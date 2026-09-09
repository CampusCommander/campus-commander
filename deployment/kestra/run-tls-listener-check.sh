#!/usr/bin/env bash
set -euo pipefail

kestra_image='docker.io/kestra/kestra@sha256:c9e6551c671d8e13274b85f3ccafb945065b8e35e33cf2ea3eeff817d52e7114'
postgres_image='docker.io/library/postgres@sha256:4ef4dbc939d61acea57712655ddb4b4ab27419c913f94cca0cd57cb3ea3c2280'
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
result_path=${1:-"$script_dir/tls-listener-result.json"}
run_id="cc5-tls-${RANDOM}-$$"
network_name="$run_id-network"
database_name="$run_id-postgres"
kestra_name="$run_id-kestra"
database_volume="$run_id-postgres-data"
storage_volume="$run_id-kestra-storage"
temporary_dir=$(mktemp -d)
admin_username='cc5-tls@example.invalid'
database_username='kestra'
database_password="Cc5Db-$(openssl rand -hex 20)"
admin_password="Cc5Tls-$(openssl rand -hex 20)!"

cleanup() {
  docker rm -f "$kestra_name" "$database_name" >/dev/null 2>&1 || true
  docker network rm "$network_name" >/dev/null 2>&1 || true
  docker volume rm "$database_volume" "$storage_volume" >/dev/null 2>&1 || true
  rm -rf "$temporary_dir"
}
trap cleanup EXIT

record_failure() {
  local exit_code=$?
  jq -n \
    --arg checkedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --argjson exitCode "$exit_code" \
    '{checkedAt:$checkedAt,status:"FAILED",exitCode:$exitCode,secretsRecorded:false}' \
    >"$result_path"
}
trap record_failure ERR

jq -n \
  --arg username "$admin_username" \
  --arg password "$admin_password" \
  '{username:$username,password:$password}' >"$temporary_dir/auth.json"
printf '%s\n' "$database_password" >"$temporary_dir/database-password"
chmod 600 "$temporary_dir/auth.json" "$temporary_dir/database-password"

openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -subj /CN=kestra.local \
  -addext subjectAltName=DNS:kestra.local \
  -keyout "$temporary_dir/server.key" \
  -out "$temporary_dir/server.pem" >/dev/null 2>&1

env \
  CC_KESTRA_PROFILE=all-docker \
  CC_KESTRA_RUNTIME_DIR="$temporary_dir/runtime" \
  CC_KESTRA_RUNTIME_MOUNT_PATH=/etc/campus-kestra \
  CC_KESTRA_AUTH_FILE="$temporary_dir/auth.json" \
  CC_KESTRA_DATABASE_PASSWORD_FILE="$temporary_dir/database-password" \
  CC_KESTRA_DATABASE_URL="jdbc:postgresql://$database_name:5432/kestra" \
  CC_KESTRA_DATABASE_USERNAME="$database_username" \
  CC_KESTRA_URL=https://kestra.local:8080 \
  CC_KESTRA_TLS_ENABLED=true \
  CC_KESTRA_TLS_CERTIFICATE_FILE="$temporary_dir/server.pem" \
  CC_KESTRA_TLS_PRIVATE_KEY_FILE="$temporary_dir/server.key" \
  node "$script_dir/render-config.mjs" >/dev/null

docker network create --label campus-commander.cc5="$run_id" "$network_name" >/dev/null
docker volume create --label campus-commander.cc5="$run_id" "$database_volume" >/dev/null
docker volume create --label campus-commander.cc5="$run_id" "$storage_volume" >/dev/null

docker run -d \
  --name "$database_name" \
  --network "$network_name" \
  --label campus-commander.cc5="$run_id" \
  -e POSTGRES_DB=kestra \
  -e POSTGRES_USER="$database_username" \
  -e POSTGRES_PASSWORD="$database_password" \
  -v "$database_volume:/var/lib/postgresql" \
  "$postgres_image" >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$database_name" pg_isready -U "$database_username" -d kestra >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$database_name" pg_isready -U "$database_username" -d kestra >/dev/null

docker run -d \
  --name "$kestra_name" \
  --network "$network_name" \
  --label campus-commander.cc5="$run_id" \
  -p 127.0.0.1::8080 \
  -v "$temporary_dir/runtime:/etc/campus-kestra:ro" \
  -v "$storage_volume:/app/storage" \
  "$kestra_image" server standalone --config /etc/campus-kestra/application.yaml >/dev/null

host_port=$(docker port "$kestra_name" 8080/tcp | sed -n 's/.*://p')
readiness_url="https://kestra.local:$host_port/api/v1/main/flows/search?size=1"
for _ in $(seq 1 180); do
  if curl -fsS --noproxy '*' \
    --cacert "$temporary_dir/server.pem" \
    --resolve "kestra.local:$host_port:127.0.0.1" \
    -u "$admin_username:$admin_password" \
    "$readiness_url" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

unauthenticated_status=$(curl -sS --noproxy '*' \
  --cacert "$temporary_dir/server.pem" \
  --resolve "kestra.local:$host_port:127.0.0.1" \
  -o /dev/null -w '%{http_code}' "$readiness_url")
authenticated_status=$(curl -sS --noproxy '*' \
  --cacert "$temporary_dir/server.pem" \
  --resolve "kestra.local:$host_port:127.0.0.1" \
  -u "$admin_username:$admin_password" \
  -o /dev/null -w '%{http_code}' "$readiness_url")
test "$unauthenticated_status" = 401
test "$authenticated_status" = 200

jq -n \
  --arg checkedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg image "$kestra_image" \
  --argjson unauthenticatedStatus "$unauthenticated_status" \
  --argjson authenticatedStatus "$authenticated_status" \
  '{
    checkedAt:$checkedAt,
    status:"PASS",
    image:$image,
    listener:{protocol:"https",port:8080,certificateTrust:"synthetic CA file"},
    unauthenticatedStatus:$unauthenticatedStatus,
    authenticatedStatus:$authenticatedStatus,
    generatedFiles:{configurationMode:"0600",keyStoreMode:"0600"},
    secretsRecorded:false,
    limits:[
      "The check used a one-day synthetic certificate.",
      "District certificate and trust integration remain untested.",
      "The check ran on one Docker host."
    ]
  }' >"$result_path"

printf 'CC-5 TLS listener: PASS\n'

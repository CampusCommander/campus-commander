#!/usr/bin/env bash
set -euo pipefail

kestra_image='docker.io/kestra/kestra@sha256:c9e6551c671d8e13274b85f3ccafb945065b8e35e33cf2ea3eeff817d52e7114'
postgres_image='docker.io/library/postgres@sha256:4ef4dbc939d61acea57712655ddb4b4ab27419c913f94cca0cd57cb3ea3c2280'
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
result_path=${1:-"$script_dir/database-failure-result.json"}
run_id="cc11-db-failure-${RANDOM}-$$"
network_name="$run_id-network"
database_name="$run_id-postgres"
database_volume="$run_id-postgres-data"
temporary_dir=$(mktemp -d)
database_password="Cc11Db-$(openssl rand -hex 20)"
wrong_password="Wrong-$(openssl rand -hex 20)"
admin_password="Cc11Admin-$(openssl rand -hex 20)!"

cleanup() {
  docker rm -f "$database_name" >/dev/null 2>&1 || true
  docker network rm "$network_name" >/dev/null 2>&1 || true
  docker volume rm "$database_volume" >/dev/null 2>&1 || true
  rm -rf "$temporary_dir"
}
trap cleanup EXIT

for command_name in docker jq node openssl timeout; do
  command -v "$command_name" >/dev/null
done

jq -n \
  --arg username cc11-failure@example.invalid \
  --arg password "$admin_password" \
  '{username:$username,password:$password}' >"$temporary_dir/auth.json"
printf '%s\n' "$wrong_password" >"$temporary_dir/database-password"
chmod 600 "$temporary_dir/auth.json" "$temporary_dir/database-password"

env \
  CC_KESTRA_PROFILE=all-docker \
  CC_KESTRA_RUNTIME_DIR="$temporary_dir/runtime" \
  CC_KESTRA_AUTH_FILE="$temporary_dir/auth.json" \
  CC_KESTRA_DATABASE_PASSWORD_FILE="$temporary_dir/database-password" \
  CC_KESTRA_DATABASE_URL="jdbc:postgresql://$database_name:5432/kestra" \
  CC_KESTRA_DATABASE_USERNAME=kestra \
  CC_KESTRA_URL=http://kestra:8080 \
  node "$script_dir/render-config.mjs" >/dev/null

docker network create --label campus-commander.cc11="$run_id" "$network_name" >/dev/null
docker volume create --label campus-commander.cc11="$run_id" "$database_volume" >/dev/null
docker run -d \
  --name "$database_name" \
  --network "$network_name" \
  --label campus-commander.cc11="$run_id" \
  -e POSTGRES_DB=kestra \
  -e POSTGRES_USER=kestra \
  -e POSTGRES_PASSWORD="$database_password" \
  -v "$database_volume:/var/lib/postgresql" \
  "$postgres_image" >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$database_name" pg_isready -U kestra -d kestra >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$database_name" pg_isready -U kestra -d kestra >/dev/null

if timeout 20s docker run --rm \
  --network "$network_name" \
  -v "$temporary_dir/runtime:/etc/campus-kestra:ro" \
  "$kestra_image" \
  server standalone --config /etc/campus-kestra/application.yaml \
  >"$temporary_dir/startup.log" 2>&1; then
  startup_exit=0
else
  startup_exit=$?
fi
test "$startup_exit" -ne 0
grep -q 'password authentication failed for user "kestra"' "$temporary_dir/startup.log"

jq -n \
  --arg checkedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg image "$kestra_image" \
  --argjson startupExit "$startup_exit" \
  --argjson harnessTermination "$(test "$startup_exit" = 124 && echo true || echo false)" \
  '{
    checkedAt:$checkedAt,
    status:"PASS",
    image:$image,
    datasource:{count:1,database:"kestra",role:"kestra"},
    failure:{
      startupExit:$startupExit,
      boundedBySeconds:20,
      harnessTermination:$harnessTermination,
      matchedReason:"PostgreSQL rejected the Kestra role password."
    },
    secretsRecorded:false,
    limits:[
      "The check validates one authentication failure path.",
      "The check does not enumerate every PostgreSQL or storage startup failure."
    ]
  }' >"$result_path"

printf 'CC-11 database failure check: PASS\n'

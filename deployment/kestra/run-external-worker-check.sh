#!/usr/bin/env bash
set -euo pipefail

kestra_image='docker.io/kestra/kestra@sha256:c9e6551c671d8e13274b85f3ccafb945065b8e35e33cf2ea3eeff817d52e7114'
postgres_image='docker.io/library/postgres@sha256:4ef4dbc939d61acea57712655ddb4b4ab27419c913f94cca0cd57cb3ea3c2280'
worker_image='campus-commander/worker:cc-6'
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
result_path=${1:-"$script_dir/external-worker-result.json"}
run_id="cc11-${RANDOM}-$$"
network_name="$run_id-network"
database_name="$run_id-postgres"
kestra_name="$run_id-kestra"
worker_name="$run_id-worker"
database_volume="$run_id-postgres-data"
storage_volume="$run_id-kestra-storage"
temporary_dir=$(mktemp -d)
database_username='kestra'
admin_username='cc11-admin@example.invalid'
database_password="Cc11Db-$(openssl rand -hex 20)"
admin_password="Cc11Admin-$(openssl rand -hex 20)!"
dispatch_secret=$(openssl rand -base64 36 | tr -d '\n')
correlation_id="cc11-$RANDOM-$$"
marker="CC-11 synthetic internal storage marker $correlation_id"
execution_id=''
final_state=''
stage='setup'
kestra_base_url=''
worker_base_url=''
namespace_upload_status=0
namespace_directory_status=0
flow_upload_status=0
started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

cleanup() {
  docker rm -f "$kestra_name" "$worker_name" "$database_name" >/dev/null 2>&1 || true
  docker network rm "$network_name" >/dev/null 2>&1 || true
  docker volume rm "$database_volume" "$storage_volume" >/dev/null 2>&1 || true
  rm -rf "$temporary_dir"
}
trap cleanup EXIT

record_failure() {
  local exit_code=$?
  local flow_upload_response=''
  local namespace_upload_response=''
  local execution_summary='{}'
  local execution_logs='[]'
  local worker_log_tail=''
  set +e
  flow_upload_response=$(cat "$temporary_dir/flow-upload-response" 2>/dev/null || true)
  namespace_upload_response=$(cat "$temporary_dir/namespace-upload-response" 2>/dev/null || true)
  worker_log_tail=$(docker logs --tail 40 "$worker_name" 2>&1)
  if test -n "$execution_id" && declare -p kestra_curl >/dev/null 2>&1; then
    execution_summary=$("${kestra_curl[@]}" \
      "$kestra_base_url/api/v1/main/executions/$execution_id" 2>/dev/null \
      | jq '{state:.state.current,taskRuns:[.taskRunList[]? | {taskId,state:.state.current,attempts:(.attempts // [] | length),outputs:.outputs}]}' \
      || printf '{}')
    execution_logs=$("${kestra_curl[@]}" \
      "$kestra_base_url/api/v1/main/logs/$execution_id" 2>/dev/null \
      | jq '[.[]? | select(.level == "ERROR" or .level == "WARN") | {level,message,taskId}]' \
      || printf '[]')
  fi
  jq -n \
    --arg checkedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg executionId "$execution_id" \
    --arg finalState "$final_state" \
    --arg stage "$stage" \
    --argjson namespaceUploadStatus "$namespace_upload_status" \
    --argjson namespaceDirectoryStatus "$namespace_directory_status" \
    --argjson flowUploadStatus "$flow_upload_status" \
    --arg flowUploadResponse "$flow_upload_response" \
    --arg namespaceUploadResponse "$namespace_upload_response" \
    --arg workerLogTail "$worker_log_tail" \
    --argjson executionSummary "$execution_summary" \
    --argjson executionLogs "$execution_logs" \
    --argjson exitCode "$exit_code" \
    '{
      checkedAt:$checkedAt,
      status:"FAILED",
      exitCode:$exitCode,
      stage:$stage,
      namespaceUploadStatus:$namespaceUploadStatus,
      namespaceDirectoryStatus:$namespaceDirectoryStatus,
      flowUploadStatus:$flowUploadStatus,
      flowUploadResponse:$flowUploadResponse,
      namespaceUploadResponse:$namespaceUploadResponse,
      workerLogTail:$workerLogTail,
      executionSummary:$executionSummary,
      executionLogs:$executionLogs,
      executionId:$executionId,
      finalState:$finalState,
      secretsRecorded:false
    }' >"$result_path"
  trap - ERR
  exit "$exit_code"
}
trap record_failure ERR

for command_name in curl docker jq node openssl sha256sum; do
  command -v "$command_name" >/dev/null
done
docker image inspect "$kestra_image" >/dev/null
docker image inspect "$postgres_image" >/dev/null
docker image inspect "$worker_image" >/dev/null
worker_image_id=$(docker image inspect "$worker_image" --format '{{.Id}}')

mkdir -p "$temporary_dir/runtime"
jq -n \
  --arg username "$admin_username" \
  --arg password "$admin_password" \
  '{username:$username,password:$password}' >"$temporary_dir/auth.json"
printf '%s\n' "$database_password" >"$temporary_dir/database-password"
printf '%s\n' "$dispatch_secret" >"$temporary_dir/dispatch-secret"
printf 'Authorization: Bearer %s\n' "$dispatch_secret" >"$temporary_dir/worker-header"
printf '%s\n' "$marker" >"$temporary_dir/internal-marker.txt"
chmod 600 \
  "$temporary_dir/auth.json" \
  "$temporary_dir/database-password" \
  "$temporary_dir/dispatch-secret" \
  "$temporary_dir/worker-header"

openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -subj /CN=cc11-worker-ca \
  -keyout "$temporary_dir/worker-ca.key" \
  -out "$temporary_dir/worker-ca.pem" >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes \
  -subj /CN=worker \
  -keyout "$temporary_dir/worker.key" \
  -out "$temporary_dir/worker.csr" >/dev/null 2>&1
printf 'subjectAltName=DNS:worker,DNS:worker.local\nextendedKeyUsage=serverAuth\n' \
  >"$temporary_dir/worker.ext"
openssl x509 -req -days 1 \
  -in "$temporary_dir/worker.csr" \
  -CA "$temporary_dir/worker-ca.pem" \
  -CAkey "$temporary_dir/worker-ca.key" \
  -CAcreateserial \
  -extfile "$temporary_dir/worker.ext" \
  -out "$temporary_dir/worker.pem" >/dev/null 2>&1

openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -subj /CN=kestra \
  -addext subjectAltName=DNS:kestra,DNS:kestra.local \
  -keyout "$temporary_dir/kestra.key" \
  -out "$temporary_dir/kestra.pem" >/dev/null 2>&1

env \
  CC_KESTRA_PROFILE=all-docker \
  CC_KESTRA_RUNTIME_DIR="$temporary_dir/runtime" \
  CC_KESTRA_RUNTIME_MOUNT_PATH=/etc/campus-kestra \
  CC_KESTRA_AUTH_FILE="$temporary_dir/auth.json" \
  CC_KESTRA_DATABASE_PASSWORD_FILE="$temporary_dir/database-password" \
  CC_KESTRA_DATABASE_URL="jdbc:postgresql://$database_name:5432/kestra" \
  CC_KESTRA_DATABASE_USERNAME="$database_username" \
  CC_KESTRA_URL=https://kestra:8080 \
  CC_KESTRA_TLS_ENABLED=true \
  CC_KESTRA_TLS_CERTIFICATE_FILE="$temporary_dir/kestra.pem" \
  CC_KESTRA_TLS_PRIVATE_KEY_FILE="$temporary_dir/kestra.key" \
  CC_KESTRA_WORKER_BASE_URL=https://worker:3001 \
  CC_KESTRA_WORKER_DISPATCH_SECRET_FILE="$temporary_dir/dispatch-secret" \
  CC_KESTRA_WORKER_CA_FILE="$temporary_dir/worker-ca.pem" \
  node "$script_dir/render-config.mjs" >/dev/null
jq -r 'to_entries[] | "\(.key)=\(.value)"' \
  "$temporary_dir/runtime/runtime-environment.json" \
  >"$temporary_dir/kestra.env"
chmod 600 "$temporary_dir/kestra.env"

test "$(stat -c '%a' "$temporary_dir/runtime/application.yaml")" = 600
test "$(stat -c '%a' "$temporary_dir/runtime/probe-header")" = 600
test "$(stat -c '%a' "$temporary_dir/runtime/worker-truststore.p12")" = 600
test "$(grep -c '^  postgres:$' "$temporary_dir/runtime/application.yaml")" = 1
test "$(grep -c '^datasources:$' "$temporary_dir/runtime/application.yaml")" = 1
grep -q '^      allowed-list:$' "$temporary_dir/runtime/application.yaml"
grep -q '^        - "https://worker:3001"$' "$temporary_dir/runtime/application.yaml"

docker network create --label campus-commander.cc11="$run_id" "$network_name" >/dev/null
docker volume create --label campus-commander.cc11="$run_id" "$database_volume" >/dev/null
docker volume create --label campus-commander.cc11="$run_id" "$storage_volume" >/dev/null
docker run --rm \
  --user 0 \
  --entrypoint chown \
  -v "$storage_volume:/app/storage" \
  "$kestra_image" -R 1000:1000 /app/storage

docker run -d \
  --name "$database_name" \
  --network "$network_name" \
  --label campus-commander.cc11="$run_id" \
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
  --name "$worker_name" \
  --network "$network_name" \
  --network-alias worker \
  --label campus-commander.cc11="$run_id" \
  -p 127.0.0.1::3001 \
  -e WORKER_DISPATCH_SECRET_FILE=/run/secrets/dispatch \
  -e REQUIRE_TLS=true \
  -e TLS_CERT_FILE=/etc/worker/server.pem \
  -e TLS_KEY_FILE=/etc/worker/server.key \
  -e TLS_CA_FILE=/etc/worker/ca.pem \
  -v "$temporary_dir/dispatch-secret:/run/secrets/dispatch:ro" \
  -v "$temporary_dir/worker.pem:/etc/worker/server.pem:ro" \
  -v "$temporary_dir/worker.key:/etc/worker/server.key:ro" \
  -v "$temporary_dir/worker-ca.pem:/etc/worker/ca.pem:ro" \
  "$worker_image" >/dev/null

docker run -d \
  --name "$kestra_name" \
  --network "$network_name" \
  --network-alias kestra \
  --label campus-commander.cc11="$run_id" \
  -p 127.0.0.1::8080 \
  --env-file "$temporary_dir/kestra.env" \
  -v "$temporary_dir/runtime:/etc/campus-kestra:ro" \
  -v "$storage_volume:/app/storage" \
  "$kestra_image" server standalone --config /etc/campus-kestra/application.yaml >/dev/null

stage='readiness'
worker_port=$(docker port "$worker_name" 3001/tcp | sed -n 's/.*://p')
kestra_port=$(docker port "$kestra_name" 8080/tcp | sed -n 's/.*://p')
worker_base_url="https://worker.local:$worker_port"
kestra_base_url="https://kestra.local:$kestra_port"

for _ in $(seq 1 180); do
  if curl -fsS --noproxy '*' \
    --cacert "$temporary_dir/kestra.pem" \
    --resolve "kestra.local:$kestra_port:127.0.0.1" \
    --header @"$temporary_dir/runtime/probe-header" \
    "$kestra_base_url/api/v1/main/flows/search?size=1" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

kestra_curl=(
  curl -sS --noproxy '*'
  --cacert "$temporary_dir/kestra.pem"
  --resolve "kestra.local:$kestra_port:127.0.0.1"
  --header @"$temporary_dir/runtime/probe-header"
)
worker_curl=(
  curl -sS --noproxy '*'
  --cacert "$temporary_dir/worker-ca.pem"
  --resolve "worker.local:$worker_port:127.0.0.1"
)

stage='control-plane-authentication'
kestra_unauthenticated_status=$(curl -sS --noproxy '*' \
  --cacert "$temporary_dir/kestra.pem" \
  --resolve "kestra.local:$kestra_port:127.0.0.1" \
  -o /dev/null -w '%{http_code}' \
  "$kestra_base_url/api/v1/main/flows/search?size=1")
kestra_authenticated_status=$("${kestra_curl[@]}" \
  -o /dev/null -w '%{http_code}' \
  "$kestra_base_url/api/v1/main/flows/search?size=1")
test "$kestra_unauthenticated_status" = 401
test "$kestra_authenticated_status" = 200

stage='worker-trust-and-authentication'
if curl -sS --noproxy '*' \
  --resolve "worker.local:$worker_port:127.0.0.1" \
  "$worker_base_url/health/ready" >/dev/null 2>&1; then
  worker_untrusted_tls_exit=0
else
  worker_untrusted_tls_exit=$?
fi
test "$worker_untrusted_tls_exit" -ne 0
worker_unauthenticated_status=$("${worker_curl[@]}" \
  -H 'content-type: application/json' \
  --data-binary '{"executionId":"probe","correlationId":"probe","marker":"probe"}' \
  -o /dev/null -w '%{http_code}' \
  "$worker_base_url/dispatch/synthetic")
worker_wrong_secret_status=$("${worker_curl[@]}" \
  -H 'content-type: application/json' \
  -H 'Authorization: Bearer wrong' \
  --data-binary '{"executionId":"probe","correlationId":"probe","marker":"probe"}' \
  -o /dev/null -w '%{http_code}' \
  "$worker_base_url/dispatch/synthetic")
worker_unknown_field_status=$("${worker_curl[@]}" \
  --header @"$temporary_dir/worker-header" \
  -H 'content-type: application/json' \
  --data-binary '{"executionId":"probe","correlationId":"probe","marker":"probe","command":"id"}' \
  -o /dev/null -w '%{http_code}' \
  "$worker_base_url/dispatch/synthetic")
test "$worker_unauthenticated_status" = 401
test "$worker_wrong_secret_status" = 401
test "$worker_unknown_field_status" = 400

stage='flow-upload'
flow_upload_status=$("${kestra_curl[@]}" \
  -H 'Content-Type: application/x-yaml' \
  --data-binary "@$script_dir/cc11-external-worker.yaml" \
  -o "$temporary_dir/flow-upload-response" -w '%{http_code}' \
  "$kestra_base_url/api/v1/main/flows")
test "$flow_upload_status" = 200

stage='namespace-file-upload'
namespace_file_url="$kestra_base_url/api/v1/main/namespaces/campus.validation/files?path=/cc11-marker.txt"
namespace_directory_status=$("${kestra_curl[@]}" \
  -X POST \
  -o /dev/null -w '%{http_code}' \
  "$kestra_base_url/api/v1/main/namespaces/campus.validation/files/directory?path=/")
case "$namespace_directory_status" in
  200|201|204) ;;
  *) false ;;
esac
namespace_upload_status=$("${kestra_curl[@]}" \
  -F "fileContent=@$temporary_dir/internal-marker.txt" \
  -o "$temporary_dir/namespace-upload-response" -w '%{http_code}' \
  "$namespace_file_url")
case "$namespace_upload_status" in
  200|201|204) ;;
  *) false ;;
esac
"${kestra_curl[@]}" "$namespace_file_url" >"$temporary_dir/marker-before"
marker_checksum_before=$(sha256sum "$temporary_dir/marker-before" | cut -d ' ' -f 1)

stage='execution-start'
execution_id=$("${kestra_curl[@]}" \
  -X POST \
  -F "correlationId=$correlation_id" \
  -F "marker=$marker" \
  -F 'delayMilliseconds=8000' \
  "$kestra_base_url/api/v1/main/executions/campus.validation/cc11_external_worker" \
  | jq -er '.id')

stage='worker-interruption'
for _ in $(seq 1 120); do
  if grep -q \
    "Synthetic dispatch accepted execution=$execution_id correlation=$correlation_id" \
    <<<"$(docker logs "$worker_name" 2>&1)"; then
    break
  fi
  execution_state=$("${kestra_curl[@]}" \
    "$kestra_base_url/api/v1/main/executions/$execution_id" \
    | jq -er '.state.current')
  case "$execution_state" in
    SUCCESS|WARNING|FAILED|KILLED|CANCELLED) break ;;
  esac
  sleep 0.25
done
grep -q \
  "Synthetic dispatch accepted execution=$execution_id correlation=$correlation_id" \
  <<<"$(docker logs "$worker_name" 2>&1)"

worker_interrupted_at_epoch=$(date +%s)
docker kill "$worker_name" >/dev/null
sleep 3
docker start "$worker_name" >/dev/null

execution_json=''
for _ in $(seq 1 180); do
  execution_json=$("${kestra_curl[@]}" \
    "$kestra_base_url/api/v1/main/executions/$execution_id")
  final_state=$(jq -er '.state.current' <<<"$execution_json")
  case "$final_state" in
    SUCCESS|WARNING|FAILED|KILLED|CANCELLED) break ;;
  esac
  sleep 0.5
done
test "$final_state" = SUCCESS
worker_recovered_at_epoch=$(date +%s)
worker_recovery_seconds=$((worker_recovered_at_epoch - worker_interrupted_at_epoch))
test "$worker_recovery_seconds" -le 45

worker_logs=$(docker logs "$worker_name" 2>&1)
worker_accept_count=$(grep -c "Synthetic dispatch accepted execution=$execution_id correlation=$correlation_id" <<<"$worker_logs")
worker_complete_count=$(grep -c "Synthetic dispatch completed execution=$execution_id correlation=$correlation_id" <<<"$worker_logs")
test "$worker_accept_count" -ge 2
test "$worker_complete_count" = 1
dispatch_attempt_count=$(jq \
  '[.taskRunList[]? | select(.taskId == "dispatch") | (.attempts // []) | length] | max // 0' \
  <<<"$execution_json")
test "$dispatch_attempt_count" -ge 2
storage_uri=$(jq -er \
  '.taskRunList[]? | select(.taskId == "persist_result") | .outputs.uri' \
  <<<"$execution_json")
test "${storage_uri#kestra://}" != "$storage_uri"

stage='kestra-restart'
database_volume_before=$(docker volume inspect "$database_volume" --format '{{.Name}}')
storage_volume_before=$(docker volume inspect "$storage_volume" --format '{{.Name}}')
docker stop --time 8 "$kestra_name" >/dev/null
docker start "$kestra_name" >/dev/null
kestra_port=$(docker port "$kestra_name" 8080/tcp | sed -n 's/.*://p')
kestra_base_url="https://kestra.local:$kestra_port"
kestra_curl=(
  curl -sS --noproxy '*'
  --cacert "$temporary_dir/kestra.pem"
  --resolve "kestra.local:$kestra_port:127.0.0.1"
  --header @"$temporary_dir/runtime/probe-header"
)
namespace_file_url="$kestra_base_url/api/v1/main/namespaces/campus.validation/files?path=/cc11-marker.txt"

for _ in $(seq 1 180); do
  if "${kestra_curl[@]}" \
    "$kestra_base_url/api/v1/main/flows/search?size=1" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
restart_authenticated_status=$("${kestra_curl[@]}" \
  -o /dev/null -w '%{http_code}' \
  "$kestra_base_url/api/v1/main/flows/search?size=1")
test "$restart_authenticated_status" = 200
"${kestra_curl[@]}" "$namespace_file_url" >"$temporary_dir/marker-after"
marker_checksum_after=$(sha256sum "$temporary_dir/marker-after" | cut -d ' ' -f 1)
test "$marker_checksum_before" = "$marker_checksum_after"

database_volume_after=$(docker volume inspect "$database_volume" --format '{{.Name}}')
storage_volume_after=$(docker volume inspect "$storage_volume" --format '{{.Name}}')
test "$database_volume_before" = "$database_volume_after"
test "$storage_volume_before" = "$storage_volume_after"
startup_log=$(docker logs "$kestra_name" 2>&1)
flyway_warning_count=$(grep -c 'latest supported version of PostgreSQL is 17' <<<"$startup_log")

stage='result-write'
jq -n \
  --arg checkedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg startedAt "$started_at" \
  --arg kestraImage "$kestra_image" \
  --arg workerImage "$worker_image" \
  --arg workerImageId "$worker_image_id" \
  --arg executionId "$execution_id" \
  --arg correlationId "$correlation_id" \
  --arg finalState "$final_state" \
  --arg storageUri "$storage_uri" \
  --arg markerChecksumBefore "$marker_checksum_before" \
  --arg markerChecksumAfter "$marker_checksum_after" \
  --arg databaseVolume "$database_volume_after" \
  --arg storageVolume "$storage_volume_after" \
  --argjson flowUploadStatus "$flow_upload_status" \
  --argjson namespaceUploadStatus "$namespace_upload_status" \
  --argjson namespaceDirectoryStatus "$namespace_directory_status" \
  --argjson kestraUnauthenticatedStatus "$kestra_unauthenticated_status" \
  --argjson kestraAuthenticatedStatus "$kestra_authenticated_status" \
  --argjson restartAuthenticatedStatus "$restart_authenticated_status" \
  --argjson workerUnauthenticatedStatus "$worker_unauthenticated_status" \
  --argjson workerWrongSecretStatus "$worker_wrong_secret_status" \
  --argjson workerUnknownFieldStatus "$worker_unknown_field_status" \
  --argjson workerUntrustedTlsExit "$worker_untrusted_tls_exit" \
  --argjson workerAcceptCount "$worker_accept_count" \
  --argjson workerCompleteCount "$worker_complete_count" \
  --argjson dispatchAttemptCount "$dispatch_attempt_count" \
  --argjson workerRecoverySeconds "$worker_recovery_seconds" \
  --argjson flywayWarningCount "$flyway_warning_count" \
  '{
    checkedAt:$checkedAt,
    startedAt:$startedAt,
    status:"PASS",
    images:{
      kestra:$kestraImage,
      workerTag:$workerImage,
      workerLocalImageId:$workerImageId
    },
    controlPlane:{
      protocol:"https",
      unauthenticatedStatus:$kestraUnauthenticatedStatus,
      authenticatedStatus:$kestraAuthenticatedStatus,
      restartAuthenticatedStatus:$restartAuthenticatedStatus
    },
    workerTrust:{
      protocol:"https",
      untrustedTlsExit:$workerUntrustedTlsExit,
      unauthenticatedStatus:$workerUnauthenticatedStatus,
      wrongSecretStatus:$workerWrongSecretStatus,
      unknownFieldStatus:$workerUnknownFieldStatus,
      privateCaTrustStore:true
    },
    execution:{
      id:$executionId,
      correlationId:$correlationId,
      flowUploadStatus:$flowUploadStatus,
      finalState:$finalState,
      dispatchAttempts:$dispatchAttemptCount,
      workerAcceptCount:$workerAcceptCount,
      workerCompleteCount:$workerCompleteCount,
      storageUri:$storageUri
    },
    interruption:{
      type:"worker SIGKILL during bounded synthetic delay",
      recoverySeconds:$workerRecoverySeconds,
      settlementLimit:"3 attempts or 30 seconds",
      finalState:$finalState
    },
    persistence:{
      namespaceUploadStatus:$namespaceUploadStatus,
      namespaceDirectoryStatus:$namespaceDirectoryStatus,
      markerChecksumBefore:$markerChecksumBefore,
      markerChecksumAfter:$markerChecksumAfter,
      sameChecksumAfterKestraRestart:true,
      databaseVolume:$databaseVolume,
      storageVolume:$storageVolume,
      sameVolumesAfterRestart:true
    },
    startup:{
      designatedDatasourceCount:1,
      postgres18FlywayWarningCount:$flywayWarningCount,
      secretsRecorded:false
    },
    limits:[
      "The check uses synthetic certificates and one Docker host.",
      "The check does not prove shared-filesystem behavior across distinct hosts.",
      "The worker endpoint supports a harmless synthetic payload only.",
      "Task retry provides at-least-once dispatch and no exactly-once guarantee.",
      "The worker keeps no durable deduplication record.",
      "PostgreSQL 18.6 exceeds the Flyway logged supported version 17."
    ]
  }' >"$result_path"

printf 'CC-11 external worker check: PASS (%s)\n' "$execution_id"

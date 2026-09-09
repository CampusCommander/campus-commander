#!/usr/bin/env bash
set -euo pipefail

kestra_image='docker.io/kestra/kestra@sha256:c9e6551c671d8e13274b85f3ccafb945065b8e35e33cf2ea3eeff817d52e7114'
postgres_image='docker.io/library/postgres@sha256:4ef4dbc939d61acea57712655ddb4b4ab27419c913f94cca0cd57cb3ea3c2280'
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
result_path=${1:-"$script_dir/synthetic-restart-result.json"}
run_id="cc5-${RANDOM}-$$"
network_name="$run_id-network"
database_name="$run_id-postgres"
kestra_name="$run_id-kestra"
database_volume="$run_id-postgres-data"
storage_volume="$run_id-kestra-storage"
admin_username='cc5-admin@example.invalid'
database_username='kestra'
database_password="Cc5Db-$(openssl rand -hex 20)"
admin_password="Cc5Admin-$(openssl rand -hex 20)!"
execution_id=''
base_url=''
started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
temporary_dir=$(mktemp -d)

cleanup() {
  docker rm -f "$kestra_name" "$database_name" >/dev/null 2>&1 || true
  docker network rm "$network_name" >/dev/null 2>&1 || true
  docker volume rm "$database_volume" "$storage_volume" >/dev/null 2>&1 || true
  rm -rf "$temporary_dir"
}
trap cleanup EXIT

record_failure() {
  local exit_code=$?
  docker logs "$kestra_name" 2>&1 \
    | sed -e "s/$database_password/[REDACTED]/g" -e "s/$admin_password/[REDACTED]/g" \
    >"$temporary_dir/kestra.log" || true
  jq -n \
    --arg checkedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg executionId "$execution_id" \
    --arg logTail "$(tail -80 "$temporary_dir/kestra.log" 2>/dev/null || true)" \
    --argjson exitCode "$exit_code" \
    '{checkedAt:$checkedAt,status:"FAILED",exitCode:$exitCode,executionId:$executionId,redactedLogTail:$logTail}' \
    >"$result_path"
}
trap record_failure ERR

for command_name in docker curl jq openssl; do
  command -v "$command_name" >/dev/null
done

docker image inspect "$kestra_image" >/dev/null
docker image inspect "$postgres_image" >/dev/null
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
  -e CC_KESTRA_DATABASE_URL="jdbc:postgresql://$database_name:5432/kestra" \
  -e CC_KESTRA_DATABASE_USERNAME="$database_username" \
  -e CC_KESTRA_DATABASE_PASSWORD="$database_password" \
  -e CC_KESTRA_ADMIN_USERNAME="$admin_username" \
  -e CC_KESTRA_ADMIN_PASSWORD="$admin_password" \
  -e CC_KESTRA_TERMINATION_GRACE_PERIOD=3s \
  -e CC_KESTRA_URL=http://kestra:8080/ \
  -v "$script_dir/application.yaml:/etc/kestra/application.yaml:ro" \
  -v "$storage_volume:/app/storage" \
  "$kestra_image" server standalone --config /etc/kestra/application.yaml >/dev/null

host_port=$(docker port "$kestra_name" 8080/tcp | sed -n 's/.*://p')
base_url="http://127.0.0.1:$host_port"
for _ in $(seq 1 180); do
  if curl -fsS "$base_url/api/v1/configs" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
curl -fsS "$base_url/api/v1/configs" >/dev/null
config_json=$(curl -fsS "$base_url/api/v1/configs")

flow_url="$base_url/api/v1/main/flows/campus.qualification/cc5_restart"
auth_health_url="$base_url/api/v1/main/flows/search?size=1"
unauthenticated_status=$(curl -sS -o /dev/null -w '%{http_code}' "$auth_health_url")
wrong_status=$(curl -sS -o /dev/null -w '%{http_code}' -u 'wrong@example.invalid:WrongPassword1!' "$auth_health_url")
authenticated_status=$(curl -sS -o /dev/null -w '%{http_code}' -u "$admin_username:$admin_password" "$auth_health_url")
test "$unauthenticated_status" = 401
test "$wrong_status" = 401
test "$authenticated_status" = 200

flow_upload_status=$(curl -sS -o /dev/null -w '%{http_code}' \
  -u "$admin_username:$admin_password" \
  -H 'Content-Type: application/x-yaml' \
  --data-binary "@$script_dir/synthetic-restart.yaml" \
  "$base_url/api/v1/main/flows")
test "$flow_upload_status" = 200

execution_id=$(curl -fsS \
  -u "$admin_username:$admin_password" \
  -X POST \
  "$base_url/api/v1/main/executions/campus.qualification/cc5_restart" \
  | jq -er '.id')

state_before_stop=''
for _ in $(seq 1 40); do
  state_before_stop=$(curl -fsS \
    -u "$admin_username:$admin_password" \
    "$base_url/api/v1/main/executions/$execution_id" \
    | jq -er '.state.current')
  if test "$state_before_stop" = RUNNING; then
    break
  fi
  sleep 0.25
done
test "$state_before_stop" = RUNNING

docker stop --time 8 "$kestra_name" >/dev/null
stopped_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
database_volume_before=$(docker volume inspect "$database_volume" --format '{{.Name}}')
storage_volume_before=$(docker volume inspect "$storage_volume" --format '{{.Name}}')
docker start "$kestra_name" >/dev/null
host_port=$(docker port "$kestra_name" 8080/tcp | sed -n 's/.*://p')
base_url="http://127.0.0.1:$host_port"
flow_url="$base_url/api/v1/main/flows/campus.qualification/cc5_restart"
auth_health_url="$base_url/api/v1/main/flows/search?size=1"

for _ in $(seq 1 180); do
  if curl -fsS "$base_url/api/v1/configs" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
curl -fsS "$base_url/api/v1/configs" >/dev/null
restart_authenticated_status=$(curl -sS -o /dev/null -w '%{http_code}' -u "$admin_username:$admin_password" "$auth_health_url")
test "$restart_authenticated_status" = 200

final_state=''
execution_json=''
for _ in $(seq 1 240); do
  execution_json=$(curl -fsS \
    -u "$admin_username:$admin_password" \
    "$base_url/api/v1/main/executions/$execution_id")
  final_state=$(jq -er '.state.current' <<<"$execution_json")
  case "$final_state" in
    SUCCESS|WARNING|FAILED|KILLED|CANCELLED) break ;;
  esac
  sleep 0.25
done
test "$final_state" = SUCCESS

database_volume_after=$(docker volume inspect "$database_volume" --format '{{.Name}}')
storage_volume_after=$(docker volume inspect "$storage_volume" --format '{{.Name}}')
test "$database_volume_before" = "$database_volume_after"
test "$storage_volume_before" = "$storage_volume_after"
startup_log=$(docker logs "$kestra_name" 2>&1)
core_plugin_count=$(grep -m1 -o 'Registered [0-9]* core plugins' <<<"$startup_log" | grep -o '[0-9]*')
external_plugin_count=$(grep -m1 -o 'Registered [0-9]* plugins from' <<<"$startup_log" | grep -o '[0-9]*')
startup_count=$(grep -c 'Starting Kestra 1.3.37' <<<"$startup_log")
flyway_warning_count=$(grep -c 'latest supported version of PostgreSQL is 17' <<<"$startup_log")
schema_current_count=$(grep -c 'Current version of schema "public": 1.57' <<<"$startup_log")
test "$core_plugin_count" = 107
test "$external_plugin_count" = 0
test "$startup_count" = 2
test "$flyway_warning_count" = 2
test "$schema_current_count" = 1

jq -n \
  --arg checkedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg startedAt "$started_at" \
  --arg stoppedAt "$stopped_at" \
  --arg image "$kestra_image" \
  --arg executionId "$execution_id" \
  --arg stateBeforeStop "$state_before_stop" \
  --arg finalState "$final_state" \
  --argjson unauthenticatedStatus "$unauthenticated_status" \
  --argjson wrongCredentialStatus "$wrong_status" \
  --argjson authenticatedStatus "$authenticated_status" \
  --argjson flowUploadStatus "$flow_upload_status" \
  --argjson restartAuthenticatedStatus "$restart_authenticated_status" \
  --arg databaseVolume "$database_volume_after" \
  --arg storageVolume "$storage_volume_after" \
  --arg version "$(jq -er '.version' <<<"$config_json")" \
  --argjson basicAuthInitialized "$(jq -er '.isBasicAuthInitialized' <<<"$config_json")" \
  --argjson corePluginCount "$core_plugin_count" \
  --argjson externalPluginCount "$external_plugin_count" \
  --argjson startupCount "$startup_count" \
  --argjson flywayWarningCount "$flyway_warning_count" \
  --argjson schemaCurrentCount "$schema_current_count" \
  --argjson stateHistory "$(jq '.state.histories | map({state,date})' <<<"$execution_json")" \
  --argjson taskRuns "$(jq '[.taskRunList[]? | {taskId,attempts:(.attempts // [] | length),state:.state.current}]' <<<"$execution_json")" \
  '{
    checkedAt:$checkedAt,
    status:"PASS",
    image:$image,
    startedAt:$startedAt,
    stoppedAt:$stoppedAt,
    startup:{
      version:$version,
      basicAuthInitialized:$basicAuthInitialized,
      corePluginCount:$corePluginCount,
      externalPluginCount:$externalPluginCount,
      processStartCount:$startupCount,
      postgres18FlywayWarningCount:$flywayWarningCount,
      schemaVersion157AfterRestartCount:$schemaCurrentCount,
      secretsRecorded:false
    },
    credentialChecks:{
      unauthenticatedStatus:$unauthenticatedStatus,
      wrongCredentialStatus:$wrongCredentialStatus,
      authenticatedStatus:$authenticatedStatus,
      flowUploadStatus:$flowUploadStatus,
      restartAuthenticatedStatus:$restartAuthenticatedStatus
    },
    execution:{
      id:$executionId,
      stateBeforeStop:$stateBeforeStop,
      finalState:$finalState,
      stateHistory:$stateHistory,
      taskRuns:$taskRuns
    },
    persistence:{
      databaseVolume:$databaseVolume,
      storageVolume:$storageVolume,
      sameVolumesAfterRestart:true
    },
    limits:[
      "Qualification uses a three-second termination grace period.",
      "Production retains the five-minute default until shutdown timing qualification.",
      "The check restarts one standalone process on one Docker host.",
      "SUCCESS proves metadata recovery for one synthetic core-task execution.",
      "The check does not establish exactly-once external effects or high availability."
    ]
  }' >"$result_path"

printf 'CC-5 synthetic restart: PASS (%s)\n' "$execution_id"

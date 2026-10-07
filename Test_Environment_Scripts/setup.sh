#!/usr/bin/env bash
set -Eeuo pipefail

export DEBIAN_FRONTEND=noninteractive

DOCKER_SOCKET="unix:///var/run/docker.sock"
DOCKER_DATA_ROOT="/var/lib/docker"
DOCKER_LOG="/var/log/dockerd.log"
DOCKER_START_TIMEOUT=60
export DOCKER_HOST="${DOCKER_SOCKET}"

echo "=== Updating system packages ==="
apt-get update
apt-get upgrade -y
apt-get install -y curl wget ca-certificates gnupg lsb-release gh

echo "=== Installing Node.js 24.19.0 ==="
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y nodejs=24.19.0-1nodesource1

echo "=== Installing Docker Engine ==="
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

echo "=== Installing OpenSSL ==="
apt-get install -y openssl

echo "=== Installing Cosign ==="
curl -Lo /usr/local/bin/cosign https://github.com/sigstore/cosign/releases/latest/download/cosign-linux-amd64
chmod +x /usr/local/bin/cosign

echo "=== Starting private Docker daemon ==="
start_docker_daemon() {
  if docker info >/dev/null 2>&1; then
    echo "Docker daemon is already ready."
    return
  fi

  rm -f /var/run/docker.pid /var/run/docker.sock
  nohup dockerd \
    --host="${DOCKER_SOCKET}" \
    --data-root="${DOCKER_DATA_ROOT}" \
    --exec-opt native.cgroupdriver=cgroupfs \
    --default-cgroupns-mode=private \
    >"${DOCKER_LOG}" 2>&1 </dev/null &
}

wait_for_docker() {
  local deadline=$((SECONDS + DOCKER_START_TIMEOUT))

  until docker info >/dev/null 2>&1; do
    if (( SECONDS >= deadline )); then
      echo "Docker daemon did not become ready within ${DOCKER_START_TIMEOUT} seconds." >&2
      if [[ -f "${DOCKER_LOG}" ]]; then
        tail -n 100 "${DOCKER_LOG}" >&2
      fi
      return 1
    fi
    sleep 1
  done

  echo "Docker daemon is ready."
}

start_docker_daemon
wait_for_docker

echo "=== Verifying installations ==="
echo "Node.js version:"
node --version
echo "Docker version:"
docker version --format '{{.Server.Version}}'
echo "Docker Compose version:"
docker compose version --short
echo "OpenSSL version:"
openssl version
echo "Cosign version:"
cosign version
echo "GitHub CLI version:"
gh --version

echo "=== Setup complete ==="

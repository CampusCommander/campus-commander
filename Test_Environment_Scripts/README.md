# Test Environment Setup

Quick-spin Docker test environment with all required tools and a private Docker daemon.

## Prerequisites

- Docker Desktop running locally
- At least 3.2 GB available memory
- At least 40 GB free disk space

## Quick Start

### 1. Generate Self-Signed Certificate

```bash
bash generate-cert.sh test-env.local
```

This creates:
- `certs/private.key` — Private key
- `certs/certificate.crt` — Self-signed certificate

### 2. Start the Test Environment Container

```bash
docker compose up -d
docker compose exec -it test-env bash
```

The container runs Ubuntu 24.04 with a 3,200 MiB memory limit. It runs in privileged mode so its own Docker daemon can create child containers. The container joins the host cgroup namespace and mounts `/sys/fs/cgroup` read-write. The host Docker socket is not mounted. The `test-docker-data` volume stores the private daemon data, and child-container bind mounts resolve against the test container filesystem.

### 3. Install Tools and Start the Private Docker Daemon

Once inside the container:

```bash
bash /setup.sh
```

`setup.sh` installs Node.js 24.19.0, Docker Engine and Compose, OpenSSL, Cosign, and GitHub CLI. It starts `dockerd` on the private Unix socket at `/var/run/docker.sock` with the cgroupfs driver and private child cgroup namespaces. It then waits up to 60 seconds for `docker info` to succeed. The command exits with the daemon log if readiness fails.

### 4. Verify the Environment

Inside the container, run:

```bash
node --version
docker version
docker compose version --short
openssl version
cosign version
gh --version
test "$(docker context show)" = default
docker info --format 'Docker root: {{.DockerRootDir}}'
docker info --format 'Cgroup version: {{.CgroupVersion}}; driver: {{.CgroupDriver}}'
child_id="$(docker create --memory=128m --cpus=0.25 alpine:3.20 sh -c 'test "$(cat /sys/fs/cgroup/memory.max)" = 134217728 && test "$(cat /sys/fs/cgroup/cpu.max)" = "25000 100000"')"
trap 'docker rm -f "$child_id" >/dev/null 2>&1 || true' EXIT
docker start "$child_id"
docker wait "$child_id"
docker rm "$child_id"
trap - EXIT
```

The Docker root must be `/var/lib/docker` inside `test-phase-env`. The cgroup output must show version 2 and the `cgroupfs` driver. The resource-limited child must start and exit successfully after checking its 128 MiB memory and 0.25 CPU limits. GitHub CLI provides authenticated access to the private repository and its releases.

Authenticate GitHub CLI inside the container before using private repository or release commands:

```bash
gh auth login
gh auth status
gh release view <tag> --repo <owner>/<repo>
```

The release command confirms that the authenticated account can read the private release.

## Configuration

- **Memory limit**: 3,200 MiB
- **Storage volume**: `test-storage` (40+ GB available)
- **Docker data volume**: `test-docker-data`
- **Cgroups**: Host cgroup namespace with `/sys/fs/cgroup` mounted read-write
- **Hostname**: `test-env.local`
- **Network**: `test-network` (bridged)
- **Docker daemon**: Private `dockerd` inside `test-phase-env`
- **GitHub CLI**: `gh` from the Ubuntu package source for private repository and release access
- **Certificates**: `certs/` mounted read-only at `/etc/ssl/certs/custom`

## Cleanup

Leave the container shell, then stop and remove the test environment and both named volumes:

```bash
exit
docker compose down -v
```

This removes `test-phase-env`, `test-storage`, and `test-docker-data`. Start again with `docker compose up -d`, then enter the shell and rerun `bash /setup.sh` if the container was recreated.

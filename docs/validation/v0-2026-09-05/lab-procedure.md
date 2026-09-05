# V0 lab procedure

**Purpose: reproduce isolated experiments. This is not the Campus Commander installer.**

## Recorded environment

The run used Ubuntu 26.04, x86-64, 16 logical CPUs, and approximately 32 GB RAM.
Node 24.19.0 and Java 25.0.4 were already installed.
PostgreSQL 18.6, Redis 8.0.5, and Kestra 1.3.37 ran as isolated user processes.
No system database or Redis service was installed.

Package files and runtime directories stayed under `/tmp/campus-v0-lab`.
The [environment record](evidence/environment.json) contains host details and downloaded-file SHA-256 hashes.
Kestra's downloaded executable matched its official release checksum:

```text
2a715bab22f2f6986debef9971f2529eff7394765662d8bf1b4d81d89e175c26
```

Download source: [Kestra 1.3.37 release](https://github.com/kestra-io/kestra/releases/tag/v1.3.37).
Runtime reference: [Kestra standalone installation](https://kestra.io/docs/installation/standalone-server).

| Service | Endpoint | Data location |
|---|---|---|
| PostgreSQL | `127.0.0.1:55439` | `/tmp/campus-v0-lab/pgdata` |
| Redis | `127.0.0.1:56389` | Ephemeral keys. Persistence disabled in this lab. |
| Kestra API | `127.0.0.1:58089` | `v0_kestra` database and `/tmp/campus-v0-lab/kestra-storage` |
| Kestra management | `127.0.0.1:8081` | Internal management endpoint |
| Synthetic worker | `127.0.0.1:58189` | Runs only during the Kestra probe |

The PostgreSQL scratch cluster used local trust authentication and a private Unix socket directory.
Use these settings only on a disposable, isolated developer host with synthetic data.
The Kestra probe generates a random local password in `/tmp/campus-v0-lab/kestra-auth.json` with mode 0600.
Do not copy that file into evidence or the repository.

## Runtime preparation

On Ubuntu 26.04, download the package versions listed in the environment record into the scratch package directory.
Extract each package into `/tmp/campus-v0-lab/runtime` using `dpkg-deb -x`.
The run used these packages:

```text
postgresql-18=18.6-0ubuntu0.26.04.1
postgresql-client-18=18.6-0ubuntu0.26.04.1
libpq5=18.6-0ubuntu0.26.04.1
redis-server=5:8.0.5-1
redis-tools=5:8.0.5-1
libicu78=78.2-2ubuntu1
liburing2=2.14-1
liblzf1=3.6-4build1
```

Package availability and platform compatibility must match the recorded environment.
Do not replace host libraries or start system services to run these probes.
Prepare the runtime paths in a dedicated shell:

```bash
export V0_LAB=/tmp/campus-v0-lab
export V0_PG_BIN="$V0_LAB/runtime/usr/lib/postgresql/18/bin"
export LD_LIBRARY_PATH="$V0_LAB/runtime/usr/lib/x86_64-linux-gnu"
mkdir -p "$V0_LAB/socket" "$V0_LAB/kestra-storage" "$V0_LAB/kestra-tmp"
chmod 700 "$V0_LAB/socket"
```

Initialize only a new scratch data directory. Skip initialization when reproducing against the existing lab cluster.

```bash
"$V0_PG_BIN/initdb" -D "$V0_LAB/pgdata" --no-locale --auth=trust
"$V0_PG_BIN/pg_ctl" -D "$V0_LAB/pgdata" -l "$V0_LAB/postgres.log" \
  -o "-h 127.0.0.1 -p 55439 -k $V0_LAB/socket" start
"$V0_PG_BIN/psql" -h 127.0.0.1 -p 55439 -d postgres \
  -c "CREATE DATABASE v0_validation WITH ENCODING 'UTF8' TEMPLATE template0"
"$V0_PG_BIN/psql" -h 127.0.0.1 -p 55439 -d postgres \
  -c "CREATE DATABASE v0_kestra WITH ENCODING 'UTF8' TEMPLATE template0"
"$V0_LAB/runtime/usr/bin/redis-server" --bind 127.0.0.1 --port 56389 \
  --save '' --appendonly no --daemonize yes \
  --pidfile "$V0_LAB/redis.pid" --logfile "$V0_LAB/redis.log"
```

The initial cluster defaulted to SQL_ASCII. Explicit UTF8 databases avoided Kestra's encoding failure.
The Redis process warned that host memory overcommit was disabled. This run did not change host memory settings.
Neither host configuration nor scratch resource use establishes deployment sizing.

Create a Kestra configuration using the actual local database username:

```yaml
micronaut:
  server:
    host: 127.0.0.1
    port: 58089
datasources:
  postgres:
    url: jdbc:postgresql://127.0.0.1:55439/v0_kestra
    driverClassName: org.postgresql.Driver
    username: YOUR_LOCAL_DATABASE_USER
    password: ""
kestra:
  repository:
    type: postgres
  queue:
    type: postgres
  storage:
    type: local
    local:
      basePath: /tmp/campus-v0-lab/kestra-storage
  tasks:
    tmpDir:
      path: /tmp/campus-v0-lab/kestra-tmp
```

The recorded run also attempted `kestra.server.basicAuth.enabled: false`. Authentication remained enabled.
The probe initializes the fresh local instance through its first-run credential API.
Leave authentication enabled when reproducing the corrected flow.

Start Kestra in a separate foreground terminal:

```bash
java -Xms256m -Xmx1024m -jar /tmp/campus-v0-lab/kestra-1.3.37 \
  server standalone --config /tmp/campus-v0-lab/kestra.yaml \
  --port 58089 --worker-thread 8 --no-tutorials
```

Wait for the API to respond before running the orchestration probe.
The standalone distribution includes the core HTTP and flow plugins used here.
Do not infer availability of untested plugins or enterprise features from this result.

## Experiment commands

Run these commands from the repository root.
The experiment dependency lockfile is separate from the application lockfile.

```bash
npm ci --prefix docs/validation/v0-2026-09-05/experiments --ignore-scripts
export V0_NODE_MODULES="$PWD/docs/validation/v0-2026-09-05/experiments/node_modules"
node docs/validation/v0-2026-09-05/experiments/runtime-probe.mjs
node docs/validation/v0-2026-09-05/experiments/query-probe.mjs
V0_WORKER_METHOD=GET node docs/validation/v0-2026-09-05/experiments/kestra-probe.mjs
node docs/validation/v0-2026-09-05/experiments/kestra-probe.mjs
```

The scripts reset their synthetic `v0` tables and overwrite their latest result files.
Preserve the previous evidence directory before rerunning a historical result.
The baseline Kestra failure is archived separately and is not overwritten by the corrected script.
GET dispatch exists only to compare the original experiment. The application dispatch contract uses POST.

The recorded dependency run used the same lockfile packages under `/tmp/campus-v0-lab/node`.
The `V0_NODE_MODULES` setting selects the reproduction dependency location without modifying application dependencies.

Run the scaffold checks through Nx:

```bash
NX_DAEMON=false NX_NO_CLOUD=true npm exec -- nx run api:build --skipNxCache
NX_DAEMON=false NX_NO_CLOUD=true npm exec -- nx run frontend:build --skipNxCache
NX_DAEMON=false NX_NO_CLOUD=true npm exec -- nx run frontend:build --skipNxCache \
  --tsConfig=docs/validation/v0-2026-09-05/experiments/frontend-tsconfig.json \
  --outputPath=dist/v0-validation/frontend
```

The ordinary frontend command is expected to reproduce the recorded failure until its production configuration changes.
The experiment configuration must use a workspace-relative path because the tested Nx builder normalizes that path.

The grid compiler fixture uses a separate dependency set under `/tmp/campus-v0-lab/grid`.
Copy the files from `experiments/grid-dependencies/` into that directory and install its lockfile:

```bash
npm ci --prefix /tmp/campus-v0-lab/grid --ignore-scripts
node docs/validation/v0-2026-09-05/experiments/grid-compiler-probe.mjs
V0_BROWSER_EXECUTABLE=/home/seaston/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome \
  node docs/validation/v0-2026-09-05/experiments/grid-browser-probe.mjs
```

Replace the browser executable path with a verified local Chromium installation when reproducing elsewhere.
The recorded run used Chromium 151.0.7922.34. The workspace Playwright default executable was absent.
The browser probe uses the workspace's installed esbuild and Playwright packages and a temporary endpoint on port 58289.
It tests synthetic in-memory edits. It does not implement the application's draft, preview, or mutation flow.
The initial missing-browser and missing-selection-module results remain in the evidence directory.

For the TTL check, set `v0:HoldCrashProbe` with `EX 300` and stop refreshing it.
Record the start time, then inspect `PTTL` after 300 seconds.
This run observed `-2` at 539.64 seconds. It did not measure the exact expiration instant.

## Installation walkthrough still required

| Profile | Prerequisites to verify | Acceptance evidence |
|---|---|---|
| Single server | Supported container host, persistent disk, trusted hostname, HTTPS, backup destination | Prebuilt images boot. Sample inventory works. Restart preserves state. |
| Separate database | Single-server prerequisites plus district PostgreSQL endpoint, credentials, TLS, and migration permissions | Application and workers use the external database. Local defaults remain optional. |
| Cluster | District Kubernetes operators, shared service endpoints, qualified artifact backend, and Kestra availability plan | Multiple API and worker instances pass fault, authorization, storage, and recovery checks. |

Redis and Kestra need explicit placement in every profile. A separate database does not remove either service.
Distributed workers require a qualified shared artifact backend before they start.
The first installation study must record hands-on time, external waiting time, failed steps, and assistance required.
Use the librarian scenario for novice observation. Use district operators for external-service and cluster qualification.

## Cleanup

Stop the foreground Kestra process before stopping its database.
Then stop only the scratch Redis instance and PostgreSQL cluster:

```bash
"$V0_LAB/runtime/usr/bin/redis-cli" -h 127.0.0.1 -p 56389 shutdown nosave
"$V0_PG_BIN/pg_ctl" -D "$V0_LAB/pgdata" -m fast stop
```

Keep evidence in the repository. Scratch runtime files contain no district data.
The repository does not include local authentication credentials or downloaded executables.

The 2026-09-05 run stopped its temporary Kestra, Redis, and PostgreSQL processes after collecting evidence.
The browser probes closed their browser processes and temporary HTTP servers.
Scratch files remain under `/tmp/campus-v0-lab` for inspection and reproduction.

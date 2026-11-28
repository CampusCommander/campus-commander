# Install Campus Commander with your existing services

This guide installs Campus Commander on a controller server and two or more worker hosts.
Your district supplies PostgreSQL, Redis, and NFS shared storage. Campus Commander connects to them over verified TLS.
It assumes Google Workspace super administrator access, Linux command-line experience, and access to your database, storage, and DNS teams.

## Contents

- [Choose a layout](#choose-a-layout)
- [Read this first](#read-this-first)
- [Which services can be your own](#which-services-can-be-your-own)
- [What you need](#what-you-need)
- [Step 1. Plan the names, DNS, certificates, firewall, and proxy](#step-1-plan-the-names-dns-certificates-firewall-and-proxy)
- [Step 2. Create the certificates and passwords](#step-2-create-the-certificates-and-passwords)
- [Step 3. Prepare PostgreSQL](#step-3-prepare-postgresql)
- [Step 4. Prepare Redis](#step-4-prepare-redis)
- [Step 5. Prepare the shared storage](#step-5-prepare-the-shared-storage)
- [Step 6. Prepare the worker hosts](#step-6-prepare-the-worker-hosts)
- [Step 7. Create the Google sign-in client and service account](#step-7-create-the-google-sign-in-client-and-service-account)
- [Step 8. Run the installer on the controller](#step-8-run-the-installer-on-the-controller)
- [Step 9. Start the workers](#step-9-start-the-workers)
- [Step 10. Make yourself the first administrator](#step-10-make-yourself-the-first-administrator)
- [Step 11. Connect your Google Workspace organization](#step-11-connect-your-google-workspace-organization)
- [Operate the installation](#operate-the-installation)
- [Troubleshooting](#troubleshooting)

## Choose a layout

| Layout                       | Guide                                           | Use it when                                                                                        |
| ---------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Trial                        | [Try Campus Commander](try-campus-commander.md) | You want a disposable evaluation at `https://localhost:8443`                                       |
| One server                   | [Install on one server](single-server.md)       | You want one machine to operate. This layout fits a single school and most districts.              |
| One server and your services | This guide                                      | Your district operates PostgreSQL, Redis, and NFS storage, and wants job workers on separate hosts |
| Kubernetes                   | [Install on Kubernetes](kubernetes.md)          | Your district operates a Kubernetes cluster with shared storage and network policy enforcement     |

This layout puts the data on services that your district already backs up, patches, and monitors.
It adds hosts to operate. A small district gets the same features from the one-server layout with less work.

## Read this first

**Every release is a review build.**
The project publishes review builds only. No accepted production release exists yet.

The installer installs the newest signed review build in candidate mode.
Candidate mode requires a project name that starts with `cc-`.
Treat the data in a review build as disposable. Install each new review build on fresh hosts and empty databases.

**Test status of this layout.**
This layout last passed a hosted installation test on 2026-09-09.
That test used an early review build, a controller, and two worker hosts.
The current review builds pass only the one-server tests. Expect to report defects in this layout.

**Known issues in release `phase-3-lab-87410bf7d21b`:**

1. The release has no procedure to replace a certificate of an installation.
   Use certificates that stay valid for the whole review period.
2. The installer checks the HTTPS port as the account that runs it.
   A normal account cannot open a port below 1024, so the check fails for port 443.
   Run the installer as root for an address on port 443.

**Some actions change Google Workspace.**
Device commands, custom attribute categories, and custom attribute values write to your organization.
The trial guide lists each action in [Read this first](try-campus-commander.md#read-this-first).

## Which services can be your own

| Component                          | Runs on                | Notes                                                                           |
| ---------------------------------- | ---------------------- | ------------------------------------------------------------------------------- |
| HTTPS edge, web client, API        | The controller         | Always Campus Commander containers                                              |
| Kestra job engine                  | The controller         | Guided setup always runs Kestra on the controller                               |
| Job workers                        | Your worker hosts      | Two or more hosts with Docker. Guided setup does not accept one host.           |
| Application PostgreSQL database    | Your PostgreSQL server | Required in this layout                                                         |
| Kestra PostgreSQL database         | Your PostgreSQL server | Required in this layout. It can share the server with the application database. |
| Redis cache                        | Your Redis instance    | Required in this layout                                                         |
| Application files and Kestra files | Your NFS export        | Required in this layout                                                         |

Guided setup supports this one combination.
The deployment contract also describes other combinations, such as a district Kestra, or local Redis with district PostgreSQL.
Those combinations need a hand-written configuration and the [installer reference](../../deployment/installer/README.md).
The project has not tested them with review builds. This guide does not cover them.

## What you need

| Item              | Requirement                                                                                                          |
| ----------------- | -------------------------------------------------------------------------------------------------------------------- |
| Controller        | Ubuntu 24.04 LTS or Debian 12 or later, amd64, at least 2 cores, 4 GB of memory, 40 GB of disk, a fixed IPv4 address |
| Worker hosts      | Two or more Ubuntu 24.04 LTS hosts, amd64, at least 1 core and 2 GB of memory each, a fixed IPv4 address each        |
| Docker on workers | Docker Engine 29.7.2 or later within version 29, and Docker Compose 5.5.0 or later within version 5                  |
| PostgreSQL        | PostgreSQL 18.6 exactly, with TLS. Campus Commander refuses other server versions.                                   |
| Redis             | One Redis instance for Campus Commander only, with TLS and ACL users. The project tests Redis 8.0.5.                 |
| Shared storage    | One NFSv4.1 export that the controller and every worker host mount at the same path                                  |
| Host names        | One public name for Campus Commander, one name for the workers, and the names of PostgreSQL and Redis                |
| Certificates      | One certificate for the public name, and certificates from one internal CA for the internal services                 |
| Clock             | Network time synchronization on every host                                                                           |
| Linux accounts    | Root access through `sudo` on every host                                                                             |
| Google            | A super administrator account, and permission to create a Google Cloud project in your organization                  |
| Workstation       | A desktop browser and an SSH client                                                                                  |

The installer prepares the controller. It installs Docker, Docker Compose, Java certificate tools, and its other tools.
You prepare the worker hosts, PostgreSQL, Redis, and the NFS export.
The installer never opens a remote shell and never creates a district service.

The project has not measured capacity for a number of users or devices.
Guided setup gives each Campus Commander service a fixed CPU and memory limit.
Add worker hosts to run jobs in parallel. The controller runs one API process.

## Step 1. Plan the names, DNS, certificates, firewall, and proxy

The examples in this guide use these names and addresses. Replace them with yours.

| Role                     | Example name              | Example address               |
| ------------------------ | ------------------------- | ----------------------------- |
| Campus Commander address | `campus.district.org`     | The controller, `10.20.0.10`  |
| Worker endpoint          | `cc-workers.district.org` | `10.20.0.21` and `10.20.0.22` |
| PostgreSQL               | `pg.district.org`         | `10.20.0.30`                  |
| Redis                    | `redis.district.org`      | `10.20.0.31`                  |
| NFS server               | `nfs.district.org`        | `10.20.0.32`                  |

### Choose intranet access or internet access

| Decision           | Intranet access                                       | Internet access                                                      |
| ------------------ | ----------------------------------------------------- | -------------------------------------------------------------------- |
| Who connects       | Staff on district networks and on the district VPN    | Staff on any network                                                 |
| DNS record         | Internal DNS only                                     | Public DNS, and internal DNS for staff inside the district           |
| Controller address | A private address                                     | A private address behind a firewall with a public address            |
| Public certificate | A public CA certificate, or a district CA certificate | A public CA certificate                                              |
| Inbound firewall   | TCP 443 from staff networks only                      | TCP 443 from the internet, or from the address ranges that you allow |

Only the controller receives browser connections. The worker hosts, PostgreSQL, Redis, and NFS stay on private networks for both choices.
Google sign-in works for both choices. Google sends the browser back to Campus Commander and never connects to your hosts.

### Choose the names

- Use a public name under a domain that your district owns, with a public top-level domain such as `.org`. Google rejects `.local` names and IP addresses in sign-in return addresses.
- The application address is `https://` and the public name, with no path. Port 443 is the default. Another port, such as `:8443`, also works.
- The worker name points at every worker host. Kestra and the API reach the workers through it.
- The web client, the API, and Kestra use the names `frontend`, `api`, and `kestra`. These names exist only inside the Docker network of the controller. They need no DNS records.

### Create the DNS records

| Record                    | Type | Value                                   | View                                                                 |
| ------------------------- | ---- | --------------------------------------- | -------------------------------------------------------------------- |
| `campus.district.org`     | A    | The controller address                  | Internal. Also public for internet access, pointed at your firewall. |
| `cc-workers.district.org` | A    | One record for each worker host address | Internal                                                             |
| `pg.district.org`         | A    | The PostgreSQL address                  | Internal                                                             |
| `redis.district.org`      | A    | The Redis address                       | Internal                                                             |
| `nfs.district.org`        | A    | The NFS server address                  | Internal                                                             |

Every host must resolve every name. Test it on the controller and on each worker host:

```sh
getent hosts campus.district.org cc-workers.district.org pg.district.org redis.district.org nfs.district.org
```

### Plan the certificates

| Certificate        | Names in the certificate  | Issuer                        |
| ------------------ | ------------------------- | ----------------------------- |
| Public certificate | `campus.district.org`     | A public CA, or a district CA |
| Web client         | `frontend`                | The internal CA               |
| API                | `api`                     | The internal CA               |
| Kestra             | `kestra`                  | The internal CA               |
| Workers            | `cc-workers.district.org` | The internal CA               |
| PostgreSQL server  | `pg.district.org`         | The internal CA               |
| Redis server       | `redis.district.org`      | The internal CA               |

Campus Commander verifies every internal connection with one CA file.
That CA must sign the six internal certificates, the PostgreSQL certificate and the Redis certificate included.
Your database team can issue all six from the district CA. Otherwise, [Step 2](#step-2-create-the-certificates-and-passwords) creates an internal CA.
The project has tested one CA for all internal certificates. It has not tested a file with several CAs.

The public certificate follows the rules of the one-server guide: [Get the certificate](single-server.md#get-the-certificate).

### Plan the firewall

| From                            | To                    | Port     | Use                                      |
| ------------------------------- | --------------------- | -------- | ---------------------------------------- |
| Staff networks, or the internet | Controller            | TCP 443  | Campus Commander                         |
| Administrator workstations      | Every host            | TCP 22   | SSH                                      |
| Controller                      | Worker hosts          | TCP 3001 | Job dispatch from Kestra and the API     |
| Controller and worker hosts     | PostgreSQL            | TCP 5432 | Application database                     |
| Controller                      | PostgreSQL            | TCP 5432 | Kestra database                          |
| Controller and worker hosts     | Redis                 | TCP 6379 | Cache and live updates                   |
| Controller and worker hosts     | NFS server            | TCP 2049 | Shared storage                           |
| Controller and worker hosts     | Google                | TCP 443  | Sign-in, Google Workspace data, and jobs |
| Controller and worker hosts     | GitHub and Docker Hub | TCP 443  | Installation and images                  |

Allow port 3001 on the worker hosts from the controller only. Open no other inbound port on the controller.
The outbound host names for Google, GitHub, and Docker Hub are in the one-server guide: [Plan the firewall](single-server.md#plan-the-firewall).

Three rules from that guide also apply to every host here:

- This release has no outbound HTTP proxy setting. The hosts need direct outbound HTTPS to Google.
- The containers trust public CAs only. Exempt the hosts from TLS inspection.
- Docker publishes ports through its own firewall rules. A `ufw` rule does not block a port that Docker publishes.
  Restrict port 443 on the controller and port 3001 on the worker hosts. Use the network firewall, or `DOCKER-USER` rules.

### Decide on a load balancer or reverse proxy

The one-server guide gives the proxy rules: [Decide on a load balancer or reverse proxy](single-server.md#decide-on-a-load-balancer-or-reverse-proxy).
TCP passthrough is the recommended mode. Do not put a proxy between Kestra and the workers. The worker name resolves directly to the worker hosts.

## Step 2. Create the certificates and passwords

Do this step on the controller as root. Skip the CA part when your database team issues the internal certificates.

1. Create a private work directory:

   ```sh
   sudo -i
   umask 077
   mkdir -p /root/cc-files
   cd /root/cc-files
   ```

2. Create the internal CA and the six internal certificates. Replace the names with yours:

   ```sh
   openssl req -x509 -newkey rsa:3072 -nodes -keyout ca.key -out district-ca.pem -days 3650 -subj "/CN=Campus Commander internal CA"
   issue() {
     openssl req -new -newkey rsa:3072 -nodes -keyout "$1-private-key.pem" -out "$1.csr" -subj "/CN=$2"
     printf 'subjectAltName=DNS:%s\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n' "$2" > "$1.ext"
     openssl x509 -req -in "$1.csr" -CA district-ca.pem -CAkey ca.key -CAcreateserial -out "$1-certificate.pem" -days 825 -extfile "$1.ext"
   }
   issue frontend frontend
   issue api api
   issue kestra kestra
   issue workers cc-workers.district.org
   issue postgres pg.district.org
   issue redis redis.district.org
   openssl verify -CAfile district-ca.pem *-certificate.pem
   ```

   The last command must print `OK` for each certificate.
   Give `postgres-certificate.pem`, `postgres-private-key.pem`, and `district-ca.pem` to your database team.
   Give `redis-certificate.pem`, `redis-private-key.pem`, and `district-ca.pem` to the Redis administrator.
   Store `ca.key` offline after this step.

3. Copy the public certificate and its key into the same directory as `edge-certificate.pem` and `edge-private-key.pem`.
   For a district CA, also copy its CA certificate as `edge-ca.pem`.

4. Create the four passwords. Each file holds one password without a line ending:

   ```sh
   for name in campus-database-password kestra-database-password redis-password postgres-migrator; do
     openssl rand -hex 32 | tr -d '\n' > "$name"
   done
   chmod 600 /root/cc-files/*
   ```

   Give the three database passwords to your database team and the Redis password to the Redis administrator.
   Send them through your district password manager, not through email.

## Step 3. Prepare PostgreSQL

Your database team does this step on PostgreSQL 18.6.

1. Install `postgres-certificate.pem` and `postgres-private-key.pem` as the server certificate. Set `ssl = on` in `postgresql.conf`.
2. Allow the Campus Commander roles over TLS only. Add these lines to `pg_hba.conf` and reload PostgreSQL:

   ```text
   hostssl campus campus-owner,application-installer 10.20.0.10/32 scram-sha-256
   hostssl campus campus-owner                       10.20.0.21/32 scram-sha-256
   hostssl campus campus-owner                       10.20.0.22/32 scram-sha-256
   hostssl kestra kestra-owner                       10.20.0.10/32 scram-sha-256
   ```

   Add one `campus-owner` line for each worker host.

3. Download the provisioning script of the release:

   ```sh
   curl -fsSLO https://raw.githubusercontent.com/CampusCommander/campus-commander/87410bf7d21bd8142c9092b378703795a6b66e8b/deployment/postgres/external-provision.sql
   ```

4. Connect as a PostgreSQL administrator with `psql`, and run the script. The `\prompt` lines ask for the passwords, so no password reaches the shell history:

   ```text
   \set app_role campus-owner
   \set migration_role application-installer
   \set app_database campus
   \set kestra_role kestra-owner
   \set kestra_database kestra
   \prompt 'Password from campus-database-password: ' app_password
   \prompt 'Password from postgres-migrator: ' migration_password
   \prompt 'Password from kestra-database-password: ' kestra_password
   \i external-provision.sql
   ```

   The script creates three login roles without administration rights and two UTF8 databases.
   The migration role owns the application database. Campus Commander creates its tables at installation.

5. Test the connection from the controller. The command asks for the password from `campus-database-password`:

   ```sh
   sudo apt install -y postgresql-client
   psql "host=pg.district.org dbname=campus user=campus-owner sslmode=verify-full sslrootcert=/root/cc-files/district-ca.pem" -c 'SHOW server_version'
   ```

   The result must start with `18.6`.

## Step 4. Prepare Redis

The Redis administrator does this step. Use a dedicated Redis instance.
Campus Commander signs in as the Redis `default` user. It limits that user to its own keys.
The instance then cannot serve other applications.

1. Install `redis-certificate.pem`, `redis-private-key.pem`, and `district-ca.pem` on the Redis server.
2. Compute the hash of the Redis password:

   ```sh
   sha256sum redis-password | cut -d' ' -f1
   ```

3. Add these lines to `redis.conf`. Replace `HASH` with the hash and the paths with yours:

   ```text
   port 0
   tls-port 6379
   tls-cert-file /etc/redis/tls/redis-certificate.pem
   tls-key-file /etc/redis/tls/redis-private-key.pem
   tls-ca-cert-file /etc/redis/tls/district-ca.pem
   tls-auth-clients no
   maxmemory 256mb
   maxmemory-policy noeviction
   save ""
   appendonly no
   user default on #HASH ~cc:* &cc:* -@all +ping +get +getdel +mget +set +del +exists +expire +ttl +eval +llen +lrange +rpush +zadd +zrem +zremrangebyscore +time +subscribe +unsubscribe +publish +incr
   user worker on #HASH ~cc:entity:* ~cc:query-gen:* ~cc:entity-inflight:* &cc:entity-events:* &cc:job-events:* -@all +ping +set +del +publish +incr +zadd +zrem +multi +exec
   ```

   These ACL rules are the rules that Campus Commander applies to its own Redis in the one-server layout.
   Redis holds cache data and sign-in sessions only. A Redis restart signs every person out. No backup is necessary.

4. Restart Redis.

## Step 5. Prepare the shared storage

The controller and every worker host mount one NFS export at the same path.
The examples use `/srv/campus-commander` on the NFS server and on every host.

1. On the NFS server, create the directories for user ID 1000. Campus Commander runs as that user ID on every host:

   ```sh
   sudo install -d -m 755 /srv/campus-commander
   sudo install -d -o 1000 -g 1000 -m 700 /srv/campus-commander/artifacts /srv/campus-commander/kestra-internal
   ```

2. Export the directory to the controller and to each worker host. Add a line to `/etc/exports`, then run `sudo exportfs -ra`:

   ```text
   /srv/campus-commander 10.20.0.10(rw,sync,no_subtree_check) 10.20.0.21(rw,sync,no_subtree_check) 10.20.0.22(rw,sync,no_subtree_check)
   ```

3. On the controller and on each worker host, mount the export:

   ```sh
   sudo apt install -y nfs-common
   sudo install -d -m 755 /srv/campus-commander
   echo 'nfs.district.org:/srv/campus-commander /srv/campus-commander nfs4 nfsvers=4.1,hard,_netdev 0 0' | sudo tee -a /etc/fstab
   sudo mount /srv/campus-commander
   ls -ln /srv/campus-commander
   ```

   The last command must show `artifacts` and `kestra-internal`, owned by `1000 1000`.

The artifact store requires exclusive file creation, file sync, and directory sync, and rejects symbolic links.
Your storage team owns the durability of the export. Keep artifacts and Kestra files in separate directories.

## Step 6. Prepare the worker hosts

Do this step on each worker host.

1. Install Docker Engine and Docker Compose from the Docker package repository:

   ```sh
   sudo apt update
   sudo apt install -y ca-certificates curl
   sudo install -m 0755 -d /etc/apt/keyrings
   sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
   echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list
   sudo apt update
   sudo apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
   ```

2. Check the versions. Docker Engine must be 29.7.2 or later within version 29. Docker Compose must be 5.5.0 or later within version 5:

   ```sh
   sudo docker version --format '{{.Server.Version}}'
   sudo docker compose version --short
   ```

3. Create the installation directory with the same path as on the controller:

   ```sh
   sudo install -d -m 700 /opt/campus-commander
   ```

4. Check the clock, the DNS names, and the NFS mount, as in Steps 1 and 5.

## Step 7. Create the Google sign-in client and service account

Follow Steps 3, 4, and 5 of the [trial guide](try-campus-commander.md#step-3-create-a-google-cloud-project).
In Step 4, enter your address with `/api/auth/callback` added as the redirect URI, for example `https://campus.district.org/api/auth/callback`.

Copy the downloaded client JSON file to the controller as `/root/cc-files/google-client.json`, with mode 600.
Keep the service account key file on your workstation. You upload it through the browser in Step 11.

## Step 8. Run the installer on the controller

Run the installer as root on the controller.

1. Download and start the installer:

   ```sh
   sudo -i
   cd /root
   curl -fsSL https://raw.githubusercontent.com/CampusCommander/campus-commander/main/install.sh -o campus-commander-install.sh
   sh campus-commander-install.sh --profile hybrid --qualification --root /opt/campus-commander
   ```

2. When a prerequisite is missing, select **Install automatically**.

3. Answer the questions. Press Enter to accept a default in brackets.

   | Question                                                                                               | Answer                                                                                     |
   | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
   | License                                                                                                | Read it and accept it                                                                      |
   | `Type candidate-lab to acknowledge ...`                                                                | `candidate-lab`                                                                            |
   | `Installation project or namespace`                                                                    | A name that starts with `cc-`, for example `cc-campus`                                     |
   | `Public HTTPS URL`                                                                                     | `https://campus.district.org`                                                              |
   | `Public HTTPS certificate trust (system-ca/private-ca)`                                                | `system-ca` for a public CA, `private-ca` for a district CA                                |
   | `HTTPS bind IPv4 address`                                                                              | The controller address, `10.20.0.10`                                                       |
   | `Readiness connection IPv4 address`                                                                    | Press Enter                                                                                |
   | `Lab prerequisite exceptions, comma-separated names, or none`                                          | `none`                                                                                     |
   | `Distinct worker host count`                                                                           | The number of worker hosts, for example `2`                                                |
   | `Worker host 1 bind IPv4 address`, and one question for each host                                      | `10.20.0.21`, then `10.20.0.22`                                                            |
   | `frontend endpoint URL without credentials`                                                            | `https://frontend:8080`                                                                    |
   | `api endpoint URL without credentials`                                                                 | `https://api:3000`                                                                         |
   | `workers endpoint URL without credentials`                                                             | `https://cc-workers.district.org:3001`                                                     |
   | `applicationDatabase endpoint URL without credentials`                                                 | `postgresql://pg.district.org:5432`                                                        |
   | `kestraDatabase endpoint URL without credentials`                                                      | `postgresql://pg.district.org:5432`                                                        |
   | `redis endpoint URL without credentials`                                                               | `rediss://redis.district.org:6379`                                                         |
   | `kestra endpoint URL without credentials`                                                              | `https://kestra:8080`                                                                      |
   | `... responsible operator` of the database and Redis services                                          | The team that runs each service, for example `district-dba`                                |
   | `... database name` and `... application role`                                                         | Press Enter (`campus`, `campus-owner`, `kestra`, `kestra-owner`)                           |
   | `... persistence storage path or managed storage identifier`                                           | A record of where the database or Redis team keeps the data, for example `pg.district.org` |
   | `services.kestra.internalStorage storage path ...`                                                     | `/srv/campus-commander/kestra-internal`                                                    |
   | `artifacts storage path ...`                                                                           | `/srv/campus-commander/artifacts`                                                          |
   | Capacities and the other responsible operators                                                         | Press Enter for each                                                                       |
   | `Application phase (1, 2, or 3)`                                                                       | Press Enter (`3`)                                                                          |
   | `Sign-in provider (google/oidc)`                                                                       | `google`                                                                                   |
   | `Google client import (browser/file)`                                                                  | `file`                                                                                     |
   | `Downloaded Google Web application JSON file`                                                          | `/root/cc-files/google-client.json`                                                        |
   | Session lifetimes                                                                                      | Press Enter for each                                                                       |
   | `...frontend.endpoint.tls.caSecretRef protected source FILE path`                                      | `/root/cc-files/district-ca.pem`. This one file serves every internal connection.          |
   | `...frontend.serverTls...`, `...api.serverTls...`, `...workers.serverTls...`, `...kestra.serverTls...` | The matching `*-certificate.pem` and `*-private-key.pem` files                             |
   | `...applicationDatabase.passwordSecretRef ...`                                                         | `/root/cc-files/campus-database-password`                                                  |
   | `...kestraDatabase.passwordSecretRef ...`                                                              | `/root/cc-files/kestra-database-password`                                                  |
   | `...redis.passwordSecretRef ...`                                                                       | `/root/cc-files/redis-password`                                                            |
   | `...edge.endpoint.tls.caSecretRef ...`                                                                 | `/root/cc-files/edge-ca.pem`. Only `private-ca` asks this question.                        |
   | `...edge.serverTls.certificateSecretRef ...` and `...privateKeySecretRef ...`                          | `/root/cc-files/edge-certificate.pem` and `/root/cc-files/edge-private-key.pem`            |
   | `Existing application migration role`                                                                  | Press Enter (`application-installer`)                                                      |
   | `Migration password protected FILE path`                                                               | `/root/cc-files/postgres-migrator`                                                         |

4. The installer prepares the worker files and pauses.
   It prints the files to copy, one start command for each worker host, and the question
   `Have all declared workers started with shared storage and credential mounts (yes/no)`.
   Leave the question open and continue with Step 9.

## Step 9. Start the workers

The installer prints three groups of paths. Each worker host needs them at the same paths:

- `/opt/campus-commander/runtime/profile.json`
- The worker credential files under `/opt/campus-commander/private/`
- `/opt/campus-commander/docker-compose.worker-N.json`, with the number of that host

1. In a second root shell on the controller, pack the files of worker 1. Copy the private paths exactly as the installer printed them:

   ```sh
   cd /
   tar -czf /root/worker-1.tgz opt/campus-commander/runtime/profile.json opt/campus-commander/docker-compose.worker-1.json opt/campus-commander/private/PRINTED-FILE-1 opt/campus-commander/private/PRINTED-FILE-2
   chmod 600 /root/worker-1.tgz
   ```

   Write each printed path without its first `/`.

2. Copy the archive to worker host 1, and unpack it there:

   ```sh
   scp /root/worker-1.tgz YOUR_USER@10.20.0.21:
   ```

   ```sh
   sudo tar -C / -xpzf ~/worker-1.tgz
   rm ~/worker-1.tgz
   ```

3. On worker host 1, run the start command that the installer printed for it. It has this form:

   ```sh
   sudo docker compose -f /opt/campus-commander/docker-compose.worker-1.json -p cc-campus-worker-1 up -d
   ```

4. Repeat steps 1 to 3 for each worker host with its number. Then delete the archives on the controller.
5. Return to the installer and type `yes`.
   The installer checks PostgreSQL, Redis, the certificates, and the shared storage. Then it starts the controller services.
   The first start downloads the images and takes several minutes. Success prints `ready` and your address.

If you type `no`, the installation pauses. The installer prints its resume command. Run it after the workers start.

## Step 10. Make yourself the first administrator

After `ready`, the installer prints an administrator setup address and a pairing code. The code expires after ten minutes.

1. On your workstation, open the browser profile of your school Google account.
2. Open the administrator setup address and enter the pairing code.
3. Sign in with your Google Workspace administrator account.
4. Return to the terminal. Check the account that the installer shows, and type `yes`.
5. The browser reports completion. Select **Sign in to Campus Commander**.

Then delete `/root/cc-files` on the controller. Keep `ca.key` offline.

## Step 11. Connect your Google Workspace organization

Follow [Step 8 of the trial guide](try-campus-commander.md#step-8-connect-your-google-workspace-organization).
Then open **Diagnostics** and check each Google capability.

## Operate the installation

Run the installer commands as root on the controller.

| Task                                             | Command                                                                              |
| ------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Show the readiness of the services               | `sh /root/campus-commander-install.sh --root /opt/campus-commander --command status` |
| Resume after an interruption or an expired code  | `sh /root/campus-commander-install.sh --root /opt/campus-commander --command resume` |
| Remove the controller services and keep the data | `sh /root/campus-commander-install.sh --root /opt/campus-commander --uninstall`      |

The installer does not stop or remove the workers. On each worker host, use its project name:

```sh
sudo docker compose -f /opt/campus-commander/docker-compose.worker-1.json -p cc-campus-worker-1 stop
sudo docker compose -f /opt/campus-commander/docker-compose.worker-1.json -p cc-campus-worker-1 down
```

`stop` stops the worker. `down` removes its containers. Neither command changes the shared storage.
The uninstall command keeps PostgreSQL, Redis, and the NFS data. Your teams remove them when the installation ends.

`/opt/campus-commander/private/google-key-1` on the controller holds the Google connection key.
Without that file, the stored service account key is unreadable. Copy `/opt/campus-commander` to a protected location after the installation.

The installer also has an update command. It requires a verified backup and pauses for the worker hosts. This guide does not cover it.
Install each new review build on fresh hosts and empty databases instead.
To remove Google access, follow [Check, restart, and remove the installation](try-campus-commander.md#check-restart-and-remove-the-installation) in the trial guide.

## Troubleshooting

### The `external-applicationDatabase` or `external-kestraDatabase` check fails

- Run the `psql` test of [Step 3](#step-3-prepare-postgresql) on the controller. The server version must start with `18.6`.
- The certificate of PostgreSQL must hold the name in the endpoint URL, and `district-ca.pem` must verify it.
- `pg_hba.conf` must allow the role from the address of the host, with `hostssl`.

### The `external-redis` check fails

- The Redis certificate must hold the name in the endpoint URL, and `district-ca.pem` must verify it.
- The hash in `redis.conf` must come from the same `redis-password` file that you gave the installer.
- Test the connection from the controller: `redis-cli --tls --cacert /root/cc-files/district-ca.pem -h redis.district.org -p 6379 --user default --askpass ping`. The answer must be `PONG`.

### The storage check fails

Run `ls -ln /srv/campus-commander` on the controller. Both directories must belong to `1000 1000` with mode `drwx------`.
The directories must not be symbolic links. Correct them on the NFS server.

### Jobs stay in the waiting state

Kestra cannot reach the workers. On the controller, test each worker host:

```sh
curl --cacert /opt/campus-commander/private/district-ca -o /dev/null -w '%{http_code}\n' https://cc-workers.district.org:3001/health
```

The command prints `200` for a running worker. A connection error points at DNS, at port 3001 in the firewall, or at a stopped worker.

### Other problems

The one-server guide covers the `https-port`, `district-dns`, and `edge-certificate` checks, the 421 answer, and the sign-in errors: [Troubleshooting](single-server.md#troubleshooting).

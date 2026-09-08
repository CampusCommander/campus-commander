# All-Docker profile

The renderer accepts a validated `all-docker` configuration and a Linux amd64 release manifest. It writes exact image digests into Compose. The profile contains no image builds.

Run the deployment build before using these commands. Prepare credentials and operator files in a private installation directory:

```sh
node deployment/profiles/all-docker/prepare.mjs deployment/examples/all-docker.json /absolute/install
```

Supply the edge certificate and private key at `/absolute/install/private/edge-certificate` and `/absolute/install/private/edge-private-key`. Protect both files with mode `0600`.

Render and start the profile:

```sh
node deployment/profiles/all-docker/render.mjs deployment/examples/all-docker.json release-manifest.json /absolute/install/docker-compose.yml
docker compose --file /absolute/install/docker-compose.yml up --detach --wait
```

`docker compose stop` preserves PostgreSQL, artifact, and Kestra volumes. The Redis cache uses a temporary filesystem and starts empty. Explicit erasure requires this separate command:

```sh
node deployment/profiles/all-docker/erase.mjs --confirm-data-loss /absolute/install/docker-compose.yml
```

Only the edge service publishes a host port. All other services use the internal Compose network.

The installer retains ownership of private host files. The `volume-permissions` initialization service copies each required file into a service-specific volume. It sets application copies to UID and GID `1000`, with directory mode `0700` and file mode `0600`. Each application service mounts only its assigned volumes, read-only, and runs as UID `1000`. This process supports root and non-root installer accounts without changing host file permissions.

The PostgreSQL entrypoint reads its administrator password as root, then starts PostgreSQL as its database user. The initialization service exits before dependent application services start. Docker administrators can access the original files and Docker volumes. Protect Docker access accordingly.

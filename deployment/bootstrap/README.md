# Phase 1 bootstrap access

CC-12 supplies temporary installation access before Phase 2 application authentication.
The HTTPS edge protects frontend assets and startup responses with a generated credential.
Use username `operator` with that credential in the browser authentication prompt.

## Credential lifecycle

Generate a credential into a new private file:

```sh
node deployment/bootstrap/cli.mjs generate /private/installation-bootstrap
```

Mount the file at the profile bootstrap secret reference.
Run application migrations before initializing bootstrap state.

```sh
node deployment/bootstrap/cli.mjs initialize /configuration/profile.json
```

Initialization stores a hash and a one-hour expiry in PostgreSQL.
Repeated initialization preserves the existing hash, generation, and expiry.
A different credential fails until an operator performs controlled replacement.
Expired or revoked credentials cannot authenticate.
Database failure denies bootstrap access.

For recovery, generate a new private credential file and mount it at the configured reference.
Inspect the current generation through the operator database connection.
Replace the credential with that expected generation:

```sh
node deployment/bootstrap/cli.mjs replace /configuration/profile.json 1
```

Concurrent replacement rejects a stale generation.
Replacement invalidates the previous credential and establishes a new expiry.
The generation argument above is illustrative. Use the value from the installation.
Revoke access with the `revoke` command and the current generation.
Keep credential files outside release bundles, logs, and database backups.

## HTTPS runtime

The API image contains both the API runtime and the separate edge entry point.
Run `node deployment/bootstrap/main.mjs` with `CC_CONFIG_FILE` pointing to the mounted profile.
The edge listens on port 8443 unless `PORT` selects another internal port.
Map the public district HTTPS port to that listener.
Mount the configured certificate and private key read-only.
Kubernetes secret references resolve under `/run/secrets/<name>/<key>`.
Use browser-trusted district certificates for operator acceptance.

Only GET and HEAD routes for startup content and local assets pass the edge.
The edge rejects worker, Kestra, and future application routes.
`/health/live` reports process liveness without credentials.
`/health` and `/health/ready` report only readiness status.
`/api/startup` requires bootstrap access before returning component checks.
The edge does not forward credentials to the frontend.
It forwards bootstrap authorization only to approved API routes.
Upstream HTTPS connections verify certificate trust and hostname.

## Validation boundary

`npm exec nx run deployment:bootstrap-test` checks HTTPS access denial and route restrictions.
The PostgreSQL integration fixture checks durable credential lifecycle behavior.
The API checks application migrations, both databases, Redis, frontend, API, workers, artifact storage, and authenticated Kestra access.
It reports fixed component names and readiness states without connection or credential values.
The edge calls only the API and frontend. It does not resolve database or service credentials.
Full browser and profile acceptance remain CC-13 through CC-20 work.

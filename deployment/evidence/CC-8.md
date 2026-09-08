# CC-8 evidence

Date: 2026-09-08. Scope: isolated Redis foundation.

The Docker registry resolved Redis 8.0.5 Alpine to:
`sha256:6c8e66693fa71bad36ae06c75c990446ad01dbd4b081dd847eb9869f20d7c6ee`.
Docker image inspection reported `amd64`. Docker Engine reported 29.7.2.

The isolated `deployment/redis/qualify.mjs` probe passed:

- Unauthenticated PING returned NOAUTH.
- Authenticated namespaced SET and GET preserved matching synthetic bytes.
- A key outside `cc:*` returned NOPERM.
- Application access to CONFIG returned NOPERM.
- The container published no host ports.
- Restart removed the synthetic key under `discard-cache`.
- The process ran as UID 999 with a read-only root filesystem and no Linux capabilities.

`npm exec nx run deployment:qualify-redis` passed the same container checks through Nx.
`npm exec nx run deployment:redis-test -- --verbose` passed two readiness tests.
The TLS fixture accepted its private CA and rejected unknown certificate trust.
The authentication failure fixture returned a fixed diagnostic without its synthetic credential marker.
Tests required approved local socket access. The restricted sandbox rejected listener creation.

The renderer supplies local TLS settings and rejects external service ownership.
Actual district Redis endpoint qualification and complete public-edge isolation remain `not-run`.
CC-13 through CC-18 must establish integrated profile evidence.
This record does not close those acceptance gates.

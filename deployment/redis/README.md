# Redis foundation

CC-8 selects Redis 8.0.5 Alpine for Linux amd64.
`runtime.mjs` records the verified immutable image reference.
The image remains an upstream Redis artifact.

Run `npm exec nx run deployment:qualify-redis` for isolated local qualification.
The probe creates and removes only its randomly named container and temporary files.

## Configuration

Build the deployment validator before invoking `runtime.mjs`.
Pass a validated profile path and a new private output path.
The renderer resolves the declared credential file and writes its SHA-256 ACL hash.
Credential files contain exact bytes without a trailing newline.
Protect generated configuration with the same controls as credential material.
Mount configuration and certificates read-only into the Redis container.
Run Redis without root privileges or published host ports.

The runtime enables authentication and limits keys and channels to `cc:*`.
The Phase 1 ACL permits PING, GET, SET, DEL, EXISTS, EXPIRE, and TTL.
Later phases must add commands only with their protocol tests.
Redis denies administrative commands to the application credential.
TLS listeners use the declared certificate and private key.
TLS clients must verify the endpoint hostname and certificate trust.
External operators own Redis provisioning and must match this policy before application readiness succeeds.

## Persistence and memory

The existing configuration contract selects `discard-cache`.
This runtime disables snapshots and append-only persistence.
The deployment must not declare an unused Redis data volume.
The existing persistence field records placement and capacity, not permission to restore stale cache state.
The container uses a disposable `/data` mount.

| Data class                            | Authority                                    | Restart behavior                                    |
| ------------------------------------- | -------------------------------------------- | --------------------------------------------------- |
| Synthetic Phase 1 keys                | Disposable fixture                           | Absent after restart                                |
| Future browsing caches and selections | Rebuildable state                            | Rebuild or expire                                   |
| Future sessions                       | Temporary access state                       | Require sign-in again                               |
| Future admission holds                | PostgreSQL job state with Redis coordination | Phase 5 must qualify reconciliation before dispatch |

The runtime sets `noeviction` and allocates half the declared memory limit to Redis data.
Memory exhaustion rejects writes. It does not silently evict coordination keys.
The remaining memory provides process overhead. CC-18 must measure resource limits for each profile.
Phase 1 does not implement sessions, selections, or admission holds.

## Sources

[Redis persistence](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/) documents persistence modes.
[Redis security](https://redis.io/docs/latest/operate/oss_and_stack/management/security/) documents authentication and transport protection.
[Redis eviction](https://redis.io/docs/latest/develop/reference/eviction/) defines memory limits and `noeviction` behavior.

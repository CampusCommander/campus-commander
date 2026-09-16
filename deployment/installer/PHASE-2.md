# Phase 2 installation

Select phase `2` during guided setup to configure application sign-in.
Existing Phase 1 answers default to phase `1`.
Setup obtains the OIDC issuer, client identifier, session limits, and a protected client-secret file.
Setup never requests a client secret as a command argument or terminal answer.

Register the exact callback `${publicOrigin}/api/auth/callback` with the identity provider.
Use the public HTTPS origin from setup. Request `openid profile` scopes.
Keep background Google authorization separate from application sign-in.

## Protected answers

Add these answers to the existing protected installation answers file:

```json
{
  "phase": "2",
  "applicationAuth.issuer": "https://identity.district.edu",
  "applicationAuth.clientId": "campus-commander",
  "applicationAuth.sessionLifetimeSeconds": 28800,
  "applicationAuth.sessionIdleSeconds": 1800,
  "files.oidc-client": "/protected/oidc-client"
}
```

For Kubernetes, replace `files.oidc-client` with `files.campus-oidc.client-secret`.
The file must match the existing `campus-oidc` Secret and its `client-secret` key.
Setup accepts alternate Secret names and keys through `applicationAuth.clientSecretRef.name` and `applicationAuth.clientSecretRef.key`.
The corresponding `files.<name>.<key>` answer must use those names.

Kubernetes also requires `kubernetes.externalEgress.identityProvider` as a comma-separated CIDR list.
Include every provider discovery, token, and signing-key endpoint network.
The API alone receives the client secret and provider egress policy.
Review network ranges when the identity provider changes its endpoints.

## Enrollment and readiness

Complete [administrator enrollment](../bootstrap/APPLICATION-ACCESS.md) with the installation migration role after migrations finish.
Installation readiness retains the bootstrap-protected `/api/startup` route in both phases.
Application cookies do not grant access to this operator route.
The application exposes account and Diagnostics pages after authorized OIDC sign-in.

## Image identity

Run `npx nx run-many -t image -p api,frontend,worker` to build application images.
Set `CC_IMAGE_VERSION` to the release version before a release build.
Images record the Git revision. Local changes append `-dirty` to the build identifier.
The API supplies these image identifiers to the authenticated shell footer.
Only clean, committed images qualify for release publication.

## Upgrade from Phase 1

1. Create and verify an encrypted foundation backup with the existing operator procedure.
2. Preserve the current profile, release manifest, installer state, and credential files.
3. Register the OIDC callback for the existing public HTTPS origin.
4. Apply the [application Redis ACL](../redis/README.md#configuration) to district-managed Redis before the upgrade.
5. Add `applicationAuth` to a copy of the current deployment configuration and set `phase` to `2`.
6. Set `services.edge.access` to `application` and select the verified Phase 2 image digests.
7. Preserve all service endpoints, placement, storage locations, and existing infrastructure settings.
8. Supply the protected OIDC client-secret file or Kubernetes Secret to the API.
9. Invoke `upgrade` with the target configuration, verified release, previous release hash, and verified backup details.
10. Resume an interrupted upgrade with the same target configuration and release.
11. Enroll the initial administrator after migrations finish.
12. Verify sign-in, all four Diagnostics checks, sign-out, and existing artifact persistence.

The installer rejects an in-place Phase 2 to Phase 1 downgrade.
Use an isolated backup restore for recovery and verify its state before directing application traffic to it.
Discard Redis sessions after restore. Review application and service credentials before reopening access.

## Upgrade qualification

Run `npx nx run api-e2e:upgrade-integration` to exercise the real installer CLI against the recorded Phase 1 candidate.
Local qualification mirrors both image inventories into a disposable loopback registry and verifies unchanged image content.
Docker Desktop uses a TCP relay between workspace loopback and daemon loopback.
The relay preserves registry requests and responses. It does not replace registry verification.
CI supplies all three `CC_AUTH_API_IMAGE`, `CC_AUTH_FRONTEND_IMAGE`, and `CC_AUTH_WORKER_IMAGE` references as published HTTPS digests.
Published references use normal registry verification without the local HTTP fixture.
It uses encrypted backups, distinct image digests, and the Phase 2 migration before administrator enrollment and Diagnostics checks.
The fixture adds a synthetic provider CA and host mapping through a separate runtime Compose file.
The installer retains its verified deployment manifest throughout lifecycle actions.
This qualification does not certify release signatures or district infrastructure.

The registry follows the [CNCF Distribution test deployment procedure](https://distribution.github.io/distribution/about/deploying/).
Production registries require their normal trust and access controls.

Run `npx nx run api-e2e:restore-integration` to extend the upgrade fixture with a complete isolated application restore.
The restore fixture preserves identity, preferences, security events, and artifact bytes in separate databases and volumes.
It tests rejection of the source session before another sign-in and all four Diagnostics checks.
Passing this fixture does not complete hybrid, Kubernetes, or published-release restore acceptance.

Run `npx nx run api-e2e:hybrid-upgrade-integration` to upgrade the rendered hybrid profile from the recorded Phase 1 images.
The fixture verifies original migration checksums, artifact metadata and bytes, both worker readers, and Kestra execution and storage.
It then verifies administrator enrollment, login, Diagnostics, restart, preferences, and logout.
This fixture exercises preparation, rendering, and migration commands. It does not exercise the installer CLI.

Run `npx nx run api-e2e:hybrid-restore-integration` to extend that upgrade with an isolated hybrid application restore.
The restore uses native PostgreSQL tools, new database roles and passwords, fresh Redis, and separate storage and networks.
The browser must reject the source session and complete a fresh login with preserved preferences and all four Diagnostics checks.
Both hybrid fixtures use one Docker host and synthetic certificates. District infrastructure and signed publication require separate acceptance.

Run `npx nx run api-e2e:kubernetes-upgrade-integration` to upgrade the rendered Kubernetes profile from published Phase 1 images.
The fixture verifies runtime image content, original migrations, artifact metadata and bytes, worker execution, and Kestra files.
The installer-owned migration job applies Phase 2 before administrator enrollment and browser checks.

Run `npx nx run api-e2e:kubernetes-restore-integration` to extend that upgrade with an isolated application restore.
The target uses another namespace, distinct persistent volumes, restored databases, and fresh Redis.
The browser must reject the source session and preserve preferences after another login.
Both Kubernetes fixtures use three Kind nodes on one Docker host. They do not qualify district storage or CNI enforcement.

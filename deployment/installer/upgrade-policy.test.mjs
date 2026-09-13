import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { supportedUpgrade } from './upgrade-policy.mjs';

for (const profile of ['all-docker', 'hybrid', 'kubernetes']) {
  test(`${profile} upgrade admits Phase 2 authentication and preserves topology and storage`, async () => {
    const before = JSON.parse(
      await readFile(new URL(`../examples/${profile}.json`, import.meta.url)),
    );
    const after = structuredClone(before);
    after.phase = 2;
    after.services.edge.access = 'application';
    after.applicationAuth = {
      issuer: 'https://identity.district.edu',
      clientId: 'campus',
      publicOrigin: new URL(before.services.edge.endpoint.url).origin,
      clientSecretRef:
        profile === 'kubernetes'
          ? {
              provider: 'kubernetes',
              name: 'campus-oidc',
              key: 'client-secret',
            }
          : { provider: 'file', path: '/run/secrets/oidc-client' },
    };
    after.images.api = `registry.example.org/campus/api@sha256:${'a'.repeat(64)}`;
    assert.equal(supportedUpgrade(before, after), true);
    assert.equal(supportedUpgrade(after, before), false);
    assert.equal(supportedUpgrade(after, structuredClone(after)), true);
    for (const mutate of [
      (config) => {
        config.artifacts.location += '-replacement';
      },
      (config) => {
        config.services.applicationDatabase.database = 'empty-replacement';
      },
      (config) => {
        config.applicationAuth.publicOrigin = 'https://different.district.edu';
      },
    ]) {
      const invalid = structuredClone(after);
      mutate(invalid);
      assert.equal(supportedUpgrade(before, invalid), false);
    }
  });
}

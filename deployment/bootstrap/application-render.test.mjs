import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { renderAllDocker } from '../profiles/all-docker/render.mjs';
import { renderHybrid } from '../profiles/hybrid/render.mjs';
import { renderKubernetes } from '../kubernetes/render.mjs';

for (const profile of ['all-docker', 'hybrid', 'kubernetes']) {
  test(`${profile} isolates OIDC credentials and permits required provider traffic`, async () => {
    const config = JSON.parse(
      await readFile(new URL(`../examples/${profile}.json`, import.meta.url)),
    );
    config.phase = 2;
    config.services.edge.access = 'application';
    config.applicationAuth = {
      issuer: 'https://identity.example.invalid',
      clientId: 'campus-commander',
      publicOrigin: 'https://campus.example.invalid',
      clientSecretRef:
        profile === 'kubernetes'
          ? {
              provider: 'kubernetes',
              name: 'campus-oidc',
              key: 'client-secret',
            }
          : { provider: 'file', path: '/run/secrets/oidc-client-secret' },
    };
    if (profile === 'kubernetes') {
      config.services.api.placement.replicas = 2;
      const operator = JSON.parse(
        await readFile(
          new URL('../kubernetes/operator.example.json', import.meta.url),
        ),
      );
      assert.throws(
        () => renderKubernetes(config, operator),
        /identity-provider egress/,
      );
      operator.externalEgress.identityProvider = ['198.51.100.0/24'];
      const rendered = renderKubernetes(config, operator);
      for (const item of rendered.items.filter(
        (item) => item.kind === 'Deployment',
      )) {
        const spec = item.spec.template.spec;
        assert.equal(
          spec.volumes.some(
            (volume) => volume.secret?.secretName === 'campus-oidc',
          ),
          item.metadata.name === 'api',
        );
      }
      const policies = rendered.items.filter(
        (item) =>
          item.kind === 'NetworkPolicy' &&
          JSON.stringify(item.spec.egress ?? []).includes('198.51.100.0/24'),
      );
      assert.deepEqual(
        policies.map((item) => item.metadata.name),
        ['api-egress'],
      );
      assert.deepEqual(policies[0].spec.egress.at(-1).ports, [
        { protocol: 'TCP', port: 443 },
      ]);
    } else {
      const release = {
        schemaVersion: 1,
        platform: 'linux/amd64',
        images: config.images,
      };
      const compose =
        profile === 'all-docker'
          ? renderAllDocker(config, release)
          : renderHybrid(config, release);
      if (profile === 'all-docker') {
        const staged = compose.services['volume-permissions'].command[2]
          .split('\n')
          .filter(
            (line) =>
              line.startsWith('cp ') && line.includes('oidc-client-secret'),
          );
        assert.equal(staged.length, 1);
        assert.match(staged[0], /api-secrets/);
      } else {
        const staged = compose.services['runtime-files'].command[2]
          .split('\n')
          .filter(
            (line) =>
              line.startsWith('cp ') && line.includes('oidc-client-secret'),
          );
        assert.equal(staged.length, 1);
        assert.match(staged[0], /api-secrets/);
        assert.ok(compose.services.api.networks.includes('egress'));
      }
    }
  });
}

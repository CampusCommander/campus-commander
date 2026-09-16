import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { configure, createQuestions } from './setup.mjs';
import { configureApplication } from './application-setup.mjs';
import { parseDeploymentConfig } from '../../dist/deployment/lib/deployment.js';
import { renderKubernetes } from '../kubernetes/render.mjs';

for (const profile of ['all-docker', 'hybrid', 'kubernetes']) {
  for (const provider of ['oidc', 'google']) {
    test(`guided ${profile} Phase 2 configuration collects protected ${provider} credentials`, async () => {
      const seen = new Set();
      const q = async (key, _label, fallback) => {
        seen.add(key);
        if (key === 'phase') return '2';
        if (key === 'applicationAuth.provider') return provider;
        if (key === 'publicUrl') return 'https://campus.district.edu';
        if (key === 'applicationAuth.issuer')
          return 'https://identity.district.edu';
        if (key === 'applicationAuth.clientId') return 'campus';
        if (key === 'kubernetes.externalEgress.identityProvider')
          return '198.51.100.0/24';
        if (key.startsWith('workerBindAddresses.'))
          return `192.0.2.${Number(key.split('.').at(-1)) + 10}`;
        if (key.endsWith('.url'))
          return (
            fallback ??
            (key.includes('Database')
              ? 'postgresql://database.district.edu:5432'
              : key.includes('redis')
                ? 'rediss://redis.district.edu:6379'
                : `https://${key.split('.')[1]}.district.edu:8443`)
          );
        if (key.startsWith('files.')) return `/protected/${key.slice(6)}`;
        if (key === 'kubernetes.sourceRanges') return '192.0.2.0/24';
        if (fallback !== undefined) return fallback;
        if (key.endsWith('.location'))
          return `/srv/shared/${key.replaceAll('.', '-')}`;
        return 'district-platform';
      };
      const images = JSON.parse(
        await readFile(new URL(`../examples/${profile}.json`, import.meta.url)),
      ).images;
      const plan = await configure({
        releaseRoot: resolve(import.meta.dirname, '../..'),
        root: '/tmp/cc-application-setup',
        profile,
        questions: q,
        manifest: { schemaVersion: 1, images, architectures: ['linux/amd64'] },
        importGoogle: async () => ({
          clientId: '123-test.apps.googleusercontent.com',
          secretPath: '/protected/google-client-secret',
        }),
      });
      parseDeploymentConfig(plan.config);
      assert.equal(
        plan.config.applicationAuth.publicOrigin,
        'https://campus.district.edu',
      );
      assert.equal(plan.config.services.edge.access, 'application');
      const source =
        provider === 'google'
          ? '/protected/google-client-secret'
          : `/protected/${profile === 'kubernetes' ? 'campus-oidc.client-secret' : 'oidc-client'}`;
      assert.ok([...plan.files.values()].includes(source));
      assert.equal(JSON.stringify(plan.config).includes('/protected/'), false);
      if (provider === 'google') {
        assert.equal(seen.has('applicationAuth.clientId'), false);
        assert.equal(
          plan.config.applicationAuth.issuer,
          'https://accounts.google.com',
        );
        assert.equal(seen.has('files.oidc-client'), false);
        assert.equal(seen.has('files.campus-oidc.client-secret'), false);
      }
      if (profile === 'kubernetes') {
        const rendered = renderKubernetes(plan.config, {
          ...plan.operator.kubernetes,
          release: {
            schemaVersion: 1,
            sourceRevision: 'a'.repeat(40),
            images,
            architectures: ['linux/amd64'],
          },
        });
        assert.ok(
          rendered.items.some((item) => item.metadata.name === 'api-egress'),
        );
      }
    });
  }
}

test('Phase 2 questions reject insecure issuer and invalid egress answers', async () => {
  const source = JSON.parse(
    await readFile(new URL('../examples/kubernetes.json', import.meta.url)),
  );
  for (const invalid of [
    { 'applicationAuth.issuer': 'http://identity.district.edu' },
    { 'applicationAuth.issuer': 'https://user:secret@identity.district.edu' },
    { 'kubernetes.externalEgress.identityProvider': '198.51.100.0/999' },
    { 'kubernetes.externalEgress.identityProvider': 'identity.district.edu' },
  ]) {
    const questions = createQuestions({
      phase: '2',
      'applicationAuth.issuer': 'https://identity.district.edu',
      'applicationAuth.clientId': 'campus',
      'kubernetes.externalEgress.identityProvider': '198.51.100.0/24',
      ...invalid,
    });
    await assert.rejects(
      configureApplication(
        structuredClone(source),
        { kubernetes: { externalEgress: {} } },
        questions,
      ),
    );
  }
});

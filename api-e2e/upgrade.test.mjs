import { applicationAccess } from './access-fixture.mjs';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import test from 'node:test';
import { qualifyInstaller } from '../deployment/installer/integration.mjs';
import { startProvider } from './provider-fixture.mjs';
import { applicationBrowser } from './profile-browser.mjs';
import { startRegistry } from './registry-fixture.mjs';
import { qualifyApplicationRestore } from './restore-fixture.mjs';
const execute = promisify(execFile);

test(
  'the real installer upgrades published Phase 1 images into an authenticated Phase 2 application',
  { timeout: 900000 },
  async () => {
    const inventoryRoot = await mkdtemp(join(tmpdir(), 'cc-phase2-upgrade-'));
    let provider;
    let registry;
    try {
      const baseline = JSON.parse(
        await readFile(
          'deployment/qualification/phase-1-upgrade-baseline.json',
          'utf8',
        ),
      );
      for (const image of Object.values(baseline.images)) {
        try {
          await execute('docker', ['image', 'inspect', image]);
        } catch {
          await execute('docker', ['pull', image], {
            timeout: 300000,
            maxBuffer: 8 * 1024 * 1024,
          });
        }
      }
      const images = {};
      const publishedReferences = ['frontend', 'api', 'worker'].map(
        (service) => process.env[`CC_AUTH_${service.toUpperCase()}_IMAGE`],
      );
      const published = publishedReferences.every((reference) =>
        /^ghcr\.io\/campuscommander\/campus-commander-(?:frontend|api|worker)@sha256:[a-f0-9]{64}$/.test(
          reference ?? '',
        ),
      );
      assert.ok(
        published || publishedReferences.every((reference) => !reference),
        'Supply all three published immutable references or use the local image fixture.',
      );
      for (const service of ['frontend', 'api', 'worker']) {
        const ref =
          process.env[`CC_AUTH_${service.toUpperCase()}_IMAGE`] ??
          `campus-commander/${service}:cc-6`;
        const image = JSON.parse(
          (await execute('docker', ['image', 'inspect', ref])).stdout,
        )[0];
        images[service === 'worker' ? 'workers' : service] = ref.includes(
          '@sha256:',
        )
          ? ref
          : image.RepoDigests[0];
      }
      const target = {
        schemaVersion: 1,
        sourceRevision: (
          await execute('git', ['rev-parse', 'HEAD'])
        ).stdout.trim(),
        architectures: ['linux/amd64'],
        images,
        phase: 2,
        qualification: 'candidate-only',
        workingTree: (
          await execute('git', ['status', '--porcelain'])
        ).stdout.trim()
          ? 'uncommitted-candidate'
          : 'clean',
      };
      const a = join(inventoryRoot, 'baseline.json'),
        b = join(inventoryRoot, 'target.json');
      if (!published)
        registry = await startRegistry({ relayImage: images.api });
      await writeFile(
        a,
        JSON.stringify(
          registry ? await registry.mirror(baseline, 'phase1') : baseline,
        ),
        { mode: 0o600 },
      );
      await writeFile(
        b,
        JSON.stringify(
          registry ? await registry.mirror(target, 'phase2') : target,
        ),
        { mode: 0o600 },
      );
      process.env.CC_INSTALLER_RELEASE_A = a;
      process.env.CC_INSTALLER_RELEASE_B = b;
      process.env.CC_INSTALLER_LOCAL_REGISTRY_HTTP = registry ? '1' : '0';
      const result = await qualifyInstaller({
        async configureApplication({ root, publicOrigin }) {
          const privateRoot = join(root, 'qualification-provider');
          await mkdir(privateRoot, { mode: 0o700 });
          const caFile = join(privateRoot, 'provider.crt'),
            keyFile = join(privateRoot, 'provider.key');
          await execute('openssl', [
            'req',
            '-x509',
            '-newkey',
            'rsa:2048',
            '-nodes',
            '-keyout',
            keyFile,
            '-out',
            caFile,
            '-days',
            '1',
            '-subj',
            '/CN=host.docker.internal',
            '-addext',
            'subjectAltName=DNS:host.docker.internal',
          ]);
          const password = randomUUID();
          provider = await startProvider({
            certificate: await readFile(caFile),
            privateKey: await readFile(keyFile),
            publicOrigin,
            password,
          });
          return {
            auth: {
              issuer: provider.issuer,
              clientId: 'qualification',
              publicOrigin,
              clientSecretRef: {
                provider: 'file',
                path: '/run/secrets/oidc-client',
              },
            },
            password,
            caFile,
            async check(fixture) {
              const { root } = fixture;
              const enrolled = applicationAccess(
                join(root, 'docker-compose.json'),
                fixture.project,
                {
                  action: 'initialize',
                  issuer: provider.issuer,
                  subject: 'administrator',
                  displayName: 'Synthetic administrator',
                },
              );
              assert.ok(enrolled.principalId);
              return applicationBrowser(publicOrigin, async (browser) => {
                if (process.env.CC_AUTH_APPLICATION_RESTORE !== '1')
                  return undefined;
                const restoration = await qualifyApplicationRestore({
                  ...fixture,
                  ...browser,
                  caFile,
                });
                await mkdir('dist/phase-2-evidence', { recursive: true });
                await writeFile(
                  'dist/phase-2-evidence/all-docker-restore.json',
                  JSON.stringify(restoration, null, 2),
                );
                return { restoration };
              });
            },
          };
        },
      });
      assert.equal(result.status, 'passed');
      assert.equal(result.application.status, 'passed');
      await mkdir('dist/phase-2-evidence', { recursive: true });
      await writeFile(
        'dist/phase-2-evidence/all-docker-upgrade.json',
        JSON.stringify(
          {
            ...result,
            baseline,
            imageMirrors: registry?.copies ?? [],
            registryTransport: registry?.transport ?? 'published-https',
            limits: [
              'The fixture uses the real current installer CLI and published Phase 1 image digests.',
              'Phase 2 target images remain development artifacts unless published references are supplied.',
              'The fixture adds its synthetic provider CA and host mapping to the rendered API service.',
              ...(registry
                ? [
                    'A disposable HTTP registry mirrors both inventories with unchanged image content through loopback listeners.',
                  ]
                : []),
              'This check does not certify release signatures or district infrastructure.',
            ],
          },
          null,
          2,
        ),
      );
    } finally {
      await provider?.close();
      await registry?.close();
      await rm(inventoryRoot, { recursive: true, force: true });
    }
  },
);

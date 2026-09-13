import { applicationAccess } from './access-fixture.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { expect } from '@playwright/test';
import { startProvider } from './provider-fixture.mjs';
import { applicationBrowser } from './profile-browser.mjs';
import { qualifyHybridUpgrade } from './hybrid-upgrade-fixture.mjs';
import { qualifyHybridApplicationRestore } from './hybrid-restore-fixture.mjs';

const docker = (...args) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 240000,
    maxBuffer: 8 * 1024 * 1024,
  }).trim();

test(
  'rendered hybrid Phase 2 uses external TLS dependencies, two workers, and shared artifacts',
  { timeout: 600000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-phase2-hybrid-provider-'));
    let provider;
    try {
      const listener = createServer().listen(0, '127.0.0.1');
      await once(listener, 'listening');
      const port = listener.address().port;
      await new Promise((done) => listener.close(done));
      const publicOrigin = `https://campus.example.org:${port}`;
      const certificate = join(root, 'provider.crt'),
        privateKey = join(root, 'provider.key');
      execFileSync(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-keyout',
          privateKey,
          '-out',
          certificate,
          '-days',
          '1',
          '-subj',
          '/CN=host.docker.internal',
          '-addext',
          'subjectAltName=DNS:host.docker.internal',
        ],
        { stdio: 'ignore' },
      );
      const password = randomUUID();
      provider = await startProvider({
        certificate: await readFile(certificate),
        privateKey: await readFile(privateKey),
        publicOrigin,
        password,
      });
      const images = Object.fromEntries(
        ['frontend', 'api', 'worker'].map((service) => {
          const ref =
            process.env[`CC_AUTH_${service.toUpperCase()}_IMAGE`] ??
            `campus-commander/${service}:cc-6`;
          const image = JSON.parse(docker('image', 'inspect', ref))[0];
          return [
            service === 'worker' ? 'workers' : service,
            ref.includes('@sha256:') ? ref : image.RepoDigests[0],
          ];
        }),
      );
      const inventory = join(root, 'release.json');
      await writeFile(
        inventory,
        JSON.stringify({
          schemaVersion: 1,
          images,
          architectures: ['linux/amd64'],
        }),
        { mode: 0o600 },
      );
      process.env.CC_QUALIFICATION_RELEASE = inventory;
      const baseline =
        process.env.CC_AUTH_HYBRID_UPGRADE === '1'
          ? JSON.parse(
              await readFile(
                'deployment/qualification/phase-1-upgrade-baseline.json',
                'utf8',
              ),
            )
          : undefined;
      if (baseline) {
        for (const image of Object.values(baseline.images)) {
          try {
            docker('image', 'inspect', image);
          } catch {
            docker('pull', image);
          }
        }
      }
      const { qualifyFullHybrid } = await import(
        '../deployment/profiles/hybrid/full-integration.mjs'
      );
      const result = await qualifyFullHybrid({
        application: {
          baseline,
          ...(baseline
            ? {
                upgrade: (fixture) =>
                  qualifyHybridUpgrade({
                    ...fixture,
                    images,
                    baseline,
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
                    caFile: certificate,
                  }),
              }
            : {}),
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
          caFile: certificate,
          async check(fixture) {
            const { controllerFile, projects, workerFiles } = fixture;
            const compose = (...args) =>
              docker(
                'compose',
                '-f',
                controllerFile,
                '-p',
                projects.controller,
                ...args,
              );
            const enrolled = applicationAccess(
              controllerFile,
              projects.controller,
              {
                action: 'initialize',
                issuer: provider.issuer,
                subject: 'administrator',
                displayName: 'Synthetic administrator',
              },
            );
            assert.ok(enrolled.principalId);
            return applicationBrowser(
              publicOrigin,
              async (browser) => {
                const { page, checks } = browser;
                const preference = page.waitForResponse(
                  (response) =>
                    new URL(response.url()).pathname ===
                      '/api/auth/preferences' &&
                    response.request().method() === 'POST',
                );
                await page
                  .getByRole('button', { name: 'Choose theme' })
                  .click();
                await page
                  .getByRole('menuitem', { name: 'Use dark theme' })
                  .click();
                assert.equal((await preference).status(), 201);
                await expect(page.locator('html')).toHaveAttribute(
                  'data-theme',
                  'dark',
                );
                compose('restart', 'api');
                for (let index = 0; index < workerFiles.length; index++)
                  docker(
                    'compose',
                    '-f',
                    workerFiles[index],
                    '-p',
                    projects.workers[index],
                    'restart',
                    'workers',
                  );
                compose('up', '-d', '--wait', '--wait-timeout', '120');
                await page.reload();
                await expect(
                  page.getByRole('heading', {
                    name: 'Diagnostics',
                    exact: true,
                  }),
                ).toBeVisible({ timeout: 15000 });
                await expect(page.locator('html')).toHaveAttribute(
                  'data-theme',
                  'dark',
                );
                await checks();
                if (process.env.CC_AUTH_HYBRID_RESTORE === '1') {
                  const restoration = await qualifyHybridApplicationRestore({
                    ...fixture,
                    ...browser,
                    caFile: certificate,
                  });
                  await mkdir('dist/phase-2-evidence', { recursive: true });
                  await writeFile(
                    'dist/phase-2-evidence/hybrid-restore.json',
                    JSON.stringify(restoration, null, 2),
                  );
                  return { restoration };
                }
              },
              { recoverySeconds: 120 },
            );
          },
        },
      });
      assert.equal(result.status, 'PASS');
      await mkdir('dist/phase-2-evidence', { recursive: true });
      await writeFile(
        `dist/phase-2-evidence/${baseline ? 'hybrid-upgrade' : 'hybrid-profile'}.json`,
        JSON.stringify(result, null, 2),
      );
    } finally {
      await provider?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

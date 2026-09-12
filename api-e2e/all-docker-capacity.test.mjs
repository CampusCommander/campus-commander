import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { expect } from '@playwright/test';
import { applicationAccess } from './access-fixture.mjs';
import { applicationBrowser } from './profile-browser.mjs';
import { startProvider } from './provider-fixture.mjs';
import { startRegistry } from './registry-fixture.mjs';
const execute = promisify(execFile);

test(
  'all-Docker Diagnostics rejects publication on a full artifact filesystem and recovers without losing application state',
  { timeout: 600000 },
  async () => {
    const inventoryRoot = await mkdtemp('/tmp/cc-phase2-capacity-');
    let provider;
    let registry;
    const previousRelease = process.env.CC_QUALIFICATION_RELEASE;
    try {
      let images = {};
      const revisions = new Set();
      for (const service of ['frontend', 'api', 'worker']) {
        const reference =
          process.env[`CC_AUTH_${service.toUpperCase()}_IMAGE`] ??
          `campus-commander/${service}:cc-6`;
        if (process.env[`CC_AUTH_${service.toUpperCase()}_IMAGE`])
          assert.match(
            reference,
            /^ghcr\.io\/campuscommander\/campus-commander-[a-z]+@sha256:[a-f0-9]{64}$/,
          );
        const image = JSON.parse(
          (await execute('docker', ['image', 'inspect', reference])).stdout,
        )[0];
        revisions.add(image.Config.Labels['org.opencontainers.image.revision']);
        images[service === 'worker' ? 'workers' : service] = reference;
      }
      assert.equal(revisions.size, 1);
      const [imageBuildId] = revisions;
      assert.match(imageBuildId, /^[a-f0-9]{40}(?:-dirty)?$/);
      const sourceRevision = imageBuildId.slice(0, 40);
      const supplied = ['frontend', 'api', 'worker'].filter(
        (service) => process.env[`CC_AUTH_${service.toUpperCase()}_IMAGE`],
      );
      assert.ok(supplied.length === 0 || supplied.length === 3);
      if (supplied.length === 0) {
        registry = await startRegistry({ relayImage: images.api });
        images = (await registry.mirror({ images, sourceRevision }, 'capacity'))
          .images;
      } else assert.equal(imageBuildId, sourceRevision);
      const releasePath = join(inventoryRoot, 'release.json');
      await writeFile(releasePath, JSON.stringify({ images, sourceRevision }), {
        mode: 0o600,
      });
      process.env.CC_QUALIFICATION_RELEASE = releasePath;
      const { qualifyProfileCapacity } = await import(
        '../deployment/qualification/profile-capacity-integration.mjs'
      );
      const result = await qualifyProfileCapacity(
        join(inventoryRoot, 'capacity.json'),
        {
          async configureApplication({ root, publicOrigin }) {
            const directory = join(root, 'qualification-provider');
            await mkdir(directory, { mode: 0o700 });
            const caFile = join(directory, 'provider.crt'),
              keyFile = join(directory, 'provider.key');
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
              async check({
                project,
                composeFile,
                executeCode,
                runQualification,
              }) {
                const enrolled = applicationAccess(composeFile, project, {
                  action: 'initialize',
                  issuer: provider.issuer,
                  subject: 'administrator',
                  displayName: 'Synthetic administrator',
                });
                assert.ok(enrolled.principalId);
                const state = async () =>
                  JSON.parse(
                    await executeCode(
                      'api',
                      `import fs from 'node:fs/promises';import pg from 'pg';
import {connectionOptions} from '/app/deployment/postgres/index.mjs';import {secretPath} from '/app/deployment/redis/runtime.mjs';
const c=JSON.parse(await fs.readFile(process.env.CC_CONFIG_FILE));const pool=new pg.Pool(await connectionOptions(c.services.applicationDatabase,r=>fs.readFile(secretPath(r))));
const principals=(await pool.query('SELECT * FROM cc.application_principals ORDER BY id')).rows;
const events=(await pool.query('SELECT * FROM cc.security_events ORDER BY id')).rows;
const migrations=(await pool.query('SELECT id,checksum FROM cc.schema_migrations ORDER BY id')).rows;
const artifacts=(await pool.query('SELECT id,attempt_id,publication_state,active FROM cc.artifacts ORDER BY id')).rows;
const artifactFiles=(await fs.readdir(c.artifacts.location)).filter(name=>/^[a-f0-9-]{36}\\.[a-f0-9-]{36}$/.test(name)).sort();
await pool.end();console.log(JSON.stringify({principals,events,migrations,artifacts,artifactFiles}));`,
                    ),
                  );
                let capacityReport, baseline, preserved, observed;
                const application = await applicationBrowser(
                  publicOrigin,
                  async ({ page, checks }) => {
                    const saved = page.waitForResponse(
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
                    assert.equal((await saved).status(), 201);
                    const verifyState = async () => {
                      const current = await state();
                      assert.deepEqual(current.principals, baseline.principals);
                      assert.deepEqual(current.migrations, baseline.migrations);
                      const events = new Map(
                        current.events.map((event) => [event.id, event]),
                      );
                      for (const event of baseline.events)
                        assert.deepEqual(events.get(event.id), event);
                      return {
                        principalCount: current.principals.length,
                        preservedSecurityEvents: baseline.events.length,
                        identityAndPreferencesPreserved: true,
                        migrationsPreserved: true,
                      };
                    };
                    capacityReport = await runQualification({
                      async beforeFault() {
                        baseline = await state();
                        assert.equal(baseline.principals.length, 1);
                        assert.ok(baseline.events.length > 0);
                      },
                      async duringFault() {
                        const card = page.getByRole('article').filter({
                          has: page.getByRole('heading', {
                            name: 'Artifact storage',
                            exact: true,
                          }),
                        });
                        const response = page.waitForResponse(
                          (result) =>
                            new URL(result.url()).pathname ===
                              '/api/diagnostics/artifacts' &&
                            result.request().method() === 'POST',
                        );
                        await card
                          .getByRole('button', {
                            name: 'Check Artifact storage',
                            exact: true,
                          })
                          .click();
                        const result = await response;
                        assert.equal(result.status(), 201);
                        const body = await result.json();
                        assert.equal(body.status, 'failed');
                        assert.match(body.correlationId, /^[a-f0-9-]{36}$/);
                        observed = {
                          httpStatus: result.status(),
                          status: body.status,
                          correlationId: body.correlationId,
                        };
                        await expect(
                          card.getByText(
                            'The check failed. Inspect the service configuration and retry.',
                          ),
                        ).toBeVisible();
                        await verifyState();
                      },
                      async afterRecovery() {
                        await checks({ recoverySeconds: 60 });
                        await expect(page.locator('html')).toHaveAttribute(
                          'data-theme',
                          'dark',
                        );
                        preserved = await verifyState();
                        assert.deepEqual(
                          (await state()).artifacts,
                          baseline.artifacts,
                          'Capacity recovery must remove failed Diagnostics staging metadata.',
                        );
                        assert.deepEqual(
                          (await state()).artifactFiles,
                          baseline.artifactFiles,
                          'Capacity recovery must remove failed Diagnostics artifact files.',
                        );
                        preserved.failedDiagnosticArtifactsRemoved = true;
                      },
                    });
                  },
                );
                return {
                  ...capacityReport,
                  application,
                  authenticatedFailure: observed,
                  preserved,
                };
              },
            };
          },
        },
      );
      assert.equal(result.status, 'PASS');
      assert.equal(result.application.status, 'passed');
      assert.equal(result.cleanupPolicy.removedOnlyOwnedResources, true);
      await registry?.close();
      registry = undefined;
      await provider?.close();
      provider = undefined;
      await mkdir('dist/phase-2-evidence', { recursive: true });
      await writeFile(
        'dist/phase-2-evidence/all-docker-capacity.json',
        JSON.stringify(
          {
            status: 'passed',
            profile: 'all-docker',
            sourceRevision,
            imageBuildId,
            qualificationWorkingTree: imageBuildId.endsWith('-dirty')
              ? 'uncommitted-candidate'
              : 'clean',
            images,
            recordedAt: new Date().toISOString(),
            application: result.application,
            capacity: result,
            ownedResourcesRemoved: true,
            limits: result.limits,
          },
          null,
          2,
        ),
      );
    } finally {
      await provider?.close();
      await registry?.close();
      if (previousRelease === undefined)
        delete process.env.CC_QUALIFICATION_RELEASE;
      else process.env.CC_QUALIFICATION_RELEASE = previousRelease;
      await rm(inventoryRoot, { recursive: true, force: true });
    }
  },
);

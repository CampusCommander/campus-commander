import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { expect } from '@playwright/test';
import { prepareAllDocker } from '../deployment/profiles/all-docker/prepare.mjs';
import { renderAllDocker } from '../deployment/profiles/all-docker/render.mjs';
import { httpsStartup } from '../deployment/qualification/faults.mjs';
import { startProvider } from './provider-fixture.mjs';
import { applicationBrowser } from './profile-browser.mjs';

const docker = (...args) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 240000,
    maxBuffer: 8 * 1024 * 1024,
  }).trim();

test(
  'rendered all-Docker Phase 2 installs, enrolls, checks dependencies, and restores sessions after restart',
  { timeout: 360000 },
  async () => {
    const startedAt = Date.now();
    const root = await mkdtemp(join(tmpdir(), 'cc-phase2-compose-'));
    const project = `cc-phase2-${randomUUID().slice(0, 12)}`;
    const composePath = join(root, 'docker-compose.json');
    const compose = (...args) =>
      docker('compose', '-f', composePath, '-p', project, ...args);
    let provider;
    let rendered;
    let failed = false;
    try {
      const portServer = createServer().listen(0, '127.0.0.1');
      await once(portServer, 'listening');
      const port = portServer.address().port;
      await new Promise((done) => portServer.close(done));
      const publicOrigin = `https://127.0.0.1:${port}`;
      const privateRoot = join(root, 'private');
      await mkdir(privateRoot, { mode: 0o700 });
      const certPath = join(privateRoot, 'edge-certificate');
      const keyPath = join(privateRoot, 'edge-private-key');
      execFileSync(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-keyout',
          keyPath,
          '-out',
          certPath,
          '-days',
          '1',
          '-subj',
          '/CN=localhost',
          '-addext',
          'subjectAltName=DNS:localhost,DNS:host.docker.internal,IP:127.0.0.1',
        ],
        { stdio: 'ignore' },
      );
      const password = randomUUID();
      await writeFile(join(privateRoot, 'oidc-client'), password, {
        mode: 0o600,
      });
      provider = await startProvider({
        certificate: await readFile(certPath),
        privateKey: await readFile(keyPath),
        publicOrigin,
        password,
      });
      const config = JSON.parse(
        await readFile('deployment/examples/all-docker.json', 'utf8'),
      );
      config.phase = 2;
      config.services.edge.access = 'application';
      config.services.edge.endpoint.url = publicOrigin;
      config.applicationAuth = {
        issuer: provider.issuer,
        clientId: 'qualification',
        publicOrigin,
        clientSecretRef: { provider: 'file', path: '/run/secrets/oidc-client' },
      };
      const images = Object.fromEntries(
        ['frontend', 'api', 'worker'].map((service) => {
          const reference =
            process.env[`CC_AUTH_${service.toUpperCase()}_IMAGE`] ??
            `campus-commander/${service}:cc-6`;
          const image = JSON.parse(docker('image', 'inspect', reference))[0];
          assert.ok(image.RepoDigests.length >= 1);
          return [
            service === 'worker' ? 'workers' : service,
            reference.includes('@sha256:') ? reference : image.RepoDigests[0],
          ];
        }),
      );
      config.images = images;
      const release = {
        schemaVersion: 1,
        images,
        architectures: ['linux/amd64'],
      };
      const configPath = join(root, 'deployment.json');
      await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
      await prepareAllDocker(configPath, root);
      rendered = renderAllDocker(config, release);
      rendered.services.edge.ports = [`127.0.0.1:${port}:8443`];
      // Only the synthetic provider requires this additional CA and host mapping.
      rendered.services.api.environment.NODE_EXTRA_CA_CERTS =
        '/run/qualification/ca.pem';
      rendered.services.api.extra_hosts = ['host.docker.internal:host-gateway'];
      rendered.services.api.volumes.push({
        type: 'bind',
        source: certPath,
        target: '/run/qualification/ca.pem',
        read_only: true,
      });
      await writeFile(composePath, JSON.stringify(rendered), { mode: 0o600 });
      process.stdout.write('Starting the rendered all-Docker deployment.\n');
      compose('up', '-d', '--wait', '--wait-timeout', '180');
      const bootstrapFile = join(privateRoot, 'bootstrap');
      const readiness = await httpsStartup({
        url: publicOrigin,
        caFile: certPath,
        bootstrapFile,
      });
      assert.equal(readiness.status, 'ready');
      assert.equal(readiness.checks.length, 8);
      const requestPath = join(root, 'access.json');
      await writeFile(
        requestPath,
        JSON.stringify({
          action: 'initialize',
          issuer: provider.issuer,
          subject: 'administrator',
          displayName: 'Synthetic administrator',
        }),
        { mode: 0o600 },
      );
      const enrolled = JSON.parse(
        compose(
          'run',
          '--rm',
          '--no-deps',
          '-v',
          `${requestPath}:/run/access.json:ro`,
          'database-migrate',
          'node',
          '/app/deployment/bootstrap/application-access-cli.mjs',
          '/run/config/profile.json',
          '/run/config/operator.json',
          '/run/access.json',
        ),
      );
      assert.ok(enrolled.principalId);
      const addresses = () =>
        Object.fromEntries(
          ['api', 'frontend', 'workers'].map((service) => [
            service,
            JSON.parse(docker('inspect', `${project}-${service}-1`))[0]
              .NetworkSettings.Networks[`${project}_internal`].IPAddress,
          ]),
        );
      const initialAddresses = addresses();
      const browser = await applicationBrowser(
        publicOrigin,
        async ({ page, checks }) => {
          await page.getByRole('button', { name: 'Choose theme' }).click();
          await page.getByRole('menuitem', { name: 'Use dark theme' }).click();
          await expect(page.locator('html')).toHaveAttribute(
            'data-theme',
            'dark',
          );
          compose('restart', 'api', 'frontend', 'workers');
          compose('up', '-d', '--wait', '--wait-timeout', '120');
          const restartedAddresses = addresses();
          await page.reload();
          await expect(
            page.getByRole('heading', { name: 'Diagnostics', exact: true }),
          ).toBeVisible();
          await expect(page.locator('html')).toHaveAttribute(
            'data-theme',
            'dark',
          );
          await checks({ recoverySeconds: 60 });
          return {
            restartRecoveryBoundSeconds: 60,
            networkAddresses: {
              before: initialAddresses,
              after: restartedAddresses,
            },
          };
        },
      );
      await mkdir('dist/phase-2-evidence', { recursive: true });
      if (browser.screenReader) {
        await writeFile(
          'dist/phase-2-evidence/screen-reader.json',
          JSON.stringify(
            {
              ...browser.screenReader,
              images,
              application: {
                status: browser.status,
                operations: browser.operations,
                observations: browser.observations,
              },
            },
            null,
            2,
          ),
        );
      }
      await writeFile(
        'dist/phase-2-evidence/all-docker-profile.json',
        JSON.stringify(
          {
            status: 'passed',
            profile: 'all-docker',
            recordedAt: new Date().toISOString(),
            durationMs: Date.now() - startedAt,
            images,
            browser,
            readinessChecks: readiness.checks.map(({ name }) => name),
            sessionSurvivedRestart: true,
            limits: [
              'Synthetic provider CA and loopback port replace district ingress.',
              'Upgrade and isolated restore require separate evidence.',
            ],
          },
          null,
          2,
        ),
      );
    } catch (error) {
      failed = true;
      process.stderr.write(`Qualification fixture: ${project} at ${root}\n`);
      if (rendered) {
        try {
          process.stderr.write(compose('ps', '-a'));
        } catch {
          /* Preserve the original failure. */
        }
      }
      throw error;
    } finally {
      if (
        rendered &&
        !(failed && process.env.CC_PHASE2_KEEP_FIXTURE === 'true')
      )
        compose('down', '--volumes', '--remove-orphans');
      await provider?.close();
      if (!(failed && process.env.CC_PHASE2_KEEP_FIXTURE === 'true'))
        await rm(root, { recursive: true, force: true });
    }
  },
);

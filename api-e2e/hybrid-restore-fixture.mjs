import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect } from '@playwright/test';
import { qualifyHybridRestore } from '../deployment/profiles/hybrid/restore-integration.mjs';
import { prepareHybrid } from '../deployment/profiles/hybrid/prepare.mjs';
import { renderFiles } from '../deployment/profiles/hybrid/render.mjs';
import { applicationBrowser } from './profile-browser.mjs';

const execute = promisify(execFile);
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
async function docker(...args) {
  return (
    await execute('docker', args, {
      timeout: 240000,
      maxBuffer: 8 * 1024 * 1024,
    })
  ).stdout.trim();
}

/** Restore hybrid application state and verify the running browser workflow. */
export async function qualifyHybridApplicationRestore({
  root: sourceRoot,
  controllerFile: sourceControllerFile,
  workerFiles: sourceWorkerFiles,
  projects: sourceProjects,
  databaseContainer,
  redisContainer,
  executionId,
  page,
  context,
  caFile,
}) {
  const startedAt = Date.now();
  const sourceConfig = await json(join(sourceRoot, 'runtime', 'profile.json'));
  const publicOrigin = sourceConfig.applicationAuth.publicOrigin;
  const cookies = await context.cookies();
  assert.ok(cookies.some((cookie) => cookie.name.startsWith('__Host-')));
  let restoreRoot;
  let restorePassed = false;
  try {
    const result = await qualifyHybridRestore({
      sourceRoot,
      executionId,
      async onRestored({ root, targetConfig, targetNetwork, images }) {
        restoreRoot = root;
        const runtimeRoot = join(root, 'application');
        const project = `${targetNetwork}-controller`;
        const controllerFile = join(
          runtimeRoot,
          'docker-compose.controller.yml',
        );
        const workerFiles = [1, 2].map((index) =>
          join(runtimeRoot, `docker-compose.worker-${index}.yml`),
        );
        const compose = (...args) =>
          docker('compose', '-f', controllerFile, '-p', project, ...args);
        const workerCompose = (index, ...args) =>
          docker(
            'compose',
            '-f',
            workerFiles[index],
            '-p',
            `${targetNetwork}-worker-${index + 1}`,
            ...args,
          );
        let rendered = false;
        try {
          await mkdir(runtimeRoot, { mode: 0o700 });
          await cp(join(sourceRoot, 'private'), join(runtimeRoot, 'private'), {
            recursive: true,
          });
          for (const name of ['restore-app', 'restore-kestra']) {
            await cp(
              join(root, 'private', name),
              join(runtimeRoot, 'private', name),
            );
          }
          await cp(
            join(root, 'private', 'restore-migrator'),
            join(runtimeRoot, 'private', 'postgres-migrator'),
          );
          const configPath = join(runtimeRoot, 'hybrid.json'),
            releasePath = join(runtimeRoot, 'release.json');
          await writeFile(configPath, JSON.stringify(targetConfig), {
            mode: 0o600,
          });
          await writeFile(
            releasePath,
            JSON.stringify({
              schemaVersion: 1,
              architectures: ['linux/amd64'],
              images: targetConfig.images,
            }),
            { mode: 0o600 },
          );
          await prepareHybrid(configPath, runtimeRoot);
          await writeFile(
            join(runtimeRoot, 'runtime', 'operator.json'),
            JSON.stringify({
              migrationRole: 'restore-migrator',
              migrationPasswordSecretRef: {
                provider: 'file',
                path: '/run/secrets/postgres-migrator',
              },
            }),
            { mode: 0o600 },
          );
          await renderFiles(configPath, releasePath, controllerFile, {
            workerBindAddresses: ['10.20.30.41', '10.20.30.42'],
          });
          rendered = true;
          const controller = await json(controllerFile);
          assert.equal(controller.services['application-postgres'], undefined);
          assert.equal(controller.services.redis, undefined);
          controller.networks.egress = { external: true, name: targetNetwork };
          controller.services.edge.ports = [
            `127.0.0.1:${new URL(publicOrigin).port}:8443`,
          ];
          controller.services.api.environment.NODE_EXTRA_CA_CERTS =
            '/run/qualification/provider-ca';
          controller.services.api.extra_hosts = [
            'host.docker.internal:host-gateway',
          ];
          controller.services.api.volumes.push({
            type: 'bind',
            source: caFile,
            target: '/run/qualification/provider-ca',
            read_only: true,
          });
          await writeFile(controllerFile, JSON.stringify(controller));
          for (const file of workerFiles) {
            const worker = await json(file);
            worker.networks.egress = { external: true, name: targetNetwork };
            delete worker.services.workers.ports;
            await writeFile(file, JSON.stringify(worker));
          }
          for (let index = 0; index < workerFiles.length; index++)
            await workerCompose(
              index,
              'up',
              '-d',
              '--wait',
              '--wait-timeout',
              '120',
            );
          await compose('up', '-d', '--wait', '--wait-timeout', '180');
          const rejectedContext = await context
            .browser()
            .newContext({ ignoreHTTPSErrors: true });
          try {
            await rejectedContext.addCookies(cookies);
            const rejectedPage = await rejectedContext.newPage();
            await rejectedPage.goto(publicOrigin);
            assert.equal(
              await rejectedPage.evaluate(
                async () => (await fetch('/api/auth/session')).status,
              ),
              401,
            );
          } finally {
            await rejectedContext.close();
          }
          const application = await applicationBrowser(
            publicOrigin,
            async ({ page: restoredPage }) => {
              await expect(restoredPage.locator('html')).toHaveAttribute(
                'data-theme',
                'dark',
              );
            },
          );
          return {
            ...application,
            oldSessionRejected: true,
            preservedTheme: 'dark',
            externalDatabase: true,
            externalRedis: true,
            workerReplicas: 2,
            images,
          };
        } finally {
          if (rendered) {
            for (let index = 0; index < workerFiles.length; index++)
              await workerCompose(
                index,
                'down',
                '--volumes',
                '--remove-orphans',
              );
            await compose('down', '--volumes', '--remove-orphans');
          }
        }
      },
    });
    assert.equal(result.application.status, 'passed');
    assert.equal(
      result.verification.application.exactIdentityAndPreferences,
      true,
    );
    assert.equal(result.verification.application.exactSecurityEvents, true);
    restorePassed = true;
    return {
      ...result,
      durationMs: Date.now() - startedAt,
      recordedAt: new Date().toISOString(),
      limits: [
        ...result.limits,
        'Source and target use the same loopback application origin sequentially.',
        'The target uses new database roles and passwords. Synthetic OIDC and service credentials remain unchanged.',
      ],
    };
  } finally {
    await docker('start', databaseContainer, redisContainer);
    for (let index = 0; index < sourceWorkerFiles.length; index++) {
      await docker(
        'compose',
        '-f',
        sourceWorkerFiles[index],
        '-p',
        sourceProjects.workers[index],
        'up',
        '-d',
        '--wait',
        '--wait-timeout',
        '120',
      );
    }
    await docker(
      'compose',
      '-f',
      sourceControllerFile,
      '-p',
      sourceProjects.controller,
      'up',
      '-d',
      '--wait',
      '--wait-timeout',
      '180',
    );
    if (restorePassed) {
      await page.goto(publicOrigin);
      const login = page.getByRole('link', {
        name: 'Sign in to Campus Commander',
      });
      const account = page.getByRole('heading', {
        name: 'Your account',
        exact: true,
      });
      await expect(login.or(account)).toBeVisible({ timeout: 15000 });
      if (await login.isVisible()) await login.click();
      await expect(account).toBeVisible({ timeout: 15000 });
    }
    if (restoreRoot) await rm(restoreRoot, { recursive: true, force: true });
  }
}

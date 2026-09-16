import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from '@playwright/test';
import { prepareAllDocker } from '../deployment/profiles/all-docker/prepare.mjs';
import { renderAllDocker } from '../deployment/profiles/all-docker/render.mjs';
import { verifyBackup } from '../deployment/operations/index.mjs';
import { createOperationsCliFixture } from '../deployment/operations/cli-fixture.mjs';
import { applicationBrowser } from './profile-browser.mjs';

const docker = (args, input) =>
  execFileSync('docker', args, {
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 240000,
    maxBuffer: 8 * 1024 * 1024,
  }).trim();

/** Restore the complete application into separate databases, networks, and volumes. */
export async function qualifyApplicationRestore({
  root,
  config,
  release,
  compose,
  resolveSecret,
  keyRecovery,
  caFile,
  page,
  context,
}) {
  const startedAt = Date.now();
  const project = `cc-phase2-restore-${randomUUID().slice(0, 12)}`;
  const targetRoot = join(root, 'isolated-application');
  const targetFile = join(targetRoot, 'docker-compose.json');
  const targetCompose = (...args) =>
    docker(['compose', '-f', targetFile, '-p', project, ...args]);
  const proxies = [];
  let sourceStopped = false;
  let targetPrepared = false;
  const probe = `
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import pg from 'pg';
import {connectionOptions} from '/app/deployment/postgres/index.mjs';
import {createArtifactStore} from '/app/deployment/storage/index.mjs';
import {secretPath} from '/app/deployment/redis/runtime.mjs';
const c=JSON.parse(await fs.readFile(process.env.CC_CONFIG_FILE));
const pool=new pg.Pool(await connectionOptions(c.services.applicationDatabase,r=>fs.readFile(secretPath(r))));
const principals=(await pool.query('SELECT * FROM cc.application_principals ORDER BY id')).rows;
const events=(await pool.query('SELECT * FROM cc.security_events ORDER BY id')).rows;
const a=JSON.parse(await fs.readFile(c.artifacts.location+'/.cc16-fixture.json'));
const store=await createArtifactStore({pool,root:c.artifacts.location});
const hash=crypto.createHash('sha256');
for await(const bytes of await store.openRead(a.artifactId))hash.update(bytes);
await store.close();await pool.end();
process.stdout.write(JSON.stringify({principals,events,artifactId:a.artifactId,sha256:hash.digest('hex')}));`;
  const inspectApplication = (run) =>
    JSON.parse(
      docker(
        ['exec', '-i', run('ps', '-q', 'api'), 'node', '--input-type=module'],
        probe,
      ),
    );
  const connectDatabases = async (run, input, label) => {
    const result = structuredClone(input);
    for (const [key, service] of [
      ['applicationDatabase', 'application-postgres'],
      ['kestraDatabase', 'kestra-postgres'],
    ]) {
      const container = run('ps', '-q', service);
      const inspect = JSON.parse(docker(['inspect', container]))[0];
      const [network, connection] = Object.entries(
        inspect.NetworkSettings.Networks,
      )[0];
      const name = `${project}-${label}-${service}`;
      docker([
        'run',
        '-d',
        '--name',
        name,
        '--network',
        network,
        '--no-healthcheck',
        '-p',
        '127.0.0.1::5432',
        '--entrypoint',
        'node',
        release.images.api,
        '-e',
        `const n=require('node:net');n.createServer(s=>{const t=n.connect(5432,${JSON.stringify(connection.IPAddress)});s.pipe(t).pipe(s);s.on('error',()=>t.destroy());t.on('error',()=>s.destroy());}).listen(5432,'0.0.0.0')`,
      ]);
      proxies.push(name);
      docker(['network', 'connect', 'bridge', name]);
      const port = docker(['port', name, '5432/tcp']).split(':').at(-1);
      const endpoint = `postgresql://127.0.0.1:${port}`;
      result.services[key].endpoint.url = endpoint;
    }
    return result;
  };
  const applicationCredentials = {
    role: 'application-installer',
    passwordSecretRef: {
      provider: 'file',
      path: '/run/secrets/postgres-migrator',
    },
  };
  try {
    const preference = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/auth/preferences' &&
        response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Choose theme' }).click();
    await page.getByRole('menuitem', { name: 'Use dark theme' }).click();
    assert.equal((await preference).status(), 201);
    const before = inspectApplication(compose);
    assert.equal(before.principals.length, 1);
    assert.equal(before.principals[0].preferences.theme, 'dark');
    assert.ok(before.events.length > 0);
    const sourceCookies = await context.cookies();
    assert.ok(
      sourceCookies.some((cookie) => cookie.name.startsWith('__Host-')),
    );
    compose('stop', 'edge', 'api', 'workers', 'kestra');
    sourceStopped = true;
    const sourceRoots = {
      artifacts: join(root, 'phase2-snapshot-artifacts'),
      kestraInternal: join(root, 'phase2-snapshot-kestra'),
    };
    for (const directory of Object.values(sourceRoots))
      await mkdir(directory, { mode: 0o700 });
    docker([
      'cp',
      `${compose('ps', '-a', '-q', 'api')}:${config.artifacts.location}/.`,
      sourceRoots.artifacts,
    ]);
    docker([
      'cp',
      `${compose('ps', '-a', '-q', 'kestra')}:/app/storage/.`,
      sourceRoots.kestraInternal,
    ]);
    const sourceConfig = await connectDatabases(compose, config, 'source');
    sourceConfig.artifacts.location = sourceRoots.artifacts;
    sourceConfig.services.kestra.internalStorage.location =
      sourceRoots.kestraInternal;
    const backupDirectory = join(root, 'phase2-application-backup');
    const operatorCli = await createOperationsCliFixture(
      join(root, 'application-operator-cli'),
      resolveSecret,
      {
        container: process.env.CC_OPERATIONS_CLI_HOST !== '1',
        mountDirectories: [root],
      },
    );
    const { result: backupResult } = await operatorCli.run('backup', {
      config: sourceConfig,
      release,
      backupDirectory,
      sourceRoots,
      keyRecovery,
      quiesce: {
        operator: 'phase2-restore-fixture',
        stoppedAt: new Date().toISOString(),
        stoppedServices: ['api', 'workers', 'kestra'],
      },
      applicationCredentials,
    });
    assert.equal(backupResult.status, 'complete');
    const { result: verifiedBackup } = await operatorCli.run('verify', {
      backupDirectory,
      keyRecovery,
    });
    assert.equal(verifiedBackup.status, 'verified');
    const backup = await verifyBackup({
      backupDirectory,
      keyRecovery,
      resolveSecret,
    });
    assert.ok(
      backup.files.every((file) => file.encryptedPath.endsWith('.enc')),
    );
    await mkdir(targetRoot, { mode: 0o700 });
    await cp(join(root, 'private'), join(targetRoot, 'private'), {
      recursive: true,
    });
    const targetConfig = structuredClone(config);
    const targetConfigPath = join(targetRoot, 'deployment.json');
    await writeFile(targetConfigPath, JSON.stringify(targetConfig), {
      mode: 0o600,
    });
    await prepareAllDocker(targetConfigPath, targetRoot);
    const rendered = renderAllDocker(targetConfig, release);
    rendered.services.edge.ports = [
      `127.0.0.1:${new URL(config.applicationAuth.publicOrigin).port}:8443`,
    ];
    rendered.services.api.environment.NODE_EXTRA_CA_CERTS =
      '/run/qualification/provider-ca';
    rendered.services.api.extra_hosts = ['host.docker.internal:host-gateway'];
    rendered.services.api.volumes.push({
      type: 'bind',
      source: caFile,
      target: '/run/qualification/provider-ca',
      read_only: true,
    });
    await writeFile(targetFile, JSON.stringify(rendered), { mode: 0o600 });
    targetPrepared = true;
    targetCompose(
      'up',
      '-d',
      '--wait',
      '--wait-timeout',
      '120',
      'application-postgres',
      'kestra-postgres',
    );
    targetCompose('run', '--rm', 'database-provision');
    const restoreConfig = await connectDatabases(
      targetCompose,
      targetConfig,
      'target',
    );
    const targetDirectory = join(targetRoot, 'restored');
    restoreConfig.artifacts.location = join(targetDirectory, 'artifacts');
    restoreConfig.services.kestra.internalStorage.location = join(
      targetDirectory,
      'kestra-internal',
    );
    const { result: restoreResult } = await operatorCli.run('restore', {
      backupDirectory,
      targetConfig: restoreConfig,
      targetDirectory,
      keyRecovery,
      applicationCredentials,
    });
    assert.equal(restoreResult.status, 'verified-services-disabled');
    const restoration = JSON.parse(
      await readFile(join(targetDirectory, 'restore-report.json'), 'utf8'),
    );
    assert.equal(restoration.status, 'verified-services-disabled');
    assert.equal(restoration.redisRecovery.releaseRequiresFreshRedis, true);
    for (const [volume, directory] of [
      ['artifacts', 'artifacts'],
      ['kestra-storage', 'kestra-internal'],
    ]) {
      docker([
        'run',
        '--rm',
        '--network',
        'none',
        '--user',
        '0:0',
        '--entrypoint',
        '/bin/sh',
        '-v',
        `${project}_${volume}:/target`,
        '-v',
        `${join(targetDirectory, directory)}:/source:ro`,
        release.images.api,
        '-c',
        'cp -a /source/. /target/ && chown -R 1000:1000 /target',
      ]);
    }
    targetCompose('up', '-d', '--wait', '--wait-timeout', '180');
    const after = inspectApplication(targetCompose);
    assert.deepEqual(after, before);
    const rejectedContext = await context
      .browser()
      .newContext({ ignoreHTTPSErrors: true });
    try {
      await rejectedContext.addCookies(sourceCookies);
      const rejectedPage = await rejectedContext.newPage();
      await rejectedPage.goto(config.applicationAuth.publicOrigin);
      const status = await rejectedPage.evaluate(
        async () => (await fetch('/api/auth/session')).status,
      );
      assert.equal(status, 401);
    } finally {
      await rejectedContext.close();
    }
    const application = await applicationBrowser(
      config.applicationAuth.publicOrigin,
      async ({ page: restoredPage }) => {
        await expect(restoredPage.locator('html')).toHaveAttribute(
          'data-theme',
          'dark',
        );
      },
    );
    return {
      status: 'passed',
      profile: 'all-docker',
      images: release.images,
      recordedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      sourceRevision: release.sourceRevision,
      application,
      restoration,
      operatorCli: { ...operatorCli.execution, commands: operatorCli.commands },
      preserved: {
        principals: before.principals.length,
        securityEvents: before.events.length,
        identityStateSha256: createHash('sha256')
          .update(JSON.stringify(before))
          .digest('hex'),
        artifactId: before.artifactId,
        artifactSha256: before.sha256,
        preference: 'dark',
      },
      oldSessionRejected: true,
      limits: [
        'Separate Compose networks, databases, and volumes share one Docker host.',
        'The stopped source and restored target reuse one loopback HTTPS origin.',
        'Synthetic credentials remain unchanged for this restore and require district review before deployment.',
        'The fixture adds a synthetic provider CA and host mapping.',
      ],
    };
  } finally {
    if (targetPrepared) targetCompose('down', '--volumes', '--remove-orphans');
    for (const name of proxies) docker(['rm', '-f', name]);
    if (sourceStopped) {
      compose('up', '-d', '--wait', '--wait-timeout', '180');
      await page.reload();
      await expect(
        page.getByRole('heading', { name: 'Diagnostics', exact: true }),
      ).toBeVisible();
    }
    await rm(targetRoot, { recursive: true, force: true });
  }
}

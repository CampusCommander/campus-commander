import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { expect } from '@playwright/test';
import { loadQualificationBundle } from '../deployment/release/qualification.mjs';
import { createOperationsCliFixture } from '../deployment/operations/cli-fixture.mjs';
import { applicationBrowser } from './profile-browser.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const docker = (...args) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 240000,
    maxBuffer: 8 * 1024 * 1024,
  }).trim();

/** Require the exact verified Phase 2 artifact selected by the acceptance record. */
export async function loadPhase2UpgradeBaseline(root) {
  assert.ok(root, 'Provide the verified Phase 2 installer directory.');
  const pinned = JSON.parse(
    await readFile('deployment/qualification/phase-2-upgrade-baseline.json'),
  );
  const bundle = await loadQualificationBundle(root, {
    phase: 2,
    sourceRevision: pinned.sourceRevision,
    images: pinned.images,
  });
  assert.equal(bundle.manifestSha256, pinned.sourceManifestSha256);
  return { ...bundle, pinned, root };
}

/** Upgrade an installed Phase 2 application through the delivered Phase 3 CLI. */
export async function qualifyPhase2Upgrade({
  root,
  config,
  release,
  baseline,
  compose,
  cli,
  activateTarget,
  operatorPath,
  configPath,
  releasePath,
  installerRoot,
  publicOrigin,
}) {
  const startedAt = Date.now();
  const privateRoot = join(root, 'private');
  const beforeConfig = {
    ...config,
    phase: 2,
    images: baseline.manifest.images,
  };
  delete beforeConfig.googleConnection;
  const statePath = join(root, 'installer-state.json');
  const beforeState = JSON.parse(await readFile(statePath));
  assert.equal(beforeState.phase, 'ready');
  assert.equal(beforeState.releaseHash, hash(await readFile(releasePath)));
  const secrets = new Map(
    await Promise.all(
      (await readdir(privateRoot)).map(async (name) => [
        name,
        await readFile(join(privateRoot, name)),
      ]),
    ),
  );
  const baselineBrowser = await applicationBrowser(
    publicOrigin,
    async ({ page }) => {
      const saved = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/auth/preferences' &&
          response.request().method() === 'POST',
      );
      await page.getByRole('button', { name: 'Choose theme' }).click();
      await page.getByRole('menuitem', { name: 'Use dark theme' }).click();
      assert.equal((await saved).status(), 201);
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    },
  );
  const databaseCode = `
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import pg from 'pg';
import {connectionOptions} from '/app/deployment/postgres/index.mjs';
import {createArtifactStore} from '/app/deployment/storage/index.mjs';
import {secretPath} from '/app/deployment/redis/runtime.mjs';
const c=JSON.parse(await fs.readFile('/run/config/profile.json'));
const service={...c.services.applicationDatabase,role:'application-installer',passwordSecretRef:{provider:'file',path:'/run/secrets/postgres-migrator'}};
const pool=new pg.Pool(await connectionOptions(service,r=>fs.readFile(secretPath(r))));
`;
  compose(
    'run',
    '--rm',
    '--no-deps',
    '-T',
    'database-migrate',
    'node',
    '--input-type=module',
    '-e',
    databaseCode +
      `
await pool.query("INSERT INTO cc.application_principals(id,issuer,subject,display_name,preferences) VALUES($1,$2,$3,$4,$5)",[crypto.randomUUID(),c.applicationAuth.issuer,'phase2-preserved-reader','Phase 2 preserved reader',{theme:'light',navigationCollapsed:true}]);
await pool.end();`,
  );
  const runtimeCode = databaseCode.replace(
    "const service={...c.services.applicationDatabase,role:'application-installer',passwordSecretRef:{provider:'file',path:'/run/secrets/postgres-migrator'}};",
    'const service=c.services.applicationDatabase;',
  );
  const api = () => compose('ps', '-q', 'api').split('\n')[0];
  docker(
    'exec',
    api(),
    'node',
    '--input-type=module',
    '-e',
    runtimeCode +
      `
const store=await createArtifactStore({pool,root:c.artifacts.location});
const bytes=Buffer.from('Phase 2 upgrade preservation École 学校');
const artifact=await store.stage({schemaVersion:1,expectedSizeBytes:bytes.length,expectedSha256:crypto.createHash('sha256').update(bytes).digest('hex')},[bytes]);
await store.publish(artifact);
await fs.writeFile(c.artifacts.location+'/.phase3-upgrade-artifact.json',JSON.stringify(artifact));
await store.close();await pool.end();`,
  );
  const probe =
    runtimeCode +
    `
const principals=(await pool.query('SELECT id,issuer,subject,display_name,enabled,permission_version,permissions,preferences FROM cc.application_principals ORDER BY id')).rows;
const ledger=(await pool.query('SELECT id,checksum FROM cc.schema_migrations ORDER BY id')).rows;
const artifact=JSON.parse(await fs.readFile(c.artifacts.location+'/.phase3-upgrade-artifact.json'));
const store=await createArtifactStore({pool,root:c.artifacts.location});
const digest=crypto.createHash('sha256');for await(const bytes of await store.openRead(artifact.artifactId))digest.update(bytes);
await store.close();await pool.end();
console.log(JSON.stringify({principals,ledger,artifactId:artifact.artifactId,artifactSha256:digest.digest('hex')}));`;
  const inspect = () =>
    JSON.parse(
      docker('exec', api(), 'node', '--input-type=module', '-e', probe),
    );
  const before = inspect();
  assert.equal(before.principals.length, 2);
  assert.equal(
    before.principals.find((p) => p.subject === 'administrator').preferences
      .theme,
    'dark',
  );
  const proxies = [];
  try {
    compose('stop', 'edge', 'api', 'workers', 'kestra');
    const sourceRoots = {
      artifacts: join(root, 'upgrade-artifacts'),
      kestraInternal: join(root, 'upgrade-kestra'),
    };
    for (const path of Object.values(sourceRoots))
      await mkdir(path, { mode: 0o700 });
    docker(
      'cp',
      `${compose('ps', '-a', '-q', 'api').split('\n')[0]}:${config.artifacts.location}/.`,
      sourceRoots.artifacts,
    );
    docker(
      'cp',
      `${compose('ps', '-a', '-q', 'kestra')}:/app/storage/.`,
      sourceRoots.kestraInternal,
    );
    const backupConfig = structuredClone(beforeConfig);
    for (const [key, service] of [
      ['applicationDatabase', 'application-postgres'],
      ['kestraDatabase', 'kestra-postgres'],
    ]) {
      const inspected = JSON.parse(
        docker('inspect', compose('ps', '-q', service)),
      )[0];
      const [network, connection] = Object.entries(
        inspected.NetworkSettings.Networks,
      )[0];
      const name = `cc-upgrade-proxy-${randomUUID()}`;
      docker(
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
        baseline.manifest.images.api,
        '-e',
        `const n=require('node:net');n.createServer(s=>{const t=n.connect(5432,${JSON.stringify(connection.IPAddress)});s.pipe(t).pipe(s);s.on('error',()=>t.destroy());t.on('error',()=>s.destroy());}).listen(5432,'0.0.0.0')`,
      );
      proxies.push(name);
      docker('network', 'connect', 'bridge', name);
      backupConfig.services[key].endpoint.url =
        `postgresql://127.0.0.1:${docker('port', name, '5432/tcp').split(':').at(-1)}`;
    }
    backupConfig.artifacts.location = sourceRoots.artifacts;
    backupConfig.services.kestra.internalStorage.location =
      sourceRoots.kestraInternal;
    const keyRecovery = {
      id: 'phase2-upgrade-backup',
      version: 1,
      reference: { provider: 'file', path: '/run/secrets/upgrade-backup-key' },
    };
    await writeFile(join(privateRoot, 'upgrade-backup-key'), randomBytes(32), {
      mode: 0o600,
    });
    const backupDirectory = join(root, 'phase2-upgrade-backup');
    const operatorCli = await createOperationsCliFixture(
      join(root, 'upgrade-operator-cli'),
      (ref) => readFile(join(privateRoot, basename(ref.path))),
      { container: true, mountDirectories: [root] },
    );
    assert.equal(
      (
        await operatorCli.run('backup', {
          config: backupConfig,
          release: baseline.manifest,
          backupDirectory,
          sourceRoots,
          keyRecovery,
          quiesce: {
            operator: 'phase3-upgrade-fixture',
            stoppedAt: new Date().toISOString(),
            stoppedServices: ['api', 'workers', 'kestra'],
          },
          applicationCredentials: {
            role: 'application-installer',
            passwordSecretRef: {
              provider: 'file',
              path: '/run/secrets/postgres-migrator',
            },
          },
        })
      ).result.status,
      'complete',
    );
    assert.equal(
      (await operatorCli.run('verify', { backupDirectory, keyRecovery })).result
        .status,
      'verified',
    );
    const operator = JSON.parse(await readFile(operatorPath));
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    await writeFile(releasePath, JSON.stringify(release), { mode: 0o600 });
    await writeFile(
      operatorPath,
      JSON.stringify({
        ...operator,
        releaseRoot: installerRoot,
        upgradeFromReleaseHash: beforeState.releaseHash,
        backupManifestSha256: hash(
          await readFile(join(backupDirectory, 'manifest.json')),
        ),
        upgradeBackup: { backupDirectory, keyRecovery },
      }),
      { mode: 0o600 },
    );
    activateTarget();
    assert.equal((await cli('upgrade')).status, 'ready');
    assert.equal((await cli('resume')).status, 'ready');
    const after = inspect();
    assert.deepEqual(after.principals, before.principals);
    assert.equal(after.artifactId, before.artifactId);
    assert.equal(after.artifactSha256, before.artifactSha256);
    for (const migration of before.ledger)
      assert.deepEqual(
        after.ledger.find((row) => row.id === migration.id),
        migration,
      );
    assert.ok(after.ledger.length > before.ledger.length);
    for (const [name, bytes] of secrets)
      assert.ok(
        bytes.equals(await readFile(join(privateRoot, name))),
        'The upgrade must preserve each existing secret.',
      );
    const afterState = JSON.parse(await readFile(statePath));
    assert.equal(afterState.phase, 'ready');
    assert.equal(afterState.releaseHash, hash(await readFile(releasePath)));
    assert.notEqual(afterState.releaseHash, beforeState.releaseHash);
    assert.notEqual(
      afterState.configurationHash,
      beforeState.configurationHash,
    );
    return {
      status: 'passed',
      durationMs: Date.now() - startedAt,
      durationScope:
        'Phase 2 browser checks, seeded state, verified cold backup, upgrade, resume, and preservation checks.',
      baseline: {
        sourceRevision: baseline.manifest.sourceRevision,
        images: baseline.manifest.images,
        bundleManifestSha256: baseline.manifestSha256,
        sourceTag: baseline.pinned.sourceTag,
        acceptanceScope: baseline.pinned.acceptanceScope,
      },
      baselineBrowser,
      operations: {
        commands: operatorCli.commands,
        execution: operatorCli.execution,
      },
      checks: {
        principalsPreserved: true,
        preferencesPreserved: true,
        artifactPreserved: true,
        migrationChecksumsPreserved: true,
        newMigrationsApplied: true,
        installerStateAdvanced: true,
        existingSecretsPreserved: true,
        backupVerified: true,
        repeatedResume: true,
      },
      principalCount: before.principals.length,
      migrationCount: {
        before: before.ledger.length,
        after: after.ledger.length,
      },
      artifact: { id: after.artifactId, sha256: after.artifactSha256 },
      installerState: {
        before: {
          phase: beforeState.phase,
          releaseHash: beforeState.releaseHash,
          configurationHash: beforeState.configurationHash,
        },
        after: {
          phase: afterState.phase,
          releaseHash: afterState.releaseHash,
          configurationHash: afterState.configurationHash,
        },
      },
      limits: [
        'The accepted Phase 2 implementation revision is pinned. The owner did not identify the exact previously installed revision.',
        'Synthetic identity and Google providers do not establish district acceptance.',
      ],
    };
  } finally {
    for (const name of proxies.reverse()) docker('rm', '-f', name);
  }
}

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from '@playwright/test';
import { createHybridOperationsCli } from './hybrid-operations-fixture.mjs';
import { applicationBrowser } from './profile-browser.mjs';
import { verifyHybridImages } from './hybrid-cli-upgrade-fixture.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (path, value) =>
  writeFile(path, JSON.stringify(value), { mode: 0o600 });

/** Reject incomplete preservation evidence before reporting an upgrade pass. */
export function assertHybridUpgradePreservation(before, after) {
  assert.equal(before.principals.length, 2);
  assert.equal(new Set(before.principals.map((p) => p.id)).size, 2);
  assert.equal(
    before.principals.find((p) => p.subject === 'administrator')?.preferences
      .theme,
    'light',
  );
  assert.equal(
    before.principals.find((p) => p.subject === 'phase2-preserved-reader')
      ?.preferences.navigationCollapsed,
    true,
  );
  assert.deepEqual(after.principals, before.principals);
  assert.match(before.artifactId, /^[a-f0-9-]{36}$/);
  assert.match(before.artifactSha256, /^[a-f0-9]{64}$/);
  assert.equal(after.artifactId, before.artifactId);
  assert.equal(after.artifactSha256, before.artifactSha256);
  assert.equal(before.artifactMetadata.length, 1);
  assert.deepEqual(after.artifactMetadata, before.artifactMetadata);
  assert.ok(before.events.length > 0);
  for (const event of before.events)
    assert.deepEqual(
      after.events.find((row) => row.value.id === event.value.id),
      { value: { ...event.value, target_id: null, resource_scope: null } },
    );
  assert.deepEqual(
    before.ledger.map((migration) => migration.id),
    ['001-foundation', '002-application-auth'],
  );
  for (const migration of before.ledger)
    assert.deepEqual(
      after.ledger.find((row) => row.id === migration.id),
      migration,
    );
  assert.ok(after.ledger.length > before.ledger.length);
}

/** Run the delivered operator CLI with native PostgreSQL tools on the controller. */
export async function backupHybridForUpgrade({
  hosts,
  controller,
  config,
  project,
}) {
  const root = controller.root;
  const keyRecovery = {
    id: `phase${config.phase}-hybrid-upgrade`,
    version: 1,
    reference: {
      provider: 'file',
      path: `/run/secrets/phase${config.phase}-upgrade-backup-key`,
    },
  };
  const backupDirectory = join(root, `phase${config.phase}-upgrade-backup`);
  const cli = await createHybridOperationsCli({ hosts, controller, project });
  assert.equal(
    (await cli.generateKey(`phase${config.phase}-upgrade-backup-key`)).result
      .status,
    'created',
  );
  const backup = await cli.run('backup', {
    config,
    release: JSON.parse(await readFile(join(root, 'release.json'))),
    backupDirectory,
    keyRecovery,
    sourceRoots: {
      artifacts: config.artifacts.location,
      kestraInternal: config.services.kestra.internalStorage.location,
    },
    quiesce: {
      operator: 'phase3-hybrid-upgrade-fixture',
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
  });
  assert.equal(backup.result.status, 'complete');
  assert.equal(
    (await cli.run('verify', { backupDirectory, keyRecovery })).result.status,
    'verified',
  );
  return {
    commands: cli.commands,
    execution: cli.execution,
    manifestSha256: hash(
      await readFile(join(backupDirectory, 'manifest.json')),
    ),
    upgradeBackup: { backupDirectory, keyRecovery },
  };
}

/** Upgrade the pinned Phase 2 hybrid installation through the delivered CLI. */
export async function qualifyHybridPhase2Upgrade({
  hosts,
  controller,
  workers,
  compose,
  cli,
  transfer,
  config,
  configPath,
  releasePath,
  operator,
  operatorPath,
  target,
  baseline,
  publicOrigin,
  activateTarget,
}) {
  const project = operator.project;
  assert.match(project, /^cc-phase3-hybrid-[a-f0-9]{12}$/);
  assert.equal(workers.length, 2);
  assert.equal(
    new Set([controller, ...workers].map((h) => h.daemonId)).size,
    3,
  );
  for (const host of [controller, ...workers])
    assert.ok(host.root.startsWith(`/tmp/${project}-`));
  assert.equal(config.phase, 2);
  assert.equal(operator.releaseRoot, '/baseline');
  assert.deepEqual(config.images, baseline.manifest.images);
  assert.equal(config.googleConnection, undefined);
  const started = Date.now();
  const root = controller.root;
  const statePath = join(root, 'installer-state.json');
  const beforeState = JSON.parse(await readFile(statePath));
  assert.equal(beforeState.phase, 'ready');
  assert.equal(beforeState.releaseHash, hash(await readFile(releasePath)));
  const beforeImages = await verifyHybridImages(
    { hosts, controller, workers, compose },
    baseline.manifest.images,
  );
  const secrets = new Map(
    await Promise.all(
      (await readdir(join(root, 'private'))).map(async (name) => [
        name,
        await readFile(join(root, 'private', name)),
      ]),
    ),
  );
  try {
    const baselineBrowser = await applicationBrowser(
      publicOrigin,
      async ({ page }) => {
        const saved = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === '/api/auth/preferences' &&
            response.request().method() === 'POST',
        );
        await page.getByRole('button', { name: 'Choose theme' }).click();
        await page.getByRole('menuitem', { name: 'Use light theme' }).click();
        assert.equal((await saved).status(), 201);
        await expect(page.locator('html')).toHaveAttribute(
          'data-theme',
          'light',
        );
      },
    );
    const common = `import fs from 'node:fs/promises';import crypto from 'node:crypto';import pg from 'pg';
import {connectionOptions} from '/app/deployment/postgres/index.mjs';
import {createArtifactStore} from '/app/deployment/storage/index.mjs';
const c=JSON.parse(await fs.readFile('/run/config/profile.json'));
const secret=r=>fs.readFile(r.path);
`;
    await hosts.run(
      controller,
      [
        'docker',
        'compose',
        '-f',
        join(root, 'docker-compose.json'),
        '-p',
        project,
        'run',
        '--rm',
        '--no-deps',
        '--interactive',
        '--no-tty',
        'database-migrate',
        'node',
        '--input-type=module',
      ],
      {
        input:
          common +
          `
const op=JSON.parse(await fs.readFile('/run/config/operator.json'));
const pool=new pg.Pool(await connectionOptions({...c.services.applicationDatabase,role:op.migrationRole,passwordSecretRef:op.migrationPasswordSecretRef},secret));
try{await pool.query("INSERT INTO cc.application_principals(id,issuer,subject,display_name,preferences) VALUES($1,$2,$3,$4,$5)",[crypto.randomUUID(),c.applicationAuth.issuer,'phase2-preserved-reader','Phase 2 preserved reader',{theme:'dark',navigationCollapsed:true}]);}finally{await pool.end();}
`,
      },
    );
    const probe = async (script) => {
      const id = (await compose(controller, ['ps', '--quiet', 'api'])).split(
        '\n',
      )[0];
      return JSON.parse(
        await hosts.run(
          controller,
          ['docker', 'exec', '-i', id, 'node', '--input-type=module'],
          {
            input:
              common +
              `const pool=new pg.Pool(await connectionOptions(c.services.applicationDatabase,secret));\n` +
              script,
          },
        ),
      );
    };
    const artifact = await probe(`
const store=await createArtifactStore({pool,root:c.artifacts.location});
try{const bytes=Buffer.from('Phase 2 hybrid upgrade École 学校');
const artifact=await store.stage({schemaVersion:1,expectedSizeBytes:bytes.length,expectedSha256:crypto.createHash('sha256').update(bytes).digest('hex')},[bytes]);
await store.publish(artifact);console.log(JSON.stringify(artifact));}finally{await store.close();await pool.end();}
`);
    const inspect = () =>
      probe(`
const store=await createArtifactStore({pool,root:c.artifacts.location});
try{const artifactId=${JSON.stringify(artifact.artifactId)};
const digest=crypto.createHash('sha256');for await(const bytes of await store.openRead(artifactId))digest.update(bytes);
const artifactMetadata=(await pool.query('SELECT to_jsonb(a) AS value FROM cc.artifacts a WHERE id=$1',[artifactId])).rows;
const principals=(await pool.query('SELECT id,issuer,subject,display_name,enabled,permission_version,permissions,preferences FROM cc.application_principals ORDER BY id')).rows;
const ledger=(await pool.query('SELECT id,checksum FROM cc.schema_migrations ORDER BY id')).rows;
const events=(await pool.query('SELECT to_jsonb(e) AS value FROM cc.security_events e ORDER BY id')).rows;
console.log(JSON.stringify({principals,ledger,events,artifactId,artifactMetadata,artifactSha256:digest.digest('hex')}));}finally{await store.close();await pool.end();}
`);
    const before = await inspect();
    await compose(controller, ['stop', 'edge', 'api', 'kestra']);
    for (const host of workers) await compose(host, ['stop', 'workers']);
    const backup = await backupHybridForUpgrade({
      hosts,
      controller,
      config,
      project,
    });
    operator.upgradeFromReleaseHash = beforeState.releaseHash;
    operator.backupManifestSha256 = backup.manifestSha256;
    operator.upgradeBackup = backup.upgradeBackup;
    operator.releaseRoot = '/release';
    await activateTarget();
    assert.equal(config.phase, 3);
    await json(configPath, config);
    await json(releasePath, target);
    await json(operatorPath, operator);
    // The delivered upgrade preflight requires reachable workers before replacement.
    for (const host of workers) await compose(host, ['start', 'workers']);
    assert.equal((await cli('upgrade')).status, 'ready');
    await transfer();
    for (const host of workers)
      await compose(host, ['up', '-d', '--wait', '--wait-timeout', '120']);
    assert.equal((await cli('resume')).status, 'ready');
    assert.equal((await cli('resume')).status, 'ready');
    const afterImages = await verifyHybridImages(
      { hosts, controller, workers, compose },
      target.images,
    );
    const after = await inspect();
    assertHybridUpgradePreservation(before, after);
    for (const [name, bytes] of secrets)
      assert.ok(
        bytes.equals(await readFile(join(root, 'private', name))),
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
      durationMs: Date.now() - started,
      durationScope:
        'Phase 2 browser checks, seeded state, native cold backup, delivered upgrade, repeated resume, and preservation checks.',
      baseline: {
        sourceRevision: baseline.manifest.sourceRevision,
        images: baseline.manifest.images,
        bundleManifestSha256: baseline.manifestSha256,
        sourceTag: baseline.pinned.sourceTag,
        acceptanceScope: baseline.pinned.acceptanceScope,
      },
      baselineBrowser,
      beforeImages,
      afterImages,
      operations: { commands: backup.commands, execution: backup.execution },
      backupManifestSha256: backup.manifestSha256,
      principalCount: before.principals.length,
      baselineMigrations: before.ledger,
      upgradedMigrations: after.ledger,
      artifact: { id: after.artifactId, sha256: after.artifactSha256 },
      auditEventCount: {
        before: before.events.length,
        after: after.events.length,
      },
      installerState: Object.fromEntries(
        [
          ['before', beforeState],
          ['after', afterState],
        ].map(([key, state]) => [
          key,
          {
            phase: state.phase,
            releaseHash: state.releaseHash,
            configurationHash: state.configurationHash,
          },
        ]),
      ),
      checks: {
        principalsPreserved: true,
        preferencesPreserved: true,
        artifactPreserved: true,
        auditEventsPreserved: true,
        migrationChecksumsPreserved: true,
        newMigrationsApplied: true,
        installerStateAdvanced: true,
        existingSecretsPreserved: true,
        backupVerified: true,
        repeatedResume: true,
      },
      limits: [
        'The accepted Phase 2 implementation is pinned. The exact previously installed owner revision remains unknown.',
        'Three Docker daemons share one physical host and synthetic district services.',
        'Synthetic identity and Google providers do not establish district acceptance.',
        'This upgrade report does not establish isolated restore or complete fault recovery.',
      ],
    };
  } finally {
    for (const bytes of secrets.values()) bytes.fill(0);
  }
}

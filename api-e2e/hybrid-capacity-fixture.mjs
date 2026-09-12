import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from '@playwright/test';
import { outerDocker } from './hybrid-hosts-fixture.mjs';
import { faultRecoveryTimeoutSeconds } from '../deployment/qualification/faults.mjs';

/** Fill only the owned capped artifact volume shared by the three Docker hosts. */
export async function qualifyHybridCapacity({
  hosts,
  services,
  compose,
  config,
  upgrade,
  page,
  checks,
  verifyReplicas,
  context,
}) {
  const controller = hosts.hosts[0];
  assert.match(controller.name, /^cc-phase2-hybrid-[a-f0-9]{12}-controller$/);
  assert.equal(new Set(hosts.hosts.map((host) => host.daemonId)).size, 3);
  assert.equal(upgrade.status, 'passed');
  const project = controller.name.replace(/-controller$/, '');
  assert.equal(hosts.artifactVolume, `${project}-bounded-artifacts`);
  const volume = JSON.parse(
    await outerDocker(['volume', 'inspect', hosts.artifactVolume]),
  )[0];
  assert.equal(volume.Labels['com.campus-commander.qualification'], project);
  assert.deepEqual(volume.Options, {
    type: 'tmpfs',
    device: 'tmpfs',
    o: 'size=16m,uid=1000,gid=1000,mode=0700',
  });
  const processes = [];
  for (const host of hosts.hosts) {
    const role = host === controller ? 'api' : 'workers';
    const ids = (await compose(host, ['ps', '--quiet', role]))
      .split('\n')
      .filter(Boolean);
    assert.equal(ids.length, role === 'api' ? 2 : 1);
    for (const id of ids) processes.push({ host, role, id });
  }
  const run = async (process, script) =>
    JSON.parse(
      await hosts.run(
        process.host,
        ['docker', 'exec', '-i', process.id, 'node', '--input-type=module'],
        { input: script },
      ),
    );
  const common = `import fs from 'node:fs/promises';import crypto from 'node:crypto';import pg from 'pg';
import {connectionOptions} from '/app/deployment/postgres/index.mjs';
import {secretPath} from '/app/deployment/redis/runtime.mjs';
import {createArtifactStore} from '/app/deployment/storage/index.mjs';
const c=JSON.parse(await fs.readFile(process.env.CC_CONFIG_FILE));
const pool=new pg.Pool(await connectionOptions(c.services.applicationDatabase,r=>fs.readFile(secretPath(r))));`;
  const state = () =>
    run(
      processes[0],
      common +
        `
const principals=(await pool.query('SELECT * FROM cc.application_principals ORDER BY id')).rows;
const events=(await pool.query('SELECT * FROM cc.security_events ORDER BY id')).rows;
const migrations=(await pool.query('SELECT id,checksum FROM cc.schema_migrations ORDER BY id')).rows;
const artifacts=(await pool.query('SELECT * FROM cc.artifacts ORDER BY id')).rows;
const files=(await fs.readdir(c.artifacts.location)).filter(n=>/^[a-f0-9-]{36}\\.[a-f0-9-]{36}$/.test(n)).sort();
const store=await createArtifactStore({pool,root:c.artifacts.location});const hash=crypto.createHash('sha256');
for await(const bytes of await store.openRead(${JSON.stringify(upgrade.artifact.artifactId)}))hash.update(bytes);
await store.close();await pool.end();console.log(JSON.stringify({principals,events,migrations,artifacts,files,artifactSha256:hash.digest('hex')}));`,
    );
  const executions = async () =>
    JSON.parse(
      await outerDocker([
        'exec',
        services.database,
        'psql',
        '-U',
        'postgres',
        '-d',
        config.services.kestraDatabase.database,
        '-At',
        '-c',
        "SELECT coalesce(json_agg(json_build_object('key',key,'sha256',encode(sha256(convert_to(value::text,'UTF8')),'hex')) ORDER BY key),'[]'::json) FROM public.executions WHERE state_current='SUCCESS';",
      ]),
    );
  await checks();
  await verifyReplicas(context);
  const baseline = await state(),
    baselineExecutions = await executions();
  assert.equal(baseline.principals.length, 1);
  assert.ok(baseline.events.length > 0);
  assert.ok(baselineExecutions.length > 0);
  assert.equal(baseline.artifactSha256, upgrade.artifact.sha256);
  const verifyState = async () => {
    const after = await state();
    for (const name of [
      'principals',
      'migrations',
      'artifacts',
      'files',
      'artifactSha256',
    ])
      assert.deepEqual(
        after[name],
        baseline[name],
        `Capacity must preserve ${name}.`,
      );
    const events = new Map(after.events.map((event) => [event.id, event]));
    for (const event of baseline.events)
      assert.deepEqual(events.get(event.id), event);
    const currentExecutions = new Map(
      (await executions()).map((item) => [item.key, item.sha256]),
    );
    for (const item of baselineExecutions)
      assert.equal(currentExecutions.get(item.key), item.sha256);
    for (const file of upgrade.internalStorageFiles)
      assert.equal(
        createHash('sha256')
          .update(
            await readFile(
              join(config.services.kestra.internalStorage.location, file.path),
            ),
          )
          .digest('hex'),
        file.sha256,
      );
    return {
      principalCount: after.principals.length,
      preservedSecurityEvents: baseline.events.length,
      identityAndPreferencesPreserved: true,
      migrationsPreserved: true,
      artifactSha256: after.artifactSha256,
      failedDiagnosticArtifactsRemoved: true,
      artifactMetadataPreserved: true,
      artifactFilesPreserved: true,
      preservedKestraExecutions: baselineExecutions.length,
      preservedInternalFiles: upgrade.internalStorageFiles.length,
    };
  };
  const filesystem = async (process) =>
    run(
      process,
      `import fs from 'node:fs/promises';
const c=JSON.parse(await fs.readFile(process.env.CC_CONFIG_FILE));const s=await fs.statfs(c.artifacts.location);
console.log(JSON.stringify({filesystemType:s.type,totalBytes:s.blocks*s.bsize,availableBytes:s.bavail*s.bsize}));`,
    );
  const report = {
    status: 'in-progress',
    recoveryBoundSeconds: faultRecoveryTimeoutSeconds,
    sharedVolume: hosts.artifactVolume,
    observations: [],
    limits: [
      'The three Docker daemons share one physical host and a capped synthetic tmpfs artifact volume.',
      'The capacity fixture does not establish persistent storage, district capacity, or district infrastructure acceptance.',
    ],
  };
  const save = () =>
    writeFile(
      join(controller.root, 'capacity-progress.json'),
      JSON.stringify(report, null, 2),
      { mode: 0o600 },
    );
  const writer = processes.find((process) => process.role === 'workers');
  const filler = '.phase2-capacity-filler';
  let filled = false;
  try {
    for (const process of processes) {
      const before = await filesystem(process);
      assert.equal(before.filesystemType, 0x01021994);
      assert.ok(
        Number.isSafeInteger(before.totalBytes) &&
          before.totalBytes > 0 &&
          before.totalBytes <= 16777216,
      );
      report.observations.push({
        host: process.host.name,
        daemonId: process.host.daemonId,
        role: process.role,
        processId: process.id,
        before,
      });
    }
    filled = true;
    report.fault = await run(
      writer,
      `import fs from 'node:fs';
const c=JSON.parse(fs.readFileSync(process.env.CC_CONFIG_FILE));const before=fs.statfsSync(c.artifacts.location);
if(before.type!==0x01021994||before.blocks*before.bsize>16777216||before.blocks*before.bsize<=0)throw Error('Capacity writer requires capped tmpfs.');
const fd=fs.openSync(c.artifacts.location+'/'+${JSON.stringify(filler)},'wx',0o600),bytes=Buffer.alloc(65536,42);let writtenBytes=0,kind;
try{for(let i=0;i<300;i++)writtenBytes+=fs.writeSync(fd,bytes);}catch(error){if(error.code!=='ENOSPC')throw error;kind=error.code;}finally{fs.closeSync(fd);}
if(kind!=='ENOSPC')throw Error('The bounded capacity writer did not reach ENOSPC.');
const after=fs.statfsSync(c.artifacts.location);console.log(JSON.stringify({kind,writtenBytes,availableBytes:after.bavail*after.bsize}));`,
    );
    assert.equal(report.fault.kind, 'ENOSPC');
    for (const [index, process] of processes.entries()) {
      const during = await filesystem(process);
      assert.equal(
        during.totalBytes,
        report.observations[index].before.totalBytes,
      );
      assert.equal(during.availableBytes, 0);
      report.observations[index].during = during;
    }
    await save();
    const card = page.getByRole('article').filter({
      has: page.getByRole('heading', {
        name: 'Artifact storage',
        exact: true,
      }),
    });
    const pending = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/diagnostics/artifacts' &&
        response.request().method() === 'POST',
    );
    await card
      .getByRole('button', { name: 'Check Artifact storage', exact: true })
      .click();
    const response = await pending,
      body = await response.json();
    assert.equal(response.status(), 201);
    assert.equal(body.status, 'failed');
    assert.match(body.correlationId, /^[a-f0-9-]{36}$/);
    await expect(
      card.getByText(
        'The check failed. Inspect the service configuration and retry.',
      ),
    ).toBeVisible();
    report.authenticatedFailure = {
      httpStatus: response.status(),
      status: body.status,
      correlationId: body.correlationId,
    };
    await verifyState();
    report.fault.publicationRejected = true;
    report.fault.readyRowsUnchanged = true;
  } finally {
    if (filled)
      await run(
        writer,
        `import fs from 'node:fs/promises';const c=JSON.parse(await fs.readFile(process.env.CC_CONFIG_FILE));await fs.rm(c.artifacts.location+'/'+${JSON.stringify(filler)},{force:true});console.log('{}');`,
      );
  }
  const recoveryStarted = Date.now();
  await checks({ recoverySeconds: faultRecoveryTimeoutSeconds });
  await verifyReplicas(context);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  report.preserved = await verifyState();
  report.recoveryMs = Date.now() - recoveryStarted;
  assert.ok(report.recoveryMs <= faultRecoveryTimeoutSeconds * 1000);
  for (const [index, process] of processes.entries()) {
    const after = await filesystem(process);
    assert.equal(
      after.availableBytes,
      report.observations[index].before.availableBytes,
    );
    report.observations[index].after = after;
  }
  report.status = 'passed';
  await save();
  return report;
}

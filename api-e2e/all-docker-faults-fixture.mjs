import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { expect } from '@playwright/test';
import { faultRecoveryTimeoutSeconds } from '../deployment/qualification/faults.mjs';

const docker = (args, input) =>
  execFileSync('docker', args, {
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 240000,
    maxBuffer: 4 * 1024 * 1024,
  }).trim();

/** Capture and verify durable state in an owned all-Docker installation. */
export async function createAllDockerDurableProbe({
  root,
  project,
  config,
  release,
  compose,
  id,
  allowObservationRefresh = false,
  allowAppendedMigrations = false,
}) {
  const phase3 = config.phase === 3;
  assert.match(
    project,
    phase3 ? /^cc-phase3-[a-f0-9-]{12}$/ : /^cc-installer-[a-z0-9-]+$/,
  );
  assert.match(
    basename(root),
    phase3 ? /^cc-phase3-compose-/ : /^cc-installer-/,
  );
  const topology = JSON.parse(compose('config', '--format', 'json'));
  assert.equal(topology.name, project);
  assert.equal(config.profile, 'all-docker');
  assert.ok([2, 3].includes(config.phase));
  const inspect = (service) => JSON.parse(docker(['inspect', id(service)]))[0];
  for (const service of [
    'api',
    'workers',
    'redis',
    'application-postgres',
    'kestra-postgres',
    'kestra',
  ])
    assert.equal(
      inspect(service).Config.Labels['com.docker.compose.project'],
      project,
    );
  const artifactMount = inspect('api').Mounts.find(
    (mount) => mount.Destination === config.artifacts.location,
  );
  const internalMount = inspect('kestra').Mounts.find(
    (mount) => mount.Destination === '/app/storage',
  );
  for (const mount of [artifactMount, internalMount]) {
    assert.equal(mount?.Type, 'volume');
    assert.ok(mount.Name.startsWith(project + '_'));
  }
  const internalMarker = `Phase ${config.phase} process recovery: École 学校`;
  const internal = (write = false) =>
    docker([
      'run',
      '--rm',
      '--network',
      'none',
      '--user',
      '1000:1000',
      '--entrypoint',
      'node',
      '--mount',
      `type=volume,source=${internalMount.Name},target=/storage${write ? '' : ',readonly'}`,
      release.images.api,
      '--input-type=module',
      '-e',
      `import fs from 'node:fs/promises';import crypto from 'node:crypto';
const path='/storage/.phase${config.phase}-process-fixture';
${write ? `await fs.writeFile(path,${JSON.stringify(internalMarker)},{flag:'wx',mode:0o600});` : ''}
console.log(crypto.createHash('sha256').update(await fs.readFile(path)).digest('hex'));`,
    ]);
  const internalSha256 = internal(true);
  assert.equal(
    internalSha256,
    createHash('sha256').update(internalMarker).digest('hex'),
  );
  if (phase3)
    docker(
      ['exec', '-i', id('api'), 'node', '--input-type=module'],
      `
import fs from 'node:fs/promises';import crypto from 'node:crypto';import pg from 'pg';
import {connectionOptions} from '/app/deployment/postgres/index.mjs';
import {createArtifactStore} from '/app/deployment/storage/index.mjs';
import {secretPath} from '/app/deployment/redis/runtime.mjs';
const c=JSON.parse(await fs.readFile(process.env.CC_CONFIG_FILE));
const pool=new pg.Pool(await connectionOptions(c.services.applicationDatabase,r=>fs.readFile(secretPath(r))));
const store=await createArtifactStore({pool,root:c.artifacts.location});
const bytes=Buffer.from('CC57 service recovery: École 学校');
const artifact=await store.stage({schemaVersion:1,expectedSizeBytes:bytes.length,expectedSha256:crypto.createHash('sha256').update(bytes).digest('hex')},[bytes]);
await store.publish(artifact);
await fs.writeFile(c.artifacts.location+'/.cc16-fixture.json',JSON.stringify(artifact),{flag:'wx',mode:0o600});
await store.close();await pool.end();`,
    );
  // Hash protected policy rows inside the owned database. Export no credential envelopes.
  const policy = () =>
    Object.fromEntries(
      [
        'google_connection',
        'google_credentials',
        'customer_settings_revisions',
        'school_definitions',
        'application_grants',
        'application_access_changes',
      ].map((table) => [
        table,
        JSON.parse(
          docker([
            'exec',
            id('application-postgres'),
            'psql',
            '-U',
            'postgres',
            '-d',
            config.services.applicationDatabase.database,
            '-At',
            '-c',
            `SELECT json_build_object('count',count(*),'sha256',encode(sha256(convert_to(coalesce(json_agg(value ORDER BY value::text)::text,'[]'),'UTF8')),'hex')) FROM (SELECT ${allowObservationRefresh && table === 'google_connection' ? "row_to_json(t)::jsonb - 'observation' - 'observed_at'" : 'row_to_json(t)'} AS value FROM cc.${table} t) rows;`,
          ]),
        ),
      ]),
    );
  const baselinePolicy = phase3 ? policy() : undefined;
  if (phase3) {
    for (const entry of Object.values(baselinePolicy))
      assert.ok(entry.count > 0);
    assert.equal(baselinePolicy.google_connection.count, 1);
    assert.equal(baselinePolicy.school_definitions.count, 2);
    assert.ok(baselinePolicy.application_access_changes.count >= 2);
  }
  const durable = () =>
    JSON.parse(
      docker(
        ['exec', '-i', id('api'), 'node', '--input-type=module'],
        `import fs from 'node:fs/promises';import crypto from 'node:crypto';import pg from 'pg';
import {connectionOptions} from '/app/deployment/postgres/index.mjs';
import {createArtifactStore} from '/app/deployment/storage/index.mjs';
import {secretPath} from '/app/deployment/redis/runtime.mjs';
const c=JSON.parse(await fs.readFile(process.env.CC_CONFIG_FILE));
const pool=new pg.Pool(await connectionOptions(c.services.applicationDatabase,r=>fs.readFile(secretPath(r))));
const principals=(await pool.query('SELECT * FROM cc.application_principals ORDER BY id')).rows;
const events=(await pool.query('SELECT * FROM cc.security_events ORDER BY id')).rows;
const migrations=(await pool.query('SELECT id,checksum FROM cc.schema_migrations ORDER BY id')).rows;
const artifact=JSON.parse(await fs.readFile(c.artifacts.location+'/.cc16-fixture.json'));
const store=await createArtifactStore({pool,root:c.artifacts.location});const hash=crypto.createHash('sha256');
for await(const bytes of await store.openRead(artifact.artifactId))hash.update(bytes);
await store.close();await pool.end();
console.log(JSON.stringify({principals,events,migrations,artifactId:artifact.artifactId,artifactSha256:hash.digest('hex')}));`,
      ),
    );
  const executions = () =>
    JSON.parse(
      docker([
        'exec',
        id('kestra-postgres'),
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
  const baseline = durable();
  const baselineExecutions = executions();
  assert.equal(baseline.principals.length, phase3 ? 2 : 1);
  assert.ok(baseline.events.length > 0);
  assert.ok(baselineExecutions.length > 0);
  const verifyDurable = () => {
    const after = durable();
    if (phase3) assert.deepEqual(policy(), baselinePolicy);
    assert.deepEqual(after.principals, baseline.principals);
    if (allowAppendedMigrations) {
      const migrations = new Map(after.migrations.map((row) => [row.id, row]));
      for (const row of baseline.migrations)
        assert.deepEqual(migrations.get(row.id), row);
    } else assert.deepEqual(after.migrations, baseline.migrations);
    assert.equal(after.artifactId, baseline.artifactId);
    assert.equal(after.artifactSha256, baseline.artifactSha256);
    const events = new Map(after.events.map((event) => [event.id, event]));
    for (const event of baseline.events)
      assert.deepEqual(events.get(event.id), event);
    const current = new Map(
      executions().map((execution) => [execution.key, execution.sha256]),
    );
    for (const execution of baselineExecutions)
      assert.equal(current.get(execution.key), execution.sha256);
    assert.equal(internal(), internalSha256);
    return {
      ...(phase3 ? { preservedPolicy: baselinePolicy } : {}),
      principalCount: after.principals.length,
      preservedSecurityEvents: baseline.events.length,
      artifactSha256: after.artifactSha256,
      preservedKestraExecutions: baselineExecutions.length,
      internalStorageSha256: internalSha256,
      preservedInternalFiles: 1,
    };
  };
  return verifyDurable;
}

/** Verify authenticated recovery and durable state in an owned installation. */
export async function faultAllDocker({
  root,
  project,
  config,
  release,
  compose,
  id,
  page,
  checks,
  evidencePath = join(root, 'application-fault-progress.json'),
  evidenceIdentity = {},
}) {
  const startedAt = Date.now();
  const request = (operation) =>
    page.evaluate(
      async ({ operation }) => {
        const session = await fetch('/api/auth/session', {
          signal: AbortSignal.timeout(45000),
        });
        if (!session.ok || !operation) return { httpStatus: session.status };
        const response = await fetch('/api/diagnostics/' + operation, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-csrf-token': (await session.json()).csrfToken,
          },
          body: '{}',
          signal: AbortSignal.timeout(45000),
        });
        const result = await response.json();
        return {
          httpStatus: response.status,
          status: result.status,
          correlationId: result.correlationId,
        };
      },
      { operation },
    );
  const permissions = (mode) =>
    docker([
      'exec',
      id('api'),
      'node',
      '--input-type=module',
      '-e',
      `import fs from 'node:fs/promises';await fs.chmod(${JSON.stringify(config.artifacts.location)},${mode});`,
    ]);
  const cases = [
    { name: 'api-interruption', service: 'api', denied: true },
    { name: 'worker-interruption', service: 'workers', operation: 'kestra' },
    {
      name: 'redis-interruption',
      service: 'redis',
      denied: true,
      freshSession: true,
    },
    {
      name: 'application-postgresql-interruption',
      service: 'application-postgres',
      denied: true,
    },
    {
      name: 'kestra-postgresql-interruption',
      service: 'kestra-postgres',
      operation: 'kestra',
    },
    { name: 'kestra-interruption', service: 'kestra', operation: 'kestra' },
    { name: 'artifact-access-loss', operation: 'artifacts' },
  ];
  const report = {
    ...evidenceIdentity,
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    environment: {
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
      browser: page.context().browser().version(),
    },
    durationScope:
      'Durable-state setup, service interruptions, recovery checks, and preservation probes.',
    status: 'in-progress',
    profile: 'all-docker',
    phase: config.phase,
    sourceRevision: release.sourceRevision,
    images: release.images,
    recoveryBoundSeconds: faultRecoveryTimeoutSeconds,
    cases: [],
    limits: [
      'One Docker host retains host and volume failure points.',
      'Capacity and certificate faults require separate evidence.',
      ...(config.phase === 3
        ? [
            'Provider faults, stale credentials, and full profile acceptance require separate evidence.',
          ]
        : []),
    ],
  };
  const save = () => {
    report.durationMs = Date.now() - startedAt;
    return writeFile(evidencePath, JSON.stringify(report, null, 2), {
      mode: 0o600,
    });
  };
  try {
    await save();
    const verifyDurable = await createAllDockerDurableProbe({
      root,
      project,
      config,
      release,
      compose,
      id,
    });
    for (const fault of cases) {
      console.log('All-Docker application fault:', fault.name);
      await checks({ recoverySeconds: faultRecoveryTimeoutSeconds });
      verifyDurable();
      const record = {
        name: fault.name,
        status: 'in-progress',
        startedAt: new Date().toISOString(),
      };
      report.cases.push(record);
      await save();
      const started = Date.now();
      try {
        if (fault.service) compose('stop', '--timeout', '5', fault.service);
        else permissions(0o000);
        record.observed = await request(fault.operation);
        if (fault.denied) assert.ok(record.observed.httpStatus >= 500);
        else {
          assert.equal(record.observed.httpStatus, 201);
          assert.ok(['failed', 'timed-out'].includes(record.observed.status));
          assert.match(record.observed.correlationId, /^[a-f0-9-]{36}$/);
        }
      } finally {
        if (fault.service) compose('start', fault.service);
        else permissions(0o700);
      }
      record.interruptionMs = Date.now() - started;
      const recoveryStarted = Date.now();
      if (fault.freshSession) {
        await expect
          .poll(async () => (await request()).httpStatus, { timeout: 15000 })
          .toBe(401);
        record.sourceSessionRejected = true;
        await page.goto(config.applicationAuth.publicOrigin + '/login');
        await page
          .getByRole('link', { name: 'Sign in to Campus Commander' })
          .click();
        await expect(
          page.getByRole('heading', { name: 'Your account', exact: true }),
        ).toBeVisible({ timeout: 15000 });
      } else
        await expect
          .poll(async () => (await request()).httpStatus, { timeout: 30000 })
          .toBe(200);
      await checks({
        recoverySeconds: faultRecoveryTimeoutSeconds,
        recoveryDeadline: recoveryStarted + faultRecoveryTimeoutSeconds * 1000,
      });
      record.recoveryMs = Date.now() - recoveryStarted;
      assert.ok(record.recoveryMs <= faultRecoveryTimeoutSeconds * 1000);
      record.durableState = verifyDurable();
      record.status = 'passed';
      await save();
    }
    report.status = 'passed';
    await save();
    return report;
  } catch (error) {
    report.status = 'failed';
    const current = report.cases.at(-1);
    if (current?.status === 'in-progress') current.status = 'failed';
    await save();
    throw error;
  }
}

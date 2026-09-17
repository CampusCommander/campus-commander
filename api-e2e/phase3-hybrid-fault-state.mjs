import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { outerDocker } from './hybrid-hosts-fixture.mjs';

const policyTables = [
  'google_connection',
  'google_credentials',
  'customer_settings_revisions',
  'school_definitions',
  'application_grants',
  'application_access_changes',
];

/** Restrict fault probes to the three owned hybrid fixture hosts. */
export function assertHybridFaultOwnership({
  hosts,
  services,
  config,
  project,
}) {
  assert.match(project, /^cc-phase3-hybrid-[a-f0-9]{12}$/);
  assert.equal(config.phase, 3);
  assert.equal(config.profile, 'hybrid');
  assert.equal(hosts.hosts.length, 3);
  assert.equal(new Set(hosts.hosts.map((host) => host.daemonId)).size, 3);
  const root = hosts.hosts[0].root.split('/').slice(0, 3).join('/');
  assert.ok(root.startsWith(`/tmp/${project}-`));
  assert.equal(hosts.shared, join(root, 'shared'));
  for (const host of hosts.hosts) {
    assert.equal(resolve(host.root), host.root);
    assert.equal(host.root, join(root, host.role));
  }
  assert.deepEqual(
    hosts.hosts.map((host) => host.role),
    ['controller', 'worker-1', 'worker-2'],
  );
  assert.equal(services.database, `${project}-postgres`);
  assert.equal(services.redis, `${project}-redis`);
  assert.equal(config.artifacts.location, join(hosts.shared, 'artifacts'));
  assert.equal(
    config.services.kestra.internalStorage.location,
    join(hosts.shared, 'kestra'),
  );
}

/** Require original durable records after each service interruption. */
export function assertHybridFaultState(
  before,
  after,
  { allowAppendedMigrations = false } = {},
) {
  assert.equal(before.principals.length, 2);
  assert.ok(before.events.length > 0);
  assert.ok(before.executions.length > 0);
  assert.ok(before.artifacts.length > 0);
  for (const table of policyTables) assert.ok(before.policy[table].count > 0);
  assert.equal(before.policy.google_connection.count, 1);
  assert.equal(before.policy.school_definitions.count, 2);
  assert.deepEqual(after.policy, before.policy);
  assert.deepEqual(after.principals, before.principals);
  if (allowAppendedMigrations) {
    assert.ok(after.migrations.length >= before.migrations.length);
    for (const row of before.migrations)
      assert.deepEqual(
        after.migrations.find((item) => item.id === row.id),
        row,
      );
  } else assert.deepEqual(after.migrations, before.migrations);
  const preserve = (original, current, key) => {
    const rows = new Map(current.map((row) => [row[key], row]));
    for (const row of original) assert.deepEqual(rows.get(row[key]), row);
  };
  preserve(before.events, after.events, 'id');
  preserve(before.artifacts, after.artifacts, 'id');
  preserve(before.executions, after.executions, 'key');
  assert.equal(after.artifactSha256, before.artifactSha256);
  assert.equal(after.internalStorageSha256, before.internalStorageSha256);
}

/** Seed one artifact and verify durable state through actual fixture services. */
export async function createHybridFaultStateProbe(input) {
  assertHybridFaultOwnership(input);
  const {
    hosts,
    services,
    config,
    compose,
    allowObservationRefresh = false,
    allowAppendedMigrations = false,
  } = input;
  const controller = hosts.hosts[0];
  for (const path of [
    config.artifacts.location,
    config.services.kestra.internalStorage.location,
  ])
    assert.equal(await realpath(path), path);
  const api = async (script) => {
    const ids = (await compose(controller, ['ps', '--quiet', 'api']))
      .split('\n')
      .filter(Boolean);
    assert.equal(ids.length, 2);
    return JSON.parse(
      await hosts.run(
        controller,
        ['docker', 'exec', '-i', ids[0], 'node', '--input-type=module'],
        { input: script },
      ),
    );
  };
  const common = `import fs from 'node:fs/promises';import crypto from 'node:crypto';import pg from 'pg';
import {connectionOptions} from '/app/deployment/postgres/index.mjs';
import {createArtifactStore} from '/app/deployment/storage/index.mjs';
import {secretPath} from '/app/deployment/redis/runtime.mjs';
const config=JSON.parse(await fs.readFile(process.env.CC_CONFIG_FILE));
const pool=new pg.Pool(await connectionOptions(config.services.applicationDatabase,ref=>fs.readFile(secretPath(ref))));
const store=await createArtifactStore({pool,root:config.artifacts.location});`;
  const artifact = await api(
    common +
      `
try {
const bytes=Buffer.from('Phase 3 hybrid service recovery: École 学校');
const artifact=await store.stage({schemaVersion:1,expectedSizeBytes:bytes.length,expectedSha256:crypto.createHash('sha256').update(bytes).digest('hex')},[bytes]);
await store.publish(artifact);console.log(JSON.stringify(artifact));
} finally {await store.close();await pool.end();}`,
  );
  const internalPath = join(
    config.services.kestra.internalStorage.location,
    '.phase3-service-fault-marker',
  );
  await writeFile(internalPath, 'Phase 3 hybrid internal storage: École 学校', {
    flag: 'wx',
    mode: 0o600,
  });
  const sql = async (database, query) =>
    JSON.parse(
      await outerDocker([
        'exec',
        services.database,
        'psql',
        '-U',
        'postgres',
        '-d',
        database,
        '-At',
        '-c',
        query,
      ]),
    );
  const snapshot = async () => {
    const policy = {};
    for (const table of policyTables)
      policy[table] = await sql(
        config.services.applicationDatabase.database,
        `SELECT json_build_object('count',count(*),'sha256',encode(sha256(convert_to(coalesce(json_agg(value ORDER BY value::text)::text,'[]'),'UTF8')),'hex')) FROM (SELECT ${allowObservationRefresh && table === 'google_connection' ? "row_to_json(t)::jsonb - 'observation' - 'observed_at'" : 'row_to_json(t)'} AS value FROM cc.${table} t) rows;`,
      );
    const durable = await api(
      common +
        `
try {
const principals=(await pool.query('SELECT * FROM cc.application_principals ORDER BY id')).rows;
const events=(await pool.query('SELECT * FROM cc.security_events ORDER BY id')).rows;
const migrations=(await pool.query('SELECT id,checksum FROM cc.schema_migrations ORDER BY id')).rows;
const artifacts=(await pool.query('SELECT * FROM cc.artifacts ORDER BY id')).rows;
const hash=crypto.createHash('sha256');
for await(const bytes of await store.openRead(${JSON.stringify(artifact.artifactId)}))hash.update(bytes);
console.log(JSON.stringify({principals,events,migrations,artifacts,artifactSha256:hash.digest('hex')}));
} finally {await store.close();await pool.end();}`,
    );
    const executions = await sql(
      config.services.kestraDatabase.database,
      "SELECT coalesce(json_agg(json_build_object('key',key,'sha256',encode(sha256(convert_to(value::text,'UTF8')),'hex')) ORDER BY key),'[]'::json) FROM public.executions WHERE state_current='SUCCESS';",
    );
    return {
      ...durable,
      policy,
      executions,
      internalStorageSha256: createHash('sha256')
        .update(await readFile(internalPath))
        .digest('hex'),
    };
  };
  const before = await snapshot();
  assert.equal(before.artifactSha256, artifact.sha256);
  assertHybridFaultState(before, before);
  return async () => {
    const after = await snapshot();
    assertHybridFaultState(before, after, { allowAppendedMigrations });
    return {
      preservedPolicy: before.policy,
      principalCount: before.principals.length,
      preservedSecurityEvents: before.events.length,
      preservedArtifactRecords: before.artifacts.length,
      artifactSha256: before.artifactSha256,
      preservedKestraExecutions: before.executions.length,
      internalStorageSha256: before.internalStorageSha256,
    };
  };
}

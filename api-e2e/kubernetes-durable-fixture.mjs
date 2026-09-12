import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Preserve application state, published artifacts, and completed Kestra state during faults. */
export async function createKubernetesDurableProbe({
  root,
  kube,
  config,
  upgrade,
}) {
  const runApi = async (script) =>
    JSON.parse(
      await kube(
        ['exec', '-i', 'deployment/api', '--', 'node', '--input-type=module'],
        script,
      ),
    );
  const durable = () =>
    runApi(`import fs from 'node:fs/promises';import crypto from 'node:crypto';import pg from 'pg';
import {connectionOptions} from '/app/deployment/postgres/index.mjs';
import {createArtifactStore} from '/app/deployment/storage/index.mjs';
import {secretPath} from '/app/deployment/redis/runtime.mjs';
const c=JSON.parse(await fs.readFile(process.env.CC_CONFIG_FILE));
const pool=new pg.Pool(await connectionOptions(c.services.applicationDatabase,r=>fs.readFile(secretPath(r))));
const principals=(await pool.query('SELECT * FROM cc.application_principals ORDER BY id')).rows;
const events=(await pool.query('SELECT * FROM cc.security_events ORDER BY id')).rows;
const migrations=(await pool.query('SELECT id,checksum FROM cc.schema_migrations ORDER BY id')).rows;
const store=await createArtifactStore({pool,root:c.artifacts.location}),hash=crypto.createHash('sha256');
for await(const bytes of await store.openRead(${JSON.stringify(upgrade.preserved.artifactId)}))hash.update(bytes);
await store.close();await pool.end();
console.log(JSON.stringify({principals,events,migrations,artifactSha256:hash.digest('hex')}));`);
  const executions = async () =>
    JSON.parse(
      await kube([
        'exec',
        'deployment/kestra-postgres',
        '--',
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
  const internalFiles = async (
    path = join(root, 'shared/kestra-internal/kestra'),
    prefix = '',
  ) => {
    const files = [];
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (entry.isDirectory())
        files.push(
          ...(await internalFiles(join(path, entry.name), relative + '/')),
        );
      else {
        assert.ok(entry.isFile());
        files.push({
          path: relative,
          sha256: createHash('sha256')
            .update(await readFile(join(path, entry.name)))
            .digest('hex'),
        });
      }
    }
    return files.sort((a, b) => a.path.localeCompare(b.path));
  };
  const baseline = await durable(),
    baselineExecutions = await executions(),
    baselineFiles = await internalFiles();
  assert.equal(baseline.principals.length, 1);
  assert.ok(baseline.events.length > 0);
  assert.ok(baselineExecutions.length > 0);
  assert.ok(baselineFiles.length > 0);
  assert.equal(baseline.artifactSha256, upgrade.preserved.artifactSha256);
  const verifyDurable = async () => {
    const after = await durable();
    assert.deepEqual(after.principals, baseline.principals);
    assert.deepEqual(after.migrations, baseline.migrations);
    assert.equal(after.artifactSha256, baseline.artifactSha256);
    const events = new Map(after.events.map((item) => [item.id, item]));
    for (const event of baseline.events)
      assert.deepEqual(events.get(event.id), event);
    const current = new Map(
      (await executions()).map((item) => [item.key, item.sha256]),
    );
    for (const item of baselineExecutions)
      assert.equal(current.get(item.key), item.sha256);
    const files = new Map(
      (await internalFiles()).map((item) => [item.path, item.sha256]),
    );
    for (const item of baselineFiles)
      assert.equal(files.get(item.path), item.sha256);
    return {
      principalCount: after.principals.length,
      preservedSecurityEvents: baseline.events.length,
      artifactSha256: after.artifactSha256,
      preservedKestraExecutions: baselineExecutions.length,
      preservedInternalFiles: baselineFiles.length,
    };
  };
  return verifyDurable;
}

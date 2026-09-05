// Throwaway V0 experiment. This is not application implementation.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { readFile, writeFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const require = createRequire(`${process.env.V0_NODE_MODULES || '/tmp/campus-v0-lab/node/node_modules'}/loader.cjs`);
const { Pool } = require('pg');
const { createClient } = require('redis');
const out = new URL('../evidence/', import.meta.url);
const pg = new Pool({ host: '127.0.0.1', port: 55439, user: process.env.USER, database: 'v0_validation', max: 12 });
assert.equal((await pg.query('SELECT current_database() AS db')).rows[0].db, 'v0_validation');
const redis = createClient({ url: 'redis://127.0.0.1:56389' });
await redis.connect();
const checks = [];
const check = async (name, fn) => {
  const started = performance.now();
  await fn();
  checks.push({ name, pass: true, durationMs: +(performance.now() - started).toFixed(2) });
  console.log(`PASS ${name}`);
};
const compareDelete = `if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end`;
const hold = 'v0:HoldDeviceUpdate';
try {
  await pg.query(`CREATE SCHEMA IF NOT EXISTS v0;
    CREATE TABLE IF NOT EXISTS v0.jobs(id text PRIMARY KEY, size integer, state text);
    CREATE TABLE IF NOT EXISTS v0.outbox(job_id text PRIMARY KEY REFERENCES v0.jobs);
    CREATE TABLE IF NOT EXISTS v0.operations(id integer PRIMARY KEY, assignment integer, state text, epoch integer DEFAULT 1, attempts integer DEFAULT 0);
    CREATE TABLE IF NOT EXISTS v0.provider_effects(id integer PRIMARY KEY, value text);
    CREATE TABLE IF NOT EXISTS v0.artifacts(id text PRIMARY KEY, path text, checksum text, state text, attempt integer);
    TRUNCATE v0.outbox, v0.jobs, v0.operations, v0.provider_effects, v0.artifacts;`);
  await check('operation acceptance and outbox roll back together', async () => {
    const c = await pg.connect();
    try {
      await c.query('BEGIN');
      await c.query("INSERT INTO v0.jobs VALUES ('rolled-back', 1, 'queued')");
      await c.query("INSERT INTO v0.outbox VALUES ('rolled-back')");
      await c.query('ROLLBACK');
      assert.equal((await c.query('SELECT count(*)::int AS n FROM v0.jobs')).rows[0].n, 0);
      assert.equal((await c.query('SELECT count(*)::int AS n FROM v0.outbox')).rows[0].n, 0);
    } finally { c.release(); }
  });
  await check('backoff overwrites ownership and renews the 300-second TTL', async () => {
    await redis.set(hold, 'A', { EX: 300 });
    await redis.pExpire(hold, 1000);
    await redis.set(hold, 'B', { EX: 300 });
    assert.equal(await redis.get(hold), 'B');
    assert.ok(await redis.pTTL(hold) > 299000);
    assert.equal(await redis.eval(compareDelete, { keys: [hold], arguments: ['A'] }), 0);
    await redis.set(hold, 'A', { EX: 300 });
    assert.equal(await redis.get(hold), 'A');
    assert.equal(await redis.eval(compareDelete, { keys: [hold], arguments: ['A'] }), 1);
  });
  await check('concurrent ownership replacement cannot be deleted by previous-owner cleanup', async () => {
    for (let n = 0; n < 100; n++) {
      await redis.set(hold, 'A', { EX: 300 });
      await Promise.all([
        redis.eval(compareDelete, { keys: [hold], arguments: ['A'] }),
        redis.set(hold, 'B', { EX: 300 }),
      ]);
      assert.equal(await redis.get(hold), 'B');
    }
  });
  await check('recovery requires owner and revision from the current backoff period', async () => {
    const key = 'v0:recovery';
    await redis.hSet(key, { owner: 'A', revision: '1', successes: '5' });
    await redis.hSet(key, { owner: 'A', revision: '2', successes: '0' });
    const release = `if redis.call('HGET',KEYS[1],'owner')==ARGV[1] and redis.call('HGET',KEYS[1],'revision')==ARGV[2] and tonumber(redis.call('HGET',KEYS[1],'successes') or '0')>=tonumber(ARGV[3]) then return redis.call('DEL',KEYS[1]) else return 0 end`;
    assert.equal(await redis.eval(release, { keys: [key], arguments: ['A', '1', '5'] }), 0);
    assert.equal(await redis.eval(release, { keys: [key], arguments: ['A', '2', '5'] }), 0);
    await redis.hSet(key, { successes: '5' });
    assert.equal(await redis.eval(release, { keys: [key], arguments: ['A', '2', '5'] }), 1);
  });
  await check('atomic Redis gate blocks new admission and returns smallest pending job on release', async () => {
    const queue = 'v0:pending';
    await redis.del(queue);
    await redis.zAdd(queue, [{ score: 5000, value: 'large' }, { score: 20, value: 'small' }, { score: 500, value: 'medium' }]);
    const admit = `if redis.call('EXISTS',KEYS[1])==1 then return {} else return redis.call('ZPOPMIN',KEYS[2],1) end`;
    await redis.set(hold, 'B', { EX: 300 });
    assert.deepEqual(await redis.eval(admit, { keys: [hold, queue], arguments: [] }), []);
    await redis.eval(compareDelete, { keys: [hold], arguments: ['B'] });
    assert.equal((await redis.eval(admit, { keys: [hold, queue], arguments: [] }))[0], 'small');
    assert.equal((await redis.eval(admit, { keys: [hold, queue], arguments: [] }))[0], 'medium');
  });
  await check('parallel assignments settle with failed operations without replaying successes', async () => {
    await pg.query("INSERT INTO v0.operations(id,assignment,state) SELECT i, (i-1)/500, 'pending' FROM generate_series(1,5000) i");
    const assignments = await Promise.allSettled(Array.from({ length: 10 }, (_, assignment) => pg.query(`
      UPDATE v0.operations SET state=CASE WHEN id % 997=0 THEN 'failed' ELSE 'succeeded' END, attempts=attempts+1
      WHERE assignment=$1 AND state='pending' RETURNING id,state`, [assignment])));
    assert.ok(assignments.every(x => x.status === 'fulfilled'));
    const first = (await pg.query('SELECT state,count(*)::int AS n FROM v0.operations GROUP BY state')).rows;
    assert.equal(first.find(x => x.state === 'failed').n, 5);
    await pg.query("UPDATE v0.operations SET state='succeeded',attempts=attempts+1 WHERE state='failed'");
    assert.equal((await pg.query('SELECT count(*)::int AS n FROM v0.operations WHERE attempts=1')).rows[0].n, 4995);
    assert.equal((await pg.query('SELECT count(*)::int AS n FROM v0.operations WHERE attempts=2')).rows[0].n, 5);
  });
  await check('worker process death after simulated provider acceptance preserves an unknown effect', async () => {
    await pg.query("INSERT INTO v0.operations VALUES (900001, 99, 'dispatch_recorded', 1, 1)");
    const child = fork(fileURLToPath(new URL('crash-worker.mjs', import.meta.url)), [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], env: process.env });
    const ready = new Promise((resolve, reject) => {
      child.once('message', resolve);
      child.once('error', reject);
      child.once('exit', () => reject(new Error('worker exited before acceptance checkpoint')));
    });
    await ready;
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGKILL');
    await exited;
    const state = (await pg.query('SELECT state FROM v0.operations WHERE id=900001')).rows[0].state;
    assert.equal(state, 'dispatch_recorded');
    assert.equal((await pg.query('SELECT count(*)::int AS n FROM v0.provider_effects WHERE id=900001')).rows[0].n, 1);
    await pg.query("UPDATE v0.operations SET state='unknown',epoch=2 WHERE id=900001");
    const stale = await pg.query("UPDATE v0.operations SET state='succeeded' WHERE id=900001 AND epoch=1");
    assert.equal(stale.rowCount, 0);
  });
  const directory = '/tmp/campus-v0-lab/artifacts';
  await mkdir(directory, { recursive: true });
  const content = Buffer.from('V0 synthetic artifact\n');
  const checksum = createHash('sha256').update(content).digest('hex');
  await check('written artifacts remain unpublished after database publication rolls back', async () => {
    const path = `${directory}/attempt-1`;
    await pg.query("INSERT INTO v0.artifacts VALUES ('a',$1,$2,'staging',1)", [path, checksum]);
    const f = await open(`${path}.tmp`, 'w');
    await f.writeFile(content); await f.sync(); await f.close();
    await rename(`${path}.tmp`, path);
    const c = await pg.connect();
    try {
      await c.query('BEGIN');
      await c.query("UPDATE v0.artifacts SET state='ready' WHERE id='a'");
      await c.query('ROLLBACK');
    } finally { c.release(); }
    assert.equal((await pg.query("SELECT count(*)::int AS n FROM v0.artifacts WHERE state='ready'")).rows[0].n, 0);
    assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'), checksum);
    await pg.query("UPDATE v0.artifacts SET state='ready' WHERE id='a' AND state='staging' AND attempt=1");
    assert.equal((await pg.query("SELECT state FROM v0.artifacts WHERE id='a'")).rows[0].state, 'ready');
  });
  await check('integrity mismatch and stale attempt prevent authoritative publication', async () => {
    const path = `${directory}/bad-attempt`;
    await writeFile(path, 'incomplete');
    const actual = createHash('sha256').update(await readFile(path)).digest('hex');
    assert.notEqual(actual, checksum);
    const stale = await pg.query("UPDATE v0.artifacts SET state='ready' WHERE id='a' AND attempt=0");
    assert.equal(stale.rowCount, 0);
    await unlink(path);
  });
  const result = { date: new Date().toISOString(), postgres: (await pg.query('SELECT version()')).rows[0].version,
    redis: (await redis.info('server')).match(/redis_version:([^\r]+)/)[1], checks,
    limits: ['Throwaway experiment, not production implementation', 'Provider effect is simulated in a separate committed table',
      'Recovery counter test does not validate the complete event aggregation protocol', 'Redis admission reservation still requires PostgreSQL recovery design',
      'Artifact checks use local disk and transaction rollback, not shared storage or host power loss'] };
  await writeFile(new URL('runtime-probe.json', out), JSON.stringify(result, null, 2) + '\n');
} finally { await redis.quit(); await pg.end(); }

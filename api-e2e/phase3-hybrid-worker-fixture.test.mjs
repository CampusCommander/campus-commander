import assert from 'node:assert/strict';
import test from 'node:test';
import { qualifyHybridWorkerCredentials } from './phase3-hybrid-worker-fixture.mjs';

test('hybrid renewal rejects unowned roots and shared daemons before database access', async () => {
  const project = 'cc-phase3-hybrid-0123456789ab';
  const fixture = {
    project,
    controller: {
      root: `/tmp/${project}-test/controller`,
      daemonId: 'controller',
    },
    workers: [
      { root: `/tmp/${project}-test/worker-1`, daemonId: 'worker-1' },
      { root: `/tmp/${project}-test/worker-2`, daemonId: 'worker-2' },
    ],
    hosts: {
      run() {
        throw new Error('Database or worker access must not start.');
      },
    },
  };
  for (const changes of [
    { project: 'district-production' },
    { controller: { ...fixture.controller, root: '/district/controller' } },
    { workers: [fixture.workers[0]] },
    { workers: [fixture.workers[0], fixture.workers[0]] },
    { workers: [fixture.controller, fixture.workers[0]] },
    {
      workers: [
        fixture.workers[0],
        { ...fixture.workers[1], root: '/district/worker' },
      ],
    },
  ]) {
    await assert.rejects(
      qualifyHybridWorkerCredentials({ ...fixture, ...changes }),
      { name: 'AssertionError' },
    );
  }
});

test('renewal instrumentation observes pending leases without retaining query data', async () => {
  const { readFile } = await import('node:fs/promises');
  const { runInNewContext } = await import('node:vm');
  const source = await readFile(
    new URL('./phase3-hybrid-renewal-preload.cjs', import.meta.url),
    'utf8',
  );
  const root = '/run/qualification-observation';
  const files = new Map([
    [`${root}/hold.json`, JSON.stringify({ hold: true })],
  ]);
  const privateResult = {
    rows: [
      { result: { status: 'pending', envelope: 'private-fixture-token' } },
    ],
  };
  const unrelatedResult = {};
  class Pool {
    query(sql) {
      return sql === 'SELECT cc.acquire_google_access($1,$2,$3) AS result'
        ? Promise.resolve(privateResult)
        : unrelatedResult;
    }
  }
  let providerCalls = 0;
  class Transport {
    async request() {
      providerCalls++;
      return { data: 'private-provider-token' };
    }
  }
  class JWT {
    transporter = new Transport();
  }
  const fs = {
    readFileSync(path) {
      if (!files.has(path))
        throw Object.assign(new Error(), { code: 'ENOENT' });
      return files.get(path);
    },
    writeFileSync(path, value, options) {
      assert.equal(options.mode, 0o600);
      files.set(path, value);
    },
    renameSync(from, to) {
      files.set(to, files.get(from));
      files.delete(from);
    },
  };
  runInNewContext(source, {
    require(name) {
      if (name === 'node:fs') return fs;
      if (name === 'node:module')
        return {
          createRequire: () => (name) => (name === 'pg' ? { Pool } : { JWT }),
        };
      throw new Error('Unexpected dependency.');
    },
    process: { cwd: () => '/app', pid: 1 },
    URL,
    Date,
    setTimeout,
  });
  const tokenRequest = new JWT().transporter.request({
    url: 'https://oauth2.googleapis.com/token',
  });
  assert.equal(providerCalls, 0);
  assert.equal(files.get(`${root}/renewal-started.json`), '{"observed":true}');
  assert.equal(
    await new Pool().query(
      'SELECT cc.acquire_google_access($1,$2,$3) AS result',
      ['private-query-input'],
    ),
    privateResult,
  );
  assert.equal(new Pool().query('unrelated query'), unrelatedResult);
  assert.equal(files.get(`${root}/pending.json`), '{"observed":true}');
  for (const value of files.values())
    assert.equal(value.includes('private-'), false);
  files.set(`${root}/hold.json`, JSON.stringify({ hold: false }));
  assert.deepEqual(await tokenRequest, { data: 'private-provider-token' });
  assert.equal(providerCalls, 1);
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from 'redis';
import { redisImage, renderRedis } from './runtime.mjs';

/**
 * Renders the real ACL configuration and proves the rights against Redis.
 * The design section 8.3 P1 test: the worker cannot write the hold key, the
 * worker can publish job events, and the API can publish and increment.
 */
const name = `ccp1-acl-${randomBytes(6).toString('hex')}`;
const directory = mkdtempSync(join(tmpdir(), 'ccp1-acl-'));
const password = randomBytes(32).toString('hex');
const config = JSON.parse(
  readFileSync('deployment/examples/all-docker.json', 'utf8'),
);
const run = (...args) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

async function connect(user) {
  const client = createClient({
    url: `redis://${user}:${password}@127.0.0.1:${run('port', name, '6379/tcp').split(':').at(-1)}`,
  });
  client.on('error', () => undefined);
  await client.connect();
  return client;
}

test('the worker publishes job events but cannot write the hold key', async () => {
  let worker;
  let api;
  try {
    chmodSync(directory, 0o755);
    writeFileSync(
      join(directory, 'redis.conf'),
      renderRedis(config, Buffer.from(password)),
      { mode: 0o444 },
    );
    run(
      'run',
      '--detach',
      '--name',
      name,
      '-p',
      '127.0.0.1::6379',
      '--user',
      '999:999',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--tmpfs',
      '/data:uid=999,gid=999',
      '--mount',
      `type=bind,src=${directory},dst=/probe,readonly`,
      redisImage,
      'redis-server',
      '/probe/redis.conf',
    );
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const probe = await connect('default');
        await probe.ping();
        await probe.quit();
        ready = true;
        break;
      } catch {
        await delay(100);
      }
    }
    assert.equal(ready, true, 'Redis did not start.');
    worker = await connect('worker');
    api = await connect('default');
    for (const command of [
      () => worker.set('cc:job-hold:C0123456:device-update', 'job'),
      () => worker.del('cc:job-hold:C0123456:device-update'),
    ])
      await assert.rejects(command, /NOPERM/);
    await assert.rejects(
      () => worker.publish('cc:job-hold:C0123456', 'synthetic'),
      /NOPERM/,
    );
    assert.equal(
      await worker.publish('cc:entity-events:C0123456', 'synthetic'),
      0,
    );
    assert.equal(
      await worker
        .publish('cc:job-events:C0123456', 'synthetic')
        .catch((error) => error.message),
      0,
      'The worker publishes job events.',
    );
    assert.equal(await worker.incr('cc:query-gen:device:C0123456'), 1);
    assert.equal(
      await api
        .publish('cc:job-events:C0123456', 'synthetic')
        .catch((error) => error.message),
      0,
      'The API publishes job events.',
    );
    assert.equal(
      await api
        .incr('cc:query-gen:device:C0123456')
        .catch((error) => error.message),
      2,
      'The API increments the query generation.',
    );
    assert.equal(
      await api.set('cc:job-hold:C0123456:device-update', 'job', 'EX', 300),
      'OK',
    );
    process.stdout.write(
      `${JSON.stringify({
        scenario: 'redis-acl',
        workerHoldDenied: true,
        workerJobEventPublish: true,
        apiPublishAndIncrement: true,
      })}\n`,
    );
  } finally {
    await Promise.allSettled([worker?.quit(), api?.quit()]);
    try {
      run('rm', '-f', '--volumes', name);
    } catch {
      /* The fixture did not start. */
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

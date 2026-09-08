import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redisImage, renderRedis } from './runtime.mjs';

const name = `cc8-probe-${randomBytes(6).toString('hex')}`;
const directory = mkdtempSync(join(tmpdir(), 'cc8-'));
const config = JSON.parse(
  readFileSync('deployment/examples/all-docker.json', 'utf8'),
);
const password = randomBytes(32).toString('hex');
const run = (...args) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
const cli = (...args) =>
  run(
    'exec',
    name,
    'sh',
    '-c',
    'export REDISCLI_AUTH="$(cat /probe/password)"; exec redis-cli "$@"',
    'probe',
    ...args,
  );
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function ready() {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      if (cli('PING') === 'PONG') return;
    } catch {
      /* Retry bounded startup. */
    }
    await sleep(100);
  }
  throw new Error('Redis startup timed out.');
}

try {
  chmodSync(directory, 0o755);
  writeFileSync(
    join(directory, 'redis.conf'),
    renderRedis(config, Buffer.from(password)),
    { mode: 0o444 },
  );
  writeFileSync(join(directory, 'password'), password, { mode: 0o444 });
  run(
    'run',
    '--detach',
    '--name',
    name,
    '--network',
    'none',
    '--user',
    '999:999',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--memory',
    '512m',
    '--mount',
    `type=bind,src=${directory},dst=/probe,readonly`,
    '--tmpfs',
    '/data:uid=999,gid=999',
    redisImage,
    'redis-server',
    '/probe/redis.conf',
  );
  await ready();
  assert.match(run('exec', name, 'redis-cli', 'PING'), /NOAUTH/);
  assert.equal(
    cli('SET', 'cc:qualification:fixture', 'synthetic', 'EX', '300'),
    'OK',
  );
  assert.equal(cli('GET', 'cc:qualification:fixture'), 'synthetic');
  assert.match(cli('SET', 'outside:fixture', 'synthetic'), /NOPERM/);
  assert.match(cli('CONFIG', 'GET', '*'), /NOPERM/);
  assert.equal(run('port', name), '');
  run('restart', name);
  await ready();
  assert.equal(cli('GET', 'cc:qualification:fixture'), '');
  process.stdout.write(
    JSON.stringify({
      image: redisImage,
      authentication: 'passed',
      namespaceIsolation: 'passed',
      administrativeDenial: 'passed',
      publishedPorts: 'none',
      restartPolicy: 'discard-cache',
      restartFixtureAbsent: true,
    }) + '\n',
  );
} catch {
  process.stderr.write(
    'Redis qualification failed. Inspect the isolated fixture without exposing credential files.\n',
  );
  process.exitCode = 1;
} finally {
  try {
    run('rm', '--force', name);
  } catch {
    /* The fixture did not start. */
  }
  rmSync(directory, { recursive: true, force: true });
}

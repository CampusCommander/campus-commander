// Run inside a disposable installed container to verify nested Docker and restart durability.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import https from 'node:https';
import { join, resolve } from 'node:path';
import { probeApi } from './hybrid-lifecycle-probes.mjs';

const root = resolve(process.argv[2]);
const seed = process.argv[3] === 'seed';
assert.ok(['seed', 'verify'].includes(process.argv[3]));
const operator = JSON.parse(await readFile(join(root, 'operator.json')));
const setup = JSON.parse(await readFile(join(root, 'setup-record.json')));
assert.equal(
  setup.qualification,
  true,
  'Use a disposable candidate installation.',
);
assert.equal(operator.installationRoot, root);
const configuration = await readFile(operator.configurationPath);
const config = JSON.parse(configuration);
assert.equal(config.profile, 'all-docker');
const docker = (args, input) =>
  execFileSync('docker', args, {
    input,
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 1024 * 1024,
  }).trim();
const limits = JSON.parse(
  docker([
    'run',
    '--rm',
    '--network=none',
    '--read-only',
    '--cap-drop=ALL',
    '--memory=128m',
    '--cpus=0.25',
    '--pids-limit=32',
    '--entrypoint=node',
    config.images.api,
    '-e',
    'const fs=require("node:fs");console.log(JSON.stringify(Object.fromEntries(["memory.max","cpu.max","pids.max"].map(n=>[n,fs.readFileSync("/sys/fs/cgroup/"+n,"utf8").trim()]))));',
  ]),
);
assert.equal(limits['memory.max'], '134217728');
assert.equal(limits['cpu.max'], '25000 100000');
assert.equal(limits['pids.max'], '32');

const token = (await readFile(join(root, 'private/bootstrap'), 'utf8')).trim();
const ca = await readFile(join(root, 'private/edge-certificate'));
const request = (path, authenticated = false) =>
  new Promise((done, reject) => {
    const req = https.get(
      new URL(path, config.services.edge.endpoint.url),
      {
        ca,
        headers: authenticated
          ? {
              authorization: `Basic ${Buffer.from(`operator:${token}`).toString('base64')}`,
            }
          : {},
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => done({ status: response.statusCode, body }));
      },
    );
    req.setTimeout(10000, () =>
      req.destroy(new Error('HTTPS probe timed out.')),
    );
    req.on('error', reject);
  });
assert.equal((await request('/')).status, 401);
assert.equal((await request('/', true)).status, 200);
const startup = await request('/api/startup', true);
assert.equal(startup.status, 200);
const readiness = JSON.parse(startup.body);
assert.equal(readiness.status, 'ready');
assert.equal(readiness.checks.length, 8);
assert.ok(readiness.checks.every((check) => check.status === 'ready'));
for (const path of ['/kestra', '/workers', '/api/jobs'])
  assert.equal((await request(path, true)).status, 404);

const api = docker([
  'compose',
  '-f',
  join(root, 'docker-compose.json'),
  '-p',
  operator.project,
  'ps',
  '-q',
  'api',
]);
const durable = JSON.parse(
  docker(
    ['exec', '-i', api, 'node', '--input-type=module'],
    `const probe=${probeApi.toString()};console.log(JSON.stringify(await probe(${seed})));`,
  ),
);
const baseline = join(root, 'container-validation-baseline.json');
const snapshot = {
  configurationSha256: createHash('sha256').update(configuration).digest('hex'),
  durable,
};
if (seed)
  await writeFile(baseline, JSON.stringify(snapshot), {
    mode: 0o600,
    flag: 'wx',
  });
else assert.deepEqual(snapshot, JSON.parse(await readFile(baseline)));
console.log(
  JSON.stringify(
    {
      status: 'passed',
      phase: seed ? 'initial' : 'after-restart',
      dockerVersion: docker(['version', '--format', '{{.Server.Version}}']),
      composeVersion: docker(['compose', 'version', '--short']),
      limits,
      readiness,
      configurationSha256: snapshot.configurationSha256,
      artifactSha256: durable.artifact.sha256,
      migrationRecords: durable.migrations.length,
      bootstrapRecords: durable.bootstrap.length,
      restartFixturePreserved: !seed,
    },
    null,
    2,
  ),
);

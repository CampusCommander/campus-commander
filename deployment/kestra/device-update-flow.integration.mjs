import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { kestraImage, postgresImage } from '../profiles/all-docker/render.mjs';

/**
 * Runs the device update flows on the pinned Kestra version against a stub
 * dispatch endpoint. The design section 8.3 P1 test. The run against the real
 * worker belongs to card P2.
 */
const flows = ['device-update.yaml', 'device-update-reconcile.yaml'];
const terminal = new Set([
  'SUCCESS',
  'WARNING',
  'FAILED',
  'KILLED',
  'CANCELLED',
]);
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const docker = (...args) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
const nodeImage = (
  await readFile('deployment/images/api.Dockerfile', 'utf8')
).match(/^FROM (node:\S+)/m)[1];

async function flowSource(name) {
  try {
    return await readFile(`deployment/kestra/${name}`, 'utf8');
  } catch {
    assert.fail(`deployment/kestra/${name} is missing.`);
  }
}

async function waitFor(readiness, label, attempts = 360, diagnostics) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const value = await readiness();
      if (value) return value;
    } catch {
      /* Retry bounded startup. */
    }
    await delay(500);
  }
  const detail = diagnostics ? `\n${diagnostics()}` : '';
  assert.fail(`${label} did not become ready.${detail}`);
}

let fixture = null;
after(async () => {
  await fixture?.stop();
});

async function startFixture(jobIds) {
  for (const image of [kestraImage, postgresImage, nodeImage]) {
    try {
      docker('image', 'inspect', image);
    } catch {
      assert.fail(`The required image is missing: ${image}`);
    }
  }
  const runId = `ccp1-${randomBytes(4).toString('hex')}`;
  const directory = await mkdtemp(join(tmpdir(), 'ccp1-device-update-'));
  const runtime = join(directory, 'kestra-runtime');
  const storage = join(directory, 'kestra-storage');
  await mkdir(runtime, { mode: 0o700 });
  await mkdir(storage, { mode: 0o700 });
  const network = `${runId}-network`;
  const postgres = `${runId}-postgres`;
  const kestra = `${runId}-kestra`;
  const stub = `${runId}-stub`;
  const names = [stub, kestra, postgres];
  const danglingBefore = docker('volume', 'ls', '-q', '-f', 'dangling=true')
    .split('\n')
    .filter(Boolean).length;
  const dispatchSecret = randomBytes(24).toString('base64url');
  const databasePassword = randomBytes(24).toString('hex');
  const auth = {
    username: 'p1-device-update@example.invalid',
    password: `A1${randomBytes(12).toString('base64url')}`,
  };
  const authorization = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`;
  await writeFile(join(directory, 'auth.json'), JSON.stringify(auth), {
    mode: 0o600,
  });
  await writeFile(join(directory, 'database-password'), databasePassword, {
    mode: 0o600,
  });
  await writeFile(join(directory, 'dispatch-secret'), dispatchSecret, {
    mode: 0o600,
  });
  let origin;
  let stubOrigin;
  const stop = async () => {
    for (const name of names) {
      try {
        // A declared volume leaves an anonymous volume without --volumes.
        docker('rm', '-f', '--volumes', name);
      } catch {
        /* The container did not start. */
      }
    }
    try {
      docker('network', 'rm', network);
    } catch {
      /* The network was not created. */
    }
    await rm(directory, { recursive: true, force: true });
  };
  try {
    docker('network', 'create', network);
    docker(
      'run',
      '-d',
      '--name',
      postgres,
      '--network',
      network,
      '-e',
      'POSTGRES_DB=kestra',
      '-e',
      'POSTGRES_USER=kestra',
      '-e',
      `POSTGRES_PASSWORD=${databasePassword}`,
      postgresImage,
    );
    await waitFor(
      () => {
        docker('exec', postgres, 'pg_isready', '-U', 'kestra', '-d', 'kestra');
        return true;
      },
      'PostgreSQL',
      120,
    );
    execFileSync(process.execPath, ['deployment/kestra/render-config.mjs'], {
      stdio: 'pipe',
      env: {
        ...process.env,
        CC_KESTRA_PROFILE: 'all-docker',
        CC_KESTRA_RUNTIME_DIR: runtime,
        CC_KESTRA_RUNTIME_MOUNT_PATH: runtime,
        CC_KESTRA_AUTH_FILE: join(directory, 'auth.json'),
        CC_KESTRA_DATABASE_PASSWORD_FILE: join(directory, 'database-password'),
        CC_KESTRA_DATABASE_URL: `jdbc:postgresql://${postgres}:5432/kestra`,
        CC_KESTRA_DATABASE_USERNAME: 'kestra',
        CC_KESTRA_URL: 'http://kestra:8080',
        CC_KESTRA_WORKER_BASE_URL: 'http://stub:9000',
        CC_KESTRA_WORKER_DISPATCH_SECRET_FILE: join(
          directory,
          'dispatch-secret',
        ),
      },
    });
    const environment = JSON.parse(
      await readFile(join(runtime, 'runtime-environment.json'), 'utf8'),
    );
    await writeFile(
      join(directory, 'kestra.env'),
      Object.entries(environment)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n'),
      { mode: 0o600 },
    );
    await writeFile(join(directory, 'requests.jsonl'), '', { mode: 0o666 });
    await copyFile(
      'deployment/kestra/stub-dispatch.mjs',
      join(directory, 'stub-dispatch.mjs'),
    );
    docker(
      'run',
      '-d',
      '--name',
      stub,
      '--network',
      network,
      '--network-alias',
      'stub',
      '-p',
      '127.0.0.1::9000',
      '-v',
      `${directory}:/stub`,
      '-e',
      'STUB_LOG=/stub/requests.jsonl',
      '-e',
      `STUB_FAIL_JOB=${jobIds.fail}`,
      nodeImage,
      'node',
      '/stub/stub-dispatch.mjs',
    );
    stubOrigin = `http://127.0.0.1:${Number(docker('port', stub, '9000/tcp').split(':').at(-1))}`;
    await waitFor(async () => {
      const response = await fetch(`${stubOrigin}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      return response.ok;
    }, 'The dispatch stub');
    docker(
      'run',
      '-d',
      '--name',
      kestra,
      '--network',
      network,
      '--user',
      `${process.getuid()}:${process.getgid()}`,
      '-p',
      '127.0.0.1::8080',
      '--env-file',
      join(directory, 'kestra.env'),
      '-v',
      `${runtime}:${runtime}:ro`,
      '-v',
      `${storage}:/app/storage`,
      kestraImage,
      'server',
      'standalone',
      '--config',
      join(runtime, 'application.yaml'),
    );
    origin = `http://127.0.0.1:${Number(docker('port', kestra, '8080/tcp').split(':').at(-1))}`;
    await waitFor(
      async () => {
        const response = await fetch(
          `${origin}/api/v1/main/flows/search?size=1`,
          {
            headers: { authorization },
            signal: AbortSignal.timeout(2000),
          },
        );
        return response.ok;
      },
      'Kestra',
      360,
      () =>
        docker(
          'ps',
          '-a',
          '--filter',
          `name=${kestra}`,
          '--format',
          '{{.Status}}',
        ) +
        '\n' +
        docker('logs', kestra, '--tail', '120'),
    );
    const live = { origin, authorization, directory, network, names };
    return {
      ...live,
      failJob: jobIds.fail,
      stubName: stub,
      stop,
      async upload(name) {
        const response = await fetch(`${origin}/api/v1/main/flows`, {
          method: 'POST',
          headers: {
            authorization,
            'content-type': 'application/x-yaml',
          },
          body: await flowSource(name),
        });
        assert.equal(response.status, 200, `Upload ${name}`);
      },
      async start(flowId, inputs) {
        const form = new FormData();
        for (const [key, value] of Object.entries(inputs))
          form.set(key, String(value));
        const response = await fetch(
          `${origin}/api/v1/main/executions/campus.application/${flowId}`,
          { method: 'POST', headers: { authorization }, body: form },
        );
        assert.equal(response.status, 200, `Start ${flowId}`);
        return (await response.json()).id;
      },
      async execution(executionId) {
        const response = await fetch(
          `${origin}/api/v1/main/executions/${executionId}`,
          { headers: { authorization }, signal: AbortSignal.timeout(5000) },
        );
        return response.json();
      },
      async records() {
        const text = await readFile(join(directory, 'requests.jsonl'), 'utf8');
        return text
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .filter((record) => record.path !== '/health');
      },
      async waitForState(executionId, expected) {
        const accepted = [expected].flat();
        let state = '';
        for (let attempt = 0; attempt < 360; attempt += 1) {
          try {
            state = (await this.execution(executionId)).state.current;
          } catch {
            /* Retry while the execution record settles. */
          }
          if (terminal.has(state)) break;
          await delay(500);
        }
        if (!accepted.includes(state)) {
          const detail = await readFile(
            join(directory, 'requests.jsonl'),
            'utf8',
          );
          assert.fail(
            `Execution ${executionId} ended ${state}.\n${JSON.stringify(
              await this.execution(executionId),
              null,
              2,
            )}\n${detail}\n${docker('logs', stub, '--tail', '40')}`,
          );
        }
        return this.execution(executionId);
      },
      async danglingVolumes() {
        return docker('volume', 'ls', '-q', '-f', 'dangling=true')
          .split('\n')
          .filter(Boolean).length;
      },
      danglingBefore,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

test('Kestra runs device_update one batch at a time with the section 5.1 retry', async () => {
  for (const name of flows) await flowSource(name);
  const jobId = randomUUID();
  const failJob = randomUUID();
  fixture = await startFixture({ fail: failJob });
  for (const name of flows) await fixture.upload(name);
  const executionId = await fixture.start('device_update', {
    customerId: 'C01zcarnq',
    jobId,
    dispatchToken: randomUUID(),
    batches: JSON.stringify([0, 1, 2]),
    correlationId: randomUUID(),
  });
  await fixture.waitForState(executionId, 'SUCCESS');
  const records = await fixture.records();
  const batches = records.filter(
    (record) => record.path === '/dispatch/device-update-batch',
  );
  // Batch 0 answers 503 once, batch 1 closes the connection once, and batch 2
  // answers 200 on its first attempt. No retry follows a 200 answer.
  assert.deepEqual(
    batches.map((record) => [Number(record.body.batch), record.status]),
    [
      [0, 503],
      [0, 200],
      [1, 0],
      [1, 200],
      [2, 200],
    ],
  );
  for (let index = 1; index < batches.length; index += 1)
    assert.ok(
      batches[index].startedAt >= batches[index - 1].endedAt,
      `Request ${index} overlapped its predecessor.`,
    );
  const finishes = records.filter(
    (record) => record.path === '/dispatch/device-update-finish',
  );
  assert.equal(finishes.length, 1);
  assert.equal(finishes[0].body.jobId, jobId);
  assert.equal(finishes[0].body.customerId, 'C01zcarnq');
  assert.ok(finishes[0].body.dispatchToken);
  assert.ok(finishes[0].body.correlationId);
  process.stdout.write(
    `${JSON.stringify({
      scenario: 'device_update',
      executionId,
      batchRequests: batches.length,
      danglingVolumesAfter: await fixture.danglingVolumes(),
      danglingVolumesBefore: fixture.danglingBefore,
    })}\n`,
  );
});

test('the errors tasks post the finish after a batch fails its retries', async () => {
  assert.ok(fixture, 'The Kestra fixture did not start.');
  const jobId = randomUUID();
  const failJob = fixture.failJob;
  assert.ok(failJob);
  const recordsBefore = (await fixture.records()).length;
  const executionId = await fixture.start('device_update', {
    customerId: 'C01zcarnq',
    jobId: failJob,
    dispatchToken: randomUUID(),
    batches: JSON.stringify([0]),
    correlationId: randomUUID(),
  });
  await fixture.waitForState(executionId, ['FAILED', 'WARNING']);
  const records = (await fixture.records()).slice(recordsBefore);
  const batches = records.filter(
    (record) => record.path === '/dispatch/device-update-batch',
  );
  assert.ok(
    batches.length >= 2,
    `The batch request retried.\n${JSON.stringify(records, null, 2)}`,
  );
  assert.deepEqual(
    batches.map((record) => record.status),
    batches.map(() => 503),
  );
  const finishes = records.filter(
    (record) => record.path === '/dispatch/device-update-finish',
  );
  assert.equal(finishes.length, 1, 'The errors task posted the finish.');
  assert.equal(finishes[0].body.jobId, failJob);
  process.stdout.write(
    `${JSON.stringify({
      scenario: 'device_update_errors',
      executionId,
      batchAttempts: batches.length,
      finishRequests: finishes.length,
    })}\n`,
  );
});

test('the reconcile flow posts one request with its inputs', async () => {
  assert.ok(fixture, 'The Kestra fixture did not start.');
  const jobId = randomUUID();
  const verifyAttempt = randomUUID();
  const recordsBefore = (await fixture.records()).length;
  const executionId = await fixture.start('device_update_reconcile', {
    customerId: 'C01zcarnq',
    jobId,
    operationNumber: '3',
    verifyAttempt,
    correlationId: randomUUID(),
  });
  await fixture.waitForState(executionId, 'SUCCESS');
  let records = (await fixture.records()).slice(recordsBefore);
  let reconciles = records.filter(
    (record) => record.path === '/dispatch/device-update-reconcile',
  );
  assert.equal(reconciles.length, 1);
  assert.equal(reconciles[0].body.operationNumber, '3');
  assert.equal(reconciles[0].body.verifyAttempt, verifyAttempt);
  assert.equal(reconciles[0].body.jobId, jobId);

  const allJobId = randomUUID();
  const allBefore = (await fixture.records()).length;
  const allExecution = await fixture.start('device_update_reconcile', {
    customerId: 'C01zcarnq',
    jobId: allJobId,
    operationNumber: 'all',
    correlationId: randomUUID(),
  });
  await fixture.waitForState(allExecution, 'SUCCESS');
  records = (await fixture.records()).slice(allBefore);
  reconciles = records.filter(
    (record) => record.path === '/dispatch/device-update-reconcile',
  );
  assert.equal(reconciles.length, 1);
  assert.equal(reconciles[0].body.operationNumber, 'all');
  assert.equal('verifyAttempt' in reconciles[0].body, false);
  process.stdout.write(
    `${JSON.stringify({
      scenario: 'device_update_reconcile',
      executionId,
      allExecution,
      reconcileRequests: 2,
    })}\n`,
  );
});

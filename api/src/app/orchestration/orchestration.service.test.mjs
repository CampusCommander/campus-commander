import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import esbuild from 'esbuild';

/**
 * The API runtime reads its flows from `deployment/kestra` under the process
 * working directory. This suite builds the final image layout from the
 * checked-in COPY instructions and exercises both write-job starters against
 * it (review R1-F1). It also pins the design's valid write-job batch counts
 * (review R1-F2).
 */
const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const identity = {
  customerId: 'C01zcarnq',
  jobId: '11111111-1111-4111-8111-111111111111',
  dispatchToken: '22222222-2222-4222-8222-222222222222',
  correlationId: '33333333-3333-4333-8333-333333333333',
};
const layouts = [];
let bundleDirectory;
let serviceBundle;

async function packagedLayout() {
  const dockerfile = await readFile(
    join(repo, 'deployment/images/api.Dockerfile'),
    'utf8',
  );
  // The final image is the last build stage.
  const stage = dockerfile.slice(dockerfile.lastIndexOf('\nFROM '));
  const layout = await mkdtemp(join(tmpdir(), 'cc-api-package-'));
  layouts.push(layout);
  let copied = 0;
  for (const line of stage.split('\n')) {
    if (!line.startsWith('COPY ')) continue;
    const tokens = line
      .split(/\s+/)
      .slice(1)
      .filter((token) => !token.startsWith('--'));
    const destination = tokens.pop();
    assert.ok(destination, `The Dockerfile COPY has a destination: ${line}`);
    for (const source of tokens) {
      if (!source.startsWith('/workspace/deployment/')) continue;
      const relative = source.slice('/workspace/'.length);
      const target = destination.endsWith('/')
        ? join(destination, basename(relative))
        : destination;
      await mkdir(dirname(join(layout, target)), { recursive: true });
      await cp(join(repo, relative), join(layout, target), {
        recursive: true,
      });
      copied += 1;
    }
  }
  assert.ok(copied > 0, 'The final stage copies deployment files.');
  return layout;
}

/** Records every request and answers like Kestra does. */
async function kestraStub() {
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const entry = {
        method: request.method,
        url: request.url,
        contentType: request.headers['content-type'],
        body,
      };
      requests.push(entry);
      if (request.method === 'GET') {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end('{}');
        return;
      }
      if (request.url === '/api/v1/main/flows') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{}');
        return;
      }
      if (request.url?.startsWith('/api/v1/main/executions/')) {
        entry.executionId = `execution-${requests.length}`;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id: entry.executionId }));
        return;
      }
      response.writeHead(500);
      response.end();
    });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((done) => server.close(done)),
  };
}

async function starter(stub) {
  const module = await import(serviceBundle);
  return new module.OrchestrationService({
    deployment: {
      services: {
        kestra: {
          endpoint: { url: stub.url, tls: { mode: 'disabled' } },
        },
      },
    },
    secret: () =>
      Buffer.from(JSON.stringify({ username: 'api', password: 'secret' })),
  });
}

/** Read one multipart form field from the recorded request body. */
function field(body, name) {
  const match = body.match(new RegExp(`name="${name}"\r\n\r\n([^\r\n]*)`));
  assert.ok(match, `The request carries the ${name} field.`);
  return match[1];
}

function executionRequests(requests) {
  return requests.filter((request) =>
    request.url?.startsWith('/api/v1/main/executions/'),
  );
}

before(async () => {
  bundleDirectory = join(
    repo,
    'node_modules/.cache',
    `cc-orchestration-test-${process.pid}-${randomUUID()}`,
  );
  await mkdir(bundleDirectory, { recursive: true });
  serviceBundle = join(bundleDirectory, 'orchestration.service.mjs');
  await esbuild.build({
    entryPoints: [
      join(repo, 'api/src/app/orchestration/orchestration.service.ts'),
    ],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: serviceBundle,
    packages: 'external',
    tsconfigRaw: {
      compilerOptions: { experimentalDecorators: true, target: 'es2022' },
    },
    logLevel: 'silent',
  });
});

after(async () => {
  for (const layout of layouts)
    await rm(layout, { recursive: true, force: true });
  await rm(bundleDirectory, { recursive: true, force: true });
});

/** Read one packaged file, and fail at an assertion when it is absent. */
async function packaged(layout, relative) {
  try {
    return await readFile(join(layout, relative), 'utf8');
  } catch (error) {
    assert.fail(`The API image does not package ${relative}: ${error.message}`);
  }
}

test('the API image packages both device update flows', async () => {
  const layout = await packagedLayout();
  // The parser must see the kestra COPY line, so a missing match fails here.
  await packaged(layout, 'deployment/kestra/entity-sync.yaml');
  await packaged(layout, 'deployment/kestra/device-update.yaml');
  await packaged(layout, 'deployment/kestra/device-update-reconcile.yaml');
});

test('startDeviceUpdate deploys and starts the packaged device_update flow', async () => {
  const layout = await packagedLayout();
  const stub = await kestraStub();
  try {
    const orchestration = await starter(stub);
    process.chdir(layout);
    let executionId;
    try {
      executionId = await orchestration.startDeviceUpdate({
        ...identity,
        batchCount: 3,
      });
    } catch (error) {
      assert.fail(`startDeviceUpdate failed: ${error.message}`);
    }
    const flow = stub.requests.find(
      (request) =>
        request.method === 'POST' && request.url === '/api/v1/main/flows',
    );
    assert.ok(flow, 'The starter deployed the flow.');
    assert.match(flow.body, /^id: device_update$/m);
    const [execution] = executionRequests(stub.requests);
    assert.ok(execution, 'The starter started an execution.');
    assert.equal(
      execution.url,
      '/api/v1/main/executions/campus.application/device_update',
    );
    assert.equal(
      execution.contentType?.startsWith('multipart/form-data'),
      true,
    );
    assert.equal(field(execution.body, 'customerId'), identity.customerId);
    assert.equal(field(execution.body, 'jobId'), identity.jobId);
    assert.equal(
      field(execution.body, 'dispatchToken'),
      identity.dispatchToken,
    );
    assert.equal(
      field(execution.body, 'correlationId'),
      identity.correlationId,
    );
    assert.deepEqual(JSON.parse(field(execution.body, 'batches')), [0, 1, 2]);
    assert.equal(executionId, execution.executionId);
  } finally {
    process.chdir(repo);
    await stub.close();
  }
});

test('startDeviceUpdateReconcile deploys and starts the packaged reconcile flow', async () => {
  const layout = await packagedLayout();
  const stub = await kestraStub();
  try {
    const orchestration = await starter(stub);
    const verifyAttempt = randomUUID();
    process.chdir(layout);
    let executionId;
    try {
      executionId = await orchestration.startDeviceUpdateReconcile({
        customerId: identity.customerId,
        jobId: identity.jobId,
        operationNumber: 3,
        verifyAttempt,
        correlationId: identity.correlationId,
      });
    } catch (error) {
      assert.fail(`startDeviceUpdateReconcile failed: ${error.message}`);
    }
    const flow = stub.requests.find(
      (request) =>
        request.method === 'POST' && request.url === '/api/v1/main/flows',
    );
    assert.ok(flow, 'The starter deployed the flow.');
    assert.match(flow.body, /^id: device_update_reconcile$/m);
    const [execution] = executionRequests(stub.requests);
    assert.ok(execution, 'The starter started an execution.');
    assert.equal(
      execution.url,
      '/api/v1/main/executions/campus.application/device_update_reconcile',
    );
    assert.equal(field(execution.body, 'customerId'), identity.customerId);
    assert.equal(field(execution.body, 'jobId'), identity.jobId);
    assert.equal(field(execution.body, 'operationNumber'), '3');
    assert.equal(field(execution.body, 'verifyAttempt'), verifyAttempt);
    assert.equal(
      field(execution.body, 'correlationId'),
      identity.correlationId,
    );
    assert.equal(executionId, execution.executionId);
  } finally {
    process.chdir(repo);
    await stub.close();
  }
});

test('startDeviceUpdate accepts a valid job above 1,000 batches', async () => {
  const layout = await packagedLayout();
  const stub = await kestraStub();
  try {
    const orchestration = await starter(stub);
    process.chdir(layout);
    for (const batchCount of [1_001, 2_000]) {
      try {
        await orchestration.startDeviceUpdate({ ...identity, batchCount });
      } catch (error) {
        assert.fail(
          `startDeviceUpdate rejected ${batchCount} batches: ${error.message}`,
        );
      }
      const execution = executionRequests(stub.requests).at(-1);
      const batches = JSON.parse(field(execution.body, 'batches'));
      assert.equal(batches.length, batchCount, `${batchCount} batch indexes`);
      assert.equal(batches.at(-1), batchCount - 1);
    }
  } finally {
    process.chdir(repo);
    await stub.close();
  }
});

test('startDeviceUpdate accepts the maximum valid write-job batch count', async () => {
  const layout = await packagedLayout();
  const stub = await kestraStub();
  try {
    const orchestration = await starter(stub);
    const batchCount = 100_000;
    process.chdir(layout);
    try {
      await orchestration.startDeviceUpdate({ ...identity, batchCount });
    } catch (error) {
      assert.fail(
        `startDeviceUpdate rejected ${batchCount} batches: ${error.message}`,
      );
    }
    const execution = executionRequests(stub.requests).at(-1);
    const batches = JSON.parse(field(execution.body, 'batches'));
    assert.equal(batches.length, batchCount);
    assert.equal(batches.at(-1), batchCount - 1);
  } finally {
    process.chdir(repo);
    await stub.close();
  }
});

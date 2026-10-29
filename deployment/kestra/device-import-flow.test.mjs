import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parse } from 'yaml';

/** The inputs of the validation flow, in contract order (design section 6). */
const deviceImportInputs = ['customerId', 'jobId', 'leaseId', 'correlationId'];
/** The retry of deployment/kestra/device-update.yaml. */
const dispatchRetry = {
  type: 'constant',
  interval: 'PT5S',
  maxAttempts: 3,
  warningOnRetry: false,
};

async function flow(name) {
  let source;
  try {
    source = await readFile(new URL(name, import.meta.url), 'utf8');
  } catch {
    assert.fail(`deployment/kestra/${name} is missing.`);
  }
  try {
    return parse(source);
  } catch (error) {
    assert.fail(
      `deployment/kestra/${name} is not valid YAML: ${error.message}`,
    );
  }
}

test('device_import runs two jobs at a time and queues the rest', async () => {
  const flowDefinition = await flow('device-import.yaml');
  assert.equal(flowDefinition.id, 'device_import');
  assert.equal(flowDefinition.namespace, 'campus.application');
  assert.deepEqual(
    flowDefinition.inputs.map((input) => input.id),
    deviceImportInputs,
  );
  // The queue of the export flow (design section 6, which follows section 5).
  assert.deepEqual(flowDefinition.concurrency, {
    limit: 2,
    behavior: 'QUEUE',
  });
});

test('device_import posts one worker request that runs the whole job', async () => {
  const flowDefinition = await flow('device-import.yaml');
  assert.equal(flowDefinition.tasks.length, 1);
  const [dispatch] = flowDefinition.tasks;
  assert.equal(dispatch.type, 'io.kestra.plugin.core.http.Request');
  assert.equal(dispatch.method, 'POST');
  assert.equal(dispatch.contentType, 'application/json');
  assert.match(dispatch.uri, /\/dispatch\/device-import$/);
  assert.deepEqual(dispatch.retry, dispatchRetry);
  for (const field of [
    'executionId',
    'customerId',
    'jobId',
    'leaseId',
    'correlationId',
  ])
    assert.match(dispatch.body, new RegExp(`"${field}"`), field);
  assert.match(dispatch.body, /execution\.id/);
  assert.match(dispatch.body, /inputs\.leaseId/);
  // A run request carries no failure, so the claim runs the two passes.
  assert.doesNotMatch(dispatch.body, /"failure"/);
});

test('device_import fails a lost run with interrupted', async () => {
  const flowDefinition = await flow('device-import.yaml');
  assert.equal(Array.isArray(flowDefinition.errors), true);
  assert.equal(flowDefinition.errors.length, 1);
  const [failure] = flowDefinition.errors;
  assert.equal(failure.type, 'io.kestra.plugin.core.http.Request');
  assert.equal(failure.method, 'POST');
  assert.match(failure.uri, /\/dispatch\/device-import$/);
  assert.match(failure.body, /"failure"\s*:\s*"interrupted"/);
  assert.deepEqual(failure.retry, dispatchRetry);
  for (const field of ['executionId', 'customerId', 'jobId', 'leaseId'])
    assert.match(failure.body, new RegExp(`"${field}"`), field);
});

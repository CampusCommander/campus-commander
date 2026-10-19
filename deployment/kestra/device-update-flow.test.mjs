import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parse } from 'yaml';

/** The design section 5.1 inputs, in contract order. */
const deviceUpdateInputs = [
  'customerId',
  'jobId',
  'dispatchToken',
  'batches',
  'correlationId',
];
const reconcileInputs = [
  'customerId',
  'jobId',
  'operationNumber',
  'verifyAttempt',
  'correlationId',
];
/** The retry of deployment/kestra/entity-sync.yaml. */
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

test('device_update has the section 5.1 inputs and no flow concurrency limit', async () => {
  const flowDefinition = await flow('device-update.yaml');
  assert.equal(flowDefinition.id, 'device_update');
  assert.equal(flowDefinition.namespace, 'campus.application');
  assert.deepEqual(
    flowDefinition.inputs.map((input) => input.id),
    deviceUpdateInputs,
  );
  // The job service admits one write job. A flow-level queue would hold a
  // superseded execution ahead of the current one (design section 5.3).
  assert.equal(flowDefinition.concurrency, undefined);
});

test('device_update posts one batch at a time to the dispatch endpoint', async () => {
  const flowDefinition = await flow('device-update.yaml');
  const batches = flowDefinition.tasks.find((task) => task.id === 'batches');
  assert.equal(batches.type, 'io.kestra.plugin.core.flow.ForEach');
  assert.equal(batches.values, '{{ inputs.batches }}');
  assert.equal(batches.concurrencyLimit, 1);
  assert.equal(batches.tasks.length, 1);
  const dispatch = batches.tasks[0];
  assert.equal(dispatch.type, 'io.kestra.plugin.core.http.Request');
  assert.equal(dispatch.method, 'POST');
  assert.match(dispatch.uri, /\/dispatch\/device-update-batch$/);
  assert.deepEqual(dispatch.retry, dispatchRetry);
  for (const field of [
    'executionId',
    'customerId',
    'jobId',
    'dispatchToken',
    'batch',
    'correlationId',
  ])
    assert.match(dispatch.body, new RegExp(`"${field}"`), field);
  assert.match(dispatch.body, /taskrun\.value/);
});

test('device_update finishes once after the batches and on flow failure', async () => {
  const flowDefinition = await flow('device-update.yaml');
  const finish = flowDefinition.tasks.find((task) => task.id === 'finish');
  assert.equal(finish.type, 'io.kestra.plugin.core.http.Request');
  assert.match(finish.uri, /\/dispatch\/device-update-finish$/);
  for (const field of [
    'executionId',
    'customerId',
    'jobId',
    'dispatchToken',
    'correlationId',
  ])
    assert.match(finish.body, new RegExp(`"${field}"`), field);
  assert.equal(Array.isArray(flowDefinition.errors), true);
  assert.ok(flowDefinition.errors.length >= 1);
  for (const task of flowDefinition.errors) {
    assert.equal(task.type, 'io.kestra.plugin.core.http.Request');
    assert.match(task.uri, /\/dispatch\/device-update-finish$/);
    assert.equal(task.method, 'POST');
  }
  assert.equal(
    flowDefinition.tasks.filter((task) => task.id === 'finish').length,
    1,
  );
});

test('device_update_reconcile has one task with the section 5.1 inputs', async () => {
  const flowDefinition = await flow('device-update-reconcile.yaml');
  assert.equal(flowDefinition.id, 'device_update_reconcile');
  assert.equal(flowDefinition.namespace, 'campus.application');
  assert.deepEqual(
    flowDefinition.inputs.map((input) => input.id),
    reconcileInputs,
  );
  // verifyAttempt accompanies one operation number only.
  assert.equal(
    flowDefinition.inputs.find((input) => input.id === 'verifyAttempt')
      .required,
    false,
  );
  assert.equal(flowDefinition.tasks.length, 1);
  const [dispatch] = flowDefinition.tasks;
  assert.equal(dispatch.type, 'io.kestra.plugin.core.http.Request');
  assert.equal(dispatch.method, 'POST');
  assert.match(dispatch.uri, /\/dispatch\/device-update-reconcile$/);
  for (const field of [
    'executionId',
    'customerId',
    'jobId',
    'operationNumber',
    'verifyAttempt',
    'correlationId',
  ])
    assert.match(dispatch.body, new RegExp(`"${field}"`), field);
});

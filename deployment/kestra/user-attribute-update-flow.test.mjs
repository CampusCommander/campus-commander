import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parse } from 'yaml';

/** The retry of the device dispatch: only a failed worker request repeats (design K24). */
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

test('user_attribute_update has the four identifiers and no flow concurrency limit', async () => {
  const flowDefinition = await flow('user-attribute-update.yaml');
  assert.equal(flowDefinition.id, 'user_attribute_update');
  assert.equal(flowDefinition.namespace, 'campus.application');
  assert.deepEqual(
    flowDefinition.inputs.map((input) => input.id),
    ['customerId', 'jobId', 'dispatchToken', 'correlationId'],
  );
  // The job service admits one write job, and a flow-level queue would hold a superseded
  // execution ahead of the current one.
  assert.equal(flowDefinition.concurrency, undefined);
});

test('user_attribute_update posts the one run and retries only a failed worker request', async () => {
  const flowDefinition = await flow('user-attribute-update.yaml');
  assert.equal(flowDefinition.tasks.length, 1);
  const [write] = flowDefinition.tasks;
  assert.equal(write.id, 'write');
  assert.equal(write.type, 'io.kestra.plugin.core.http.Request');
  assert.equal(write.method, 'POST');
  assert.match(write.uri, /\/dispatch\/user-attribute-update$/);
  assert.deepEqual(write.retry, dispatchRetry);
  for (const field of [
    'executionId',
    'customerId',
    'jobId',
    'dispatchToken',
    'correlationId',
  ])
    assert.match(write.body, new RegExp(`"${field}"`), field);
  // The flow holds no errors block. The job service recovery ends a lost run.
  assert.equal(flowDefinition.errors, undefined);
});

test('user_attribute_update_reconcile names the operation and the read-back attempt', async () => {
  const flowDefinition = await flow('user-attribute-update-reconcile.yaml');
  assert.equal(flowDefinition.id, 'user_attribute_update_reconcile');
  assert.equal(flowDefinition.namespace, 'campus.application');
  assert.deepEqual(
    flowDefinition.inputs.map((input) => input.id),
    [
      'customerId',
      'jobId',
      'operationNumber',
      'verifyAttempt',
      'correlationId',
    ],
  );
  // The route claims the read-back, so the attempt is optional and never minted here.
  assert.equal(
    flowDefinition.inputs.find((input) => input.id === 'verifyAttempt')
      .required,
    false,
  );
  assert.equal(flowDefinition.concurrency, undefined);
  assert.equal(flowDefinition.errors, undefined);
});

test('user_attribute_update_reconcile posts one masked read and leaves the retry to the person', async () => {
  const flowDefinition = await flow('user-attribute-update-reconcile.yaml');
  assert.equal(flowDefinition.tasks.length, 1);
  const [dispatch] = flowDefinition.tasks;
  assert.equal(dispatch.type, 'io.kestra.plugin.core.http.Request');
  assert.equal(dispatch.method, 'POST');
  assert.match(dispatch.uri, /\/dispatch\/user-attribute-reconcile$/);
  // The device reconcile holds no retry: a lost run keeps the operation Unknown, and the person
  // reads again after the claim lease expires.
  assert.equal(dispatch.retry, undefined);
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

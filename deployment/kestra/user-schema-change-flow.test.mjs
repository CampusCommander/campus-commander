import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parse } from 'yaml';

/** The retry of the device dispatch: only a failed worker request repeats (design K16). */
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

test('user_schema_change has the four identifiers and no flow concurrency limit', async () => {
  const flowDefinition = await flow('user-schema-change.yaml');
  assert.equal(flowDefinition.id, 'user_schema_change');
  assert.equal(flowDefinition.namespace, 'campus.application');
  assert.deepEqual(
    flowDefinition.inputs.map((input) => input.id),
    ['customerId', 'jobId', 'dispatchToken', 'correlationId'],
  );
  // The job service admits one write job, and a flow-level queue would hold a superseded
  // execution ahead of the current one.
  assert.equal(flowDefinition.concurrency, undefined);
});

test('user_schema_change posts the one call and retries only a failed worker request', async () => {
  const flowDefinition = await flow('user-schema-change.yaml');
  assert.equal(flowDefinition.tasks.length, 1);
  const [change] = flowDefinition.tasks;
  assert.equal(change.id, 'change');
  assert.equal(change.type, 'io.kestra.plugin.core.http.Request');
  assert.equal(change.method, 'POST');
  assert.match(change.uri, /\/dispatch\/user-schema-change$/);
  assert.deepEqual(change.retry, dispatchRetry);
  for (const field of [
    'executionId',
    'customerId',
    'jobId',
    'dispatchToken',
    'correlationId',
  ])
    assert.match(change.body, new RegExp(`"${field}"`), field);
  // The flow holds no errors block. The job service recovery ends a lost run.
  assert.equal(flowDefinition.errors, undefined);
});

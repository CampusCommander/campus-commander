import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parse } from 'yaml';

/** The inputs of the full user sync, in the order of deployment/kestra/device-sync.yaml. */
const userSyncInputs = ['customerId', 'syncId', 'correlationId'];

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

test('user_sync carries the three full-sync inputs', async () => {
  const flowDefinition = await flow('user-sync.yaml');
  assert.equal(flowDefinition.id, 'user_sync');
  assert.equal(flowDefinition.namespace, 'campus.application');
  assert.deepEqual(
    flowDefinition.inputs.map((input) => input.id),
    userSyncInputs,
  );
  assert.deepEqual(
    flowDefinition.inputs.map((input) => input.type),
    userSyncInputs.map(() => 'STRING'),
  );
});

test('user_sync posts one worker request for the whole sync', async () => {
  const flowDefinition = await flow('user-sync.yaml');
  assert.equal(flowDefinition.tasks.length, 1);
  const [dispatch] = flowDefinition.tasks;
  assert.equal(dispatch.id, 'dispatch');
  assert.equal(dispatch.type, 'io.kestra.plugin.core.http.Request');
  assert.equal(dispatch.method, 'POST');
  assert.equal(dispatch.contentType, 'application/json');
  assert.match(dispatch.uri, /\/dispatch\/user-sync$/);
  assert.equal(
    dispatch.headers.Authorization,
    "Bearer {{ secret('CC_WORKER_DISPATCH_TOKEN') }}",
  );
  for (const field of ['executionId', 'customerId', 'syncId', 'correlationId'])
    assert.match(dispatch.body, new RegExp(`"${field}"`), field);
  assert.match(dispatch.body, /execution\.id/);
  assert.match(dispatch.body, /inputs\.syncId/);
  assert.equal(dispatch.timeout, 'PT1H');
});

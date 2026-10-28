import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  handleDeviceSyncDispatch,
  handleEntitySyncDispatch,
} from './dispatch.ts';
import { DeviceSyncError } from './device-sync.ts';

const secret = 'fixture-dispatch-secret-000000000000';
const customerId = 'C0123456';

/** A dispatch request with one JSON body chunk. */
function request(url, body) {
  const text = JSON.stringify(body);
  return {
    method: 'POST',
    url,
    headers: {
      authorization: `Bearer ${secret}`,
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(text)),
    },
    resume() {
      /* The handler drains the body itself. */
    },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(text);
    },
  };
}

/** The status and body of one answered dispatch. */
function response() {
  const answer = {
    status: 0,
    body: '',
    headersSent: false,
    writeHead(status) {
      answer.status = status;
      answer.headersSent = true;
    },
    end(body) {
      answer.body = body;
    },
  };
  return answer;
}

const syncRequest = () => ({
  customerId,
  syncId: randomUUID(),
  correlationId: randomUUID(),
  executionId: 'execution-1',
});
const entityRequest = () => ({
  customerId,
  jobId: randomUUID(),
  batch: 0,
  correlationId: randomUUID(),
  executionId: 'execution-1',
});

/** The full sync and the selected-device batch both answer 409, as a purged refresh does. */
test('both refresh dispatches answer 409 when the cancel stopped the run', async () => {
  const context = { secret, signal: AbortSignal.timeout(5000) };
  for (const [handler, url, build, code] of [
    [
      handleDeviceSyncDispatch,
      '/dispatch/device-sync',
      syncRequest,
      'device-sync-changed',
    ],
    [
      handleEntitySyncDispatch,
      '/dispatch/entity-sync-batch',
      entityRequest,
      'entity-sync-changed',
    ],
    [
      handleEntitySyncDispatch,
      '/dispatch/entity-sync-batch',
      entityRequest,
      'worker-stopping',
    ],
  ]) {
    const answer = response();
    const handled = await handler(request(url, build()), answer, context, {
      syncDevices: async () => {
        throw new DeviceSyncError(code);
      },
      syncEntityBatch: async () => {
        throw new DeviceSyncError(code);
      },
    });
    assert.equal(handled, true);
    assert.equal(answer.status, 409);
    assert.deepEqual(JSON.parse(answer.body), { error: code });
  }
});

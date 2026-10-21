import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ConflictException,
  ForbiddenException,
  HttpException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DeviceDomainRefresh } from './device-domain-refresh.ts';

const customerId = 'C0123456';
const correlationId = '22222222-2222-4222-8222-222222222222';
const session = { identity: { id: 'a', permissionVersion: 1 } };
const current = {
  customerId,
  generation: 3,
  status: 'ready',
  observedAt: null,
  deviceCount: 12,
  failure: null,
  telemetryFailure: null,
  startedAt: null,
  checkedAt: null,
  stale: false,
};
const started = {
  ...current,
  status: 'running',
  startedAt: new Date().toISOString(),
};

const health = (failures = [null, null], history = []) => ({
  customerId,
  generation: current.generation,
  observedAt: '2026-10-20T12:00:00.000Z',
  backgroundFailure: null,
  check: null,
  capabilities: [
    {
      capability: 'customer-identity',
      scopeVerified: failures[0] === null,
      failure: failures[0],
      checkedAt: '2026-10-20T12:00:00.000Z',
      lastSucceededAt: null,
      correlationId: null,
    },
    {
      capability: 'domain-observations',
      scopeVerified: failures[1] === null,
      failure: failures[1],
      checkedAt: '2026-10-20T12:00:00.000Z',
      lastSucceededAt: null,
      correlationId: null,
    },
    ...history.map(({ capability, failure }) => ({
      capability,
      scopeVerified: failure === null,
      failure,
      checkedAt: '2026-10-20T12:00:00.000Z',
      lastSucceededAt: null,
      correlationId: null,
    })),
  ],
});

/** Settle a call into a value or an error so a wrong answer reads as an assertion. */
const settle = (call) =>
  call().then(
    (value) => ({ value }),
    (error) => ({ error }),
  );

function fakes({ authorize, requestSync, checkHealth } = {}) {
  const calls = { authorize: [], requestSync: [], checkHealth: [] };
  const port = {
    async authorize(_receivedSession, receivedCustomer, receivedCorrelation) {
      calls.authorize.push([receivedCustomer, receivedCorrelation]);
      if (authorize) throw authorize;
    },
    async requestSync(receivedSession, receivedCurrent, receivedCorrelation) {
      calls.requestSync.push(receivedCurrent);
      if (requestSync) throw requestSync;
      return started;
    },
    async checkHealth(
      receivedSession,
      receivedCustomer,
      generation,
      capabilities,
      receivedCorrelation,
    ) {
      calls.checkHealth.push({
        customer: receivedCustomer,
        generation,
        capabilities,
        correlation: receivedCorrelation,
      });
      if (checkHealth) throw checkHealth;
      return health();
    },
  };
  return { calls, refresh: new DeviceDomainRefresh(port) };
}

test('a caller without connection:diagnose answers 403 and starts neither read', async () => {
  const { calls, refresh } = fakes({
    authorize: new ForbiddenException(
      'This action requires additional permission.',
    ),
  });
  const answer = await settle(() =>
    refresh.request(session, current, correlationId),
  );
  assert.ok(answer.error instanceof ForbiddenException);
  assert.equal(answer.error.getStatus(), 403);
  assert.deepEqual(calls.authorize, [[customerId, correlationId]]);
  assert.deepEqual(calls.requestSync, [], 'A 403 starts no sync.');
  assert.deepEqual(calls.checkHealth, [], 'A 403 runs no check.');
});

test('a running sync answers 409 and runs no check', async () => {
  const { calls, refresh } = fakes({
    requestSync: new ConflictException({ reason: 'device-sync-running' }),
  });
  const answer = await settle(() =>
    refresh.request(session, current, correlationId),
  );
  assert.ok(answer.error instanceof ConflictException);
  assert.equal(answer.error.getStatus(), 409);
  assert.deepEqual(answer.error.getResponse(), {
    reason: 'device-sync-running',
  });
  assert.equal(calls.requestSync.length, 1);
  assert.deepEqual(calls.checkHealth, [], 'A running sync runs no check.');
});

test('a start failure answers 503 and runs no check', async () => {
  const { calls, refresh } = fakes({
    requestSync: new ServiceUnavailableException({
      reason: 'orchestration-unavailable',
    }),
  });
  const answer = await settle(() =>
    refresh.request(session, current, correlationId),
  );
  assert.ok(answer.error instanceof ServiceUnavailableException);
  assert.equal(answer.error.getStatus(), 503);
  assert.deepEqual(calls.checkHealth, [], 'A start failure runs no check.');
});

test('two passing checks answer refreshed with no reason', async () => {
  const { calls, refresh } = fakes();
  const answer = await settle(() =>
    refresh.request(session, current, correlationId),
  );
  assert.equal(answer.error, undefined, `The request answers: ${answer.error}`);
  assert.deepEqual(answer.value, {
    sync: started,
    domain: { status: 'refreshed', reason: null },
  });
  assert.deepEqual(calls.checkHealth, [
    {
      customer: customerId,
      generation: current.generation,
      capabilities: ['customer-identity', 'domain-observations'],
      correlation: correlationId,
    },
  ]);
});

test('a failed check answers its own code', async () => {
  for (const [failures, reason] of [
    [[null, 'quota'], 'quota'],
    [['permission-denied', null], 'permission-denied'],
    [['scope-mismatch', 'scope-mismatch'], 'scope-mismatch'],
  ]) {
    const failing = new DeviceDomainRefresh({
      authorize: async () => undefined,
      async requestSync() {
        return started;
      },
      async checkHealth() {
        return health(failures);
      },
    });
    const answer = await settle(() =>
      failing.request(session, current, correlationId),
    );
    assert.equal(
      answer.error,
      undefined,
      `The request answers: ${answer.error}`,
    );
    assert.deepEqual(answer.value.domain, { status: 'failed', reason });
  }
});

test('a failure outside the refreshed capabilities does not fail the domain refresh', async () => {
  const refresh = new DeviceDomainRefresh({
    authorize: async () => undefined,
    async requestSync() {
      return started;
    },
    async checkHealth() {
      return health(
        [null, null],
        [
          {
            capability: 'device-changes',
            failure: 'delegation-not-authorized',
          },
        ],
      );
    },
  });
  const answer = await settle(() =>
    refresh.request(session, current, correlationId),
  );
  assert.equal(answer.error, undefined, `The request answers: ${answer.error}`);
  assert.deepEqual(answer.value.domain, { status: 'refreshed', reason: null });
});

test('a 429 answers busy and a lease failure leaves the sync running', async () => {
  const busy = new DeviceDomainRefresh({
    authorize: async () => undefined,
    async requestSync() {
      return started;
    },
    async checkHealth() {
      throw new HttpException({ reason: 'health-rate-limited' }, 429);
    },
  });
  const answer = await settle(() =>
    busy.request(session, current, correlationId),
  );
  assert.equal(answer.error, undefined, `The request answers: ${answer.error}`);
  assert.deepEqual(answer.value, {
    sync: started,
    domain: { status: 'failed', reason: 'busy' },
  });
});

test('any other check failure answers unavailable', async () => {
  const unavailable = new DeviceDomainRefresh({
    authorize: async () => undefined,
    async requestSync() {
      return started;
    },
    async checkHealth() {
      throw new Error('google unreachable');
    },
  });
  const answer = await settle(() =>
    unavailable.request(session, current, correlationId),
  );
  assert.equal(answer.error, undefined, `The request answers: ${answer.error}`);
  assert.deepEqual(answer.value, {
    sync: started,
    domain: { status: 'failed', reason: 'unavailable' },
  });
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { ForbiddenException, HttpException } from '@nestjs/common';
import { UserDomainRefresh } from './user-domain-refresh.ts';

const customer = 'C0123456';
const session = { identity: { id: 'p1', permissionVersion: 1 } };
const correlationId = '0f8fad5b-d9cb-469f-a165-70867728950e';
const sync = {
  customerId: customer,
  generation: 4,
  status: 'running',
  jobId: null,
  observedAt: null,
  failure: null,
};

const health = (failures = {}) => ({
  capabilities: [
    {
      capability: 'customer-identity',
      scopeVerified: true,
      failure: failures['customer-identity'] ?? null,
      checkedAt: new Date().toISOString(),
    },
    {
      capability: 'domain-observations',
      scopeVerified: true,
      failure: failures['domain-observations'] ?? null,
      checkedAt: new Date().toISOString(),
    },
    {
      capability: 'device-management',
      scopeVerified: true,
      failure: null,
      checkedAt: new Date().toISOString(),
    },
  ],
  checkedAt: new Date().toISOString(),
});

function fakePort(overrides = {}) {
  const calls = { authorize: 0, requestSync: 0, checkHealth: [] };
  return {
    calls,
    async authorize() {
      calls.authorize += 1;
      if (overrides.authorizeFails) throw new ForbiddenException();
    },
    async requestSync() {
      calls.requestSync += 1;
      return overrides.sync ?? { ...sync, status: 'running' };
    },
    async checkHealth(_session, _customerId, _generation, capabilities) {
      calls.checkHealth.push(capabilities);
      if (overrides.healthFails) throw overrides.healthFails;
      return overrides.health ?? health();
    },
  };
}

test('a refresh starts the sync and then checks the two reads', async () => {
  const port = fakePort();
  const answer = await new UserDomainRefresh(port).request(
    session,
    sync,
    correlationId,
  );
  assert.equal(port.calls.authorize, 1);
  assert.equal(port.calls.requestSync, 1);
  assert.deepEqual(port.calls.checkHealth, [
    ['customer-identity', 'domain-observations'],
  ]);
  assert.deepEqual(answer.domain, { status: 'refreshed', reason: null });
  assert.equal(answer.sync.status, 'running');
});

test('a failed capability names its failure', async () => {
  const port = fakePort({
    health: health({ 'domain-observations': 'scope-mismatch' }),
  });
  const answer = await new UserDomainRefresh(port).request(
    session,
    sync,
    correlationId,
  );
  assert.deepEqual(answer.domain, {
    status: 'failed',
    reason: 'scope-mismatch',
  });
});

test('a failure of another capability does not decide this answer', async () => {
  const port = fakePort({ health: health({ 'device-management': 'quota' }) });
  const answer = await new UserDomainRefresh(port).request(
    session,
    sync,
    correlationId,
  );
  assert.deepEqual(answer.domain, { status: 'refreshed', reason: null });
});

test('a busy check answers busy and leaves the sync running', async () => {
  const busy = new HttpException('busy', 429);
  const port = fakePort({ healthFails: busy });
  const answer = await new UserDomainRefresh(port).request(
    session,
    sync,
    correlationId,
  );
  assert.deepEqual(answer.domain, { status: 'failed', reason: 'busy' });
  assert.equal(answer.sync.status, 'running');
});

test('a check that cannot run answers unavailable', async () => {
  const port = fakePort({ healthFails: new Error('down') });
  const answer = await new UserDomainRefresh(port).request(
    session,
    sync,
    correlationId,
  );
  assert.deepEqual(answer.domain, { status: 'failed', reason: 'unavailable' });
});

test('a refused authorization starts no sync', async () => {
  const port = fakePort({ authorizeFails: true });
  await assert.rejects(
    new UserDomainRefresh(port).request(session, sync, correlationId),
    (error) => {
      assert.equal(error.getStatus(), 403);
      return true;
    },
  );
  assert.equal(port.calls.requestSync, 0);
});

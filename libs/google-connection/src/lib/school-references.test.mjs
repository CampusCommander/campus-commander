import assert from 'node:assert/strict';
import test from 'node:test';
import { JWT, OAuth2Client } from 'google-auth-library';
import {
  GoogleCustomerVerifier,
  GOOGLE_CONNECTION_SCOPES,
} from './provider.ts';

const scope =
  'https://www.googleapis.com/auth/admin.directory.orgunit.readonly';
const credential = {
  subject: 'fixture@school.invalid',
  serviceAccount: {
    client_email: 'fixture@project.iam.gserviceaccount.com',
    private_key: 'synthetic',
    private_key_id: 'fixture',
  },
};
const root = { orgUnitId: 'root', name: 'Root', orgUnitPath: '/' };
const child = {
  orgUnitId: 'child',
  name: 'School',
  orgUnitPath: '/School',
  parentOrgUnitId: 'root',
};
function stub(
  t,
  { units = [root, child], scopes = [scope], tokenFailure, readFailure } = {},
) {
  const calls = [];
  t.mock.method(JWT.prototype, 'getAccessToken', async function () {
    calls.push({ kind: 'token', scopes: this.scopes });
    if (tokenFailure) throw tokenFailure;
    return { token: 'synthetic-token' };
  });
  t.mock.method(JWT.prototype, 'getTokenInfo', async () => ({
    scopes,
    expiry_date: Date.now() + 3500000,
  }));
  t.mock.method(OAuth2Client.prototype, 'request', async (options) => {
    calls.push({ kind: 'read', ...options });
    if (readFailure) throw readFailure;
    return { data: { organizationUnits: units } };
  });
  return calls;
}
const read = () =>
  new GoogleCustomerVerifier().readSchoolReferences(
    credential,
    'C0123456',
    7,
    AbortSignal.timeout(30000),
  );
test('optional OU read binds the exact customer and generation with one isolated read-only scope', async (t) => {
  const calls = stub(t);
  const result = await read();
  assert.equal(result.customerId, 'C0123456');
  assert.equal(result.generation, 7);
  assert.equal(result.complete, true);
  assert.equal(result.verified, true);
  assert.equal(result.units[0].parentId, null);
  assert.equal(result.units[1].parentId, 'root');
  assert.deepEqual(calls[0], { kind: 'token', scopes: [scope] });
  assert.equal(
    calls[1].url,
    'https://admin.googleapis.com/admin/directory/v1/customer/C0123456/orgunits',
  );
  assert.equal(calls[1].params.type, 'all_including_parent');
  assert.equal(GOOGLE_CONNECTION_SCOPES.includes(scope), false);
  assert.equal(JSON.stringify(result).includes('synthetic-token'), false);
});
test('extra issued scopes deny optional reads before the provider request', async (t) => {
  const calls = stub(t, { scopes: [scope, 'extra'] });
  await assert.rejects(read(), { code: 'scope-mismatch' });
  assert.equal(calls.length, 1);
});
test('optional scope denial and missing Google privileges retain distinct recovery reasons', async (t) => {
  stub(t, {
    tokenFailure: {
      response: { status: 400, data: { error: 'unauthorized_client' } },
    },
  });
  await assert.rejects(read(), { code: 'delegation-not-authorized' });
  t.mock.restoreAll();
  stub(t, { readFailure: { response: { status: 403 } } });
  await assert.rejects(read(), { code: 'permission-denied' });
});
test('malformed or incomplete OU hierarchies never become verified reference observations', async (t) => {
  for (const units of [
    [child],
    [root, root],
    [root, { ...child, parentOrgUnitId: 'missing' }],
    [root, { ...child, orgUnitPath: '/Elsewhere' }],
    [],
  ]) {
    stub(t, { units });
    await assert.rejects(read(), { code: 'invalid-response' });
    t.mock.restoreAll();
  }
});

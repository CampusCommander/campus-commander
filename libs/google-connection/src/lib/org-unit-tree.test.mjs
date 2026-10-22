import assert from 'node:assert/strict';
import test from 'node:test';
import { JWT, OAuth2Client } from 'google-auth-library';
import { GoogleDeviceReader } from './devices.ts';

const scope =
  'https://www.googleapis.com/auth/admin.directory.orgunit.readonly';
const credential = {
  subject: 'fixture@example.org',
  serviceAccount: {
    client_email: 'fixture@example.iam.gserviceaccount.com',
    private_key: 'synthetic',
    private_key_id: 'fixture',
  },
};
const root = { orgUnitId: 'id:01', name: 'District', orgUnitPath: '/' };
const school = {
  orgUnitId: 'id:02',
  name: 'School A',
  orgUnitPath: '/School A',
  parentOrgUnitId: 'id:01',
};
const classroom = {
  orgUnitId: 'id:03',
  name: 'Class 1',
  orgUnitPath: '/School A/Class 1',
  parentOrgUnitId: 'id:02',
};
function stub(
  t,
  { units = [root, school, classroom], scopes = [scope], readFailure } = {},
) {
  const calls = [];
  t.mock.method(JWT.prototype, 'getAccessToken', async function () {
    calls.push({ kind: 'token', scopes: this.scopes });
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
  new GoogleDeviceReader().readOrgUnitTree(
    credential,
    'C0123456',
    AbortSignal.timeout(30000),
  );

test('the tree read mints the one OU scope and keeps Google casing', async (t) => {
  const calls = stub(t);
  const units = await read();
  assert.deepEqual(units, [
    {
      orgUnitId: 'id:01',
      name: 'District',
      orgUnitPath: '/',
      parentOrgUnitId: null,
    },
    {
      orgUnitId: 'id:02',
      name: 'School A',
      orgUnitPath: '/School A',
      parentOrgUnitId: 'id:01',
    },
    {
      orgUnitId: 'id:03',
      name: 'Class 1',
      orgUnitPath: '/School A/Class 1',
      parentOrgUnitId: 'id:02',
    },
  ]);
  assert.deepEqual(calls[0], { kind: 'token', scopes: [scope] });
  assert.equal(
    calls[1].url,
    'https://admin.googleapis.com/admin/directory/v1/customer/C0123456/orgunits',
  );
  assert.equal(calls[1].params.type, 'all_including_parent');
  assert.match(calls[1].params.fields, /parentOrgUnitId/);
  assert.equal(JSON.stringify(units).includes('synthetic-token'), false);
});

test('the tree read accepts 10,000 units and refuses more', async (t) => {
  const many = (count) =>
    Array.from({ length: count }, (_value, index) => ({
      orgUnitId: `id:${index}`,
      name: `Unit ${index}`,
      orgUnitPath: index === 0 ? '/' : `/Unit ${index}`,
      ...(index === 0 ? {} : { parentOrgUnitId: 'id:0' }),
    }));
  stub(t, { units: many(10_000) });
  assert.equal((await read()).length, 10_000);
  t.mock.restoreAll();
  stub(t, { units: many(10_001) });
  await assert.rejects(read(), { code: 'invalid-response' });
});

test('a unit without an id, a name, or a leading slash path is refused', async (t) => {
  for (const units of [
    [{ name: 'District', orgUnitPath: '/' }],
    [{ orgUnitId: 'id:01', orgUnitPath: '/' }],
    [{ orgUnitId: 'id:01', name: 'District', orgUnitPath: 'School A' }],
    [
      {
        orgUnitId: 'id:01',
        name: 'District',
        orgUnitPath: '/',
        parentOrgUnitId: '',
      },
    ],
  ]) {
    t.mock.restoreAll();
    stub(t, { units });
    await assert.rejects(read(), { code: 'invalid-response' });
  }
});

test('an empty answer is refused, because every customer has a root unit', async (t) => {
  stub(t, { units: [] });
  await assert.rejects(read(), { code: 'invalid-response' });
});

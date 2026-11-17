import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { JWT, OAuth2Client } from 'google-auth-library';
import { GOOGLE_CAPABILITIES } from '@campus/application-contracts';
import { GoogleBatchService } from './batch.ts';
import { GoogleUserReader } from './users.ts';
import { fakeGoogle } from './batch-fake.mjs';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
  publicKeyEncoding: { format: 'pem', type: 'spki' },
});
const credential = {
  subject: 'fixture@example.invalid',
  serviceAccount: {
    client_email: 'fixture@project.iam.gserviceaccount.com',
    private_key: privateKey,
    private_key_id: 'fixture',
  },
};
const userScope = GOOGLE_CAPABILITIES.find(
  (capability) => capability.id === 'user-inventory',
).scope;
const schemaScope = GOOGLE_CAPABILITIES.find(
  (capability) => capability.id === 'user-schemas',
).scope;

/** Record the token and API requests of a direct read. */
function stub(t, pages) {
  const calls = [];
  const scopes = [];
  t.mock.method(JWT.prototype, 'getAccessToken', async function () {
    scopes.push(...this.scopes);
    return { token: 'private-fixture-token' };
  });
  t.mock.method(JWT.prototype, 'getTokenInfo', async function () {
    return { scopes: [...this.scopes], expiry_date: Date.now() + 3_500_000 };
  });
  t.mock.method(OAuth2Client.prototype, 'request', async (options) => {
    calls.push(options);
    const next = pages.shift();
    if (next instanceof Error || (next && next.response)) throw next;
    return { data: next };
  });
  return { calls, scopes };
}

async function collect(iterable) {
  const pages = [];
  for await (const page of iterable) pages.push(page);
  return pages;
}

const fastBatch = () =>
  new GoogleBatchService({ sleep: async () => undefined, random: () => 0 });
const signal = () => AbortSignal.timeout(5000);

function stubBatch(t, answer, options) {
  const google = fakeGoogle(answer, options);
  const scopes = [];
  t.mock.method(JWT.prototype, 'getAccessToken', async function () {
    scopes.push(...this.scopes);
    return { token: 'private-fixture-token' };
  });
  t.mock.method(JWT.prototype, 'getTokenInfo', async function () {
    return { scopes: [...this.scopes], expiry_date: Date.now() + 3_500_000 };
  });
  t.mock.method(OAuth2Client.prototype, 'request', (options) =>
    google.client.request(options),
  );
  return { google, scopes };
}

const resource = (id, extra = {}) => ({
  id,
  primaryEmail: `${id}@example.org`,
  orgUnitPath: '/Students',
  suspended: false,
  archived: false,
  lastLoginTime: '2026-03-01T10:00:00.000Z',
  creationTime: '2025-08-20T09:00:00.000Z',
  isEnrolledIn2Sv: false,
  ...extra,
});

test('user pages follow page tokens and map each Google field', async (t) => {
  const { calls, scopes } = stub(t, [
    {
      nextPageToken: 'page-2',
      users: [
        resource('u1', {
          name: {
            givenName: 'Ada',
            familyName: 'Lovelace',
            fullName: 'Ada Lovelace',
          },
          suspended: true,
          suspensionReason: 'ADMIN',
          archived: true,
          isEnrolledIn2Sv: true,
          aliases: ['a.lovelace@example.org'],
          organizations: [
            { department: 'Office', title: 'Clerk' },
            { primary: true, department: 'Science', title: 'Teacher' },
          ],
          customSchemas: {
            StudentInfo: {
              GradeLevel: 7,
              Programs: [{ value: 'Robotics', type: 'work' }],
            },
          },
        }),
        resource('u2', {
          // Google reports a user that never signed in at the Unix epoch.
          lastLoginTime: '1970-01-01T00:00:00.000Z',
        }),
      ],
    },
    { users: [resource('u3', { orgUnitPath: '/' })] },
  ]);
  const pages = await collect(
    new GoogleUserReader().userPages(credential, 'C0123456', signal()),
  );
  assert.deepEqual(scopes, [userScope]);
  assert.deepEqual(
    pages.map((page) => page.map((user) => user.userId)),
    [['u1', 'u2'], ['u3']],
  );
  const [first, second, third] = [...pages[0], ...pages[1]];
  assert.deepEqual(
    {
      userId: first.userId,
      primaryEmail: first.primaryEmail,
      orgUnitPath: first.orgUnitPath,
      givenName: first.givenName,
      familyName: first.familyName,
      fullName: first.fullName,
      suspended: first.suspended,
      suspensionReason: first.suspensionReason,
      archived: first.archived,
      twoStepEnrolled: first.twoStepEnrolled,
      department: first.department,
      title: first.title,
      aliases: first.aliases,
    },
    {
      userId: 'u1',
      primaryEmail: 'u1@example.org',
      orgUnitPath: '/Students',
      givenName: 'Ada',
      familyName: 'Lovelace',
      fullName: 'Ada Lovelace',
      suspended: true,
      suspensionReason: 'ADMIN',
      archived: true,
      twoStepEnrolled: true,
      department: 'Science',
      title: 'Teacher',
      aliases: ['a.lovelace@example.org'],
    },
  );
  assert.deepEqual(first.customSchemas, {
    StudentInfo: {
      GradeLevel: 7,
      Programs: [{ value: 'Robotics', type: 'work' }],
    },
  });
  assert.equal(first.lastLoginTime, '2026-03-01T10:00:00.000Z');
  assert.equal(second.lastLoginTime, null, 'the epoch is no sign-in');
  assert.equal(second.givenName, null);
  assert.equal(second.department, null);
  assert.equal(second.title, null);
  assert.deepEqual(second.customSchemas, {});
  assert.equal(third.orgUnitPath, '/');
  assert.equal(calls.length, 2);
  assert.equal(
    calls[0].url,
    'https://admin.googleapis.com/admin/directory/v1/users',
  );
  assert.deepEqual(calls[0].params, {
    customer: 'C0123456',
    projection: 'full',
    maxResults: 500,
    fields:
      'nextPageToken,users(id,primaryEmail,name(givenName,familyName,fullName),orgUnitPath,suspended,suspensionReason,archived,lastLoginTime,creationTime,isEnrolledIn2Sv,organizations(primary,department,title),aliases,customSchemas)',
  });
  assert.equal(calls[1].params.pageToken, 'page-2');
});

test('user pages keep legal own __proto__ category and field keys', async (t) => {
  const raw = JSON.parse(
    '{"__proto__":{"__proto__":"alpha","Grade":7},"StudentInfo":{"__proto__":"beta","Grade":8}}',
  );
  stub(t, [{ users: [resource('u1', { customSchemas: raw })] }]);
  const pages = await collect(
    new GoogleUserReader().userPages(credential, 'C0123456', signal()),
  );
  const user = pages[0][0];
  // The raw object, its reserved category, and its reserved field stay own keys.
  assert.deepEqual(user.customSchemas, raw);
  assert.deepEqual(Object.keys(user.customSchemas).sort(), [
    'StudentInfo',
    '__proto__',
  ]);
  const reserved = user.customSchemas['__proto__'];
  assert.deepEqual(Object.keys(reserved).sort(), ['Grade', '__proto__']);
  assert.equal(reserved['__proto__'], 'alpha');
  // Neither parse changes an object prototype.
  assert.equal(Object.getPrototypeOf(user.customSchemas), Object.prototype);
  assert.equal(Object.getPrototypeOf(reserved), Object.prototype);
  assert.equal(Object.getPrototypeOf(raw), Object.prototype);
  assert.equal(Object.getPrototypeOf(raw['__proto__']), Object.prototype);
});

test('user pages fail a resource without a user ID or org unit path', async (t) => {
  for (const broken of [
    { ...resource('u1'), id: undefined },
    { ...resource('u1'), orgUnitPath: 'Students' },
  ]) {
    stub(t, [{ users: [broken] }]);
    await assert.rejects(
      collect(
        new GoogleUserReader().userPages(credential, 'C0123456', signal()),
      ),
      { name: 'GoogleConnectionError', code: 'invalid-response' },
    );
    t.mock.restoreAll();
  }
});

test('user pages reject a customer ID that Google cannot hold', () => {
  assert.throws(
    () => new GoogleUserReader().userPages(credential, 'C01', signal()),
    (error) => error.name === 'ZodError',
  );
});

test('users reads each requested user once and reports a missing user', async (t) => {
  const { google, scopes } = stubBatch(t, (part) =>
    part.key === 'u/missing'
      ? {
          status: 404,
          body: { error: { code: 404, message: 'Resource Not Found' } },
        }
      : { status: 200, body: resource(part.key) },
  );
  const result = await new GoogleUserReader({
    batch: fastBatch(),
  }).users(credential, 'C0123456', ['u1', 'u/missing', 'u1'], signal());
  assert.deepEqual(scopes, [userScope]);
  assert.deepEqual(
    google.sent[0].map((part) => [part.method, part.path, part.query]),
    [
      [
        'GET',
        '/admin/directory/v1/users/u1',
        { projection: 'full', fields: expectFields() },
      ],
      [
        'GET',
        '/admin/directory/v1/users/u%2Fmissing',
        { projection: 'full', fields: expectFields() },
      ],
    ],
  );
  assert.deepEqual(
    result.users.map((user) => user.userId),
    ['u1'],
  );
  assert.deepEqual(result.missing, ['u/missing']);
});

test('a batched user read keeps legal own __proto__ category and field keys', async (t) => {
  const raw = JSON.parse(
    '{"__proto__":{"__proto__":"alpha","Grade":7},"StudentInfo":{"__proto__":"beta","Grade":8}}',
  );
  stubBatch(t, () => ({
    status: 200,
    body: resource('u1', { customSchemas: raw }),
  }));
  const result = await new GoogleUserReader({
    batch: fastBatch(),
  }).users(credential, 'C0123456', ['u1'], signal());
  const user = result.users[0];
  assert.deepEqual(user.customSchemas, raw);
  const reserved = user.customSchemas['__proto__'];
  assert.equal(Object.keys(reserved).length, 2);
  assert.equal(reserved['__proto__'], 'alpha');
  assert.equal(Object.getPrototypeOf(user.customSchemas), Object.prototype);
  assert.equal(Object.getPrototypeOf(reserved), Object.prototype);
  assert.equal(Object.getPrototypeOf(raw), Object.prototype);
});

test('users reads at most 100 users in one batch envelope', async (t) => {
  const { google } = stubBatch(t, (part) => ({
    status: 200,
    body: resource(part.key),
  }));
  const ids = Array.from({ length: 101 }, (_, index) => `u${index + 1}`);
  const result = await new GoogleUserReader({
    batch: fastBatch(),
  }).users(credential, 'C0123456', ids, signal());
  assert.deepEqual(
    google.sent.map((envelope) => envelope.length),
    [100, 1],
  );
  assert.deepEqual(
    result.users.map((user) => user.userId),
    ids,
  );
});

test('users retries a quota answer on its own part', async (t) => {
  let throttled = false;
  const { google } = stubBatch(t, (part) => {
    if (part.key === 'u1' && !throttled) {
      throttled = true;
      return {
        status: 403,
        body: {
          error: { code: 403, errors: [{ reason: 'userRateLimitExceeded' }] },
        },
      };
    }
    return { status: 200, body: resource(part.key) };
  });
  const result = await new GoogleUserReader({
    batch: fastBatch(),
  }).users(credential, 'C0123456', ['u1', 'u2'], signal());
  assert.deepEqual(google.keys(), [['u1', 'u2'], ['u1']]);
  assert.deepEqual(
    result.users.map((user) => user.userId),
    ['u1', 'u2'],
  );
});

test('users surfaces a final denied part as the Google failure', async (t) => {
  stubBatch(t, () => ({
    status: 403,
    body: { error: { code: 403, errors: [{ reason: 'forbidden' }] } },
  }));
  await assert.rejects(
    new GoogleUserReader({ batch: fastBatch() }).users(
      credential,
      'C0123456',
      ['u1'],
      signal(),
    ),
    { name: 'GoogleConnectionError', code: 'permission-denied' },
  );
});

const expectFields = () =>
  'id,primaryEmail,name(givenName,familyName,fullName),orgUnitPath,suspended,suspensionReason,archived,lastLoginTime,creationTime,isEnrolledIn2Sv,organizations(primary,department,title),aliases,customSchemas';

const category = (schemaName, extra = {}) => ({
  kind: 'admin#directory#schema',
  etag: `"${schemaName}-1"`,
  schemaId: `${schemaName}Id==`,
  schemaName,
  displayName: `${schemaName} display`,
  fields: [
    {
      fieldId: `${schemaName}-field`,
      fieldName: 'GradeLevel',
      displayName: 'Grade level',
      fieldType: 'INT64',
      numericIndexingSpec: { minValue: 0 },
    },
  ],
  ...extra,
});

test('categories reads the list with the schema scope and applies the field defaults', async (t) => {
  const { calls, scopes } = stub(t, [
    { schemas: [category('StudentInfo'), category('StaffInfo')] },
  ]);
  const categories = await new GoogleUserReader().categories(
    credential,
    'C0123456',
    signal(),
  );
  assert.deepEqual(scopes, [schemaScope]);
  assert.equal(
    calls[0].url,
    'https://admin.googleapis.com/admin/directory/v1/customer/C0123456/schemas',
  );
  assert.deepEqual(calls[0].params, {
    fields:
      'schemas(schemaId,schemaName,displayName,etag,fields(fieldId,fieldName,displayName,fieldType,multiValued,indexed,readAccessType,numericIndexingSpec(minValue,maxValue)))',
  });
  assert.deepEqual(
    categories.map((entry) => entry.schemaName),
    ['StudentInfo', 'StaffInfo'],
  );
  assert.deepEqual(categories[0], {
    schemaId: 'StudentInfoId==',
    schemaName: 'StudentInfo',
    displayName: 'StudentInfo display',
    etag: '"StudentInfo-1"',
    fields: [
      {
        fieldId: 'StudentInfo-field',
        fieldName: 'GradeLevel',
        displayName: 'Grade level',
        fieldType: 'INT64',
        multiValued: false,
        indexed: true,
        readAccessType: 'ALL_DOMAIN_USERS',
        numericIndexingSpec: { minValue: 0, maxValue: null },
      },
    ],
  });
});

test('categories accepts an account without a category', async (t) => {
  stub(t, [{ schemas: [] }]);
  assert.deepEqual(
    await new GoogleUserReader().categories(credential, 'C0123456', signal()),
    [],
  );
});

test('categories fails a category without an attribute', async (t) => {
  stub(t, [{ schemas: [{ ...category('StudentInfo'), fields: [] }] }]);
  await assert.rejects(
    new GoogleUserReader().categories(credential, 'C0123456', signal()),
    { name: 'GoogleConnectionError', code: 'invalid-response' },
  );
});

test('a category read encodes the opaque schema ID as one path segment', async (t) => {
  const { google, scopes } = stubBatch(t, () => ({
    status: 200,
    body: category('StudentInfo', {
      schemaId: 'ab/c+d==',
      schemaName: 'StudentInfo',
    }),
  }));
  const entry = await new GoogleUserReader({
    batch: fastBatch(),
  }).category(credential, 'C0123456', 'ab/c+d==', signal());
  assert.deepEqual(scopes, [schemaScope]);
  // The allowlist admits the encoded segment as one segment, and the part keeps
  // the percent escapes on the wire.
  assert.deepEqual(
    google.sent[0].map((part) => [part.method, part.path, part.query]),
    [
      [
        'GET',
        '/admin/directory/v1/customer/C0123456/schemas/ab%2Fc%2Bd%3D%3D',
        {},
      ],
    ],
  );
  assert.equal(entry.schemaId, 'ab/c+d==');
  assert.equal(entry.schemaName, 'StudentInfo');
});

test('a category read reports a missing category as null', async (t) => {
  stubBatch(t, () => ({
    status: 404,
    body: { error: { code: 404, message: 'Resource Not Found: schemaKey' } },
  }));
  assert.equal(
    await new GoogleUserReader({
      batch: fastBatch(),
    }).category(credential, 'C0123456', 'missing==', signal()),
    null,
  );
});

test('a category read retries a quota answer and then answers the category', async (t) => {
  let throttled = false;
  const { google } = stubBatch(t, () => {
    if (!throttled) {
      throttled = true;
      return {
        status: 403,
        body: {
          error: { code: 403, errors: [{ reason: 'userRateLimitExceeded' }] },
        },
      };
    }
    return { status: 200, body: category('StudentInfo') };
  });
  const entry = await new GoogleUserReader({
    batch: fastBatch(),
  }).category(credential, 'C0123456', 'StudentInfoId==', signal());
  assert.deepEqual(google.sent.length, 2);
  assert.equal(entry.schemaName, 'StudentInfo');
});

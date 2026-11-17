/**
 * Reads a seeded mock tenant through Campus Commander's user and category readers.
 * The mock answers the OAuth exchange and the Directory API in process, so each reader
 * proves its own delegated scope. No Docker and no live Google call.
 * Run the file inside `nx run google-connection:test`.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { JWT } from 'google-auth-library';
import { startMock } from '@campuscommander/admin-sdk-mock';
import { GOOGLE_CAPABILITIES } from '@campus/application-contracts';
import { GoogleBatchService } from './batch.ts';
import { GoogleUserReader } from './users.ts';
import { validateServiceAccount } from './credential.ts';

const readerScopes = ['user-inventory', 'user-schemas'].map(
  (id) => GOOGLE_CAPABILITIES.find((capability) => capability.id === id).scope,
);
/** A user ID that no seed can hold, for the removed-user path. */
const unknownUserId = '00000000-0000-4000-8000-000000000000';
const timeout = 60_000;

let mock;
let domain;
let credential;
let reader;
let users;

async function collect(iterable) {
  const items = [];
  for await (const page of iterable) items.push(...page);
  return items;
}

/** Read the raw user resources with an unmodified Google client. */
async function rawUsers() {
  const auth = new JWT({
    email: credential.serviceAccount.client_email,
    key: credential.serviceAccount.private_key,
    keyId: credential.serviceAccount.private_key_id,
    scopes: [readerScopes[0]],
    subject: credential.subject,
  });
  const found = new Map();
  let pageToken;
  for (let page = 0; page < 100; page += 1) {
    const url = new URL(
      'https://admin.googleapis.com/admin/directory/v1/users',
    );
    url.searchParams.set('customer', domain.customerId);
    url.searchParams.set('projection', 'full');
    url.searchParams.set('maxResults', '500');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const { data } = await auth.request({ url: url.href, method: 'GET' });
    for (const user of data.users ?? []) found.set(user.id, user);
    pageToken = data.nextPageToken;
    if (!pageToken) return found;
  }
  throw new Error('The user read never ended.');
}

class RecordingBatch extends GoogleBatchService {
  constructor(options = {}) {
    super(options);
    this.paths = [];
  }

  execute(call) {
    this.paths.push(call.requests.map((request) => request.path));
    return super.execute(call);
  }
}

before(async () => {
  mock = await startMock();
  // The proxy and its CA route every Google client of this process to the mock.
  mock.useInProcess();
  domain = await mock.createDomain({
    tier: 'small',
    seed: 'user-reader-fixture',
    customSchemas: true,
  });
  const key = mock.credential(domain.customerId, readerScopes);
  credential = {
    serviceAccount: validateServiceAccount(key, key.client_id),
    subject: domain.adminEmail,
  };
  reader = new GoogleUserReader();
});

after(async () => {
  await mock?.close();
});

test('the user reader reads every user of the mock domain once', async () => {
  users = await collect(
    reader.userPages(
      credential,
      domain.customerId,
      AbortSignal.timeout(timeout),
    ),
  );
  const listed = (await mock.control('GET', '/domains')).find(
    (entry) => entry.customerId === domain.customerId,
  );
  assert.ok(listed, 'the mock reports the seeded domain');
  assert.equal(
    users.length,
    listed.counts.users,
    'the reader reads the user count the mock reports',
  );
  assert.equal(
    new Set(users.map((user) => user.userId)).size,
    users.length,
    'every user appears once',
  );
});

test('each user keeps the raw customSchemas object that Google answered', async () => {
  const raw = await rawUsers();
  assert.deepEqual(
    users.map((user) => user.userId).sort(),
    [...raw.keys()].sort(),
  );
  let withValues = 0;
  for (const observation of users) {
    const answer = raw.get(observation.userId);
    assert.deepEqual(
      observation.customSchemas,
      answer.customSchemas ?? {},
      observation.userId,
    );
    assert.equal(observation.primaryEmail, answer.primaryEmail);
    assert.equal(observation.orgUnitPath, answer.orgUnitPath);
    // Google reports a user that never signed in at the Unix epoch. The reader
    // keeps no sign-in time for that user (A section 13).
    assert.equal(
      observation.lastLoginTime === null,
      Date.parse(answer.lastLoginTime) === 0,
      observation.userId,
    );
    const primary =
      (answer.organizations ?? []).find((entry) => entry.primary === true) ??
      (answer.organizations ?? [])[0];
    assert.equal(observation.department, primary?.department ?? null);
    assert.equal(observation.title, primary?.title ?? null);
    if (Object.keys(observation.customSchemas).length > 0) withValues += 1;
  }
  assert.ok(withValues > 0, 'the seeded domain holds custom values');
});

test('the category reader lists the seeded categories with their attributes', async () => {
  const categories = await reader.categories(
    credential,
    domain.customerId,
    AbortSignal.timeout(timeout),
  );
  assert.deepEqual(categories.map((category) => category.schemaName).sort(), [
    'DeviceProgram',
    'StaffInfo',
    'StudentInfo',
  ]);
  const student = categories.find(
    (category) => category.schemaName === 'StudentInfo',
  );
  assert.ok(student, 'the category read returns StudentInfo');
  assert.ok(student.schemaId, 'the category keeps its Google schema ID');
  assert.equal(student.displayName, 'Student information');
  assert.equal(student.fields.length, 5);
  const grade = student.fields.find(
    (field) => field.fieldName === 'GradeLevel',
  );
  assert.deepEqual(grade, {
    fieldId: grade.fieldId,
    fieldName: 'GradeLevel',
    displayName: 'Grade level',
    fieldType: 'INT64',
    multiValued: false,
    indexed: true,
    readAccessType: 'ALL_DOMAIN_USERS',
    numericIndexingSpec: { minValue: 0, maxValue: 12 },
  });
});

test('the category read of a schema ID with = padding reaches the mock encoded and answers', async () => {
  const categories = await reader.categories(
    credential,
    domain.customerId,
    AbortSignal.timeout(timeout),
  );
  const student = categories.find(
    (category) => category.schemaName === 'StudentInfo',
  );
  assert.ok(student.schemaId.includes('=='), 'the mock assigns = padding');
  const batch = new RecordingBatch({ sleep: async () => undefined });
  const entry = await new GoogleUserReader({ batch }).category(
    credential,
    domain.customerId,
    student.schemaId,
    AbortSignal.timeout(timeout),
  );
  assert.deepEqual(entry, student);
  // The allowlist admitted the segment, and the part carried the escaped form.
  assert.equal(batch.paths.length, 1);
  assert.deepEqual(batch.paths[0], [
    `/admin/directory/v1/customer/${domain.customerId}/schemas/${encodeURIComponent(student.schemaId)}`,
  ]);
  assert.ok(
    batch.paths[0][0].includes('%3D%3D'),
    'the padding leaves percent-encoded',
  );
  assert.ok(
    !batch.paths[0][0].includes('=='),
    'the raw padding never leaves the process',
  );
});

test('a missing schema ID answers null', async () => {
  assert.equal(
    await reader.category(
      credential,
      domain.customerId,
      '0000000000000000000000==',
      AbortSignal.timeout(timeout),
    ),
    null,
  );
});

test('the user batch read resolves known users and reports an unknown user', async () => {
  const known = users.slice(0, 5).map((user) => user.userId);
  const { users: read, missing } = await reader.users(
    credential,
    domain.customerId,
    [...known, unknownUserId],
    AbortSignal.timeout(timeout),
  );
  assert.deepEqual(missing, [unknownUserId]);
  assert.deepEqual(read.map((user) => user.userId).sort(), [...known].sort());
});

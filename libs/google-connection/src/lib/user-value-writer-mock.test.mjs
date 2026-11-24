/**
 * Writes custom attribute values through the Google value writer against
 * admin-sdk-mock 0.4.0, and reads them back with the masked read. Each write is one
 * batch part with the user write scope; each masked read is one batch part with the
 * read-only user scope. No live Google call. Run the file inside
 * `nx run google-connection:test`.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startMock } from '@campuscommander/admin-sdk-mock';
import { GOOGLE_CAPABILITIES } from '@campus/application-contracts';
import { GoogleBatchService } from './batch.ts';
import { validateServiceAccount } from './credential.ts';
import { GoogleUserReader, GoogleUserWriter } from './users.ts';

const scopeOf = (id) =>
  GOOGLE_CAPABILITIES.find((capability) => capability.id === id).scope;
const readScope = scopeOf('user-inventory');
const writeScope = scopeOf('user-changes');
/** A user ID that no seed can hold, for the missing-user part. */
const unknownUserId = '00000000-0000-4000-8000-000000000000';
const timeout = 60_000;

/** The parts of every batch the writer sends. */
class RecordingBatch extends GoogleBatchService {
  constructor() {
    super();
    this.parts = [];
  }

  execute(call) {
    this.parts.push(...call.requests);
    return super.execute(call);
  }
}

let mock;
let domain;
let reader;
let writer;
let batch;
let bothCredential;
let readCredential;
let writeCredential;
let users;

/** A delegated credential whose grant holds exactly these scopes. */
function credentialFor(scopes) {
  const key = mock.credential(domain.customerId, scopes);
  return {
    serviceAccount: validateServiceAccount(key, key.client_id),
    subject: domain.adminEmail,
  };
}

function signal() {
  return AbortSignal.timeout(timeout);
}

/** The last part the writer sent. */
function lastPart() {
  return batch.parts.at(-1);
}

/** Write one body on one user and answer the batch result. */
function write(userId, customSchemas) {
  return writer.writeValues(
    writeCredential,
    [{ userId, customSchemas }],
    signal(),
  );
}

/** Read the masked values of one user. */
function values(userId, customFieldMask) {
  return writer.userValues(readCredential, userId, customFieldMask, signal());
}

/** One attribute of a masked read, or undefined when the user holds no value. */
async function attribute(userId, schemaName, fieldName) {
  const answer = await values(userId, [schemaName]);
  return answer[schemaName]?.[fieldName];
}

before(async () => {
  mock = await startMock();
  // The proxy and its CA route every Google client of this process to the mock.
  mock.useInProcess();
  domain = await mock.createDomain({
    tier: 'small',
    seed: 'value-writer-fixture',
    customSchemas: true,
  });
  bothCredential = credentialFor([readScope, writeScope]);
  readCredential = credentialFor([readScope]);
  writeCredential = credentialFor([writeScope]);
  batch = new RecordingBatch();
  reader = new GoogleUserReader({ batch });
  writer = new GoogleUserWriter({ batch });
  users = [];
  for await (const page of reader.userPages(
    bothCredential,
    domain.customerId,
    signal(),
  ))
    users.push(...page);
  assert.ok(users.length >= 3, 'the seed holds at least three users');
});

after(async () => {
  await mock?.close();
});

test('each mode of B section 8.3 writes on the mock and reads back with the masked read', async () => {
  const userId = users[0].userId;
  // Start from a clear state, so each mode reads its own result.
  await write(userId, { StudentInfo: { Homeroom: null, Programs: null } });
  assert.equal(lastPart().method, 'PUT');
  assert.equal(await attribute(userId, 'StudentInfo', 'Homeroom'), undefined);
  assert.equal(await attribute(userId, 'StudentInfo', 'Programs'), undefined);

  // Set value: one single value leaves as a PATCH and reads back.
  const set = await write(userId, { StudentInfo: { Homeroom: 'B12' } });
  assert.equal(lastPart().method, 'PATCH');
  assert.deepEqual([...set.failed.keys()], []);
  // A write answer is the user resource with its customSchemas (C11).
  assert.equal(
    set.succeeded.get(userId)?.[0].customSchemas.StudentInfo.Homeroom,
    'B12',
  );
  assert.equal(await attribute(userId, 'StudentInfo', 'Homeroom'), 'B12');

  // Add values: the body names the current entries and the new one.
  await write(userId, {
    StudentInfo: { Programs: [{ value: 'ELL' }, { value: 'Band' }] },
  });
  assert.equal(lastPart().method, 'PATCH');
  assert.deepEqual(await attribute(userId, 'StudentInfo', 'Programs'), [
    { value: 'ELL' },
    { value: 'Band' },
  ]);

  // Remove values: the body names the entries that stay.
  await write(userId, { StudentInfo: { Programs: [{ value: 'ELL' }] } });
  assert.equal(lastPart().method, 'PATCH');
  assert.deepEqual(await attribute(userId, 'StudentInfo', 'Programs'), [
    { value: 'ELL' },
  ]);

  // Replace all values: the body names exactly the new values.
  await write(userId, {
    StudentInfo: { Programs: [{ value: 'Robotics' }] },
  });
  assert.equal(lastPart().method, 'PATCH');
  assert.deepEqual(await attribute(userId, 'StudentInfo', 'Programs'), [
    { value: 'Robotics' },
  ]);

  // Clear value: a single value leaves as a PUT and reads back as no value.
  await write(userId, { StudentInfo: { Homeroom: null } });
  assert.equal(lastPart().method, 'PUT');
  assert.equal(await attribute(userId, 'StudentInfo', 'Homeroom'), undefined);
  assert.deepEqual(await attribute(userId, 'StudentInfo', 'Programs'), [
    { value: 'Robotics' },
  ]);

  // Clear values: a list leaves as a PUT and reads back as no value.
  await write(userId, { StudentInfo: { Programs: null } });
  assert.equal(lastPart().method, 'PUT');
  assert.equal(await attribute(userId, 'StudentInfo', 'Programs'), undefined);
});

test('a body with a null leaves as users.update and clears the value (C9)', async () => {
  const userId = users[1].userId;
  // A body without a null leaves as users.patch and sets the value.
  await write(userId, { StudentInfo: { Homeroom: 'B21' } });
  assert.equal(lastPart().method, 'PATCH');
  assert.equal(await attribute(userId, 'StudentInfo', 'Homeroom'), 'B21');
  // The same attribute with a null leaves as users.update and clears it.
  await write(userId, { StudentInfo: { Homeroom: null } });
  assert.equal(lastPart().method, 'PUT');
  assert.equal(await attribute(userId, 'StudentInfo', 'Homeroom'), undefined);
  // An attribute that the body leaves out keeps its value.
  await write(userId, { StudentInfo: { Homeroom: 'B22' } });
  await write(userId, { StudentInfo: { GradeLevel: 7, Homeroom: null } });
  assert.equal(await attribute(userId, 'StudentInfo', 'GradeLevel'), 7);
  assert.equal(await attribute(userId, 'StudentInfo', 'Homeroom'), undefined);
});

test('a custom read of a missing category fails instead of an empty value set (C10)', async () => {
  const userId = users[0].userId;
  // A 200 without values is an empty object. Find a category this user lacks.
  const held = await values(userId, [
    'StudentInfo',
    'StaffInfo',
    'DeviceProgram',
  ]);
  const empty = ['StudentInfo', 'StaffInfo', 'DeviceProgram'].find(
    (schemaName) => held[schemaName] === undefined,
  );
  assert.ok(empty, 'the seeded user lacks one of the seeded categories');
  assert.deepEqual(await values(userId, [empty]), {});
  // A mask that names a missing category answers 400 invalid, which is a failure.
  await assert.rejects(values(userId, ['NoSuchCategory']), {
    name: 'GoogleConnectionError',
    code: 'request-failed',
  });
  assert.equal(lastPart().method, 'GET');
});

test('a missing user fails only its part', async () => {
  const userId = users[2].userId;
  const result = await writer.writeValues(
    writeCredential,
    [
      { userId, customSchemas: { StudentInfo: { Homeroom: 'B31' } } },
      {
        userId: unknownUserId,
        customSchemas: { StudentInfo: { Homeroom: 'B32' } },
      },
    ],
    signal(),
  );
  assert.deepEqual([...result.succeeded.keys()], [userId]);
  const failed = result.failed.get(unknownUserId);
  assert.equal(failed.kind, 'not-found');
  assert.equal(failed.status, 404);
  // The other part stored its value.
  assert.equal(await attribute(userId, 'StudentInfo', 'Homeroom'), 'B31');
});

test('each part carries only its own scope', async () => {
  const userId = users[0].userId;
  // A write token cannot read, and a read token cannot write.
  await assert.rejects(
    writer.userValues(writeCredential, userId, ['StudentInfo'], signal()),
    { name: 'GoogleConnectionError', code: 'delegation-not-authorized' },
  );
  await assert.rejects(
    writer.writeValues(
      readCredential,
      [{ userId, customSchemas: { StudentInfo: { Homeroom: 'B41' } } }],
      signal(),
    ),
    { name: 'GoogleConnectionError', code: 'delegation-not-authorized' },
  );
  // A credential that holds both scopes still mints one exact scope per call.
  await writer.writeValues(
    bothCredential,
    [{ userId, customSchemas: { StudentInfo: { Homeroom: 'B42' } } }],
    signal(),
  );
  assert.equal(await attribute(userId, 'StudentInfo', 'Homeroom'), 'B42');
});

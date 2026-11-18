/**
 * Writes custom attribute categories through the Google category writer against
 * admin-sdk-mock 0.4.0. Each call is one batch part with one exact scope: the
 * read-only schema scope for a read, the schema write scope for a write.
 * No live Google call. Run the file inside `nx run google-connection:test`.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startMock } from '@campuscommander/admin-sdk-mock';
import { GOOGLE_CAPABILITIES } from '@campus/application-contracts';
import { GoogleBatchService } from './batch.ts';
import { validateServiceAccount } from './credential.ts';
import { GoogleCategoryWriter } from './users.ts';

const scopeOf = (id) =>
  GOOGLE_CAPABILITIES.find((capability) => capability.id === id).scope;
const readScope = scopeOf('user-schemas');
const writeScope = scopeOf('user-schema-changes');
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
let writer;
let batch;
let readCredential;
let writeCredential;

/** A delegated credential whose grant holds exactly these scopes. */
function credentialFor(scopes) {
  const key = mock.credential(domain.customerId, scopes);
  return {
    serviceAccount: validateServiceAccount(key, key.client_id),
    subject: domain.adminEmail,
  };
}

/** The complete body of B section 6.1 for one category and one attribute. */
function body(extra = {}) {
  return {
    schemaName: 'WriterCheck',
    displayName: 'Writer check',
    fields: [
      {
        fieldName: 'GradeLevel',
        displayName: 'Grade level',
        fieldType: 'INT64',
        multiValued: false,
        indexed: true,
        readAccessType: 'ALL_DOMAIN_USERS',
        numericIndexingSpec: { minValue: 0, maxValue: 12 },
      },
    ],
    ...extra,
  };
}

before(async () => {
  mock = await startMock();
  // The proxy and its CA route every Google client of this process to the mock.
  mock.useInProcess();
  domain = await mock.createDomain({
    tier: 'small',
    seed: 'category-writer-fixture',
    customSchemas: true,
  });
  readCredential = credentialFor([readScope]);
  writeCredential = credentialFor([writeScope]);
  batch = new RecordingBatch();
  writer = new GoogleCategoryWriter({ batch });
});

after(async () => {
  await mock?.close();
});

test('an insert writes one POST part with the write scope and no If-Match', async () => {
  const result = await writer.insertCategory(
    writeCredential,
    domain.customerId,
    body(),
    AbortSignal.timeout(timeout),
  );
  assert.deepEqual([...result.failed.keys()], []);
  const created = result.succeeded.get('category')?.[0];
  assert.ok(created, 'the insert answers the schema');
  assert.ok(created.schemaId, 'the mock assigns a schema ID');
  assert.ok(created.schemaId.endsWith('=='), 'the mock pads the schema ID');
  assert.equal(created.schemaName, 'WriterCheck');
  assert.equal(created.displayName, 'Writer check');
  assert.equal(created.fields[0].fieldType, 'INT64');
  assert.deepEqual(created.fields[0].numericIndexingSpec, {
    minValue: 0,
    maxValue: 12,
  });
  const part = batch.parts.at(-1);
  assert.equal(part.method, 'POST');
  assert.equal(
    part.path,
    `/admin/directory/v1/customer/${domain.customerId}/schemas`,
  );
  assert.equal(part.headers?.['If-Match'], undefined);
});

test('a read names the category by its opaque ID with the read-only scope', async () => {
  const listed = await writer.category(
    readCredential,
    domain.customerId,
    'WriterCheck',
    AbortSignal.timeout(timeout),
  );
  assert.ok(listed, 'the category is readable by name');
  const read = await writer.category(
    readCredential,
    domain.customerId,
    listed.schemaId,
    AbortSignal.timeout(timeout),
  );
  assert.deepEqual(read, listed);
  const part = batch.parts.at(-1);
  assert.equal(part.method, 'GET');
  assert.equal(
    part.path,
    `/admin/directory/v1/customer/${domain.customerId}/schemas/${encodeURIComponent(listed.schemaId)}`,
  );
});

test('an update sends the plan etag in If-Match and answers the new etag', async () => {
  const listed = await writer.category(
    readCredential,
    domain.customerId,
    'WriterCheck',
    AbortSignal.timeout(timeout),
  );
  const result = await writer.updateCategory(
    writeCredential,
    domain.customerId,
    listed.schemaId,
    listed.etag,
    {
      schemaName: listed.schemaName,
      displayName: 'Writer check changed',
      fields: [
        {
          fieldId: listed.fields[0].fieldId,
          fieldName: listed.fields[0].fieldName,
          displayName: 'Grade level changed',
          fieldType: listed.fields[0].fieldType,
          multiValued: listed.fields[0].multiValued,
          indexed: listed.fields[0].indexed,
          readAccessType: listed.fields[0].readAccessType,
          numericIndexingSpec: listed.fields[0].numericIndexingSpec,
        },
        {
          fieldName: 'Section',
          displayName: 'Section',
          fieldType: 'STRING',
          multiValued: false,
          indexed: true,
          readAccessType: 'ALL_DOMAIN_USERS',
        },
      ],
    },
    AbortSignal.timeout(timeout),
  );
  assert.deepEqual([...result.failed.keys()], []);
  const updated = result.succeeded.get('category')?.[0];
  assert.ok(updated, 'the update answers the schema');
  assert.equal(updated.displayName, 'Writer check changed');
  assert.equal(updated.fields.length, 2);
  assert.notEqual(updated.etag, listed.etag, 'each write gives a new etag');
  const part = batch.parts.at(-1);
  assert.equal(part.method, 'PUT');
  assert.equal(part.headers?.['If-Match'], listed.etag);
});

test('a stale If-Match on a delete answers 412 conditionNotMet', async () => {
  const listed = await writer.category(
    readCredential,
    domain.customerId,
    'WriterCheck',
    AbortSignal.timeout(timeout),
  );
  const result = await writer.deleteCategory(
    writeCredential,
    domain.customerId,
    listed.schemaId,
    '"stale-etag"',
    AbortSignal.timeout(timeout),
  );
  assert.deepEqual([...result.succeeded.keys()], []);
  const failed = result.failed.get('category');
  assert.equal(failed.status, 412);
  assert.equal(failed.reason, 'conditionNotMet');
  assert.equal(batch.parts.at(-1).headers?.['If-Match'], '"stale-etag"');
});

test('a delete with the current etag answers 204 and the category is gone', async () => {
  const listed = await writer.category(
    readCredential,
    domain.customerId,
    'WriterCheck',
    AbortSignal.timeout(timeout),
  );
  const result = await writer.deleteCategory(
    writeCredential,
    domain.customerId,
    listed.schemaId,
    listed.etag,
    AbortSignal.timeout(timeout),
  );
  assert.deepEqual([...result.failed.keys()], []);
  assert.deepEqual(result.succeeded.get('category'), [null]);
  assert.equal(
    await writer.category(
      readCredential,
      domain.customerId,
      listed.schemaId,
      AbortSignal.timeout(timeout),
    ),
    null,
  );
});

test('a reused category name answers 412 conditionNotMet without a retry', async () => {
  const before = batch.parts.length;
  const result = await writer.insertCategory(
    writeCredential,
    domain.customerId,
    body({ schemaName: 'StudentInfo' }),
    AbortSignal.timeout(timeout),
  );
  const failed = result.failed.get('category');
  assert.equal(failed.status, 412);
  assert.equal(failed.reason, 'conditionNotMet');
  assert.equal(
    batch.parts.length - before,
    1,
    'a rejected insert sends one part',
  );
});

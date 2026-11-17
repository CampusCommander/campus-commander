/**
 * Coverage for the L2 live check without a network call.
 * The tests drive the production sequence with a simulated Directory `schemas` service.
 * They cover the name guard, the evidence sanitizer, the recorded answers, the stop before
 * a write, and the cleanup of a category that this run created.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import '../../libs/application-contracts/test-register.mjs';

const {
  CATEGORY_NAME,
  CUSTOMER_PLACEHOLDER,
  LONG_DISPLAY_NAME,
  LONG_FIELD_NAME,
  SCOPE,
  SUBJECT_PLACEHOLDER,
  assertCategoryName,
  evidencePathFor,
  runCheck,
  sanitizeEvidence,
} = await import('./user-schema-live.mjs');

const prefix = '/admin/directory/v1/customer/my_customer/schemas';
const syntheticToken = 'fixture-access-token';
const subject = 'owner@example.org';
const ownerCategory = {
  schemaId: 'domain-category',
  schemaName: 'DomainCategory',
  displayName: 'Domain category',
  etag: 'etag-domain',
  fields: [
    {
      fieldId: 'domain-field',
      fieldName: 'Grade',
      fieldType: 'STRING',
      displayName: 'Grade',
      multiValued: false,
      indexed: true,
      readAccessType: 'ALL_DOMAIN_USERS',
    },
  ],
};

/** One simulated Directory `schemas` service. It answers the five calls of the L2 row. */
function google({
  categories = [],
  displayNameLimit = 60,
  fieldNameLimit = 60,
  faults = [],
} = {}) {
  let serial = 0;
  let etagSerial = 0;
  const schemas = categories.map((item) => structuredClone(item));
  const requests = [];
  const pending = [...faults];
  const nextId = (name) => {
    serial += 1;
    return `${name}-${serial}`;
  };
  const nextEtag = () => {
    etagSerial += 1;
    return `etag-${etagSerial}`;
  };
  const fail = (status, reason) => ({
    status,
    data: { error: { code: status, errors: [{ reason }] } },
  });
  const find = (key) =>
    schemas.find((item) => item.schemaId === key || item.schemaName === key) ??
    null;
  const withDefaults = (fields = []) =>
    fields.map((field) => ({
      fieldId: field.fieldId ?? nextId('field'),
      fieldName: field.fieldName,
      fieldType: field.fieldType ?? 'STRING',
      displayName: field.displayName ?? field.fieldName,
      multiValued: field.multiValued ?? false,
      indexed: field.indexed ?? true,
      readAccessType: field.readAccessType ?? 'ALL_DOMAIN_USERS',
    }));

  const send = async (token, request) => {
    requests.push({
      token,
      method: request.method,
      path: request.path,
      headers: request.headers ?? {},
      body: request.body ?? null,
    });
    const fault = pending.findIndex((item) => item.method === request.method);
    if (fault >= 0) {
      const [item] = pending.splice(fault, 1);
      return fail(item.status, item.reason);
    }
    if (!request.path.startsWith(prefix)) return fail(404, 'notFound');
    const key =
      request.path === prefix ? '' : request.path.slice(prefix.length + 1);

    if (request.method === 'GET' && key === '')
      return {
        status: 200,
        data: { schemas: schemas.map((item) => structuredClone(item)) },
      };
    if (request.method === 'GET') {
      const found = find(key);
      return found
        ? { status: 200, data: structuredClone(found) }
        : fail(404, 'notFound');
    }
    if (request.method === 'POST') {
      if (schemas.some((item) => item.schemaName === request.body.schemaName))
        return fail(409, 'duplicate');
      const made = {
        schemaId: nextId('schema'),
        schemaName: request.body.schemaName,
        displayName: request.body.displayName,
        etag: nextEtag(),
        fields: withDefaults(request.body.fields),
      };
      schemas.push(made);
      return { status: 200, data: structuredClone(made) };
    }
    const found = find(key);
    if (!found) return fail(404, 'notFound');
    if (request.method === 'PUT') {
      const ifMatch = request.headers?.['If-Match'];
      if (ifMatch !== undefined && ifMatch !== found.etag)
        return fail(412, 'conditionNotMet');
      if (request.body.displayName.length > displayNameLimit)
        return fail(400, 'invalid');
      if (
        (request.body.fields ?? []).some(
          (field) => field.fieldName.length > fieldNameLimit,
        )
      )
        return fail(400, 'invalid');
      found.displayName = request.body.displayName;
      found.fields = withDefaults(request.body.fields);
      found.etag = nextEtag();
      return { status: 200, data: structuredClone(found) };
    }
    if (request.method === 'DELETE') {
      schemas.splice(schemas.indexOf(found), 1);
      return { status: 200, data: null };
    }
    return fail(405, 'methodNotAllowed');
  };

  return { send, schemas, requests };
}

/** Run the check into a scratch directory with an injected clock and transport. */
async function run(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'cc-user-schema-live-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, 'evidence.json');
  const { evidence, path } = await runCheck(
    { subject },
    {
      output,
      now: () => new Date(),
      mint: async () => ({ token: syntheticToken }),
      ...options,
    },
  );
  return {
    evidence,
    path,
    written: JSON.parse(await readFile(output, 'utf8')),
  };
}

const stepOf = (evidence, step) => {
  const found = evidence.steps.find((call) => call.step === step);
  assert.ok(found, `the evidence holds the ${step} step`);
  return found;
};

test('the check records the four answers of steps 3, 4, 5, and 6', async (t) => {
  const fake = google({ categories: [ownerCategory] });
  const { evidence, written } = await run(t, { send: fake.send });

  assert.equal(evidence.status, 'passed');
  assert.deepEqual(written, evidence);
  assert.deepEqual(evidence.answers, {
    reusedName: 409,
    staleIfMatch: 412,
    longDisplayName: 400,
    longAttributeName: 400,
    nameReuseAfterDelete: 200,
  });
  assert.deepEqual(evidence.counts, {
    categoriesBefore: 1,
    categoriesAfter: 1,
    ccLiveCheckAfter: false,
  });
  assert.equal(stepOf(evidence, '3-insert-reused-name').reason, 'duplicate');
  assert.equal(
    stepOf(evidence, '4-update-stale-if-match').reason,
    'conditionNotMet',
  );
  assert.equal(
    stepOf(evidence, '5-update-long-display-name').wrote.displayNameLength,
    200,
  );
  assert.equal(
    stepOf(evidence, '5-update-long-display-name').wrote.displayName,
    LONG_DISPLAY_NAME,
  );
  assert.equal(
    stepOf(evidence, '5-update-long-attribute-name').wrote.fields.at(-1)
      .fieldNameLength,
    200,
  );
  assert.equal(
    stepOf(evidence, '5-update-long-attribute-name').wrote.fields.at(-1)
      .fieldName,
    LONG_FIELD_NAME,
  );
  // Both updates of step 4 send the etag of step 2, so the second call carries a stale value.
  assert.equal(
    stepOf(evidence, '4-update-fresh-etag').ifMatch,
    stepOf(evidence, '4-update-stale-if-match').ifMatch,
  );
  assert.equal(stepOf(evidence, '2-insert').httpStatus, 200);
});

test('the check leaves the other category of the domain untouched', async (t) => {
  const fake = google({ categories: [ownerCategory] });
  const { evidence } = await run(t, { send: fake.send });

  assert.deepEqual(fake.schemas, [ownerCategory]);
  assert.ok(
    !fake.requests.some((request) =>
      request.path.includes(ownerCategory.schemaId),
    ),
    'no call names the other category',
  );
  assert.ok(
    !JSON.stringify(evidence).includes(ownerCategory.schemaName),
    'the evidence names no other category',
  );
  assert.ok(
    fake.requests
      .filter((request) => request.path !== prefix)
      .every(
        (request) =>
          request.path.endsWith(`/${CATEGORY_NAME}`) ||
          /\/schema-\d+$/.test(request.path),
      ),
    'every category call names the test category or an ID that Google issued',
  );
});

test('the evidence holds no token and no live identifier', async (t) => {
  const fake = google({ categories: [ownerCategory] });
  const { evidence } = await run(t, { send: fake.send });

  const text = JSON.stringify(evidence);
  assert.ok(!text.includes(syntheticToken));
  assert.equal(evidence.customer, CUSTOMER_PLACEHOLDER);
  assert.equal(evidence.subject, SUBJECT_PLACEHOLDER);
  assert.equal(evidence.scope, SCOPE);
  assert.equal(evidence.scopeCheck.result, 'passed');
  assert.ok(!text.includes('Bearer'));
  assert.ok(
    evidence.steps.every(
      (call) => call.path === null || call.path.includes(CUSTOMER_PLACEHOLDER),
    ),
    'every recorded path carries the customer placeholder',
  );
});

test('the check stops before a write when the category already exists', async (t) => {
  const leftover = {
    schemaId: 'leftover',
    schemaName: CATEGORY_NAME,
    displayName: 'Leftover',
    etag: 'etag-leftover',
    fields: [],
  };
  const fake = google({ categories: [ownerCategory, leftover] });
  const { evidence } = await run(t, { send: fake.send });

  assert.equal(evidence.status, 'stopped');
  assert.deepEqual(evidence.stopped, {
    step: '1-get-guard',
    reason: 'category-exists',
    httpStatus: 200,
  });
  assert.ok(
    fake.requests.every((request) => request.method === 'GET'),
    'the stopped run sends no write',
  );
  assert.deepEqual(evidence.answers, {});
  assert.deepEqual(evidence.counts, {
    categoriesBefore: 2,
    categoriesAfter: 2,
    ccLiveCheckAfter: true,
  });
  assert.ok(
    fake.schemas.some((item) => item.schemaName === CATEGORY_NAME),
    'the category that the run did not create stays',
  );
});

test('the cleanup removes the category after a refused delete', async (t) => {
  const fake = google({
    categories: [ownerCategory],
    faults: [{ method: 'DELETE', status: 403, reason: 'forbidden' }],
  });
  const { evidence } = await run(t, { send: fake.send });

  assert.equal(stepOf(evidence, '6-delete').httpStatus, 403);
  assert.equal(evidence.answers.nameReuseAfterDelete, 409);
  assert.equal(stepOf(evidence, '7-cleanup-delete').httpStatus, 200);
  assert.deepEqual(evidence.counts, {
    categoriesBefore: 1,
    categoriesAfter: 1,
    ccLiveCheckAfter: false,
  });
  assert.equal(evidence.status, 'passed');
  assert.deepEqual(fake.schemas, [ownerCategory]);
});

test('a refused insert fails the check and writes the evidence', async (t) => {
  const fake = google({
    categories: [ownerCategory],
    faults: [{ method: 'POST', status: 403, reason: 'forbidden' }],
  });
  const { evidence, written } = await run(t, { send: fake.send });

  assert.equal(evidence.status, 'failed');
  assert.equal(evidence.failure, 'insert-403');
  assert.deepEqual(written, evidence);
  assert.equal(stepOf(evidence, '2-insert').reason, 'forbidden');
  assert.deepEqual(evidence.counts, {
    categoriesBefore: 1,
    categoriesAfter: 1,
    ccLiveCheckAfter: false,
  });
  assert.deepEqual(fake.schemas, [ownerCategory]);
});

test('a refused token fails the check before any call', async (t) => {
  const fake = google({ categories: [ownerCategory] });
  const { evidence } = await run(t, {
    send: fake.send,
    mint: async () => {
      throw Object.assign(new Error('refused'), {
        code: 'delegation-not-authorized',
      });
    },
  });

  assert.equal(evidence.status, 'failed');
  assert.equal(evidence.failure, 'delegation-not-authorized');
  assert.equal(evidence.scopeCheck.result, 'not-run');
  assert.equal(fake.requests.length, 0);
  assert.equal(stepOf(evidence, '7-cleanup').note, 'skipped: no token');
});

test('the name guard refuses every other category name', () => {
  assert.equal(assertCategoryName(CATEGORY_NAME), CATEGORY_NAME);
  for (const name of [
    'Cclivecheck',
    'ccLiveCheck',
    `${CATEGORY_NAME} `,
    ` ${CATEGORY_NAME}`,
    `${CATEGORY_NAME}/../Other`,
    'DomainCategory',
    '',
    '..',
  ]) {
    assert.throws(() => assertCategoryName(name), {
      code: 'schema-name-refused',
    });
  }
});

test('the sanitizer replaces each identifier and drops each credential field', () => {
  const live = {
    customer: 'C0fixture9',
    subject: 'owner@example.org',
    testUser: 'person@example.org',
    nested: [
      { path: '/customer/C0fixture9/schemas', subject: 'owner@example.org' },
      { testUser: 'person@example.org', count: 1 },
    ],
    access_token: 'opaque-value',
    ['client' + 'Id']: '123',
    client_secret: 'opaque-value',
    key_id: 'opaque-value',
    keep: true,
  };
  const sanitized = sanitizeEvidence(live, [
    { from: 'C0fixture9', to: CUSTOMER_PLACEHOLDER },
    { from: 'owner@example.org', to: SUBJECT_PLACEHOLDER },
    { from: 'person@example.org', to: 'test-user@example.org' },
  ]);

  assert.deepEqual(sanitized, {
    customer: CUSTOMER_PLACEHOLDER,
    subject: SUBJECT_PLACEHOLDER,
    testUser: 'test-user@example.org',
    nested: [
      {
        path: `/customer/${CUSTOMER_PLACEHOLDER}/schemas`,
        subject: SUBJECT_PLACEHOLDER,
      },
      { testUser: 'test-user@example.org', count: 1 },
    ],
    keep: true,
  });
  // The walk copies: the caller keeps the live value.
  assert.equal(live.nested[0].path, '/customer/C0fixture9/schemas');
  assert.equal(live.access_token, 'opaque-value');
});

test('the evidence carries the run date of the injected clock', async (t) => {
  const clock = () => new Date('2026-01-02T03:04:05Z');
  assert.equal(
    evidencePathFor(clock()),
    'deployment/evidence/user-schema-live-l2-2026-01-02.json',
  );
  const fake = google({ categories: [ownerCategory] });
  const { evidence, written } = await run(t, { send: fake.send, now: clock });
  assert.equal(evidence.observedAt, clock().toISOString());
  assert.deepEqual(written, evidence);
});

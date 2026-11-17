/**
 * Coverage for the L2 live check without a network call.
 * The tests drive the production sequence with a simulated Directory `schemas` service.
 * They cover the name guard, the evidence sanitizer, the recorded answers, the stop before
 * a write, and the cleanup of a category that this run created, including cleanup after a lost
 * insert answer, a refused delete, an expired operation signal, and an unknown final list.
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
  rotateEtag = true,
  schemaId = (name, serial) => `${name}-${serial}`,
} = {}) {
  let serial = 0;
  let etagSerial = 0;
  const schemas = categories.map((item) => structuredClone(item));
  const requests = [];
  const pending = faults.map((item) => ({
    ...item,
    seen: 0,
    fired: 0,
    times: item.times ?? 1,
  }));
  const nextId = (name) => {
    serial += 1;
    return schemaId(name, serial);
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

  const handle = (request) => {
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
      if (rotateEtag) found.etag = nextEtag();
      return { status: 200, data: structuredClone(found) };
    }
    if (request.method === 'DELETE') {
      schemas.splice(schemas.indexOf(found), 1);
      return { status: 200, data: null };
    }
    return fail(405, 'methodNotAllowed');
  };

  /** One fault that matches this request, or null. `skip` lets the first calls pass. */
  const takeFault = (request) => {
    for (const item of pending) {
      if (item.method !== request.method) continue;
      if (item.path !== undefined && item.path !== request.path) continue;
      item.seen += 1;
      if (item.skip !== undefined && item.seen <= item.skip) continue;
      if (item.fired >= item.times) continue;
      item.fired += 1;
      return item;
    }
    return null;
  };

  const send = async (token, request, signal) => {
    // `fetch` rejects an aborted request before it leaves the process.
    if (signal?.aborted) {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }
    requests.push({
      token,
      method: request.method,
      path: request.path,
      headers: request.headers ?? {},
      body: request.body ?? null,
    });
    const fault = takeFault(request);
    if (fault) {
      // `apply` performs the write before the answer is lost, as a reset connection can.
      const applied = fault.apply ? handle(request) : null;
      if (fault.abort) fault.abort();
      if (fault.transport)
        throw Object.assign(new Error(fault.transport), {
          name: fault.transport,
        });
      return applied ?? fail(fault.status, fault.reason);
    }
    return handle(request);
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
  assert.equal(
    stepOf(evidence, '4-update-stale-if-match').ifMatch,
    stepOf(evidence, '2-insert').answered.etag,
  );
  // The first update changes the etag, so the second header is recorded as stale.
  assert.notEqual(
    stepOf(evidence, '4-update-fresh-etag').answered.etag,
    stepOf(evidence, '2-insert').answered.etag,
  );
  assert.equal(stepOf(evidence, '4-update-stale-if-match').ifMatchStale, true);
  assert.equal(stepOf(evidence, '2-insert').httpStatus, 200);
});

test('the check reports an unchanged etag as current, not stale', async (t) => {
  // A service that keeps its etag after a write cannot make the second header stale.
  const fake = google({ categories: [ownerCategory], rotateEtag: false });
  const { evidence } = await run(t, { send: fake.send });

  assert.equal(evidence.answers.staleIfMatch, 200);
  assert.equal(stepOf(evidence, '4-update-stale-if-match').ifMatchStale, false);
  assert.equal(
    stepOf(evidence, '4-update-stale-if-match').ifMatch,
    stepOf(evidence, '4-update-fresh-etag').answered.etag,
  );
  assert.deepEqual(evidence.counts, {
    categoriesBefore: 1,
    categoriesAfter: 1,
    ccLiveCheckAfter: false,
  });
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

test('an insert that applies before its answer fails does not strand the category', async (t) => {
  // The POST applies, then the connection drops, so the run never receives the new schema.
  const fake = google({
    categories: [ownerCategory],
    faults: [{ method: 'POST', apply: true, transport: 'ECONNRESET' }],
  });
  const { evidence } = await run(t, { send: fake.send });

  assert.equal(evidence.status, 'failed');
  assert.equal(evidence.failure, 'insert-ECONNRESET');
  assert.equal(stepOf(evidence, '2-insert').httpStatus, null);
  assert.equal(stepOf(evidence, '2-insert').failure, 'ECONNRESET');
  // The cleanup names the permitted category, so it needs no received schema answer.
  const cleanup = stepOf(evidence, '7-cleanup-delete');
  assert.equal(cleanup.httpStatus, 200);
  assert.equal(cleanup.path.endsWith(`/${CATEGORY_NAME}`), true);
  assert.deepEqual(cleanup.wrote, { schemaKey: 'name' });
  assert.deepEqual(evidence.counts, {
    categoriesBefore: 1,
    categoriesAfter: 1,
    ccLiveCheckAfter: false,
  });
  assert.deepEqual(fake.schemas, [ownerCategory]);
});

test('a lost recreation answer with an ID outside the name guard still cleans up', async (t) => {
  // The issued ID carries characters outside the name guard, and the recreation answer is lost.
  const fake = google({
    categories: [ownerCategory],
    schemaId: (name) => (name === 'schema' ? 'schema:1/odd' : `${name}-id`),
    faults: [{ method: 'POST', skip: 2, apply: true, transport: 'ECONNRESET' }],
  });
  const { evidence } = await run(t, { send: fake.send });

  assert.equal(stepOf(evidence, '2-insert').answered.schemaIdPathSafe, false);
  assert.equal(
    stepOf(evidence, '2-insert').answered.schemaIdLength,
    'schema:1/odd'.length,
  );
  assert.equal(stepOf(evidence, '6-insert-reused-name').failure, 'ECONNRESET');
  assert.equal(evidence.answers.nameReuseAfterDelete, null);
  const cleanup = stepOf(evidence, '7-cleanup-delete');
  assert.equal(cleanup.httpStatus, 200);
  assert.equal(cleanup.path.endsWith(`/${CATEGORY_NAME}`), true);
  assert.deepEqual(evidence.counts, {
    categoriesBefore: 1,
    categoriesAfter: 1,
    ccLiveCheckAfter: false,
  });
  assert.deepEqual(fake.schemas, [ownerCategory]);
});

test('a refused cleanup delete is reconciled by the permitted name', async (t) => {
  // The first cleanup delete answers 503, so the category survives the first pass.
  const fake = google({
    categories: [ownerCategory],
    faults: [
      { method: 'DELETE', skip: 1, status: 503, reason: 'backendError' },
    ],
  });
  const { evidence } = await run(t, { send: fake.send });

  assert.equal(stepOf(evidence, '7-cleanup-delete').httpStatus, 503);
  assert.equal(stepOf(evidence, '7-cleanup-delete').reason, 'backendError');
  const repeated = stepOf(evidence, '7-cleanup-delete-repeated');
  assert.equal(repeated.httpStatus, 200);
  assert.equal(repeated.path.endsWith(`/${CATEGORY_NAME}`), true);
  assert.deepEqual(evidence.counts, {
    categoriesBefore: 1,
    categoriesAfter: 1,
    ccLiveCheckAfter: false,
  });
  assert.equal(evidence.status, 'passed');
  assert.deepEqual(fake.schemas, [ownerCategory]);
});

test('an aborted operation signal does not disable the cleanup', async (t) => {
  // The operation deadline fires after the insert applies. Cleanup must use its own signal.
  const operation = new AbortController();
  const fake = google({
    categories: [ownerCategory],
    faults: [
      {
        method: 'POST',
        apply: true,
        transport: 'ECONNRESET',
        abort: () => operation.abort(),
      },
    ],
  });
  const { evidence } = await run(t, {
    send: fake.send,
    signal: operation.signal,
  });

  assert.equal(operation.signal.aborted, true);
  assert.equal(evidence.status, 'failed');
  assert.equal(stepOf(evidence, '2-insert').failure, 'ECONNRESET');
  // The fake refuses any request that carries an aborted signal, as `fetch` does.
  const cleanup = stepOf(evidence, '7-cleanup-delete');
  assert.equal(cleanup.httpStatus, 200);
  assert.equal(stepOf(evidence, '7-list').httpStatus, 200);
  assert.deepEqual(evidence.counts, {
    categoriesBefore: 1,
    categoriesAfter: 1,
    ccLiveCheckAfter: false,
  });
  assert.deepEqual(fake.schemas, [ownerCategory]);
});

test('a failed final list reports the absence as unknown, not clean', async (t) => {
  // Both cleanup lists fail after the delete. A failed read never proves absence.
  const fake = google({
    categories: [ownerCategory],
    faults: [
      {
        method: 'GET',
        path: prefix,
        skip: 1,
        times: 2,
        status: 503,
        reason: 'backendError',
      },
    ],
  });
  const { evidence } = await run(t, { send: fake.send });

  assert.equal(stepOf(evidence, '7-list').httpStatus, 503);
  assert.equal(stepOf(evidence, '7-list-final').httpStatus, 503);
  assert.equal(evidence.counts.categoriesBefore, 1);
  assert.equal(evidence.counts.categoriesAfter, null);
  assert.equal(evidence.counts.ccLiveCheckAfter, null);
  assert.equal(evidence.status, 'failed');
  // The delete itself succeeded, and the domain is clean even though the proof is incomplete.
  assert.equal(stepOf(evidence, '7-cleanup-delete').httpStatus, 200);
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

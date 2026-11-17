/**
 * Unit tests of the live check L3.
 * The name guard, the evidence sanitizer, and the cleanup path run without network.
 * A fake Directory transport answers every request, so each test drives the whole check.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import '../../libs/application-contracts/test-register.mjs';

const {
  CATEGORY,
  CLIENT_ID_PLACEHOLDER,
  CUSTOMER_PLACEHOLDER,
  SCHEMA_SCOPE,
  SUBJECT_PLACEHOLDER,
  TEST_USER_PLACEHOLDER,
  USER_SCOPE,
  answerShape,
  requireCategory,
  runCheck,
  sanitizeEvidence,
  valuePatch,
} = await import('./user-values-live.mjs');

const BASE_URL = 'https://directory.fixture.invalid/admin/directory/v1';
const REAL_TEST_USER = 'demo-user@real-tenant.test';
const REAL_SUBJECT = 'admin@real-tenant.test';
const REAL_CUSTOMER = 'C0REALTENANT';
const REAL_CLIENT_ID = '987654321098765432109';
const OTHER_VALUE = 'other-category-value';
const credential = {
  subject: REAL_SUBJECT,
  serviceAccount: {
    client_id: REAL_CLIENT_ID,
    client_email: 'fixture@project.iam.gserviceaccount.com',
    private_key: 'synthetic',
    private_key_id: 'fixture',
  },
};

/** One Google answer that carries no body. */
class FakeAnswer extends Error {
  constructor(status, reason) {
    super(`HTTP ${status}`);
    this.response = { status, data: { error: { errors: [{ reason }] } } };
  }
}

/**
 * A fake Directory API. It answers the schema routes and the user routes of the check.
 * It records every call, so a test can prove which scope and which body left the script.
 */
function createDirectory(options = {}) {
  const state = {
    schema: null,
    values: {},
    calls: [],
    fieldSequence: 0,
    etagSequence: 0,
    deletesToRefuse: options.deletesToRefuse ?? 0,
  };
  const clone = (value) =>
    value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const nextField = (spec) => {
    state.fieldSequence += 1;
    return {
      fieldId: `field-${state.fieldSequence}`,
      fieldName: spec.fieldName,
      fieldType: spec.fieldType,
      displayName: spec.displayName,
      multiValued: spec.multiValued === true,
      indexed: spec.indexed !== false,
      readAccessType: spec.readAccessType ?? 'ADMINS_AND_SELF',
    };
  };
  const touch = () => {
    state.etagSequence += 1;
    state.schema.etag = `etag-${state.etagSequence}`;
  };
  if (options.startWithCategory === true) {
    state.schema = {
      schemaId: 'schema-seed',
      schemaName: CATEGORY,
      displayName: 'Seed category',
      etag: 'etag-0',
      fields: [
        nextField({
          fieldName: 'ccSeed',
          fieldType: 'STRING',
          displayName: 'Seed attribute',
        }),
      ],
    };
    state.values = { ...(options.startValues ?? {}) };
  }

  const userAnswer = () => {
    const schemas = {};
    if (state.schema !== null && Object.keys(state.values).length > 0)
      schemas[CATEGORY] = clone(state.values);
    schemas.OtherCategory = { secret: OTHER_VALUE };
    return {
      primaryEmail: 'fixture@example.test',
      name: { givenName: 'Fixture' },
      customSchemas: schemas,
    };
  };

  const applyPatch = (body) => {
    const names = Object.keys(body?.customSchemas ?? {});
    if (names.length !== 1 || names[0] !== CATEGORY)
      throw new FakeAnswer(400, 'invalid');
    const category = body.customSchemas[CATEGORY];
    if (category === null) {
      state.values = {};
      return;
    }
    if (state.schema === null) throw new FakeAnswer(404, 'notFound');
    for (const [name, value] of Object.entries(category)) {
      if (!state.schema.fields.some((field) => field.fieldName === name))
        throw new FakeAnswer(400, 'invalid');
      if (value === null) delete state.values[name];
      else state.values[name] = clone(value);
    }
  };

  const insert = (body) => {
    if (state.schema !== null) throw new FakeAnswer(409, 'duplicate');
    if (body?.schemaName !== CATEGORY) throw new FakeAnswer(400, 'invalid');
    state.schema = {
      schemaId: 'schema-live',
      schemaName: body.schemaName,
      displayName: body.displayName,
      etag: 'etag-0',
      fields: (body.fields ?? []).map(nextField),
    };
    touch();
  };

  const update = (body) => {
    if (state.schema === null) throw new FakeAnswer(404, 'notFound');
    const kept = body?.fields ?? [];
    const previous = state.schema.fields;
    const removed = previous.filter(
      (field) => !kept.some((entry) => entry.fieldId === field.fieldId),
    );
    state.schema.fields = kept.map((entry) => {
      const existing = previous.find(
        (field) => field.fieldId === entry.fieldId,
      );
      if (existing === undefined) return nextField(entry);
      if (entry.fieldType !== existing.fieldType)
        throw new FakeAnswer(400, 'invalid');
      return {
        ...existing,
        displayName: entry.displayName ?? existing.displayName,
        multiValued: entry.multiValued ?? existing.multiValued,
      };
    });
    // A removal deletes the stored value, and one value becomes a list of one entry.
    for (const field of removed) delete state.values[field.fieldName];
    for (const field of state.schema.fields) {
      const value = state.values[field.fieldName];
      if (field.multiValued && value !== undefined && !Array.isArray(value))
        state.values[field.fieldName] = [{ value }];
    }
    touch();
  };

  const removeCategory = () => {
    if (state.deletesToRefuse > 0) {
      state.deletesToRefuse -= 1;
      throw new FakeAnswer(400, 'invalid');
    }
    state.schema = null;
    state.values = {};
  };

  const request = (scope, options_) => {
    const url = new URL(options_.url);
    const method = options_.method ?? 'GET';
    state.calls.push({
      scope,
      method,
      path: url.pathname,
      data: clone(options_.data),
      params: { ...(options_.params ?? {}) },
    });
    if (url.pathname.startsWith('/admin/directory/v1/users/')) {
      if (scope !== USER_SCOPE) throw new FakeAnswer(403, 'forbidden');
      if (method === 'GET') return { status: 200, data: userAnswer() };
      if (method === 'PATCH') {
        applyPatch(options_.data);
        return { status: 200, data: userAnswer() };
      }
      throw new FakeAnswer(405, 'methodNotAllowed');
    }
    const collection = '/admin/directory/v1/customer/my_customer/schemas';
    if (url.pathname === collection) {
      if (scope !== SCHEMA_SCOPE) throw new FakeAnswer(403, 'forbidden');
      if (method !== 'POST') throw new FakeAnswer(405, 'methodNotAllowed');
      insert(options_.data);
      return { status: 200, data: clone(state.schema) };
    }
    if (url.pathname.startsWith(`${collection}/`)) {
      if (scope !== SCHEMA_SCOPE) throw new FakeAnswer(403, 'forbidden');
      if (method === 'GET') {
        if (state.schema === null) throw new FakeAnswer(404, 'notFound');
        return { status: 200, data: clone(state.schema) };
      }
      if (method === 'PUT') {
        update(options_.data);
        return { status: 200, data: clone(state.schema) };
      }
      if (method === 'DELETE') {
        removeCategory();
        return { status: 204, data: undefined };
      }
    }
    throw new FakeAnswer(404, 'notFound');
  };

  return {
    request,
    calls: state.calls,
    snapshot: () => ({
      schemaPresent: state.schema !== null,
      values: clone(state.values),
    }),
  };
}

async function runFlow(t, options = {}) {
  const directory = createDirectory(options);
  const dir = await mkdtemp(join(tmpdir(), 'cc-user-values-live-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const output = join(dir, 'evidence.json');
  const evidence = await runCheck(credential, {
    testUser: REAL_TEST_USER,
    output,
    baseUrl: BASE_URL,
    clientFor: async (scope) => ({
      request: (request) => directory.request(scope, request),
    }),
    now: () => new Date('2026-11-16T12:00:00.000Z'),
  });
  const written = JSON.parse(await readFile(output, 'utf8'));
  return { evidence, written, directory };
}

test('the category guard refuses every name but CcLiveValues', () => {
  assert.equal(requireCategory(CATEGORY), CATEGORY);
  for (const name of ['CcOther', 'cclivevalues', '', 'CcLiveValues2', null])
    assert.throws(() => requireCategory(name), /Refused/);
  assert.throws(() => valuePatch('CcOther', { ccText: 'x' }), /Refused/);
  assert.deepEqual(
    Object.keys(valuePatch(CATEGORY, { ccText: 'x' }).customSchemas),
    [CATEGORY],
  );
});

test('the PATCH answer shape holds no value', () => {
  assert.deepEqual(
    answerShape({
      primaryEmail: 'fixture@example.test',
      customSchemas: { OtherCategory: { secret: OTHER_VALUE } },
    }),
    { present: true, keys: ['customSchemas', 'primaryEmail'] },
  );
  assert.deepEqual(answerShape(undefined), { present: false });
});

test('the sanitizer replaces the customer, the subject, the user, and the client ID', () => {
  const encoded = encodeURIComponent(REAL_TEST_USER);
  const sanitized = sanitizeEvidence(
    {
      user: REAL_TEST_USER,
      encoded,
      subject: REAL_SUBJECT,
      customer: REAL_CUSTOMER,
      client: REAL_CLIENT_ID,
      list: [REAL_SUBJECT, REAL_TEST_USER],
    },
    {
      customerId: REAL_CUSTOMER,
      subject: REAL_SUBJECT,
      testUser: REAL_TEST_USER,
      clientId: REAL_CLIENT_ID,
    },
  );
  assert.equal(sanitized.user, TEST_USER_PLACEHOLDER);
  assert.equal(sanitized.encoded, encodeURIComponent(TEST_USER_PLACEHOLDER));
  assert.equal(sanitized.subject, SUBJECT_PLACEHOLDER);
  assert.equal(sanitized.customer, CUSTOMER_PLACEHOLDER);
  assert.equal(sanitized.client, CLIENT_ID_PLACEHOLDER);
  assert.deepEqual(sanitized.list, [
    SUBJECT_PLACEHOLDER,
    TEST_USER_PLACEHOLDER,
  ]);
  const text = JSON.stringify(sanitized);
  for (const value of [
    REAL_TEST_USER,
    REAL_SUBJECT,
    REAL_CUSTOMER,
    REAL_CLIENT_ID,
  ])
    assert.ok(
      !text.includes(value),
      `the sanitized evidence holds no ${value}`,
    );
});

test('the check records every step and leaves no category and no value', async (t) => {
  const { evidence, written, directory } = await runFlow(t);

  assert.equal(evidence.status, 'passed');
  assert.deepEqual(written, evidence);
  assert.equal(evidence.steps.length, 8);
  assert.deepEqual(
    evidence.steps.map((entry) => entry.action),
    [
      'schemas.get',
      'schemas.insert',
      'users.patch',
      'users.patch',
      'schemas.update',
      'schemas.update',
      'schemas.update',
      'schemas.delete',
    ],
  );
  for (const entry of evidence.steps) {
    assert.equal(typeof entry.method, 'string');
    assert.ok(Number.isInteger(entry.httpStatus));
    assert.equal(typeof entry.read.httpStatus, 'number');
  }
  assert.equal(evidence.findings.nullSingleValue.answer, 'deleted');
  assert.equal(evidence.findings.nullList.answer, 'deleted');
  assert.equal(evidence.findings.singleToMultiple.answer, 'list-of-one');
  assert.equal(evidence.findings.removedFieldValues.answer, 'deleted');
  assert.equal(evidence.findings.readdedField.answer, 'starts-empty');
  assert.equal(
    evidence.findings.deleteWithValues.answer,
    'deletes-category-and-values',
  );
  assert.equal(evidence.findings.phoneStoredAs.answer, '+1 555 0100');
  assert.deepEqual(evidence.findings.unknown, []);
  assert.equal(evidence.verification.category.httpStatus, 404);
  assert.equal(evidence.verification.user.categoryPresent, false);

  for (const call of directory.calls)
    assert.equal(
      call.scope,
      call.path.includes('/users/') ? USER_SCOPE : SCHEMA_SCOPE,
      `${call.method} ${call.path} carries its single scope`,
    );
  for (const call of directory.calls.filter(
    (entry) => entry.method === 'PATCH',
  ))
    assert.deepEqual(Object.keys(call.data.customSchemas), [CATEGORY]);
  for (const call of directory.calls.filter((entry) => entry.method === 'GET'))
    if (call.path.includes('/users/'))
      assert.deepEqual(call.params, {
        projection: 'custom',
        customFieldMask: CATEGORY,
      });

  const text = JSON.stringify(written);
  for (const value of [OTHER_VALUE, 'fixture@example.test', REAL_TEST_USER])
    assert.ok(!text.includes(value), `the evidence holds no ${value}`);
  assert.ok(text.includes(TEST_USER_PLACEHOLDER));
  assert.deepEqual(directory.snapshot(), { schemaPresent: false, values: {} });
});

test('an existing category stops the check before any write', async (t) => {
  const { evidence, written, directory } = await runFlow(t, {
    startWithCategory: true,
    startValues: { ccSeed: 'pre-existing-secret' },
  });

  assert.equal(evidence.status, 'stopped');
  assert.equal(evidence.outcome, 'already-exists');
  assert.equal(evidence.steps.length, 1);
  assert.equal(evidence.steps[0].httpStatus, 200);
  assert.equal(evidence.existingCategory.fields.length, 1);
  assert.deepEqual(
    directory.calls.filter((call) => call.method !== 'GET'),
    [],
  );
  assert.deepEqual(directory.snapshot(), {
    schemaPresent: true,
    values: { ccSeed: 'pre-existing-secret' },
  });
  assert.equal(typeof evidence.verification.skipped, 'string');
  assert.ok(!JSON.stringify(written).includes('pre-existing-secret'));
});

test('a refused delete leaves the cleanup to clear the value and delete the category', async (t) => {
  const { evidence, directory } = await runFlow(t, { deletesToRefuse: 1 });

  assert.equal(evidence.findings.deleteWithValues.answer, 'refused:invalid');
  assert.equal(evidence.status, 'passed');
  assert.ok(
    evidence.cleanup.some(
      (entry) => entry.action === 'users.patch' && entry.httpStatus === 200,
    ),
  );
  assert.ok(
    evidence.cleanup.some(
      (entry) => entry.action === 'schemas.delete' && entry.httpStatus === 204,
    ),
  );
  assert.deepEqual(directory.snapshot(), { schemaPresent: false, values: {} });
});

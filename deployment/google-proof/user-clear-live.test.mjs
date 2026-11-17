/**
 * Unit tests of the live check L4.
 * The name guard, the evidence sanitizer, the account comparison, and the cleanup path run
 * without network. A fake Directory transport answers every request, so each test drives the
 * whole check, including a lost answer and an interrupted read.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import '../../libs/application-contracts/test-register.mjs';

const {
  ATTRIBUTES,
  CATEGORY,
  CLIENT_ID_PLACEHOLDER,
  CUSTOMER_PLACEHOLDER,
  FIRST_VALUES,
  OMITTED_ATTRIBUTE,
  SCHEMA_SCOPE,
  SECOND_VALUES,
  SUBJECT_PLACEHOLDER,
  TEST_USER_PLACEHOLDER,
  USER_SCOPE,
  accountComparison,
  requireCategory,
  runCheck,
  sanitizeEvidence,
  valuesBody,
} = await import('./user-clear-live.mjs');

const BASE_URL = 'https://directory.fixture.invalid/admin/directory/v1';
const REAL_TEST_USER = 'sandbox-user@real-tenant.test';
const REAL_SUBJECT = 'admin@real-tenant.test';
const REAL_CUSTOMER = 'C0REALTENANT';
const REAL_CLIENT_ID = '987654321098765432109';
const ACCOUNT_GIVEN_NAME = 'Sandbox';
const ACCOUNT_FAMILY_NAME = 'Person';
const OTHER_VALUE = 'other-category-value';
const credential = {
  subject: REAL_SUBJECT,
  // The fake client answers every request, so the fixture needs no key material.
  serviceAccount: {
    client_id: REAL_CLIENT_ID,
    client_email: 'fixture@project.iam.gserviceaccount.com',
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
    schemaReads: 0,
    stale: null,
    staleReads: 0,
    deletesToRefuse: options.deletesToRefuse ?? 0,
    refuseInsert: options.refuseInsert ?? null,
    loseInsertAnswer: options.loseInsertAnswer === true,
    interruptSchemaReadAt: options.interruptSchemaReadAt ?? null,
    failUpdateOnce: options.failUpdateOnce ?? null,
    changeAccountOnUpdate: options.changeAccountOnUpdate === true,
    account: {
      kind: 'admin#directory#user',
      id: 'fixture-user-id',
      etag: '"fixture-etag"',
      primaryEmail: REAL_TEST_USER,
      name: { givenName: ACCOUNT_GIVEN_NAME, familyName: ACCOUNT_FAMILY_NAME },
      isAdmin: false,
      suspended: false,
      orgUnitPath: '/',
    },
  };
  const lagReads = options.lagReads ?? 0;
  const clone = (value) =>
    value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  /**
   * An exception whose `response` getter throws. It escapes the request guard, which
   * reads `error.response`, so it models an interrupted request that the guard cannot
   * classify into an HTTP answer.
   */
  const interrupt = () => {
    const interrupted = new Error('request interrupted');
    interrupted.code = 'ECONNRESET';
    Object.defineProperty(interrupted, 'response', {
      get() {
        const reset = new Error('request interrupted');
        reset.code = 'ECONNRESET';
        throw reset;
      },
    });
    return interrupted;
  };
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
          fieldName: 'One',
          fieldType: 'STRING',
          displayName: 'Seed attribute',
        }),
      ],
    };
    state.values = { ...(options.startValues ?? {}) };
  }

  const customAnswer = () => {
    const schemas = {};
    if (state.schema !== null && Object.keys(state.values).length > 0)
      schemas[CATEGORY] = clone(state.values);
    schemas.OtherCategory = { secret: OTHER_VALUE };
    return {
      ...clone(state.account),
      customSchemas: schemas,
    };
  };

  /** Model the delay of the live service: the next reads serve the state before the write. */
  const captureStale = () => {
    if (lagReads === 0) return;
    state.stale = {
      schema: clone(state.schema),
      values: clone(state.values),
    };
    state.staleReads = lagReads;
  };

  const staleCustomAnswer = () => {
    if (state.stale.schema === null) throw new FakeAnswer(400, 'invalid');
    const schemas = { OtherCategory: { secret: OTHER_VALUE } };
    if (Object.keys(state.stale.values).length > 0)
      schemas[CATEGORY] = state.stale.values;
    return {
      status: 200,
      data: { ...clone(state.account), customSchemas: schemas },
    };
  };

  const applyPatch = (body) => {
    const names = Object.keys(body?.customSchemas ?? {});
    if (names.length !== 1 || names[0] !== CATEGORY)
      throw new FakeAnswer(400, 'invalid');
    if (state.schema === null) throw new FakeAnswer(404, 'notFound');
    captureStale();
    for (const [name, value] of Object.entries(
      body.customSchemas[CATEGORY] ?? {},
    )) {
      if (!state.schema.fields.some((field) => field.fieldName === name))
        throw new FakeAnswer(400, 'invalid');
      // A PATCH keeps the value that the body names with null, as check L3 observed.
      if (value === null) continue;
      state.values[name] = clone(value);
    }
  };

  const applyUpdate = (body) => {
    const names = Object.keys(body?.customSchemas ?? {});
    if (names.length !== 1 || names[0] !== CATEGORY)
      throw new FakeAnswer(400, 'invalid');
    if (state.schema === null) throw new FakeAnswer(404, 'notFound');
    captureStale();
    const category = body.customSchemas[CATEGORY];
    if (category === null) {
      state.values = {};
    } else {
      for (const [name, value] of Object.entries(category)) {
        if (!state.schema.fields.some((field) => field.fieldName === name))
          throw new FakeAnswer(400, 'invalid');
        if (value === null) delete state.values[name];
        else state.values[name] = clone(value);
      }
    }
    if (state.changeAccountOnUpdate)
      state.account = {
        ...state.account,
        name: { ...state.account.name, givenName: 'Changed' },
      };
  };

  const insert = (body) => {
    if (state.schema !== null) throw new FakeAnswer(412, 'conditionNotMet');
    if (body?.schemaName !== CATEGORY) throw new FakeAnswer(400, 'invalid');
    const names = (body.fields ?? []).map((field) => field.fieldName);
    if (names.join(',') !== ATTRIBUTES.join(','))
      throw new FakeAnswer(400, 'invalid');
    captureStale();
    state.schema = {
      schemaId: 'schema-live',
      schemaName: body.schemaName,
      displayName: body.displayName,
      etag: 'etag-0',
      fields: (body.fields ?? []).map(nextField),
    };
    touch();
  };

  const removeCategory = () => {
    if (state.deletesToRefuse > 0) {
      state.deletesToRefuse -= 1;
      throw new FakeAnswer(400, 'invalid');
    }
    captureStale();
    state.schema = null;
    state.values = {};
  };

  const request = (scope, requestOptions) => {
    const url = new URL(requestOptions.url);
    const method = requestOptions.method ?? 'GET';
    state.calls.push({
      scope,
      method,
      path: url.pathname,
      data: clone(requestOptions.data),
      params: { ...(requestOptions.params ?? {}) },
    });
    if (url.pathname.startsWith('/admin/directory/v1/users/')) {
      if (scope !== USER_SCOPE) throw new FakeAnswer(403, 'forbidden');
      if (method === 'GET') {
        const projection = requestOptions.params?.projection;
        if (projection === 'basic')
          return { status: 200, data: clone(state.account) };
        if (
          projection !== 'custom' ||
          requestOptions.params?.customFieldMask !== CATEGORY
        )
          throw new FakeAnswer(400, 'invalid');
        if (state.staleReads > 0) {
          state.staleReads -= 1;
          return staleCustomAnswer();
        }
        // Google answers 400 invalid to a customFieldMask that names no category.
        if (state.schema === null) throw new FakeAnswer(400, 'invalid');
        return { status: 200, data: customAnswer() };
      }
      if (method === 'PATCH') {
        if (state.schema === null) throw new FakeAnswer(400, 'invalid');
        applyPatch(requestOptions.data);
        return { status: 200, data: customAnswer() };
      }
      if (method === 'PUT') {
        if (state.failUpdateOnce !== null) {
          const failure = state.failUpdateOnce;
          state.failUpdateOnce = null;
          throw new FakeAnswer(failure.status, failure.reason);
        }
        if (state.schema === null) throw new FakeAnswer(400, 'invalid');
        applyUpdate(requestOptions.data);
        return { status: 200, data: customAnswer() };
      }
      throw new FakeAnswer(405, 'methodNotAllowed');
    }
    const collection = '/admin/directory/v1/customer/my_customer/schemas';
    if (url.pathname === collection) {
      if (scope !== SCHEMA_SCOPE) throw new FakeAnswer(403, 'forbidden');
      if (method !== 'POST') throw new FakeAnswer(405, 'methodNotAllowed');
      if (state.refuseInsert !== null)
        throw new FakeAnswer(
          state.refuseInsert.status,
          state.refuseInsert.reason,
        );
      insert(requestOptions.data);
      if (state.loseInsertAnswer) {
        // The service applies the insert, then the answer is lost on the wire.
        const lost = new Error('socket hang up');
        lost.code = 'ECONNRESET';
        throw lost;
      }
      return { status: 200, data: clone(state.schema) };
    }
    if (url.pathname.startsWith(`${collection}/`)) {
      if (scope !== SCHEMA_SCOPE) throw new FakeAnswer(403, 'forbidden');
      if (method === 'GET') {
        state.schemaReads += 1;
        // The step 3 observation is the second schema read of a run.
        if (state.schemaReads === state.interruptSchemaReadAt)
          throw interrupt();
        if (state.staleReads > 0) {
          state.staleReads -= 1;
          if (state.stale.schema === null)
            throw new FakeAnswer(404, 'notFound');
          return { status: 200, data: clone(state.stale.schema) };
        }
        if (state.schema === null) throw new FakeAnswer(404, 'notFound');
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
  const dir = await mkdtemp(join(tmpdir(), 'cc-user-clear-live-'));
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
    sleep: () => Promise.resolve(),
    pollAttempts: 5,
  });
  const written = JSON.parse(await readFile(output, 'utf8'));
  return { evidence, written, directory };
}

test('the category guard refuses every name but CcLiveClear', () => {
  assert.equal(requireCategory(CATEGORY), CATEGORY);
  for (const name of ['CcOther', 'ccliveclear', '', 'CcLiveClear2', null])
    assert.throws(() => requireCategory(name), /Refused/);
  assert.throws(() => valuesBody('CcOther', { One: 'x' }), /Refused/);
  assert.deepEqual(
    Object.keys(valuesBody(CATEGORY, { One: 'x' }).customSchemas),
    [CATEGORY],
  );
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

test('the account comparison answers yes or no per field and copies no value', () => {
  const before = {
    primaryEmail: REAL_TEST_USER,
    name: { givenName: ACCOUNT_GIVEN_NAME },
    suspended: false,
    lastLoginTime: '2026-11-16T00:00:00.000Z',
  };
  const after = {
    primaryEmail: REAL_TEST_USER,
    name: { givenName: ACCOUNT_GIVEN_NAME },
    suspended: true,
    lastLoginTime: '2026-11-16T00:00:00.000Z',
    recoveryEmail: 'recovery@example.test',
  };
  assert.deepEqual(accountComparison(before, before), {
    lastLoginTime: 'yes',
    name: 'yes',
    primaryEmail: 'yes',
    suspended: 'yes',
  });
  assert.deepEqual(accountComparison(before, after), {
    lastLoginTime: 'yes',
    name: 'yes',
    primaryEmail: 'yes',
    recoveryEmail: 'no',
    suspended: 'no',
  });
  assert.deepEqual(accountComparison(null, after), {});
  const text = JSON.stringify(accountComparison(before, after));
  for (const value of [REAL_TEST_USER, ACCOUNT_GIVEN_NAME, '2026-11-16'])
    assert.ok(!text.includes(value), `the comparison holds no ${value}`);
});

test('the check records every step and leaves no category and no value', async (t) => {
  const { evidence, written, directory } = await runFlow(t);

  assert.equal(evidence.status, 'passed');
  assert.equal(evidence.outcome, 'completed');
  assert.deepEqual(written, evidence);
  assert.equal(evidence.steps.length, 8);
  assert.deepEqual(
    evidence.steps.map((entry) => entry.action),
    [
      'schemas.get',
      'users.get',
      'schemas.insert',
      'users.patch',
      'users.update',
      'users.get',
      'schemas.delete',
      'schemas.insert',
    ],
  );
  for (const entry of evidence.steps) {
    assert.equal(typeof entry.method, 'string');
    assert.ok(Number.isInteger(entry.httpStatus));
  }
  assert.equal(evidence.findings.updateAnswerShape.answer.present, true);
  assert.ok(
    evidence.findings.updateAnswerShape.answer.keys.includes('customSchemas'),
  );
  assert.equal(evidence.findings.setValue.answer, 'set');
  assert.equal(evidence.findings.setValue.stored.value, SECOND_VALUES.One);
  assert.equal(evidence.findings.nullSingleValue.answer, 'cleared');
  assert.equal(evidence.findings.nullList.answer, 'cleared');
  assert.equal(evidence.findings.omittedAttribute.answer, 'kept');
  assert.equal(
    evidence.findings.omittedAttribute.stored.value,
    FIRST_VALUES[OMITTED_ATTRIBUTE],
  );
  assert.equal(evidence.findings.accountFields.answer, 'all-equal');
  assert.deepEqual(evidence.accountFieldsChanged, []);
  assert.equal(
    Object.values(evidence.accountComparison).every((value) => value === 'yes'),
    true,
  );
  assert.equal(
    evidence.findings.deleteWithValues.answer,
    'accepted-category-gone',
  );
  assert.equal(evidence.findings.recreatedCategory.answer, 'starts-empty');
  assert.deepEqual(evidence.findings.unknown, []);
  assert.equal(evidence.verification.category.httpStatus, 404);
  assert.equal(evidence.recreate.oldValuesReturned, 'no');

  // Every step 6 row holds a value answer and a change time in milliseconds.
  for (const name of ATTRIBUTES) {
    const row = evidence.steps.find((entry) => entry.step === 6).observed[name];
    assert.equal(typeof row.holdsValue, 'boolean');
    assert.ok(
      row.changedAfterMs === null || typeof row.changedAfterMs === 'number',
      `the change time of ${name} is a number or null`,
    );
  }
  assert.equal(
    evidence.steps.find((entry) => entry.step === 6).observed.Two.holdsValue,
    false,
  );
  assert.equal(
    evidence.steps.find((entry) => entry.step === 6).observed.Three.holdsValue,
    true,
  );

  for (const call of directory.calls)
    assert.equal(
      call.scope,
      call.path.includes('/users/') ? USER_SCOPE : SCHEMA_SCOPE,
      `${call.method} ${call.path} carries its single scope`,
    );
  for (const call of directory.calls.filter(
    (entry) => entry.method === 'PATCH' || entry.method === 'PUT',
  ))
    assert.deepEqual(Object.keys(call.data.customSchemas), [CATEGORY]);
  const step5 = directory.calls.find(
    (call) =>
      call.method === 'PUT' && call.data.customSchemas[CATEGORY] !== null,
  );
  assert.deepEqual(step5.data, {
    customSchemas: { [CATEGORY]: SECOND_VALUES },
  });
  assert.equal(
    Object.keys(step5.data.customSchemas[CATEGORY]).includes('Three'),
    false,
  );
  for (const call of directory.calls.filter((entry) => entry.method === 'GET'))
    if (call.path.includes('/users/'))
      assert.ok(
        call.params.projection === 'basic' ||
          (call.params.projection === 'custom' &&
            call.params.customFieldMask === CATEGORY),
      );

  const text = JSON.stringify(written);
  for (const value of [
    ACCOUNT_GIVEN_NAME,
    ACCOUNT_FAMILY_NAME,
    REAL_TEST_USER,
    OTHER_VALUE,
  ])
    assert.ok(!text.includes(value), `the evidence holds no ${value}`);
  assert.ok(text.includes(TEST_USER_PLACEHOLDER));
  assert.deepEqual(directory.snapshot(), { schemaPresent: false, values: {} });
});

test('a failed users.update still clears the value and deletes the category', async (t) => {
  const { evidence, directory } = await runFlow(t, {
    failUpdateOnce: { status: 500, reason: 'backendError' },
  });

  assert.equal(evidence.outcome, 'update-failed');
  assert.equal(evidence.status, 'failed');
  assert.equal(
    evidence.steps.find((entry) => entry.step === 5).httpStatus,
    500,
  );
  assert.equal(
    evidence.findings.nullSingleValue.answer,
    'refused:backendError',
  );
  assert.equal(evidence.findings.nullList.answer, 'refused:backendError');
  assert.ok(
    evidence.cleanup.some(
      (entry) => entry.action === 'users.update' && entry.httpStatus === 200,
    ),
    'the cleanup clears the value with users.update',
  );
  assert.ok(
    evidence.cleanup.some(
      (entry) => entry.action === 'schemas.delete' && entry.httpStatus === 204,
    ),
    'the cleanup deletes the category',
  );
  const clear = directory.calls.find(
    (call) =>
      call.method === 'PUT' && call.data.customSchemas[CATEGORY] === null,
  );
  assert.ok(clear, 'the cleanup sends customSchemas.CcLiveClear=null');
  assert.deepEqual(Object.keys(clear.data.customSchemas), [CATEGORY]);
  assert.equal(evidence.verification.category.httpStatus, 404);
  assert.deepEqual(directory.snapshot(), { schemaPresent: false, values: {} });
});

test('a lost insert answer still runs cleanup and verifies absence', async (t) => {
  const { evidence, directory } = await runFlow(t, { loseInsertAnswer: true });

  // The POST landed, but its answer never arrived. The run failed; the category is gone.
  assert.equal(evidence.outcome, 'insert-failed');
  assert.equal(evidence.status, 'failed');
  assert.equal(evidence.steps[2].httpStatus, null);
  assert.equal(evidence.steps[2].errorReason, 'ECONNRESET');
  assert.ok(
    evidence.cleanup.some(
      (entry) => entry.action === 'schemas.delete' && entry.httpStatus === 204,
    ),
    'the cleanup deletes the category that the lost POST created',
  );
  assert.equal(evidence.verification.category.httpStatus, 404);
  assert.equal(evidence.verification.skipped, undefined);
  assert.deepEqual(directory.snapshot(), { schemaPresent: false, values: {} });
});

test('an interrupted insert observation still runs cleanup and verifies absence', async (t) => {
  const { evidence, directory } = await runFlow(t, {
    interruptSchemaReadAt: 2,
  });

  // The insert answered; the observation that follows it threw before step 4.
  assert.equal(evidence.failure, 'ECONNRESET');
  assert.equal(evidence.status, 'failed');
  assert.ok(
    evidence.steps.every((entry) => entry.step <= 3),
    'the run stops inside step 3',
  );
  assert.ok(
    evidence.cleanup.some(
      (entry) => entry.action === 'schemas.delete' && entry.httpStatus === 204,
    ),
    'the cleanup deletes the category that the interrupted insert created',
  );
  assert.equal(evidence.verification.category.httpStatus, 404);
  assert.deepEqual(directory.snapshot(), { schemaPresent: false, values: {} });
});

test('an interrupted cleanup probe still deletes the category', async (t) => {
  const { evidence, directory } = await runFlow(t, {
    interruptSchemaReadAt: 4,
  });

  // The cleanup probe threw, so its answer is unknown. The delete must still run.
  assert.equal(evidence.cleanupFailure, undefined);
  assert.ok(
    evidence.cleanup.some(
      (entry) =>
        entry.action === 'schemas.get' && entry.failed === 'ECONNRESET',
    ),
    'the cleanup records the interrupted probe',
  );
  assert.ok(
    evidence.cleanup.some(
      (entry) => entry.action === 'schemas.delete' && entry.httpStatus === 204,
    ),
    'the cleanup deletes the category after the interrupted probe',
  );
  assert.equal(evidence.verification.category.httpStatus, 404);
  assert.equal(evidence.verification.category.present, false);
  assert.deepEqual(directory.snapshot(), { schemaPresent: false, values: {} });
});

test('an existing category stops the check before any write', async (t) => {
  const { evidence, written, directory } = await runFlow(t, {
    startWithCategory: true,
    startValues: { One: 'pre-existing-secret' },
  });

  assert.equal(evidence.status, 'stopped');
  assert.equal(evidence.outcome, 'already-exists');
  assert.equal(evidence.steps.length, 1);
  assert.equal(evidence.steps[0].httpStatus, 200);
  assert.deepEqual(
    directory.calls.filter((call) => call.method !== 'GET'),
    [],
  );
  assert.deepEqual(directory.snapshot(), {
    schemaPresent: true,
    values: { One: 'pre-existing-secret' },
  });
  assert.equal(typeof evidence.verification.skipped, 'string');
  assert.ok(!JSON.stringify(written).includes('pre-existing-secret'));
});

test('the check waits for each write to become visible before the next step', async (t) => {
  const { evidence } = await runFlow(t, { lagReads: 2 });

  assert.equal(evidence.status, 'passed');
  assert.equal(evidence.findings.nullSingleValue.answer, 'cleared');
  assert.equal(evidence.findings.nullList.answer, 'cleared');
  assert.equal(evidence.findings.omittedAttribute.answer, 'kept');
  assert.ok(evidence.steps[3].settledAfterMs > 0);
  assert.ok(evidence.steps[3].read.attributes.One !== undefined);
  assert.ok(
    evidence.steps.find((entry) => entry.step === 6).waitedAfterMs > 0,
    'the step 6 poll waited for the cleared values',
  );
});

test('a changed account field is recorded as no and its value stays out', async (t) => {
  const { evidence, written } = await runFlow(t, {
    changeAccountOnUpdate: true,
  });

  assert.equal(evidence.status, 'passed');
  assert.equal(evidence.accountComparison.name, 'no');
  assert.deepEqual(evidence.accountFieldsChanged, ['name']);
  assert.equal(evidence.findings.accountFields.answer, 'changed:name');
  const text = JSON.stringify(written);
  for (const value of ['"Changed"', ACCOUNT_GIVEN_NAME, ACCOUNT_FAMILY_NAME])
    assert.ok(!text.includes(value), `the evidence holds no ${value}`);
});

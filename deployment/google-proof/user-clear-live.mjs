/**
 * Live write check L4 of the custom user attributes design (section 6, K30).
 * Run: node --import ./libs/application-contracts/test-register.mjs deployment/google-proof/user-clear-live.mjs <key-file> <subject> <client-id> <test-user>
 *
 * Two single-scope clients: the schema scope for the category and the user scope for the values.
 * The check touches only the category CcLiveClear and only the test user of its argument.
 * It sends one users.update body and records whether the null values cleared and after how many
 * seconds, whether the left-out attribute kept its value, and the shape of the answer.
 * It compares the account fields of two projection=basic reads and stores no account field value.
 * It deletes the category, inserts it again, and records whether an old value came back.
 * It writes sanitized evidence under deployment/evidence/ and leaves no category and no value.
 */
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { JWT, OAuth2Client } from 'google-auth-library';
import { validateServiceAccount } from '@campus/google-connection';
import {
  CLIENT_ID_PLACEHOLDER,
  CUSTOMER_PLACEHOLDER,
  SUBJECT_PLACEHOLDER,
  TEST_USER_PLACEHOLDER,
  answerShape,
  describeValue,
  describeValues,
  sanitizeEvidence,
} from './user-values-live.mjs';

export const usage =
  'Usage: node --import ./libs/application-contracts/test-register.mjs deployment/google-proof/user-clear-live.mjs <key-file> <subject> <client-id> <test-user>';

/** The only category this check reads or writes. Every schema name goes through the guard. */
export const CATEGORY = 'CcLiveClear';
export const SCHEMA_SCOPE =
  'https://www.googleapis.com/auth/admin.directory.userschema';
export const USER_SCOPE =
  'https://www.googleapis.com/auth/admin.directory.user';
/** The schema path accepts the alias of the authenticated customer. No tenant value is stored. */
const CUSTOMER = 'my_customer';
const DIRECTORY = 'https://admin.googleapis.com/admin/directory/v1';
/** The four attributes that step 3 inserts and step 5 partially clears. */
export const FIELD_SPECS = [
  { fieldName: 'One', fieldType: 'STRING', displayName: 'CC one' },
  { fieldName: 'Two', fieldType: 'STRING', displayName: 'CC two' },
  { fieldName: 'Three', fieldType: 'STRING', displayName: 'CC three' },
  {
    fieldName: 'List',
    fieldType: 'STRING',
    displayName: 'CC list',
    multiValued: true,
  },
];
export const ATTRIBUTES = FIELD_SPECS.map((field) => field.fieldName);
/** The values that step 4 sets. */
export const FIRST_VALUES = {
  One: 'L4 one',
  Two: 'L4 two',
  Three: 'L4 three',
  List: [{ value: 'L4 alpha' }, { value: 'L4 beta' }],
};
/** The one users.update body of step 5. `Three` stays out of it. */
export const SECOND_VALUES = { One: 'L4 one changed', Two: null, List: null };
/** The attribute that the step 5 body leaves out. */
export const OMITTED_ATTRIBUTE = 'Three';

// The sanitizer, the value shape, and the placeholders come from the check L3 module.
export {
  CLIENT_ID_PLACEHOLDER,
  CUSTOMER_PLACEHOLDER,
  SUBJECT_PLACEHOLDER,
  TEST_USER_PLACEHOLDER,
  answerShape,
  describeValue,
  describeValues,
  sanitizeEvidence,
};

/** Refuse every schema name but the one category this check owns. */
export function requireCategory(name) {
  if (name !== CATEGORY)
    throw new Error(
      `Refused: check L4 touches only the category ${CATEGORY}, not ${String(name)}.`,
    );
  return name;
}

/** The path of the schemas collection of the authenticated customer. */
export function schemasUrl(baseUrl) {
  return `${baseUrl}/customer/${CUSTOMER}/schemas`;
}

/** The path of one schema. The guard refuses every other name. */
export function schemaUrl(baseUrl, name) {
  return `${schemasUrl(baseUrl)}/${encodeURIComponent(requireCategory(name))}`;
}

/** The path of one user. */
export function userUrl(baseUrl, testUser) {
  return `${baseUrl}/users/${encodeURIComponent(testUser)}`;
}

/** A user write body. It names only the category of the guard. */
export function valuesBody(category, values) {
  return { customSchemas: { [requireCategory(category)]: values } };
}

/** The category body of step 3 and of the second insert of step 8. */
export function schemaInsertBody() {
  return {
    schemaName: requireCategory(CATEGORY),
    displayName: 'CC live clear',
    fields: FIELD_SPECS.map((field) => ({
      fieldName: field.fieldName,
      fieldType: field.fieldType,
      displayName: field.displayName,
      multiValued: field.multiValued === true,
      indexed: true,
      readAccessType: 'ADMINS_AND_SELF',
    })),
  };
}

/**
 * Compare each account field of two projection=basic reads.
 * The answer holds only `yes` or `no` for each field name, never a field value.
 */
export function accountComparison(before, after) {
  const isRecord = (value) =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!isRecord(before) || !isRecord(after)) return {};
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return Object.fromEntries(
    [...names]
      .sort()
      .map((name) => [
        name,
        isDeepStrictEqual(before[name], after[name]) ? 'yes' : 'no',
      ]),
  );
}

/** The schema without its values. A schema holds none. It records no Google-issued ID. */
export function summarizeSchema(schema) {
  if (schema === null || typeof schema !== 'object') return null;
  return {
    schemaName: schema.schemaName ?? null,
    displayName: schema.displayName ?? null,
    fields: Array.isArray(schema.fields)
      ? schema.fields.map((field) => ({
          fieldName: field.fieldName,
          fieldType: field.fieldType,
          multiValued: field.multiValued === true,
        }))
      : [],
  };
}

function isOk(result) {
  return (
    Number.isInteger(result.httpStatus) &&
    result.httpStatus >= 200 &&
    result.httpStatus < 300
  );
}

function isRefusal(status) {
  return Number.isInteger(status) && status >= 400 && status < 500;
}

function httpStatusOf(response) {
  return Number.isInteger(response?.status) ? response.status : null;
}

/** The Google error reason of one failed request. No header and no body is copied. */
function reasonOf(error) {
  const body = error?.response?.data;
  const first = body?.error?.errors?.[0]?.reason;
  if (typeof first === 'string') return first;
  if (typeof body?.error?.reason === 'string') return body.error.reason;
  if (typeof body?.error === 'string') return body.error;
  if (typeof error?.code === 'string') return error.code;
  return null;
}

function failureCode(error) {
  if (error && typeof error === 'object' && typeof error.code === 'string')
    return error.code;
  if (error instanceof Error) return error.name;
  return 'unknown';
}

function revision() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
}

/**
 * One request. A write is never retried: a repeated insert or delete would hide an answer.
 * Each call carries its own timeout, so a cleanup call never waits on an earlier deadline.
 */
async function perform(client, request, timeout) {
  const started = Date.now();
  try {
    const response = await client.request({
      url: request.url,
      method: request.method,
      ...(request.data === undefined ? {} : { data: request.data }),
      ...(request.params === undefined ? {} : { params: request.params }),
      timeout,
      retry: false,
    });
    return {
      httpStatus: httpStatusOf(response),
      body: response?.data,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    return {
      httpStatus: httpStatusOf(error?.response),
      errorReason: reasonOf(error),
      durationMs: Date.now() - started,
    };
  }
}

/**
 * One single-scope client. It asks for one scope and refuses a token that carries another.
 * The script builds each request itself, so the application allowlist of provider.ts does not apply.
 */
async function singleScopeClient(credential, scope) {
  const issuer = new JWT({ subject: credential.subject, scopes: [scope] });
  // The validated account carries the email, the key, and the key ID of the service account.
  issuer.fromJSON(credential.serviceAccount);
  const { token } = await issuer.getAccessToken();
  if (!token) throw new Error('credential-rejected');
  const info = await issuer.getTokenInfo(token);
  if (info.scopes.length !== 1 || info.scopes[0] !== scope)
    throw new Error('scope-mismatch');
  if (!Number.isFinite(info.expiry_date) || info.expiry_date <= Date.now())
    throw new Error('invalid-response');
  const client = new OAuth2Client();
  client.eagerRefreshThresholdMillis = 0;
  client.setCredentials({ access_token: token, expiry_date: info.expiry_date });
  return client;
}

/** The observed answer of one users.get with projection=custom. */
export function observeCustom(result) {
  const observation = {
    httpStatus: result.httpStatus,
    ...(result.errorReason ? { errorReason: result.errorReason } : {}),
  };
  if (!isOk(result)) return observation;
  const category = result.body?.customSchemas?.[CATEGORY];
  if (
    category === null ||
    typeof category !== 'object' ||
    Array.isArray(category) ||
    Object.keys(category).length === 0
  )
    return { ...observation, categoryPresent: false, attributes: {} };
  const attributes = Object.fromEntries(
    Object.entries(category).map(([name, value]) => [
      name,
      describeValue(value),
    ]),
  );
  return { ...observation, categoryPresent: true, attributes };
}

/** The fields and status of one projection=basic read. It never copies a value. */
export function observeBasic(result) {
  const observation = {
    httpStatus: result.httpStatus,
    ...(result.errorReason ? { errorReason: result.errorReason } : {}),
  };
  if (!isOk(result)) return observation;
  return {
    ...observation,
    present: true,
    fields:
      result.body !== null &&
      typeof result.body === 'object' &&
      !Array.isArray(result.body)
        ? Object.keys(result.body).sort()
        : [],
  };
}

/** The seconds and the milliseconds of one wait. */
function seconds(ms) {
  return ms === null ? null : Math.round(ms / 100) / 10;
}

const limitations = [
  'The check touches only the category CcLiveClear and only the test user of its argument.',
  'Each users.get uses projection=custom and customFieldMask=CcLiveClear, except the two projection=basic reads of step 2 and step 6. The basic reads record no value.',
  'The answer settles one test user of one domain. It settles no other domain and no other user.',
  'The check records only values that it writes to CcLiveClear. It reads no value of another category.',
  'The evidence holds each account field name and a yes or no, never a field value.',
  'A customFieldMask that names no category answers 400 invalid, so the final read cannot show the values of the deleted category.',
  'The step 5 users.update body names only customSchemas.CcLiveClear. The check never writes an account field.',
  'Each run needs the owner yes named in the card, because the standing authorization permits no Google data mutation.',
];

/**
 * Run the steps of the K30 plan and write the sanitized evidence.
 * `options.clientFor`, `options.baseUrl`, `options.output`, and `options.now` exist for the test.
 */
export async function runCheck(credential, options = {}) {
  const testUser = options.testUser;
  if (typeof testUser !== 'string' || !testUser.includes('@'))
    throw new Error('The test user address is missing.');
  const now = options.now ?? (() => new Date());
  const recordedAt = now().toISOString();
  const runDate = recordedAt.slice(0, 10);
  const baseUrl = options.baseUrl ?? DIRECTORY;
  const output =
    options.output ?? `deployment/evidence/user-clear-live-l4-${runDate}.json`;
  const clientFor =
    options.clientFor ?? ((scope) => singleScopeClient(credential, scope));
  /** The step 6 poll reads at once and then once a second for up to 60 seconds. */
  const pollAttempts = options.pollAttempts ?? 60;
  const pollDelayMs = options.pollDelayMs ?? 1000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 25_000;
  const cleanupTimeoutMs = options.cleanupTimeoutMs ?? 20_000;
  const sleep =
    options.sleep ??
    ((milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const evidence = {
    schemaVersion: 1,
    check: 'L4',
    status: 'failed',
    outcome: null,
    recordedAt,
    sourceRevision: revision(),
    nodeVersion: process.version,
    customerId: CUSTOMER_PLACEHOLDER,
    subject: SUBJECT_PLACEHOLDER,
    testUser: TEST_USER_PLACEHOLDER,
    clientId: CLIENT_ID_PLACEHOLDER,
    category: CATEGORY,
    scopes: [SCHEMA_SCOPE, USER_SCOPE],
    command: usage.replace('Usage: ', ''),
    steps: [],
    accountComparison: null,
    accountFieldsChanged: [],
    findings: {},
    cleanup: [],
    verification: {},
    limitations,
    durationMs: 0,
  };
  const state = {
    createAttempted: false,
    created: false,
    inserted: false,
    accountBefore: null,
    step4Attributes: null,
    updateAnsweredAt: null,
  };
  const startedAt = Date.now();
  const schemaClient = await clientFor(SCHEMA_SCOPE);
  const userClient = await clientFor(USER_SCOPE);
  const userEndpoint = userUrl(baseUrl, testUser);

  const call = (client, request, timeout = requestTimeoutMs) =>
    perform(client, request, timeout);
  const readSchema = () =>
    call(schemaClient, { method: 'GET', url: schemaUrl(baseUrl, CATEGORY) });
  const readCustom = () =>
    call(userClient, {
      method: 'GET',
      url: userEndpoint,
      params: { projection: 'custom', customFieldMask: CATEGORY },
    });
  const observeCustomNow = async () => observeCustom(await readCustom());
  const readBasic = () =>
    call(userClient, {
      method: 'GET',
      url: userEndpoint,
      params: { projection: 'basic' },
    });

  /** One bounded poll. It reads at once, then after each delay, and returns the first read. */
  const poll = async (read, settles) => {
    let observation = await read();
    const immediate = observation;
    let waitedMs = 0;
    for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
      if (settles(observation)) break;
      await sleep(pollDelayMs);
      waitedMs += pollDelayMs;
      observation = await read();
    }
    return {
      immediate,
      observation,
      waitedMs,
      settled: settles(observation),
    };
  };

  const record = (number, action, method, result, extra = {}) => {
    const entry = {
      step: number,
      action,
      method,
      httpStatus: result.httpStatus,
      ...(result.errorReason ? { errorReason: result.errorReason } : {}),
      ...extra,
    };
    evidence.steps.push(entry);
    return entry;
  };

  const runSteps = async () => {
    // Step 1. A category that already exists stops the check before any write.
    const first = await readSchema();
    const firstEntry = record(1, 'schemas.get', 'GET', first);
    if (isOk(first)) {
      evidence.outcome = 'already-exists';
      firstEntry.answered = summarizeSchema(first.body);
      evidence.existingCategory = summarizeSchema(first.body);
      return;
    }
    if (first.httpStatus !== 404) {
      evidence.outcome = 'category-read-failed';
      return;
    }

    // Step 2. Keep the account fields in memory for the comparison of step 6.
    const before = await readBasic();
    const beforeEntry = record(2, 'users.get', 'GET', before, {
      projection: 'basic',
      answered: observeBasic(before),
    });
    if (
      !isOk(before) ||
      before.body === null ||
      typeof before.body !== 'object'
    ) {
      evidence.outcome = 'account-read-failed';
      return;
    }
    state.accountBefore = before.body;
    beforeEntry.accountFieldCount = Object.keys(before.body).length;

    // Step 3. Insert the category. Track the attempt before the request leaves, because a
    // lost answer or a failed observation may still have created it.
    state.createAttempted = true;
    const inserted = await call(schemaClient, {
      method: 'POST',
      url: schemasUrl(baseUrl),
      data: schemaInsertBody(),
    });
    const insertEntry = record(3, 'schemas.insert', 'POST', inserted, {
      requestedFields: FIELD_SPECS.map((field) => ({
        fieldName: field.fieldName,
        fieldType: field.fieldType,
        displayName: field.displayName,
        multiValued: field.multiValued === true,
      })),
    });
    if (!isOk(inserted)) {
      // A 4xx refusal proves that this run created nothing. A 5xx answer or a lost
      // answer does not, so cleanup still probes and removes the category.
      if (isRefusal(inserted.httpStatus)) state.createAttempted = false;
      else state.inserted = true;
      evidence.outcome = 'insert-failed';
      return;
    }
    state.created = true;
    state.inserted = true;
    insertEntry.answered = summarizeSchema(inserted.body);
    const visible = await poll(
      () => readSchema(),
      (observation) => isOk(observation),
    );
    insertEntry.settledAfterMs = visible.waitedMs;
    insertEntry.read = {
      httpStatus: visible.observation.httpStatus,
      ...(visible.observation.errorReason
        ? { errorReason: visible.observation.errorReason }
        : {}),
      present: isOk(visible.observation),
    };
    if (!visible.settled) {
      evidence.outcome = 'insert-not-visible';
      return;
    }

    // Step 4. Set the three single values and the two-entry list.
    const patched = await call(userClient, {
      method: 'PATCH',
      url: userEndpoint,
      data: valuesBody(CATEGORY, FIRST_VALUES),
    });
    const patchEntry = record(4, 'users.patch', 'PATCH', patched, {
      requested: describeValues(FIRST_VALUES),
    });
    if (!isOk(patched)) {
      evidence.outcome = 'value-write-failed';
      return;
    }
    patchEntry.answer = answerShape(patched.body);
    const written = describeValues(FIRST_VALUES);
    const stored = await poll(
      () => observeCustomNow(),
      (observation) =>
        ATTRIBUTES.every((name) =>
          isDeepStrictEqual(observation.attributes?.[name], written[name]),
        ),
    );
    patchEntry.immediate = stored.immediate;
    patchEntry.read = stored.observation;
    patchEntry.settledAfterMs = stored.waitedMs;
    patchEntry.settled = stored.settled;
    state.step4Attributes =
      stored.observation.attributes ?? describeValues(FIRST_VALUES);
    evidence.storedValues = stored.observation.attributes ?? null;
    if (!stored.settled) {
      evidence.outcome = 'value-write-not-visible';
      return;
    }

    // Step 5. One users.update body: One a new value, Two and List null, Three left out.
    const updated = await call(userClient, {
      method: 'PUT',
      url: userEndpoint,
      data: valuesBody(CATEGORY, SECOND_VALUES),
    });
    state.updateAnsweredAt = Date.now();
    const updateEntry = record(5, 'users.update', 'PUT', updated, {
      requested: describeValues(SECOND_VALUES),
      omitted: [OMITTED_ATTRIBUTE],
    });
    updateEntry.answer = answerShape(updated.body);
    if (!isOk(updated)) {
      evidence.outcome = 'update-failed';
      return;
    }

    // Step 6. Read at once, then once a second for up to 60 seconds, until Two and List
    // are absent. Record for each attribute whether it holds a value and the change time.
    const baseline = state.step4Attributes;
    const changedAfterMs = Object.fromEntries(
      ATTRIBUTES.map((name) => [name, null]),
    );
    const markChanges = (observation) => {
      const at = Date.now() - state.updateAnsweredAt;
      for (const name of ATTRIBUTES) {
        if (changedAfterMs[name] !== null) continue;
        if (!isDeepStrictEqual(baseline[name], observation.attributes?.[name]))
          changedAfterMs[name] = at;
      }
    };
    const cleared = (observation) =>
      observation.attributes?.Two === undefined &&
      observation.attributes?.List === undefined;
    let observation = await observeCustomNow();
    const immediate = observation;
    markChanges(observation);
    let waitedMs = 0;
    for (
      let attempt = 0;
      attempt < pollAttempts && !cleared(observation);
      attempt += 1
    ) {
      await sleep(pollDelayMs);
      waitedMs += pollDelayMs;
      observation = await observeCustomNow();
      markChanges(observation);
    }
    const attributes = observation.attributes ?? {};
    const row = (name) => {
      const changed = changedAfterMs[name];
      return {
        holdsValue: attributes[name] !== undefined,
        stored: attributes[name] ?? null,
        changedAfterMs: changed,
        changedAfterSeconds: seconds(changed),
      };
    };
    const clearEntry = record(6, 'users.get', 'GET', observation, {
      projection: 'custom',
      customFieldMask: CATEGORY,
      immediate,
      read: observation,
      waitedAfterMs: waitedMs,
      settledAfterMs: Date.now() - state.updateAnsweredAt,
      settled: cleared(observation),
      observed: Object.fromEntries(ATTRIBUTES.map((name) => [name, row(name)])),
    });

    // Step 6, second read. Compare the account fields and record only yes or no.
    const after = await readBasic();
    clearEntry.account = observeBasic(after);
    if (!isOk(after)) {
      evidence.outcome = 'account-read-failed';
      return;
    }
    evidence.accountComparison = accountComparison(
      state.accountBefore,
      after.body,
    );
    evidence.accountFieldsChanged = Object.entries(evidence.accountComparison)
      .filter(([, answer]) => answer === 'no')
      .map(([name]) => name);

    // Step 7. Delete the category while One and Three still hold values.
    const heldBeforeDelete = {
      One: attributes.One !== undefined,
      [OMITTED_ATTRIBUTE]: attributes[OMITTED_ATTRIBUTE] !== undefined,
    };
    const removed = await call(schemaClient, {
      method: 'DELETE',
      url: schemaUrl(baseUrl, CATEGORY),
    });
    const deleteEntry = record(7, 'schemas.delete', 'DELETE', removed, {
      heldBeforeDelete,
    });
    if (!isOk(removed)) {
      evidence.outcome = 'delete-failed';
      return;
    }
    const gone = await poll(
      () => readSchema(),
      (result) => result.httpStatus === 404,
    );
    deleteEntry.settledAfterMs = gone.waitedMs;
    deleteEntry.read = {
      httpStatus: gone.observation.httpStatus,
      ...(gone.observation.errorReason
        ? { errorReason: gone.observation.errorReason }
        : {}),
      present: isOk(gone.observation),
    };
    if (!gone.settled) {
      evidence.outcome = 'delete-not-settled';
      return;
    }
    state.created = false;
    state.createAttempted = false;

    // Step 8. Insert the same name and the same four attributes again. Read the user with
    // the mask and record whether any old value came back.
    state.createAttempted = true;
    const reinserted = await call(schemaClient, {
      method: 'POST',
      url: schemasUrl(baseUrl),
      data: schemaInsertBody(),
    });
    const reinsertEntry = record(8, 'schemas.insert', 'POST', reinserted, {
      requestedFields: FIELD_SPECS.map((field) => ({
        fieldName: field.fieldName,
        fieldType: field.fieldType,
        displayName: field.displayName,
        multiValued: field.multiValued === true,
      })),
      heldBeforeDelete,
    });
    if (!isOk(reinserted)) {
      if (isRefusal(reinserted.httpStatus)) state.createAttempted = false;
      else state.inserted = true;
      evidence.outcome = 'second-insert-failed';
      return;
    }
    state.created = true;
    state.inserted = true;
    reinsertEntry.answered = summarizeSchema(reinserted.body);
    const recreated = await poll(
      () => observeCustomNow(),
      (result) => result.httpStatus === 200,
    );
    reinsertEntry.settledAfterMs = recreated.waitedMs;
    reinsertEntry.read = recreated.observation;
    const oldValues = recreated.observation.attributes ?? {};
    const expected = {
      One: describeValue(SECOND_VALUES.One),
      Two: describeValue(FIRST_VALUES.Two),
      [OMITTED_ATTRIBUTE]: describeValue(FIRST_VALUES[OMITTED_ATTRIBUTE]),
      List: describeValue(FIRST_VALUES.List),
    };
    const perAttribute = Object.fromEntries(
      ATTRIBUTES.map((name) => {
        const observed = oldValues[name];
        if (observed === undefined) return [name, 'absent'];
        return [
          name,
          isDeepStrictEqual(observed, expected[name])
            ? 'same-as-written'
            : 'different-value',
        ];
      }),
    );
    evidence.recreate = {
      method: 'POST',
      httpStatus: reinserted.httpStatus,
      answered: summarizeSchema(reinserted.body),
      observedAfterMs: recreated.waitedMs,
      categoryPresent: recreated.observation.categoryPresent ?? null,
      attributes: oldValues,
      oldValuesReturned: recreated.settled
        ? Object.values(perAttribute).some((value) => value !== 'absent')
          ? 'yes'
          : 'no'
        : 'unknown',
      perAttribute,
    };
    if (!recreated.settled) {
      evidence.outcome = 'second-insert-not-visible';
      return;
    }

    evidence.outcome = 'completed';
  };

  const cleanup = async () => {
    // Run after every attempt that could have created the category, not only after an
    // acknowledged insert. A lost answer or a failed observation leaves the flags set.
    if (!state.createAttempted && !state.created) return;
    let current = null;
    try {
      current = await call(
        schemaClient,
        { method: 'GET', url: schemaUrl(baseUrl, CATEGORY) },
        cleanupTimeoutMs,
      );
      evidence.cleanup.push({
        action: 'schemas.get',
        method: 'GET',
        httpStatus: current.httpStatus,
        ...(current.errorReason ? { errorReason: current.errorReason } : {}),
      });
    } catch (error) {
      evidence.cleanup.push({
        action: 'schemas.get',
        method: 'GET',
        failed: failureCode(error),
      });
    }
    let observed = null;
    try {
      observed = observeCustom(
        await call(
          userClient,
          {
            method: 'GET',
            url: userEndpoint,
            params: { projection: 'custom', customFieldMask: CATEGORY },
          },
          cleanupTimeoutMs,
        ),
      );
      evidence.cleanup.push({
        action: 'users.get',
        method: 'GET',
        ...observed,
      });
    } catch (error) {
      evidence.cleanup.push({
        action: 'users.get',
        method: 'GET',
        failed: failureCode(error),
      });
    }
    const holdsValue =
      observed?.categoryPresent === true &&
      Object.keys(observed.attributes ?? {}).length > 0;
    // When the category exists but the user read could not answer, a null update is the
    // only safe way to make sure no value remains. It names only this category. A
    // cleanup probe that threw leaves `current` null; the delete below still runs.
    const readUncertain =
      current !== null &&
      isOk(current) &&
      (observed === null || !isOk(observed));
    let cleared = false;
    if (holdsValue || readUncertain) {
      try {
        const clearedAnswer = await call(
          userClient,
          {
            method: 'PUT',
            url: userEndpoint,
            data: valuesBody(CATEGORY, null),
          },
          cleanupTimeoutMs,
        );
        cleared = isOk(clearedAnswer);
        evidence.cleanup.push({
          action: 'users.update',
          method: 'PUT',
          httpStatus: clearedAnswer.httpStatus,
          ...(clearedAnswer.errorReason
            ? { errorReason: clearedAnswer.errorReason }
            : {}),
          requested: `customSchemas.${CATEGORY}=null`,
        });
      } catch (error) {
        evidence.cleanup.push({
          action: 'users.update',
          method: 'PUT',
          failed: failureCode(error),
        });
      }
    }
    // A 404 proves absence. Delete when the probe answered, and also when it did not
    // answer, so an ambiguous probe does not leave this run's category behind.
    if (current === null || current.httpStatus !== 404) {
      try {
        const removal = await call(
          schemaClient,
          { method: 'DELETE', url: schemaUrl(baseUrl, CATEGORY) },
          cleanupTimeoutMs,
        );
        evidence.cleanup.push({
          action: 'schemas.delete',
          method: 'DELETE',
          httpStatus: removal.httpStatus,
          ...(removal.errorReason ? { errorReason: removal.errorReason } : {}),
        });
      } catch (error) {
        evidence.cleanup.push({
          action: 'schemas.delete',
          method: 'DELETE',
          failed: failureCode(error),
        });
      }
    }
    evidence.cleanup.push({
      clearedValueBeforeDelete: cleared,
      categoryPresentBeforeCleanup: current !== null && isOk(current),
    });
  };

  const verify = async () => {
    // After an ambiguous write the check still verifies absence. Only a run that sent
    // no write at all, or one that a 4xx refused outright, verifies nothing.
    if (!state.inserted) {
      evidence.verification = {
        skipped: 'The check wrote nothing, so it verified nothing.',
      };
      return;
    }
    // The final read is the proof. Poll it, because a Directory read can lag the delete.
    const gone = await poll(
      () =>
        call(
          schemaClient,
          { method: 'GET', url: schemaUrl(baseUrl, CATEGORY) },
          cleanupTimeoutMs,
        ),
      (result) => result.httpStatus === 404,
    );
    evidence.verification = {
      category: {
        httpStatus: gone.observation.httpStatus,
        ...(gone.observation.errorReason
          ? { errorReason: gone.observation.errorReason }
          : {}),
        present: isOk(gone.observation),
      },
      settledAfterMs: gone.waitedMs,
      note: 'A customFieldMask that names an absent category answers 400 invalid, so the final read cannot show a value of the deleted category.',
    };
  };

  try {
    await runSteps();
  } catch (error) {
    evidence.failure = failureCode(error);
    evidence.outcome ??= 'failed';
  }
  try {
    await cleanup();
  } catch (error) {
    evidence.cleanupFailure = failureCode(error);
  }
  try {
    await verify();
  } catch (error) {
    evidence.verification = { failed: failureCode(error) };
  }

  evidence.findings = findingsOf(evidence);
  evidence.status = verdict(evidence);
  evidence.durationMs = Date.now() - startedAt;
  const sanitized = sanitizeEvidence(evidence, {
    customerId: CUSTOMER,
    subject: credential.subject,
    testUser,
    clientId: credential.serviceAccount.client_id,
  });
  await writeFile(output, `${JSON.stringify(sanitized, null, 2)}\n`);
  return sanitized;
}

/** The answers of the K30 plan. */
export function findingsOf(evidence) {
  const step = (number) =>
    evidence.steps.find((entry) => entry.step === number);
  const accepted = (number) => {
    const entry = step(number);
    return (
      entry !== undefined &&
      Number.isInteger(entry.httpStatus) &&
      entry.httpStatus >= 200 &&
      entry.httpStatus < 300
    );
  };
  const refusal = (number) =>
    `refused:${String(step(number)?.errorReason ?? step(number)?.httpStatus)}`;
  const observed = step(6)?.observed ?? null;
  const row = (name) => observed?.[name] ?? null;
  const read = step(6)?.read?.httpStatus;
  const readable = Number.isInteger(read) && read >= 200 && read < 300;

  let nullTwo = 'unknown';
  let nullList = 'unknown';
  if (step(5) !== undefined && !accepted(5)) {
    nullTwo = refusal(5);
    nullList = refusal(5);
  } else if (observed !== null && readable) {
    nullTwo = row('Two')?.holdsValue === false ? 'cleared' : 'kept';
    nullList = row('List')?.holdsValue === false ? 'cleared' : 'kept';
  } else if (step(6) !== undefined) {
    nullTwo = `unreadable:${String(step(6).read?.errorReason ?? read)}`;
    nullList = nullTwo;
  }

  let setValue = 'unknown';
  if (step(5) !== undefined && !accepted(5)) setValue = refusal(5);
  else if (row('One') !== null && readable) {
    setValue = isDeepStrictEqual(
      row('One').stored,
      describeValue(SECOND_VALUES.One),
    )
      ? 'set'
      : 'not-set';
  } else if (step(6) !== undefined) {
    setValue = `unreadable:${String(step(6).read?.errorReason ?? read)}`;
  }

  let omitted = 'unknown';
  if (step(5) !== undefined && !accepted(5)) omitted = refusal(5);
  else if (row(OMITTED_ATTRIBUTE) !== null && readable) {
    omitted =
      row(OMITTED_ATTRIBUTE).changedAfterMs === null ? 'kept' : 'changed';
  } else if (step(6) !== undefined) {
    omitted = `unreadable:${String(step(6).read?.errorReason ?? read)}`;
  }

  let deleteWithValues = 'unknown';
  const deleteRead = step(7)?.read;
  if (step(7) === undefined) deleteWithValues = 'unknown';
  else if (!accepted(7)) deleteWithValues = refusal(7);
  else if (deleteRead?.httpStatus === 404)
    deleteWithValues = 'accepted-category-gone';
  else if (
    Number.isInteger(deleteRead?.httpStatus) &&
    deleteRead.httpStatus >= 200 &&
    deleteRead.httpStatus < 300
  )
    deleteWithValues = 'accepted-category-still-present';
  else
    deleteWithValues = `accepted-read-failed:${String(
      deleteRead?.errorReason ?? deleteRead?.httpStatus,
    )}`;

  const recreateAnswer = evidence.recreate?.oldValuesReturned ?? 'unknown';
  const accountFields =
    evidence.accountComparison === null ||
    Object.keys(evidence.accountComparison).length === 0
      ? 'unavailable'
      : evidence.accountFieldsChanged.length === 0
        ? 'all-equal'
        : `changed:${evidence.accountFieldsChanged.join(',')}`;

  const findings = {
    updateAnswerShape: {
      question: 'The users.update answer body shape',
      answer: step(5)?.answer ?? 'unknown',
    },
    setValue: {
      question: 'The value that the users.update body set on One',
      answer: setValue,
      stored: row('One')?.stored ?? null,
      changedAfterMs: row('One')?.changedAfterMs ?? null,
      changedAfterSeconds: row('One')?.changedAfterSeconds ?? null,
    },
    nullSingleValue: {
      question:
        'A users.update body names the single-value attribute Two with null',
      answer: nullTwo,
      holdsValue: row('Two')?.holdsValue ?? null,
      changedAfterMs: row('Two')?.changedAfterMs ?? null,
      changedAfterSeconds: row('Two')?.changedAfterSeconds ?? null,
    },
    nullList: {
      question:
        'A users.update body names the multi-value attribute List with null',
      answer: nullList,
      holdsValue: row('List')?.holdsValue ?? null,
      changedAfterMs: row('List')?.changedAfterMs ?? null,
      changedAfterSeconds: row('List')?.changedAfterSeconds ?? null,
    },
    omittedAttribute: {
      question:
        'A users.update body leaves the single-value attribute Three out',
      answer: omitted,
      holdsValue: row(OMITTED_ATTRIBUTE)?.holdsValue ?? null,
      stored: row(OMITTED_ATTRIBUTE)?.stored ?? null,
      changedAfterMs: row(OMITTED_ATTRIBUTE)?.changedAfterMs ?? null,
    },
    accountFields: {
      question:
        'Each account field of the projection=basic read after users.update',
      answer: accountFields,
      changed: evidence.accountFieldsChanged,
    },
    deleteWithValues: {
      question: 'schemas.delete while the test user holds values',
      answer: deleteWithValues,
      heldBeforeDelete: step(7)?.heldBeforeDelete ?? null,
    },
    recreatedCategory: {
      question: 'A new category with the name of a deleted category',
      answer:
        recreateAnswer === 'yes'
          ? 'old-values-returned'
          : recreateAnswer === 'no'
            ? 'starts-empty'
            : 'unknown',
      perAttribute: evidence.recreate?.perAttribute ?? null,
    },
  };
  const unknown = Object.entries(findings)
    .filter(([, finding]) => finding.answer === 'unknown')
    .map(([name]) => name);
  return { ...findings, unknown };
}

/** The run passed when every step answered, every answer is recorded, and nothing remains. */
export function verdict(evidence) {
  if (evidence.outcome === 'already-exists') return 'stopped';
  if (evidence.outcome !== 'completed') return 'failed';
  if ((evidence.findings?.unknown ?? []).length > 0) return 'failed';
  const categoryGone = evidence.verification?.category?.httpStatus === 404;
  const accountRecorded =
    evidence.accountComparison !== null &&
    Object.keys(evidence.accountComparison).length > 0;
  const everyStepAnswered =
    evidence.steps.length === 8 &&
    evidence.steps.every(
      (entry, index) =>
        entry.step === index + 1 && Number.isInteger(entry.httpStatus),
    );
  return categoryGone && accountRecorded && everyStepAnswered
    ? 'passed'
    : 'failed';
}

async function main() {
  const [keyPath, subject, clientId, testUser] = process.argv.slice(2);
  if (!keyPath || !subject || !clientId || !testUser) {
    console.error(usage);
    process.exit(2);
  }
  const credential = {
    subject,
    serviceAccount: validateServiceAccount(
      JSON.parse(await readFile(keyPath, 'utf8')),
      clientId,
    ),
  };
  const evidence = await runCheck(credential, { testUser });
  const printed = {
    status: evidence.status,
    outcome: evidence.outcome,
    findings: evidence.findings,
    accountComparison: evidence.accountComparison,
    verification: evidence.verification,
    cleanup: evidence.cleanup,
  };
  console.log(JSON.stringify(printed, null, 2));
  const path = `deployment/evidence/user-clear-live-l4-${evidence.recordedAt.slice(0, 10)}.json`;
  if (evidence.status === 'failed') {
    console.error(`Evidence written to ${path}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Evidence written to ${path}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();

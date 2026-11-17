/**
 * Live write check L3 of the custom user attributes design (B section 14, row L3).
 * Run: node --import ./libs/application-contracts/test-register.mjs deployment/google-proof/user-values-live.mjs <key-file> <subject> <client-id> <test-user>
 *
 * Two single-scope clients: the schema scope for the category and the user scope for its values.
 * The check touches only the category CcLiveValues and only the test user of its argument.
 * It reads that user with projection=custom and customFieldMask=CcLiveValues after each step.
 * It writes sanitized evidence under deployment/evidence/ and leaves no category and no value.
 */
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { JWT, OAuth2Client } from 'google-auth-library';
import { validateServiceAccount } from '@campus/google-connection';

export const usage =
  'Usage: node --import ./libs/application-contracts/test-register.mjs deployment/google-proof/user-values-live.mjs <key-file> <subject> <client-id> <test-user>';

/** The only category this check reads or writes. Every schema name goes through the guard. */
export const CATEGORY = 'CcLiveValues';
export const SCHEMA_SCOPE =
  'https://www.googleapis.com/auth/admin.directory.userschema';
export const USER_SCOPE =
  'https://www.googleapis.com/auth/admin.directory.user';
/** The schema path accepts the alias of the authenticated customer. No tenant value is stored. */
const CUSTOMER = 'my_customer';
const DIRECTORY = 'https://admin.googleapis.com/admin/directory/v1';
/**
 * The sanitized answers of the evidence file. The test user keeps an `example.org` address
 * and does not repeat the local part of the real test user.
 */
export const CUSTOMER_PLACEHOLDER = 'C0123456';
export const SUBJECT_PLACEHOLDER = 'admin@example.org';
export const TEST_USER_PLACEHOLDER = 'test-user@example.org';
export const CLIENT_ID_PLACEHOLDER = '123456789012345678901';
/** One attribute of each info type, the multi-value STRING, and a second single-value STRING. */
export const FIELD_SPECS = [
  { fieldName: 'ccText', fieldType: 'STRING', displayName: 'CC text' },
  { fieldName: 'ccWhole', fieldType: 'INT64', displayName: 'CC whole number' },
  { fieldName: 'ccYesNo', fieldType: 'BOOL', displayName: 'CC yes or no' },
  {
    fieldName: 'ccDecimal',
    fieldType: 'DOUBLE',
    displayName: 'CC decimal number',
  },
  { fieldName: 'ccEmail', fieldType: 'EMAIL', displayName: 'CC email' },
  { fieldName: 'ccPhone', fieldType: 'PHONE', displayName: 'CC phone' },
  { fieldName: 'ccDate', fieldType: 'DATE', displayName: 'CC date' },
  {
    fieldName: 'ccTags',
    fieldType: 'STRING',
    displayName: 'CC tags',
    multiValued: true,
  },
  { fieldName: 'ccExtra', fieldType: 'STRING', displayName: 'CC extra string' },
];

/** Refuse every schema name but the one category this check owns. */
export function requireCategory(name) {
  if (name !== CATEGORY)
    throw new Error(
      `Refused: check L3 touches only the category ${CATEGORY}, not ${String(name)}.`,
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

/** A value PATCH body. It names only the category of the guard. */
export function valuePatch(category, values) {
  return { customSchemas: { [requireCategory(category)]: values } };
}

/** The JSON shape of one value, with the value itself only when the check wrote it. */
export function describeValue(value) {
  if (value === null) return { jsonType: 'null' };
  if (Array.isArray(value))
    return {
      jsonType: 'array',
      entries: value.map((entry) =>
        entry !== null && typeof entry === 'object'
          ? { keys: Object.keys(entry).sort(), value: entry.value }
          : { value: entry },
      ),
    };
  return { jsonType: typeof value, value };
}

/** The JSON shape of each attribute of one PATCH body. */
export function describeValues(values) {
  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => [name, describeValue(value)]),
  );
}

/** The top-level keys of an answer. It never copies a value, so no user data is stored. */
export function answerShape(body) {
  if (body === undefined || body === null) return { present: false };
  if (typeof body !== 'object' || Array.isArray(body))
    return { present: true, jsonType: typeof body };
  return { present: true, keys: Object.keys(body).sort() };
}

/** The schema without its values. A schema holds none. */
export function summarizeSchema(schema) {
  if (schema === null || typeof schema !== 'object') return null;
  return {
    schemaId: schema.schemaId ?? null,
    schemaName: schema.schemaName ?? null,
    displayName: schema.displayName ?? null,
    etag: schema.etag ?? null,
    fields: Array.isArray(schema.fields)
      ? schema.fields.map((field) => ({
          fieldId: field.fieldId ?? null,
          fieldName: field.fieldName,
          fieldType: field.fieldType,
          multiValued: field.multiValued === true,
        }))
      : [],
  };
}

/**
 * The complete schema body of an update (B section 6.1). Each kept field carries its fieldId.
 * `change` holds a partial field by name, `remove` lists removed names, and `add` holds new fields.
 */
export function updateBody(schema, options = {}) {
  const change = options.change ?? {};
  const remove = options.remove ?? [];
  const add = options.add ?? [];
  const kept = (schema?.fields ?? [])
    .filter((field) => !remove.includes(field.fieldName))
    .map((field) => {
      const changed = change[field.fieldName] ?? {};
      return {
        fieldId: field.fieldId,
        fieldName: field.fieldName,
        fieldType: field.fieldType,
        displayName: field.displayName,
        multiValued: changed.multiValued ?? field.multiValued === true,
        indexed: field.indexed !== false,
        readAccessType: field.readAccessType ?? 'ADMINS_AND_SELF',
      };
    });
  const added = add.map((field) => ({
    fieldName: field.fieldName,
    fieldType: field.fieldType,
    displayName: field.displayName,
    multiValued: field.multiValued === true,
    indexed: field.indexed !== false,
    readAccessType: field.readAccessType ?? 'ADMINS_AND_SELF',
  }));
  return {
    schemaName: schema?.schemaName ?? CATEGORY,
    displayName: schema?.displayName ?? 'CC live values',
    fields: [...kept, ...added],
  };
}

/** A short record of one observation, for the answer right after a write. */
export function summarizeRead(observation) {
  return {
    httpStatus: observation.httpStatus,
    ...(observation.errorReason
      ? { errorReason: observation.errorReason }
      : {}),
    categoryPresent: observation.categoryPresent ?? null,
    attributeNames: Object.keys(observation.attributes ?? {}).sort(),
  };
}

/** Two observations agree when their answer and their values agree. */
export function sameRead(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Replace every tenant value of the run with an example value.
 * The test user is replaced in plain and URL-encoded form.
 */
export function sanitizeEvidence(evidence, identifiers) {
  const pairs = [
    [identifiers.customerId, CUSTOMER_PLACEHOLDER],
    [identifiers.subject, SUBJECT_PLACEHOLDER],
    [identifiers.testUser, TEST_USER_PLACEHOLDER],
    [identifiers.clientId, CLIENT_ID_PLACEHOLDER],
    [
      encodeURIComponent(identifiers.testUser),
      encodeURIComponent(TEST_USER_PLACEHOLDER),
    ],
  ]
    .filter(([from]) => typeof from === 'string' && from.length > 0)
    .sort(([left], [right]) => right.length - left.length);
  const replace = (text) =>
    pairs.reduce((result, [from, to]) => result.split(from).join(to), text);
  const walk = (value) => {
    if (typeof value === 'string') return replace(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value !== null && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, walk(entry)]),
      );
    return value;
  };
  return walk(evidence);
}

function isOk(result) {
  return (
    Number.isInteger(result.httpStatus) &&
    result.httpStatus >= 200 &&
    result.httpStatus < 300
  );
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

/** One request. A write is never retried: a repeated insert or delete would hide an answer. */
async function perform(client, request) {
  const started = Date.now();
  try {
    const response = await client.request({
      url: request.url,
      method: request.method,
      ...(request.data === undefined ? {} : { data: request.data }),
      ...(request.params === undefined ? {} : { params: request.params }),
      timeout: 25_000,
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
  const issuer = new JWT({
    email: credential.serviceAccount.client_email,
    key: credential.serviceAccount.private_key,
    keyId: credential.serviceAccount.private_key_id,
    subject: credential.subject,
    scopes: [scope],
  });
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

/** The observed answer of one users.get. Values appear only when the check wrote them. */
export function observeUser(result, includeValues) {
  const observation = {
    httpStatus: result.httpStatus,
    ...(result.errorReason ? { errorReason: result.errorReason } : {}),
  };
  if (!isOk(result)) return observation;
  const category = result.body?.customSchemas?.[CATEGORY];
  if (
    category === null ||
    typeof category !== 'object' ||
    Object.keys(category).length === 0
  )
    return { ...observation, categoryPresent: false, attributes: {} };
  const attributes = Object.fromEntries(
    Object.entries(category).map(([name, value]) => [
      name,
      includeValues
        ? describeValue(value)
        : { jsonType: describeValue(value).jsonType },
    ]),
  );
  return { ...observation, categoryPresent: true, attributes };
}

const limitations = [
  'The check touches only the category CcLiveValues and only the test user of its argument.',
  'Each users.get uses projection=custom and customFieldMask=CcLiveValues, so no other category is read.',
  'The answer settles one sandbox user of one domain. It settles no other domain and no other user.',
  'The row of an attribute that a SAML app maps stays unverified. No SAML app maps an attribute here.',
  'A value PATCH deletes the named attribute on that user. The check never names the category alone.',
];

/**
 * Run the nine steps of B section 14 row L3 and write the sanitized evidence.
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
    options.output ?? `deployment/evidence/user-values-live-l3-${runDate}.json`;
  const clientFor =
    options.clientFor ?? ((scope) => singleScopeClient(credential, scope));
  const pollAttempts = options.pollAttempts ?? 8;
  const pollDelayMs = options.pollDelayMs ?? 1000;
  const sleep =
    options.sleep ??
    ((milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const evidence = {
    schemaVersion: 1,
    check: 'L3',
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
    cleanup: [],
    findings: {},
    verification: {},
    limitations,
    durationMs: 0,
  };
  const state = { created: false, schema: null };
  const startedAt = Date.now();
  const schemaClient = await clientFor(SCHEMA_SCOPE);
  const userClient = await clientFor(USER_SCOPE);
  const userUrl = `${baseUrl}/users/${encodeURIComponent(testUser)}`;
  const getCategory = () =>
    perform(schemaClient, { method: 'GET', url: schemaUrl(baseUrl, CATEGORY) });
  const readUser = () =>
    perform(userClient, {
      method: 'GET',
      url: userUrl,
      params: { projection: 'custom', customFieldMask: CATEGORY },
    });

  const step = async (
    number,
    action,
    method,
    request,
    extra = {},
    settles = null,
  ) => {
    const result = await perform(request.client, {
      method,
      url: request.url,
      data: request.data,
    });
    const entry = {
      step: number,
      action,
      method,
      httpStatus: result.httpStatus,
      ...(result.errorReason ? { errorReason: result.errorReason } : {}),
      ...extra,
    };
    let observation = observeUser(await readUser(), state.created);
    entry.immediate = summarizeRead(observation);
    let waited = 0;
    if (settles !== null) {
      let previous = null;
      for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
        if (settles(observation, previous)) break;
        previous = observation;
        await sleep(pollDelayMs);
        waited += pollDelayMs;
        observation = observeUser(await readUser(), state.created);
      }
    }
    entry.read = observation;
    entry.settledAfterMs = waited;
    evidence.steps.push(entry);
    return { result, entry };
  };

  const runSteps = async () => {
    /** A successful schema answer with field ids is the state of the next update. */
    const adoptSchema = async (result) => {
      if (!isOk(result)) return;
      if (
        Array.isArray(result.body?.fields) &&
        result.body.fields.every((field) => typeof field.fieldId === 'string')
      )
        state.schema = result.body;
      else {
        const fresh = await getCategory();
        if (isOk(fresh)) state.schema = fresh.body;
      }
    };
    // Step 1. A category that already exists stops the check before any write.
    const first = await step(1, 'schemas.get', 'GET', {
      client: schemaClient,
      url: schemaUrl(baseUrl, CATEGORY),
    });
    if (isOk(first.result)) {
      evidence.outcome = 'already-exists';
      first.entry.answered = summarizeSchema(first.result.body);
      evidence.existingCategory = summarizeSchema(first.result.body);
      return;
    }
    if (first.result.httpStatus !== 404) {
      evidence.outcome = 'category-read-failed';
      return;
    }

    // Step 2. Insert the category with one attribute of each info type.
    const inserted = await step(
      2,
      'schemas.insert',
      'POST',
      {
        client: schemaClient,
        url: schemasUrl(baseUrl),
        data: {
          schemaName: requireCategory(CATEGORY),
          displayName: 'CC live values',
          fields: FIELD_SPECS.map((field) => ({
            fieldName: field.fieldName,
            fieldType: field.fieldType,
            displayName: field.displayName,
            multiValued: field.multiValued === true,
            indexed: true,
            readAccessType: 'ADMINS_AND_SELF',
          })),
        },
      },
      {
        requestedFields: FIELD_SPECS.map((field) => ({
          ...field,
          multiValued: field.multiValued === true,
        })),
      },
      (observation) =>
        observation.httpStatus === 200 && observation.categoryPresent === false,
    );
    if (!isOk(inserted.result)) {
      evidence.outcome = 'insert-failed';
      return;
    }
    state.created = true;
    await adoptSchema(inserted.result);
    inserted.entry.answered = summarizeSchema(inserted.result.body);

    // Step 3. Set every attribute. The phone value is the recorded one.
    const values = {
      ccText: 'K4 text',
      ccWhole: 7,
      ccYesNo: true,
      ccDecimal: 1.5,
      ccEmail: 'value@example.org',
      ccPhone: '+1 555 0100',
      ccDate: runDate,
      ccTags: [{ value: 'alpha' }, { value: 'beta' }],
      ccExtra: 'K4 extra',
    };
    const patched = await step(
      3,
      'users.patch',
      'PATCH',
      {
        client: userClient,
        url: userUrl,
        data: valuePatch(CATEGORY, values),
      },
      { requested: describeValues(values) },
      (observation) =>
        Object.keys(values).every(
          (name) => observation.attributes?.[name] !== undefined,
        ),
    );
    patched.entry.answer = answerShape(patched.result.body);
    if (!isOk(patched.result)) evidence.outcome = 'value-write-failed';

    // Step 4. Clear one single-value attribute and the multi-value attribute.
    const cleared = { ccWhole: null, ccTags: null };
    const clearedAnswer = await step(
      4,
      'users.patch',
      'PATCH',
      {
        client: userClient,
        url: userUrl,
        data: valuePatch(CATEGORY, cleared),
      },
      { requested: describeValues(cleared) },
      (observation) =>
        observation.attributes?.ccWhole === undefined &&
        observation.attributes?.ccTags === undefined,
    );
    clearedAnswer.entry.answer = answerShape(clearedAnswer.result.body);

    // Step 5. Change the second single-value STRING attribute to multiple values.
    if (state.schema === null) throw new Error('The schema state is missing.');
    const converted = await step(
      5,
      'schemas.update',
      'PUT',
      {
        client: schemaClient,
        url: schemaUrl(baseUrl, CATEGORY),
        data: updateBody(state.schema, {
          change: { ccExtra: { multiValued: true } },
        }),
      },
      { change: { fieldName: 'ccExtra', multiValued: true } },
      (observation) => observation.attributes?.ccExtra?.jsonType === 'array',
    );
    converted.entry.answered = summarizeSchema(converted.result.body);
    await adoptSchema(converted.result);

    // Step 6. Remove one attribute that holds a value.
    const removed = await step(
      6,
      'schemas.update',
      'PUT',
      {
        client: schemaClient,
        url: schemaUrl(baseUrl, CATEGORY),
        data: updateBody(state.schema, { remove: ['ccText'] }),
      },
      { remove: ['ccText'] },
      (observation) => observation.attributes?.ccText === undefined,
    );
    removed.entry.answered = summarizeSchema(removed.result.body);
    await adoptSchema(removed.result);

    // Step 7. Add the same attribute again, with the same name and type.
    const restored = await step(
      7,
      'schemas.update',
      'PUT',
      {
        client: schemaClient,
        url: schemaUrl(baseUrl, CATEGORY),
        data: updateBody(state.schema, { add: [FIELD_SPECS[0]] }),
      },
      { add: [FIELD_SPECS[0]] },
      (observation, previous) =>
        previous !== null && sameRead(previous, observation),
    );
    restored.entry.answered = summarizeSchema(restored.result.body);
    await adoptSchema(restored.result);

    // Step 8. Delete the category while the test user holds values.
    const deleted = await step(
      8,
      'schemas.delete',
      'DELETE',
      {
        client: schemaClient,
        url: schemaUrl(baseUrl, CATEGORY),
      },
      {},
      (observation) =>
        observation.categoryPresent === false ||
        (observation.httpStatus === 400 &&
          observation.errorReason === 'invalid'),
    );
    deleted.entry.answered = { deleted: isOk(deleted.result) };
    if (evidence.outcome === null) evidence.outcome = 'completed';
  };

  const cleanup = async () => {
    if (!state.created) return;
    const current = await getCategory();
    evidence.cleanup.push({
      action: 'schemas.get',
      method: 'GET',
      httpStatus: current.httpStatus,
      ...(current.errorReason ? { errorReason: current.errorReason } : {}),
    });
    const before = await readUser();
    const observed = observeUser(before, true);
    evidence.cleanup.push({ action: 'users.get', method: 'GET', ...observed });
    const holdsValue =
      observed.categoryPresent === true &&
      Object.keys(observed.attributes ?? {}).length > 0;
    let cleared = false;
    if (holdsValue) {
      const clear = await perform(userClient, {
        method: 'PATCH',
        url: userUrl,
        data: valuePatch(CATEGORY, null),
      });
      cleared = isOk(clear);
      evidence.cleanup.push({
        action: 'users.patch',
        method: 'PATCH',
        httpStatus: clear.httpStatus,
        ...(clear.errorReason ? { errorReason: clear.errorReason } : {}),
        requested: 'customSchemas.CcLiveValues=null',
      });
      const after = observeUser(await readUser(), true);
      evidence.cleanup.push({ action: 'users.get', method: 'GET', ...after });
    }
    if (isOk(current)) {
      const removal = await perform(schemaClient, {
        method: 'DELETE',
        url: schemaUrl(baseUrl, CATEGORY),
      });
      evidence.cleanup.push({
        action: 'schemas.delete',
        method: 'DELETE',
        httpStatus: removal.httpStatus,
        ...(removal.errorReason ? { errorReason: removal.errorReason } : {}),
      });
    }
    evidence.cleanup.push({
      clearedValueBeforeDelete: cleared,
      categoryPresentBeforeCleanup: isOk(current),
    });
  };

  const verify = async () => {
    if (!state.created) {
      evidence.verification = {
        skipped: 'The check wrote nothing, so it verified nothing.',
      };
      return;
    }
    const category = await getCategory();
    const user = await readUser();
    const userObservation = observeUser(user, true);
    const unreadable =
      userObservation.httpStatus === 400 &&
      userObservation.errorReason === 'invalid';
    evidence.verification = {
      category: {
        httpStatus: category.httpStatus,
        ...(category.errorReason ? { errorReason: category.errorReason } : {}),
        present: isOk(category),
      },
      user: userObservation,
      ...(unreadable
        ? {
            note: 'Google answers 400 invalid to customFieldMask=CcLiveValues when no such category exists. The category is absent, so the final read cannot show its values.',
          }
        : {}),
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

/** The answer of each B section 6.3 row that names check L3. */
export function findingsOf(evidence) {
  const step = (number) =>
    evidence.steps.find((entry) => entry.step === number);
  const attributes = (number) => step(number)?.read?.attributes ?? null;
  const responded = (number) =>
    step(number) !== undefined && Number.isInteger(step(number).httpStatus);
  const accepted = (number) =>
    responded(number) &&
    step(number).httpStatus >= 200 &&
    step(number).httpStatus < 300;
  const refusal = (number) =>
    `refused:${String(step(number)?.errorReason ?? step(number)?.httpStatus)}`;
  const afterWrite = attributes(3);
  const afterClear = attributes(4);
  const afterConvert = attributes(5);
  const afterRemove = attributes(6);
  const afterRestore = attributes(7);

  let nullSingleValue = 'unknown';
  let nullList = 'unknown';
  if (responded(4) && !accepted(4)) {
    nullSingleValue = refusal(4);
    nullList = refusal(4);
  } else if (afterClear !== null) {
    nullSingleValue = afterClear.ccWhole === undefined ? 'deleted' : 'kept';
    nullList = afterClear.ccTags === undefined ? 'deleted' : 'kept';
  }

  let singleToMultiple = 'unknown';
  if (responded(5) && !accepted(5)) singleToMultiple = refusal(5);
  else if (afterConvert !== null) {
    if (afterConvert.ccExtra === undefined) singleToMultiple = 'value-lost';
    else if (afterConvert.ccExtra.jsonType === 'array')
      singleToMultiple = 'list-of-one';
    else singleToMultiple = `kept-as-${afterConvert.ccExtra.jsonType}`;
  }

  let readdedField = 'unknown';
  if (responded(7) && !accepted(7)) readdedField = refusal(7);
  else if (afterRestore !== null) {
    readdedField =
      afterRestore.ccText === undefined ? 'starts-empty' : 'shows-old-values';
  }

  // The two rows together: a value that survives the removal reappears when the field returns.
  let removedFieldValues = 'unknown';
  if (responded(6) && !accepted(6)) removedFieldValues = refusal(6);
  else if (readdedField === 'shows-old-values')
    removedFieldValues = 'kept-hidden';
  else if (readdedField === 'starts-empty') removedFieldValues = 'deleted';
  else if (afterRemove !== null)
    removedFieldValues = afterRemove.ccText === undefined ? 'unknown' : 'kept';

  let deleteWithValues = 'unknown';
  const deleteRead = step(8)?.read;
  if (!responded(8)) deleteWithValues = 'unknown';
  else if (!accepted(8)) deleteWithValues = refusal(8);
  else if (deleteRead?.categoryPresent === true)
    deleteWithValues = 'accepted-values-readable-after-delete';
  else if (deleteRead?.httpStatus === 400)
    deleteWithValues = 'accepted-values-unreadable';
  else deleteWithValues = 'accepted-values-gone';

  const findings = {
    nullSingleValue: {
      question: 'A value PATCH names a single-value attribute with null',
      answer: nullSingleValue,
    },
    nullList: {
      question: 'A value PATCH names a multi-value attribute with null',
      answer: nullList,
    },
    singleToMultiple: {
      question: 'One value to multiple values',
      answer: singleToMultiple,
      storedForm: afterConvert?.ccExtra ?? null,
    },
    removedFieldValues: {
      question: 'Values of a removed field',
      answer: removedFieldValues,
      storedForm: afterRemove?.ccText ?? null,
    },
    readdedField: {
      question: 'A new field with the name of a removed field',
      answer: readdedField,
      storedForm: afterRestore?.ccText ?? null,
    },
    deleteWithValues: {
      question: 'schemas.delete while users hold values',
      answer: deleteWithValues,
    },
    patchAnswer: {
      question: 'The PATCH answer body shape',
      answer: step(3)?.answer ?? 'unknown',
    },
    phoneStoredAs: {
      question: 'The stored form of the phone value +1 555 0100',
      answer: afterWrite?.ccPhone?.value ?? 'unknown',
      jsonType: afterWrite?.ccPhone?.jsonType ?? 'unknown',
    },
    dateStoredAs: {
      question: 'The stored form of the DATE value',
      answer: afterWrite?.ccDate?.value ?? 'unknown',
      jsonType: afterWrite?.ccDate?.jsonType ?? 'unknown',
    },
    storedValues: {
      question: 'The stored form of each written value',
      answer: afterWrite ?? 'unknown',
    },
  };
  const unknown = Object.entries(findings)
    .filter(([, finding]) => finding.answer === 'unknown')
    .map(([name]) => name);
  return { ...findings, unknown };
}

/** The run passed when every step answered, every row has an answer, and nothing remains. */
export function verdict(evidence) {
  if (evidence.outcome === 'already-exists') return 'stopped';
  if (evidence.outcome !== 'completed') return 'failed';
  if ((evidence.findings?.unknown ?? []).length > 0) return 'failed';
  const categoryGone = evidence.verification?.category?.httpStatus === 404;
  const user = evidence.verification?.user;
  const userClean = user?.httpStatus === 200 && user?.categoryPresent === false;
  const userUnreadable =
    user?.httpStatus === 400 && user?.errorReason === 'invalid';
  const everyStepAnswered =
    evidence.steps.length === 8 &&
    evidence.steps.every(
      (entry, index) =>
        entry.step === index + 1 && Number.isInteger(entry.httpStatus),
    );
  return categoryGone && (userClean || userUnreadable) && everyStepAnswered
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
    verification: evidence.verification,
    cleanup: evidence.cleanup,
  };
  console.log(JSON.stringify(printed, null, 2));
  if (evidence.status === 'failed') {
    console.error(
      `Evidence written to deployment/evidence/user-values-live-l3-${evidence.recordedAt.slice(0, 10)}.json`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `Evidence written to deployment/evidence/user-values-live-l3-${evidence.recordedAt.slice(0, 10)}.json`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();

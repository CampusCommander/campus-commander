/**
 * Live check L2 of the category writer: the Google Directory `schemas` calls on one test category.
 * Run: node --import ./libs/application-contracts/test-register.mjs deployment/google-proof/user-schema-live.mjs <key-file> <subject> <client-id>
 * The script touches the category `CcLiveCheck` only and refuses every other schema name.
 * One single-scope client carries `admin.directory.userschema`. No call touches a user.
 * Evidence lands sanitized under `deployment/evidence/`.
 */
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { validateServiceAccount } from '@campus/google-connection';
import { scopedClient } from '../../libs/google-connection/src/lib/provider.ts';

export const CATEGORY_NAME = 'CcLiveCheck';
export const SCOPE =
  'https://www.googleapis.com/auth/admin.directory.userschema';
/** The Directory alias for the calling customer. */
export const CUSTOMER = 'my_customer';
/** The two placeholders that replace the live identifiers in the evidence. */
export const CUSTOMER_PLACEHOLDER = 'C0123456';
export const SUBJECT_PLACEHOLDER = 'admin@example.org';

export const usage =
  'Usage: node --import ./libs/application-contracts/test-register.mjs deployment/google-proof/user-schema-live.mjs <key-file> <subject> <client-id>';

const origin = 'https://admin.googleapis.com';
const directoryPath = '/admin/directory/v1';
const insertDisplayName = 'Cc live check';
const renamedDisplayName = 'Cc live check renamed';
const staleDisplayName = 'Cc live check stale';
/** The two names of step 5. Each length is the value under test. */
export const LONG_DISPLAY_NAME = 'D'.repeat(200);
export const LONG_FIELD_NAME = 'N'.repeat(200);
/** A credential field name never reaches the evidence. The wildcard keeps a sample name out of the source. */
const CREDENTIAL_KEY =
  /token|secret|credential|authorization|^client_?id$|(?:^|_)key(?:_?id)?$/i;
const schemaIdShape = /^[A-Za-z0-9_-]{1,128}$/;

export class SchemaNameError extends Error {
  code = 'schema-name-refused';
  constructor() {
    super('schema-name-refused');
    this.name = 'SchemaNameError';
  }
}

/** The name guard of this check. Every other schema name is refused. */
export function assertCategoryName(name) {
  if (name !== CATEGORY_NAME) throw new SchemaNameError();
  return name;
}

export function evidencePathFor(date) {
  return `deployment/evidence/user-schema-live-l2-${date.toISOString().slice(0, 10)}.json`;
}

/**
 * Replace each live identifier with its placeholder and drop every credential field.
 * The walk copies the input, so a caller keeps the unsanitized value.
 */
export function sanitizeEvidence(value, redactions = []) {
  if (typeof value === 'string') {
    let text = value;
    for (const { from, to } of redactions) {
      if (typeof from !== 'string' || from.length === 0) continue;
      text = text.split(from).join(to);
    }
    return text;
  }
  if (Array.isArray(value))
    return value.map((item) => sanitizeEvidence(item, redactions));
  if (value === null || typeof value !== 'object') return value;
  const copy = {};
  for (const [key, item] of Object.entries(value)) {
    if (CREDENTIAL_KEY.test(key)) continue;
    copy[sanitizeEvidence(key, redactions)] = sanitizeEvidence(
      item,
      redactions,
    );
  }
  return copy;
}

/** The one wire call. It sends the body verbatim and records the answer verbatim. */
export async function sendJson(token, request, signal) {
  const url = new URL(`${origin}${request.path}`);
  const headers = {
    accept: 'application/json',
    authorization: `Bearer ${token}`,
    ...request.headers,
  };
  if (request.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(url, {
    method: request.method,
    headers,
    ...(request.body === undefined
      ? {}
      : { body: JSON.stringify(request.body) }),
    signal,
  });
  const text = await response.text();
  return { status: response.status, data: parseJson(text) };
}

function parseJson(text) {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The Google reason of one answer. A call that names no reason records null. */
export function reasonOf(data) {
  const error = data?.error;
  if (typeof error === 'string') return error;
  const reason = error?.errors?.[0]?.reason;
  if (typeof reason === 'string') return reason;
  const status = error?.status;
  return typeof status === 'string' ? status : null;
}

function codeOf(error) {
  const code = error?.code;
  if (typeof code === 'string') return code;
  if (error instanceof Error) return error.name;
  return 'unknown';
}

function revision() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function worktreeState() {
  try {
    const status = execFileSync('git', ['status', '--porcelain'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return status.trim().length === 0 ? 'clean' : 'dirty';
  } catch {
    return 'unknown';
  }
}

/** Mint the one-scope token. The production helper refuses a token with any other scope set. */
export async function mintToken(credential, signal) {
  const client = await scopedClient(credential, SCOPE, signal);
  const token = client.credentials.access_token;
  if (typeof token !== 'string' || token.length === 0)
    throw new Error('token-unavailable');
  return { token };
}

/** One insert body: the category name, a label, and one STRING attribute named `Note`. */
function insertBody() {
  return {
    schemaName: CATEGORY_NAME,
    displayName: insertDisplayName,
    fields: [{ fieldName: 'Note', fieldType: 'STRING', displayName: 'Note' }],
  };
}

/** One field of an update body. A kept field carries its `fieldId`, as B section 6.1 requires. */
function fieldBody(field) {
  return {
    fieldId: field.fieldId,
    fieldName: field.fieldName,
    fieldType: field.fieldType,
    displayName: field.displayName,
    multiValued: field.multiValued,
    indexed: field.indexed,
    readAccessType: field.readAccessType,
    ...(field.numericIndexingSpec === undefined
      ? {}
      : { numericIndexingSpec: field.numericIndexingSpec }),
  };
}

/** The complete schema that an update sends, with the requested changes. */
function updateBody(schema, change) {
  return {
    schemaName: schema?.schemaName ?? CATEGORY_NAME,
    displayName: change.displayName ?? schema?.displayName ?? insertDisplayName,
    fields:
      change.fields ?? (schema?.fields ?? []).map((field) => fieldBody(field)),
  };
}

/** What the script wrote. It records the script's own values and no Google value. */
function written(body) {
  const fields = Array.isArray(body.fields) ? body.fields : [];
  return {
    schemaName: body.schemaName,
    displayName: body.displayName,
    displayNameLength:
      typeof body.displayName === 'string' ? body.displayName.length : null,
    fields: fields.map((field) => ({
      fieldName: field.fieldName,
      fieldNameLength:
        typeof field.fieldName === 'string' ? field.fieldName.length : null,
      fieldType: field.fieldType,
    })),
  };
}

/** What one successful answer holds. Each value names its own presence, never a Google identifier. */
function answered(schema) {
  const fields = Array.isArray(schema.fields) ? schema.fields : [];
  return {
    schemaIdPresent: typeof schema.schemaId === 'string',
    etagPresent: typeof schema.etag === 'string',
    schemaName: schema.schemaName ?? null,
    displayName: schema.displayName ?? null,
    fieldCount: fields.length,
    fieldNames: fields.map((field) => field.fieldName ?? null),
  };
}

/**
 * Run the L2 sequence and write the sanitized evidence.
 * `options.mint`, `options.send`, `options.now`, `options.output`, and `options.signal`
 * exist for the unit test. A live run uses every default.
 */
export async function runCheck(config, options = {}) {
  const now = options.now ?? (() => new Date());
  const send = options.send ?? sendJson;
  const signal = options.signal ?? AbortSignal.timeout(120_000);
  const mint =
    options.mint ??
    ((runSignal) => {
      if (!config.credential) throw new Error('credential-required');
      return mintToken(config.credential, runSignal);
    });
  const redactions = [{ from: config.subject, to: SUBJECT_PLACEHOLDER }];

  const evidence = {
    schemaVersion: 1,
    check: 'L2',
    status: 'failed',
    observedAt: now().toISOString(),
    sourceRevision: revision(),
    worktree: worktreeState(),
    nodeVersion: process.version,
    customer: CUSTOMER_PLACEHOLDER,
    subject: SUBJECT_PLACEHOLDER,
    scope: SCOPE,
    category: CATEGORY_NAME,
    scopeCheck: { scope: SCOPE, checkedBy: 'scopedClient', result: 'not-run' },
    steps: [],
    answers: {},
    counts: {},
    durationMs: 0,
  };
  const steps = evidence.steps;
  const base = `${directoryPath}/customer/${CUSTOMER}`;
  let token = null;
  let failure = null;
  let stopped = null;
  /** The last `CcLiveCheck` schema this run received. */
  let schema = null;
  /** True while the category exists and this run created it. */
  let owned = false;
  /** True once this run inserted the category. Cleanup deletes only such a category. */
  let everOwned = false;
  /** The schema IDs that Google issued to this run. A call may name one of these or the category name. */
  const issued = new Set();
  const started = Date.now();

  /** A path that carries the category name, or an ID that Google issued to this run. */
  function schemaPath(key) {
    if (key === CATEGORY_NAME) return `${base}/schemas/${CATEGORY_NAME}`;
    if (issued.has(key) && schemaIdShape.test(key))
      return `${base}/schemas/${key}`;
    throw new SchemaNameError();
  }

  function keyOf() {
    const key = schema?.schemaId;
    if (typeof key === 'string' && schemaIdShape.test(key)) {
      issued.add(key);
      return key;
    }
    return CATEGORY_NAME;
  }

  function remember(answer) {
    if (!answer) return;
    if (
      typeof answer.schemaId === 'string' &&
      schemaIdShape.test(answer.schemaId)
    )
      issued.add(answer.schemaId);
    schema = answer;
  }

  function recordedPath(path) {
    return path
      .split(`/customer/${CUSTOMER}`)
      .join(`/customer/${CUSTOMER_PLACEHOLDER}`);
  }

  /** Send one call and record its answer. A transport failure is recorded and returned, not thrown. */
  async function attempt(step, googleMethod, httpMethod, path, extra = {}) {
    const call = {
      step,
      googleMethod,
      httpMethod,
      path: path === null ? null : recordedPath(path),
      ...(extra.wrote === undefined ? {} : { wrote: extra.wrote }),
      ...(extra.headers?.['If-Match'] === undefined
        ? {}
        : { ifMatch: extra.headers['If-Match'] }),
      ...(extra.note === undefined ? {} : { note: extra.note }),
      httpStatus: null,
      reason: null,
    };
    steps.push(call);
    if (token === null || httpMethod === null || path === null) {
      call.failure = 'no-token';
      return { call, status: null, data: null, failure: call.failure };
    }
    try {
      const answer = await send(
        token,
        {
          method: httpMethod,
          path,
          ...(extra.body === undefined ? {} : { body: extra.body }),
          ...(extra.headers === undefined ? {} : { headers: extra.headers }),
        },
        signal,
      );
      call.httpStatus = answer.status;
      call.reason = reasonOf(answer.data);
      return { call, status: answer.status, data: answer.data };
    } catch (error) {
      call.failure = codeOf(error);
      return { call, status: null, data: null, failure: call.failure };
    }
  }

  const created = (status) => status === 200 || status === 201;
  const accepted = (status) => status !== null && status >= 200 && status < 300;

  /** The category list. It records the count and the presence of the test category, never a name. */
  async function listCategories(step) {
    const answer = await attempt(
      step,
      'schemas.list',
      'GET',
      `${base}/schemas`,
    );
    if (answer.status !== 200) return { count: null, held: null };
    const schemas = Array.isArray(answer.data?.schemas)
      ? answer.data.schemas
      : [];
    const held =
      schemas.find((item) => item?.schemaName === CATEGORY_NAME) ?? null;
    answer.call.answered = {
      categoryCount: schemas.length,
      ccLiveCheckListed: held !== null,
    };
    return { count: schemas.length, held };
  }

  async function insert(step) {
    const body = insertBody();
    const answer = await attempt(
      step,
      'schemas.insert',
      'POST',
      `${base}/schemas`,
      {
        body,
        wrote: written(body),
      },
    );
    if (created(answer.status) && answer.data) {
      answer.call.answered = answered(answer.data);
      remember(answer.data);
      owned = true;
      everOwned = true;
    }
    return answer;
  }

  async function update(step, body, ifMatch) {
    const answer = await attempt(
      step,
      'schemas.update',
      'PUT',
      schemaPath(keyOf()),
      {
        body,
        wrote: written(body),
        ...(ifMatch === undefined ? {} : { headers: { 'If-Match': ifMatch } }),
      },
    );
    if (accepted(answer.status) && answer.data) {
      answer.call.answered = answered(answer.data);
      remember(answer.data);
    }
    return answer;
  }

  async function cleanup() {
    // A category that step 1 found belongs to nobody in this run. Step 1 stops before any write,
    // so the cleanup leaves it in place and reports it.
    if (token === null) {
      steps.push({
        step: '7-cleanup',
        googleMethod: null,
        httpMethod: null,
        path: null,
        note: 'skipped: no token',
        httpStatus: null,
        reason: null,
      });
      return;
    }
    if (owned) {
      const key = keyOf();
      const removed = await attempt(
        '7-cleanup-delete',
        'schemas.delete',
        'DELETE',
        schemaPath(key),
        { wrote: { schemaKey: key === CATEGORY_NAME ? 'name' : 'id' } },
      );
      if (accepted(removed.status)) {
        owned = false;
        schema = null;
      }
    } else {
      steps.push({
        step: '7-cleanup-delete',
        googleMethod: null,
        httpMethod: null,
        path: null,
        note: 'skipped: this run created no category',
        httpStatus: null,
        reason: null,
      });
    }

    let listed = await listCategories('7-list');
    evidence.counts.categoriesAfter = listed.count;
    evidence.counts.ccLiveCheckAfter = listed.held !== null;
    // A category that this run never created stays in place.
    if (listed.held === null || !everOwned) return;

    // A second pass removes a category that the first delete left behind.
    const held = listed.held;
    if (
      typeof held.schemaId === 'string' &&
      schemaIdShape.test(held.schemaId)
    ) {
      issued.add(held.schemaId);
      schema = held;
      const repeated = await attempt(
        '7-cleanup-delete-repeated',
        'schemas.delete',
        'DELETE',
        schemaPath(held.schemaId),
        { wrote: { schemaKey: 'id' } },
      );
      if (accepted(repeated.status)) {
        owned = false;
        schema = null;
      }
      listed = await listCategories('7-list-final');
      evidence.counts.categoriesAfter = listed.count;
      evidence.counts.ccLiveCheckAfter = listed.held !== null;
    }
  }

  const statusOf = (step) =>
    steps.find((call) => call.step === step)?.httpStatus ?? null;

  try {
    const minted = await mint(signal);
    token = minted.token;
    evidence.scopeCheck.result = 'passed';

    // Step 1. The guard. It reads the count and refuses to write while the category exists.
    const before = await listCategories('1-list-before');
    evidence.counts.categoriesBefore = before.count;
    const guard = await attempt(
      '1-get-guard',
      'schemas.get',
      'GET',
      schemaPath(CATEGORY_NAME),
    );
    if (guard.status === 200) {
      stopped = {
        step: '1-get-guard',
        reason: 'category-exists',
        httpStatus: 200,
      };
    } else if (guard.status !== 404) {
      throw Object.assign(new Error('guard-refused'), {
        code: guard.failure ?? `unexpected-status-${guard.status}`,
      });
    }

    if (stopped === null) {
      // Step 2. The insert.
      const inserted = await insert('2-insert');
      if (!created(inserted.status)) {
        throw Object.assign(new Error('insert-refused'), {
          code: `insert-${inserted.status ?? inserted.failure}`,
        });
      }
      const etag = schema?.etag;

      // Step 3. The same name again.
      await insert('3-insert-reused-name');
      evidence.answers.reusedName = statusOf('3-insert-reused-name');

      // Step 4. The etag of step 2 changes the display name, then the same etag goes stale.
      await update(
        '4-update-fresh-etag',
        updateBody(schema, { displayName: renamedDisplayName }),
        etag,
      );
      await update(
        '4-update-stale-if-match',
        updateBody(schema, { displayName: staleDisplayName }),
        etag,
      );
      evidence.answers.staleIfMatch = statusOf('4-update-stale-if-match');

      // Step 5. A display name of 200 characters, then an attribute name of 200 characters.
      await update(
        '5-update-long-display-name',
        updateBody(schema, { displayName: LONG_DISPLAY_NAME }),
      );
      evidence.answers.longDisplayName = statusOf('5-update-long-display-name');
      await update('5-update-long-attribute-name', {
        ...updateBody(schema, {}),
        fields: [
          ...(schema?.fields ?? []).map((field) => fieldBody(field)),
          {
            fieldName: LONG_FIELD_NAME,
            fieldType: 'STRING',
            displayName: 'Long name',
          },
        ],
      });
      evidence.answers.longAttributeName = statusOf(
        '5-update-long-attribute-name',
      );

      // Step 6. The delete, then the same name again.
      const key = keyOf();
      const removed = await attempt(
        '6-delete',
        'schemas.delete',
        'DELETE',
        schemaPath(key),
        { wrote: { schemaKey: key === CATEGORY_NAME ? 'name' : 'id' } },
      );
      if (accepted(removed.status)) {
        owned = false;
        schema = null;
      }
      await insert('6-insert-reused-name');
      evidence.answers.nameReuseAfterDelete = statusOf('6-insert-reused-name');
    }
  } catch (error) {
    failure = codeOf(error);
  } finally {
    try {
      await cleanup();
    } catch (error) {
      failure = failure ?? codeOf(error);
    }
  }

  if (stopped !== null) evidence.stopped = stopped;
  if (failure !== null) evidence.failure = failure;
  const clean =
    evidence.counts.ccLiveCheckAfter === false &&
    evidence.counts.categoriesBefore !== null &&
    evidence.counts.categoriesBefore === evidence.counts.categoriesAfter;
  evidence.status =
    stopped !== null
      ? 'stopped'
      : failure !== null || !clean
        ? 'failed'
        : 'passed';
  evidence.durationMs = Date.now() - started;
  evidence.limitations = [
    'The check proves one category lifecycle and nothing about a user value or a user route.',
    'Step 1 stops the run when the category already exists. That run writes nothing and keeps the category.',
    'The cleanup delete sends no If-Match, so a stale etag cannot block the cleanup.',
    'The evidence holds the count of the categories of this customer and no name of another category.',
    'The production request allowlist admits no schemas path. This proof sends its own calls until that card lands.',
  ];

  const sanitized = sanitizeEvidence(evidence, redactions);
  const path = options.output ?? evidencePathFor(now());
  await writeFile(path, `${JSON.stringify(sanitized, null, 2)}\n`);
  return { evidence: sanitized, path };
}

async function main() {
  const [keyPath, subject, clientId] = process.argv.slice(2);
  if (!keyPath || !subject || !clientId) {
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
  const { evidence, path } = await runCheck({ subject, credential });
  const report = `${JSON.stringify(evidence, null, 2)}\n`;
  if (evidence.status === 'passed') console.log(report);
  else console.error(report);
  console.error(`Evidence written to ${path}`);
  process.exit(evidence.status === 'passed' ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();

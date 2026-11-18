import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  entityEventsChannel,
  googleCustomerIdSchema,
  queryGenerationKey,
  userAttributeCategoryPlanKindSchema,
  type UserAttributeCategoryObservation,
} from '@campus/application-contracts';
import type { EntityCache } from './entity-cache';
import {
  CATEGORY_PART_ID,
  GoogleCategoryWriter,
  GoogleUserReader,
  categoryWriteBodySchema,
  type BatchFailure,
  type BatchResult,
  type CategoryWriteBody,
  type CredentialCipher,
  type DelegatedCredential,
} from '@campus/google-connection';
import { partFailureCode } from './device-update';
import {
  DeviceSyncError,
  callStore,
  type DeviceSyncDatabase,
} from './device-sync';

/**
 * The one request of a category job (design card K16, document B section 7.1). The flow passes the
 * identifiers the admission wrote, and the worker sends the one Google call.
 */
export const userSchemaChangeRequestSchema = z.strictObject({
  customerId: googleCustomerIdSchema,
  jobId: z.uuid(),
  dispatchToken: z.uuid(),
  correlationId: z.uuid(),
});
export type UserSchemaChangeRequest = z.infer<
  typeof userSchemaChangeRequestSchema
>;

/** The job failure vocabulary of `cc.jobs` (B section 7.3 adds the three category codes). */
const jobFailureCodes = new Set([
  'credential-rejected',
  'delegation-not-authorized',
  'api-not-enabled',
  'policy-restricted',
  'network-failure',
  'scope-mismatch',
  'permission-denied',
  'quota',
  'provider-unavailable',
  'invalid-response',
  'wrong-customer',
  'request-failed',
  'key-unavailable',
  'interrupted',
  'orchestration-unavailable',
  'permission-changed',
  'connection-changed',
  'storage-unavailable',
  'inventory-unavailable',
  'export-too-large',
  'drive-unavailable',
  'sheet-write-failed',
  'name-in-use',
  'category-changed',
  'not-found',
]);

function jobFailure(code: string | null | undefined): string {
  return code !== null && code !== undefined && jobFailureCodes.has(code)
    ? code
    : 'request-failed';
}

/**
 * The failure codes that prove no request applied: a refused token mint and an auth refusal. Any
 * other thrown call may have left the worker, so the job reads Google back.
 */
const definitiveErrors = new Set([
  'credential-rejected',
  'delegation-not-authorized',
  'api-not-enabled',
  'policy-restricted',
  'permission-denied',
  'scope-mismatch',
  'quota',
  'key-unavailable',
]);

const claimSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('claimed'),
    generation: z.number().int().positive(),
    credentialId: z.uuid(),
    envelope: z.unknown(),
    action: userAttributeCategoryPlanKindSchema,
    schemaId: z.string().min(1).max(200).nullable(),
    schemaName: z.string().min(1).max(200),
    body: categoryWriteBodySchema.nullable(),
    baseEtag: z.string().min(1).max(1024).nullable(),
    planId: z.uuid(),
    /** True when an earlier attempt began the call. The worker only reads Google back. */
    resume: z.boolean(),
  }),
  z.object({ outcome: z.literal('fenced') }),
  /** Another runner holds a live lease. This runner changes nothing (R1). */
  z.object({ outcome: z.literal('busy') }),
  z.object({
    outcome: z.literal('stopped'),
    failure: z.string().min(1).max(64),
  }),
]);
type Claim = z.infer<typeof claimSchema>;
type Claimed = Extract<Claim, { outcome: 'claimed' }>;

const beginWriteSchema = z.object({
  outcome: z.enum(['writing', 'fenced']),
});

const settlementAnswerSchema = z.object({
  outcome: z.enum(['settled', 'fenced']),
  status: z.string().optional(),
  /** True when the settlement wrote the schema cache, so the worker publishes a schema change. */
  schemaChanged: z.boolean().optional(),
});

/** One part answer of one call. A delete answers no value. */
interface PartAnswer {
  value?: UserAttributeCategoryObservation | null;
  failed?: BatchFailure;
}

/** One settlement of the one call. The schema cache write belongs to the same transaction. */
interface Settlement {
  outcome: 'succeeded' | 'failed' | 'unknown';
  failure: string | null;
  reason: string | null;
  schema: UserAttributeCategoryObservation | null;
  categories: UserAttributeCategoryObservation[] | null;
}

/** What the worker answers the flow. Every answer is a 200, so the flow never retries a settled job. */
export type UserSchemaChangeAnswer =
  | { outcome: 'settled'; status: string }
  | { outcome: 'stopped'; failure: string }
  | { outcome: 'fenced' }
  | { outcome: 'busy' };

export interface UserSchemaChangeOptions {
  /** The deadline of the one Google write part. Defaults to 60 seconds. */
  writeTimeoutMilliseconds?: number;
  /** The deadline of the guard read, the refresh, and the read-back. Defaults to 25 seconds. */
  readTimeoutMilliseconds?: number;
  writer?: Pick<
    GoogleCategoryWriter,
    'category' | 'insertCategory' | 'updateCategory' | 'deleteCategory'
  >;
  reader?: Pick<GoogleUserReader, 'categories'>;
  /** The event cache of the schema change that follows a settlement (B section 6.2 step 5). */
  cache?: Pick<EntityCache, 'increment' | 'publish'>;
}

const DEFAULT_WRITE_TIMEOUT_MS = 60_000;
const DEFAULT_READ_TIMEOUT_MS = 25_000;
/** The pause between two read-back reads (B section 7.1). */
const READ_BACK_PAUSE_MS = 250;

/** Read the one part of a call. A part that neither succeeded nor failed is a store contract break. */
function partAnswer<T>(result: BatchResult<T>): {
  value?: T;
  failed?: BatchFailure;
} {
  const pages = result.succeeded.get(CATEGORY_PART_ID);
  if (pages !== undefined) return { value: pages[pages.length - 1] };
  return { failed: result.failed.get(CATEGORY_PART_ID) };
}

/**
 * The one call of a `user-schema-change` job (document B sections 6.2, 7.1, 7.3, and 9).
 *
 * The claim fences the attempt and returns the frozen plan and the encrypted credential. An edit
 * and a delete compare the fresh `etag` before any write, and a changed `etag` sends nothing (C7).
 * An insert sends one POST and never repeats it. A call without an answer goes through the read-back
 * of B section 7.1, and only a match settles Succeeded.
 */
export class UserSchemaChangeJobs {
  private readonly database: DeviceSyncDatabase;
  private readonly cipher: Pick<CredentialCipher, 'open'>;
  private readonly writer: Pick<
    GoogleCategoryWriter,
    'category' | 'insertCategory' | 'updateCategory' | 'deleteCategory'
  >;
  private readonly reader: Pick<GoogleUserReader, 'categories'>;
  private readonly cache: Pick<EntityCache, 'increment' | 'publish'>;
  private readonly writeTimeoutMilliseconds: number;
  private readonly readTimeoutMilliseconds: number;

  constructor(
    database: DeviceSyncDatabase,
    cipher: Pick<CredentialCipher, 'open'>,
    options: UserSchemaChangeOptions = {},
  ) {
    this.database = database;
    this.cipher = cipher;
    this.writer = options.writer ?? new GoogleCategoryWriter();
    this.reader = options.reader ?? new GoogleUserReader();
    this.cache = options.cache ?? noSchemaEvents;
    this.writeTimeoutMilliseconds =
      options.writeTimeoutMilliseconds ?? DEFAULT_WRITE_TIMEOUT_MS;
    this.readTimeoutMilliseconds =
      options.readTimeoutMilliseconds ?? DEFAULT_READ_TIMEOUT_MS;
  }

  private call(sql: string, values: unknown[]): Promise<unknown> {
    return callStore(this.database, sql, values);
  }

  /** The database clock. The cache read time comes from Google's read, not the worker clock. */
  private async clock(): Promise<Date> {
    const value = await this.call('SELECT clock_timestamp() AS result', []);
    const stamp = new Date(
      value instanceof Date || typeof value === 'string' ? value : Number.NaN,
    );
    if (Number.isNaN(stamp.getTime()))
      throw new DeviceSyncError('store-unavailable');
    return stamp;
  }

  private deadline(signal: AbortSignal, milliseconds: number): AbortSignal {
    return AbortSignal.any([signal, AbortSignal.timeout(milliseconds)]);
  }

  private openCredential(
    claim: Claimed,
    customer: string,
  ): DelegatedCredential {
    return this.cipher.open(claim.envelope, {
      recordId: claim.credentialId,
      customerId: customer,
      generation: claim.generation,
    });
  }

  /** Run the one call of a category job. */
  async run(
    request: UserSchemaChangeRequest,
    signal: AbortSignal,
  ): Promise<UserSchemaChangeAnswer> {
    const input = userSchemaChangeRequestSchema.parse(request);
    const attempt = randomUUID();
    const answer = await this.call(
      'SELECT cc.claim_user_schema_change($1,$2,$3,$4) AS result',
      [input.customerId, input.jobId, input.dispatchToken, attempt],
    );
    const claim = claimSchema.parse(answer);
    if (claim.outcome !== 'claimed') return claim;
    let credential: DelegatedCredential;
    try {
      credential = this.openCredential(claim, input.customerId);
    } catch {
      // A credential that cannot open gives key-unavailable before any request, as a batch does.
      return this.settle(input, attempt, {
        outcome: 'failed',
        failure: 'key-unavailable',
        reason: null,
        schema: null,
        categories: null,
      });
    }
    const settlement = await this.change(
      input,
      claim,
      credential,
      attempt,
      signal,
    );
    if (settlement === 'fenced') return { outcome: 'fenced' };
    return this.settle(input, attempt, settlement);
  }

  /** The one call of the plan, and the read-back of a call without an answer. */
  private async change(
    input: UserSchemaChangeRequest,
    claim: Claimed,
    credential: DelegatedCredential,
    attempt: string,
    signal: AbortSignal,
  ): Promise<Settlement | 'fenced'> {
    // A claim that follows a begun call only reads Google back (B section 7.3).
    if (claim.resume)
      return this.readBack(input, claim, credential, signal, null);
    const body =
      claim.body === null ? null : categoryWriteBodySchema.parse(claim.body);
    if (claim.action === 'edit-category' && body === null)
      return refused('request-failed');
    // C7: the fresh etag compare is the only guard before a write. A changed category sends nothing.
    if (claim.action !== 'create-category') {
      const observed = await this.guard(input, claim, credential, signal);
      if (observed === 'unreadable') return refused('network-failure');
      if (observed === null) return refused('not-found');
      if (claim.baseEtag === null || observed.etag !== claim.baseEtag)
        return {
          ...refused('category-changed'),
          schema: observed,
        };
    }
    // R4: the send gate runs last. A cancel, a lost ownership, or an expired lease before it stops
    // the write here, and the job state already holds the outcome.
    if (!(await this.beginWrite(input, attempt))) return 'fenced';
    let part: PartAnswer;
    try {
      part = await this.send(input, claim, body, credential, signal);
    } catch (error) {
      const code =
        error instanceof Error && 'code' in error
          ? jobFailure(String((error as { code: unknown }).code))
          : 'request-failed';
      if (definitiveErrors.has(code)) return refused(code);
      // The request may have left the worker. The read-back decides (B section 7.1).
      return this.readBack(input, claim, credential, signal, {
        failure: code,
        reason: null,
      });
    }
    if (part.failed !== undefined)
      return this.classify(input, claim, credential, signal, part.failed);
    if (part.value === undefined)
      return { ...refused('invalid-response'), outcome: 'unknown' };
    // B section 7.3: a 2xx answer settles Succeeded only with the requested result. A schema that
    // differs proves the call applied something else, so the job reads Google back (R5).
    if (
      body !== null &&
      (part.value === null || !bodyMatches(part.value, body))
    )
      return {
        outcome: 'unknown',
        failure: 'invalid-response',
        reason: null,
        schema: part.value,
        categories: null,
      };
    return {
      outcome: 'succeeded',
      failure: null,
      reason: null,
      schema: part.value,
      categories: null,
    };
  }

  /** The atomic send gate of R4. True only while this attempt owns the job and no cancel landed. */
  private async beginWrite(
    input: UserSchemaChangeRequest,
    attempt: string,
  ): Promise<boolean> {
    const answer = beginWriteSchema.parse(
      await this.call(
        'SELECT cc.begin_user_schema_change_write($1,$2,$3,$4) AS result',
        [input.customerId, input.jobId, input.dispatchToken, attempt],
      ),
    );
    return answer.outcome === 'writing';
  }

  /** Send the one part of the plan. An update and a delete carry the plan etag in `If-Match`. */
  private async send(
    input: UserSchemaChangeRequest,
    claim: Claimed,
    body: CategoryWriteBody | null,
    credential: DelegatedCredential,
    signal: AbortSignal,
  ): Promise<PartAnswer> {
    const writeSignal = this.deadline(signal, this.writeTimeoutMilliseconds);
    if (claim.action === 'create-category') {
      if (body === null) return { failed: undefined };
      return partAnswer(
        await this.writer.insertCategory(
          credential,
          input.customerId,
          body,
          writeSignal,
        ),
      );
    }
    if (claim.schemaId === null || claim.baseEtag === null)
      return { failed: undefined };
    if (claim.action === 'edit-category') {
      if (body === null) return { failed: undefined };
      return partAnswer(
        await this.writer.updateCategory(
          credential,
          input.customerId,
          claim.schemaId,
          claim.baseEtag,
          body,
          writeSignal,
        ),
      );
    }
    return partAnswer(
      await this.writer.deleteCategory(
        credential,
        input.customerId,
        claim.schemaId,
        claim.baseEtag,
        writeSignal,
      ),
    );
  }

  /** The guard read of an edit or a delete. A read error sent no write, so the job fails. */
  private async guard(
    input: UserSchemaChangeRequest,
    claim: Claimed,
    credential: DelegatedCredential,
    signal: AbortSignal,
  ): Promise<UserAttributeCategoryObservation | null | 'unreadable'> {
    if (claim.schemaId === null) return null;
    try {
      return await this.writer.category(
        credential,
        input.customerId,
        claim.schemaId,
        this.deadline(signal, this.readTimeoutMilliseconds),
      );
    } catch {
      return 'unreadable';
    }
  }

  /**
   * The classification of one part answer (B section 7.3). A first-attempt refusal fails the job. A
   * transient retry or a lost answer leaves the request open, so the read-back decides.
   */
  private async classify(
    input: UserSchemaChangeRequest,
    claim: Claimed,
    credential: DelegatedCredential,
    signal: AbortSignal,
    failed: BatchFailure,
  ): Promise<Settlement> {
    // A lost answer is a network failure. An `auth` failure with status 0 is a refused token mint,
    // and its reason is the code.
    const code =
      failed.kind === 'invalid-response'
        ? 'invalid-response'
        : failed.status === 0 && failed.kind !== 'auth'
          ? 'network-failure'
          : jobFailure(partFailureCode(failed));
    // A transient retry and a lost answer leave a request that may have applied. A POST is never
    // retried, so a transient insert answer reaches the read-back too (B section 7.3).
    // A mint failure carries status 0 with kind `auth` and never left the worker.
    const open =
      failed.kind === 'invalid-response' ||
      failed.kind === 'transient' ||
      (failed.status === 0 && failed.kind !== 'auth') ||
      failed.attempts.transient > 0;
    if (open)
      return this.readBack(input, claim, credential, signal, {
        failure: code,
        reason: failed.reason,
      });
    if (failed.kind === 'auth')
      return { ...refused(code), reason: failed.reason };
    if (failed.kind === 'quota')
      return { ...refused('quota'), reason: failed.reason };
    if (failed.kind === 'not-found')
      return { ...refused('not-found'), reason: failed.reason };
    // C6: an insert answer of 409 or 412 means the name is taken.
    if (
      claim.action === 'create-category' &&
      (failed.status === 409 || failed.status === 412)
    )
      return {
        ...refused('name-in-use'),
        reason: failed.reason,
        categories: await this.refresh(input, credential, signal),
      };
    // C7: an update or a delete that fails its precondition changed under the plan.
    if (claim.action !== 'create-category' && failed.status === 412)
      return {
        ...refused('category-changed'),
        reason: failed.reason,
        categories: await this.refresh(input, credential, signal),
      };
    return { ...refused(code), reason: failed.reason };
  }

  /** One `schemas.list` read after a refused call, so the cache holds the current Google state. */
  private async refresh(
    input: UserSchemaChangeRequest,
    credential: DelegatedCredential,
    signal: AbortSignal,
  ): Promise<UserAttributeCategoryObservation[] | null> {
    try {
      return await this.reader.categories(
        credential,
        input.customerId,
        this.deadline(signal, this.readTimeoutMilliseconds),
      );
    } catch {
      // A failed refresh leaves the cache to the next category read. The outcome still settles.
      return null;
    }
  }

  /**
   * The read-back of B section 7.1. `schemas.get` by `schemaId`, or by `schemaName` for a create.
   * Only a plan match settles Succeeded; a delete answers 404. The read repeats until the read
   * deadline, because the unanswered call may still land (a `hang` past the write timeout does).
   * A read that never matches stays Unknown, because it proves no negative.
   */
  private async readBack(
    input: UserSchemaChangeRequest,
    claim: Claimed,
    credential: DelegatedCredential,
    signal: AbortSignal,
    fallback: { failure: string; reason: string | null } | null,
  ): Promise<Settlement> {
    const key =
      claim.action === 'create-category'
        ? claim.schemaName
        : (claim.schemaId ?? '');
    const body =
      claim.body === null ? null : categoryWriteBodySchema.parse(claim.body);
    const until = Date.now() + this.readTimeoutMilliseconds;
    let observed: UserAttributeCategoryObservation | null = null;
    for (;;) {
      let read: UserAttributeCategoryObservation | null = null;
      let answered = false;
      try {
        read = await this.writer.category(
          credential,
          input.customerId,
          key,
          this.deadline(signal, Math.max(1, until - Date.now())),
        );
        answered = true;
      } catch {
        // A failed read proves nothing, so it never settles a delete.
      }
      if (answered) observed = read;
      if (claim.action === 'delete-category' && answered && read === null)
        return {
          outcome: 'succeeded',
          failure: null,
          reason: null,
          schema: null,
          categories: null,
        };
      if (read !== null && body !== null && bodyMatches(read, body))
        return {
          outcome: 'succeeded',
          failure: null,
          reason: null,
          schema: read,
          categories: null,
        };
      if (Date.now() + READ_BACK_PAUSE_MS > until) break;
      await new Promise((resolve) => setTimeout(resolve, READ_BACK_PAUSE_MS));
    }
    return {
      outcome: 'unknown',
      failure: fallback?.failure ?? 'network-failure',
      reason: fallback?.reason ?? null,
      schema: observed,
      categories: null,
    };
  }

  private async settle(
    input: UserSchemaChangeRequest,
    attempt: string,
    settlement: Settlement,
  ): Promise<UserSchemaChangeAnswer> {
    const observedAt = await this.clock();
    const answer = settlementAnswerSchema.parse(
      await this.call(
        'SELECT cc.settle_user_schema_change($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS result',
        [
          input.customerId,
          input.jobId,
          input.dispatchToken,
          attempt,
          settlement.outcome,
          settlement.failure,
          settlement.reason,
          settlement.schema === null ? null : JSON.stringify(settlement.schema),
          settlement.categories === null
            ? null
            : JSON.stringify(settlement.categories),
          observedAt.toISOString(),
        ],
      ),
    );
    if (answer.outcome === 'fenced') return { outcome: 'fenced' };
    // B section 6.2 step 5 and section 9: the worker publishes the schema change after the
    // settlement committed, and moves the user query generation so no cached query serves the old
    // values (R6).
    if (answer.schemaChanged) await this.publishSchemaChange(input.customerId);
    return { outcome: 'settled', status: String(answer.status ?? '') };
  }

  /**
   * Publish one schema change on the entity channel and invalidate the user query cache. A Redis
   * failure leaves the next category read and the next user query to fill both; it never fails a
   * settled job.
   */
  private async publishSchemaChange(customerId: string): Promise<void> {
    try {
      await this.cache.increment(queryGenerationKey('user', customerId));
      await this.cache.publish(
        entityEventsChannel(customerId),
        JSON.stringify({ type: 'schema-change', entityType: 'user' }),
      );
    } catch {
      // The next read fills the cache.
    }
  }
}

/** The event cache when Redis is not configured. A settled job never fails on a missing cache. */
const noSchemaEvents: Pick<EntityCache, 'increment' | 'publish'> = {
  increment: async () => undefined,
  publish: async () => undefined,
};

/** A settlement that stored no schema. */
function refused(failure: string): Settlement {
  return {
    outcome: 'failed',
    failure,
    reason: null,
    schema: null,
    categories: null,
  };
}

/** Compare the observed category with the plan body that the write sent (B section 7.1). The
 * comparison covers every requested property: the label, each attribute, its retained Google field
 * ID, and its number range (R5). */
export function bodyMatches(
  observed: UserAttributeCategoryObservation,
  body: CategoryWriteBody,
): boolean {
  if (observed.schemaName !== body.schemaName) return false;
  if (observed.displayName !== body.displayName) return false;
  if (observed.fields.length !== body.fields.length) return false;
  for (const field of body.fields) {
    const seen = observed.fields.find(
      (one) => one.fieldName === field.fieldName,
    );
    if (seen === undefined) return false;
    if (field.fieldId !== undefined && seen.fieldId !== field.fieldId)
      return false;
    if (seen.displayName !== field.displayName) return false;
    if (seen.fieldType !== field.fieldType) return false;
    if (seen.multiValued !== (field.multiValued ?? false)) return false;
    if (seen.indexed !== (field.indexed ?? true)) return false;
    if (seen.readAccessType !== (field.readAccessType ?? 'ALL_DOMAIN_USERS'))
      return false;
    if (!sameRange(seen.numericIndexingSpec, field.numericIndexingSpec ?? null))
      return false;
  }
  return true;
}

/** Compare two number ranges. An absent range equals a range with two null bounds (C3). */
function sameRange(
  seen: { minValue: number | null; maxValue: number | null } | null,
  wanted: { minValue: number | null; maxValue: number | null } | null,
): boolean {
  return (
    (seen?.minValue ?? null) === (wanted?.minValue ?? null) &&
    (seen?.maxValue ?? null) === (wanted?.maxValue ?? null)
  );
}

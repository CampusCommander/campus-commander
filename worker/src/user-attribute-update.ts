import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  entityEventSchema,
  entityEventsChannel,
  entityKey,
  googleCustomerIdSchema,
  queryGenerationKey,
  userAttributeFailureText,
  userCustomSchemasSchema,
  type UserCustomSchemas,
  type UserObservation,
} from '@campus/application-contracts';
import {
  GoogleUserWriter,
  ValueSendRefused,
  type BatchFailure,
  type CredentialCipher,
  type DelegatedCredential,
  type UserValueWrite,
  type ValueSendGate,
} from '@campus/google-connection';
import type { EntityCache } from './entity-cache';
import { partFailureCode } from './device-update';
import {
  DeviceSyncError,
  callStore,
  type DeviceSyncDatabase,
} from './device-sync';

/** One run of one value job (design card K24, document B section 7.2). */
export const userAttributeUpdateRequestSchema = z.strictObject({
  customerId: googleCustomerIdSchema,
  jobId: z.uuid(),
  dispatchToken: z.uuid(),
  correlationId: z.uuid(),
});
export type UserAttributeUpdateRequest = z.infer<
  typeof userAttributeUpdateRequestSchema
>;

/** One read-back of one Unknown operation (B section 7.3). */
export const userAttributeReconcileRequestSchema = z.strictObject({
  customerId: googleCustomerIdSchema,
  jobId: z.uuid(),
  operationNumber: z.coerce.number().int().min(1),
  verifyAttempt: z.uuid().optional(),
  correlationId: z.uuid(),
});
export type UserAttributeReconcileRequest = z.infer<
  typeof userAttributeReconcileRequestSchema
>;

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
 * The failure codes that prove no request applied. Every other thrown call may have left the worker,
 * so its parts stay Unknown and the read-back decides (B section 7.3).
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

/** One changed attribute of the preview. The type comes from the category cache (B section 8.1). */
const workFieldSchema = z.strictObject({
  schemaName: z.string().min(1).max(200),
  fieldName: z.string().min(1).max(200),
  fieldType: z.string().min(1).max(64).nullable(),
  multiValued: z.boolean(),
});
export type WorkField = z.infer<typeof workFieldSchema>;

/** One eligible user of the preview, as one write part and one read part. */
const workUserSchema = z.strictObject({
  ordinal: z.number().int().min(0),
  userId: z.string().min(1).max(128),
  primaryEmail: z.string().min(1).max(254),
  customSchemas: userCustomSchemasSchema,
});
export type WorkUser = z.infer<typeof workUserSchema>;

const claimSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('claimed'),
    generation: z.number().int().positive(),
    credentialId: z.uuid(),
    envelope: z.unknown(),
    source: z.enum(['selection', 'edit-list']),
    fields: z.array(workFieldSchema),
    mask: z.array(z.string()).min(1),
    users: z.array(workUserSchema).max(250),
    remaining: z.boolean(),
  }),
  z.object({ outcome: z.literal('fenced') }),
  /** Another runner holds a live lease. This runner changes nothing (R1). */
  z.object({ outcome: z.literal('busy') }),
  z.object({
    outcome: z.literal('stopped'),
    failure: z.string().min(1).max(64),
  }),
  z.object({ outcome: z.literal('done'), status: z.string().min(1).max(64) }),
]);
type Claim = z.infer<typeof claimSchema>;
type Claimed = Extract<Claim, { outcome: 'claimed' }>;

const verificationSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('claimed'),
    generation: z.number().int().positive(),
    credentialId: z.uuid(),
    envelope: z.unknown(),
    source: z.enum(['selection', 'edit-list']),
    fields: z.array(workFieldSchema),
    mask: z.array(z.string()).min(1),
    users: z.array(workUserSchema).max(250),
    remaining: z.number().int().min(0),
    waitMilliseconds: z.number().int().min(0),
  }),
  z.object({ outcome: z.literal('fenced') }),
  z.object({ outcome: z.literal('busy') }),
  z.object({
    outcome: z.literal('stopped'),
    failure: z.string().min(1).max(64),
  }),
  z.object({ outcome: z.literal('done'), status: z.string().min(1).max(64) }),
]);
type Verification = z.infer<typeof verificationSchema>;
type Verified = Extract<Verification, { outcome: 'claimed' }>;

const settlementSchema = z.object({
  outcome: z.enum(['settled', 'fenced']),
  status: z.string().optional(),
  changed: z.array(z.string()).optional(),
  removed: z.array(z.string()).optional(),
  remaining: z.boolean().optional(),
});

const finishSchema = z.object({
  outcome: z.enum(['finished', 'busy', 'fenced']),
  status: z.string().optional(),
});

const verificationReadSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('read'),
    ordinal: z.number().int().min(0),
    generation: z.number().int().positive(),
    credentialId: z.uuid(),
    envelope: z.unknown(),
    mask: z.array(z.string()).min(1),
    fields: z.array(workFieldSchema),
    user: workUserSchema,
  }),
  z.object({ outcome: z.literal('fenced') }),
]);

const verificationSettlementSchema = z.object({
  outcome: z.enum(['settled', 'fenced']),
  status: z.string().optional(),
  removed: z.array(z.string()).optional(),
  outcomeOf: z.string().optional(),
});

/** One part answer of one envelope. */
interface PartAnswer {
  observation?: UserObservation;
  failed?: BatchFailure;
}

/** One user settlement of one envelope or one read-back (B section 7.3). */
export interface UserValueResult {
  ordinal: number;
  outcome: 'succeeded' | 'failed' | 'unknown';
  failure: string | null;
  reason: string | null;
  googleStatus: number | null;
  googleReason: string | null;
  verifiedBy: 'write-response' | 'read-back' | null;
  observed: UserCustomSchemas | null;
}

/** What the worker answers the flow. Every answer is a 200, so the flow retries only a lost request. */
export type UserAttributeUpdateAnswer =
  | { outcome: 'settled'; status: string }
  | { outcome: 'stopped'; failure: string }
  | { outcome: 'fenced' }
  | { outcome: 'busy' };

export interface UserAttributeUpdateOptions {
  /** The deadline of one envelope. Defaults to 60 seconds. */
  writeTimeoutMilliseconds?: number;
  /** The deadline of one masked read. Defaults to 25 seconds. */
  readTimeoutMilliseconds?: number;
  /** The longest pause between two read-back claims. Defaults to 30 seconds. */
  maximumPauseMilliseconds?: number;
  /** The event cache of the settled users (B section 9). */
  cache?: Pick<EntityCache, 'increment' | 'publish' | 'remove'>;
  writer?: Pick<GoogleUserWriter, 'writeValues'>;
  reader?: Pick<GoogleUserWriter, 'valueReads'>;
  /** The pause of the read-back loop. A test replaces it to control the clock. */
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

const DEFAULT_WRITE_TIMEOUT_MS = 60_000;
const DEFAULT_READ_TIMEOUT_MS = 25_000;
const DEFAULT_MAXIMUM_PAUSE_MS = 30_000;
/** The smallest pause of the read-back loop. */
const MINIMUM_PAUSE_MS = 100;
/** B section 7.31: the read-back starts 30 seconds after the write answer or later (C11). */
export const READ_BACK_DELAY_SECONDS = 30;

/** The pause of the read-back loop, without a long or negative wait. */
function pauseMilliseconds(wait: number, maximum: number): number {
  if (!Number.isFinite(wait) || wait < MINIMUM_PAUSE_MS)
    return MINIMUM_PAUSE_MS;
  return Math.min(Math.round(wait), maximum);
}

const realSleep = (milliseconds: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
    signal.addEventListener('abort', () => resolve(), { once: true });
  });

/**
 * The value job of one confirmed preview (document B sections 7.2, 7.3, 7.4, and 9).
 *
 * The claim fences one attempt and returns up to 250 pending users with their final values. Each
 * envelope is one batch call, and a body with a `null` leaves as `users.update` (C9). A 2xx answer
 * that does not hold the requested values stays Unknown (C11), and a read-back that cannot prove a
 * value leaves it Unknown too (C10). A read-back starts no earlier than 30 seconds after the write
 * answer, and only a match settles Succeeded. A 404 settles Failed `not-found` and removes the user.
 */
export class UserAttributeUpdateJobs {
  private readonly database: DeviceSyncDatabase;
  private readonly cipher: Pick<CredentialCipher, 'open'>;
  private readonly cache: Pick<EntityCache, 'increment' | 'publish' | 'remove'>;
  private readonly writer: Pick<GoogleUserWriter, 'writeValues'>;
  private readonly reader: Pick<GoogleUserWriter, 'valueReads'>;
  private readonly writeTimeoutMilliseconds: number;
  private readonly readTimeoutMilliseconds: number;
  private readonly maximumPauseMilliseconds: number;
  private readonly sleep: (
    milliseconds: number,
    signal: AbortSignal,
  ) => Promise<void>;

  constructor(
    database: DeviceSyncDatabase,
    cipher: Pick<CredentialCipher, 'open'>,
    options: UserAttributeUpdateOptions = {},
  ) {
    this.database = database;
    this.cipher = cipher;
    const writer = options.writer ?? new GoogleUserWriter();
    const reader = options.reader ?? new GoogleUserWriter();
    this.writer = writer;
    this.reader = reader;
    this.cache = options.cache ?? noValueEvents;
    this.writeTimeoutMilliseconds =
      options.writeTimeoutMilliseconds ?? DEFAULT_WRITE_TIMEOUT_MS;
    this.readTimeoutMilliseconds =
      options.readTimeoutMilliseconds ?? DEFAULT_READ_TIMEOUT_MS;
    this.maximumPauseMilliseconds =
      options.maximumPauseMilliseconds ?? DEFAULT_MAXIMUM_PAUSE_MS;
    this.sleep = options.sleep ?? realSleep;
  }

  private call(sql: string, values: unknown[]): Promise<unknown> {
    return callStore(this.database, sql, values);
  }

  /** The database clock. Every fence time comes from it, never from the worker clock. */
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
    claim: { credentialId: string; envelope: unknown },
    customer: string,
    generation: number,
  ): DelegatedCredential {
    return this.cipher.open(claim.envelope, {
      recordId: claim.credentialId,
      customerId: customer,
      generation,
    });
  }

  private async claim(
    input: UserAttributeUpdateRequest,
    attempt: string,
  ): Promise<Claim> {
    return claimSchema.parse(
      await this.call(
        'SELECT cc.claim_user_attribute_updates($1,$2,$3,$4,$5) AS result',
        [input.customerId, input.jobId, input.dispatchToken, attempt, 250],
      ),
    );
  }

  private async settlement(
    input: UserAttributeUpdateRequest,
    attempt: string,
    results: UserValueResult[],
    failure: string | null,
  ) {
    const observedAt = await this.clock();
    return settlementSchema.parse(
      await this.call(
        'SELECT cc.settle_user_attribute_updates($1,$2,$3,$4,$5,$6,$7) AS result',
        [
          input.customerId,
          input.jobId,
          input.dispatchToken,
          attempt,
          JSON.stringify(results),
          observedAt.toISOString(),
          failure,
        ],
      ),
    );
  }

  /** Run the whole job: every envelope, then every read-back, then the finish. */
  async run(
    request: UserAttributeUpdateRequest,
    signal: AbortSignal,
  ): Promise<UserAttributeUpdateAnswer> {
    const input = userAttributeUpdateRequestSchema.parse(request);
    const attempt = randomUUID();
    let credential: DelegatedCredential | null = null;
    let fields: WorkField[] = [];
    let batch = 0;
    // 1. The envelopes. The claim ends the job for a cancel, a stop reason, or a finished header.
    for (;;) {
      if (signal.aborted) return { outcome: 'busy' };
      const claim = await this.claim(input, attempt);
      if (claim.outcome !== 'claimed') return answerOf(claim);
      if (credential === null) {
        try {
          credential = this.openCredential(
            claim,
            input.customerId,
            claim.generation,
          );
        } catch {
          return this.stopFor(input, attempt, 'key-unavailable');
        }
      }
      fields = claim.fields;
      if (claim.users.length === 0) break;
      const sent = await this.writeEnvelope(
        input,
        claim,
        credential,
        attempt,
        batch,
        fields,
        signal,
      );
      batch += 1;
      if (sent === 'fenced') return { outcome: 'fenced' };
    }
    // 2. The read-back of every Unknown user, no earlier than 30 seconds after its write answer.
    for (;;) {
      if (signal.aborted) return { outcome: 'busy' };
      const verified = verificationSchema.parse(
        await this.call(
          'SELECT cc.claim_user_attribute_verification($1,$2,$3,$4,$5) AS result',
          [input.customerId, input.jobId, attempt, null, 250],
        ),
      );
      if (verified.outcome !== 'claimed') return answerOf(verified);
      if (verified.users.length === 0) {
        if (verified.remaining === 0) break;
        await this.sleep(
          pauseMilliseconds(
            verified.waitMilliseconds,
            this.maximumPauseMilliseconds,
          ),
          signal,
        );
        continue;
      }
      if (credential === null) {
        try {
          credential = this.openCredential(
            verified,
            input.customerId,
            verified.generation,
          );
        } catch {
          // The read-back cannot run without the credential. The job keeps Needs review.
          break;
        }
      }
      const read = await this.readEnvelope(
        input,
        verified,
        credential,
        attempt,
        fields,
        signal,
      );
      if (read === 'fenced') return { outcome: 'fenced' };
    }
    // 3. The one terminal decision.
    return this.finish(input, attempt);
  }

  /** One envelope: one call, and one settlement of its parts (B section 7.3). */
  private async writeEnvelope(
    input: UserAttributeUpdateRequest,
    claim: Claimed,
    credential: DelegatedCredential,
    attempt: string,
    batch: number,
    fields: WorkField[],
    signal: AbortSignal,
  ): Promise<'sent' | 'fenced'> {
    const writes: UserValueWrite[] = claim.users.map((user) => ({
      userId: user.userId,
      customSchemas: user.customSchemas,
    }));
    const writeSignal = this.deadline(signal, this.writeTimeoutMilliseconds);
    const beforeSend: ValueSendGate = () => this.beginWrite(input, attempt);
    const onRound = async () => {
      await this.extendAttempt(input, attempt);
    };
    let parts: Map<string, PartAnswer>;
    try {
      const result = await this.writer.writeValues(
        credential,
        writes,
        writeSignal,
        onRound,
        beforeSend,
      );
      parts = new Map();
      for (const write of writes) {
        const pages = result.succeeded.get(write.userId);
        if (pages !== undefined) {
          parts.set(write.userId, { observation: pages[pages.length - 1] });
          continue;
        }
        const failed = result.failed.get(write.userId);
        if (failed !== undefined) parts.set(write.userId, { failed });
      }
    } catch (error) {
      // The gate refused the envelope, so nothing left the worker and the SQL fence already holds.
      if (error instanceof ValueSendRefused) return 'fenced';
      const code =
        error instanceof Error && 'code' in error
          ? jobFailure(String((error as { code: unknown }).code))
          : 'request-failed';
      if (definitiveErrors.has(code)) {
        // No part of this envelope reached Google. Each part settles the same failure.
        await this.settleAndPublish(
          input,
          attempt,
          claim.users.map((user) => ({
            ordinal: user.ordinal,
            outcome: 'failed' as const,
            failure: code,
            reason: null,
            googleStatus: null,
            googleReason: null,
            verifiedBy: null,
            observed: null,
          })),
          code,
          batch,
        );
        return 'sent';
      }
      // The envelope may have left the worker. Every part stays Unknown and the read-back decides.
      await this.settleAndPublish(
        input,
        attempt,
        claim.users.map((user) => ({
          ordinal: user.ordinal,
          outcome: 'unknown' as const,
          failure: code,
          reason: null,
          googleStatus: null,
          googleReason: null,
          verifiedBy: null,
          observed: null,
        })),
        code,
        batch,
      );
      return 'sent';
    }
    const results = claim.users.map((user) =>
      classifyPart(user, parts.get(user.userId), fields),
    );
    await this.settleAndPublish(input, attempt, results, null, batch);
    return 'sent';
  }

  /** One read-back envelope: the masked read of each Unknown user (B section 7.3). */
  private async readEnvelope(
    input: UserAttributeUpdateRequest,
    claim: Verified,
    credential: DelegatedCredential,
    attempt: string,
    _fields: WorkField[],
    signal: AbortSignal,
  ): Promise<'sent' | 'fenced'> {
    const users = claim.users;
    if (users.length === 0) return 'sent';
    let read: {
      values: Map<string, UserCustomSchemas>;
      missing: string[];
      failed: Map<string, BatchFailure>;
    };
    try {
      read = await this.reader.valueReads(
        credential,
        users.map((user) => user.userId),
        claim.mask,
        this.deadline(signal, this.readTimeoutMilliseconds),
      );
    } catch {
      // A read that proves nothing leaves every user Unknown (C10). The next pass reads again.
      return 'sent';
    }
    const results: UserValueResult[] = users.map((user) => {
      if (read.missing.includes(user.userId)) return notFound(user);
      const failed = read.failed.get(user.userId);
      if (failed !== undefined) {
        // A 400 `invalid` of the mask and every other refusal prove no value (C10).
        return {
          ordinal: user.ordinal,
          outcome: 'unknown' as const,
          failure: jobFailure(partFailureCode(failed)),
          reason: failed.reason,
          googleStatus: failed.status === 0 ? null : failed.status,
          googleReason: failed.reason,
          verifiedBy: 'read-back',
          observed: null,
        };
      }
      const observed = read.values.get(user.userId);
      if (observed === undefined) {
        return {
          ordinal: user.ordinal,
          outcome: 'unknown' as const,
          failure: 'invalid-response',
          reason: null,
          googleStatus: null,
          googleReason: null,
          verifiedBy: 'read-back',
          observed: null,
        };
      }
      return compareUser(user, observed, claim.fields, 'read-back');
    });
    await this.settleAndPublish(input, attempt, results, null, 0);
    return 'sent';
  }

  /** Settle one batch and publish what it changed (B section 9). */
  private async settleAndPublish(
    input: UserAttributeUpdateRequest,
    attempt: string,
    results: UserValueResult[],
    failure: string | null,
    batch: number,
  ): Promise<void> {
    const settled = await this.settlement(input, attempt, results, failure);
    if (settled.outcome !== 'settled') return;
    await this.publish(
      input.customerId,
      input.jobId,
      batch,
      settled.changed ?? [],
      settled.removed ?? [],
    );
  }

  /** The send gate of one envelope. True only while this attempt owns the job and no cancel landed. */
  private async beginWrite(
    input: UserAttributeUpdateRequest,
    attempt: string,
  ): Promise<boolean> {
    const answer = z
      .object({ outcome: z.enum(['writing', 'fenced']) })
      .parse(
        await this.call(
          'SELECT cc.begin_user_attribute_write($1,$2,$3,$4) AS result',
          [input.customerId, input.jobId, input.dispatchToken, attempt],
        ),
      );
    return answer.outcome === 'writing';
  }

  /** Extend the attempt lease after one multipart round (R1). */
  private async extendAttempt(
    input: UserAttributeUpdateRequest,
    attempt: string,
  ): Promise<void> {
    await this.call(
      'SELECT cc.extend_user_attribute_attempt($1,$2,$3) AS result',
      [input.customerId, input.jobId, attempt],
    );
  }

  private async stopFor(
    input: UserAttributeUpdateRequest,
    attempt: string,
    failure: string,
  ): Promise<UserAttributeUpdateAnswer> {
    const results = await this.settlement(input, attempt, [], failure);
    if (results.outcome === 'fenced') return { outcome: 'fenced' };
    const finished = await this.finish(input, attempt, failure);
    return finished;
  }

  private async finish(
    input: UserAttributeUpdateRequest,
    attempt: string,
    failure: string | null = null,
  ): Promise<UserAttributeUpdateAnswer> {
    const answer = finishSchema.parse(
      await this.call(
        'SELECT cc.finish_user_attribute_job($1,$2,$3,$4,$5) AS result',
        [input.customerId, input.jobId, input.dispatchToken, attempt, failure],
      ),
    );
    if (answer.outcome === 'finished')
      return { outcome: 'settled', status: String(answer.status ?? '') };
    if (answer.outcome === 'fenced') return { outcome: 'fenced' };
    // A remaining envelope keeps the job running for the recovery.
    return { outcome: 'busy' };
  }

  /**
   * One read-back of one Unknown operation, or of every Unknown operation of the job (B section
   * 7.3). The reconcile route claimed the operation, so this path changes only that settlement.
   */
  async reconcile(
    request: UserAttributeReconcileRequest,
    signal: AbortSignal,
  ): Promise<UserAttributeUpdateAnswer> {
    const input = userAttributeReconcileRequestSchema.parse(request);
    // A flow without an attempt claims its own, so the route may omit it.
    const attempt = input.verifyAttempt ?? randomUUID();
    if (input.verifyAttempt === undefined) {
      const claimed = await this.call(
        'SELECT cc.claim_user_attribute_verification_one($1,$2,$3,$4) AS result',
        [input.customerId, input.jobId, attempt, input.operationNumber],
      );
      const outcome = z.object({ outcome: z.string() }).parse(claimed).outcome;
      if (outcome !== 'claimed') return { outcome: 'busy' };
    }
    const read = verificationReadSchema.parse(
      await this.call(
        'SELECT cc.read_user_attribute_verification($1,$2,$3,$4) AS result',
        [input.customerId, input.jobId, attempt, input.operationNumber],
      ),
    );
    if (read.outcome !== 'read') return { outcome: 'fenced' };
    let credential: DelegatedCredential;
    try {
      credential = this.openCredential(read, input.customerId, read.generation);
    } catch {
      return { outcome: 'busy' };
    }
    let observed: UserCustomSchemas | null = null;
    let missing = false;
    let failed: BatchFailure | undefined;
    try {
      const answer = await this.reader.valueReads(
        credential,
        [read.user.userId],
        read.mask,
        this.deadline(signal, this.readTimeoutMilliseconds),
      );
      missing = answer.missing.includes(read.user.userId);
      failed = answer.failed.get(read.user.userId);
      observed = answer.values.get(read.user.userId) ?? null;
    } catch {
      // A read that proves nothing keeps the operation Unknown.
    }
    const result: UserValueResult = missing
      ? notFound(read.user)
      : failed !== undefined
        ? {
            ordinal: read.user.ordinal,
            outcome: 'unknown',
            failure: jobFailure(partFailureCode(failed)),
            reason: failed.reason,
            googleStatus: failed.status === 0 ? null : failed.status,
            googleReason: failed.reason,
            verifiedBy: 'read-back',
            observed: null,
          }
        : observed === null
          ? {
              ordinal: read.user.ordinal,
              outcome: 'unknown',
              failure: 'invalid-response',
              reason: null,
              googleStatus: null,
              googleReason: null,
              verifiedBy: 'read-back',
              observed: null,
            }
          : compareUser(read.user, observed, read.fields, 'read-back');
    const observedAt = await this.clock();
    const settled = verificationSettlementSchema.parse(
      await this.call(
        'SELECT cc.settle_user_attribute_verification($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) AS result',
        [
          input.customerId,
          input.jobId,
          attempt,
          read.ordinal,
          result.outcome,
          result.failure,
          result.reason,
          result.googleStatus,
          result.googleReason,
          result.observed === null ? null : JSON.stringify(result.observed),
          observedAt.toISOString(),
        ],
      ),
    );
    if (settled.outcome !== 'settled') return { outcome: 'fenced' };
    if (result.outcome === 'succeeded')
      await this.publish(
        input.customerId,
        input.jobId,
        0,
        [read.user.userId],
        [],
      );
    if ((settled.removed ?? []).length > 0)
      await this.publish(
        input.customerId,
        input.jobId,
        0,
        [],
        settled.removed ?? [],
      );
    return { outcome: 'settled', status: String(settled.status ?? '') };
  }

  /**
   * Publish the users that one settlement changed or removed, and move the user query generation
   * (B section 9). A Redis failure leaves the next read to fill both; it never fails a settled job.
   */
  private async publish(
    customerId: string,
    jobId: string,
    batch: number,
    changed: string[],
    removed: string[],
  ): Promise<void> {
    if (changed.length === 0 && removed.length === 0) return;
    try {
      if (removed.length > 0)
        await this.cache.remove(
          removed.map((id) => entityKey('user', customerId, id)),
        );
      await this.cache.increment(queryGenerationKey('user', customerId));
      await this.cache.publish(
        entityEventsChannel(customerId),
        JSON.stringify(
          entityEventSchema.parse({
            type: 'entity-batch',
            jobId,
            entityType: 'user',
            batch,
            batchCount: 1,
            deviceIds: changed,
            removedIds: removed,
          }),
        ),
      );
    } catch {
      // The next read fills the cache.
    }
  }
}

/** The event cache when Redis is not configured. A settled job never fails on a missing cache. */
const noValueEvents: Pick<EntityCache, 'increment' | 'publish' | 'remove'> = {
  increment: async () => undefined,
  publish: async () => undefined,
  remove: async () => undefined,
};

/** Map one claim outcome to the flow answer. Every answer is a 200. */
function answerOf(claim: Claim | Verification): UserAttributeUpdateAnswer {
  if (claim.outcome === 'stopped')
    return { outcome: 'stopped', failure: claim.failure };
  if (claim.outcome === 'done')
    return { outcome: 'settled', status: claim.status };
  return claim.outcome === 'busy' ? { outcome: 'busy' } : { outcome: 'fenced' };
}

/** A 404 of a write or a read settles Failed `not-found` and removes the user (B section 13). */
function notFound(user: WorkUser): UserValueResult {
  return {
    ordinal: user.ordinal,
    outcome: 'failed',
    failure: 'not-found',
    // The drafted text of UM notes question 7 belongs beside the code (design card K24).
    reason: userAttributeFailureText('not-found'),
    googleStatus: 404,
    googleReason: 'notFound',
    verifiedBy: 'read-back',
    observed: null,
  };
}

/** The classification of one part of one envelope (B section 7.3). */
export function classifyPart(
  user: WorkUser,
  part: PartAnswer | undefined,
  fields: readonly WorkField[],
): UserValueResult {
  if (part === undefined)
    return {
      ordinal: user.ordinal,
      outcome: 'unknown',
      failure: 'invalid-response',
      reason: null,
      googleStatus: null,
      googleReason: null,
      verifiedBy: null,
      observed: null,
    };
  const failed = part.failed;
  if (failed !== undefined) {
    // A 404 part is a missing user, and it settles Failed `not-found` (B section 13).
    if (failed.kind === 'not-found') return notFound(user);
    return {
      ordinal: user.ordinal,
      outcome: 'failed',
      failure: jobFailure(partFailureCode(failed)),
      reason: failed.reason,
      googleStatus: failed.status === 0 ? null : failed.status,
      googleReason: failed.reason,
      verifiedBy: null,
      observed: null,
    };
  }
  const observation = part.observation;
  if (observation === undefined)
    return {
      ordinal: user.ordinal,
      outcome: 'unknown',
      failure: 'invalid-response',
      reason: null,
      googleStatus: 200,
      googleReason: null,
      verifiedBy: null,
      observed: null,
    };
  const observed = observation.customSchemas ?? {};
  return compareUser(user, observed, fields, 'write-response');
}

/**
 * Compare the observed values of one user with the requested values (B sections 7.3 and 8.4). A
 * match settles Succeeded with `write-response` or `read-back`. A difference answers Unknown for a
 * write answer, because only a match proves the write (C11), and Failed `value-differs` for a read.
 */
export function compareUser(
  user: WorkUser,
  observed: UserCustomSchemas,
  fields: readonly WorkField[],
  verifiedBy: 'write-response' | 'read-back',
): UserValueResult {
  const differs = changedValues(user.customSchemas, observed, fields);
  if (!differs) {
    return {
      ordinal: user.ordinal,
      outcome: 'succeeded',
      failure: null,
      reason: null,
      googleStatus: 200,
      googleReason: null,
      verifiedBy,
      observed,
    };
  }
  return {
    ordinal: user.ordinal,
    outcome: verifiedBy === 'write-response' ? 'unknown' : 'failed',
    failure:
      verifiedBy === 'write-response' ? 'invalid-response' : 'request-failed',
    reason: verifiedBy === 'write-response' ? null : 'value-differs',
    googleStatus: 200,
    googleReason: null,
    verifiedBy,
    observed,
  };
}

/** True when any requested attribute of the user differs from the observed value. */
export function changedValues(
  requested: UserCustomSchemas,
  observed: UserCustomSchemas,
  fields: readonly WorkField[],
): boolean {
  const types = new Map(
    fields.map((field) => [
      `${field.schemaName}\u0000${field.fieldName}`,
      field,
    ]),
  );
  for (const [schemaName, attributes] of Object.entries(requested)) {
    for (const [fieldName, wanted] of Object.entries(attributes ?? {})) {
      const field = types.get(`${schemaName}\u0000${fieldName}`);
      const seen = observed[schemaName]?.[fieldName];
      if (!sameValue(wanted, seen, field)) return true;
    }
  }
  return false;
}

/**
 * Compare one requested value with the observed value in the canonical form of B section 8.1: an
 * INT64 or DOUBLE compares as a number, a BOOL compares as a boolean, and a list compares entry by
 * entry in order. A missing value equals a clear (a requested `null`).
 */
export function sameValue(
  requested: unknown,
  observed: unknown,
  field?: WorkField,
): boolean {
  const wanted = entries(requested);
  const seen = entries(observed);
  if (wanted === null || seen === null) return wanted === seen;
  if (wanted.length !== seen.length) return false;
  for (let index = 0; index < wanted.length; index += 1) {
    if (!sameScalar(wanted[index], seen[index], field?.fieldType ?? null))
      return false;
  }
  return true;
}

/** The values of one Google form value, or null for no value. */
function entries(value: unknown): (string | number | boolean)[] | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    return value.map((entry) =>
      entry !== null && typeof entry === 'object' && 'value' in entry
        ? ((entry as { value: string | number | boolean }).value ?? '')
        : (entry as string | number | boolean),
    );
  }
  if (typeof value === 'object' && 'value' in value)
    return [(value as { value: string | number | boolean }).value ?? ''];
  return [value as string | number | boolean];
}

/** Compare two scalar values in the canonical form of their field type. */
function sameScalar(
  wanted: string | number | boolean,
  seen: string | number | boolean,
  fieldType: string | null,
): boolean {
  if (typeof wanted === 'string' && typeof seen === 'string') {
    if (fieldType === 'EMAIL')
      return wanted.toLowerCase() === seen.toLowerCase();
    return wanted === seen;
  }
  const number = (value: string | number | boolean): number =>
    typeof value === 'boolean' ? (value ? 1 : 0) : Number(value);
  if (
    fieldType === 'INT64' ||
    fieldType === 'DOUBLE' ||
    typeof wanted === 'number' ||
    typeof seen === 'number'
  ) {
    const left = number(wanted);
    const right = number(seen);
    return Number.isFinite(left) && Number.isFinite(right) && left === right;
  }
  if (typeof wanted === 'boolean' || typeof seen === 'boolean') {
    const flag = (value: string | number | boolean): boolean =>
      value === true || value === 'true';
    return flag(wanted) === flag(seen);
  }
  return String(wanted) === String(seen);
}

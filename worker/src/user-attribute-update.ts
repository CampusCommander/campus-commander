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
 * The failure codes that stop the job (B sections 7.3 and 7.4). A fatal auth answer repeats for every
 * later part, so no further envelope leaves the worker and the unsent users settle Skipped. Every
 * other thrown failure is ambiguous and leaves its parts Unknown for the read-back.
 */
const stopErrors = new Set([
  'credential-rejected',
  'delegation-not-authorized',
  'api-not-enabled',
  'policy-restricted',
  'permission-denied',
  'scope-mismatch',
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
  changed: z.array(z.string()).optional(),
  removed: z.array(z.string()).optional(),
  outcomeOf: z.string().optional(),
});

/** What one envelope answers its runner (B sections 7.3 and 7.4). */
type EnvelopeAnswer =
  | { outcome: 'sent' }
  | { outcome: 'fenced' }
  | { outcome: 'stop'; failure: string }
  | { outcome: 'cancel' };

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
          // No part left the worker. The claimed users settle Skipped and the job ends (B section 7.3).
          return this.stopJob(input, attempt, 'key-unavailable');
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
      if (sent.outcome === 'fenced') return { outcome: 'fenced' };
      // A fatal auth answer stops the job after its envelope settles (B sections 7.3 and 7.4).
      if (sent.outcome === 'stop')
        return this.stopJob(input, attempt, sent.failure);
      // A cancel that refused the send gate ends the job with its proven-unsent users Cancelled.
      if (sent.outcome === 'cancel')
        return this.stopJob(input, attempt, null, true);
    }
    // 2. The read-back of every Unknown user, no earlier than 30 seconds after its write answer. The
    // claim bound of three passes ends the automatic loop, and a person reconciles the rest.
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

  /**
   * One envelope: one call, and one settlement of its parts (B section 7.3). It answers `sent` when
   * the job continues, `fenced` when this attempt no longer owns the job, and a failure code when a
   * fatal auth answer stops the job.
   */
  private async writeEnvelope(
    input: UserAttributeUpdateRequest,
    claim: Claimed,
    credential: DelegatedCredential,
    attempt: string,
    batch: number,
    fields: WorkField[],
    signal: AbortSignal,
  ): Promise<EnvelopeAnswer> {
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
      // The gate refused the envelope, so nothing left the worker. A cancel ends the job here.
      if (error instanceof ValueSendRefused) return { outcome: 'cancel' };
      const code =
        error instanceof Error && 'code' in error
          ? jobFailure(String((error as { code: unknown }).code))
          : 'request-failed';
      // A fatal auth failure repeats for every later part, so the job stops (B sections 7.3 and 7.4).
      if (stopErrors.has(code)) return { outcome: 'stop', failure: code };
      // The envelope may have left the worker. Every part stays Unknown and the read-back decides.
      const settled = await this.settleAndPublish(
        input,
        attempt,
        claim.users.map((user) => unknownOf(user, code, null, null, null)),
        code,
        batch,
      );
      return settled === 'fenced' ? { outcome: 'fenced' } : { outcome: 'sent' };
    }
    const results = claim.users.map((user) =>
      classifyPart(user, parts.get(user.userId), fields),
    );
    // A part answer of kind `auth` stops the job after its batch settles (B section 7.3).
    const auth = [...parts.values()].find(
      (part) => part.failed !== undefined && part.failed.kind === 'auth',
    )?.failed;
    const stop = auth === undefined ? null : jobFailure(partFailureCode(auth));
    const settled = await this.settleAndPublish(
      input,
      attempt,
      results,
      null,
      batch,
    );
    if (settled === 'fenced') return { outcome: 'fenced' };
    return stop === null
      ? { outcome: 'sent' }
      : { outcome: 'stop', failure: stop };
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
      // A read that proves nothing leaves every user Unknown (C10), and the claim must not stay
      // live: the settlement clears it so the next pass reads again.
      const settled = await this.settleAndPublish(
        input,
        attempt,
        users.map((user) =>
          unknownOf(
            user,
            'network-failure',
            'verification-failed',
            null,
            'read-back',
          ),
        ),
        null,
        0,
      );
      return settled === 'fenced' ? 'fenced' : 'sent';
    }
    const results: UserValueResult[] = users.map((user) => {
      if (read.missing.includes(user.userId))
        return notFound(user, 'read-back');
      const failed = read.failed.get(user.userId);
      if (failed !== undefined)
        return classifyFailure(user, failed, 'read-back');
      const observed = read.values.get(user.userId);
      if (observed === undefined)
        return unknownOf(
          user,
          'invalid-response',
          'verification-failed',
          null,
          'read-back',
        );
      return compareUser(user, observed, claim.fields, 'read-back');
    });
    const settled = await this.settleAndPublish(
      input,
      attempt,
      results,
      null,
      0,
    );
    return settled === 'fenced' ? 'fenced' : 'sent';
  }

  /** Settle one batch and publish what it changed (B section 9). */
  private async settleAndPublish(
    input: UserAttributeUpdateRequest,
    attempt: string,
    results: UserValueResult[],
    failure: string | null,
    batch: number,
  ): Promise<'settled' | 'fenced'> {
    const settled = await this.settlement(input, attempt, results, failure);
    if (settled.outcome !== 'settled') return 'fenced';
    await this.publish(
      input.customerId,
      input.jobId,
      batch,
      settled.changed ?? [],
      settled.removed ?? [],
    );
    return 'settled';
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
      'SELECT cc.extend_user_attribute_attempt($1,$2,$3,$4) AS result',
      [input.customerId, input.jobId, input.dispatchToken, attempt],
    );
  }

  /**
   * End the job from the worker (B sections 7.3 and 7.4). A cancel settles the proven-unsent users
   * Cancelled, a fatal failure settles them Skipped, and a user whose envelope left stays Unknown.
   */
  private async stopJob(
    input: UserAttributeUpdateRequest,
    attempt: string,
    failure: string | null,
    cancel = false,
  ): Promise<UserAttributeUpdateAnswer> {
    const answer = z
      .object({
        outcome: z.enum(['stopped', 'fenced']),
        status: z.string().optional(),
      })
      .parse(
        await this.call(
          'SELECT cc.stop_user_attribute_job($1,$2,$3,$4,$5,$6) AS result',
          [
            input.customerId,
            input.jobId,
            input.dispatchToken,
            attempt,
            failure,
            cancel,
          ],
        ),
      );
    if (answer.outcome === 'fenced') return { outcome: 'fenced' };
    return { outcome: 'settled', status: String(answer.status ?? '') };
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
      ? notFound(read.user, 'read-back')
      : failed !== undefined
        ? classifyFailure(read.user, failed, 'read-back')
        : observed === null
          ? unknownOf(
              read.user,
              'invalid-response',
              'verification-failed',
              null,
              'read-back',
            )
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
    // B section 9: publish only what the cache accepted (R6).
    if (
      (settled.changed ?? []).length > 0 ||
      (settled.removed ?? []).length > 0
    )
      await this.publish(
        input.customerId,
        input.jobId,
        0,
        settled.changed ?? [],
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

/**
 * A 404 of a write or a read settles Failed `not-found` and removes the user (B section 13). The
 * drafted text of UM notes question 7 belongs beside the code (design card K24).
 */
export function notFound(
  user: WorkUser,
  verifiedBy: 'write-response' | 'read-back' | null,
): UserValueResult {
  return {
    ordinal: user.ordinal,
    outcome: 'failed',
    failure: 'not-found',
    reason: userAttributeFailureText('not-found'),
    googleStatus: 404,
    googleReason: 'notFound',
    verifiedBy,
    observed: null,
  };
}

/** One Unknown result, with the evidence of the answer that proved nothing (B section 7.3). */
export function unknownOf(
  user: WorkUser,
  failure: string,
  reason: string | null,
  googleStatus: number | null,
  verifiedBy: 'write-response' | 'read-back' | null,
): UserValueResult {
  return {
    ordinal: user.ordinal,
    outcome: 'unknown',
    failure,
    reason,
    googleStatus,
    googleReason: null,
    verifiedBy,
    observed: null,
  };
}

/**
 * One part failure of a write answer or a read-back (B section 7.3). Any failure after a transient
 * retry may follow an applied request, and an unreadable or aborted answer proves nothing, so those
 * outcomes stay Unknown for the read-back. A first-attempt refusal is definitive: 404 names a
 * missing user, `quota` names the exhausted budget, and every other status carries its Google
 * reason. A read-back failure always proves nothing (C10).
 */
export function classifyFailure(
  user: WorkUser,
  failed: BatchFailure,
  verifiedBy: 'write-response' | 'read-back',
): UserValueResult {
  const reason = verifiedBy === 'read-back' ? 'verification-failed' : null;
  const ambiguous =
    verifiedBy === 'read-back' ||
    failed.kind === 'invalid-response' ||
    failed.kind === 'transient' ||
    failed.kind === 'aborted' ||
    failed.attempts.transient > 0;
  if (ambiguous)
    return {
      ordinal: user.ordinal,
      outcome: 'unknown',
      failure: jobFailure(partFailureCode(failed)),
      reason,
      googleStatus: failed.status === 0 ? null : failed.status,
      googleReason: failed.reason,
      verifiedBy,
      observed: null,
    };
  if (failed.kind === 'not-found') return notFound(user, verifiedBy);
  return {
    ordinal: user.ordinal,
    outcome: 'failed',
    failure: jobFailure(partFailureCode(failed)),
    reason: failed.reason,
    googleStatus: failed.status === 0 ? null : failed.status,
    googleReason: failed.reason,
    verifiedBy,
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
    return unknownOf(user, 'invalid-response', null, null, null);
  const failed = part.failed;
  if (failed !== undefined)
    return classifyFailure(user, failed, 'write-response');
  const observation = part.observation;
  // A 2xx answer that carries no user resource proves no value (C11).
  if (observation === undefined)
    return unknownOf(user, 'invalid-response', null, 200, null);
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

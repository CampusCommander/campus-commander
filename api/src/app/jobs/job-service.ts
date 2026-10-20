import {
  entityEventSchema,
  entityEventsChannel,
  jobEventSchema,
  jobEventsChannel,
  queryGenerationKey,
} from '@campus/application-contracts';
import { randomUUID } from 'node:crypto';
import { ServiceResponseError } from '../configuration/service-http';

/** The hold lives five minutes (design section 6.2). */
export const JOB_HOLD_SECONDS = 300;
/** The tick and the relay each run on their own five-second timer (design section 3.6). */
export const JOB_TICK_MS = 5_000;
export const JOB_RELAY_MS = 5_000;
/** An apply that took longer than this skips the Redis write and keeps the registry entry (R9). */
export const HOLD_WRITE_DEADLINE_MS = 5_000;
/** One relay run reads at most 500 rows (design section 3.6). */
export const JOB_RELAY_LIMIT = 500;

/** The hold key of one customer and the canonical write job type. */
export const jobHoldKey = (customerId: string) =>
  `cc:job-hold:${customerId}:device-update`;

interface QueryResult {
  rows: Record<string, unknown>[];
}
interface QueryClient {
  query(text: string, values?: unknown[]): Promise<QueryResult>;
}
export interface JobServiceDatabase {
  connection: QueryClient;
}

/** The Redis commands of the job service. Its ACL line allows get, set, eval, publish, and incr. */
export interface JobServiceCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, seconds: number): Promise<unknown>;
  release(key: string, owner: string): Promise<unknown>;
  publish(channel: string, message: string): Promise<unknown>;
  increment(key: string): Promise<unknown>;
}

export interface JobServiceOrchestration {
  startDeviceUpdate(input: {
    customerId: string;
    jobId: string;
    dispatchToken: string;
    batchCount: number;
    correlationId: string;
  }): Promise<string>;
  startDeviceUpdateReconcile(input: {
    customerId: string;
    jobId: string;
    operationNumber: number | 'all';
    verifyAttempt?: string;
    correlationId: string;
  }): Promise<string>;
}

export interface JobServiceOptions {
  database: JobServiceDatabase;
  cache: JobServiceCache;
  orchestration: JobServiceOrchestration;
  /** Monotonic milliseconds. The hold write measures its own stall on it, never on the wall clock. */
  clock?: () => number;
}

/** One admitted job, as `cc.admit_device_update_job` answers it. */
export interface AdmittedJob {
  jobId: string;
  displayId: string;
  dispatchToken: string;
  correlationId: string;
  targetCount: number;
}

/** One publication element of the relay (design section 3.6). */
interface PublicationElement {
  publicationId: number | string;
  jobId: string;
  displayId: string;
  requestedBy: string;
  revision: number;
  statusChanged: boolean;
  deviceIds: string[];
  removedIds: string[];
  batch: number | null;
  batchCount: number | null;
}

const terminal = `('completed','completed-with-errors','failed','needs-review')`;

/**
 * The job service of design section 6 and the relay of section 3.6. It runs inside the API process as
 * one instance. One in-process lock serializes every admission decision, hold write, and cleanup.
 *
 * Every database call is its own statement, so no transaction spans two 017 function calls (rule G).
 * The tick and the relay never share a timer or a lock: a slow Kestra start delays no relay run.
 */
export class JobService {
  private readonly database: JobServiceDatabase;
  private readonly cache: JobServiceCache;
  private readonly orchestration: JobServiceOrchestration;
  private readonly clock: () => number;
  private lock: Promise<void> = Promise.resolve();
  private relaying = false;

  constructor(options: JobServiceOptions) {
    this.database = options.database;
    this.cache = options.cache;
    this.orchestration = options.orchestration;
    this.clock = options.clock ?? (() => performance.now());
  }

  private async rows(text: string, values: unknown[] = []) {
    return (await this.database.connection.query(text, values)).rows;
  }

  private async result<T>(text: string, values: unknown[] = []) {
    const rows = await this.rows(text, values);
    return rows[0]?.['result'] as T;
  }

  /** Run one critical section under the admission lock (design section 6.5). */
  private async exclusive<T>(run: () => Promise<T>): Promise<T> {
    const previous = this.lock;
    let release: () => void = () => undefined;
    this.lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await run();
    } finally {
      release();
    }
  }

  /**
   * The customers with work. The job service reads them from the rows that need work through the
   * existing SELECT grants (eng-lead ruling 4).
   */
  async customers(): Promise<string[]> {
    const rows = await this.rows(
      `SELECT DISTINCT j.customer_id FROM cc.jobs j
        WHERE j.kind='device-update' AND (j.status IN ('accepted','queued','held','running')
          OR EXISTS(SELECT 1 FROM cc.device_update_jobs u WHERE u.job_id=j.job_id
            AND u.hold_written_at IS NOT NULL AND u.hold_cleaned_at IS NULL))
        ORDER BY j.customer_id`,
    );
    return rows.map((row) => String(row['customer_id']));
  }

  /** One tick: the hold write, the recovery function, cleanup, and admission (design section 6.5). */
  async tick(): Promise<void> {
    await this.exclusive(async () => {
      for (const customer of await this.customers()) {
        const hold = await this.step(() => this.applyHoldLocked(customer));
        if (hold) {
          const refused = await this.step(() => this.admitLocked(customer));
          if (refused === true) await this.retryAfterRefusal(customer);
        }
        const recovered = await this.step(() => this.recoverLocked(customer));
        if (recovered === true) {
          await this.step(() => this.cleanupLocked(customer));
          await this.step(() => this.admitLocked(customer));
        }
        await this.step(() => this.cleanupLocked(customer));
        const refused = await this.step(() => this.admitLocked(customer));
        if (refused === true) await this.retryAfterRefusal(customer);
      }
    });
  }

  /**
   * A terminal `job-changed` runs cleanup and admission at once (design section 6.4). The tick repeats
   * the work, so a lost event only waits for the next tick.
   */
  async changed(customerId: string, jobId: string): Promise<void> {
    await this.exclusive(async () => {
      const rows = await this.rows(
        `SELECT 1 FROM cc.jobs j WHERE j.customer_id=$1 AND j.job_id=$2
          AND j.kind='device-update' AND j.status IN ${terminal}`,
        [customerId, jobId],
      );
      // Cleanup filters its own registry rows, and admission sees the freed write slot.
      if (rows.length === 0) return;
      await this.cleanupLocked(customerId);
      await this.admitLocked(customerId);
    });
  }

  private async retryAfterRefusal(customerId: string): Promise<void> {
    await this.step(() => this.cleanupLocked(customerId));
    await this.step(() => this.admitLocked(customerId));
  }

  /** A failed step leaves the next step and the next tick to repair the state. */
  private async step<T>(run: () => Promise<T>): Promise<T | undefined> {
    try {
      return await run();
    } catch {
      return undefined;
    }
  }

  /** Apply the newest accepted backoff report, then write the hold (design section 6.3). */
  async applyHold(customerId: string): Promise<boolean> {
    return this.exclusive(() => this.applyHoldLocked(customerId));
  }

  private async applyHoldLocked(customerId: string): Promise<boolean> {
    const startedAt = this.clock();
    const accepted = await this.result<{ jobId?: string } | null>(
      'SELECT cc.accept_device_update_hold($1) AS result',
      [customerId],
    );
    const jobId = accepted?.jobId;
    if (jobId == null) return false;
    // A stalled process never renews a hold from a stale report. The registry entry stays (design 1266).
    if (this.clock() - startedAt > HOLD_WRITE_DEADLINE_MS) return true;
    // No NX and no XX: the newest owner replaces the owner and resets the TTL to 300 seconds.
    await this.cache.set(
      jobHoldKey(customerId),
      String(jobId),
      JOB_HOLD_SECONDS,
    );
    return true;
  }

  /** One admission decision (design section 6.5). Returns true when the start was refused. */
  async admit(customerId: string): Promise<boolean> {
    return this.exclusive(() => this.admitLocked(customerId));
  }

  private async admitLocked(customerId: string): Promise<boolean> {
    // A Redis error counts as held. Admission fails closed and retries on the next tick.
    let held = true;
    try {
      held = (await this.cache.get(jobHoldKey(customerId))) !== null;
    } catch {
      held = true;
    }
    const after = await this.maxPublication(customerId);
    const admitted = await this.result<AdmittedJob | null>(
      'SELECT cc.admit_device_update_job($1,$2) AS result',
      [customerId, held],
    );
    // An admission, a label, a refused start, and a reaper run publish at once (design sections 3.2, 6.5).
    // A publication failure leaves the rows for the relay and cancels no committed start (R1-F1).
    await this.publishCommittedRows(customerId, after);
    if (!admitted) return false;
    return this.startLocked(customerId, admitted);
  }

  /**
   * Start the admitted flow. Admission and the start share no transaction (design section 5.3).
   * Only a 4xx answer runs the refused start. A timeout, a network failure, and a 5xx answer change
   * nothing at once: the start deadline resolves them.
   */
  private async startLocked(
    customerId: string,
    admitted: AdmittedJob,
  ): Promise<boolean> {
    const jobId = String(admitted.jobId);
    const token = String(admitted.dispatchToken);
    const detail = (
      await this.rows(
        'SELECT batch_count FROM cc.device_update_jobs WHERE job_id=$1',
        [jobId],
      )
    )[0];
    const batchCount = Number(detail?.['batch_count']);
    if (!Number.isInteger(batchCount) || batchCount < 1) return false;
    let executionId: string;
    try {
      executionId = await this.orchestration.startDeviceUpdate({
        customerId,
        jobId,
        dispatchToken: token,
        batchCount,
        correlationId: String(admitted.correlationId),
      });
    } catch (error) {
      if (
        error instanceof ServiceResponseError &&
        error.status >= 400 &&
        error.status < 500
      ) {
        const after = await this.maxPublication(customerId);
        await this.result(
          'SELECT cc.abandon_device_update_start($1,$2,$3) AS result',
          [customerId, jobId, token],
        );
        // The refusal stands even when its publication fails. Cleanup and admission still follow.
        await this.publishCommittedRows(customerId, after);
        return true;
      }
      return false;
    }
    // A superseded recording changes nothing. The deadline and the reaper own that state.
    await this.result(
      'SELECT cc.record_device_update_start($1,$2,$3,$4) AS result',
      [customerId, jobId, token, executionId],
    ).catch(() => undefined);
    return false;
  }

  /** Run the recovery function and start what it asks for (design sections 5.3 and 5.10). */
  async recover(customerId: string): Promise<boolean> {
    return this.exclusive(() => this.recoverLocked(customerId));
  }

  private async recoverLocked(customerId: string): Promise<boolean> {
    const after = await this.maxPublication(customerId);
    const recovered =
      (await this.result<{ starts?: unknown[]; reconciles?: unknown[] }>(
        'SELECT cc.recover_device_update_jobs($1) AS result',
        [customerId],
      )) ?? {};
    const starts = Array.isArray(recovered.starts) ? recovered.starts : [];
    const reconciles = Array.isArray(recovered.reconciles)
      ? recovered.reconciles
      : [];
    for (const start of starts)
      await this.startLocked(customerId, start as AdmittedJob);
    // The recovery result is committed. A publication failure leaves its rows for the relay and never
    // drops the reconcile starts that the reaper asked for (R1-F1).
    await this.publishCommittedRows(customerId, after);
    for (const jobId of reconciles) {
      try {
        // P2 claims the chunks of `all` itself, so the flow carries no verify attempt.
        await this.orchestration.startDeviceUpdateReconcile({
          customerId,
          jobId: String(jobId),
          operationNumber: 'all',
          correlationId: randomUUID(),
        });
      } catch {
        // After a reaper run the job service does not retry the flow for `all` (eng-lead ruling 6).
      }
    }
    return starts.length > 0 || reconciles.length > 0;
  }

  /** Delete the hold of every terminal job through the compare-and-delete script (design section 6.4). */
  async cleanup(customerId: string): Promise<number> {
    return this.exclusive(() => this.cleanupLocked(customerId));
  }

  private async cleanupLocked(customerId: string): Promise<number> {
    const rows = await this.rows(
      `SELECT j.job_id FROM cc.jobs j JOIN cc.device_update_jobs u ON u.job_id=j.job_id
        WHERE j.customer_id=$1 AND j.kind='device-update' AND j.status IN ${terminal}
          AND u.hold_written_at IS NOT NULL AND u.hold_cleaned_at IS NULL
        ORDER BY j.finished_at, j.display_id`,
      [customerId],
    );
    let cleaned = 0;
    for (const row of rows) {
      const jobId = String(row['job_id']);
      try {
        // The script deletes the key only while it still holds this job. A previous owner never
        // deletes the hold of a newer owner.
        await this.cache.release(jobHoldKey(customerId), jobId);
      } catch {
        // A Redis error keeps the registry entry for the next run.
        continue;
      }
      await this.result('SELECT cc.clean_device_update_hold($1,$2) AS result', [
        customerId,
        jobId,
      ]);
      cleaned += 1;
    }
    return cleaned;
  }

  private async maxPublication(customerId: string): Promise<string> {
    const row = (
      await this.rows(
        'SELECT COALESCE(max(publication_id),0) AS value FROM cc.job_publications WHERE customer_id=$1',
        [customerId],
      )
    )[0];
    return String(row?.['value'] ?? '0');
  }

  /**
   * Publish the rows that a committed dispatch decision produced. A Redis failure leaves them for the
   * relay and never cancels the start, the cleanup, or the admission that follows (R1-F1).
   */
  private async publishCommittedRows(
    customerId: string,
    after: string,
  ): Promise<void> {
    await this.publishRows(customerId, after).catch(() => undefined);
  }

  /**
   * Publish the rows that one job service call committed, at once, and complete them
   * (design sections 3.2 and 6.5). A refresh row and a worker row stay for the relay.
   */
  private async publishRows(customerId: string, after: string): Promise<void> {
    const rows = await this.rows(
      `SELECT p.publication_id,p.job_id,j.display_id,j.revision,j.requested_by
        FROM cc.job_publications p JOIN cc.jobs j ON j.job_id=p.job_id
        WHERE p.customer_id=$1 AND p.publication_id>$2::bigint AND j.kind='device-update'
          AND p.status_changed AND jsonb_array_length(p.device_ids)=0 AND jsonb_array_length(p.removed_ids)=0
        ORDER BY p.publication_id`,
      [customerId, after],
    );
    if (rows.length === 0) return;
    const jobs = new Map<string, Record<string, unknown>>();
    for (const row of rows) jobs.set(String(row['job_id']), row);
    for (const row of jobs.values())
      await this.publishJobChanged(customerId, row);
    await this.result('SELECT cc.complete_job_publications($1,$2) AS result', [
      customerId,
      JSON.stringify(rows.map((row) => Number(row['publication_id']))),
    ]);
  }

  private async publishJobChanged(
    customerId: string,
    row: Record<string, unknown>,
  ) {
    const event = jobEventSchema.parse({
      type: 'job-changed',
      jobId: String(row['job_id']),
      displayId: String(row['display_id']),
      revision: Number(row['revision']),
      requestedBy: String(row['requested_by']),
    });
    await this.cache.publish(
      jobEventsChannel(customerId),
      JSON.stringify(event),
    );
  }

  /** One relay run. One run executes at a time (design section 3.6). */
  async relay(): Promise<boolean> {
    if (this.relaying) return false;
    this.relaying = true;
    try {
      // A database outage skips this run; the next timer tick retries.
      const customers = await this.rows(
        'SELECT DISTINCT customer_id FROM cc.job_publications ORDER BY customer_id',
      ).catch(() => []);
      for (const row of customers) {
        try {
          await this.relayCustomer(String(row['customer_id']));
        } catch {
          // A Redis failure keeps this customer's rows for the next run.
        }
      }
      return true;
    } finally {
      this.relaying = false;
    }
  }

  private async relayCustomer(customerId: string): Promise<void> {
    const elements = await this.result<PublicationElement[]>(
      'SELECT cc.read_job_publications($1,$2) AS result',
      [customerId, JOB_RELAY_LIMIT],
    );
    if (!Array.isArray(elements) || elements.length === 0) return;
    const events: [string, string][] = [];
    const jobs = new Map<string, PublicationElement>();
    for (const element of elements) {
      const jobId = String(element.jobId);
      const deviceIds = (element.deviceIds ?? []).map(String);
      const removedIds = (element.removedIds ?? []).map(String);
      if (deviceIds.length > 0 || removedIds.length > 0) {
        // The relay bumps the query generation and publishes entity-batch. It never touches an
        // entity key: the API never writes the entity cache.
        await this.cache.increment(queryGenerationKey('device', customerId));
        events.push([
          entityEventsChannel(customerId),
          JSON.stringify(
            entityEventSchema.parse({
              type: 'entity-batch',
              jobId,
              entityType: 'device',
              batch: Number(element.batch),
              batchCount: Number(element.batchCount),
              deviceIds,
              removedIds,
            }),
          ),
        ]);
      }
      // One job-changed per job per run, at the current revision that the relay read.
      if (!jobs.has(jobId)) jobs.set(jobId, element);
    }
    for (const element of jobs.values()) {
      events.push([
        jobEventsChannel(customerId),
        JSON.stringify(
          jobEventSchema.parse({
            type: 'job-changed',
            jobId: String(element.jobId),
            displayId: String(element.displayId),
            revision: Number(element.revision),
            requestedBy: String(element.requestedBy),
          }),
        ),
      ]);
    }
    // A publish failure throws here, so no row of this customer completes.
    for (const [channel, message] of events)
      await this.cache.publish(channel, message);
    await this.result('SELECT cc.complete_job_publications($1,$2) AS result', [
      customerId,
      JSON.stringify(elements.map((element) => Number(element.publicationId))),
    ]);
  }
}

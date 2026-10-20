import { Injectable, computed, inject, signal } from '@angular/core';
import {
  jobDetailSchema,
  jobEventSchema,
  jobOperationsPageSchema,
  type JobDetail,
  type JobOperation,
} from '@campus/application-contracts';
import { AuthStore } from '../auth.store';
import { operationNumber } from './job-detail-fields';
import { JobReader, type JobRevisions } from './job-reader';
import { JobStream, type JobEventSource } from './job-stream';

/** Operations per page. The frames show six rows and "Rows 1–6 of 48". */
export const OPERATIONS_PAGE_SIZE = 6;

/**
 * One job detail. The reader follows section 3.4: a `job-changed` event is an
 * invalidation only, and one read loads the job, Latest activity, and the visible
 * operations page.
 */
@Injectable({ providedIn: 'root' })
export class JobDetailStore {
  private readonly auth = inject(AuthStore);
  /** Opens the jobs event stream. Tests replace it. */
  eventSource: (url: string) => JobEventSource = (url) => new EventSource(url);
  /** Milliseconds before a closed stream reopens. */
  reopenDelay = 5000;
  /** Milliseconds without any event, pings included, before the stream counts as dead. */
  streamTimeout = 60_000;

  readonly displayId = signal<string | null>(null);
  readonly job = signal<JobDetail | null>(null);
  readonly operations = signal<readonly JobOperation[]>([]);
  readonly nextCursor = signal<string | null>(null);
  /** The first read has no answer yet. */
  readonly loading = signal(true);
  /** A successful read has produced the current state at least once. */
  readonly loaded = signal(false);
  /** A read is in flight. */
  readonly reading = signal(false);
  /** The person asked for a read with Refresh. */
  readonly refreshing = signal(false);
  readonly offline = signal(false);
  /** The last read failed while earlier data remains visible. */
  readonly stale = signal(false);
  readonly error = signal('');
  /** The job read answered 404: unknown or purged (design 2.5). */
  readonly missing = signal(false);
  /** The job loaded but its operation rows did not. */
  readonly operationsError = signal('');
  /** The attention filter contains failed and unknown rows only (frame 231:4707). */
  readonly attention = signal(false);
  readonly pageIndex = signal(0);
  /** The page whose rows are shown. It trails pageIndex until the next page arrives. */
  readonly shownIndex = signal(0);
  /** A paging read is in flight. Further paging waits for it. */
  readonly navigating = signal(false);
  private readonly cursors = signal<readonly (string | null)[]>([null]);
  readonly hasPrevious = computed(() => this.shownIndex() > 0);
  readonly hasNext = computed(() => !!this.nextCursor());
  /** Operations with a Reconcile request after a 202 answer (design 2.6). */
  readonly reconciling = signal<ReadonlySet<string>>(new Set());
  readonly reconcileError = signal('');
  /** A successful Reconcile start or a settled operation. */
  readonly notice = signal('');

  private readonly reader = new JobReader(() => this.read());
  private readonly events = new JobStream({
    open: () => this.eventSource('/api/jobs/events'),
    reopenDelay: () => this.reopenDelay,
    timeout: () => this.streamTimeout,
    opened: () => this.reader.opened(),
    changed: (data) => this.onEvent(data),
  });
  /** Increments on another job. Late answers for the old job are dropped. */
  private epoch = 0;
  /** Counts read starts. A Reconcile started during a read keeps its mark. */
  private readGeneration = 0;
  private reconcileStartedAt = 0;

  /** Job detail mounted: open the stream and read the job and its visible page. */
  async init(displayId: string): Promise<void> {
    if (this.displayId() !== displayId) this.reset(displayId);
    this.events.start();
    if (!this.loaded()) this.loading.set(true);
    await this.reader.request();
  }

  /** Job detail left: stop scheduled reads and close the stream. The state stays. */
  leave(): void {
    this.reader.stop();
    this.events.stop();
  }

  /** Refresh rereads job state only. It never dispatches provider work. */
  async refresh(): Promise<void> {
    if (this.refreshing()) return;
    this.refreshing.set(true);
    try {
      await this.reader.request();
    } finally {
      this.refreshing.set(false);
    }
  }

  /** "Show N needing attention" reads with attention=true; "Show all" clears it. */
  setAttention(value: boolean): void {
    if (value === this.attention()) return;
    this.attention.set(value);
    this.operations.set([]);
    this.nextCursor.set(null);
    this.operationsError.set('');
    this.pageIndex.set(0);
    this.shownIndex.set(0);
    this.navigating.set(false);
    this.cursors.set([null]);
    void this.reader.request();
  }

  next(): void {
    if (this.reading() || this.navigating()) return;
    const cursor = this.nextCursor();
    if (!cursor) return;
    // Navigation starts at the shown page, so a failed read never stacks a cursor twice.
    const index = this.shownIndex() + 1;
    const stack = this.cursors().slice(0, index);
    stack.push(cursor);
    this.cursors.set(stack);
    this.pageIndex.set(index);
    this.navigating.set(true);
    void this.reader.request();
  }

  previous(): void {
    if (this.reading() || this.navigating()) return;
    const index = this.shownIndex() - 1;
    if (index < 0) return;
    this.pageIndex.set(index);
    this.navigating.set(true);
    void this.reader.request();
  }

  /**
   * Reconcile one unknown operation (design 2.6). A 202 answer marks the row as
   * reconciling until a later job read. A 409 reads the job again. Other answers
   * show a message and leave the row unchanged.
   */
  async reconcile(operation: JobOperation): Promise<void> {
    const displayId = this.displayId();
    if (!displayId || this.reconciling().has(operation.operationId)) return;
    const number = operationNumber(operation.operationId);
    this.reconcileError.set('');
    this.notice.set('');
    if (!number) {
      this.reconcileError.set('Reconcile could not start. Try again.');
      return;
    }
    this.setReconciling(operation.operationId, true);
    try {
      const response = await this.auth.request(
        `/api/jobs/${encodeURIComponent(displayId)}/operations/${number}/reconcile`,
        {},
      );
      if (response.status === 202) {
        // A read that started before this answer does not clear the mark.
        this.reconcileStartedAt = this.readGeneration;
        this.notice.set(
          `Reconcile started for ${operation.serialNumber || operation.deviceId}.`,
        );
        return;
      }
      this.setReconciling(operation.operationId, false);
      if (response.status === 409) {
        const body: unknown = await response.json().catch(() => null);
        const settled =
          (body as { reason?: unknown } | null)?.reason === 'operation-settled';
        this.notice.set(
          settled
            ? 'The operation settled. Reading the job again.'
            : 'The operation is no longer unknown. Reading the job again.',
        );
        await this.reader.request();
        return;
      }
      if (response.status === 403) {
        this.reconcileError.set(
          'You do not have permission to reconcile this operation.',
        );
        return;
      }
      if (response.status === 404) {
        this.reconcileError.set('This job or operation no longer exists.');
        await this.reader.request();
        return;
      }
      this.reconcileError.set('Reconcile could not start. Try again.');
    } catch {
      this.setReconciling(operation.operationId, false);
      this.reconcileError.set(
        'Cannot reach Campus Commander. Reconcile did not start.',
      );
    }
  }

  private reset(displayId: string): void {
    this.epoch++;
    this.reader.clear();
    this.displayId.set(displayId);
    this.job.set(null);
    this.operations.set([]);
    this.nextCursor.set(null);
    this.loading.set(true);
    this.loaded.set(false);
    this.reading.set(false);
    this.refreshing.set(false);
    this.offline.set(false);
    this.stale.set(false);
    this.error.set('');
    this.missing.set(false);
    this.operationsError.set('');
    this.attention.set(false);
    this.pageIndex.set(0);
    this.shownIndex.set(0);
    this.navigating.set(false);
    this.cursors.set([null]);
    this.reconciling.set(new Set());
    this.reconcileError.set('');
    this.notice.set('');
  }

  /** One read of the job, Latest activity, and the visible operations page. */
  private async read(): Promise<JobRevisions | null> {
    const displayId = this.displayId();
    if (!displayId) return [];
    const epoch = this.epoch;
    const generation = ++this.readGeneration;
    const index = this.pageIndex();
    const cursor = this.cursors()[index] ?? null;
    const path = `/api/jobs/${encodeURIComponent(displayId)}`;
    this.reading.set(true);
    try {
      let response: Response;
      try {
        response = await this.auth.request(path);
      } catch {
        if (epoch !== this.epoch) return [];
        this.failed(true);
        return null;
      }
      if (epoch !== this.epoch) return [];
      if (response.status === 404) {
        this.missingJob();
        return [];
      }
      if (!response.ok) {
        this.failed(false);
        return null;
      }
      const detail = jobDetailSchema.safeParse(
        await response.json().catch(() => null),
      );
      if (epoch !== this.epoch) return [];
      if (!detail.success) {
        this.failed(false);
        return null;
      }
      // The identity, counters, and Latest activity stay visible while the rows load.
      this.job.set(detail.data);
      this.loaded.set(true);
      this.loading.set(false);
      this.missing.set(false);

      const params = new URLSearchParams();
      if (this.attention()) params.set('attention', 'true');
      if (cursor) params.set('cursor', cursor);
      params.set('limit', String(OPERATIONS_PAGE_SIZE));
      let page: Response;
      try {
        page = await this.auth.request(
          `${path}/operations?${params.toString()}`,
        );
      } catch {
        if (epoch !== this.epoch) return [];
        this.operationsFailed(true);
        return null;
      }
      if (epoch !== this.epoch) return [];
      if (!page.ok) {
        this.operationsFailed(false);
        return null;
      }
      const parsed = jobOperationsPageSchema.safeParse(
        await page.json().catch(() => null),
      );
      if (epoch !== this.epoch) return [];
      if (!parsed.success) {
        this.operationsFailed(false);
        return null;
      }
      this.operations.set(parsed.data.operations);
      this.nextCursor.set(parsed.data.nextCursor);
      this.shownIndex.set(index);
      this.operationsError.set('');
      this.offline.set(false);
      this.stale.set(false);
      this.error.set('');
      // A read after the 202 answer clears the reconciling marks (design 2.6).
      if (generation > this.reconcileStartedAt) {
        this.reconciling.set(new Set());
        if (this.notice().startsWith('Reconcile started for '))
          this.notice.set('');
      }
      return [{ jobId: detail.data.jobId, revision: detail.data.revision }];
    } finally {
      this.reading.set(false);
      if (epoch === this.epoch) this.navigating.set(false);
    }
  }

  private missingJob(): void {
    this.job.set(null);
    this.operations.set([]);
    this.nextCursor.set(null);
    this.loading.set(false);
    this.loaded.set(false);
    this.missing.set(true);
    this.error.set('');
    this.offline.set(false);
    this.stale.set(false);
    this.operationsError.set('');
    this.navigating.set(false);
  }

  private failed(offline: boolean): void {
    this.loading.set(false);
    this.offline.set(offline);
    this.missing.set(false);
    if (!this.job()) {
      this.error.set('Job details are unavailable.');
      this.stale.set(false);
    } else {
      this.error.set('');
      this.stale.set(!offline);
    }
  }

  private operationsFailed(offline: boolean): void {
    this.offline.set(offline);
    // The job read succeeded; only the rows are unavailable.
    this.stale.set(false);
    this.operationsError.set(
      offline
        ? 'Cannot reach Campus Commander. Operation results may be out of date.'
        : 'Operation results are unavailable.',
    );
  }

  private setReconciling(operationId: string, on: boolean): void {
    this.reconciling.update((current) => {
      const next = new Set(current);
      if (on) next.add(operationId);
      else next.delete(operationId);
      return next;
    });
  }

  private onEvent(data: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const result = jobEventSchema.safeParse(parsed);
    if (!result.success) return;
    const event = result.data;
    const current = this.job();
    if (
      current
        ? event.jobId !== current.jobId
        : event.displayId !== this.displayId()
    )
      return;
    this.reader.changed(event);
  }
}

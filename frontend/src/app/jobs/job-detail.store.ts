import {
  Injectable,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
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
import { LiveFeeds, type LiveFeedSubscription } from './live-feeds';
import { type JobEventSource } from './job-stream';

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
  private readonly feeds = inject(LiveFeeds);
  /** Opens the one live stream of the tab. Tests replace it. */
  eventSource: (url: string) => JobEventSource = (url) => new EventSource(url);

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
  /** A cancel request is in flight (design section 6, choice 8). */
  readonly cancelling = signal(false);
  /** The reason a cancel did not start, shown beside the toolbar. */
  readonly cancelError = signal('');

  private readonly reader = new JobReader(() => this.read());
  /** The tab's shared jobs connection. The last store to leave closes it. */
  private subscription: LiveFeedSubscription | null = null;
  /** The page is mounted. A late Reconcile answer changes nothing after leave. */
  private mounted = false;
  /** Increments at every mount and leave. A continuation from an earlier mount is dropped. */
  private mountGeneration = 0;
  /** The page holds the stream. */
  private streamWanted = false;
  /** The person of the current state. Another person clears it. */
  private identity: string | null = null;
  /** The session ended. The same person can resume it. */
  private away = false;
  /** Increments on another job or another person. Late answers are dropped. */
  private epoch = 0;
  /** Increments on a filter or page change. Late answers are dropped. */
  private queryRevision = 0;
  /** Counts read starts. A Reconcile accepted during a read keeps its mark. */
  private readGeneration = 0;
  /** Operation ID to the read generation at its 202 answer. A later read clears it. */
  private readonly acceptedMarks = new Map<string, number>();
  /**
   * Operation ID to the live Reconcile request that owns its mark. A request that
   * terminates without acceptance releases its own mark, so a 401 during a session
   * interruption cannot leave an orphan Reconciling row (R2-F1).
   */
  private readonly pendingReconciles = new Map<string, symbol>();
  /** The operation whose accepted notice is visible. A later read clears that notice. */
  private startedNoticeFor: string | null = null;
  /**
   * The live cancel request that owns the busy state. A reset hands the busy state
   * to the next job, so an obsolete answer must not release the newer request (R3).
   */
  private cancelToken: symbol | null = null;

  constructor() {
    // The session cookie belongs to one person. Another person starts from no state,
    // no stream, no held revisions, and no pending answer (the Jobs page boundary).
    effect(() => {
      const identity = this.auth.session()?.identity.id ?? null;
      untracked(() => {
        if (identity === null) {
          this.away = this.identity !== null;
          return;
        }
        const resumed = this.away && identity === this.identity;
        this.away = false;
        if (this.identity !== null && identity !== this.identity) this.reset();
        this.identity = identity;
        if (resumed) this.resume();
      });
    });
  }

  /** Job detail mounted: open the stream and read the job and its visible page. */
  async init(displayId: string): Promise<void> {
    this.mounted = true;
    this.mountGeneration++;
    if (this.displayId() !== displayId) this.reset(displayId, false);
    this.streamWanted = true;
    this.follow();
    if (!this.loaded()) this.loading.set(true);
    await this.reader.request();
  }

  /** Job detail left: stop scheduled reads and close the stream. The state stays. */
  leave(): void {
    this.mounted = false;
    this.mountGeneration++;
    this.streamWanted = false;
    this.reader.stop();
    this.subscription?.close();
    this.subscription = null;
    // No request outlives the page. A mark without a held answer would never clear.
    this.clearReconcileState();
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
    this.queryRevision++;
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
    this.go(index);
  }

  previous(): void {
    if (this.reading() || this.navigating()) return;
    const index = this.shownIndex() - 1;
    if (index < 0) return;
    this.go(index);
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
    const epoch = this.epoch;
    const mount = this.mountGeneration;
    const identity = this.auth.session()?.identity.id ?? null;
    // A held answer must not reach another job, another person, or a left page.
    const current = () =>
      this.mounted &&
      this.mountGeneration === mount &&
      this.epoch === epoch &&
      this.displayId() === displayId &&
      (this.auth.session()?.identity.id ?? null) === identity;
    this.reconcileError.set('');
    this.notice.set('');
    this.startedNoticeFor = null;
    if (!number) {
      this.reconcileError.set('Reconcile could not start. Try again.');
      return;
    }
    const token = Symbol(operation.operationId);
    this.pendingReconciles.set(operation.operationId, token);
    this.setReconciling(operation.operationId, true);
    try {
      const response = await this.auth.request(
        `/api/jobs/${encodeURIComponent(displayId)}/operations/${number}/reconcile`,
        {},
      );
      if (!current()) return;
      if (response.status === 202) {
        // A read that started before this answer does not clear the mark.
        this.acceptedMarks.set(operation.operationId, this.readGeneration);
        const text = `Reconcile started for ${
          operation.serialNumber || operation.deviceId
        }.`;
        this.notice.set(text);
        this.startedNoticeFor = operation.operationId;
        return;
      }
      if (response.status === 409) {
        const body: unknown = await response.json().catch(() => null);
        if (!current()) return;
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
      if (!current()) return;
      this.reconcileError.set(
        'Cannot reach Campus Commander. Reconcile did not start.',
      );
    } finally {
      // The request has terminated. Release its mark unless a 202 accepted it for a
      // later read, and leave a newer request's mark alone (R2-F1).
      this.releaseReconcile(operation.operationId, token);
    }
  }

  /**
   * Request the cancel of the current job (design section 6). The SQL function decides
   * every refusal. A 200 reads the job again, so the banner, the identity line, and the
   * disabled control follow the stored request rather than an optimistic guess.
   */
  async cancel(): Promise<boolean> {
    const displayId = this.displayId();
    if (!displayId || this.cancelling()) return false;
    const epoch = this.epoch;
    const mount = this.mountGeneration;
    const identity = this.auth.session()?.identity.id ?? null;
    const current = () =>
      this.mounted &&
      this.mountGeneration === mount &&
      this.epoch === epoch &&
      this.displayId() === displayId &&
      (this.auth.session()?.identity.id ?? null) === identity;
    this.cancelError.set('');
    this.cancelling.set(true);
    const token = Symbol(displayId);
    this.cancelToken = token;
    try {
      const response = await this.auth.request(
        `/api/jobs/${encodeURIComponent(displayId)}/cancel`,
        {},
      );
      if (!current()) return false;
      if (response.ok) {
        await this.reader.request();
        return current();
      }
      const body: unknown = await response.json().catch(() => null);
      if (!current()) return false;
      const reason = (body as { reason?: unknown } | null)?.reason;
      if (response.status === 403) {
        this.cancelError.set('You do not have permission to cancel this job.');
        return false;
      }
      if (response.status === 404) {
        this.cancelError.set('This job no longer exists.');
        await this.reader.request();
        return false;
      }
      if (response.status === 409 && reason === 'job-finished') {
        this.cancelError.set('The job finished before the cancel arrived.');
        await this.reader.request();
        return false;
      }
      if (response.status === 409 && reason === 'nothing-to-stop') {
        this.cancelError.set('The job holds no pending work to stop.');
        await this.reader.request();
        return false;
      }
      this.cancelError.set('Cancel could not start. Try again.');
      return false;
    } catch {
      if (current())
        this.cancelError.set(
          'Cannot reach Campus Commander. Cancel did not start.',
        );
      return false;
    } finally {
      // Only the request that owns the busy state clears it. A reset or a newer
      // request has already taken ownership, so an obsolete answer leaves it busy.
      if (this.cancelToken === token) {
        this.cancelToken = null;
        this.cancelling.set(false);
      }
    }
  }

  private go(index: number): void {
    this.pageIndex.set(index);
    this.navigating.set(true);
    this.queryRevision++;
    void this.reader.request();
  }

  /**
   * Clears the state of the previous job or person. A mounted page replaces its
   * stream, because the stream carries the session cookie, and reads again.
   */
  private reset(
    displayId: string | null = this.displayId(),
    reread = true,
  ): void {
    this.epoch++;
    this.queryRevision++;
    this.reader.clear();
    if (displayId !== null) this.displayId.set(displayId);
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
    this.clearReconcileState();
    this.cancelToken = null;
    this.cancelling.set(false);
    this.cancelError.set('');
    if (reread && this.streamWanted) {
      this.subscription?.restart();
      // Do not wait for the stream open to remove the previous person's data.
      void this.reader.request();
    }
  }

  /** The same person resumed an interrupted session. A stream that a 401 closed opens again. */
  private resume(): void {
    if (!this.streamWanted) return;
    if (!this.subscription) this.follow();
    else this.subscription.resume();
  }

  /** Subscribes to the tab's one live connection. The subscription is shared with every store. */
  private follow(): void {
    if (this.subscription) return;
    this.subscription = this.feeds.subscribe('/api/events', {
      open: () => this.eventSource('/api/events'),
      events: ['job-changed'],
      opened: () => this.reader.opened(),
      changed: (data) => this.onEvent(data),
    });
  }

  private clearReconcileState(): void {
    this.reconciling.set(new Set());
    this.acceptedMarks.clear();
    this.pendingReconciles.clear();
    this.startedNoticeFor = null;
    this.reconcileError.set('');
    this.notice.set('');
  }

  /**
   * Releases the mark of a terminated Reconcile request. A 202 acceptance keeps its
   * mark for a later read. A newer request for the same operation keeps its own mark.
   */
  private releaseReconcile(operationId: string, token: symbol): void {
    if (this.pendingReconciles.get(operationId) !== token) return;
    this.pendingReconciles.delete(operationId);
    if (this.acceptedMarks.has(operationId)) return;
    this.setReconciling(operationId, false);
  }

  /** One read of the job, Latest activity, and the visible operations page. */
  private async read(): Promise<JobRevisions | null> {
    const displayId = this.displayId();
    if (!displayId) return [];
    const epoch = this.epoch;
    const revision = this.queryRevision;
    const generation = ++this.readGeneration;
    const identity = this.auth.session()?.identity.id ?? null;
    const index = this.pageIndex();
    const cursor = this.cursors()[index] ?? null;
    const attention = this.attention();
    const path = `/api/jobs/${encodeURIComponent(displayId)}`;
    // Another job, person, filter, or page makes this answer obsolete.
    const current = () =>
      epoch === this.epoch &&
      revision === this.queryRevision &&
      (this.auth.session()?.identity.id ?? null) === identity;
    this.reading.set(true);
    try {
      let response: Response;
      try {
        response = await this.auth.request(path);
      } catch {
        if (!current()) return [];
        this.failed(true);
        return null;
      }
      if (!current()) return [];
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
      if (!current()) return [];
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
      if (attention) params.set('attention', 'true');
      if (cursor) params.set('cursor', cursor);
      params.set('limit', String(OPERATIONS_PAGE_SIZE));
      let page: Response;
      try {
        page = await this.auth.request(
          `${path}/operations?${params.toString()}`,
        );
      } catch {
        if (!current()) return [];
        this.operationsFailed(true);
        return null;
      }
      if (!current()) return [];
      if (!page.ok) {
        this.operationsFailed(false);
        return null;
      }
      const parsed = jobOperationsPageSchema.safeParse(
        await page.json().catch(() => null),
      );
      if (!current()) return [];
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
      // A completed read after the 202 answer clears the accepted marks of this
      // operation only (design 2.6). A read started before the answer does not.
      for (const [operationId, accepted] of [...this.acceptedMarks]) {
        if (generation <= accepted) continue;
        this.acceptedMarks.delete(operationId);
        this.setReconciling(operationId, false);
        if (this.startedNoticeFor === operationId) {
          this.startedNoticeFor = null;
          this.notice.set('');
        }
      }
      return [{ jobId: detail.data.jobId, revision: detail.data.revision }];
    } finally {
      this.reading.set(false);
      if (revision === this.queryRevision) this.navigating.set(false);
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

import {
  Injectable,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import {
  jobEventSchema,
  jobListSchema,
  jobRequestersSchema,
  type JobEvent,
  type JobList,
  type JobPerson,
} from '@campus/application-contracts';
import { AuthStore } from '../auth.store';
import { jobFilterQuery, sameFilters, type JobFilter } from './job-fields';
import { JobReader, type JobRevisions } from './job-reader';
import { LiveFeeds, type LiveFeedSubscription } from './live-feeds';
import { type JobEventSource } from './job-stream';

/** Rows per page. The API caps a page at 100. */
export const JOBS_PAGE_SIZE = 50;

export type { JobEventSource } from './job-stream';

/** The Jobs navigation item and route need jobs:read, jobs:manage, or devices:read (design 2.1). */
export function jobsReadable(auth: InstanceType<typeof AuthStore>): boolean {
  if (auth.metadata()?.phase !== 3) return false;
  const grants = auth.session()?.identity.grants ?? [];
  return grants.some(
    (grant) =>
      grant.action === 'jobs:read' ||
      grant.action === 'jobs:manage' ||
      grant.action === 'devices:read',
  );
}

/**
 * The Jobs page state. The reader follows section 3.4: events are invalidations only,
 * revisions suppress duplicate reads, and a failed read retries after 5 s.
 */
@Injectable({ providedIn: 'root' })
export class JobsStore {
  private readonly auth = inject(AuthStore);
  private readonly feeds = inject(LiveFeeds);
  /** Opens the one live stream of the tab. Tests replace it. */
  eventSource: (url: string) => JobEventSource = (url) => new EventSource(url);

  readonly filters = signal<JobFilter[]>([]);
  readonly page = signal<JobList | null>(null);
  /** The first read has no answer yet. */
  readonly loading = signal(true);
  /** A successful read has produced the current state at least once. */
  readonly loaded = signal(false);
  /** A read is in flight. */
  readonly reading = signal(false);
  /** The person asked for a read with Refresh. */
  readonly refreshing = signal(false);
  readonly offline = signal(false);
  /** The last read failed while earlier rows remain visible. */
  readonly stale = signal(false);
  readonly error = signal('');
  readonly pageIndex = signal(0);
  /** The page whose rows are shown. It trails pageIndex until the next page arrives. */
  readonly shownIndex = signal(0);
  /** A paging read is in flight. Further paging waits for it. */
  readonly navigating = signal(false);
  private readonly cursors = signal<readonly (string | null)[]>([null]);
  readonly hasPrevious = computed(() => this.shownIndex() > 0);
  readonly hasNext = computed(() => !!this.page()?.nextCursor);

  private readonly reader = new JobReader(() => this.read());
  /** The tab's shared jobs connection. The last store to leave closes it. */
  private subscription: LiveFeedSubscription | null = null;
  private streamWanted = false;
  /** Increments on a query change. A late answer for the old query is dropped. */
  private queryRevision = 0;
  /** Increments on sign-in by another person. Late answers for the old person are dropped. */
  private epoch = 0;
  private identity: string | null = null;
  /** The session ended. The same person can resume it. */
  private away = false;

  constructor() {
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

  /** Jobs mounted: open the stream and read the current page. */
  async init(): Promise<void> {
    this.streamWanted = true;
    this.follow();
    if (!this.loaded()) this.loading.set(true);
    await this.reader.request();
  }

  /** Jobs left: stop scheduled reads and close the stream. The query and page stay. */
  leave(): void {
    this.streamWanted = false;
    this.reader.stop();
    this.subscription?.close();
    this.subscription = null;
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

  /** A filter change starts a new query at its first page. */
  setFilters(filters: JobFilter[]): void {
    if (sameFilters(filters, this.filters())) return;
    this.filters.set(filters);
    this.queryRevision++;
    this.page.set(null);
    this.loaded.set(false);
    this.loading.set(true);
    this.error.set('');
    this.stale.set(false);
    this.navigating.set(false);
    this.pageIndex.set(0);
    this.shownIndex.set(0);
    this.cursors.set([null]);
    void this.reader.request();
  }

  clearFilters(): void {
    this.setFilters([]);
  }

  next(): void {
    if (this.reading() || this.navigating()) return;
    const cursor = this.page()?.nextCursor;
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

  private go(index: number): void {
    this.pageIndex.set(index);
    this.navigating.set(true);
    this.queryRevision++;
    void this.reader.request();
  }

  /** The `requestedBy` autocomplete reads the distinct requesters of visible jobs. */
  async requesters(query: string): Promise<JobPerson[] | null> {
    try {
      const response = await this.auth.request(
        `/api/jobs/requesters?query=${encodeURIComponent(query)}&limit=20`,
      );
      if (!response.ok) return null;
      return jobRequestersSchema.parse(await response.json()).requesters;
    } catch {
      return null;
    }
  }

  /** The held revisions of the current reader, for the page and tests. */
  revision(jobId: string): number {
    return this.reader.revision(jobId);
  }

  private reset(): void {
    this.epoch++;
    this.queryRevision++;
    this.reader.clear();
    this.filters.set([]);
    this.page.set(null);
    this.loading.set(true);
    this.loaded.set(false);
    this.refreshing.set(false);
    this.offline.set(false);
    this.stale.set(false);
    this.error.set('');
    this.navigating.set(false);
    this.pageIndex.set(0);
    this.shownIndex.set(0);
    this.cursors.set([null]);
    // The stream carries the session cookie. A new person needs a new stream.
    if (this.streamWanted) {
      this.subscription?.restart();
      // Do not wait for the stream open to remove the previous person's rows.
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
      // Every stream open marks the reader dirty (section 3.4).
      opened: () => this.reader.opened(),
      changed: (data) => this.onEvent(data),
    });
  }

  /** One read of the current query. Returns the revisions of a successful answer. */
  private async read(): Promise<JobRevisions | null> {
    const revision = this.queryRevision;
    const epoch = this.epoch;
    const index = this.pageIndex();
    const cursor = this.cursors()[index] ?? null;
    const query = jobFilterQuery(this.filters(), cursor);
    const path = query
      ? `/api/jobs?${query}&limit=${JOBS_PAGE_SIZE}`
      : `/api/jobs?limit=${JOBS_PAGE_SIZE}`;
    this.reading.set(true);
    try {
      const response = await this.auth.request(path);
      if (epoch !== this.epoch || revision !== this.queryRevision) return [];
      if (!response.ok) {
        this.failed(false);
        return null;
      }
      let list: JobList;
      try {
        list = jobListSchema.parse(await response.json());
      } catch {
        if (epoch !== this.epoch || revision !== this.queryRevision) return [];
        this.failed(false);
        return null;
      }
      if (epoch !== this.epoch || revision !== this.queryRevision) return [];
      this.page.set(list);
      this.loaded.set(true);
      this.loading.set(false);
      this.offline.set(false);
      this.stale.set(false);
      this.error.set('');
      this.shownIndex.set(index);
      return list.jobs;
    } catch {
      if (epoch !== this.epoch || revision !== this.queryRevision) return [];
      this.failed(true);
      return null;
    } finally {
      this.reading.set(false);
      if (revision === this.queryRevision) this.navigating.set(false);
    }
  }

  private failed(offline: boolean): void {
    this.loading.set(false);
    this.offline.set(offline);
    if (!this.page()) {
      this.error.set('Job status is unavailable.');
      this.stale.set(false);
    } else {
      this.error.set('');
      this.stale.set(!offline);
    }
  }

  private onEvent(data: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const result = jobEventSchema.safeParse(parsed);
    if (result.success) this.reader.changed(result.data as JobEvent);
  }
}

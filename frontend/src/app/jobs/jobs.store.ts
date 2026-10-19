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

/** Rows per page. The API caps a page at 100. */
export const JOBS_PAGE_SIZE = 50;

const CLOSED = 2;

/** The part of EventSource that the store uses. Tests supply a fake. */
export type JobEventSource = Pick<
  EventSource,
  'addEventListener' | 'close' | 'readyState'
>;

/** The Jobs navigation item and route need jobs:read or devices:read (design 2.1). */
export function jobsReadable(auth: InstanceType<typeof AuthStore>): boolean {
  if (auth.metadata()?.phase !== 3) return false;
  const grants = auth.session()?.identity.grants ?? [];
  return grants.some(
    (grant) => grant.action === 'jobs:read' || grant.action === 'devices:read',
  );
}

/**
 * The Jobs page state. The reader follows section 3.4: events are invalidations only,
 * revisions suppress duplicate reads, and a failed read retries after 5 s.
 */
@Injectable({ providedIn: 'root' })
export class JobsStore {
  private readonly auth = inject(AuthStore);
  /** Opens the jobs event stream. Tests replace it. */
  eventSource: (url: string) => JobEventSource = (url) => new EventSource(url);
  /** Milliseconds before a closed stream reopens. */
  reopenDelay = 5000;
  /** Milliseconds without any event, pings included, before the stream counts as dead. */
  streamTimeout = 60_000;

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
  private readonly cursors = signal<readonly (string | null)[]>([null]);
  readonly hasPrevious = computed(() => this.pageIndex() > 0);
  readonly hasNext = computed(() => !!this.page()?.nextCursor);

  private readonly reader = new JobReader(() => this.read());
  private stream: JobEventSource | null = null;
  private streamWanted = false;
  private reopenTimer?: ReturnType<typeof setTimeout>;
  private watchdog?: ReturnType<typeof setTimeout>;
  /** Increments on a query change. A late answer for the old query is dropped. */
  private queryRevision = 0;
  private identity: string | null = null;

  constructor() {
    effect(() => {
      const identity = this.auth.session()?.identity.id ?? null;
      untracked(() => {
        if (
          this.identity !== null &&
          identity !== null &&
          identity !== this.identity
        )
          this.reset();
        this.identity = identity;
      });
    });
  }

  /** Jobs mounted: open the stream and read the current page. */
  async init(): Promise<void> {
    this.streamWanted = true;
    if (!this.stream) this.openStream();
    if (!this.loaded()) this.loading.set(true);
    await this.reader.request();
  }

  /** Jobs left: stop scheduled reads and close the stream. The query and page stay. */
  leave(): void {
    this.streamWanted = false;
    this.reader.stop();
    this.closeStream();
    clearTimeout(this.reopenTimer);
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
    this.pageIndex.set(0);
    this.shownIndex.set(0);
    this.cursors.set([null]);
    void this.reader.request();
  }

  clearFilters(): void {
    this.setFilters([]);
  }

  next(): void {
    const cursor = this.page()?.nextCursor;
    if (!cursor) return;
    const stack = this.cursors().slice(0, this.pageIndex() + 1);
    stack.push(cursor);
    this.cursors.set(stack);
    this.pageIndex.set(stack.length - 1);
    this.queryRevision++;
    void this.reader.request();
  }

  previous(): void {
    if (this.pageIndex() === 0) return;
    this.pageIndex.update((index) => index - 1);
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
    this.queryRevision++;
    this.reader.stop();
    this.filters.set([]);
    this.page.set(null);
    this.loading.set(true);
    this.loaded.set(false);
    this.offline.set(false);
    this.stale.set(false);
    this.error.set('');
    this.pageIndex.set(0);
    this.shownIndex.set(0);
    this.cursors.set([null]);
    // The stream carries the session cookie. A new person needs a new stream.
    if (this.stream) this.openStream();
  }

  /** One read of the current query. Returns the revisions of a successful answer. */
  private async read(): Promise<JobRevisions | null> {
    const revision = this.queryRevision;
    const index = this.pageIndex();
    const cursor = this.cursors()[index] ?? null;
    const query = jobFilterQuery(this.filters(), cursor);
    const path = query
      ? `/api/jobs?${query}&limit=${JOBS_PAGE_SIZE}`
      : `/api/jobs?limit=${JOBS_PAGE_SIZE}`;
    this.reading.set(true);
    try {
      const response = await this.auth.request(path);
      if (!response.ok) {
        this.failed(false);
        return null;
      }
      let list: JobList;
      try {
        list = jobListSchema.parse(await response.json());
      } catch {
        this.failed(false);
        return null;
      }
      if (revision !== this.queryRevision) return [];
      this.page.set(list);
      this.loaded.set(true);
      this.loading.set(false);
      this.offline.set(false);
      this.stale.set(false);
      this.error.set('');
      this.shownIndex.set(index);
      return list.jobs;
    } catch {
      this.failed(true);
      return null;
    } finally {
      this.reading.set(false);
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

  private openStream(): void {
    this.closeStream();
    const stream = this.eventSource('/api/jobs/events');
    this.stream = stream;
    const current = () => this.stream === stream;
    stream.addEventListener('open', () => {
      if (!current()) return;
      this.watch();
      // Every stream open marks the reader dirty (section 3.4).
      this.reader.opened();
    });
    stream.addEventListener('ping', () => {
      if (current()) this.watch();
    });
    stream.addEventListener('job-changed', (message) => {
      if (!current()) return;
      this.watch();
      this.onEvent((message as MessageEvent<string>).data);
    });
    stream.addEventListener('error', () => {
      // EventSource retries while CONNECTING. A closed stream reopens after the delay.
      if (current() && stream.readyState === CLOSED) this.scheduleReopen();
    });
  }

  private closeStream(): void {
    clearTimeout(this.watchdog);
    this.stream?.close();
    this.stream = null;
  }

  /** A stream without events past the timeout counts as dead. */
  private watch(): void {
    clearTimeout(this.watchdog);
    if (this.streamTimeout > 0)
      this.watchdog = setTimeout(() => {
        if (this.streamWanted) this.scheduleReopen();
      }, this.streamTimeout);
  }

  private scheduleReopen(): void {
    this.closeStream();
    clearTimeout(this.reopenTimer);
    this.reopenTimer = setTimeout(() => {
      if (this.streamWanted) this.openStream();
    }, this.reopenDelay);
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

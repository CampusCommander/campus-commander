import {
  Injectable,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import {
  DEVICE_BY_IDS_LIMIT,
  deviceDetailSchema,
  deviceDomainRefreshSchema,
  deviceFreshnessSchema,
  deviceOrgUnitsSchema,
  deviceGroupPageSchema,
  devicePageSchema,
  deviceRowsSchema,
  deviceSelectionRefreshSchema,
  deviceSyncStateSchema,
  deviceStreamEventSchema,
  type DeviceDetail,
  type DeviceFreshness,
  type DeviceOrgUnit,
  type DeviceGroupPage,
  type DevicePage,
  type DevicePredicate,
  type DeviceRow,
  type DeviceSelectionKey,
  type DeviceSyncFailure,
  type DeviceSyncState,
} from '@campus/application-contracts';
import type { GridState } from 'ag-grid-community';
import { AuthStore } from '../auth.store';
import { CustomerStore } from '../customer-settings/customer.store';
import { ConnectionStore } from '../google-connection/connection.store';
import { LiveFeeds, type LiveFeedSubscription } from '../jobs/live-feeds';
import { GROUP_LIMIT, type DeviceView } from './device-datasource';
import { samePredicates } from './device-filter-model';
import {
  DOMAIN_REFRESHED_TEXT,
  NOTHING_SELECTED_TEXT,
  SELECTION_EXPIRED_TEXT,
  SELECTION_TOO_LARGE_TEXT,
  domainFailureText,
  refreshAlreadyReadingText,
  refreshStartFailureText,
  refreshStartedText,
} from './device-refresh-messages';
import { DeviceRowRefresh } from './device-row-refresh';
import {
  DEVICE_GRID_ID,
  DeviceSelectionProvider,
  deviceSelectionTab,
} from './device-selection';

export function devicesReadable(auth: InstanceType<typeof AuthStore>): boolean {
  return (
    auth.metadata()?.phase === 3 &&
    !!auth
      .session()
      ?.identity.grants.some((grant) => grant.action === 'devices:read')
  );
}

const defaultView = (): DeviceView => ({
  predicates: [],
  sort: { field: 'serialNumber', direction: 'asc' },
  selection: null,
});

/** Only the outermost query reports counts. Open groups and Next device leave them alone. */
const countsKey = (view: DeviceView): string | null =>
  view.group?.keys.length
    ? null
    : JSON.stringify([view.predicates, view.selection, view.group?.by ?? []]);

/** The part of EventSource that the store uses. Tests supply a fake. */
export type DeviceEventSource = Pick<
  EventSource,
  'addEventListener' | 'close' | 'readyState'
>;

/** An instant as whole seconds from the epoch and the fraction digits that follow. */
interface Instant {
  seconds: number;
  /** Fraction digits without trailing zeros. An empty string means no fraction. */
  fraction: string;
}

/**
 * The timestamp shape of the contract: a `Z` or `±hh:mm` offset, seconds optional,
 * and any number of fraction digits. A fraction never appears without seconds.
 */
const instantPattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|([+-])(\d{2}):(\d{2}))$/;

/** Days from 1970-01-01 to the civil date. Exact for every year the contract accepts. */
const daysFromCivil = (year: number, month: number, day: number): number => {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear =
    Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 +
    Math.floor(yearOfEra / 4) -
    Math.floor(yearOfEra / 100) +
    dayOfYear;
  return era * 146097 + dayOfEra - 719468;
};

/** Split a contract timestamp into its instant. Returns null for any other shape. */
const parseInstant = (time: string): Instant | null => {
  const parts = instantPattern.exec(time);
  if (!parts) return null;
  const [
    ,
    year,
    month,
    day,
    hour,
    minute,
    second,
    fraction,
    zone,
    sign,
    offsetHours,
    offsetMinutes,
  ] = parts;
  const offset =
    zone === 'Z'
      ? 0
      : (sign === '-' ? -1 : 1) *
        (Number(offsetHours) * 3600 + Number(offsetMinutes) * 60);
  return {
    seconds:
      daysFromCivil(Number(year), Number(month), Number(day)) * 86_400 +
      Number(hour) * 3600 +
      Number(minute) * 60 +
      // The contract allows a timestamp without seconds. An omitted second is zero.
      Number(second ?? 0) -
      offset,
    // Trailing zeros carry no order, so one instant in two spellings compares as one value.
    fraction: (fraction ?? '').replace(/0+$/, ''),
  };
};

/**
 * -1, 0, or 1 for `time` against `other`. Every fraction digit counts.
 * A missing time is earliest. A time without an exact parse returns null.
 */
const compareInstants = (
  time: string | null,
  other: string | null,
): number | null => {
  if (time === null) return other === null ? 0 : -1;
  if (other === null) return 1;
  const left = parseInstant(time);
  const right = parseInstant(other);
  // The contract schema rejects every other shape. No order means the answer replaces.
  if (!left || !right) return null;
  if (left.seconds !== right.seconds)
    return left.seconds < right.seconds ? -1 : 1;
  const digits = Math.max(left.fraction.length, right.fraction.length);
  const leftFraction = left.fraction.padEnd(digits, '0');
  const rightFraction = right.fraction.padEnd(digits, '0');
  if (leftFraction === rightFraction) return 0;
  return leftFraction < rightFraction ? -1 : 1;
};

/** The query whose stale devices the banner counts: the outermost filters and selection. */
interface CountedQuery {
  predicates: DevicePredicate[];
  selection: DeviceSelectionKey | null;
}

/** Browsing state survives navigation between the grid and device details. */
@Injectable({ providedIn: 'root' })
export class DevicesStore {
  private readonly auth = inject(AuthStore);
  private readonly customer = inject(CustomerStore);
  private readonly connection = inject(ConnectionStore);
  private readonly feeds = inject(LiveFeeds);
  /** Opens the one live stream of the tab. Tests replace it. */
  eventSource: (url: string) => DeviceEventSource = (url) =>
    new EventSource(url);
  /** Milliseconds between a refresh signal and the stale count that it triggers. */
  recountDelay = 1000;
  /** Milliseconds before a failed status read is retried. Each failed attempt doubles the wait. */
  statusRetryDelay = 5000;
  /** Milliseconds that the doubled status-read retry never exceeds. */
  statusRetryCap = 60_000;
  readonly sync = signal<DeviceSyncState | null>(null);
  readonly syncLoaded = signal(false);
  readonly predicates = signal<DevicePredicate[]>([]);
  /** The query the grid last ran. Next device follows it. */
  readonly view = signal<DeviceView>(defaultView());
  /** Grid columns, filters, sort, and page, kept while device details are open. */
  readonly gridState = signal<GridState | null>(null);
  /** Show All Selected was on when the grid closed. Back to devices reopens it. */
  readonly selectedView = signal(false);
  readonly selection = new DeviceSelectionProvider(
    (path, body) => this.call(path, body),
    () => ({
      predicates: this.view().predicates,
      by: this.view().group?.by ?? [],
    }),
  );
  readonly selectionTab = deviceSelectionTab();
  readonly page = signal<Omit<DevicePage, 'rows' | 'refreshJobId'> | null>(
    null,
  );
  /**
   * The pending view's row count. Null while the grid shows the person's own query,
   * so the status bar counts the query (addendum section 5).
   */
  readonly pendingMatching = signal<number | null>(null);
  /** The pending read failed, so the view names the failure and offers a retry. */
  readonly pendingFailure = signal(false);
  /** Invalidates a pending read that answers after the person returns to the query. */
  private pendingSequence = 0;
  /** Stale devices in the counted result set, and whether a refresh job runs (D11). */
  readonly freshness = signal<DeviceFreshness | null>(null);
  /** The cause of the last refresh job that failed. A new refresh job clears it. */
  readonly jobFailure = signal<DeviceSyncFailure | null>(null);
  /** The device rows that the grid holds. The grid attaches itself when ready. */
  readonly gridRows = new DeviceRowRefresh();
  /** True when an open group or a grouped level holds more than the grid lists. */
  readonly groupLimit = signal(false);
  /** The outermost query whose counts the status bar shows. */
  private counted = countsKey(defaultView());
  private countedQuery: CountedQuery = { predicates: [], selection: null };
  /** The counts and revision that the last stale count belongs to. */
  private recounted: string | null = null;
  /** The counted query that `freshness` belongs to. */
  private freshnessFor: string | null = null;
  readonly orgUnits = signal<DeviceOrgUnit[]>([]);
  readonly offline = signal(false);
  readonly error = signal('');
  /** Increments when the grid must reload from the first block. */
  readonly revision = signal(0);
  /** Increments when a resumed session must retry the grid blocks whose loads failed. */
  readonly resumeRevision = signal(0);
  /** Row index and ID of the last opened device in the current filtered order. */
  readonly position = signal<{
    index: number;
    deviceId: string;
    /** Rows that Next device can walk. Set for a device opened inside a group. */
    count?: number;
  } | null>(null);
  /** A full sync runs. */
  readonly refreshing = computed(() => this.sync()?.status === 'running');
  /** A start or outcome message for the footer status panel (GRID-01). */
  readonly refreshStatus = signal('');
  /** The requests from the Refresh menu that are still pending, by sequence. */
  private readonly refreshRequests = signal<ReadonlySet<number>>(new Set());
  readonly refreshPending = computed(() => this.refreshRequests().size > 0);
  /** The next refresh request replaces the answer of an earlier one. */
  private refreshSequence = 0;
  readonly readable = computed(() => devicesReadable(this.auth));
  /** The tab's shared connection. The last store to leave closes it. */
  private feed: LiveFeedSubscription | null = null;
  /** Devices is mounted. */
  private streamWanted = false;
  /** A status read before the store subscribes is in flight. */
  private connecting = false;
  /** A stream opened once since the store subscribed. The next open is a reconnect. */
  private streamOpened = false;
  /** The status from before the stream dropped. The reconcile after the next open compares against it. */
  private dropped: { state: DeviceSyncState | null } | null = null;
  /** Device events of an open that waits for its status read. */
  private held: string[] = [];
  /** An open waits for its status read before it follows the device events. */
  private holding = false;
  /** Invalidates a status read whose open a stop replaced. */
  private openGeneration = 0;
  /** Failed status reads since the last successful one. */
  private statusFailures = 0;
  private statusRetryTimer?: ReturnType<typeof setTimeout>;
  private recountTimer?: ReturnType<typeof setTimeout>;
  /** Increments on sign-in by another person. Late answers for the old person are dropped. */
  private epoch = 0;
  private identity: string | null = null;
  /** The session ended or was interrupted. The same person can resume it. */
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

  /** Browsing state belongs to one person. Another sign-in starts clean. */
  private reset(): void {
    this.epoch++;
    this.refreshSequence++;
    this.refreshStatus.set('');
    this.refreshRequests.set(new Set());
    this.dropped = null;
    this.sync.set(null);
    this.syncLoaded.set(false);
    this.predicates.set([]);
    this.view.set(defaultView());
    this.gridState.set(null);
    this.selectedView.set(false);
    this.groupLimit.set(false);
    this.counted = countsKey(defaultView());
    this.countedQuery = { predicates: [], selection: null };
    this.recounted = null;
    this.freshnessFor = null;
    this.selection.spec.set(null);
    this.page.set(null);
    this.freshness.set(null);
    this.jobFailure.set(null);
    this.orgUnits.set([]);
    this.offline.set(false);
    this.error.set('');
    this.position.set(null);
    this.revision.update((value) => value + 1);
    // The stream carries the session cookie. A new person needs a new stream.
    if (this.feed) this.feed.restart();
    // The new person's stream is a first stream. Its open recovers nothing.
    this.streamOpened = false;
    this.dropped = null;
    this.dropHeld();
    this.clearStatusRetry();
  }

  private async call(path: string, body?: unknown): Promise<Response | null> {
    try {
      const response = await this.auth.request(path, body);
      this.offline.set(false);
      return response;
    } catch {
      this.offline.set(true);
      return null;
    }
  }

  /** Devices mounted: read the status, then follow the device events (D12). */
  async init(): Promise<void> {
    this.streamWanted = true;
    await this.connect();
  }

  /**
   * The status read that comes before this store follows the device events. A denied read or a
   * customer without a sync leaves this store stopped. The tab keeps its connection for the
   * stores that follow the job feed.
   */
  private async connect(): Promise<void> {
    if (this.feed || this.connecting) return;
    this.connecting = true;
    try {
      const result = await this.readSync();
      // A leave, or a resume that opened a connection, made this read obsolete.
      if (!this.streamWanted || this.feed) return;
      if (result === 'denied') return;
      if (result === 'failed') {
        this.scheduleStatusRetry('connect');
        return;
      }
      if (!this.sync()) return;
      this.statusFailures = 0;
      this.follow();
    } finally {
      this.connecting = false;
    }
  }

  /** Subscribes to the tab's one connection. Other stores keep it while this store follows. */
  private follow(): void {
    if (this.feed) return;
    this.streamOpened = false;
    this.dropped = null;
    this.feed = this.feeds.subscribe('/api/events', {
      open: () => this.eventSource('/api/events'),
      events: ['entity-batch', 'job-finished', 'full-sync'],
      opened: (replaced) => this.onStreamOpen(replaced),
      changed: (data) => this.onEvent(data),
      closed: () => {
        this.dropped ??= { state: this.sync() };
      },
    });
  }

  /** Stops this store's subscription. The tab's connection stays for every other store. */
  private stopFeed(): void {
    this.openGeneration += 1;
    this.feed?.close();
    this.feed = null;
    this.dropped = null;
  }

  /** Devices left: close the subscription and drop pending timers. */
  leave(): void {
    this.streamWanted = false;
    this.stopFeed();
    this.clearStatusRetry();
    this.dropHeld();
    // A late refresh answer must not reach the footer after the page closes.
    this.refreshSequence++;
    this.refreshStatus.set('');
    clearTimeout(this.recountTimer);
  }

  /** Reads the status again after a failed read. The device store alone waits. */
  private scheduleStatusRetry(action: 'connect' | 'open', generation = 0): void {
    if (this.statusRetryTimer !== undefined || !this.streamWanted) return;
    const delay = Math.min(
      this.statusRetryDelay * 2 ** this.statusFailures,
      this.statusRetryCap,
    );
    this.statusFailures += 1;
    this.statusRetryTimer = setTimeout(() => {
      this.statusRetryTimer = undefined;
      if (action === 'connect') void this.connect();
      else void this.retryOpen(generation);
    }, delay);
  }

  private clearStatusRetry(): void {
    if (this.statusRetryTimer !== undefined) clearTimeout(this.statusRetryTimer);
    this.statusRetryTimer = undefined;
    this.statusFailures = 0;
  }

  /** Returns false when the status could not be read. */
  async loadSync(): Promise<boolean> {
    return (await this.readSync()) === 'read';
  }

  /** Read the status. `denied` means a 401 or 403 answer. `failed` means any other failure. */
  private async readSync(): Promise<'read' | 'denied' | 'failed'> {
    // Another person signed in while this read was in flight. Its answer belongs to the old person.
    const epoch = this.epoch;
    const response = await this.call('/api/devices/sync');
    if (epoch !== this.epoch) return 'failed';
    if (!response) return 'failed';
    if (!response.ok) {
      this.error.set('Device inventory status is unavailable.');
      return response.status === 401 || response.status === 403
        ? 'denied'
        : 'failed';
    }
    let answer: DeviceSyncState | null;
    try {
      answer = deviceSyncStateSchema
        .nullable()
        .parse((await response.json()).sync);
    } catch {
      if (epoch !== this.epoch) return 'failed';
      // A 200 answer with an unreadable body counts as a failed read. The reopen then retries.
      this.error.set('Device inventory status is unavailable.');
      return 'failed';
    }
    if (epoch !== this.epoch) return 'failed';
    this.error.set('');
    this.setSync(answer);
    this.syncLoaded.set(true);
    return 'read';
  }

  /** A status answer never replaces a newer current status (S2). */
  private setSync(answer: DeviceSyncState | null): void {
    if (this.isOlder(answer)) return;
    this.sync.set(answer);
  }

  /** True when `answer` predates the current status of the same customer and generation. */
  private isOlder(answer: DeviceSyncState | null): boolean {
    const current = this.sync();
    if (!answer || !current) return false;
    if (
      answer.customerId !== current.customerId ||
      answer.generation !== current.generation
    )
      return false;
    const starts = compareInstants(answer.startedAt, current.startedAt);
    // An unreadable time has no order. The answer replaces the status, as before S2.
    if (starts === null) return false;
    if (starts !== 0) return starts < 0;
    const checks = compareInstants(answer.checkedAt, current.checkedAt);
    return checks !== null && checks < 0;
  }

  /** Start a full sync. The full-sync event reports its end (D12). */
  async refreshAll(): Promise<void> {
    const attempt = this.beginRefresh();
    try {
      const response = await this.call('/api/devices/sync', {});
      if (!attempt.current() || !response) return;
      const body = await response.json().catch(() => null);
      if (!attempt.current()) return;
      if (response.status === 409 && body?.reason === 'device-sync-running') {
        await this.loadSync();
      } else if (!response.ok) {
        this.error.set(refreshStartFailureText(body?.reason));
      } else {
        const started = deviceSyncStateSchema.safeParse(body?.sync);
        if (!started.success) {
          // A 200 answer with an unreadable body never starts a refresh.
          this.error.set('The refresh could not start.');
          return;
        }
        this.error.set('');
        this.setSync(started.data);
      }
    } finally {
      attempt.end();
    }
  }

  /** Refresh Selected: read the selected devices from Google again. */
  async refreshSelection(): Promise<void> {
    const attempt = this.beginRefresh();
    try {
      const response = await this.call('/api/devices/selection/refresh', {
        gridId: DEVICE_GRID_ID,
        tabId: this.selectionTab,
      });
      if (!attempt.current() || !response) return;
      const body = await response.json().catch(() => null);
      if (!attempt.current()) return;
      if (response.ok) {
        const refresh = deviceSelectionRefreshSchema.safeParse(body?.refresh);
        if (!refresh.success) {
          this.error.set('The refresh could not start.');
          return;
        }
        this.error.set('');
        this.refreshStatus.set(
          refresh.data.jobId === null
            ? refreshAlreadyReadingText(refresh.data.selected)
            : refreshStartedText(refresh.data.selected),
        );
        return;
      }
      // A 401 answer ends the session. The shell reports it, and no status line stays.
      // A 403 answer is an ordinary failure like every other status.
      if (response.status === 401) return;
      if (response.status === 409 && body?.reason === 'selection-expired')
        this.refreshStatus.set(SELECTION_EXPIRED_TEXT);
      else if (response.status === 422 && body?.reason === 'nothing-selected')
        this.refreshStatus.set(NOTHING_SELECTED_TEXT);
      else if (
        response.status === 422 &&
        body?.reason === 'selection-too-large'
      )
        this.refreshStatus.set(SELECTION_TOO_LARGE_TEXT);
      else {
        this.error.set(refreshStartFailureText(body?.reason));
        return;
      }
      this.error.set('');
    } finally {
      attempt.end();
    }
  }

  /** Refresh Domain: start the full sync, then read the domain details again. */
  async refreshDomain(): Promise<void> {
    const attempt = this.beginRefresh();
    try {
      const response = await this.call('/api/devices/domain/refresh', {});
      if (!attempt.current() || !response) return;
      const body = await response.json().catch(() => null);
      if (!attempt.current()) return;
      if (response.status === 409 && body?.reason === 'device-sync-running') {
        await this.loadSync();
        return;
      }
      if (!response.ok) {
        // A 401 answer ends the session. The shell reports it, and no status line stays.
        if (response.status === 401) return;
        this.error.set(refreshStartFailureText(body?.reason));
        return;
      }
      const answer = deviceDomainRefreshSchema.safeParse(body?.refresh);
      if (!answer.success) {
        this.error.set('The refresh could not start.');
        return;
      }
      this.error.set('');
      // The full sync starts before the domain check. Apply it even when the check failed.
      this.setSync(answer.data.sync);
      if (answer.data.domain.status === 'refreshed') {
        this.refreshStatus.set(DOMAIN_REFRESHED_TEXT);
        // The shell shows the new domain details.
        void this.customer.refresh();
        void this.connection.refresh();
      } else {
        this.refreshStatus.set(domainFailureText(answer.data.domain.reason));
      }
    } finally {
      attempt.end();
    }
  }

  /** Clear the last status line and count the request that follows. */
  private beginRefresh(): { current: () => boolean; end: () => void } {
    const sequence = ++this.refreshSequence;
    const epoch = this.epoch;
    this.refreshStatus.set('');
    this.refreshRequests.update((value) => new Set(value).add(sequence));
    return {
      current: () => sequence === this.refreshSequence && epoch === this.epoch,
      end: () =>
        this.refreshRequests.update((value) => {
          // A reset already cleared the request. A late end must not clear a newer one.
          if (!value.has(sequence)) return value;
          const next = new Set(value);
          next.delete(sequence);
          return next;
        }),
    };
  }

  /** Reconnect after an offline period: reload the status and the grid, and reopen the stream. */
  async reconnect(): Promise<void> {
    if (!(await this.loadSync())) return;
    this.revision.update((value) => value + 1);
    if (!this.streamWanted) return;
    if (!this.feed) {
      void this.connect();
      return;
    }
    if (!this.feed.active && this.sync()) this.feed.resume();
  }

  async rows(offset: number, limit: number): Promise<DevicePage | null> {
    // The person's own query replaces the pending view, so the status bar counts it again.
    this.clearPending();
    const view = this.view();
    const revision = this.revision();
    const response = await this.call('/api/devices/query', {
      ...view,
      offset,
      limit,
    });
    if (!response?.ok) return null;
    const page = devicePageSchema.parse((await response.json()).page);
    // A new refresh job replaces the cause of the last failed one. The banner then counts its devices.
    if (page.refreshJobId) {
      this.jobFailure.set(null);
      this.scheduleRecount();
    }
    // Only a whole open group loads at the group limit. Next device loads one row.
    if (
      view.group?.by.length &&
      limit === GROUP_LIMIT &&
      page.rows.length < page.matching
    )
      this.groupLimit.set(true);
    this.keepCounts(view, revision, page);
    return page;
  }

  /**
   * The view boundary. The person's own query is back, so the pending count leaves the
   * status bar and a late pending answer changes no count (addendum section 5).
   */
  clearPending(): void {
    this.pendingSequence += 1;
    this.pendingMatching.set(null);
    this.pendingFailure.set(false);
  }

  /**
   * The pending view's rows: the changed devices of the grid draft, read by ID
   * (addendum section 5). A draft holds at most 500 devices, the request limit, so one
   * POST answers the view.
   */
  async pendingRows(ids: readonly string[]): Promise<DeviceRow[] | null> {
    const sequence = ++this.pendingSequence;
    this.pendingFailure.set(false);
    // The pending set is one row per changed device, so this count holds during the read.
    this.pendingMatching.set(ids.length);
    if (!ids.length) {
      this.pendingMatching.set(0);
      return [];
    }
    const response = await this.call('/api/devices/by-ids', {
      deviceIds: [...ids],
    });
    if (!response?.ok) {
      if (sequence === this.pendingSequence) this.pendingFailure.set(true);
      return null;
    }
    try {
      const rows = deviceRowsSchema.parse((await response.json()).rows);
      // A read that answers after the person returned to the query changes no count.
      if (sequence === this.pendingSequence)
        this.pendingMatching.set(rows.length);
      return rows;
    } catch {
      // A contract drift is a failed read, not an empty view.
      if (sequence === this.pendingSequence) this.pendingFailure.set(true);
      return null;
    }
  }

  async groups(view: DeviceView): Promise<DeviceGroupPage | null> {
    // A grouped root is the person's query too. Its count replaces the pending view's.
    this.clearPending();
    const revision = this.revision();
    const response = await this.call('/api/devices/groups', {
      ...view,
      offset: 0,
      limit: GROUP_LIMIT,
    });
    if (!response?.ok) return null;
    const page = deviceGroupPageSchema.parse((await response.json()).groups);
    if (page.groups.length < page.groupCount) this.groupLimit.set(true);
    this.keepCounts(view, revision, page);
    return page;
  }

  /** A response for a query that changed meanwhile must not replace the counts. */
  private keepCounts(
    view: DeviceView,
    revision: number,
    counts: Omit<DevicePage, 'rows' | 'refreshJobId'>,
  ): void {
    const key = countsKey(view);
    if (key === null || key !== this.counted || revision !== this.revision())
      return;
    this.page.set({
      matching: counts.matching,
      total: counts.total,
      observedAt: counts.observedAt,
    });
    // New counts mean a new result set. Its stale count follows at once, once per query and revision.
    // The banner keeps the last count until then, so it does not blink.
    const token = `${key}#${revision}`;
    if (token === this.recounted) return;
    this.recounted = token;
    this.scheduleRecount(0);
  }

  /** Count the stale devices of the counted query and learn whether a refresh job runs (D11). */
  async recount(): Promise<void> {
    const counted = this.counted;
    const epoch = this.epoch;
    const response = await this.call(
      '/api/devices/freshness',
      this.countedQuery,
    );
    let freshness: DeviceFreshness | null = null;
    try {
      if (response?.ok)
        freshness = deviceFreshnessSchema.parse(
          (await response.json()).freshness,
        );
    } catch {
      // An unreadable count counts as a failed count.
    }
    if (counted !== this.counted || epoch !== this.epoch) return;
    if (freshness) {
      this.freshness.set(freshness);
      this.freshnessFor = counted;
    } else if (this.freshnessFor !== counted) {
      // A failed count leaves the banner as it was. A count for another query must not stay.
      this.freshness.set(null);
    }
  }

  private scheduleRecount(delay = this.recountDelay): void {
    clearTimeout(this.recountTimer);
    this.recountTimer = setTimeout(() => void this.recount(), delay);
  }

  /**
   * A shared connection opened. The status read before the subscription answers for the first
   * open of a replaced connection; a client that replaces the connection reads the status before
   * it follows the device events again (S1 to S5, D12). A native reconnect reuses the connection.
   */
  private onStreamOpen(replaced: boolean): void {
    const first = !this.streamOpened;
    this.streamOpened = true;
    const generation = ++this.openGeneration;
    // A first open after the subscription read has the status it needs. Every other open reads.
    const read = !(first && this.dropped === null) && replaced;
    if (read) this.holding = true;
    void this.afterOpen(generation, first, read);
  }

  private async afterOpen(
    generation: number,
    first: boolean,
    read: boolean,
  ): Promise<void> {
    // Only a first open with no closed stream behind it has missed no event.
    if (first && this.dropped === null) {
      if (this.sync()?.status !== 'running') return;
      // A full sync can end between the read before the subscription and this first open.
      this.dropped = { state: this.sync() };
    } else if (read) {
      const result = await this.readSync();
      if (generation !== this.openGeneration) return;
      if (this.stopOnStatusResult(result)) return;
      if (result === 'failed') {
        // The status read comes before the device events. A failed one waits for its retry.
        this.scheduleStatusRetry('open', generation);
        return;
      }
      this.statusFailures = 0;
    }
    await this.reconcile();
    if (generation !== this.openGeneration) return;
    this.releaseHeld();
  }

  /** Retries the status read of one open. The device events wait until it answers. */
  private async retryOpen(generation: number): Promise<void> {
    if (generation !== this.openGeneration || !this.feed) return;
    const result = await this.readSync();
    if (generation !== this.openGeneration || !this.feed) return;
    if (this.stopOnStatusResult(result)) return;
    if (result === 'failed') {
      this.scheduleStatusRetry('open', generation);
      return;
    }
    this.statusFailures = 0;
    await this.reconcile();
    if (generation !== this.openGeneration) return;
    this.releaseHeld();
  }

  /** Stops this store when its status read denies it or the customer has no sync. */
  private stopOnStatusResult(result: 'read' | 'denied' | 'failed'): boolean {
    if (result !== 'denied' && !(result === 'read' && !this.sync())) return false;
    // A denied read or a missing sync stops only this store. The tab keeps the connection.
    this.stopFeed();
    this.dropHeld();
    return true;
  }

  /** Follows the device events that an open held for its status read. */
  private releaseHeld(): void {
    this.holding = false;
    for (const data of this.held.splice(0)) this.applyEvent(data);
  }

  /** Drops the device events of a stopped store. They belong to no followed feed. */
  private dropHeld(): void {
    this.holding = false;
    this.held = [];
  }

  /** The same person resumed an interrupted session. A stream that a 401 stopped opens again. */
  private resume(): void {
    // The grid retries the blocks whose loads failed while the session was interrupted (S5).
    this.resumeRevision.update((value) => value + 1);
    if (!this.streamWanted) return;
    if (!this.feed) {
      void this.connect();
      return;
    }
    this.feed.resume();
  }

  private onEvent(data: string): void {
    // A status read comes before this store follows the device events of an open.
    if (this.holding) this.held.push(data);
    else this.applyEvent(data);
  }

  private applyEvent(data: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const result = deviceStreamEventSchema.safeParse(parsed);
    if (!result.success) return;
    const event = result.data;
    if (event.type === 'entity-batch') {
      void this.refreshRows([...event.deviceIds, ...event.removedIds]);
      this.scheduleRecount();
    } else if (event.type === 'job-finished') {
      if (event.failure) this.jobFailure.set(event.failure);
      this.scheduleRecount();
    } else {
      // An older event reports a sync that the current status already passed. It changes nothing.
      if (this.isOlder(event.sync)) return;
      this.sync.set(event.sync);
      if (event.sync.status !== 'running')
        this.revision.update((value) => value + 1);
    }
  }

  /**
   * After a reconnect: a status read after the open, every held row, and the counts (D12).
   * A closed feed loses events, so any held row can have changed. Its stale tag is not enough.
   */
  private async reconcile(): Promise<void> {
    // The reopen read ran before this stream subscribed, so a full sync can end unseen in between.
    // This read runs after the open. It compares against the status from before the drop.
    const baseline = this.dropped;
    this.dropped = null;
    const before = baseline ? baseline.state : this.sync();
    const read = await this.loadSync();
    // A failed read leaves the gate-read status in place, so it answers for the gate read too.
    const after = this.sync();
    // A full sync that ended meanwhile reloads every row and count.
    const ended =
      (before?.status === 'running' && after?.status !== 'running') ||
      before?.observedAt !== after?.observedAt;
    if (!read) {
      if (ended) {
        this.revision.update((value) => value + 1);
        // The gate read is the status that the next reconnect compares against.
        this.dropped = { state: after };
        return;
      }
      // The next reconnect compares against the same status.
      this.dropped = { state: before };
      return;
    }
    if (ended) {
      this.revision.update((value) => value + 1);
      return;
    }
    await this.refreshRows('all');
    await this.recount();
  }

  /** Refetch the held rows among `ids`, or every held row (D7, D12). */
  private async refreshRows(ids: readonly string[] | 'all'): Promise<void> {
    const wanted = new Set(ids === 'all' ? [] : ids);
    const held = this.gridRows.held((row) =>
      ids === 'all' ? true : wanted.has(row.deviceId),
    );
    const epoch = this.epoch;
    for (let start = 0; start < held.length; start += DEVICE_BY_IDS_LIMIT) {
      const response = await this.call('/api/devices/by-ids', {
        deviceIds: held.slice(start, start + DEVICE_BY_IDS_LIMIT),
      });
      if (!response?.ok || epoch !== this.epoch) return;
      this.gridRows.apply(deviceRowsSchema.parse((await response.json()).rows));
    }
  }

  async neighbor(index: number): Promise<DeviceRow | null> {
    if (index < 0) return null;
    return (await this.rows(index, 1))?.rows[0] ?? null;
  }

  async device(id: string): Promise<DeviceDetail | null> {
    const response = await this.call(`/api/devices/${encodeURIComponent(id)}`);
    if (!response?.ok) return null;
    return deviceDetailSchema.parse((await response.json()).device);
  }

  async loadOrgUnits(): Promise<void> {
    const response = await this.call('/api/devices/org-units');
    if (!response?.ok) return;
    this.orgUnits.set(
      deviceOrgUnitsSchema.parse((await response.json()).orgUnits),
    );
  }

  /** Chips and column filters both land here. The grid applies them and reloads itself. */
  setPredicates(predicates: DevicePredicate[]): void {
    if (samePredicates(predicates, this.predicates())) return;
    this.predicates.set(predicates);
    this.position.set(null);
  }

  /** The grid reports each query it runs. A different query forgets the opened row. */
  setView(view: DeviceView): void {
    if (JSON.stringify(view) === JSON.stringify(this.view())) return;
    this.view.set(view);
    this.position.set(null);
    const key = countsKey(view);
    if (key === null || key === this.counted) return;
    this.counted = key;
    this.countedQuery = {
      predicates: view.predicates,
      selection: view.selection,
    };
    this.groupLimit.set(false);
  }
}

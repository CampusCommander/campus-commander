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
  ENTITY_EVENTS_PING_SECONDS,
  deviceDetailSchema,
  deviceFreshnessSchema,
  deviceOrgUnitsSchema,
  deviceGroupPageSchema,
  devicePageSchema,
  deviceRowsSchema,
  deviceSyncStateSchema,
  entityEventSchema,
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
import { GROUP_LIMIT, type DeviceView } from './device-datasource';
import { samePredicates } from './device-filter-model';
import { DeviceRowRefresh } from './device-row-refresh';
import {
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
const CLOSED = 2;

/** The query whose stale devices the banner counts: the outermost filters and selection. */
interface CountedQuery {
  predicates: DevicePredicate[];
  selection: DeviceSelectionKey | null;
}

/** Browsing state survives navigation between the grid and device details. */
@Injectable({ providedIn: 'root' })
export class DevicesStore {
  private readonly auth = inject(AuthStore);
  /** Opens the device event stream. Tests replace it. */
  eventSource: (url: string) => DeviceEventSource = (url) =>
    new EventSource(url);
  /** Milliseconds between a refresh signal and the stale count that it triggers. */
  recountDelay = 1000;
  /** Milliseconds before a closed stream reopens. Each failed attempt doubles the wait. */
  reopenDelay = 5000;
  /** Milliseconds that the doubled reopen wait never exceeds. */
  reopenCap = 60_000;
  /** Milliseconds without any event, pings included, before the stream counts as dead. */
  streamTimeout = ENTITY_EVENTS_PING_SECONDS * 2000 + 10_000;
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
  /** Row index and ID of the last opened device in the current filtered order. */
  readonly position = signal<{
    index: number;
    deviceId: string;
    /** Rows that Next device can walk. Set for a device opened inside a group. */
    count?: number;
  } | null>(null);
  /** A full sync runs. */
  readonly refreshing = computed(() => this.sync()?.status === 'running');
  readonly readable = computed(() => devicesReadable(this.auth));
  private stream: DeviceEventSource | null = null;
  /** Devices is mounted. */
  private streamWanted = false;
  /** A stream opened once since mount. The next open is a reconnect. */
  private streamOpened = false;
  private watchdog?: ReturnType<typeof setTimeout>;
  private reopenTimer?: ReturnType<typeof setTimeout>;
  /** Failed reopen attempts since the last open. Each one doubles the wait. */
  private reopenAttempts = 0;
  private recountTimer?: ReturnType<typeof setTimeout>;
  /** The status from before the stream dropped. The reconcile after the next open compares against it. */
  private dropped: { state: DeviceSyncState | null } | null = null;
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
    if (this.stream) this.openStream();
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

  /** Devices mounted: read the status and open the event stream (D12). */
  async init(): Promise<void> {
    this.streamWanted = true;
    if (this.stream) return;
    this.streamOpened = false;
    this.dropped = null;
    await this.reopen();
  }

  /** Devices left: close the stream and drop pending timers. */
  leave(): void {
    this.streamWanted = false;
    this.dropped = null;
    this.reopenAttempts = 0;
    this.closeStream();
    clearTimeout(this.reopenTimer);
    clearTimeout(this.recountTimer);
  }

  /** Returns false when the status could not be read. */
  async loadSync(): Promise<boolean> {
    return (await this.readSync()) === 'read';
  }

  /** Read the status. `denied` means a 401 or 403 answer. `failed` means any other failure. */
  private async readSync(): Promise<'read' | 'denied' | 'failed'> {
    const response = await this.call('/api/devices/sync');
    if (!response) return 'failed';
    if (!response.ok) {
      this.error.set('Device inventory status is unavailable.');
      return response.status === 401 || response.status === 403
        ? 'denied'
        : 'failed';
    }
    this.error.set('');
    this.sync.set(
      deviceSyncStateSchema.nullable().parse((await response.json()).sync),
    );
    this.syncLoaded.set(true);
    return 'read';
  }

  /** Start a full sync. The full-sync event reports its end (D12). */
  async refreshAll(): Promise<void> {
    const response = await this.call('/api/devices/sync', {});
    if (!response) return;
    const body = await response.json().catch(() => null);
    if (response.status === 409 && body?.reason === 'device-sync-running') {
      await this.loadSync();
    } else if (!response.ok) {
      this.error.set(
        body?.reason === 'orchestration-unavailable'
          ? 'Campus Commander could not start the refresh. Check Diagnostics.'
          : 'The refresh could not start.',
      );
    } else {
      this.error.set('');
      this.sync.set(deviceSyncStateSchema.parse(body.sync));
    }
  }

  /** Reconnect after an offline period: reload the status and the grid, and reopen the stream. */
  async reconnect(): Promise<void> {
    if (!(await this.loadSync())) return;
    this.revision.update((value) => value + 1);
    if (this.streamWanted && !this.stream && this.sync()) {
      clearTimeout(this.reopenTimer);
      this.openStream();
    }
  }

  async rows(offset: number, limit: number): Promise<DevicePage | null> {
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

  async groups(view: DeviceView): Promise<DeviceGroupPage | null> {
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

  private openStream(): void {
    this.closeStream();
    const stream = this.eventSource('/api/devices/events');
    this.stream = stream;
    const epoch = this.epoch;
    const current = () => this.stream === stream && epoch === this.epoch;
    stream.addEventListener('open', () => {
      if (!current()) return;
      this.reopenAttempts = 0;
      this.watch();
      // The first open follows a fresh status read. It has no earlier stream to reconcile.
      if (this.streamOpened) void this.reconcile();
      else this.dropped = null;
      this.streamOpened = true;
    });
    stream.addEventListener('error', () => {
      // EventSource retries by itself while CONNECTING. A closed stream reopens after a status read.
      if (current() && stream.readyState === CLOSED) this.scheduleReopen();
    });
    for (const name of ['ping', 'entity-batch', 'job-finished', 'full-sync'])
      stream.addEventListener(name, (message) => {
        if (!current()) return;
        this.watch();
        if (name !== 'ping')
          this.onEvent((message as MessageEvent<string>).data);
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

  /** Close the stream and reopen it later. Each failed attempt doubles the wait, up to the cap. */
  private scheduleReopen(): void {
    this.dropped ??= { state: this.sync() };
    this.closeStream();
    clearTimeout(this.reopenTimer);
    const delay = Math.min(
      this.reopenDelay * 2 ** this.reopenAttempts,
      this.reopenCap,
    );
    this.reopenAttempts++;
    this.reopenTimer = setTimeout(() => {
      if (this.streamWanted) void this.reopen();
    }, delay);
  }

  /**
   * Read the status, then open the stream. AuthStore handles an ended session through this read.
   * 401 and 403 leave the stream closed. A server error or a network failure tries again later.
   */
  private async reopen(): Promise<void> {
    const result = await this.readSync();
    if (!this.streamWanted || this.stream) return;
    if (result === 'failed') this.scheduleReopen();
    else if (result === 'read' && this.sync()) this.openStream();
  }

  /** The same person resumed an interrupted session. A stream that a 401 closed opens again. */
  private resume(): void {
    if (!this.streamWanted || this.stream) return;
    clearTimeout(this.reopenTimer);
    void this.reopen();
  }

  private onEvent(data: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const result = entityEventSchema.safeParse(parsed);
    if (!result.success) return;
    const event = result.data;
    if (event.type === 'entity-batch') {
      void this.refreshRows([...event.deviceIds, ...event.removedIds]);
      this.scheduleRecount();
    } else if (event.type === 'job-finished') {
      if (event.job.failure) this.jobFailure.set(event.job.failure);
      this.scheduleRecount();
    } else {
      this.sync.set(event.sync);
      if (event.sync.status !== 'running')
        this.revision.update((value) => value + 1);
    }
  }

  /** After a reconnect: a status read after the open, the rows still tagged stale, and the counts (D12). */
  private async reconcile(): Promise<void> {
    // The reopen read ran before this stream subscribed, so a full sync can end unseen in between.
    // This read runs after the open. It compares against the status from before the drop.
    const baseline = this.dropped;
    this.dropped = null;
    const before = baseline ? baseline.state : this.sync();
    if (!(await this.loadSync())) {
      // The next reconnect compares against the same status.
      this.dropped = { state: before };
      return;
    }
    const after = this.sync();
    // A full sync that ended meanwhile reloads every row and count.
    if (
      (before?.status === 'running' && after?.status !== 'running') ||
      before?.observedAt !== after?.observedAt
    ) {
      this.revision.update((value) => value + 1);
      return;
    }
    await this.refreshRows('stale');
    await this.recount();
  }

  /** Refetch held rows among `ids`, or every held row still tagged stale (D7, D12). */
  private async refreshRows(ids: readonly string[] | 'stale'): Promise<void> {
    const wanted = new Set(ids === 'stale' ? [] : ids);
    const held = this.gridRows.held((row) =>
      ids === 'stale' ? row.stale : wanted.has(row.deviceId),
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

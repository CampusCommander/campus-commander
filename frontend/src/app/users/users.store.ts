import {
  Injectable,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import {
  USER_BY_IDS_LIMIT,
  userAttributeCategoriesSchema,
  userDetailSchema,
  userDomainRefreshSchema,
  userFreshnessSchema,
  userOrgUnitsSchema,
  userPageSchema,
  userRowSchema,
  userSelectionRefreshSchema,
  userStreamEventSchema,
  userSyncStateSchema,
  type DeviceSyncFailure,
  type UserAttributeCategories,
  type UserDetail,
  type UserFreshness,
  type UserOrgUnit,
  type UserPage,
  type UserPredicate,
  type UserRow,
  type UserSyncState,
} from '@campus/application-contracts';
import { z } from 'zod';
import type { GridState } from 'ag-grid-community';
import { AuthStore } from '../auth.store';
import { CustomerStore } from '../customer-settings/customer.store';
import { ConnectionStore } from '../google-connection/connection.store';
import { LiveFeeds, type LiveFeedSubscription } from '../jobs/live-feeds';
import type { UserView } from './user-datasource';
import { samePredicates } from './user-filter-model';
import {
  USER_GRID_ID,
  UserSelectionProvider,
  userSelectionTab,
} from './user-selection';
import {
  attributeColumns,
  categoryFailureText,
  categoryNeedsConnection,
  type UserAttributeColumn,
} from './user-fields';
import { UserRowRefresh } from './user-row-refresh';
import {
  DOMAIN_REFRESHED_TEXT,
  NOTHING_SELECTED_TEXT,
  SELECTION_EXPIRED_TEXT,
  SELECTION_TOO_LARGE_TEXT,
  domainFailureText,
  refreshAlreadyReadingText,
  refreshStartFailureText,
  refreshStartedText,
} from './user-refresh-messages';

export function usersReadable(auth: InstanceType<typeof AuthStore>): boolean {
  return (
    auth.metadata()?.phase === 3 &&
    !!auth
      .session()
      ?.identity.grants.some((grant) => grant.action === 'users:read')
  );
}

/** Whether the session holds the User Schema Manage permission (U4). */
export function usersSchemaManageable(
  auth: InstanceType<typeof AuthStore>,
): boolean {
  return (
    auth.metadata()?.phase === 3 &&
    !!auth
      .session()
      ?.identity.grants.some((grant) => grant.action === 'users:schema-manage')
  );
}

const defaultView = (): UserView => ({
  predicates: [],
  sort: { field: 'fullName', direction: 'asc' },
  selection: null,
});

/** The row that opened the details: its place in the filtered order and the grid offset. */
export interface UserRowAnchor {
  index: number;
  userId: string;
  scrollTop: number | null;
}

/**
 * The answer of one details read (A section 11). A missing record is a 404 and nothing
 * else. Denied, failed, offline, and unreadable answers stay apart, so the page never
 * reports a failed read as a missing user (R5). `stale` marks an answer of an earlier
 * person, which no caller may show (R1).
 */
export type UserRead =
  | { kind: 'user'; user: UserDetail }
  | { kind: 'missing' }
  | { kind: 'denied' }
  | { kind: 'offline' }
  | { kind: 'failed' }
  | { kind: 'stale' };

/** Only the outermost query reports counts. */
const countsKey = (view: UserView): string =>
  JSON.stringify([view.predicates, view.selection]);

/** The completion time of a sync observation, for ordering two answers. */
function completionTime(state: UserSyncState): number | null {
  const value = state.checkedAt ?? state.observedAt;
  return value ? Date.parse(value) : null;
}

/** When the run of a sync answer started, or null for a directory that never ran one. */
function runStarted(state: UserSyncState): number | null {
  return state.startedAt ? Date.parse(state.startedAt) : null;
}

/** The moment that the answer describes: the run start while it runs, its completion after. */
function syncMoment(state: UserSyncState): number | null {
  if (state.status === 'running') return runStarted(state);
  return completionTime(state) ?? runStarted(state);
}

/**
 * Whether `answer` describes an older moment than `current`. A later connection
 * generation outranks an earlier one. Distinct runs of one generation are ordered
 * by their start, because a refresh keeps the connection generation. Within one
 * run, a completion or expiry outranks the running start that produced it, even
 * when the expired projection still carries the previous run's `checkedAt` (R2).
 * A state without a time never replaces a dated one (R2).
 */
function isOlderSync(answer: UserSyncState, current: UserSyncState): boolean {
  if (answer.customerId !== current.customerId) return false;
  if (answer.generation !== current.generation)
    return answer.generation < current.generation;
  const answerStart = runStarted(answer);
  const currentStart = runStarted(current);
  // Two observable runs: the later start is the newer run, and its answer wins.
  if (
    answerStart !== null &&
    currentStart !== null &&
    answerStart !== currentStart
  )
    return answerStart < currentStart;
  // One run: its terminal or expiry observation outranks its running start. The
  // production expired projection keeps the start of the expired run and the
  // `checkedAt` of the prior completion, so the moments alone place it earlier.
  if (
    answerStart !== null &&
    currentStart !== null &&
    answerStart === currentStart
  ) {
    if (answer.status !== 'running' && current.status === 'running')
      return false;
    if (answer.status === 'running' && current.status !== 'running')
      return true;
  }
  const answerMoment = syncMoment(answer);
  const currentMoment = syncMoment(current);
  if (answerMoment !== null && currentMoment !== null)
    return answerMoment < currentMoment;
  // A state without a time is older than a dated state.
  return answerMoment === null && currentMoment !== null;
}

/** The part of EventSource that the store uses. Tests supply a fake. */
export type UserEventSource = Pick<
  EventSource,
  'addEventListener' | 'close' | 'readyState'
>;

/**
 * The Users grid state: the directory status, one page of rows, the filters, the
 * selection, and the feed of `GET /api/events` (document A section 8).
 *
 * The store follows the users feed through `LiveFeeds`, so a visible tab holds one
 * connection for every store on the page.
 *
 * Every asynchronous answer carries the epoch of the person who started it. A reset
 * bumps the epoch, so an answer of an earlier person never publishes to the next
 * one (R1).
 */
@Injectable({ providedIn: 'root' })
export class UsersStore {
  private readonly auth = inject(AuthStore);
  private readonly feeds = inject(LiveFeeds);
  private readonly customer = inject(CustomerStore);
  private readonly connection = inject(ConnectionStore);

  readonly sync = signal<UserSyncState | null>(null);
  readonly readable = computed(() => usersReadable(this.auth));
  readonly syncLoaded = signal(false);
  /** The status read failed. The page offers a retry while this holds text. */
  readonly statusError = signal('');
  readonly statusRetryable = signal(false);
  readonly predicates = signal<UserPredicate[]>([]);
  readonly view = signal<UserView>(defaultView());
  readonly gridState = signal<GridState | null>(null);
  readonly selectedView = signal(false);
  /**
   * The row that the person opened: its index in the filtered order, its ID, and the
   * grid offset. Back to users returns to this row, page, and scroll (A section 4).
   */
  readonly position = signal<UserRowAnchor | null>(null);
  /**
   * The row that the details page shows while Next user walks the filtered order.
   * It starts at the opened row and never moves the return anchor (A section 4).
   */
  readonly cursor = signal<{ index: number; userId: string } | null>(null);
  /**
   * The grid shows a filter that the query cannot express, such as an empty BOOLEAN
   * set. No row matches, and the page offers filter recovery (R6).
   */
  readonly emptyFilter = signal(false);
  readonly page = signal<Pick<
    UserPage,
    'matching' | 'total' | 'observedAt'
  > | null>(null);
  readonly freshness = signal<UserFreshness | null>(null);
  readonly jobFailure = signal<DeviceSyncFailure | null>(null);
  readonly orgUnits = signal<readonly UserOrgUnit[]>([]);
  readonly categories = signal<UserAttributeCategories | null>(null);
  readonly attributes = computed<readonly UserAttributeColumn[]>(() =>
    attributeColumns(this.categories()?.categories ?? []),
  );
  readonly categoriesError = signal('');
  /** The Google connection page carries the fix for the category read. */
  readonly categoriesRecovery = signal(false);
  /** The category read has not answered yet, so the tab shows its loading state (UI-08). */
  readonly categoriesLoading = signal(true);
  /** Refresh reads the categories from Google now (B section 9). */
  readonly categoriesRefreshing = signal(false);
  /** The last category read failure, in the words of the tab (`categoryReadText`). */
  readonly categoriesFailure = signal<{
    status: number | undefined;
    failure: string | undefined;
  } | null>(null);
  readonly offline = signal(false);
  readonly error = signal('');
  readonly refreshing = computed(() => this.sync()?.status === 'running');
  readonly refreshPending = signal(false);
  readonly refreshStatus = signal('');
  /** Bumps when a full sync ends, a reconnect happens, or another person signs in. */
  readonly revision = signal(0);
  /** Bumps when the API says the selection ended. The grid re-resolves its rows. */
  readonly selectionRevision = signal(0);
  readonly rowRefresh = new UserRowRefresh();

  /** The filters and attributes that the selection provider reads. */
  readonly selection = new UserSelectionProvider(
    (path, body, owns) => this.call(path, body, owns),
    () => ({ predicates: this.predicates(), attributes: this.attributes() }),
  );
  readonly selectionTab = userSelectionTab();

  private feed: LiveFeedSubscription | null = null;
  private streamWanted = false;
  private streamOpened = false;
  private streamInterrupted = false;
  /** Bumps when another person signs in. Answers of the earlier person never publish. */
  private epoch = 0;
  private readonly requests = new Set<number>();
  private refreshSequence = 0;
  /** The newest category read owns the published answer (R3). */
  private categoryRead = 0;
  private identity: string | null = this.auth.session()?.identity.id ?? null;
  private away = false;
  private counted = countsKey(defaultView());
  private recounted: string | null = null;
  private freshnessFor: string | null = null;
  /**
   * The local empty result owns the counts and the freshness. This epoch makes a
   * pending row or freshness answer of the previous dataset obsolete (R6).
   */
  private emptyEpoch = 0;
  private emptySnapshot: {
    total: number;
    observedAt: string | null;
  } | null = null;
  private recountTimer: ReturnType<typeof setTimeout> | undefined;

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

  private owns(epoch: number): boolean {
    return epoch === this.epoch;
  }

  /** Another person signed in. Browsing state belongs to one person. */
  private reset(): void {
    this.epoch++;
    this.sync.set(null);
    this.syncLoaded.set(false);
    this.statusError.set('');
    this.statusRetryable.set(false);
    this.predicates.set([]);
    this.view.set(defaultView());
    this.gridState.set(null);
    this.selectedView.set(false);
    this.position.set(null);
    this.cursor.set(null);
    this.emptyFilter.set(false);
    this.emptyEpoch++;
    this.emptySnapshot = null;
    this.counted = countsKey(defaultView());
    this.recounted = null;
    this.freshnessFor = null;
    this.selection.reset();
    this.selectionRevision.update((value) => value + 1);
    this.page.set(null);
    this.freshness.set(null);
    this.jobFailure.set(null);
    this.orgUnits.set([]);
    this.categories.set(null);
    this.categoriesError.set('');
    this.categoriesRecovery.set(false);
    this.categoriesLoading.set(true);
    this.categoriesRefreshing.set(false);
    this.categoriesFailure.set(null);
    this.offline.set(false);
    this.error.set('');
    this.refreshStatus.set('');
    this.requests.clear();
    this.refreshPending.set(false);
    this.refreshSequence++;
    this.streamInterrupted = false;
    clearTimeout(this.recountTimer);
    this.recountTimer = undefined;
    this.revision.update((value) => value + 1);
    this.feed?.close();
    this.feed = null;
    if (this.streamWanted) void this.connect();
  }

  /** One request. Only the person who started it may change the offline state. */
  private async call(
    path: string,
    body?: unknown,
    owns: () => boolean = () => true,
  ): Promise<Response | null> {
    try {
      const response = await this.auth.request(path, body);
      if (owns()) this.offline.set(false);
      return response;
    } catch {
      if (owns()) this.offline.set(true);
      return null;
    }
  }

  /** Users mounted: read the status and the categories, then follow the users feed. */
  async init(): Promise<void> {
    this.streamWanted = true;
    await Promise.all([
      this.connect(),
      this.loadCategories(),
      this.loadOrgUnits(),
    ]);
  }

  /** Users left: close the subscription and drop pending timers. */
  leave(): void {
    this.streamWanted = false;
    this.feed?.close();
    this.feed = null;
    this.refreshSequence++;
    this.refreshStatus.set('');
    clearTimeout(this.recountTimer);
  }

  /** The same person resumed an interrupted session. A stream that a 401 stopped opens again. */
  private resume(): void {
    this.revision.update((value) => value + 1);
    if (!this.streamWanted) return;
    if (this.feed) this.feed.resume();
    else void this.connect();
  }

  /** Read the status, then follow the users feed when this caller may read users. */
  private async connect(): Promise<void> {
    const epoch = this.epoch;
    const result = await this.readSync(epoch);
    if (!this.owns(epoch) || !this.streamWanted) return;
    if (result === 'denied' || (result === 'read' && !this.sync())) {
      this.closeFeed();
      return;
    }
    // A failed read may still recover from a full-sync event, so the feed opens too.
    this.follow(epoch);
  }

  private closeFeed(): void {
    this.feed?.close();
    this.feed = null;
  }

  /** Subscribes to the tab's one connection. Other stores keep it while this store follows. */
  private follow(epoch: number): void {
    if (this.feed) return;
    this.streamOpened = false;
    this.streamInterrupted = false;
    const owns = () => this.owns(epoch);
    this.feed = this.feeds.subscribe('/api/events', {
      open: () => this.eventSource('/api/events'),
      events: [
        'entity-batch',
        'job-finished',
        'user-full-sync',
        'schema-change',
      ],
      opened: (replaced) => {
        if (owns()) void this.onStreamOpen(replaced);
      },
      changed: (data) => {
        if (owns()) this.onEvent(data);
      },
      closed: () => {
        if (owns()) this.streamInterrupted = true;
      },
    });
  }

  /** The browser's EventSource. A test replaces this method. */
  protected eventSource(url: string): UserEventSource {
    return new EventSource(url);
  }

  async loadSync(): Promise<boolean> {
    const epoch = this.epoch;
    return (await this.readSync(epoch)) === 'read' && this.owns(epoch);
  }

  private failStatus(text: string, retryable: boolean): void {
    this.statusError.set(text);
    this.statusRetryable.set(retryable);
  }

  private clearStatus(): void {
    if (!this.statusError()) return;
    this.statusError.set('');
    this.statusRetryable.set(false);
  }

  private async readSync(epoch: number): Promise<'read' | 'denied' | 'failed'> {
    const owns = () => this.owns(epoch);
    const response = await this.call('/api/users/sync', undefined, owns);
    if (!this.owns(epoch)) return 'failed';
    if (!response) {
      this.failStatus('User directory status is unavailable.', true);
      return 'failed';
    }
    if (!response.ok) {
      if (response.status === 403) {
        this.failStatus(
          'You do not have permission to read users for this customer.',
          false,
        );
        return 'denied';
      }
      this.failStatus('User directory status is unavailable.', true);
      return response.status === 401 ? 'denied' : 'failed';
    }
    let answer: UserSyncState | null;
    try {
      answer = userSyncStateSchema
        .nullable()
        .parse((await response.json()).sync);
    } catch {
      if (this.owns(epoch))
        this.failStatus('User directory status is unavailable.', true);
      return 'failed';
    }
    if (!this.owns(epoch)) return 'failed';
    this.setSync(answer);
    this.syncLoaded.set(true);
    this.clearStatus();
    return 'read';
  }

  /** A status answer never replaces a newer observation of the same generation (R2). */
  private setSync(answer: UserSyncState | null): void {
    if (!answer) return;
    const current = this.sync();
    if (current && isOlderSync(answer, current)) return;
    this.sync.set(answer);
  }

  /** Refresh Users: start a full user sync. The feed reports its end. */
  async refreshAll(): Promise<void> {
    const epoch = this.epoch;
    const attempt = this.beginRefresh();
    try {
      const response = await this.call('/api/users/sync', {}, () =>
        this.owns(epoch),
      );
      if (!this.owns(epoch) || !attempt.current() || !response) return;
      const body = await response.json().catch(() => null);
      if (!this.owns(epoch) || !attempt.current()) return;
      if (response.status === 409 && body?.reason === 'user-sync-running') {
        await this.loadSync();
      } else if (!response.ok) {
        this.error.set(refreshStartFailureText(body?.reason));
      } else {
        const started = userSyncStateSchema.safeParse(body?.sync);
        if (!started.success) {
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

  /** Refresh Selected: read the selected users from Google again. */
  async refreshSelection(): Promise<void> {
    const epoch = this.epoch;
    const attempt = this.beginRefresh();
    try {
      const response = await this.call(
        '/api/users/selection/refresh',
        {
          gridId: USER_GRID_ID,
          tabId: this.selectionTab,
        },
        () => this.owns(epoch),
      );
      if (!this.owns(epoch) || !attempt.current() || !response) return;
      const body = await response.json().catch(() => null);
      if (!this.owns(epoch) || !attempt.current()) return;
      if (response.ok) {
        const refresh = userSelectionRefreshSchema.safeParse(body?.refresh);
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
      if (response.status === 401) return;
      if (response.status === 409 && body?.reason === 'selection-expired') {
        // A section 11: an expired selection shows as empty (R10).
        this.selectionEnded();
        this.refreshStatus.set(SELECTION_EXPIRED_TEXT);
      } else if (
        response.status === 422 &&
        body?.reason === 'nothing-selected'
      ) {
        this.selectionEnded();
        this.refreshStatus.set(NOTHING_SELECTED_TEXT);
      } else if (
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

  /** The selection ended at the API. Show it empty and re-resolve the held rows. */
  private selectionEnded(): void {
    this.selection.clear();
    this.selectionRevision.update((value) => value + 1);
  }

  /** Refresh Domain: start the full sync, then read the domain details again. */
  async refreshDomain(): Promise<void> {
    const epoch = this.epoch;
    const attempt = this.beginRefresh();
    try {
      const response = await this.call('/api/users/domain/refresh', {}, () =>
        this.owns(epoch),
      );
      if (!this.owns(epoch) || !attempt.current() || !response) return;
      const body = await response.json().catch(() => null);
      if (!this.owns(epoch) || !attempt.current()) return;
      if (response.status === 409 && body?.reason === 'user-sync-running') {
        await this.loadSync();
        return;
      }
      if (!response.ok) {
        if (response.status === 401) return;
        this.error.set(refreshStartFailureText(body?.reason));
        return;
      }
      const answer = userDomainRefreshSchema.safeParse(body?.refresh);
      if (!answer.success) {
        this.error.set('The refresh could not start.');
        return;
      }
      this.error.set('');
      this.setSync(answer.data.sync);
      if (answer.data.domain.status === 'refreshed') {
        this.refreshStatus.set(DOMAIN_REFRESHED_TEXT);
        void this.customer.refresh();
        void this.connection.refresh();
      } else {
        this.refreshStatus.set(domainFailureText(answer.data.domain.reason));
      }
    } finally {
      attempt.end();
    }
  }

  private beginRefresh(): { current: () => boolean; end: () => void } {
    const sequence = ++this.refreshSequence;
    this.refreshStatus.set('');
    this.refreshPending.set(true);
    this.requests.add(sequence);
    return {
      current: () => sequence === this.refreshSequence,
      end: () => {
        this.requests.delete(sequence);
        this.refreshPending.set(this.requests.size > 0);
      },
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

  async rows(offset: number, limit: number): Promise<UserPage | null> {
    const epoch = this.epoch;
    const view = this.view();
    const revision = this.revision();
    const emptyEpoch = this.emptyEpoch;
    const response = await this.call(
      '/api/users/query',
      {
        ...view,
        offset,
        limit,
      },
      () => this.owns(epoch),
    );
    if (!this.owns(epoch) || !response?.ok) return null;
    const page = userPageSchema.parse((await response.json()).page);
    if (!this.owns(epoch)) return null;
    // An answer that a local empty result or a newer query replaced keeps no count.
    if (emptyEpoch !== this.emptyEpoch || this.emptyFilter()) return page;
    if (page.refreshJobId) {
      this.jobFailure.set(null);
      this.scheduleRecount();
    }
    this.keepCounts(view, revision, page);
    return page;
  }

  /** The next row of the current filtered order, for Next user (A section 4). */
  async neighbor(index: number): Promise<UserRow | null> {
    if (index < 0) return null;
    return (await this.rows(index, 1))?.rows[0] ?? null;
  }

  /**
   * One user for the details page (A section 9). A missing user is a 404 and nothing
   * else: a denied, failed, offline, or unreadable answer is its own result (R5). The
   * answer of an earlier person never leaves the store, even when its body arrives
   * after the change (R1).
   */
  async user(id: string): Promise<UserRead> {
    const epoch = this.epoch;
    const response = await this.call(
      `/api/users/${encodeURIComponent(id)}`,
      undefined,
      () => this.owns(epoch),
    );
    if (!this.owns(epoch)) return { kind: 'stale' };
    if (!response) return { kind: 'offline' };
    if (response.status === 404) return { kind: 'missing' };
    if (response.status === 401 || response.status === 403)
      return { kind: 'denied' };
    if (!response.ok) return { kind: 'failed' };
    let user: UserDetail;
    try {
      user = userDetailSchema.parse((await response.json()).user);
    } catch {
      return { kind: 'failed' };
    }
    // The body can arrive after another person signed in. It belongs to nobody then.
    if (!this.owns(epoch)) return { kind: 'stale' };
    return { kind: 'user', user };
  }

  /** A response for a query that changed meanwhile must not replace the counts. */
  private keepCounts(
    view: UserView,
    revision: number,
    counts: Omit<UserPage, 'rows' | 'refreshJobId'>,
  ): void {
    const key = countsKey(view);
    if (key !== this.counted || revision !== this.revision()) return;
    this.page.set({
      matching: counts.matching,
      total: counts.total,
      observedAt: counts.observedAt,
    });
    // New counts mean a new result set. Its stale count follows once per query and revision.
    const token = `${key}#${revision}`;
    if (token === this.recounted) return;
    this.recounted = token;
    this.scheduleRecount(0);
  }

  /** Count the stale users of the counted query and learn whether a refresh job runs (D11). */
  async recount(): Promise<void> {
    // The local empty result owns its counts and its freshness. It queries nothing (R6).
    if (this.emptyFilter()) return;
    const epoch = this.epoch;
    const counted = this.counted;
    const emptyEpoch = this.emptyEpoch;
    const view = this.view();
    const response = await this.call(
      '/api/users/freshness',
      {
        predicates: view.predicates,
        selection: view.selection,
      },
      () => this.owns(epoch),
    );
    let freshness: UserFreshness | null = null;
    try {
      if (response?.ok)
        freshness = userFreshnessSchema.parse(
          (await response.json()).freshness,
        );
    } catch {
      // An unreadable count counts as a failed count.
    }
    if (
      !this.owns(epoch) ||
      counted !== this.counted ||
      emptyEpoch !== this.emptyEpoch ||
      this.emptyFilter()
    )
      return;
    if (freshness) {
      this.freshness.set(freshness);
      this.freshnessFor = counted;
    } else if (this.freshnessFor !== counted) {
      this.freshness.set(null);
    }
  }

  private scheduleRecount(delay = this.recountDelay): void {
    clearTimeout(this.recountTimer);
    this.recountTimer = setTimeout(() => void this.recount(), delay);
  }

  /** Milliseconds after a query answer before its stale count is read. */
  recountDelay = 0;

  /**
   * A connection opened. A first open after a fresh status read is current. Any
   * open that can have missed a completion reconciles: a later open, a replacement
   * connection, an interrupted first connection, or a first open while a sync runs (R3).
   */
  private async onStreamOpen(replaced: boolean): Promise<void> {
    const first = !this.streamOpened;
    this.streamOpened = true;
    const interrupted = this.streamInterrupted;
    this.streamInterrupted = false;
    if (!first) {
      // A gap can hide a schema change. The list reads again before the reconcile (K16).
      void this.loadCategories();
      await this.reconcile();
      return;
    }
    if (!replaced && !interrupted && this.sync()?.status !== 'running') return;
    void this.loadCategories();
    await this.reconcile();
  }

  private async reconcile(): Promise<void> {
    const epoch = this.epoch;
    const before = this.sync();
    const read = await this.loadSync();
    if (!this.owns(epoch) || !read) return;
    const after = this.sync();
    const ended =
      (before?.status === 'running' && after?.status !== 'running') ||
      before?.observedAt !== after?.observedAt;
    if (ended) {
      this.revision.update((value) => value + 1);
      return;
    }
    await this.refreshRows('all');
    if (!this.owns(epoch)) return;
    await this.recount();
  }

  private onEvent(data: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const result = userStreamEventSchema.safeParse(parsed);
    if (!result.success) return;
    const event = result.data;
    if (event.type === 'entity-batch') {
      // A removed user is not an updated user. The by-ids answer can repeat the
      // retained record, so a removal requeries the rows and the counts (R7).
      if (event.removedIds.length) this.revision.update((value) => value + 1);
      if (event.userIds.length) void this.refreshRows(event.userIds);
      this.scheduleRecount();
    } else if (event.type === 'job-finished') {
      if (event.failure) this.jobFailure.set(event.failure);
      this.scheduleRecount();
    } else if (event.type === 'schema-change') {
      // A category job changed the schema list. The held rows read the new query
      // generation, and the tab reads the new categories and their limit counts (R6).
      this.revision.update((value) => value + 1);
      void this.loadCategories();
    } else {
      this.setSync(event.sync);
      if (event.sync.status !== 'running')
        this.revision.update((value) => value + 1);
    }
  }

  /** Refetch the held rows among `ids`, or every held row (D7). */
  private async refreshRows(ids: readonly string[] | 'all'): Promise<void> {
    const epoch = this.epoch;
    const wanted = new Set(ids === 'all' ? [] : ids);
    const held = this.rowRefresh.held((row) =>
      ids === 'all' ? true : wanted.has(row.userId),
    );
    if (!held.length) return;
    // An answer belongs to the grid that asked. A replacement grid ignores it.
    const attachment = this.rowRefresh.current();
    for (let start = 0; start < held.length; start += USER_BY_IDS_LIMIT) {
      const response = await this.call(
        '/api/users/by-ids',
        {
          userIds: held.slice(start, start + USER_BY_IDS_LIMIT),
        },
        () => this.owns(epoch),
      );
      if (!this.owns(epoch) || !response?.ok) return;
      const rows = z.array(userRowSchema).parse((await response.json()).rows);
      if (!this.owns(epoch)) return;
      this.rowRefresh.apply(rows, attachment);
    }
  }

  async loadCategories(): Promise<void> {
    await this.readCategories('/api/users/attribute-categories', undefined);
  }

  /**
   * Refresh on the Custom attributes tab: read `schemas.list` now (B section 9). A failure
   * keeps the categories that the cache holds, so the list stays usable (UI-08).
   */
  async refreshCategories(): Promise<void> {
    if (this.categoriesRefreshing()) return;
    await this.readCategories(
      '/api/users/attribute-categories/refresh',
      {},
      true,
    );
  }

  /**
   * The cache-aware read of B section 9, and the forced read of Refresh. One request owns
   * the published answer: a late answer of an older read never replaces a newer set, never
   * restores a failure that a newer answer cleared, and never clears another read's busy
   * state (R3). The principal epoch still fences every answer (R1).
   */
  private async readCategories(
    path: string,
    body: unknown,
    refresh = false,
  ): Promise<void> {
    const epoch = this.epoch;
    const read = ++this.categoryRead;
    const current = () => this.owns(epoch) && read === this.categoryRead;
    if (refresh) this.categoriesRefreshing.set(true);
    try {
      const response = await this.call(path, body, current);
      if (!current()) return;
      if (!response?.ok) {
        const failure = await this.categoryFailureOf(response);
        if (!current()) return;
        this.publishCategoryFailure(response?.status, failure, refresh);
        return;
      }
      let categories: UserAttributeCategories;
      try {
        categories = userAttributeCategoriesSchema.parse(await response.json());
      } catch {
        if (!current()) return;
        this.publishCategoryFailure(undefined, undefined, refresh);
        return;
      }
      if (!current()) return;
      this.categories.set(categories);
      this.categoriesError.set('');
      this.categoriesRecovery.set(false);
      this.categoriesFailure.set(null);
    } finally {
      // The newest read owns the busy state, also when it superseded a Refresh.
      if (current()) {
        this.categoriesLoading.set(false);
        this.categoriesRefreshing.set(false);
      }
    }
  }

  /** The API failure code of a category answer, when the body holds one. */
  private async categoryFailureOf(
    response: Response | null,
  ): Promise<string | undefined> {
    const body = (await response?.json().catch(() => null)) as {
      failure?: unknown;
    } | null;
    return typeof body?.failure === 'string' ? body.failure : undefined;
  }

  /** Record a category failure. A Refresh keeps the cached list and its error line (UI-08). */
  private publishCategoryFailure(
    status: number | undefined,
    failure: string | undefined,
    refresh: boolean,
  ): void {
    if (!refresh)
      this.categoriesError.set(categoryFailureText(status, failure));
    this.categoriesRecovery.set(categoryNeedsConnection(status, failure));
    this.categoriesFailure.set({ status, failure });
  }

  async loadOrgUnits(): Promise<void> {
    const epoch = this.epoch;
    const response = await this.call('/api/users/org-units', undefined, () =>
      this.owns(epoch),
    );
    if (!this.owns(epoch) || !response?.ok) return;
    const units = userOrgUnitsSchema.parse((await response.json()).orgUnits);
    if (!this.owns(epoch)) return;
    this.orgUnits.set(units);
  }

  /** Chips and column filters both land here. The grid applies them and reloads itself. */
  setPredicates(predicates: UserPredicate[]): void {
    if (samePredicates(predicates, this.predicates(), this.attributes()))
      return;
    this.predicates.set(predicates);
    // A new query holds a new order, so Next user and Back to users forget the opened row.
    this.position.set(null);
    this.cursor.set(null);
  }

  /**
   * Clear every filter, including a column filter that no query can express. A new
   * array makes the grid drop its own filter model as well (R6).
   */
  clearFilters(): void {
    this.setEmptyFilter(false);
    this.predicates.set([]);
  }

  /**
   * The grid holds a filter that no query can express, so the grid itself shows the
   * empty result. The counts follow that result: no row matches, and the district
   * total stays (R6).
   */
  setEmptyFilter(empty: boolean): void {
    if (empty === this.emptyFilter()) {
      // A repeated notification keeps the empty result in place (R6).
      if (empty) this.publishEmptyCounts();
      return;
    }
    this.emptyFilter.set(empty);
    // The local empty result replaces the counted dataset until it ends.
    this.emptyEpoch++;
    clearTimeout(this.recountTimer);
    this.recountTimer = undefined;
    this.recounted = null;
    this.freshnessFor = null;
    if (!empty) {
      // The next query publishes the recovered counts and freshness.
      this.emptySnapshot = null;
      return;
    }
    const page = this.page();
    this.emptySnapshot = {
      total: page?.total ?? this.sync()?.userCount ?? 0,
      observedAt: page?.observedAt ?? this.sync()?.observedAt ?? null,
    };
    this.publishEmptyCounts();
  }

  /** The local empty result keeps zero matches and the district total (R6). */
  private publishEmptyCounts(): void {
    const snapshot = this.emptySnapshot;
    this.page.set({
      matching: 0,
      total: snapshot?.total ?? 0,
      observedAt: snapshot?.observedAt ?? null,
    });
    this.freshness.set(null);
  }

  /** The grid reports each query it runs. */
  setView(view: UserView): void {
    if (JSON.stringify(view) === JSON.stringify(this.view())) return;
    this.view.set(view);
    // A different query holds a different order, so Next user and Back to users forget it.
    this.position.set(null);
    this.cursor.set(null);
    const key = countsKey(view);
    if (key === this.counted) return;
    this.counted = key;
  }

  /** The selection count of the status bar. */
  readonly selectedCount = computed(
    () => this.selection.spec()?.selectedCount ?? 0,
  );
}

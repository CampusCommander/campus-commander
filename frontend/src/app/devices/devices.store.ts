import {
  Injectable,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import {
  deviceDetailSchema,
  deviceOrgUnitsSchema,
  devicePageSchema,
  deviceSyncStateSchema,
  type DeviceDetail,
  type DeviceOrgUnit,
  type DevicePage,
  type DevicePredicate,
  type DeviceRow,
  type DeviceSyncState,
} from '@campus/application-contracts';
import type { GridState } from 'ag-grid-community';
import { AuthStore } from '../auth.store';
import type { DeviceView } from './device-datasource';
import { samePredicates } from './device-filter-model';
import {
  DeviceSelectionProvider,
  deviceSelectionTab,
} from './device-selection';

export type OptionalDeviceColumn = 'annotatedLocation' | 'notes';

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

/** Browsing state survives navigation between the grid and device details. */
@Injectable({ providedIn: 'root' })
export class DevicesStore {
  private readonly auth = inject(AuthStore);
  /** Milliseconds between sync status checks while a refresh runs. */
  pollInterval = 2000;
  readonly sync = signal<DeviceSyncState | null>(null);
  readonly syncLoaded = signal(false);
  readonly predicates = signal<DevicePredicate[]>([]);
  /** The query the grid last ran. Next device follows it. */
  readonly view = signal<DeviceView>(defaultView());
  /** Grid columns, filters, sort, and page, kept while device details are open. */
  readonly gridState = signal<GridState | null>(null);
  readonly selection = new DeviceSelectionProvider((path, body) =>
    this.call(path, body),
  );
  readonly selectionTab = deviceSelectionTab();
  readonly page = signal<Omit<DevicePage, 'rows'> | null>(null);
  readonly orgUnits = signal<DeviceOrgUnit[]>([]);
  readonly offline = signal(false);
  readonly error = signal('');
  /** Increments when the grid must reload from the first block. */
  readonly revision = signal(0);
  /** Row index and ID of the last opened device in the current filtered order. */
  readonly position = signal<{ index: number; deviceId: string } | null>(null);
  readonly optionalColumns = signal<Record<OptionalDeviceColumn, boolean>>({
    annotatedLocation: false,
    notes: false,
  });
  readonly refreshing = computed(() => this.sync()?.status === 'running');
  readonly readable = computed(() => devicesReadable(this.auth));
  private polling = false;
  /** Increments on sign-in by another person. A running poll stops when it changes. */
  private epoch = 0;
  private identity: string | null = null;

  constructor() {
    effect(() => {
      const identity = this.auth.session()?.identity.id ?? null;
      untracked(() => {
        if (identity === null) return;
        if (this.identity !== null && identity !== this.identity) this.reset();
        this.identity = identity;
      });
    });
  }

  /** Browsing state belongs to one person. Another sign-in starts clean. */
  private reset(): void {
    this.epoch++;
    this.sync.set(null);
    this.syncLoaded.set(false);
    this.predicates.set([]);
    this.view.set(defaultView());
    this.gridState.set(null);
    this.selection.spec.set(null);
    this.page.set(null);
    this.orgUnits.set([]);
    this.offline.set(false);
    this.error.set('');
    this.position.set(null);
    this.revision.update((value) => value + 1);
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

  async init(): Promise<void> {
    await this.loadSync();
    if (this.refreshing()) await this.poll();
  }

  /** Returns false when the status could not be read, so callers stop polling. */
  async loadSync(): Promise<boolean> {
    const response = await this.call('/api/devices/sync');
    if (!response) return false;
    if (!response.ok) {
      this.error.set('Device inventory status is unavailable.');
      return false;
    }
    this.error.set('');
    this.sync.set(
      deviceSyncStateSchema.nullable().parse((await response.json()).sync),
    );
    this.syncLoaded.set(true);
    return true;
  }

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
      return;
    } else {
      this.error.set('');
      this.sync.set(deviceSyncStateSchema.parse(body.sync));
    }
    await this.poll();
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    const epoch = this.epoch;
    try {
      while (this.sync()?.status === 'running') {
        await new Promise((resolve) => setTimeout(resolve, this.pollInterval));
        if (epoch !== this.epoch || !(await this.loadSync())) return;
      }
      if (epoch === this.epoch) this.revision.update((value) => value + 1);
    } finally {
      this.polling = false;
    }
  }

  async reconnect(): Promise<void> {
    if (!(await this.loadSync())) return;
    if (this.refreshing()) await this.poll();
    else this.revision.update((value) => value + 1);
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
    // A response for a query that changed meanwhile must not replace the counts.
    if (view !== this.view() || revision !== this.revision()) return page;
    this.page.set({
      matching: page.matching,
      total: page.total,
      observedAt: page.observedAt,
    });
    return page;
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
  }
}

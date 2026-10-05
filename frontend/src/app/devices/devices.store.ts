import { Injectable, computed, inject, signal } from '@angular/core';
import {
  deviceDetailSchema,
  deviceOrgUnitsSchema,
  devicePageSchema,
  deviceSyncStateSchema,
  type DeviceDetail,
  type DeviceOrgUnit,
  type DevicePage,
  type DevicePredicate,
  type DeviceQuery,
  type DeviceRow,
  type DeviceSyncState,
} from '@campus/application-contracts';
import { AuthStore } from '../auth.store';

export type OptionalDeviceColumn = 'annotatedLocation' | 'notes';

export function devicesReadable(auth: InstanceType<typeof AuthStore>): boolean {
  return (
    auth.metadata()?.phase === 3 &&
    !!auth
      .session()
      ?.identity.grants.some((grant) => grant.action === 'devices:read')
  );
}

/** Browsing state survives navigation between the grid and device details. */
@Injectable({ providedIn: 'root' })
export class DevicesStore {
  private readonly auth = inject(AuthStore);
  /** Milliseconds between sync status checks while a refresh runs. */
  pollInterval = 2000;
  readonly sync = signal<DeviceSyncState | null>(null);
  readonly syncLoaded = signal(false);
  readonly predicates = signal<DevicePredicate[]>([]);
  readonly sort = signal<DeviceQuery['sort']>({
    field: 'serialNumber',
    direction: 'asc',
  });
  readonly page = signal<Omit<DevicePage, 'rows'> | null>(null);
  readonly orgUnits = signal<DeviceOrgUnit[]>([]);
  readonly offline = signal(false);
  readonly error = signal('');
  /** Increments when the grid must reload from the first block. */
  readonly revision = signal(0);
  /** Row index of the last opened device in the current filtered order. */
  readonly position = signal<number | null>(null);
  readonly optionalColumns = signal<Record<OptionalDeviceColumn, boolean>>({
    annotatedLocation: false,
    notes: false,
  });
  readonly refreshing = computed(() => this.sync()?.status === 'running');
  readonly readable = computed(() => devicesReadable(this.auth));
  private polling = false;

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

  async loadSync(): Promise<void> {
    const response = await this.call('/api/devices/sync');
    if (!response) return;
    if (!response.ok) {
      this.error.set('Device inventory status is unavailable.');
      return;
    }
    this.error.set('');
    this.sync.set(
      deviceSyncStateSchema.nullable().parse((await response.json()).sync),
    );
    this.syncLoaded.set(true);
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
    try {
      while (this.sync()?.status === 'running') {
        await new Promise((resolve) => setTimeout(resolve, this.pollInterval));
        await this.loadSync();
        if (this.offline()) return;
      }
      this.revision.update((value) => value + 1);
    } finally {
      this.polling = false;
    }
  }

  async reconnect(): Promise<void> {
    await this.loadSync();
    if (!this.offline()) this.revision.update((value) => value + 1);
  }

  async rows(offset: number, limit: number): Promise<DevicePage | null> {
    const response = await this.call('/api/devices/query', {
      predicates: this.predicates(),
      sort: this.sort(),
      offset,
      limit,
    });
    if (!response?.ok) return null;
    const page = devicePageSchema.parse((await response.json()).page);
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

  setPredicates(predicates: DevicePredicate[]): void {
    this.predicates.set(predicates);
    this.position.set(null);
    this.revision.update((value) => value + 1);
  }

  /** The grid calls this when a header sort changes. The grid reloads itself. */
  setSort(sort: DeviceQuery['sort']): void {
    const current = this.sort();
    if (current.field === sort.field && current.direction === sort.direction)
      return;
    this.sort.set(sort);
    this.position.set(null);
  }
}

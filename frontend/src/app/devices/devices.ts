import {
  Component,
  OnInit,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatMenuModule } from '@angular/material/menu';
import type { DevicePredicate, DeviceRow } from '@campus/application-contracts';
import { DevicesStore, type OptionalDeviceColumn } from './devices.store';
import { DeviceGrid, type DeviceRange } from './device-grid';
import { DeviceFilter } from './device-filter';
import type { DeviceSort } from './device-datasource';
import {
  chipLabel,
  syncFailureText,
  telemetryFailureText,
} from './device-fields';

@Component({
  selector: 'app-devices',
  imports: [
    DatePipe,
    RouterLink,
    MatButtonModule,
    MatMenuModule,
    DeviceGrid,
    DeviceFilter,
  ],
  templateUrl: './devices.html',
  styleUrl: './devices.css',
})
export class DevicesPage implements OnInit {
  protected readonly store = inject(DevicesStore);
  private readonly router = inject(Router);
  protected readonly sync = this.store.sync;
  protected readonly range = signal<DeviceRange | null>(null);
  protected readonly editingIndex = signal<number | null>(null);
  protected readonly editing = computed(() => {
    const index = this.editingIndex();
    return index === null ? null : (this.store.predicates()[index] ?? null);
  });
  protected readonly published = computed(() => !!this.sync()?.observedAt);
  protected readonly noMatches = computed(
    () =>
      this.store.page()?.matching === 0 && this.store.predicates().length > 0,
  );
  protected readonly emptyInventory = computed(
    () =>
      this.store.page()?.total === 0 && this.store.predicates().length === 0,
  );
  protected readonly failureText = computed(() =>
    syncFailureText(this.sync()?.failure ?? null),
  );
  protected readonly telemetryText = computed(() =>
    telemetryFailureText(this.sync()?.telemetryFailure ?? null),
  );
  protected readonly label = chipLabel;
  protected readonly load = (
    offset: number,
    limit: number,
    sort: DeviceSort,
  ) => {
    this.store.setSort(sort);
    return this.store.rows(offset, limit);
  };

  constructor() {
    effect(() => {
      this.store.revision();
      untracked(() => void this.store.loadOrgUnits());
    });
  }

  ngOnInit(): void {
    void this.store.init();
  }

  protected count(value: number): string {
    return value.toLocaleString('en-US');
  }

  protected refresh(): void {
    void this.store.refreshAll();
  }

  protected reconnect(): void {
    void this.store.reconnect();
  }

  protected apply(predicate: DevicePredicate): void {
    const index = this.editingIndex();
    const predicates = [...this.store.predicates()];
    if (index === null) predicates.push(predicate);
    else predicates[index] = predicate;
    this.editingIndex.set(null);
    this.store.setPredicates(predicates);
  }

  protected remove(index: number): void {
    this.store.setPredicates(
      this.store.predicates().filter((_, position) => position !== index),
    );
  }

  protected clear(): void {
    this.store.setPredicates([]);
  }

  protected toggleColumn(column: OptionalDeviceColumn): void {
    this.store.optionalColumns.update((columns) => ({
      ...columns,
      [column]: !columns[column],
    }));
  }

  protected open(event: { row: DeviceRow; index: number }): void {
    this.store.position.set(event.index);
    void this.router.navigate(['/devices', event.row.deviceId]);
  }
}

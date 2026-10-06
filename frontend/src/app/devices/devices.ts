import {
  Component,
  ElementRef,
  Injector,
  OnInit,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChildren,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatMenuModule } from '@angular/material/menu';
import type { DevicePredicate, DeviceRow } from '@campus/application-contracts';
import { DevicesStore } from './devices.store';
import { DeviceGrid } from './device-grid';
import { DeviceFilter } from './device-filter';
import type { DeviceView } from './device-datasource';
import type { GridState } from 'ag-grid-community';
import {
  chipLabel,
  syncFailureText,
  telemetryFailureText,
} from './device-fields';

@Component({
  selector: 'app-devices',
  imports: [
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
  private readonly injector = inject(Injector);
  private readonly chips = viewChildren<ElementRef<HTMLButtonElement>>('chip');
  protected readonly sync = this.store.sync;
  protected readonly editingIndex = signal<number | null>(null);
  protected readonly editing = computed(() => {
    const index = this.editingIndex();
    return index === null ? null : (this.store.predicates()[index] ?? null);
  });
  protected readonly published = computed(() => !!this.sync()?.observedAt);
  protected readonly noMatches = computed(
    () =>
      this.store.page()?.matching === 0 &&
      this.store.predicates().length > 0 &&
      // Show All Selected keeps the grid, so its footer can return to all records.
      !this.store.view().selection,
  );
  protected readonly selection = {
    provider: this.store.selection,
    tabId: this.store.selectionTab,
  };
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
    view: DeviceView,
  ) => {
    this.store.setView(view);
    return this.store.rows(offset, limit);
  };
  protected readonly loadGroups = (view: DeviceView) => {
    this.store.setView(view);
    return this.store.groups(view);
  };
  /** A grouped grid cannot scroll back to a row inside a closed group. */
  protected readonly grouped = computed(
    () => !!this.store.view().group?.by.length,
  );
  protected readonly saveState = (state: GridState, selectedView: boolean) => {
    this.store.gridState.set(state);
    this.store.selectedView.set(selectedView);
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

  protected refresh(): void {
    void this.store.refreshAll();
  }

  protected reconnect(): void {
    void this.store.reconnect();
  }

  /** One filter per field. A chip for a filtered field replaces that filter. */
  protected apply(predicate: DevicePredicate): void {
    const index = this.editingIndex();
    const current = this.store.predicates();
    const at =
      index !== null && index < current.length
        ? index
        : current.findIndex((item) => item.field === predicate.field);
    // The editor emits closed next. editorClosed() clears the index and restores focus.
    this.store.setPredicates(
      at === -1
        ? [...current, predicate]
        : current.map((item, position) => (position === at ? predicate : item)),
    );
  }

  protected remove(index: number): void {
    this.editingIndex.set(null);
    this.store.setPredicates(
      this.store.predicates().filter((_, position) => position !== index),
    );
  }

  protected clear(): void {
    this.editingIndex.set(null);
    this.store.setPredicates([]);
  }

  /** After a chip edit closes, focus returns to that chip (GRID-04). */
  protected editorClosed(): void {
    const index = this.editingIndex();
    this.editingIndex.set(null);
    if (index === null) return;
    afterNextRender(() => this.chips()[index]?.nativeElement.focus(), {
      injector: this.injector,
    });
  }

  protected open(event: {
    row: DeviceRow;
    index: number;
    route: string[] | null;
  }): void {
    // Next device follows the opened device's group.
    const view = this.store.view();
    if (event.route)
      this.store.view.set({
        ...view,
        group: { by: view.group?.by ?? [], keys: event.route },
      });
    this.store.position.set({
      index: event.index,
      deviceId: event.row.deviceId,
    });
    void this.router.navigate(['/devices', event.row.deviceId]);
  }
}

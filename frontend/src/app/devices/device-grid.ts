import {
  Component,
  OnInit,
  effect,
  input,
  output,
  untracked,
} from '@angular/core';
import { AgGridAngular } from 'ag-grid-angular';
import {
  AllCommunityModule,
  ModuleRegistry,
  themeQuartz,
  type GridApi,
  type GridOptions,
  type GridReadyEvent,
  type GridState,
} from 'ag-grid-community';
import { ServerSideRowModelModule } from '@libregrid/server-side-row-model';
import { SetFilterModule } from '@libregrid/set-filter';
import type {
  DeviceOrgUnit,
  DevicePage,
  DevicePredicate,
  DeviceRow,
} from '@campus/application-contracts';
import { detailsKeyHandler, deviceColumnDefs } from './device-columns';
import {
  defaultGridState,
  deviceDatasource,
  savedGridState,
  type DeviceLoader,
} from './device-datasource';
import {
  filterModelUpdate,
  predicatesFromFilterModel,
} from './device-filter-model';
import type { OptionalDeviceColumn } from './devices.store';

ModuleRegistry.registerModules([
  AllCommunityModule,
  ServerSideRowModelModule,
  SetFilterModule,
]);

export interface DeviceRange {
  first: number;
  last: number;
}

@Component({
  selector: 'app-device-grid',
  imports: [AgGridAngular],
  template: `
    <ag-grid-angular
      class="device-grid"
      [gridOptions]="options"
      (gridReady)="ready($event)"
      (modelUpdated)="updated()"
      (bodyScrollEnd)="emitRange()"
    />
  `,
  styles: `
    :host {
      display: block;
      height: 100%;
      min-height: calc(var(--cc-row-height-grid) * 8);
    }
    .device-grid {
      display: block;
      height: 100%;
    }
    :host ::ng-deep .device-code {
      font-family: 'Roboto Mono', monospace;
    }
    :host ::ng-deep .device-details-header .ag-header-cell-text {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0 0 0 0);
      white-space: nowrap;
    }
  `,
})
export class DeviceGrid implements OnInit {
  readonly load = input.required<DeviceLoader>();
  readonly revision = input(0);
  readonly optionalColumns = input<Record<OptionalDeviceColumn, boolean>>({
    annotatedLocation: false,
    notes: false,
  });
  /** Row to scroll into view after the first block loads, such as after Back to devices. */
  readonly focusIndex = input<number | null>(null);
  /** Saved grid state to open with, such as after Back to devices. */
  readonly state = input<GridState | null>(null);
  /** Receives the grid state when the grid closes. */
  readonly saveState = input<(state: GridState) => void>(() => undefined);
  /** The chips. The grid shows them as column filters. */
  readonly predicates = input<DevicePredicate[]>([]);
  /** Organization units for the OrgUnit set filter. */
  readonly orgUnits = input<readonly DeviceOrgUnit[]>([]);
  readonly filtersChange = output<DevicePredicate[]>();
  readonly details = output<{ row: DeviceRow; index: number }>();
  readonly rangeChange = output<DeviceRange | null>();

  private api: GridApi<DeviceRow> | null = null;
  private focused = false;
  protected options!: GridOptions<DeviceRow>;

  constructor() {
    effect(() => {
      this.revision();
      untracked(() => this.reload());
    });
    effect(() => {
      const columns = this.optionalColumns();
      untracked(() => this.applyColumns(columns));
    });
    effect(() => {
      const predicates = this.predicates();
      untracked(() => this.applyPredicates(predicates));
    });
  }

  ngOnInit(): void {
    const open = (row: DeviceRow, index: number) =>
      this.details.emit({ row, index });
    this.options = {
      theme: themeQuartz.withParams({
        accentColor: 'var(--cc-accent)',
        backgroundColor: 'var(--cc-surface-card)',
        headerBackgroundColor: 'var(--cc-surface-app)',
        borderColor: 'var(--cc-border)',
        foregroundColor: 'var(--cc-text-primary)',
      }),
      columnDefs: deviceColumnDefs(open, {
        orgUnits: () => this.orgUnits().map((unit) => unit.path),
      }),
      onCellKeyDown: detailsKeyHandler(open),
      initialState: this.state() ?? defaultGridState(),
      onFilterChanged: () => this.filtersChanged(),
      onGridPreDestroyed: ({ state }) =>
        this.saveState()(savedGridState(state)),
      getRowId: ({ data }) => data.deviceId,
      rowModelType: 'serverSide',
      cacheBlockSize: 100,
      maxBlocksInCache: 20,
    };
  }

  protected ready(event: GridReadyEvent<DeviceRow>): void {
    this.api = event.api;
    this.applyColumns(this.optionalColumns());
    this.applyPredicates(this.predicates());
    this.reload();
  }

  /** Setting a new datasource resets the server-side row model to its first block. */
  private reload(): void {
    this.api?.setGridOption(
      'serverSideDatasource',
      deviceDatasource(
        (offset, limit, view) => this.load()(offset, limit, view),
        (page) => this.restore(page),
      ),
    );
  }

  private applyColumns(columns: Record<OptionalDeviceColumn, boolean>): void {
    this.api?.setColumnsVisible(
      ['annotatedLocation'],
      columns.annotatedLocation,
    );
    this.api?.setColumnsVisible(['notes'], columns.notes);
  }

  private applyPredicates(predicates: readonly DevicePredicate[]): void {
    const api = this.api;
    const next = api && filterModelUpdate(api.getFilterModel(), predicates);
    if (next) api?.setFilterModel(next);
  }

  private filtersChanged(): void {
    const api = this.api;
    if (!api) return;
    try {
      this.filtersChange.emit(predicatesFromFilterModel(api.getFilterModel()));
    } catch {
      // The datasource fails the load for a model the query cannot express.
    }
  }

  /** Scroll the remembered row into view once the server reports enough rows. */
  private restore(page: DevicePage): void {
    const index = this.focusIndex();
    if (this.focused || index === null || page.matching <= index) return;
    this.focused = true;
    setTimeout(() => this.api?.ensureIndexVisible(index, 'middle'));
  }

  protected updated(): void {
    this.emitRange();
  }

  protected emitRange(): void {
    const api = this.api;
    if (!api) return;
    const first = api.getFirstDisplayedRowIndex();
    const last = api.getLastDisplayedRowIndex();
    this.rangeChange.emit(first >= 0 && last >= first ? { first, last } : null);
  }
}

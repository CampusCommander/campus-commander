import {
  ApplicationRef,
  Component,
  DestroyRef,
  EnvironmentInjector,
  Injector,
  OnInit,
  createComponent,
  effect,
  inject,
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
  type IRowNode,
} from 'ag-grid-community';
import { ServerSideRowModelModule } from '@libregrid/server-side-row-model';
import {
  ServerSideSelectionModule,
  type ServerSideSelectionProvider,
  type SsrmSelectionService,
} from '@libregrid/server-side-selection';
import { RowGroupingModule } from '@libregrid/row-grouping';
import { SetFilterModule } from '@libregrid/set-filter';
import { ColumnMenuModule } from '@libregrid/menu';
import { SideBarModule } from '@libregrid/side-bar';
import { ColumnsToolPanelModule } from '@libregrid/columns-tool-panel';
import { FiltersToolPanelModule } from '@libregrid/filters-tool-panel';
import { StatusBarModule } from '@libregrid/status-bar';
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
  type DeviceGroupLoader,
  type DeviceLoader,
} from './device-datasource';
import {
  filterModelUpdate,
  predicatesFromFilterModel,
} from './device-filter-model';
import {
  detailsTarget,
  deviceGridFeatures,
  showRow,
} from './device-grid-options';
import type { DeviceRowRefresh } from './device-row-refresh';
import { DEVICE_GRID_ID } from './device-selection';
import { DeviceStatusPanel } from './device-status-panel';

ModuleRegistry.registerModules([
  AllCommunityModule,
  ServerSideRowModelModule,
  RowGroupingModule,
  ServerSideSelectionModule,
  SetFilterModule,
  ColumnMenuModule,
  SideBarModule,
  ColumnsToolPanelModule,
  FiltersToolPanelModule,
  StatusBarModule,
]);

@Component({
  selector: 'app-device-grid',
  imports: [AgGridAngular],
  template: `
    <ag-grid-angular
      class="device-grid"
      [gridOptions]="options"
      (gridReady)="ready($event)"
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
    :host ::ng-deep .lgr-ssrm-selection-footer {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--cc-space-md);
      color: var(--cc-text-primary);
    }
    :host ::ng-deep .lgr-ssrm-selection-footer button {
      color: var(--cc-text-link);
      font: inherit;
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
  readonly loadGroups = input.required<DeviceGroupLoader>();
  readonly revision = input(0);
  /** Row to scroll into view after the first block loads, such as after Back to devices. */
  readonly focusIndex = input<number | null>(null);
  /** Saved grid state to open with, such as after Back to devices. */
  readonly state = input<GridState | null>(null);
  /** Receives the grid state when the grid closes. */
  readonly saveState = input<(state: GridState, selectedView: boolean) => void>(
    () => undefined,
  );
  /** Show All Selected was on when the grid last closed. */
  readonly selectedView = input(false);
  /** The chips. The grid shows them as column filters. */
  readonly predicates = input<DevicePredicate[]>([]);
  /** Organization units for the OrgUnit set filter. */
  readonly orgUnits = input<readonly DeviceOrgUnit[]>([]);
  readonly filtersChange = output<DevicePredicate[]>();
  readonly selection = input.required<{
    provider: ServerSideSelectionProvider;
    tabId: string;
  }>();
  /** Refresh signals update the rows this grid holds. */
  readonly rowRefresh = input<DeviceRowRefresh | null>(null);
  /** The selection footer lives in the status bar. LibreGrid fills it on ready. */
  private readonly footer = document.createElement('div');
  /** Counts and freshness render here, inside the status bar (GRID-01). */
  private readonly status = document.createElement('div');
  private readonly injector = inject(Injector);
  private readonly environment = inject(EnvironmentInjector);
  private readonly application = inject(ApplicationRef);
  private readonly destroyRef = inject(DestroyRef);
  readonly details = output<{
    row: DeviceRow;
    index: number;
    route: string[] | null;
    count: number | null;
  }>();

  private api: GridApi<DeviceRow> | null = null;
  private focused = false;
  /** The remembered row while the status bar may still change height. */
  private pendingRow: number | null = null;
  protected options!: GridOptions<DeviceRow>;

  constructor() {
    effect(() => {
      this.revision();
      untracked(() => this.reload());
    });
    effect(() => {
      const predicates = this.predicates();
      untracked(() => this.applyPredicates(predicates));
    });
  }

  ngOnInit(): void {
    const status = createComponent(DeviceStatusPanel, {
      environmentInjector: this.environment,
      elementInjector: this.injector,
      hostElement: this.status,
    });
    this.application.attachView(status.hostView);
    this.destroyRef.onDestroy(() => status.destroy());
    const open = (row: DeviceRow, node: IRowNode<DeviceRow>) => {
      const target = detailsTarget(node);
      if (target) this.details.emit({ row, ...target });
    };
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
      // LibreGrid refreshes only existing group stores when grouping changes.
      // A new datasource makes it switch between paged rows and groups.
      onColumnRowGroupChanged: () => this.reload(),
      onGridPreDestroyed: ({ state, api }) =>
        this.saveState()(
          savedGridState(state),
          api.getGridOption('ssrmSelectionViewActive') === true,
        ),
      // The first load already shows the selection, so the opened row keeps its place.
      ssrmSelectionViewActive: this.selectedView(),
      getRowId: ({ data }) => data.deviceId,
      rowModelType: 'serverSide',
      cacheBlockSize: 100,
      // A full cache stays within the API's 2,000-ID selection batch.
      maxBlocksInCache: 10,
      ...deviceGridFeatures({
        provider: this.selection().provider,
        tabId: this.selection().tabId,
        footer: this.footer,
        status: this.status,
        onSelectionReady: (service) => this.selectionReady(service),
      }),
    };
  }

  protected ready(event: GridReadyEvent<DeviceRow>): void {
    this.api = event.api;
    const refresh = this.rowRefresh();
    refresh?.attach(event.api);
    this.destroyRef.onDestroy(() => refresh?.detach(event.api));
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
        { gridId: DEVICE_GRID_ID, tabId: this.selection().tabId },
        (view) => this.loadGroups()(view),
      ),
    );
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
    this.pendingRow = index;
    this.reveal();
  }

  /** The selection footer makes the status bar taller and the body shorter. Show the row again. */
  private selectionReady(service: SsrmSelectionService): void {
    if (this.selectedView() && !service.isViewActive()) {
      service.enterViewMode();
      // An empty or expired selection cannot hold the view. Show all records instead.
      if (!service.isViewActive()) {
        this.api?.setGridOption('ssrmSelectionViewActive', false);
        this.api?.refreshServerSide();
      }
    }
    this.reveal();
    this.pendingRow = null;
  }

  private reveal(): void {
    const api = this.api;
    const index = this.pendingRow;
    if (!api || index === null) return;
    // AG Grid measures the body in a resize observer, so wait two frames.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => showRow(api, index)),
    );
  }
}

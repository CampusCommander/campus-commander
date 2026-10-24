import {
  ApplicationRef,
  Component,
  DestroyRef,
  ElementRef,
  EnvironmentInjector,
  Injector,
  OnInit,
  afterNextRender,
  computed,
  createComponent,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { AgGridAngular } from 'ag-grid-angular';
import {
  AllCommunityModule,
  ModuleRegistry,
  themeQuartz,
  type CellDoubleClickedEvent,
  type CellEditRequestEvent,
  type CellEditingStartedEvent,
  type CellKeyDownEvent,
  type FullWidthCellKeyDownEvent,
  type GridApi,
  type GridOptions,
  type GridReadyEvent,
  type GridState,
  type IRowNode,
  type ColumnState,
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
  DeviceUpdateField,
} from '@campus/application-contracts';
import {
  GRID_UPDATE_FIELDS,
  detailsKeyHandler,
  deviceColumnDefs,
  gridColumnFor,
  type DeviceDraftColumnOptions,
} from './device-columns';
import {
  defaultGridState,
  deviceDatasource,
  pendingDatasource,
  savedGridState,
  type DeviceGroupLoader,
  type DeviceLoader,
  type DevicePendingDatasource,
  type DevicePendingLoader,
} from './device-datasource';
import {
  filterModelUpdate,
  predicatesFromFilterModel,
} from './device-filter-model';
import {
  DeviceGridDraftStore,
  baselineFor,
  type DeviceGridDraftEntry,
} from './device-grid-draft.store';
import { DeviceGridConflict } from './device-grid-conflict';
import {
  detailsTarget,
  deviceGridFeatures,
  showRow,
} from './device-grid-options';
import { DeviceOrgUnitPicker } from './device-org-unit-picker';
import {
  DeviceOrgUnitTreeStore,
  type OrgUnitTreeRow,
} from './device-org-unit-tree.store';
import type { DeviceRowRefresh } from './device-row-refresh';
import { DEVICE_GRID_ID } from './device-selection';
import { DeviceStatusPanel } from './device-status-panel';
import type { DeviceSortField } from './device-fields';

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

interface DeviceGridPicker {
  row: DeviceRow;
  node: IRowNode<DeviceRow>;
}

interface DeviceGridConflictView {
  entry: DeviceGridDraftEntry;
  trigger: HTMLElement;
  left: number;
  top: number;
}

@Component({
  selector: 'app-device-grid',
  imports: [AgGridAngular, DeviceGridConflict, DeviceOrgUnitPicker],
  template: `
    <ag-grid-angular
      class="device-grid"
      [gridOptions]="options"
      (gridReady)="ready($event)"
    />
    @if (picker(); as edit) {
      <app-device-org-unit-picker
        [open]="true"
        [units]="pickerUnits()"
        [deviceCount]="1"
        [selectedId]="pickerSelectedId()"
        [contextLine]="edit.row.serialNumber + ' · Organization unit'"
        confirmLabel="Stage change"
        (chosen)="chooseUnit($event)"
        (cancelled)="cancelPicker()"
      />
    }
    @if (conflict(); as view) {
      <div #conflictCard class="conflict-anchor">
        <app-device-grid-conflict
          [entry]="view.entry"
          [left]="view.left"
          [top]="view.top"
          (keepCurrent)="resolveConflict('current')"
          (keepDraft)="resolveConflict('draft')"
          (closed)="closeConflict()"
        />
      </div>
    }
  `,
  styles: `
    :host {
      position: relative;
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
    :host ::ng-deep .device-stale {
      color: var(--cc-text-secondary);
    }
    /* DRAFT-02: the pending, invalid, and conflict cells of the grid draft. */
    :host ::ng-deep .ag-cell.device-draft-pending {
      border-radius: 2px;
      background: var(--cc-surface-selected);
      box-shadow: inset 0 0 0 2px var(--cc-accent);
    }
    :host ::ng-deep .ag-cell.device-draft-invalid {
      border-radius: 2px;
      background: color-mix(in srgb, var(--cc-status-error) 8%, transparent);
      box-shadow: inset 0 0 0 2px var(--cc-status-error);
    }
    :host ::ng-deep .ag-cell.device-draft-conflict {
      border-radius: 2px;
      background: color-mix(in srgb, var(--cc-status-warning) 14%, transparent);
      box-shadow: inset 0 0 0 2px var(--cc-status-warning);
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
    .conflict-anchor {
      display: contents;
    }
  `,
})
export class DeviceGrid implements OnInit {
  readonly load = input.required<DeviceLoader>();
  readonly loadGroups = input.required<DeviceGroupLoader>();
  readonly revision = input(0);
  /** Increments when a resumed session must retry the grid blocks whose loads failed (S5). */
  readonly resumeRevision = input(0);
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
  /**
   * The changed devices of the grid draft. A non-null list switches the grid to the
   * pending view: flat rows outside the person's filters and grouping (addendum 5).
   */
  readonly pendingIds = input<readonly string[] | null>(null);
  /** Reads the pending view's rows by device ID. */
  readonly loadPending = input<DevicePendingLoader | null>(null);
  /** Increments when the person asks for a failed pending read again. */
  readonly pendingRevision = input(0);
  /** Organization units for the OrgUnit set filter. */
  readonly orgUnits = input<readonly DeviceOrgUnit[]>([]);
  /**
   * True when the route grants the three Update device actions. Without them every cell
   * stays read-only (rules UI-04 and 108:303).
   */
  readonly editable = input(false);
  readonly filtersChange = output<DevicePredicate[]>();
  readonly selection = input.required<{
    provider: ServerSideSelectionProvider;
    tabId: string;
    /** The pending view's device IDs while that view is on (SELECT-01). */
    pendingScope?: (ids: readonly string[] | null) => void;
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
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly draft = inject(DeviceGridDraftStore);
  private readonly orgUnitTree = inject(DeviceOrgUnitTreeStore);
  readonly details = output<{
    row: DeviceRow;
    index: number;
    route: string[] | null;
    count: number | null;
  }>();

  protected readonly picker = signal<DeviceGridPicker | null>(null);
  protected readonly conflict = signal<DeviceGridConflictView | null>(null);
  protected readonly pickerUnits = computed(
    () => this.orgUnitTree.units() ?? [],
  );
  protected readonly pickerSelectedId = computed<string | null>(() => {
    const picker = this.picker();
    if (!picker) return null;
    const entry = this.draft.entryFor(picker.row.deviceId, 'orgUnitPath');
    if (entry?.orgUnitId) return entry.orgUnitId;
    const path = entry?.value ?? picker.row.orgUnitPath;
    return this.pickerUnits().find((unit) => unit.path === path)?.id ?? null;
  });
  private readonly conflictCard =
    viewChild<ElementRef<HTMLElement>>('conflictCard');

  private api: GridApi<DeviceRow> | null = null;
  /** The grid shows the pending view: flat rows of the draft's devices. */
  private pending = false;
  /** The person's row grouping, put back when the pending view closes. */
  private pendingGroups: string[] | null = null;
  /** The person's sort, put back when the pending view closes. */
  private pendingSort: ColumnState[] | null = null;
  /** The rows of the pending view, so refreshed records reach its cache (D7). */
  private pendingSource: DevicePendingDatasource | null = null;
  /** The device IDs of the pending view on screen. */
  private pendingViewIds: readonly string[] | null = null;
  /** A view switch is moving the grid, so its reloads wait for the switch to finish. */
  private switching = false;
  /** The last retry request that the grid answered. */
  private pendingRetried = 0;
  private focused = false;
  /** The remembered row while the status bar may still change height. */
  private pendingRow: number | null = null;
  protected options!: GridOptions<DeviceRow>;
  private selectionService: SsrmSelectionService | null = null;
  private liveListener: ((event: Event) => void) | null = null;

  constructor() {
    effect(() => {
      this.revision();
      // A revision arrives from a reconnect or a completed full sync. It reloads the
      // view on screen, which is the pending view while that view is on (B2).
      untracked(() => this.reloadActiveView());
    });
    effect(() => {
      this.resumeRevision();
      untracked(() => this.retryFailedBlocks());
    });
    effect(() => {
      const predicates = this.predicates();
      untracked(() => {
        // The pending view hides the person's filters. They return with Show all devices.
        if (!this.pending) this.applyPredicates(predicates);
      });
    });
    // "Show pending changes" swaps the datasource for the draft's devices (addendum 5).
    effect(() => {
      const ids = this.pendingIds();
      untracked(() => this.applyPendingView(ids));
    });
    // A failed pending read retries on request. The first run is not a retry.
    effect(() => {
      const revision = this.pendingRevision();
      untracked(() => {
        if (revision === this.pendingRetried) return;
        this.pendingRetried = revision;
        const ids = this.pendingIds();
        if (this.pending && ids?.length) this.applyPendingView(ids);
      });
    });
    // "Review pending devices" switches the open grid to its selected view.
    effect(() => {
      const wanted = this.selectedView();
      untracked(() => this.applySelectionView(wanted));
    });
    // A restored or changed draft repaints the cells that show its values.
    effect(() => {
      this.draft.entries();
      untracked(() => this.refreshDraftCells());
    });
    effect(() => {
      this.editable();
      untracked(() => this.refreshDraftCells());
    });
    // The unit read decides whether its column shows the edit hint.
    effect(() => {
      this.orgUnitTree.state();
      untracked(() => this.refreshDraftCells());
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
    const keys = detailsKeyHandler(open);
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
        draft: this.draftOptions(),
      }),
      // An edit never writes the row data. The draft holds the value (addendum section 5).
      readOnlyEdit: true,
      onCellEditRequest: (event) => this.stageEdit(event),
      onCellEditingStarted: (event) => this.beginLiveEdit(event),
      onCellEditingStopped: () => this.endLiveEdit(),
      onCellDoubleClicked: (event) => this.openUnitFromDoubleClick(event),
      onCellKeyDown: (event) => {
        keys(event);
        this.draftKey(event);
      },
      initialState: this.state() ?? defaultGridState(),
      onFilterChanged: () => this.filtersChanged(),
      // LibreGrid refreshes only existing group stores when grouping changes.
      // A new datasource makes it switch between paged rows and groups.
      onColumnRowGroupChanged: () => this.rowGroupingChanged(),
      onGridPreDestroyed: ({ state, api }) => {
        this.endLiveEdit();
        this.picker.set(null);
        this.conflict.set(null);
        // The selection provider belongs to the page. A closed pending view leaves no scope.
        this.pendingScope(null);
        this.saveState()(
          this.stateForSave(state),
          api.getGridOption('ssrmSelectionViewActive') === true,
        );
      },
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
        pending: () => this.pending,
        onSelectionReady: (service) => this.selectionReady(service),
      }),
    };
  }

  protected ready(event: GridReadyEvent<DeviceRow>): void {
    this.api = event.api;
    const refresh = this.rowRefresh();
    refresh?.attach(event.api);
    // A refreshed record reaches the pending view's cached rows, so sorting keeps it (D7).
    const stop = refresh?.onApply((rows) => this.pendingSource?.update(rows));
    this.destroyRef.onDestroy(() => {
      refresh?.detach(event.api);
      stop?.();
    });
    // A saved pending view opens before the person's own query runs.
    const pending = this.pendingIds();
    if (pending?.length) this.applyPendingView(pending);
    else {
      this.applyPredicates(this.predicates());
      this.reload();
    }
    this.refreshDraftCells();
  }

  /** The draft reads and writes that the editable columns call. */
  private draftOptions(): DeviceDraftColumnOptions {
    return {
      editable: () => this.editable(),
      orgUnitEditable: () => this.orgUnitTree.state() === 'granted',
      value: (deviceId, field, text) =>
        this.draft.valueFor(deviceId, field, text),
      entry: (deviceId, field) => this.draft.entryFor(deviceId, field),
      reason: (entry) => this.draft.reasonFor(entry),
      onRevert: (deviceId, field) => this.draft.revert(deviceId, field),
      onConflict: (deviceId, field, anchor) =>
        this.openConflict(deviceId, field, anchor),
    };
  }

  /**
   * Validate and stage the edit request. With readOnlyEdit the row data keeps its value,
   * and the cell renderer shows the draft value instead.
   */
  private stageEdit(event: CellEditRequestEvent<DeviceRow>): void {
    if (!this.editable() || !event.data || event.node.group) return;
    const field =
      GRID_UPDATE_FIELDS[event.column.getColId() as DeviceSortField];
    if (!field || field === 'orgUnitPath') return;
    const value =
      event.newValue === null || event.newValue === undefined
        ? ''
        : String(event.newValue);
    this.draft.stageText(event.data, field, value);
    // The draft effect repaints the cell from the store once the edit cycle ends.
  }

  /** Count the changed input of an open editor before it stages (mockup choice 5). */
  private beginLiveEdit(event: CellEditingStartedEvent<DeviceRow>): void {
    if (!this.editable() || !event.data || event.node.group) return;
    const field =
      GRID_UPDATE_FIELDS[event.column.getColId() as DeviceSortField];
    if (!field || field === 'orgUnitPath') return;
    const entry = this.draft.entryFor(event.data.deviceId, field);
    this.draft.beginLive({
      deviceId: event.data.deviceId,
      field,
      baseline: baselineFor(entry, event.data, field),
      value:
        event.value === null || event.value === undefined
          ? ''
          : String(event.value),
    });
    this.attachLiveInput();
  }

  private endLiveEdit(): void {
    this.draft.endLive();
    this.detachLiveInput();
  }

  /** The open editor's input bubbles from the cell or the large text popup. */
  private attachLiveInput(): void {
    this.detachLiveInput();
    const listener = (event: Event) => {
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement
      )
        this.draft.updateLive(target.value);
    };
    this.host.nativeElement.addEventListener('input', listener, true);
    this.liveListener = listener;
  }

  private detachLiveInput(): void {
    if (!this.liveListener) return;
    this.host.nativeElement.removeEventListener(
      'input',
      this.liveListener,
      true,
    );
    this.liveListener = null;
  }

  /** Enter and F2 open the picker on the unit column. Shift+Enter reverts a pending cell. */
  private draftKey(
    event: CellKeyDownEvent<DeviceRow> | FullWidthCellKeyDownEvent<DeviceRow>,
  ): void {
    const keyboard = event.event as KeyboardEvent | null;
    if (!keyboard || !('column' in event) || !event.data || event.node.group)
      return;
    const field =
      GRID_UPDATE_FIELDS[event.column.getColId() as DeviceSortField];
    if (!field) return;
    if (field === 'orgUnitPath') {
      if (keyboard.key === 'Enter' || keyboard.key === 'F2') {
        keyboard.preventDefault();
        this.openPicker(event.data, event.node);
      }
      return;
    }
    if (
      keyboard.key === 'Enter' &&
      keyboard.shiftKey &&
      !this.draft.live() &&
      this.draft.entryFor(event.data.deviceId, field)
    ) {
      keyboard.preventDefault();
      keyboard.stopPropagation();
      this.draft.revert(event.data.deviceId, field);
    }
  }

  private openUnitFromDoubleClick(
    event: CellDoubleClickedEvent<DeviceRow>,
  ): void {
    if (
      event.column.getColId() !== 'orgUnitPath' ||
      !event.data ||
      event.node.group
    )
      return;
    event.event?.preventDefault();
    this.openPicker(event.data, event.node);
  }

  private openPicker(row: DeviceRow, node: IRowNode<DeviceRow>): void {
    if (!this.editable()) return;
    const tree = this.orgUnitTree.tree();
    if (!tree) {
      void this.orgUnitTree.load().then(() => {
        if (this.orgUnitTree.state() === 'granted')
          this.picker.set({ row, node });
      });
      return;
    }
    if (tree.state !== 'granted') return;
    this.endLiveEdit();
    this.picker.set({ row, node });
  }

  protected chooseUnit(unit: OrgUnitTreeRow): void {
    const picker = this.picker();
    if (!picker) return;
    this.draft.stageMove(picker.row, unit);
    this.picker.set(null);
    this.refocusCell(picker.row.deviceId, 'orgUnitPath');
  }

  protected cancelPicker(): void {
    const picker = this.picker();
    this.picker.set(null);
    if (picker) this.refocusCell(picker.row.deviceId, 'orgUnitPath');
  }

  private openConflict(
    deviceId: string,
    field: DeviceUpdateField,
    trigger: HTMLElement,
  ): void {
    const entry = this.draft.entryFor(deviceId, field);
    if (!entry) return;
    this.conflict.set({ entry, trigger, left: 0, top: 0 });
    afterNextRender(() => this.placeConflict(), { injector: this.injector });
  }

  /** Place the card above the cell, or below it when the grid has no room above. */
  private placeConflict(): void {
    const view = this.conflict();
    const card = this.conflictCard()?.nativeElement;
    if (!view || !card) return;
    const host = this.host.nativeElement.getBoundingClientRect();
    const anchor = view.trigger.getBoundingClientRect();
    const width = card.offsetWidth || 360;
    const height = card.offsetHeight || 220;
    const left = Math.max(
      8,
      Math.min(anchor.right - host.left - width, host.width - width - 8),
    );
    const above = anchor.top - host.top - height - 6;
    const below = anchor.bottom - host.top + 6;
    const top = Math.max(
      8,
      Math.min(above >= 8 ? above : below, host.height - height - 8),
    );
    this.conflict.set({ ...view, left, top });
  }

  /** Keep current value removes the entry; keep my draft rebases it on the current value. */
  protected resolveConflict(choice: 'current' | 'draft'): void {
    const view = this.conflict();
    if (!view) return;
    if (choice === 'current')
      this.draft.keepCurrent(view.entry.deviceId, view.entry.field);
    else this.draft.keepDraft(view.entry.deviceId, view.entry.field);
    this.conflict.set(null);
    this.refocusCell(view.entry.deviceId, view.entry.field);
  }

  protected closeConflict(): void {
    const view = this.conflict();
    if (!view) return;
    this.conflict.set(null);
    if (view.trigger.isConnected) view.trigger.focus();
  }

  private refocusCell(deviceId: string, field: DeviceUpdateField): void {
    afterNextRender(
      () => {
        const node = this.api?.getRowNode(deviceId);
        if (node?.rowIndex === null || node?.rowIndex === undefined) return;
        this.api?.setFocusedCell(node.rowIndex, gridColumnFor(field));
      },
      { injector: this.injector },
    );
  }

  private refreshDraftCells(): void {
    this.api?.refreshCells?.({ force: true, suppressFlash: true });
  }

  /**
   * Switch between the person's query and the pending view. The pending view is flat:
   * its rows ignore the person's filters and grouping (addendum section 5). Neither
   * switch touches the draft.
   */
  private applyPendingView(ids: readonly string[] | null): void {
    const api = this.api;
    if (!api) return;
    if (!ids?.length) {
      if (this.pending) this.leavePendingView();
      return;
    }
    if (!this.pending) {
      this.switching = true;
      this.pending = true;
      // The person's grouping and sort return with Show all devices.
      this.pendingGroups = api
        .getRowGroupColumns()
        .map((column) => column.getColId());
      this.pendingSort = api.getColumnState();
      api.setRowGroupColumns([]);
      api.setFilterModel(null);
      this.switching = false;
    }
    this.reloadPending(ids);
  }

  /** Put the person's query back: grouping, sort, filters, and the query datasource. */
  private leavePendingView(): void {
    const groups = this.pendingGroups ?? [];
    const sort = this.pendingSort;
    this.switching = true;
    this.pending = false;
    this.pendingGroups = null;
    this.pendingSort = null;
    this.pendingViewIds = null;
    this.pendingSource = null;
    this.pendingScope(null);
    this.api?.setRowGroupColumns(groups);
    // The pending view may have sorted its own rows. The person's sort comes back.
    if (sort) this.restoreSort(sort);
    // The chips are the person's query. They rebuild the column filters.
    this.applyPredicates(this.predicates());
    this.switching = false;
    this.reload();
  }

  /** Every column's sort is replaced, so no pending order stays behind. */
  private restoreSort(sort: readonly ColumnState[]): void {
    this.api?.applyColumnState({
      defaultState: { sort: null },
      state: sort.map((item) => ({
        colId: item.colId,
        sort: item.sort,
        sortIndex: item.sortIndex,
      })),
    });
  }

  /** One read answers the pending view. Paging and sorting reuse that answer. */
  private reloadPending(ids: readonly string[]): void {
    const load = this.loadPending();
    if (!load) return;
    this.pendingViewIds = ids;
    this.pendingScope(ids);
    const source = pendingDatasource(() => load(ids));
    this.pendingSource = source;
    this.api?.setGridOption('serverSideDatasource', source);
  }

  /** A revision reloads the view on screen, which is the pending view while it is on (B2). */
  private reloadActiveView(): void {
    const ids = this.pendingViewIds;
    if (this.pending && ids?.length) this.reloadPending(ids);
    else this.reload();
  }

  /** The pending view is flat. A grouping control returns it to flat rows (addendum 5). */
  private rowGroupingChanged(): void {
    // A view switch moves the grouping itself. Its own reload follows the switch.
    if (this.switching) return;
    if (this.pending) {
      // The Columns panel and API callers can group past the column menu.
      if (this.api?.getRowGroupColumns().length)
        queueMicrotask(() => this.keepPendingFlat());
      return;
    }
    this.reload();
  }

  private keepPendingFlat(): void {
    const api = this.api;
    if (!this.pending || !api?.getRowGroupColumns().length) return;
    this.switching = true;
    api.setRowGroupColumns([]);
    this.switching = false;
  }

  /** The pending view's selection scope is its device IDs, not the person's filter. */
  private pendingScope(ids: readonly string[] | null): void {
    this.selection().pendingScope?.(ids);
  }

  /**
   * The state that Back to devices restores. The pending view is temporary, so its save
   * keeps the person's grouping and sort rather than the flat layout on screen.
   */
  private stateForSave(state: GridState): GridState {
    const saved = savedGridState(state);
    if (!this.pending) return saved;
    const next: GridState = { ...saved };
    const groups = this.pendingGroups;
    if (groups?.length) next.rowGroup = { groupColIds: [...groups] };
    const sort = this.pendingSort;
    if (sort?.length)
      next.sort = {
        sortModel: sort
          .filter((item) => item.sort !== null && item.sort !== undefined)
          .map((item) => ({ colId: item.colId, sort: item.sort! })),
      };
    return next;
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

  /** A resumed session retries the blocks whose loads failed. The rows that loaded stay in place. */
  private retryFailedBlocks(): void {
    this.api?.retryServerSideLoads();
  }

  private applyPredicates(predicates: readonly DevicePredicate[]): void {
    const api = this.api;
    const next = api && filterModelUpdate(api.getFilterModel(), predicates);
    if (next) api?.setFilterModel(next);
  }

  private filtersChanged(): void {
    const api = this.api;
    // The pending view sets its own model. A column filter there is not the person's query.
    if (!api || this.pending || this.switching) return;
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
    this.selectionService = service;
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

  /** Follow a later Show All Selected request without remounting the grid. */
  private applySelectionView(wanted: boolean): void {
    const service = this.selectionService;
    if (!service) return;
    if (wanted && !service.isViewActive()) {
      service.enterViewMode();
      if (!service.isViewActive()) {
        this.api?.setGridOption('ssrmSelectionViewActive', false);
        this.api?.refreshServerSide();
      }
    } else if (!wanted && service.isViewActive()) {
      service.exitViewMode();
    }
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

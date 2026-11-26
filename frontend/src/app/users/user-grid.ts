import {
  ApplicationRef,
  Component,
  DestroyRef,
  ElementRef,
  EnvironmentInjector,
  Injector,
  OnInit,
  afterNextRender,
  createComponent,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
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
  type ColumnMovedEvent,
  type FilterModel,
  type FullWidthCellKeyDownEvent,
  type GridApi,
  type GridOptions,
  type GridReadyEvent,
  type GridState,
  type IRowNode,
  type ToolPanelVisibleChangedEvent,
} from 'ag-grid-community';
import { ServerSideRowModelModule } from '@libregrid/server-side-row-model';
import {
  ServerSideSelectionModule,
  type ServerSideSelectionProvider,
  type SsrmSelectionService,
} from '@libregrid/server-side-selection';
import { SetFilterModule } from '@libregrid/set-filter';
import { ColumnMenuModule } from '@libregrid/menu';
import { SideBarModule } from '@libregrid/side-bar';
import { ColumnsToolPanelModule } from '@libregrid/columns-tool-panel';
import { FiltersToolPanelModule } from '@libregrid/filters-tool-panel';
import { StatusBarModule } from '@libregrid/status-bar';
import type {
  UserOrgUnit,
  UserPage,
  UserPredicate,
  UserRow,
} from '@campus/application-contracts';
import {
  cellOpensDialog,
  userColumnDefs,
  attributeColumnsSignature,
  ATTRIBUTE_BOOL_CLEAR,
} from './user-columns';
import {
  defaultGridState,
  pendingUserDatasource,
  savedGridState,
  userDatasource,
  type UserLoader,
  type UserPendingDatasource,
} from './user-datasource';
import {
  EmptySetFilterError,
  filterModelUpdate,
  gridExpresses,
  mergeGridPredicates,
  predicatesFromFilterModel,
  samePredicates,
} from './user-filter-model';
import {
  userGridFeatures,
  detailsKeyHandler,
  showRow,
} from './user-grid-options';
import { USER_GRID_ID, UserSelectionProvider } from './user-selection';
import type { UserRowRefresh } from './user-row-refresh';
import { attributeFor, type UserAttributeColumn } from './user-fields';
import {
  UserAttributeGridDraft,
  cellFor,
  type UserAttributeDraftEntry,
} from './user-attribute-grid-draft';
import { UserAttributeCellDialog } from './user-attribute-cell-dialog';
import { UserStatusPanel } from './user-status-panel';

ModuleRegistry.registerModules([
  AllCommunityModule,
  ServerSideRowModelModule,
  ServerSideSelectionModule,
  SetFilterModule,
  ColumnMenuModule,
  SideBarModule,
  ColumnsToolPanelModule,
  FiltersToolPanelModule,
  StatusBarModule,
]);

/** The users grid: server-side rows, the Columns panel, filters, and selection (A section 9). */
@Component({
  selector: 'app-user-grid',
  imports: [AgGridAngular, UserAttributeCellDialog],
  template: `
    <ag-grid-angular
      class="user-grid"
      [gridOptions]="options"
      (gridReady)="ready($event)"
    />
    @if (cellDialog(); as open) {
      <app-user-attribute-cell-dialog
        [field]="open.column.field"
        [attribute]="open.column.id"
        [label]="open.column.label"
        [value]="open.value"
        [userName]="open.userName"
        (cancelled)="closeCellDialog()"
        (cleared)="clearCellDialog()"
        (staged)="stageCellDialog($event)"
      />
    }
  `,
  styles: `
    :host {
      position: relative;
      display: block;
      height: 100%;
      min-height: calc(var(--cc-row-height-grid) * 8);
    }
    .user-grid {
      display: block;
      height: 100%;
    }
    /* A stale row shows its name muted until the refresh lands (A section 15.4). */
    :host ::ng-deep .user-stale {
      color: var(--cc-text-secondary);
    }
    /* DRAFT-02: the pending, invalid, and conflict cells of the grid draft. */
    :host ::ng-deep .ag-cell.user-attribute-draft-pending {
      border-radius: 2px;
      background: var(--cc-surface-selected);
      box-shadow: inset 0 0 0 2px var(--cc-accent);
    }
    :host ::ng-deep .ag-cell.user-attribute-draft-invalid {
      border-radius: 2px;
      background: color-mix(in srgb, var(--cc-status-error) 8%, transparent);
      box-shadow: inset 0 0 0 2px var(--cc-status-error);
    }
    :host ::ng-deep .ag-cell.user-attribute-draft-conflict {
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
    :host ::ng-deep .user-details-header .ag-header-cell-text {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0 0 0 0);
      white-space: nowrap;
    }
    /* The approved Columns panel lists the checkbox, the label, and the drag grip
       (state 02, R13). Pin controls are not in that composition, so they stay
       hidden and out of the tab order. */
    :host ::ng-deep .lgr-columns-row-actions button[aria-label^='Pin '],
    :host ::ng-deep .lgr-columns-row-actions button[aria-label^='Unpin '] {
      display: none;
    }
    /* UI-09: the move controls stay in the tab order. A row reveals them on
       keyboard focus or the pointer. They sit out of flow, so the approved
       258 px row keeps its label width and its rest look. */
    :host ::ng-deep .lgr-columns-row {
      position: relative;
    }
    :host ::ng-deep .lgr-columns-row-actions {
      position: absolute;
      top: 50%;
      right: calc(var(--ag-grid-size, 8px) * 4.25);
      display: flex;
      margin-left: 0;
      opacity: 0;
      pointer-events: none;
      transform: translateY(-50%);
    }
    :host ::ng-deep .lgr-columns-row:hover .lgr-columns-row-actions,
    :host ::ng-deep .lgr-columns-row:focus-within .lgr-columns-row-actions {
      opacity: 1;
      pointer-events: auto;
    }
    /* UI-09: the revealed controls sit at the row's trailing edge. An active
       row reserves their footprint so the label ends with an ellipsis before
       them instead of running beneath them. The footprint is the two 24 px
       controls and their 2 px gap, plus the 5 px focus ring and a 5 px gap.
       Only a movable row pays it, and only while focused or under the
       pointer, so a row at rest keeps the approved label width. */
    :host ::ng-deep .lgr-columns-row[data-column-movable='true']:hover > label,
    :host
      ::ng-deep
      .lgr-columns-row[data-column-movable='true']:focus-within
      > label {
      padding-right: calc(var(--ag-grid-size, 8px) * 6.25 + 10px);
    }
  `,
})
export class UserGrid implements OnInit {
  readonly load = input.required<UserLoader>();
  readonly revision = input(0);
  /** Saved grid state, such as after Back to users. */
  readonly state = input<GridState | null>(null);
  /** Receives the grid state when the grid closes. */
  readonly saveState = input<(state: GridState, selectedView: boolean) => void>(
    () => undefined,
  );
  /** Show All Selected was on when the grid last closed. */
  readonly selectedView = input(false);
  /** Bumps when the API ended the selection. The grid re-resolves its loaded rows. */
  readonly selectionRevision = input(0);
  /** The chips. The grid shows them as column filters. */
  readonly predicates = input<UserPredicate[]>([]);
  /** The attribute columns of the connection's user schemas. */
  readonly attributes = input<readonly UserAttributeColumn[]>([]);
  /** Organization units for the OrgUnit set filter. */
  readonly orgUnits = input<readonly UserOrgUnit[]>([]);
  readonly filtersChange = output<UserPredicate[]>();
  /** The grid holds a filter that matches no row, such as an empty set filter (R6). */
  readonly emptyFilter = output<boolean>();
  /** The grid left Show All Selected, so the page holds no selected view (R10). */
  readonly selectedViewChange = output<boolean>();
  readonly selection = input.required<{
    provider: ServerSideSelectionProvider;
    tabId: string;
  }>();
  /** Refresh signals update the rows this grid holds. */
  readonly rowRefresh = input<UserRowRefresh | null>(null);
  /** The cells are editable: users:write at the district, and the page is online (B section 12). */
  readonly editable = input(false);
  /** The draft's user IDs while Show pending changes is on (DRAFT-02). */
  readonly pendingIds = input<readonly string[] | null>(null);
  /** Reads the pending view's rows by user ID. One request answers at most 500 users. */
  readonly loadPending = input<(() => Promise<UserRow[] | null>) | null>(null);
  /** Increments when the person asks for a failed pending read again. */
  readonly pendingRevision = input(0);
  /** Row to focus after the first block loads, such as the row that opened the details (UI-09). */
  readonly focusIndex = input<number | null>(null);
  /** The grid offset of that row, so Back to users restores the scroll position (A section 4). */
  readonly focusScroll = input<number | null>(null);
  /** GRID-03: the details control of a row opens that user's details page. */
  readonly details = output<{
    row: UserRow;
    index: number;
    scrollTop: number | null;
  }>();
  /** The Name link records the row before the router opens its details page. */
  readonly opened = output<{
    row: UserRow;
    index: number;
    scrollTop: number | null;
  }>();

  /** The selection footer lives in the status bar. LibreGrid fills it on ready. */
  private readonly footer = document.createElement('div');
  /** Counts and freshness render here, inside the status bar (GRID-01). */
  private readonly status = document.createElement('div');
  private readonly injector = inject(Injector);
  private readonly environment = inject(EnvironmentInjector);
  private readonly application = inject(ApplicationRef);
  private readonly destroyRef = inject(DestroyRef);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  /** The grid draft holds the pending attribute cells (design K26). */
  private readonly draft = inject(UserAttributeGridDraft);

  /** The open date picker or list editor of one cell (B section 12). */
  protected readonly cellDialog = signal<{
    row: UserRow;
    column: UserAttributeColumn;
    value: string | string[];
    userName: string;
  } | null>(null);

  private api: GridApi<UserRow> | null = null;
  /** The grid started. The column effect waits for it, so an early category read lands. */
  private readonly started = signal(false);
  /** The attribute set that the grid already holds, so one read sets the columns once. */
  private appliedColumns = '';
  private selectionService: SsrmSelectionService | null = null;
  /** The grid shows the pending view: flat rows of the draft's users (DRAFT-02). */
  private pending = false;
  /** The rows of the pending view, so refreshed records reach its cache. */
  private pendingSource: UserPendingDatasource | null = null;
  /** The user IDs of the pending view on screen. */
  private pendingViewIds: readonly string[] | null = null;
  /** The revision of the last retried pending read. */
  private pendingRetried = 0;
  /** A filter model change of the view switch is not a person's filter. */
  private switching = false;
  /** The column rebuild restores the open filter model; that is not a person's filter. */
  private restoringColumns = false;
  /** The open editor's input listener. */
  private liveListener: ((event: Event) => void) | null = null;
  /** The predicates that no column filter shows. The datasource reads them (R4). */
  private keptPredicates: readonly UserPredicate[] = [];
  /** The predicates that the loaded rows follow, so a model change never reloads twice (R4). */
  private appliedPredicates: readonly UserPredicate[] = [];
  private datasourceReady = false;
  /**
   * The row that focus returns to is in place. It stays false until focus lands, so a
   * block that loads later resumes the restoration (R4).
   */
  private restored = false;
  /** One restoration loop runs at a time. A block answer joins the running loop. */
  private focusing = false;
  /** The grid ended. A pending frame or block answer must not touch focus (R4). */
  private destroyed = false;
  /** The move control that an activation used. Its row takes focus back after the panel re-renders. */
  private panelMove: {
    columnId: string;
    direction: 'up' | 'down';
  } | null = null;
  private readonly moveClick = (event: MouseEvent) =>
    this.trackMoveClick(event);
  protected options!: GridOptions<UserRow>;

  constructor() {
    effect(() => {
      this.revision();
      // A revision arrives from a reconnect or a completed full sync.
      untracked(() => this.reload());
    });
    effect(() => {
      const predicates = this.predicates();
      // The pending view hides the person's filters. They return with Show all users.
      untracked(() => {
        if (!this.pending) this.applyPredicates(predicates);
      });
    });
    // The category read adds the attribute columns after the grid starts.
    effect(() => {
      const attributes = this.attributes();
      // The grid start fires the effect again when the category read finished first.
      const started = this.started();
      untracked(() => {
        if (!started || !this.api || !attributes.length) return;
        // One column set for one metadata read. The signature carries the label, type,
        // list, and range, so a same-ID category change rebuilds the editor closures
        // without a second set for an unchanged read (R1-E). The filter model survives.
        const signature = attributeColumnsSignature(attributes);
        if (signature === this.appliedColumns) return;
        this.appliedColumns = signature;
        // A rebuilt column set must keep the unrelated filters of the open query (R4,
        // R1-E). The model returns after the new definitions, and its change is not a
        // person's filter.
        const model = this.api.getFilterModel();
        this.restoringColumns = true;
        try {
          this.api.setGridOption('columnDefs', this.columnDefs());
          this.api.setFilterModel(model);
        } finally {
          this.restoringColumns = false;
        }
        this.scheduleGroupHeader();
      });
    });
    effect(() => {
      const wanted = this.selectedView();
      untracked(() => this.applySelectionView(wanted));
    });
    // An expired selection re-resolves the loaded rows and their counts (R10).
    effect(() => {
      const revision = this.selectionRevision();
      untracked(() => {
        if (!revision) return;
        this.selectionEnded();
      });
    });
    // "Show pending changes" swaps the datasource for the draft's users (DRAFT-02).
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
    // The draft repaints its cells without reloading a block (DRAFT-02).
    effect(() => {
      this.draft.entries();
      this.draft.live();
      untracked(() => this.refreshDraftCells());
    });
    // A frame or block answer that lands after the grid ended must leave focus alone (R4).
    this.destroyRef.onDestroy(() => {
      this.destroyed = true;
    });
  }

  ngOnInit(): void {
    const panel = createComponent(UserStatusPanel, {
      environmentInjector: this.environment,
      elementInjector: this.injector,
      hostElement: this.status,
    });
    this.application.attachView(panel.hostView);
    this.destroyRef.onDestroy(() => panel.destroy());
    // UI-09: the panel rebuilds its rows after a move. Record the activation
    // before the control's own click handler runs, so focus can return to the
    // moved row. Enter and Space raise the same click event as the pointer.
    this.host.nativeElement.addEventListener('click', this.moveClick, true);
    this.destroyRef.onDestroy(() =>
      this.host.nativeElement.removeEventListener(
        'click',
        this.moveClick,
        true,
      ),
    );
    this.options = {
      theme: themeQuartz.withParams({
        accentColor: 'var(--cc-accent)',
        backgroundColor: 'var(--cc-surface-card)',
        headerBackgroundColor: 'var(--cc-surface-app)',
        borderColor: 'var(--cc-border)',
        foregroundColor: 'var(--cc-text-primary)',
      }),
      columnDefs: this.columnDefs(),
      // The users grid keeps one header row. A category still groups its columns in the panel.
      groupHeaderHeight: 0,
      initialState: this.state() ?? defaultGridState(),
      onFilterChanged: () => this.filtersChanged(),
      onToolPanelVisibleChanged: (event) => this.panelToggled(event),
      // DRAFT-02: an edit stages in the draft and never writes the row data.
      readOnlyEdit: true,
      onCellEditRequest: (event) => this.stageEdit(event),
      onCellEditingStarted: (event) => this.beginLiveEdit(event),
      onCellEditingStopped: () => this.endLiveEdit(),
      onCellDoubleClicked: (event) => this.openCellDialogFromEvent(event),
      onCellKeyDown: (event) => this.cellKeyDown(event),
      // A moved or pinned attribute column keeps its group header name for assistive tech.
      onColumnMoved: (event) => {
        this.columnMoved(event);
        this.scheduleGroupHeader();
      },
      onDisplayedColumnsChanged: () => this.scheduleGroupHeader(),
      onGridPreDestroyed: ({ state, api }) => {
        this.saveState()(
          savedGridState(state),
          api.getGridOption('ssrmSelectionViewActive') === true,
        );
      },
      ssrmSelectionViewActive: this.selectedView(),
      getRowId: ({ data }) => data.userId,
      rowModelType: 'serverSide',
      cacheBlockSize: 100,
      maxBlocksInCache: 10,
      ...userGridFeatures({
        provider: this.selection().provider,
        tabId: this.selection().tabId,
        footer: this.footer,
        status: this.status,
        expandedGroups: () => [
          ...new Set(
            this.attributes().map((attribute) => `cat:${attribute.schemaName}`),
          ),
        ],
        onSelectionReady: (service) => this.selectionReady(service),
      }),
    };
  }

  private columnDefs() {
    return userColumnDefs({
      attributes: this.attributes(),
      orgUnits: () => this.orgUnits().map((unit) => unit.path),
      onDetails: (row, node) => this.open(row, node),
      onOpen: (row, node) => this.openedRow(row, node),
      draft: this.draftOptions(),
    });
  }

  /**
   * The approved composition shows one header row, so a category group header has zero
   * height and draws no text (design state 01). The category name lives in the Columns panel.
   * Hide that empty row from assistive tech, so the accessibility tree never holds an empty
   * column header (UI-01), and make it inert, so keyboard focus never lands in it.
   */
  private hideGroupHeaderRow(): void {
    const host = this.host.nativeElement as HTMLElement;
    for (const row of host.querySelectorAll<HTMLElement>(
      '.ag-header-row-group',
    )) {
      if (row.getAttribute('aria-hidden') !== 'true')
        row.setAttribute('aria-hidden', 'true');
      if (!row.hasAttribute('inert')) row.setAttribute('inert', '');
    }
  }

  /** The header renders after the column set changes, so hide the group row next frame. */
  private scheduleGroupHeader(): void {
    requestAnimationFrame(() => {
      if (!this.destroyed) this.hideGroupHeaderRow();
    });
  }

  /** The draft reads and writes that the editable attribute columns call. */
  private draftOptions() {
    return {
      editable: () => this.editable(),
      value: (row: UserRow, column: UserAttributeColumn) =>
        this.draft.valueFor(row, column),
      entry: (userId: string, attribute: string) =>
        this.draft.entryFor(userId, attribute),
      reason: (entry: UserAttributeDraftEntry) => this.draft.reasonFor(entry),
      onRevert: (userId: string, attribute: string) =>
        this.draft.revert(userId, attribute),
    };
  }

  /**
   * Stop the active editor before Save changes reads the draft. The live input already
   * reached the draft, so Commit live keeps it (DRAFT-02).
   */
  endEdit(): void {
    this.api?.stopEditing();
    this.endLiveEdit();
  }

  /**
   * Validate and stage an edit request. With readOnlyEdit the row data keeps its value, and
   * the cell renderer shows the draft value instead (DRAFT-02).
   */
  private stageEdit(event: CellEditRequestEvent<UserRow>): void {
    if (!this.editable() || !event.data || event.node.group) return;
    const column = attributeFor(this.attributes(), event.column.getColId());
    if (!column) return;
    const raw = event.newValue;
    if (column.field.fieldType === 'BOOL') {
      // The boolean editor answers Yes, No, or Clear value. No is a value, never an empty
      // cell, and a clear request stays a Clear (B section 12, R1-G).
      if (raw === null || raw === undefined || raw === ATTRIBUTE_BOOL_CLEAR) {
        this.draft.stageBool(event.data, column, null);
        return;
      }
      this.draft.stageBool(
        event.data,
        column,
        raw === true || raw === 'Yes' || raw === 'true',
      );
      return;
    }
    this.draft.stageText(
      event.data,
      column,
      raw === null || raw === undefined ? '' : String(raw),
    );
  }

  /** Count the changed input of an open editor before it stages (DRAFT-02). */
  private beginLiveEdit(event: CellEditingStartedEvent<UserRow>): void {
    if (!this.editable() || !event.data || event.node.group) return;
    const column = attributeFor(this.attributes(), event.column.getColId());
    if (!column) return;
    const cell = cellFor(event.data, column);
    this.draft.beginLive({
      userId: cell.userId,
      userName: cell.userName,
      attribute: cell.attribute,
      label: cell.label,
      fieldType: cell.fieldType,
      multiValued: cell.multiValued,
      minValue: cell.minValue,
      maxValue: cell.maxValue,
      // A re-edit keeps the baseline that the first edit began with (R1-D).
      baseline: this.draft.baselineFor(event.data, column),
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

  /** The open editor's input bubbles from the cell. */
  private attachLiveInput(): void {
    this.detachLiveInput();
    const listener = (event: Event) => {
      const target = event.target;
      if (target instanceof HTMLInputElement)
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

  /** Enter and F2 open a date or list cell. Shift+Enter reverts a pending cell. */
  private cellKeyDown(
    event: CellKeyDownEvent<UserRow> | FullWidthCellKeyDownEvent<UserRow>,
  ): void {
    const keyboard = event.event as KeyboardEvent | null;
    if (!keyboard || !('column' in event) || !event.data || event.node.group) {
      detailsKeyHandler((row, node) => this.open(row, node))(event);
      return;
    }
    const column = attributeFor(this.attributes(), event.column.getColId());
    if (column) {
      if (
        (keyboard.key === 'Enter' || keyboard.key === 'F2') &&
        cellOpensDialog(column)
      ) {
        keyboard.preventDefault();
        this.openCellDialog(event.data, column);
        return;
      }
      if (
        keyboard.key === 'Enter' &&
        keyboard.shiftKey &&
        !event.event?.defaultPrevented &&
        this.draft.entryFor(event.data.userId, column.id)
      ) {
        keyboard.preventDefault();
        keyboard.stopPropagation();
        this.draft.revert(event.data.userId, column.id);
        return;
      }
    }
    detailsKeyHandler((row, node) => this.open(row, node))(event);
  }

  private openCellDialogFromEvent(
    event: CellDoubleClickedEvent<UserRow>,
  ): void {
    if (!this.editable() || !event.data || event.node.group) return;
    const column = attributeFor(this.attributes(), event.column.getColId());
    if (!column || !cellOpensDialog(column)) return;
    event.event?.preventDefault();
    this.openCellDialog(event.data, column);
  }

  /** Open the date picker or the list editor of one cell (B section 12). */
  private openCellDialog(row: UserRow, column: UserAttributeColumn): void {
    if (!this.editable()) return;
    this.endEdit();
    this.cellDialog.set({
      row,
      column,
      value: this.cellEditorValue(row, column),
      userName: row.fullName || row.primaryEmail,
    });
  }

  /** The value that a dialog editor opens with: the pending value over the row value. */
  private cellEditorValue(
    row: UserRow,
    column: UserAttributeColumn,
  ): string | string[] {
    const entry = this.draft.entryFor(row.userId, column.id);
    const value = entry ? entry.value : cellFor(row, column).value;
    if (Array.isArray(value)) return value.map((item) => String(item));
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    return value ?? '';
  }

  protected closeCellDialog(): void {
    const open = this.cellDialog();
    this.cellDialog.set(null);
    if (open) this.refocusCell(open.row.userId, open.column.id);
  }

  protected stageCellDialog(value: string | string[]): void {
    const open = this.cellDialog();
    if (!open) return;
    this.cellDialog.set(null);
    if (Array.isArray(value))
      this.draft.stageList(open.row, open.column, value);
    else this.draft.stageText(open.row, open.column, value);
    this.refocusCell(open.row.userId, open.column.id);
  }

  /** Clear value is its own field operation (B section 12). */
  protected clearCellDialog(): void {
    const open = this.cellDialog();
    if (!open) return;
    this.cellDialog.set(null);
    this.draft.stageClear(open.row, open.column);
    this.refocusCell(open.row.userId, open.column.id);
  }

  /** Return focus to the cell that opened a dialog (UI-09). */
  private refocusCell(userId: string, attribute: string): void {
    afterNextRender(
      () => {
        const node = this.api?.getRowNode(userId);
        if (node?.rowIndex === null || node?.rowIndex === undefined) return;
        this.api?.setFocusedCell(node.rowIndex, attribute);
      },
      { injector: this.injector },
    );
  }

  private refreshDraftCells(): void {
    this.api?.refreshCells?.({ force: true, suppressFlash: true });
  }

  /**
   * Switch between the person's query and the pending view. The pending view is flat: its
   * rows ignore the person's filters (DRAFT-02). Neither switch touches the draft.
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
      api.setFilterModel(null);
      this.switching = false;
    }
    this.pendingViewIds = ids;
    // Select All of the pending view names these users, never the directory (R1-A).
    const provider = this.selection().provider;
    if (provider instanceof UserSelectionProvider) provider.setPending(ids);
    const load = this.loadPending();
    if (!load) return;
    const key = { gridId: USER_GRID_ID, tabId: this.selection().tabId };
    const source = pendingUserDatasource(load, {
      key,
      resolve: (rowIds) =>
        this.selection().provider.resolveSelected({
          ...key,
          rowIds: [...rowIds],
          groupRoutes: [],
        }),
    });
    this.pendingSource = source;
    api.setGridOption('serverSideDatasource', source);
  }

  /** Put the person's query back: filters, predicates, and the query datasource. */
  private leavePendingView(): void {
    this.switching = true;
    this.pending = false;
    this.pendingViewIds = null;
    this.pendingSource = null;
    this.switching = false;
    // The query keeps the tab's selection, so its counts read again (R1-A).
    const provider = this.selection().provider;
    if (provider instanceof UserSelectionProvider) provider.setPending(null);
    this.applyPredicates(this.predicates());
    this.reload();
  }

  /** GRID-03: the details control opens the page, so the row is recorded first. */
  private open(row: UserRow, node: IRowNode<UserRow>): void {
    const index = node.rowIndex;
    if (index === null || index < 0) return;
    this.details.emit({ row, index, scrollTop: this.scrollTop() });
  }

  /** The Name link keeps its own navigation. The page records the row for Next user. */
  private openedRow(row: UserRow, node: IRowNode<UserRow>): void {
    const index = node.rowIndex;
    if (index === null || index < 0) return;
    this.opened.emit({ row, index, scrollTop: this.scrollTop() });
  }

  /** The body's vertical offset, so Back to users returns to the same view (A section 4). */
  private scrollTop(): number | null {
    const viewport = this.bodyViewport();
    return viewport ? Math.round(viewport.scrollTop) : null;
  }

  /** The element that scrolls the rows vertically. */
  private bodyViewport(): HTMLElement | null {
    return this.host.nativeElement.querySelector<HTMLElement>(
      '.ag-grid-viewport',
    );
  }

  protected ready(event: GridReadyEvent<UserRow>): void {
    this.api = event.api;
    this.started.set(true);
    this.scheduleGroupHeader();
    const refresh = this.rowRefresh();
    refresh?.attach(event.api);
    this.destroyRef.onDestroy(() => refresh?.detach(event.api));
    // A refresh that a save settles reaches the pending view's cache and the saved cells
    // (design K26). The rows keep their nodes, so the grid never reloads.
    const stop = refresh?.onApply((rows) => {
      this.pendingSource?.update(rows);
      this.draft.settleWithRows(rows);
    });
    if (stop) this.destroyRef.onDestroy(stop);
    this.applyPredicates(this.predicates());
    // A pending view that the page opened before the grid started reads now.
    const pending = this.pendingIds();
    if (pending?.length) this.applyPendingView(pending);
    else this.reload();
  }

  /** Setting a new datasource resets the server-side row model to its first block. */
  private reload(): void {
    this.datasourceReady = true;
    // The pending view reads its own rows. A revision must not swap the query back in.
    if (this.pending) {
      this.applyPendingView(this.pendingViewIds);
      return;
    }
    this.api?.setGridOption(
      'serverSideDatasource',
      userDatasource(
        (offset, limit, view) => this.load()(offset, limit, view),
        (page) => this.restore(page),
        { gridId: 'users', tabId: this.selection().tabId },
        () => this.attributes(),
        // Alias and has-a-value chips have no column filter. The query keeps them.
        () => this.keptPredicates,
        // The page shows the empty result and its recovery (R6).
        () => this.emptyFilter.emit(true),
      ),
    );
  }

  /**
   * Show the predicates as column filters. A chip that no column filter can show
   * changes the query alone, so the grid reloads without a model change (R4).
   */
  private applyPredicates(predicates: readonly UserPredicate[]): void {
    const api = this.api;
    if (!api) return;
    this.keptPredicates = predicates.filter(
      (predicate) => !gridExpresses(predicate),
    );
    const next = filterModelUpdate(
      api.getFilterModel(),
      predicates,
      this.attributes(),
    );
    if (next) {
      this.appliedPredicates = predicates;
      this.emptyFilter.emit(this.matchesNobody(next));
      api.setFilterModel(next);
      return;
    }
    if (samePredicates(this.appliedPredicates, predicates, this.attributes()))
      return;
    this.appliedPredicates = predicates;
    if (this.datasourceReady) api.refreshServerSide();
  }

  /** Whether a filter model matches no row, so the grid shows the empty result itself (R6). */
  private matchesNobody(model: FilterModel): boolean {
    try {
      predicatesFromFilterModel(model, this.attributes());
      return false;
    } catch (error) {
      return error instanceof EmptySetFilterError;
    }
  }

  private filtersChanged(): void {
    const api = this.api;
    if (!api) return;
    // The pending view's model is empty by design, so its change is not the person's filter.
    // The column rebuild restores the model that the person already set (R1-E).
    if (this.switching || this.restoringColumns) return;
    let modeled: UserPredicate[];
    try {
      modeled = predicatesFromFilterModel(
        api.getFilterModel(),
        this.attributes(),
      );
    } catch (error) {
      // A column filter with no value matches no row. The chips keep their own
      // predicates, and the page shows the empty result with filter recovery (R6).
      if (error instanceof EmptySetFilterError) this.emptyFilter.emit(true);
      // Otherwise the datasource fails the load for a model that no query can express.
      return;
    }
    // A column filter replaces the chip of its field, and a filter-only chip stays (R4).
    const next = mergeGridPredicates(modeled, this.predicates());
    this.keptPredicates = next.filter((predicate) => !gridExpresses(predicate));
    this.appliedPredicates = next;
    this.emptyFilter.emit(false);
    if (samePredicates(next, this.predicates(), this.attributes())) return;
    this.filtersChange.emit(next);
  }

  /** A block of rows arrived. Focus returns to the opening row once its cell exists. */
  private restore(page?: UserPage): void {
    if (this.restored || this.destroyed) return;
    const index = this.focusIndex();
    if (index === null || !page || page.matching <= index) return;
    this.placeFocus(index);
  }

  /**
   * UI-09: Back to users returns focus to the row that opened the details, at the page
   * and scroll position that held it (A section 4). A row outside the first block needs
   * the block that holds it, so a later block answer resumes this restoration (R4).
   */
  private placeFocus(index: number, attempt = 0): void {
    if (this.restored || this.destroyed || this.focusing) return;
    const api = this.api;
    if (!api) return;
    this.focusing = true;
    requestAnimationFrame(() => {
      this.focusing = false;
      if (this.restored || this.destroyed) return;
      // The row is usable once its control exists. A cell that still renders its
      // Angular content holds no focus target yet (R4).
      const button = this.detailsButton(index);
      this.revealRow(api, index);
      if (button) {
        // Focus must not scroll the grid away from the restored offset.
        button.focus({ preventScroll: true });
        this.restored = true;
        // The row model can still grow its scroll height for a frame or two. Keep the
        // saved offset until the layout settles, or a clamp shortens it (R3).
        this.settleScroll();
        return;
      }
      if (attempt < 30) this.placeFocus(index, attempt + 1);
    });
  }

  /** Reapplies the saved offset while the restored grid finishes its layout. */
  private settleScroll(remaining = 6): void {
    if (this.destroyed || remaining <= 0) return;
    requestAnimationFrame(() => {
      if (this.destroyed) return;
      this.applySavedScroll();
      this.settleScroll(remaining - 1);
    });
  }

  /** The grid offset that Back to users returns to, when the page holds it. */
  private applySavedScroll(): void {
    const top = this.focusScroll();
    const viewport = this.bodyViewport();
    if (top === null || !viewport) return;
    viewport.scrollTop = top;
  }

  /** The details control of one row, once the grid has rendered its content. */
  private detailsButton(index: number): HTMLElement | null {
    const cell = this.host.nativeElement.querySelector<HTMLElement>(
      `[row-index="${index}"] [col-id="details"]`,
    );
    return cell?.querySelector<HTMLElement>('button') ?? null;
  }

  /**
   * Bring the opening row into view. A page change centers it. A row on the restored
   * page returns to the saved offset instead of the center (R3).
   */
  private revealRow(api: GridApi<UserRow>, index: number): void {
    const page = Math.floor(index / api.paginationGetPageSize());
    if (page !== api.paginationGetCurrentPage()) {
      showRow(api, index);
      return;
    }
    const top = this.focusScroll();
    const viewport = this.bodyViewport();
    if (top === null || !viewport) {
      showRow(api, index);
      return;
    }
    viewport.scrollTop = top;
  }

  /**
   * UI-09: the side bar rebuilds its tab buttons when a panel closes, so focus drops to the body.
   * Return focus to the tab that opened the panel, after the rebuilt button exists.
   */
  private panelToggled(event: ToolPanelVisibleChangedEvent): void {
    if (event.visible || event.switchingToolPanel) return;
    requestAnimationFrame(() => {
      this.host.nativeElement
        .querySelector<HTMLElement>(`#lgr-side-bar-${event.key}-button`)
        ?.focus();
    });
  }

  /**
   * UI-09: record a move of a Columns panel row. The panel replaces its rows
   * when the column moves, so the row that held focus must take it back.
   */
  private trackMoveClick(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    // A click on the icon resolves to the button that holds the move label.
    const control = target.closest<HTMLElement>('button[aria-label]');
    if (!control || !control.closest('.lgr-columns-tool-panel')) return;
    const match = /^Move (.+) (up|down)$/.exec(
      control.getAttribute('aria-label') ?? '',
    );
    const row = control.closest<HTMLElement>('.lgr-columns-row');
    const columnId = row?.dataset['columnId'];
    if (!match || !columnId) return;
    this.panelMove = {
      columnId,
      direction: match[2] as 'up' | 'down',
    };
  }

  /** The panel rebuilt its rows after a move. Return focus to the moved row (UI-09). */
  private columnMoved(event: ColumnMovedEvent<UserRow>): void {
    const pending = this.panelMove;
    this.panelMove = null;
    if (!pending) return;
    const columnId = event.column?.getColId() ?? pending.columnId;
    if (columnId !== pending.columnId) return;
    requestAnimationFrame(() =>
      this.restoreMoveFocus(columnId, pending.direction),
    );
  }

  /**
   * Focus the same move control of the moved row, or the other move control when
   * the move disabled it, or the row's checkbox when both are disabled.
   */
  private restoreMoveFocus(
    columnId: string,
    direction: 'up' | 'down',
    attempt = 0,
  ): void {
    if (this.destroyed) return;
    const row = this.host.nativeElement.querySelector<HTMLElement>(
      `.lgr-columns-tool-panel .lgr-columns-row[data-column-id="${columnId}"]`,
    );
    if (!row) {
      if (attempt < 30)
        requestAnimationFrame(() =>
          this.restoreMoveFocus(columnId, direction, attempt + 1),
        );
      return;
    }
    const name = row.dataset['columnName'] ?? '';
    const moves = [
      ...row.querySelectorAll<HTMLButtonElement>(
        '.lgr-columns-row-actions button',
      ),
    ].filter(
      (button) =>
        !button.disabled &&
        (button.getAttribute('aria-label') ?? '').startsWith('Move '),
    );
    const target =
      moves.find(
        (button) =>
          button.getAttribute('aria-label') === `Move ${name} ${direction}`,
      ) ??
      moves[0] ??
      row.querySelector<HTMLInputElement>('input[type="checkbox"]');
    target?.focus();
  }

  /** The selection footer makes the status bar taller. Follow a later Show All Selected. */
  private selectionReady(service: SsrmSelectionService): void {
    this.selectionService = service;
    if (this.selectedView() && !service.isViewActive()) {
      service.enterViewMode();
      if (!service.isViewActive()) {
        this.api?.setGridOption('ssrmSelectionViewActive', false);
        this.api?.refreshServerSide();
      }
    }
  }

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

  /**
   * The API ended the selection. Leave Show All Selected so the grid requeries the
   * chosen dataset, or refresh the rows that the selection flags apply to (R10).
   */
  private selectionEnded(): void {
    const service = this.selectionService;
    if (!service) return;
    if (service.isViewActive()) {
      // Exiting the view turns the option off and requeries the rows.
      service.exitViewMode();
      this.selectedViewChange.emit(false);
      return;
    }
    service.refresh();
  }
}

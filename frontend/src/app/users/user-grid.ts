import {
  ApplicationRef,
  Component,
  DestroyRef,
  ElementRef,
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
  type ColumnMovedEvent,
  type FilterModel,
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
import { userColumnDefs } from './user-columns';
import {
  defaultGridState,
  savedGridState,
  userDatasource,
  type UserLoader,
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
import type { UserRowRefresh } from './user-row-refresh';
import type { UserAttributeColumn } from './user-fields';
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
  imports: [AgGridAngular],
  template: `
    <ag-grid-angular
      class="user-grid"
      [gridOptions]="options"
      (gridReady)="ready($event)"
    />
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

  private api: GridApi<UserRow> | null = null;
  private selectionService: SsrmSelectionService | null = null;
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
      untracked(() => this.applyPredicates(predicates));
    });
    // The category read adds the attribute columns after the grid starts.
    effect(() => {
      const attributes = this.attributes();
      untracked(() => {
        if (!this.api || !attributes.length) return;
        this.api.setGridOption('columnDefs', this.columnDefs());
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
      onColumnMoved: (event) => this.columnMoved(event),
      onToolPanelVisibleChanged: (event) => this.panelToggled(event),
      onCellKeyDown: (event) =>
        detailsKeyHandler((row, node) => this.open(row, node))(event),
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
    });
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
    const refresh = this.rowRefresh();
    refresh?.attach(event.api);
    this.destroyRef.onDestroy(() => refresh?.detach(event.api));
    this.applyPredicates(this.predicates());
    this.reload();
  }

  /** Setting a new datasource resets the server-side row model to its first block. */
  private reload(): void {
    this.datasourceReady = true;
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

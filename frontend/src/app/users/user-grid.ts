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
  type FilterModel,
  type GridApi,
  type GridOptions,
  type GridReadyEvent,
  type GridState,
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
import { userGridFeatures } from './user-grid-options';
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
       (state 02, R13). The pin and move controls are not in that composition, and
       they truncate the labels at the approved 258 px width. */
    :host ::ng-deep .lgr-columns-row-actions {
      display: none;
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
  }

  ngOnInit(): void {
    const panel = createComponent(UserStatusPanel, {
      environmentInjector: this.environment,
      elementInjector: this.injector,
      hostElement: this.status,
    });
    this.application.attachView(panel.hostView);
    this.destroyRef.onDestroy(() => panel.destroy());
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
    });
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
        () => this.restore(),
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

  private restore(): void {
    // K10 holds no row position to restore.
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

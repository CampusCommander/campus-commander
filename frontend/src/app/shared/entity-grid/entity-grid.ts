import {
  Component,
  computed,
  effect,
  inject,
  input,
  model,
  output,
  signal,
  viewChild,
  ViewContainerRef,
  type ComponentRef,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatMenuModule } from '@angular/material/menu';
import { DataRegion, type DataRegionState } from '../data-region/data-region';
import { FilterChip } from '../filter-chip/filter-chip';
import {
  DEFAULT_FILTER_OPERATORS,
  type EntityGridBulkAction,
  type EntityGridConfig,
  type EntityGridFilter,
} from './entity-grid-config';
import {
  EntityGridViewportLoader,
  type EntityGridViewportOutputs,
} from './entity-grid-viewport-loader';

const CONTENT_STATES = new Set(['ready', 'partial', 'stale', 'offline']);

interface FilterEntry {
  fieldId: string;
  operator: string;
  value: string;
}

/**
 * Entity grid bridge. Composes the GRID-01 anatomy: filter/action row,
 * conditional draft panel, entity viewport, and persistent grid footer.
 * The viewport mounts the qualified LibreGrid renderer through a lazy seam.
 * Batch editing stays disabled until GRID-05 qualification completes.
 */
@Component({
  selector: 'app-entity-grid',
  imports: [DataRegion, FilterChip, MatButtonModule, MatMenuModule],
  templateUrl: './entity-grid.html',
  styleUrl: './entity-grid.css',
})
export class EntityGrid<TRow = unknown> {
  readonly config = input.required<EntityGridConfig<TRow>>();
  readonly state = input.required<DataRegionState>();
  readonly rows = input<TRow[]>([]);
  readonly dataSource = input<unknown | null>(null);
  readonly selectionProvider = input<unknown | null>(null);

  /** Active filter predicates. Chips render field, operator, and value. */
  readonly filters = model<EntityGridFilter[]>([]);

  /** API-provided selected count. Falls back to the local explicit selection. */
  readonly selectedCount = input<number | null>(null);
  /** Original criteria for an all-filtered selection (SELECT-01). */
  readonly selectionScope = input<string | null>(null);
  readonly showSelectedOnly = input(false);
  readonly selectionExpired = input(false);
  readonly draftPanelVisible = input(false);

  readonly detailNavigation = output<string>();
  readonly filterAdded = output<EntityGridFilter>();
  readonly filterRemoved = output<EntityGridFilter>();
  readonly filtersCleared = output<void>();
  readonly refreshSelected = output<void>();
  readonly refreshAll = output<void>();
  readonly bulkAction = output<EntityGridBulkAction>();
  readonly selectAll = output<void>();
  readonly deselectAll = output<void>();
  readonly showAllSelected = output<void>();
  readonly showAllRows = output<void>();
  readonly retry = output<void>();
  readonly refresh = output<void>();
  readonly reconnect = output<void>();

  private readonly viewportLoader = inject(EntityGridViewportLoader);
  private readonly viewportContainer = viewChild('viewport', {
    read: ViewContainerRef,
  });

  /** Data columns in contract order. Selection and details columns are implicit. */
  readonly visibleColumns = computed(() => this.config().columns);

  protected readonly filterableColumns = computed(() =>
    this.config().columns.filter((column) => column.filterable),
  );

  protected readonly entry = signal<FilterEntry | null>(null);
  protected readonly addingFilter = computed(() => this.entry() !== null);

  protected readonly entryFields = computed(() =>
    this.filterableColumns().map((column) => ({
      fieldId: column.fieldId,
      label: column.label,
    })),
  );

  protected readonly localSelectionIds = signal<ReadonlySet<string>>(new Set());

  protected readonly footerCount = computed(
    () => this.selectedCount() ?? this.localSelectionIds().size,
  );

  protected readonly hasSelection = computed(() => this.footerCount() > 0);

  private viewportRef: ComponentRef<unknown> | null = null;
  private mounting = false;

  constructor() {
    effect(() => {
      const state = this.state();
      const rows = this.rows();
      const dataSource = this.dataSource();
      const selectionProvider = this.selectionProvider();
      const container = this.viewportContainer();
      if (!container) {
        return;
      }
      if (this.viewportRef) {
        this.viewportRef.setInput('rows', rows);
        this.viewportRef.setInput('dataSource', dataSource);
        this.viewportRef.setInput('selectionProvider', selectionProvider);
        return;
      }
      if (CONTENT_STATES.has(state.status) && !this.mounting) {
        void this.mountViewport(container);
      }
    });
  }

  protected entryOperators(): string[] {
    const entry = this.entry();
    if (!entry?.fieldId) {
      return [];
    }
    const column = this.config().columns.find(
      (candidate) => candidate.fieldId === entry.fieldId,
    );
    if (!column) {
      return [];
    }
    return (
      this.config().filterOperators?.[column.dataType] ??
      DEFAULT_FILTER_OPERATORS[column.dataType]
    );
  }

  protected entryValid(): boolean {
    const entry = this.entry();
    if (!entry?.fieldId || !entry.operator) {
      return false;
    }
    if (entry.operator === 'is-unset' || entry.operator === 'is-set') {
      return true;
    }
    return entry.value.trim().length > 0;
  }

  protected beginFilterEntry(): void {
    this.entry.set({ fieldId: '', operator: '', value: '' });
  }

  protected cancelFilterEntry(): void {
    this.entry.set(null);
  }

  protected updateEntry(patch: Partial<FilterEntry>): void {
    const current = this.entry();
    if (current) {
      this.entry.set({ ...current, ...patch });
    }
  }

  protected applyFilterEntry(): void {
    const entry = this.entry();
    if (!entry || !this.entryValid()) {
      return;
    }
    const column = this.filterableColumns().find(
      (candidate) => candidate.fieldId === entry.fieldId,
    );
    if (!column) {
      return;
    }
    const filter: EntityGridFilter = {
      fieldId: column.fieldId,
      fieldLabel: column.label,
      operator: entry.operator,
      valueLabel: entry.value,
    };
    this.filters.update((filters) => [...filters, filter]);
    this.entry.set(null);
    this.filterAdded.emit(filter);
  }

  protected removeFilter(filter: EntityGridFilter): void {
    this.filters.update((filters) =>
      filters.filter((candidate) => candidate !== filter),
    );
    this.filterRemoved.emit(filter);
  }

  /** Clear filters preserves selection, drafts, and sorting (GRID-04). */
  protected clearFilters(): void {
    this.filters.set([]);
    this.filtersCleared.emit();
  }

  private async mountViewport(container: ViewContainerRef): Promise<void> {
    this.mounting = true;
    try {
      const component = await this.viewportLoader.load();
      if (this.viewportRef) {
        return;
      }
      const ref = container.createComponent(component);
      ref.setInput('config', this.config());
      ref.setInput('rows', this.rows());
      ref.setInput('dataSource', this.dataSource());
      ref.setInput('selectionProvider', this.selectionProvider());
      const outputs = ref.instance as EntityGridViewportOutputs;
      outputs.detailsRequested.subscribe((stableId) =>
        this.detailNavigation.emit(stableId),
      );
      outputs.rowSelectionChange.subscribe((ids) => {
        this.localSelectionIds.set(ids);
      });
      this.viewportRef = ref;
    } finally {
      this.mounting = false;
    }
  }
}

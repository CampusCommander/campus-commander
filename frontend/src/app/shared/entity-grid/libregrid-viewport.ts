import { Component, computed, input, output } from '@angular/core';
import { AgGridAngular } from 'ag-grid-angular';
import {
  AllCommunityModule,
  ModuleRegistry,
  themeQuartz,
  type GridApi,
  type GridOptions,
  type GridReadyEvent,
  type IServerSideDatasource,
  type SelectionChangedEvent,
} from 'ag-grid-community';
import { ServerSideRowModelModule } from '@libregrid/server-side-row-model';
import {
  ServerSideSelectionModule,
  type ServerSideSelectionProvider,
} from '@libregrid/server-side-selection';
import type { EntityGridConfig } from './entity-grid-config';
import { toColumnDefs } from './libregrid-column-defs';

// Qualified set per GRID-02 (2026-09-16): LibreGrid 1.3.4 on AG Grid Community 36.2.0.
// Registration lives in this lazy chunk so the vendor library stays out of
// the initial bundle. Do not move registration into application bootstrap.
ModuleRegistry.registerModules([
  AllCommunityModule,
  ServerSideRowModelModule,
  ServerSideSelectionModule,
]);

const GRID_ROW_HEIGHT = Number.parseInt(
  getComputedStyle(document.documentElement).getPropertyValue(
    '--cc-row-height-grid',
  ),
  10,
);

/**
 * Qualified LibreGrid renderer for the entity grid bridge.
 * Server-side row model by default (GRID-01). Client rows render only when a
 * page passes `rows` without a `dataSource`, which suits tests and fixtures.
 */
@Component({
  selector: 'app-libregrid-viewport',
  imports: [AgGridAngular],
  template: `
    <ag-grid-angular
      class="entity-grid-ag"
      [gridOptions]="gridOptions()"
      [rowData]="rowData()"
      (gridReady)="onGridReady($event)"
      (selectionChanged)="onSelectionChanged($event)"
    />
  `,
  styles: `
    :host {
      display: block;
      height: 100%;
      min-height: calc(var(--cc-row-height-grid) * 8);
    }
    .entity-grid-ag {
      display: block;
      height: 100%;
    }
    :host ::ng-deep .entity-grid-numeric {
      font-variant-numeric: tabular-nums;
    }
    :host ::ng-deep .entity-grid-code {
      font-family: var(--cc-font-code-family);
      font-size: var(--cc-font-code-size);
      line-height: var(--cc-font-code-line-height);
    }
  `,
})
export class LibreGridViewport<TRow = unknown> {
  readonly config = input.required<EntityGridConfig<TRow>>();
  readonly rows = input<TRow[]>([]);
  readonly dataSource = input<IServerSideDatasource<TRow> | null>(null);
  readonly selectionProvider = input<ServerSideSelectionProvider | null>(null);

  readonly detailsRequested = output<string>();
  readonly rowSelectionChange = output<ReadonlySet<string>>();
  readonly gridReady = output<GridApi<TRow>>();

  protected readonly theme = themeQuartz.withParams({
    accentColor: 'var(--cc-accent)',
    backgroundColor: 'var(--cc-surface-card)',
    headerBackgroundColor: 'var(--cc-surface-app)',
    borderColor: 'var(--cc-border)',
    foregroundColor: 'var(--cc-text-primary)',
    rowHeight: Number.isFinite(GRID_ROW_HEIGHT) ? GRID_ROW_HEIGHT : 32,
    fontFamily: 'var(--cc-font-body-family)',
    fontSize: 'var(--cc-font-caption-size)',
  });

  protected readonly rowData = computed(() =>
    this.dataSource() ? undefined : this.rows(),
  );

  protected readonly gridOptions = computed<GridOptions<TRow>>(() => {
    const config = this.config();
    const dataSource = this.dataSource();
    const provider = this.selectionProvider();
    const options: GridOptions<TRow> = {
      theme: this.theme,
      columnDefs: toColumnDefs(config, (stableId) =>
        this.detailsRequested.emit(stableId),
      ),
      getRowId: ({ data }) => config.getRowId(data),
      rowSelection: {
        mode: 'multiRow',
        // Header checkbox covers the current viewport only (SELECT-01).
        // The durable footer Select All captures the full filtered scope.
        selectAll: 'currentPage',
        checkboxes: true,
        headerCheckbox: true,
      },
      rowModelType: dataSource ? 'serverSide' : 'clientSide',
      serverSideDatasource: dataSource ?? undefined,
    };
    // The selection provider persists the selection specification server-side.
    // Wire it only when the backend contract supplies one (SELECT-01).
    if (dataSource && provider) {
      (options as Record<string, unknown>)['ssrmSelection'] = {
        provider,
        gridId: config.gridId,
        tabId: 'default',
      };
    }
    return options;
  });

  protected onGridReady(event: GridReadyEvent<TRow>): void {
    this.gridReady.emit(event.api);
  }

  protected onSelectionChanged(event: SelectionChangedEvent<TRow>): void {
    const config = this.config();
    const ids = new Set<string>();
    for (const node of event.selectedNodes ?? []) {
      if (node.data) {
        ids.add(config.getRowId(node.data));
      }
    }
    this.rowSelectionChange.emit(ids);
  }
}

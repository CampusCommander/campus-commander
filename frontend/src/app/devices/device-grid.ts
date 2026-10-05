import { Component, effect, input, output, untracked } from '@angular/core';
import { AgGridAngular } from 'ag-grid-angular';
import {
  AllCommunityModule,
  ModuleRegistry,
  themeQuartz,
  type GridApi,
  type GridOptions,
  type GridReadyEvent,
} from 'ag-grid-community';
import { ServerSideRowModelModule } from '@libregrid/server-side-row-model';
import type { DeviceRow } from '@campus/application-contracts';
import { deviceColumnDefs } from './device-columns';
import { deviceDatasource, type DeviceLoader } from './device-datasource';
import type { OptionalDeviceColumn } from './devices.store';

ModuleRegistry.registerModules([AllCommunityModule, ServerSideRowModelModule]);

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
export class DeviceGrid {
  readonly load = input.required<DeviceLoader>();
  readonly revision = input(0);
  readonly optionalColumns = input<Record<OptionalDeviceColumn, boolean>>({
    annotatedLocation: false,
    notes: false,
  });
  /** Row to scroll into view after the first block loads, such as after Back to devices. */
  readonly focusIndex = input<number | null>(null);
  readonly details = output<{ row: DeviceRow; index: number }>();
  readonly rangeChange = output<DeviceRange | null>();

  private api: GridApi<DeviceRow> | null = null;
  private focused = false;
  protected readonly options: GridOptions<DeviceRow> = {
    theme: themeQuartz.withParams({
      accentColor: 'var(--cc-accent)',
      backgroundColor: 'var(--cc-surface-card)',
      headerBackgroundColor: 'var(--cc-surface-app)',
      borderColor: 'var(--cc-border)',
      foregroundColor: 'var(--cc-text-primary)',
    }),
    columnDefs: deviceColumnDefs((row, index) =>
      this.details.emit({ row, index }),
    ),
    getRowId: ({ data }) => data.deviceId,
    rowModelType: 'serverSide',
    cacheBlockSize: 100,
    maxBlocksInCache: 20,
  };

  constructor() {
    effect(() => {
      this.revision();
      untracked(() => this.reload());
    });
    effect(() => {
      const columns = this.optionalColumns();
      untracked(() => this.applyColumns(columns));
    });
  }

  protected ready(event: GridReadyEvent<DeviceRow>): void {
    this.api = event.api;
    this.applyColumns(this.optionalColumns());
    this.reload();
  }

  /** Setting a new datasource resets the server-side row model to its first block. */
  private reload(): void {
    this.api?.setGridOption(
      'serverSideDatasource',
      deviceDatasource((offset, limit, sort) =>
        this.load()(offset, limit, sort),
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

  protected updated(): void {
    const index = this.focusIndex();
    if (
      !this.focused &&
      index !== null &&
      this.api &&
      this.api.getDisplayedRowCount() > 0
    ) {
      this.focused = true;
      this.api.ensureIndexVisible(index, 'middle');
    }
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

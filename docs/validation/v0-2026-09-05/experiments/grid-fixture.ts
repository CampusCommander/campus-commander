// Disposable compiler fixture. It does not implement the application grid.
import { Component, signal } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { AgGridAngular } from 'ag-grid-angular';
import { type GridApi, type GridReadyEvent } from 'ag-grid-community';
import { createGridApiSignals, defineGridOptions, provideLibreGrid, withCommunityModules } from '@libregrid/angular';
import { ServerSideRowModelModule } from '@libregrid/server-side-row-model';
import { ServerSideSelectionModule } from '@libregrid/server-side-selection';
import { provideLibreGridMaterialTheme } from '@libregrid/material';

interface Device { id: string; serial: string; location: string; }

@Component({
  selector: 'v0-grid',
  standalone: true,
  imports: [AgGridAngular],
  template: '<ag-grid-angular [gridOptions]="options" (gridReady)="ready($event)" />',
})
export class GridFixture {
  readonly api = signal<GridApi<Device> | undefined>(undefined);
  readonly state = createGridApiSignals(this.api);
  readonly options = defineGridOptions<Device>({
    rowModelType: 'serverSide',
    getRowId: ({ data }) => data.id,
    columnDefs: [{ field: 'serial' }, { field: 'location', editable: true }],
    rowSelection: { mode: 'multiRow' },
    serverSideDatasource: {
      getRows(params) {
        params.success({ rowData: [{ id: 'device-1', serial: 'TEST001', location: 'Library' }], rowCount: 1 });
      },
    },
  });
  ready(event: GridReadyEvent<Device>) { this.api.set(event.api); }
}

void bootstrapApplication(GridFixture, {
  providers: [provideLibreGrid(...withCommunityModules(ServerSideRowModelModule, ServerSideSelectionModule)), provideLibreGridMaterialTheme()],
});

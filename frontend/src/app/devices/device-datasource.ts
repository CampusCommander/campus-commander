import type {
  IServerSideDatasource,
  IServerSideGetRowsParams,
} from 'ag-grid-community';
import type {
  DevicePage,
  DeviceQuery,
  DeviceRow,
} from '@campus/application-contracts';
import { DEVICE_FIELDS } from './device-fields';

export type DeviceSort = DeviceQuery['sort'];
export type DeviceLoader = (
  offset: number,
  limit: number,
  sort: DeviceSort,
) => Promise<DevicePage | null>;

const defaultSort: DeviceSort = { field: 'serialNumber', direction: 'asc' };

export function sortFromModel(
  model: readonly { colId: string; sort: 'asc' | 'desc' }[] | undefined,
): DeviceSort {
  const first = model?.[0];
  const field = DEVICE_FIELDS.find(
    (candidate) => candidate.id === first?.colId,
  );
  return field && first
    ? { field: field.id, direction: first.sort }
    : defaultSort;
}

/** Adapt LibreGrid block requests to the device query endpoint (GRID-01). */
export function deviceDatasource(
  load: DeviceLoader,
): IServerSideDatasource<DeviceRow> {
  return {
    getRows(params: IServerSideGetRowsParams<DeviceRow>) {
      const offset = params.request.startRow ?? 0;
      const limit = Math.min(
        200,
        Math.max(1, (params.request.endRow ?? offset + 100) - offset),
      );
      load(offset, limit, sortFromModel(params.request.sortModel)).then(
        (page) =>
          page
            ? params.success({ rowData: page.rows, rowCount: page.matching })
            : params.fail(),
        () => params.fail(),
      );
    },
  };
}

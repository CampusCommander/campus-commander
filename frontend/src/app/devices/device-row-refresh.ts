import type { GridApi } from 'ag-grid-community';
import type { DeviceRow } from '@campus/application-contracts';

type RowApi = Pick<GridApi<DeviceRow>, 'forEachNode' | 'getRowNode'>;

/** The device rows that the grid holds. Refresh signals update them in place (D7). */
export class DeviceRowRefresh {
  private api: RowApi | null = null;

  attach(api: RowApi): void {
    this.api = api;
  }

  detach(api: RowApi): void {
    if (this.api === api) this.api = null;
  }

  /** IDs of loaded device rows that pass `test`. Group rows carry no device. */
  held(test: (row: DeviceRow) => boolean = () => true): string[] {
    const ids: string[] = [];
    this.api?.forEachNode((node) => {
      if (!node.group && node.data && test(node.data))
        ids.push(node.data.deviceId);
    });
    return ids;
  }

  /** Replace the data of loaded rows. LibreGrid refreshes their cells. */
  apply(rows: readonly DeviceRow[]): void {
    for (const row of rows) {
      const node = this.api?.getRowNode(row.deviceId);
      if (node && !node.group) node.updateData(row);
    }
  }
}

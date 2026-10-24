import type { GridApi } from 'ag-grid-community';
import type { DeviceRow } from '@campus/application-contracts';

type RowApi = Pick<GridApi<DeviceRow>, 'forEachNode' | 'getRowNode'>;

/** Receives the refreshed records after they replace the held grid nodes. */
export type DeviceRowApplied = (rows: readonly DeviceRow[]) => void;

/** The device rows that the grid holds. Refresh signals update them in place (D7). */
export class DeviceRowRefresh {
  private api: RowApi | null = null;
  private readonly listeners = new Set<DeviceRowApplied>();

  attach(api: RowApi): void {
    this.api = api;
  }

  detach(api: RowApi): void {
    if (this.api === api) this.api = null;
  }

  /** Listen for refreshed records. The grid's cached reads follow them. Returns an undo. */
  onApply(listener: DeviceRowApplied): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
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
    // A cached read reuses its first answer, so it needs the same observation.
    for (const listener of this.listeners) listener(rows);
  }
}

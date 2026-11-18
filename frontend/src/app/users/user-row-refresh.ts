import type { GridApi } from 'ag-grid-community';
import type { UserRow } from '@campus/application-contracts';

type RowApi = Pick<GridApi<UserRow>, 'forEachNode' | 'getRowNode'>;

/** Receives the refreshed records after they replace the held grid nodes. */
export type UserRowApplied = (rows: readonly UserRow[]) => void;

/** The user rows that the grid holds. Refresh signals update them in place (D7). */
export class UserRowRefresh {
  private api: RowApi | null = null;
  /** Bumps when a grid attaches or detaches. An answer of the earlier grid never lands. */
  private attachment = 0;

  attach(api: RowApi): void {
    this.api = api;
    this.attachment++;
  }

  detach(api: RowApi): void {
    if (this.api !== api) return;
    this.api = null;
    this.attachment++;
  }

  /** The attachment that a by-ids request belongs to. */
  current(): number {
    return this.attachment;
  }

  /** IDs of loaded user rows that pass `test`. */
  held(test: (row: UserRow) => boolean = () => true): string[] {
    const ids: string[] = [];
    this.api?.forEachNode((node) => {
      if (!node.group && node.data && test(node.data))
        ids.push(node.data.userId);
    });
    return ids;
  }

  /**
   * Replace the data of loaded rows. An answer older than the held record, or one
   * for a grid that left, changes nothing (R8).
   */
  apply(rows: readonly UserRow[], attachment = this.attachment): void {
    if (attachment !== this.attachment) return;
    for (const row of rows) {
      const node = this.api?.getRowNode(row.userId);
      if (!node || node.group || !node.data) continue;
      if (row.recordVersion < node.data.recordVersion) continue;
      node.updateData(row);
    }
  }
}

import type { ColDef } from 'ag-grid-community';
import { EntityGridDetailsCell } from './details-cell';
import type { EntityGridConfig } from './entity-grid-config';

export const DETAILS_COLUMN_ID = 'details';

/**
 * Maps the repository field contract onto vendor column definitions.
 * Column order follows entity-grid-fields.json: selection (vendor checkbox
 * column), details, then data columns in config order.
 *
 * GRID-05: every data column renders read-only. `inGridEditor` is repository
 * metadata, not a LibreGrid option. Do not enable editors until server-side
 * batch-edit qualification completes.
 */
export function toColumnDefs<TRow>(
  config: EntityGridConfig<TRow>,
  onDetails: (stableId: string) => void,
): ColDef<TRow>[] {
  const details: ColDef<TRow> = {
    colId: DETAILS_COLUMN_ID,
    headerName: '',
    width: 48,
    minWidth: 48,
    maxWidth: 48,
    pinned: 'left',
    lockVisible: true,
    suppressMovable: true,
    sortable: false,
    filter: false,
    cellRenderer: EntityGridDetailsCell,
    cellRendererParams: {
      getRowId: config.getRowId,
      entityLabel: config.entityLabel,
      onDetails,
    },
  };

  const dataColumns: ColDef<TRow>[] = config.columns.map((column) => ({
    colId: column.fieldId,
    headerName: column.label,
    valueGetter: ({ data }) => (data ? column.value(data) : null),
    editable: false,
    hide: column.defaultVisible === false,
    sortable: true,
    filter: column.filterable,
    cellClass: column.dataType === 'number'
      ? 'entity-grid-numeric'
      : column.code
        ? 'entity-grid-code'
        : undefined,
  }));

  return [details, ...dataColumns];
}

/**
 * Editor metadata per field, carried beside the grid rather than inside
 * vendor options. Null declares a read-only column.
 */
export function editorMetadata<TRow>(
  config: EntityGridConfig<TRow>,
): Record<string, string | null> {
  return Object.fromEntries(
    config.columns.map((column) => [column.fieldId, column.inGridEditor]),
  );
}

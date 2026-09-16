/**
 * Bridge configuration shaped by docs/ui/entity-grid-fields.json.
 * These types are repository metadata. They are not LibreGrid or AG Grid options.
 */
export type EntityGridDataType =
  | 'text'
  | 'multilineText'
  | 'number'
  | 'date'
  | 'dateTime'
  | 'enum'
  | 'boolean'
  | 'orgUnit';

export interface EntityGridColumn<TRow> {
  fieldId: string;
  label: string;
  dataType: EntityGridDataType;
  /**
   * Editor identifier or explicit null from the field contract.
   * Null declares a read-only column. It does not describe the cell value.
   * Editors stay disabled until GRID-05 server-side qualification completes.
   */
  inGridEditor: string | null;
  filterable: boolean;
  defaultVisible?: boolean;
  /** Render with the code type role for technical identifiers (UI-04). */
  code?: boolean;
  value(row: TRow): unknown;
}

export interface EntityGridFilter {
  fieldId: string;
  fieldLabel: string;
  operator: string;
  valueLabel: string;
}

export interface EntityGridBulkAction {
  id: string;
  label: string;
  disabled?: boolean;
  disabledReason?: string;
}

export interface EntityGridConfig<TRow> {
  /** Stable grid identity. Used as the selection storage key by the vendor layer. */
  gridId: string;
  /** Data columns in display order. Selection and details columns are implicit. */
  columns: EntityGridColumn<TRow>[];
  /** Stable entity identity. Drives row identity, drafts, and selection. */
  getRowId(row: TRow): string;
  /** Readable identity used in accessible names. */
  entityLabel(row: TRow): string;
  bulkActions: EntityGridBulkAction[];
  /** Operators offered per datatype. Production pages pass the qualified query contract. */
  filterOperators?: Partial<Record<EntityGridDataType, string[]>>;
}

/**
 * Interim operators until the qualified query contract supplies its own list.
 * Offer only operators the field contract supports once that contract is wired.
 */
export const DEFAULT_FILTER_OPERATORS: Record<EntityGridDataType, string[]> = {
  text: ['contains', 'equals', 'is-unset', 'is-set'],
  multilineText: ['contains', 'is-unset', 'is-set'],
  number: ['equals', 'greater-than', 'less-than', 'is-unset', 'is-set'],
  date: ['on', 'before', 'after', 'is-unset', 'is-set'],
  dateTime: ['before', 'after', 'is-unset', 'is-set'],
  enum: ['is', 'is-not'],
  boolean: ['is-true', 'is-false'],
  orgUnit: ['is', 'is-descendant-of'],
};

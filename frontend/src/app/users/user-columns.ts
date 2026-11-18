import type {
  ColDef,
  ColGroupDef,
  IFilterOptionDef,
  IRowNode,
} from 'ag-grid-community';
import type { UserRow } from '@campus/application-contracts';
import { UserDetailsCell } from './user-details-cell';
import { UserNameCell } from './user-name-cell';
import {
  STATUS_LABELS,
  TWO_STEP_LABELS,
  USER_FIELDS,
  attributeText,
  statusValue,
  twoStepValue,
  type UserAttributeColumn,
  type UserField,
} from './user-fields';
import { orgUnitTreePath } from './user-filter-model';

const filterButtons = { buttons: ['apply', 'reset'], closeOnApply: true };
/** The users query applies these filters. Rows the grid holds already match. */
const serverSide = () => true;
const dateOptions: IFilterOptionDef[] = [
  {
    displayKey: 'before',
    displayName: 'Before',
    predicate: serverSide,
    numberOfInputs: 1,
  },
  {
    displayKey: 'after',
    displayName: 'On or after',
    predicate: serverSide,
    numberOfInputs: 1,
  },
];

/** The display text of one static cell. */
function text(row: UserRow, id: string): string {
  switch (id) {
    case 'fullName':
      return row.fullName ?? '';
    case 'primaryEmail':
      return row.primaryEmail;
    case 'orgUnitPath':
      return row.orgUnitPath;
    case 'status':
      return STATUS_LABELS[statusValue(row)];
    case 'lastLoginTime':
      return row.lastLoginTime
        ? new Date(row.lastLoginTime).toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
          })
        : 'Never';
    case 'twoStep':
      return TWO_STEP_LABELS[twoStepValue(row)];
    case 'creationTime':
      return row.creationTime
        ? new Date(row.creationTime).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
          })
        : '';
    case 'department':
      return row.department ?? '';
    case 'title':
      return row.title ?? '';
    default:
      return '';
  }
}

/** The width of each column, from the approved screen of the users grid. */
const WIDTHS: Readonly<Record<string, number>> = {
  fullName: 180,
  primaryEmail: 220,
  orgUnitPath: 200,
  status: 130,
  lastLoginTime: 165,
  twoStep: 210,
  creationTime: 165,
  department: 160,
  title: 160,
};

function columnFilter(
  field: UserField,
  orgUnits: () => readonly string[],
): Pick<ColDef<UserRow>, 'filter' | 'filterParams'> {
  switch (field.kind) {
    case 'text':
      return {
        filter: 'agTextColumnFilter',
        filterParams: {
          filterOptions: ['contains', 'startsWith', 'equals', 'blank'],
          maxNumConditions: 1,
          trimInput: true,
          ...filterButtons,
        },
      };
    case 'dateTime':
      return {
        filter: 'agDateColumnFilter',
        filterParams: {
          filterOptions: dateOptions,
          maxNumConditions: 1,
          ...filterButtons,
        },
      };
    case 'orgUnit':
      return {
        filter: 'agSetColumnFilter',
        filterParams: {
          values: (params: { success: (values: string[]) => void }) =>
            params.success([...orgUnits()]),
          refreshValuesOnOpen: true,
          treeList: true,
          treeListPathGetter: orgUnitTreePath,
          treeListFormatter: (key: string | null, level: number) =>
            level === 0 ? 'All organization units' : (key ?? ''),
          ...filterButtons,
        },
      };
    case 'status':
      return {
        filter: 'agSetColumnFilter',
        filterParams: {
          values: Object.keys(STATUS_LABELS),
          suppressSorting: true,
          valueFormatter: ({ value }: { value: string }) =>
            STATUS_LABELS[value as keyof typeof STATUS_LABELS] ?? value,
          ...filterButtons,
        },
      };
    case 'boolean':
      return {
        filter: 'agSetColumnFilter',
        filterParams: {
          values: Object.keys(TWO_STEP_LABELS),
          suppressSorting: true,
          valueFormatter: ({ value }: { value: string }) =>
            TWO_STEP_LABELS[value as keyof typeof TWO_STEP_LABELS] ?? value,
          ...filterButtons,
        },
      };
  }
}

/** The filter of one attribute follows its info type (baseline default 4). */
function attributeFilter(
  attribute: UserAttributeColumn,
): Pick<ColDef<UserRow>, 'filter' | 'filterParams'> {
  switch (attribute.field.fieldType) {
    case 'INT64':
    case 'DOUBLE':
      return {
        filter: 'agNumberColumnFilter',
        filterParams: {
          filterOptions: ['inRange'],
          maxNumConditions: 1,
          ...filterButtons,
        },
      };
    case 'DATE':
      return {
        filter: 'agDateColumnFilter',
        filterParams: {
          filterOptions: ['inRange'],
          maxNumConditions: 1,
          ...filterButtons,
        },
      };
    case 'BOOL':
      return {
        filter: 'agSetColumnFilter',
        filterParams: {
          values: ['true', 'false'],
          valueFormatter: ({ value }: { value: string }) =>
            value === 'true' ? 'Yes' : 'No',
          ...filterButtons,
        },
      };
    default:
      return {
        filter: 'agTextColumnFilter',
        filterParams: {
          filterOptions: ['contains'],
          maxNumConditions: 1,
          trimInput: true,
          ...filterButtons,
        },
      };
  }
}

/**
 * The users grid columns. The Name column stays pinned (record default 4), and the
 * attribute columns sit under their category in the Columns panel (A section 9).
 */
export function userColumnDefs(
  options: {
    attributes?: readonly UserAttributeColumn[];
    orgUnits?: () => readonly string[];
    /** GRID-03: the details icon opens the user's details page. */
    onDetails?: (row: UserRow, node: IRowNode<UserRow>) => void;
    /** The Name link records the row before the router opens the details page. */
    onOpen?: (row: UserRow, node: IRowNode<UserRow>) => void;
  } = {},
): (ColDef<UserRow> | ColGroupDef<UserRow>)[] {
  const orgUnits = options.orgUnits ?? (() => []);
  const attributes = options.attributes ?? [];
  const onDetails = options.onDetails ?? (() => undefined);
  const onOpen = options.onOpen ?? (() => undefined);
  const columns: ColDef<UserRow>[] = [
    {
      colId: 'details',
      headerName: 'Details',
      headerClass: 'user-details-header',
      width: 55,
      minWidth: 55,
      maxWidth: 55,
      pinned: 'left',
      lockVisible: true,
      suppressMovable: true,
      // GRID-03: the details icon stays right after the checkbox, before the Name column.
      lockPosition: 'left',
      sortable: false,
      resizable: false,
      cellRenderer: UserDetailsCell,
      cellRendererParams: { onDetails },
      // The marker centers in the narrow column and no cell padding can wrap it.
      cellStyle: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '0',
      },
      filter: false,
      suppressHeaderMenuButton: true,
      suppressHeaderFilterButton: true,
      suppressColumnsToolPanel: true,
      suppressFiltersToolPanel: true,
    },
    ...USER_FIELDS.map((field): ColDef<UserRow> => {
      const sortable = field.id !== 'twoStep';
      return {
        colId: field.id,
        headerName: field.label,
        width: WIDTHS[field.id] ?? 165,
        minWidth: 100,
        valueGetter: ({ data }) => (data ? text(data, field.id) : ''),
        // The Name cell is the link to the details page (A section 9).
        ...(field.id === 'fullName'
          ? {
              cellRenderer: UserNameCell,
              cellRendererParams: { onOpen },
            }
          : {}),
        sortable,
        ...columnFilter(field, orgUnits),
        hide: field.optional,
        // The Name column stays pinned at the left (record default 4).
        ...(field.id === 'fullName'
          ? { pinned: 'left' as const, lockPinned: true }
          : {}),
        // A stale row shows its name muted until the refresh lands (A section 15.4).
        ...(field.id === 'fullName'
          ? {
              cellClassRules: {
                'user-stale': ({ data }: { data?: UserRow | null }) =>
                  !!data && data.stale === true,
              },
              tooltipValueGetter: ({ data }: { data?: UserRow | null }) =>
                data?.stale ? 'Refreshing from Google' : undefined,
            }
          : {}),
      };
    }),
  ];
  // One group for each category. A zero group header height keeps the single header row.
  const groups: ColGroupDef<UserRow>[] = options.attributes?.length
    ? [...new Set(attributes.map((attribute) => attribute.schemaName))].map(
        (schemaName) => {
          const children = attributes.filter(
            (attribute) => attribute.schemaName === schemaName,
          );
          return {
            groupId: `cat:${schemaName}`,
            headerName: children[0].schemaDisplayName,
            openByDefault: true,
            children: children.map(
              (attribute): ColDef<UserRow> => ({
                colId: attribute.id,
                headerName: attribute.label,
                width: attribute.field.multiValued ? 180 : 165,
                minWidth: 110,
                valueGetter: ({ data }) =>
                  data ? attributeText(data, attribute) : '',
                // The users query sorts static fields only.
                sortable: false,
                ...attributeFilter(attribute),
                hide: true,
              }),
            ),
          };
        },
      )
    : [];
  return [...columns, ...groups];
}

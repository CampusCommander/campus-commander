import * as z from 'zod';
import {
  googleCustomerIdSchema,
  googleFailureSchema,
} from './google-connection';

const timestamp = z.iso.datetime({ offset: true });
const deviceId = z.string().min(1).max(128);
const orgUnitPath = z.string().min(1).max(4096).startsWith('/');
const percent = z.number().int().min(0).max(200);

export const batteryHealthSchema = z.enum([
  'normal',
  'replace-soon',
  'replace-now',
]);
export type BatteryHealth = z.infer<typeof batteryHealthSchema>;

export const batteryReportSchema = z.strictObject({
  reportedAt: timestamp,
  health: batteryHealthSchema.nullable(),
  capacityPercent: percent.nullable(),
});
export type BatteryReport = z.infer<typeof batteryReportSchema>;

export const deviceBatterySchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('reported'),
    health: batteryHealthSchema,
    capacityPercent: percent.nullable(),
    reportedAt: timestamp,
  }),
  z.strictObject({ status: z.literal('no-report') }),
  z.strictObject({ status: z.literal('unavailable') }),
]);
export type DeviceBattery = z.infer<typeof deviceBatterySchema>;

/** One device as the worker stages it. */
export const deviceObservationSchema = z.strictObject({
  deviceId,
  serialNumber: z.string().max(256),
  model: z.string().max(256).nullable(),
  assetTag: z.string().max(256).nullable(),
  orgUnitPath,
  lastContact: timestamp.nullable(),
  annotatedLocation: z.string().max(4096).nullable(),
  notes: z.string().max(4096).nullable(),
  status: z.string().max(64).nullable(),
});
export type DeviceObservation = z.infer<typeof deviceObservationSchema>;

/** One device's battery data as the worker stages it. The reader never reports unavailable. */
export const batteryObservationSchema = z.strictObject({
  deviceId,
  battery: deviceBatterySchema,
  reports: z.array(batteryReportSchema).max(30),
});
export type BatteryObservation = z.infer<typeof batteryObservationSchema>;

const recordShape = {
  deviceId,
  serialNumber: z.string().max(256),
  model: z.string().max(256).nullable(),
  assetTag: z.string().max(256).nullable(),
  orgUnitPath,
  lastContact: timestamp.nullable(),
  annotatedLocation: z.string().max(4096).nullable(),
  notes: z.string().max(4096).nullable(),
  battery: deviceBatterySchema,
  /** When Campus Commander last read this device from Google. */
  lastEntitySync: timestamp,
};
/** One device as Redis stores it. Readers add `stale` at read time. */
export const deviceRecordSchema = z.strictObject(recordShape);
export type DeviceRecord = z.infer<typeof deviceRecordSchema>;

export const deviceRowSchema = z.strictObject({
  ...recordShape,
  stale: z.boolean(),
});
export type DeviceRow = z.infer<typeof deviceRowSchema>;

export const deviceDetailSchema = z.strictObject({
  ...recordShape,
  stale: z.boolean(),
  /** Set when Google no longer returns the device. The row stays in the database. */
  removedAt: timestamp.nullable(),
  batteryReports: z.array(batteryReportSchema).max(30),
});
export type DeviceDetail = z.infer<typeof deviceDetailSchema>;

/** IDs per by-ids request. A grid holds at most 1,000 rows, so the client sends two requests at most. */
export const DEVICE_BY_IDS_LIMIT = 500;
export const deviceByIdsSchema = z.strictObject({
  deviceIds: z.array(deviceId).min(1).max(DEVICE_BY_IDS_LIMIT),
});
export const deviceRowsSchema = z.array(deviceRowSchema).max(DEVICE_BY_IDS_LIMIT);

/** Stale devices in one result set, and whether a refresh job runs for the customer (D11). */
export const deviceFreshnessSchema = z.strictObject({
  stale: z.number().int().min(0),
  refreshing: z.boolean(),
});
export type DeviceFreshness = z.infer<typeof deviceFreshnessSchema>;

export const deviceTextFieldSchema = z.enum([
  'serialNumber',
  'model',
  'assetTag',
  'annotatedLocation',
  'notes',
]);
export const deviceSortFieldSchema = z.enum([
  'serialNumber',
  'model',
  'assetTag',
  'orgUnitPath',
  'battery',
  'lastContact',
  'annotatedLocation',
  'notes',
]);
export const batteryFilterValueSchema = z.enum([
  'normal',
  'replace-soon',
  'replace-now',
  'no-report',
  'unavailable',
]);

const filterText = z.string().trim().min(1).max(256);

/** Each field type offers only its own operators. Chips combine with AND. */
export const devicePredicateSchema = z.union([
  z.strictObject({
    field: deviceTextFieldSchema,
    operator: z.enum(['contains', 'startsWith', 'equals']),
    value: filterText,
  }),
  z.strictObject({
    field: deviceTextFieldSchema,
    operator: z.literal('isEmpty'),
  }),
  z.strictObject({
    field: z.literal('orgUnitPath'),
    operator: z.literal('in'),
    values: z.array(orgUnitPath).max(1000),
  }),
  z.strictObject({
    field: z.literal('battery'),
    operator: z.literal('is'),
    values: z.array(batteryFilterValueSchema).max(5),
  }),
  z.strictObject({
    field: z.literal('lastContact'),
    operator: z.enum(['before', 'after']),
    value: timestamp,
  }),
]);
export type DevicePredicate = z.infer<typeof devicePredicateSchema>;

export const deviceGroupFieldSchema = z.enum([
  'orgUnitPath',
  'model',
  'battery',
]);
export type DeviceGroupField = z.infer<typeof deviceGroupFieldSchema>;
/** Group keys are filter values: an OrgUnit path, a model (empty for none), or a battery filter value. */
const groupKey = z.string().max(4096);

/** The grouped fields, outermost first, and the keys of the open group. */
export const deviceGroupingSchema = z
  .strictObject({
    by: z.array(deviceGroupFieldSchema).max(3),
    keys: z.array(groupKey).max(3),
  })
  .refine((group) => new Set(group.by).size === group.by.length, {
    message: 'Group by each field once.',
  })
  .refine((group) => group.keys.length <= group.by.length, {
    message: 'Each group key needs a grouped field.',
  });
export type DeviceGrouping = z.infer<typeof deviceGroupingSchema>;

const selectionIds = z.array(deviceId).min(1).max(2000);
const selectionKeyShape = {
  gridId: z.literal('devices'),
  tabId: z.uuid(),
};
const groupScopeShape = {
  predicates: z.array(devicePredicateSchema).max(20),
  by: z.array(deviceGroupFieldSchema).min(1).max(3),
  route: z.array(groupKey).min(1).max(3),
};
const routeFits = (scope: { by: string[]; route: string[] }) =>
  scope.route.length <= scope.by.length &&
  new Set(scope.by).size === scope.by.length;
const routeMessage = {
  message: 'A group route needs one grouped field per key.',
};

/** A group as the grid showed it: the active filters, the grouped fields, and the group's keys. */
export const deviceGroupScopeSchema = z
  .strictObject(groupScopeShape)
  .refine(routeFits, routeMessage);
export type DeviceGroupScope = z.infer<typeof deviceGroupScopeSchema>;

/** One browser tab's selection in one grid. The API scopes it to the signed-in person. */
export const deviceSelectionKeySchema = z.strictObject(selectionKeyShape);
export type DeviceSelectionKey = z.infer<typeof deviceSelectionKeySchema>;

export const deviceSelectionOpSchema = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('selectAll'),
    predicates: z.array(devicePredicateSchema).max(20),
  }),
  z.strictObject({ op: z.literal('deselectAll') }),
  z.strictObject({ op: z.literal('select'), ids: selectionIds }),
  z.strictObject({ op: z.literal('deselect'), ids: selectionIds }),
  z
    .strictObject({ op: z.literal('selectGroup'), ...groupScopeShape })
    .refine(routeFits, routeMessage),
  z
    .strictObject({ op: z.literal('deselectGroup'), ...groupScopeShape })
    .refine(routeFits, routeMessage),
]);
export type DeviceSelectionOp = z.infer<typeof deviceSelectionOpSchema>;

export const deviceSelectionChangeSchema = z.strictObject({
  ...selectionKeyShape,
  ops: z.array(deviceSelectionOpSchema).min(1).max(100),
});

export const deviceSelectionResolveSchema = z.strictObject({
  ...selectionKeyShape,
  rowIds: z.array(deviceId).max(2000),
  groupRoutes: z.array(z.string().max(8192)).max(2000),
  /** The grid's filters and grouped fields, for the group rows in `groupRoutes`. */
  predicates: z.array(devicePredicateSchema).max(20).default([]),
  by: z.array(deviceGroupFieldSchema).max(3).default([]),
});

/** What Select All captured and the API's count. Device IDs stay on the server. */
export const deviceSelectionSpecSchema = z.strictObject({
  terms: z
    .array(
      z.strictObject({
        type: z.literal('all'),
        predicates: z.array(devicePredicateSchema).max(20),
      }),
    )
    .max(50),
  groups: z.array(deviceGroupScopeSchema).max(50).default([]),
  added: z.number().int().min(0),
  excluded: z.number().int().min(0),
  selectedCount: z.number().int().min(0),
});
export type DeviceSelectionSpec = z.infer<typeof deviceSelectionSpecSchema>;

export const deviceQuerySchema = z.strictObject({
  predicates: z.array(devicePredicateSchema).max(20).default([]),
  sort: z
    .strictObject({
      field: deviceSortFieldSchema,
      direction: z.enum(['asc', 'desc']),
    })
    .default({ field: 'serialNumber', direction: 'asc' }),
  offset: z.number().int().min(0).max(1_000_000).default(0),
  limit: z.number().int().min(1).max(1000).default(100),
  /** Show All Selected limits the query to this tab's selection. */
  selection: deviceSelectionKeySchema.nullable().default(null),
  /** Open group keys narrow the rows. LibreGrid loads an open group in one request. */
  group: deviceGroupingSchema.default({ by: [], keys: [] }),
});
export type DeviceQuery = z.output<typeof deviceQuerySchema>;

export const devicePageSchema = z.strictObject({
  rows: z.array(deviceRowSchema).max(1000),
  matching: z.number().int().min(0),
  total: z.number().int().min(0),
  observedAt: timestamp.nullable(),
  /** The refresh job this page started for its stale devices, when one started. */
  refreshJobId: z.uuid().nullable(),
});
export type DevicePage = z.infer<typeof devicePageSchema>;

/** A group request opens the next grouped level. */
export const deviceGroupQuerySchema = deviceQuerySchema.refine(
  (query) => query.group.keys.length < query.group.by.length,
  { message: 'A group request needs an unopened grouped level.' },
);

export const deviceGroupPageSchema = z.strictObject({
  groups: z
    .array(z.strictObject({ key: groupKey, devices: z.number().int().min(0) }))
    .max(1000),
  groupCount: z.number().int().min(0),
  /** Devices in all groups of this level. */
  matching: z.number().int().min(0),
  total: z.number().int().min(0),
  observedAt: timestamp.nullable(),
});
export type DeviceGroupPage = z.infer<typeof deviceGroupPageSchema>;

export const deviceSyncFailureSchema = z.union([
  googleFailureSchema,
  z.enum(['key-unavailable', 'interrupted', 'orchestration-unavailable']),
]);
export type DeviceSyncFailure = z.infer<typeof deviceSyncFailureSchema>;

export const deviceSyncStateSchema = z.strictObject({
  customerId: googleCustomerIdSchema,
  generation: z.number().int().positive(),
  status: z.enum(['never', 'running', 'ready', 'failed']),
  observedAt: timestamp.nullable(),
  deviceCount: z.number().int().min(0),
  failure: deviceSyncFailureSchema.nullable(),
  telemetryFailure: googleFailureSchema.nullable(),
  startedAt: timestamp.nullable(),
  checkedAt: timestamp.nullable(),
  stale: z.boolean(),
});
export type DeviceSyncState = z.infer<typeof deviceSyncStateSchema>;

export const deviceOrgUnitSchema = z.strictObject({
  path: orgUnitPath,
  devices: z.number().int().min(0),
});
export type DeviceOrgUnit = z.infer<typeof deviceOrgUnitSchema>;
export const deviceOrgUnitsSchema = z.array(deviceOrgUnitSchema).max(10000);

import * as z from 'zod';
import {
  googleCustomerIdSchema,
  googleFailureSchema,
} from './google-connection';
import { googleHealthFailureSchema } from './google-health';

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
  assetTag: z.string().max(4096).nullable(),
  orgUnitPath,
  lastContact: timestamp.nullable(),
  annotatedLocation: z.string().max(4096).nullable(),
  annotatedUser: z.string().max(4096).nullable(),
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
  assetTag: z.string().max(4096).nullable(),
  orgUnitPath,
  lastContact: timestamp.nullable(),
  annotatedLocation: z.string().max(4096).nullable(),
  annotatedUser: z.string().max(4096).nullable(),
  notes: z.string().max(4096).nullable(),
  /** Google's device status: ACTIVE, DISABLED, DEPROVISIONED, another value, or null. */
  status: z.string().max(64).nullable(),
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
export const deviceRowsSchema = z
  .array(deviceRowSchema)
  .max(DEVICE_BY_IDS_LIMIT);

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
  'annotatedUser',
  'notes',
]);
export const deviceSortFieldSchema = z.enum([
  'serialNumber',
  'model',
  'assetTag',
  'orgUnitPath',
  'status',
  'battery',
  'lastContact',
  'annotatedLocation',
  'annotatedUser',
  'notes',
]);
export const batteryFilterValueSchema = z.enum([
  'normal',
  'replace-soon',
  'replace-now',
  'no-report',
  'unavailable',
]);
export const deviceStatusFilterValueSchema = z.enum([
  'ACTIVE',
  'DISABLED',
  'DEPROVISIONED',
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
    field: z.literal('status'),
    operator: z.literal('is'),
    values: z.array(deviceStatusFilterValueSchema).max(3),
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
  /** The expiry time of a selection that lapsed, or null while the selection is current. */
  expiredAt: timestamp.nullable(),
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

/** The answer of Refresh Selected. `selected` counts the devices the job reads. */
export const deviceSelectionRefreshSchema = z.strictObject({
  jobId: z.uuid().nullable(),
  selected: z.number().int().min(1).max(100_000),
});
export type DeviceSelectionRefreshAnswer = z.infer<
  typeof deviceSelectionRefreshSchema
>;

/** The answer of Refresh Domain. The sync and the domain read report separately. */
const deviceDomainRefreshShape = z.strictObject({
  sync: deviceSyncStateSchema,
  domain: z.strictObject({
    status: z.enum(['refreshed', 'failed']),
    /** A passed check carries no reason. A failed check names its cause. */
    reason: z
      .union([googleHealthFailureSchema, z.enum(['busy', 'unavailable'])])
      .nullable(),
  }),
});
export const deviceDomainRefreshSchema = deviceDomainRefreshShape.refine(
  (answer: z.infer<typeof deviceDomainRefreshShape>) =>
    (answer.domain.reason === null) === (answer.domain.status === 'refreshed'),
  {
    message: 'A refreshed check carries no reason. A failed check names one.',
  },
);
export type DeviceDomainRefreshAnswer = z.infer<
  typeof deviceDomainRefreshSchema
>;

export const deviceOrgUnitSchema = z.strictObject({
  path: orgUnitPath,
  devices: z.number().int().min(0),
});
export type DeviceOrgUnit = z.infer<typeof deviceOrgUnitSchema>;
export const deviceOrgUnitsSchema = z.array(deviceOrgUnitSchema).max(10000);

/** The five writable fields of the record, in contract order (addendum section 1). */
export const DEVICE_UPDATE_FIELD_ORDER = [
  'annotatedLocation',
  'annotatedAssetId',
  'annotatedUser',
  'notes',
  'orgUnitPath',
] as const;
export const deviceUpdateFieldSchema = z.enum(DEVICE_UPDATE_FIELD_ORDER);
export type DeviceUpdateField = z.infer<typeof deviceUpdateFieldSchema>;
/** The four fields of the bulk Update device selection (addendum section 9). Asset tag stays out. */
export const DEVICE_UPDATE_SELECTION_FIELDS = [
  'annotatedLocation',
  'annotatedUser',
  'notes',
  'orgUnitPath',
] as const;
export const deviceUpdateSelectionFieldSchema = z.enum(
  DEVICE_UPDATE_SELECTION_FIELDS,
);
export type DeviceUpdateSelectionField = z.infer<
  typeof deviceUpdateSelectionFieldSchema
>;
/** The three text fields of the bulk Update device sheet. Organization unit moves to a path. */
export const DEVICE_UPDATE_TEXT_FIELDS = [
  'annotatedLocation',
  'annotatedUser',
  'notes',
] as const;
export const deviceUpdateTextFieldSchema = z.enum(DEVICE_UPDATE_TEXT_FIELDS);
export type DeviceUpdateTextField = z.infer<typeof deviceUpdateTextFieldSchema>;

/**
 * The write limit of each field (addendum section 1). A text limit counts code points. The path
 * limit counts UTF-16 units, as every path reader does.
 */
export const DEVICE_UPDATE_FIELD_LIMITS: Readonly<
  Record<DeviceUpdateField, number>
> = Object.freeze({
  annotatedLocation: 200,
  annotatedAssetId: 256,
  annotatedUser: 100,
  notes: 500,
  orgUnitPath: 4096,
});

/** The label of each field. A refusal names the label of its field. */
export const DEVICE_UPDATE_FIELD_LABELS: Readonly<
  Record<DeviceUpdateField, string>
> = Object.freeze({
  annotatedLocation: 'Annotated location',
  annotatedAssetId: 'Asset tag',
  annotatedUser: 'Annotated user',
  notes: 'Notes',
  orgUnitPath: 'Organization unit',
});

/** The mode of each change. A text field replaces or clears. Organization unit moves. */
export const deviceUpdateModeSchema = z.enum(['replace', 'clear', 'move']);
export type DeviceUpdateMode = z.infer<typeof deviceUpdateModeSchema>;

/** A change under its rules, before any schema refines it. */
interface DeviceUpdateChangeShape {
  field: DeviceUpdateField;
  mode: DeviceUpdateMode;
  value?: string;
}

/**
 * Refuse the mode and the value of one change. A refusal names the field label and its limit.
 * Clear (and only Clear) carries no value. A text value keeps the step 4 rule: 1 to its limit of
 * code points, a visible character, and no trim. A Move carries a path that starts with `/`.
 * Asset tag offers Replace alone, because Google keeps no empty tag.
 */
function refuseChange(
  change: DeviceUpdateChangeShape,
  context: z.RefinementCtx,
): void {
  const label = DEVICE_UPDATE_FIELD_LABELS[change.field];
  const limit = DEVICE_UPDATE_FIELD_LIMITS[change.field];
  const refuse = (message: string) =>
    context.addIssue({ code: 'custom', message, path: ['value'] });
  if (change.field === 'orgUnitPath') {
    if (change.mode !== 'move') return refuse(`${label} offers Move only.`);
    if (change.value === undefined) return refuse(`${label} needs a path.`);
    if (
      change.value.length < 1 ||
      change.value.length > limit ||
      !change.value.startsWith('/')
    )
      return refuse(
        `${label} needs a path that starts with / and holds at most ${limit} characters.`,
      );
    return;
  }
  if (change.field === 'annotatedAssetId' && change.mode !== 'replace')
    return refuse(`${label} offers Replace only.`);
  if (change.mode === 'move')
    return refuse(`${label} offers Replace or Clear.`);
  if (change.mode === 'clear') {
    if (change.value !== undefined)
      return refuse(`A Clear change of ${label} carries no value.`);
    return;
  }
  if (change.value === undefined) return refuse(`${label} needs a value.`);
  // One code point takes at most two UTF-16 units. Refuse twice the limit before counting, so a
  // giant body never reaches the spread and the refusal still names the field and its limit.
  if (change.value.length > 2 * limit)
    return refuse(`${label} holds 1 to ${limit} characters.`);
  const length = [...change.value].length;
  if (length < 1 || length > limit)
    return refuse(`${label} holds 1 to ${limit} characters.`);
  if (change.value.trim().length === 0)
    return refuse(`${label} needs a visible character.`);
}

/** The request that a change would write. Clear writes null. */
function changeRequest(change: DeviceUpdateChangeShape): string | null {
  return change.mode === 'clear' ? null : (change.value ?? null);
}

/** The keys of one field change, before its rules run. */
const changeShape = {
  field: deviceUpdateFieldSchema,
  mode: deviceUpdateModeSchema,
  // The refinement names the field and its limit at every length, an absurd body included.
  value: z.string().optional(),
};

/**
 * One field change of a preview or a job. Clear (and only Clear) carries no value. A text value
 * keeps the step 4 rule: 1 to its limit of code points, a visible character, and no trim. A Move
 * carries a path that starts with `/`.
 */
export const deviceUpdateChangeSchema = z
  .strictObject(changeShape)
  .superRefine(refuseChange);
export type DeviceUpdateChange = z.infer<typeof deviceUpdateChangeSchema>;

/** One change of the bulk Update device selection. Asset tag stays out of that sheet. */
export const deviceUpdateSelectionChangeSchema = z
  .strictObject({ ...changeShape, field: deviceUpdateSelectionFieldSchema })
  .superRefine(refuseChange);
export type DeviceUpdateSelectionChange = z.infer<
  typeof deviceUpdateSelectionChangeSchema
>;

/** The changes of one selection draft, in contract order, with each field once. */
export const deviceUpdateChangesSchema = z
  .array(deviceUpdateSelectionChangeSchema)
  .min(1)
  .max(DEVICE_UPDATE_SELECTION_FIELDS.length)
  .refine(
    (changes) =>
      new Set(changes.map((change) => change.field)).size === changes.length,
    { message: 'A field occurs once.' },
  );

/**
 * One edit of an edit list (addendum section 1): a device and a field change, with the value that
 * the person saw when the edit began. A request equal to its baseline changes nothing, so it is
 * invalid. Paths compare without case, as every path reader does.
 */
export const deviceUpdateEditSchema = z
  .strictObject({
    deviceId,
    ...changeShape,
    /** The observed value when the edit began, or null when the field held none. */
    baselineValue: z.string().max(4096).nullable(),
  })
  .superRefine((edit, context) => {
    refuseChange(edit, context);
    const request = changeRequest(edit);
    const baseline = edit.baselineValue;
    const equal =
      edit.field === 'orgUnitPath'
        ? (request ?? '').toLowerCase() === (baseline ?? '').toLowerCase()
        : request === baseline;
    if (!equal) return;
    context.addIssue({
      code: 'custom',
      message: `${DEVICE_UPDATE_FIELD_LABELS[edit.field]} already holds this value.`,
      path: ['baselineValue'],
    });
  });
export type DeviceUpdateEdit = z.infer<typeof deviceUpdateEditSchema>;

/** The four Deprovision reasons that Google accepts (record D11). The other seven fail. */
export const DEPROVISION_REASONS = [
  'DEPROVISION_REASON_RETIRING_DEVICE',
  'DEPROVISION_REASON_DIFFERENT_MODEL_REPLACEMENT',
  'DEPROVISION_REASON_SAME_MODEL_REPLACEMENT',
  'DEPROVISION_REASON_UPGRADE_TRANSFER',
] as const;
export const deprovisionReasonSchema = z.enum(DEPROVISION_REASONS);
export type DeprovisionReason = z.infer<typeof deprovisionReasonSchema>;

/** The label of each reason (D11). The schema holds no default, so no reason starts selected. */
export const DEPROVISION_REASON_LABELS: Readonly<
  Record<DeprovisionReason, string>
> = Object.freeze({
  DEPROVISION_REASON_RETIRING_DEVICE: 'Retiring from fleet',
  DEPROVISION_REASON_DIFFERENT_MODEL_REPLACEMENT: 'Different model replacement',
  DEPROVISION_REASON_SAME_MODEL_REPLACEMENT: 'Same model replacement',
  DEPROVISION_REASON_UPGRADE_TRANSFER: 'ChromeOS Flex upgrade transfer',
});

/** Sort changes into contract order. The rows, the bodies, and the digest use that order. */
export function deviceUpdateChangesInOrder(
  changes: readonly DeviceUpdateChange[],
): DeviceUpdateChange[] {
  return [...changes].sort(
    (left, right) =>
      DEVICE_UPDATE_FIELD_ORDER.indexOf(left.field) -
      DEVICE_UPDATE_FIELD_ORDER.indexOf(right.field),
  );
}

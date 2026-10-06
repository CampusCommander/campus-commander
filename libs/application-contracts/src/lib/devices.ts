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

const rowShape = {
  deviceId,
  serialNumber: z.string().max(256),
  model: z.string().max(256).nullable(),
  assetTag: z.string().max(256).nullable(),
  orgUnitPath,
  lastContact: timestamp.nullable(),
  annotatedLocation: z.string().max(4096).nullable(),
  notes: z.string().max(4096).nullable(),
  battery: deviceBatterySchema,
};
export const deviceRowSchema = z.strictObject(rowShape);
export type DeviceRow = z.infer<typeof deviceRowSchema>;

export const deviceDetailSchema = z.strictObject({
  ...rowShape,
  observedAt: timestamp,
  batteryReports: z.array(batteryReportSchema).max(30),
});
export type DeviceDetail = z.infer<typeof deviceDetailSchema>;

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

export const deviceQuerySchema = z.strictObject({
  predicates: z.array(devicePredicateSchema).max(20).default([]),
  sort: z
    .strictObject({
      field: deviceSortFieldSchema,
      direction: z.enum(['asc', 'desc']),
    })
    .default({ field: 'serialNumber', direction: 'asc' }),
  offset: z.number().int().min(0).max(1_000_000).default(0),
  limit: z.number().int().min(1).max(200).default(100),
});
export type DeviceQuery = z.output<typeof deviceQuerySchema>;

export const devicePageSchema = z.strictObject({
  rows: z.array(deviceRowSchema).max(200),
  matching: z.number().int().min(0),
  total: z.number().int().min(0),
  observedAt: timestamp.nullable(),
});
export type DevicePage = z.infer<typeof devicePageSchema>;

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

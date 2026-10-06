import * as z from 'zod';
import { googleCustomerIdSchema } from './google-connection';
import { deviceSyncFailureSchema, deviceSyncStateSchema } from './devices';

const timestamp = z.iso.datetime({ offset: true });
const deviceId = z.string().min(1).max(128);
const count = z.number().int().min(0);

export const entityTypeSchema = z.enum(['device']);
export type EntityType = z.infer<typeof entityTypeSchema>;

/** Hours after the last Google read when an entity counts as stale. Evaluated at read time. */
export const ENTITY_FRESHNESS_HOURS: Readonly<Record<EntityType, number>> = {
  device: 24,
};
/** Redis keeps a record as long as it stays fresh. */
export const ENTITY_CACHE_SECONDS: Readonly<Record<EntityType, number>> = {
  device: ENTITY_FRESHNESS_HOURS.device * 3600,
};
/** Devices per Kestra batch. The Directory batch endpoint allows 1,000. */
export const ENTITY_SYNC_BATCH_SIZE = 100;
/** Seconds an ID waits in the in-flight set when no batch removes it. */
export const ENTITY_INFLIGHT_SECONDS = 120;

export function freshnessCutoff(type: EntityType, now = Date.now()): Date {
  return new Date(now - ENTITY_FRESHNESS_HOURS[type] * 3_600_000);
}

export function isStale(
  type: EntityType,
  lastEntitySync: string,
  now = Date.now(),
): boolean {
  return Date.parse(lastEntitySync) < freshnessCutoff(type, now).getTime();
}

export const entityKey = (type: EntityType, customerId: string, id: string) =>
  `cc:entity:${type}:${customerId}:${id}`;
export const queryGenerationKey = (type: EntityType, customerId: string) =>
  `cc:query-gen:${type}:${customerId}`;
export const inflightKey = (type: EntityType, customerId: string) =>
  `cc:entity-inflight:${type}:${customerId}`;
export const entityEventsChannel = (customerId: string) =>
  `cc:entity-events:${customerId}`;

export const entitySyncJobSchema = z.strictObject({
  jobId: z.uuid(),
  customerId: googleCustomerIdSchema,
  entityType: entityTypeSchema,
  batchCount: z.number().int().min(1),
  completedBatches: count,
  failedBatches: count,
  failure: deviceSyncFailureSchema.nullable(),
  createdAt: timestamp,
  finishedAt: timestamp.nullable(),
});
export type EntitySyncJob = z.infer<typeof entitySyncJobSchema>;

/** One Kestra batch dispatch. Kestra passes loop values as text. */
export const entitySyncBatchRequestSchema = z.strictObject({
  customerId: googleCustomerIdSchema,
  jobId: z.uuid(),
  batch: z.coerce.number().int().min(0),
  correlationId: z.uuid(),
});
export type EntitySyncBatchRequest = z.infer<typeof entitySyncBatchRequestSchema>;

export const entityEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('entity-batch'),
    jobId: z.uuid(),
    entityType: entityTypeSchema,
    batch: count,
    batchCount: z.number().int().min(1),
    deviceIds: z.array(deviceId).max(1000),
    removedIds: z.array(deviceId).max(1000),
  }),
  z.strictObject({ type: z.literal('job-finished'), job: entitySyncJobSchema }),
  z.strictObject({ type: z.literal('full-sync'), sync: deviceSyncStateSchema }),
]);
export type EntityEvent = z.infer<typeof entityEventSchema>;

import * as z from 'zod';
import { deviceSyncFailureSchema } from './devices';

const timestamp = z.iso.datetime({ offset: true });
const count = z.number().int().min(0);
const revision = z.number().int().min(1);
const deviceId = z.string().min(1).max(128);
const serialNumber = z.string().max(256);
const orgUnitPath = z.string().min(1).max(4096).startsWith('/');
const displayName = z.string().min(1).max(200);
/** Product codes of operations. The vocabulary stays open (section 1.4). */
const productCode = z.string().min(1).max(64);

/** The display IDs of sections 1.4 and 1.6. The number carries at least three digits. */
export const jobDisplayIdSchema = z.string().regex(/^(UPD|REF)-\d{3,}$/);
export type JobDisplayId = z.infer<typeof jobDisplayIdSchema>;
export const previewDisplayIdSchema = z.string().regex(/^PV-\d{3,}$/);
export type PreviewDisplayId = z.infer<typeof previewDisplayIdSchema>;

/** The eight job statuses of section 1.2. */
export const jobStatusSchema = z.enum([
  'accepted',
  'queued',
  'held',
  'running',
  'completed',
  'completed-with-errors',
  'failed',
  'needs-review',
]);
export type JobStatus = z.infer<typeof jobStatusSchema>;

export const jobActionSchema = z.enum([
  'update-device-annotations',
  'refresh-inventory',
]);
export type JobAction = z.infer<typeof jobActionSchema>;
export const JOB_ACTION_LABELS: Readonly<Record<JobAction, string>> = {
  'update-device-annotations': 'Update device annotations',
  'refresh-inventory': 'Refresh inventory',
};

/** A running full sync knows no total. Its pending count stays unknown. */
export const jobProgressSchema = z
  .strictObject({
    total: count.nullable(),
    succeeded: count,
    failed: count,
    unknown: count,
    skipped: count,
    pending: count.nullable(),
  })
  .refine(
    (progress) => (progress.total === null) === (progress.pending === null),
    {
      message: 'Total and pending count together.',
    },
  );
export type JobProgress = z.infer<typeof jobProgressSchema>;

/** The job failure codes of section 1.2: the sync codes plus the two revalidation codes. */
export const jobFailureSchema = z.union([
  deviceSyncFailureSchema,
  z.enum(['permission-changed', 'connection-changed']),
]);
export type JobFailure = z.infer<typeof jobFailureSchema>;

/** One person behind a job: its requester or its confirmer. */
export const jobPersonSchema = z.strictObject({
  id: z.uuid(),
  displayName,
});
export type JobPerson = z.infer<typeof jobPersonSchema>;

export const jobScopeSchema = z.strictObject({
  kind: z.enum(['devices', 'all-devices']),
  /** The target count. A running full sync holds null. */
  deviceCount: count.nullable(),
});
export type JobScope = z.infer<typeof jobScopeSchema>;

/** One job row of the Jobs grid (section 2.5). */
export const jobSummarySchema = z.strictObject({
  jobId: z.uuid(),
  displayId: jobDisplayIdSchema,
  revision,
  action: jobActionSchema,
  status: jobStatusSchema,
  scope: jobScopeSchema,
  requestedBy: jobPersonSchema,
  createdAt: timestamp,
  startedAt: timestamp.nullable(),
  finishedAt: timestamp.nullable(),
  progress: jobProgressSchema,
  failure: jobFailureSchema.nullable(),
});
export type JobSummary = z.infer<typeof jobSummarySchema>;

/** The operation outcomes that the API shows. A dispatched operation reads pending (section 2.2). */
export const jobOutcomeSchema = z.enum([
  'pending',
  'succeeded',
  'failed',
  'unknown',
  'skipped',
]);
export type JobOutcome = z.infer<typeof jobOutcomeSchema>;

export const jobVerifiedBySchema = z.enum(['write-response', 'read-back']);
export type JobVerifiedBy = z.infer<typeof jobVerifiedBySchema>;

/** One operation of a write job (section 1.4). */
export const jobOperationSchema = z.strictObject({
  operationId: z.string().regex(/^UPD-\d{3,}-\d+$/),
  deviceId,
  serialNumber,
  orgUnitPath,
  operation: z.enum(['replace', 'clear']),
  baselineValue: z.string().max(4096).nullable(),
  requestedValue: z.string().max(4096).nullable(),
  outcome: jobOutcomeSchema,
  outcomeReason: productCode.nullable(),
  googleStatus: z.number().int().min(100).max(599).nullable(),
  googleReason: z.string().min(1).max(256).nullable(),
  observedValue: z.string().max(4096).nullable(),
  verifiedBy: jobVerifiedBySchema.nullable(),
  updatedAt: timestamp,
});
export type JobOperation = z.infer<typeof jobOperationSchema>;

/** One failed sample of the Latest activity line. */
export const jobFailedActivityOperationSchema = z.strictObject({
  operationId: z.string().regex(/^UPD-\d{3,}-\d+$/),
  deviceId,
  serialNumber,
  outcomeReason: productCode.nullable(),
  googleStatus: z.number().int().min(100).max(599).nullable(),
  googleReason: z.string().min(1).max(256).nullable(),
  updatedAt: timestamp,
});
export type JobFailedActivityOperation = z.infer<
  typeof jobFailedActivityOperationSchema
>;

/** One unknown sample of the Latest activity line. */
export const jobUnknownActivityOperationSchema = z.strictObject({
  operationId: z.string().regex(/^UPD-\d{3,}-\d+$/),
  deviceId,
  serialNumber,
  updatedAt: timestamp,
});
export type JobUnknownActivityOperation = z.infer<
  typeof jobUnknownActivityOperationSchema
>;

/** Latest activity of one job (section 2.5). Each outcome carries at most three samples. */
export const jobLatestActivitySchema = z.strictObject({
  at: timestamp,
  failed: z.strictObject({
    count,
    operations: z.array(jobFailedActivityOperationSchema).max(3),
  }),
  unknown: z.strictObject({
    count,
    operations: z.array(jobUnknownActivityOperationSchema).max(3),
  }),
});
export type JobLatestActivity = z.infer<typeof jobLatestActivitySchema>;

/** One job detail row. Refresh jobs hold null in every write field. */
export const jobDetailSchema = jobSummarySchema.extend({
  confirmedBy: jobPersonSchema.nullable(),
  previewDisplayId: previewDisplayIdSchema.nullable(),
  field: z.literal('annotatedLocation').nullable(),
  mode: z.enum(['replace', 'clear']).nullable(),
  requestedValue: z.string().max(4096).nullable(),
  targetOrgUnitPaths: z.array(orgUnitPath).max(10000).nullable(),
  correlationId: z.uuid(),
  latestActivity: jobLatestActivitySchema,
});
export type JobDetail = z.infer<typeof jobDetailSchema>;

/** The activity summary of section 2.5. Each section caps its rows. */
export const jobActivitySchema = z.strictObject({
  running: z.strictObject({
    count,
    jobs: z.array(jobSummarySchema).max(50),
  }),
  waiting: z.strictObject({
    count,
    jobs: z.array(jobSummarySchema).max(50),
  }),
  recent: z.strictObject({
    count,
    jobs: z.array(jobSummarySchema).max(10),
    /** The finished time of the oldest counted job plus 24 hours. */
    nextExpiryAt: timestamp.nullable(),
  }),
  attention: z.boolean(),
  seenAt: timestamp.nullable(),
  observedAt: timestamp,
});
export type JobActivity = z.infer<typeof jobActivitySchema>;

/** The job channel of section 3.1. Job events never travel on the entity channel. */
export const jobEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('job-changed'),
    jobId: z.uuid(),
    displayId: jobDisplayIdSchema,
    revision,
    /** The principal ID of the requester. */
    requestedBy: z.uuid(),
  }),
]);
export type JobEvent = z.infer<typeof jobEventSchema>;

export const jobEventsChannel = (customerId: string) =>
  `cc:job-events:${customerId}`;

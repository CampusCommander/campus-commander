import * as z from 'zod';
import {
  deprovisionReasonSchema,
  deviceSyncFailureSchema,
  deviceUpdateChangesSchema,
} from './devices';
import { deviceImportModeSchema } from './device-edit-template';

const timestamp = z.iso.datetime({ offset: true });
const count = z.number().int().min(0);
const revision = z.number().int().min(1);
const deviceId = z.string().min(1).max(128);
const serialNumber = z.string().max(256);
const orgUnitPath = z.string().min(1).max(4096).startsWith('/');
const displayName = z.string().min(1).max(200);
/** Product codes of operations. The vocabulary stays open (section 1.4). */
const productCode = z.string().min(1).max(64);

/** The display IDs of sections 1.4 and 1.6, and of the export and import kinds (design section 1).
 * The number carries at least three digits. */
export const jobDisplayIdSchema = z
  .string()
  .regex(/^(UPD|REF|CMD|STS|EXP|IMP)-\d{3,}$/);
export type JobDisplayId = z.infer<typeof jobDisplayIdSchema>;
export const previewDisplayIdSchema = z.string().regex(/^PV-\d{3,}$/);
export type PreviewDisplayId = z.infer<typeof previewDisplayIdSchema>;

/** One operation ID. Its prefix and number repeat the display ID of its job (section 1.4). An
 * update row adds the field ID, because an update job answers one row per device and field. */
export const jobOperationIdSchema = z
  .string()
  .regex(
    /^(UPD|CMD|STS)-\d{3,}-\d+(-(annotatedLocation|annotatedAssetId|annotatedUser|notes|orgUnitPath))?$/,
  );

/** The five writable field IDs of an update operation, in contract order (addendum section 1). */
export const jobOperationFieldSchema = z.enum([
  'annotatedLocation',
  'annotatedAssetId',
  'annotatedUser',
  'notes',
  'orgUnitPath',
]);
export type JobOperationField = z.infer<typeof jobOperationFieldSchema>;

/** The ten job statuses of section 1.2. An awaiting-devices command job holds no write slot. */
export const jobStatusSchema = z.enum([
  'accepted',
  'queued',
  'held',
  'running',
  'awaiting-devices',
  'completed',
  'completed-with-errors',
  'failed',
  'needs-review',
  'cancelled',
]);
export type JobStatus = z.infer<typeof jobStatusSchema>;

/** The ten job actions of section 1 and design section 1. A status job holds disable, re-enable, or
 * deprovision. An export job holds `export-devices`, and a validation job holds
 * `validate-device-import`. */
export const jobActionSchema = z.enum([
  'update-device-annotations',
  'refresh-inventory',
  'reboot-devices',
  'wipe-user-data',
  'powerwash-devices',
  'disable-devices',
  'reenable-devices',
  'deprovision-devices',
  'export-devices',
  'validate-device-import',
]);
export type JobAction = z.infer<typeof jobActionSchema>;
export const JOB_ACTION_LABELS: Readonly<Record<JobAction, string>> = {
  'update-device-annotations': 'Update device annotations',
  'refresh-inventory': 'Refresh inventory',
  'reboot-devices': 'Reboot devices',
  'wipe-user-data': 'Wipe user data',
  'powerwash-devices': 'Powerwash devices',
  'disable-devices': 'Disable devices',
  'reenable-devices': 'Re-enable devices',
  'deprovision-devices': 'Deprovision devices',
  'export-devices': 'Export devices',
  'validate-device-import': 'Validate device import',
};

/** A running full sync knows no total. Its pending count stays unknown. */
export const jobProgressSchema = z
  .strictObject({
    total: count.nullable(),
    succeeded: count,
    failed: count,
    unknown: count,
    skipped: count,
    /** A command that Google reports EXPIRED (section 1, terminal status). */
    expired: count,
    /** An operation that never left the worker (design section 1). */
    cancelled: count,
    pending: count.nullable(),
  })
  .refine(
    (progress) => (progress.total === null) === (progress.pending === null),
    {
      message: 'Total and pending count together.',
    },
  );
export type JobProgress = z.infer<typeof jobProgressSchema>;

/** The job failure codes of section 1.2: the sync codes, the two revalidation codes, and the three
 * export and import codes of design section 1. */
export const jobFailureSchema = z.union([
  deviceSyncFailureSchema,
  z.enum([
    'permission-changed',
    'connection-changed',
    'storage-unavailable',
    'inventory-unavailable',
    'export-too-large',
  ]),
]);
export type JobFailure = z.infer<typeof jobFailureSchema>;

/** The progress phases of design section 2, in job order. An export writes rows and prepares a
 * download. A validation reads a header, refreshes, compares, and writes a report. */
export const JOB_PHASES = [
  'write-rows',
  'prepare-download',
  'header-check',
  'refresh',
  'compare',
  'report',
] as const;
export const jobPhaseNameSchema = z.enum(JOB_PHASES);
export type JobPhaseName = z.infer<typeof jobPhaseNameSchema>;

/** One phase of an export or a validation job (design sections 1 and 2). */
export const jobPhaseSchema = z.strictObject({
  name: jobPhaseNameSchema,
  /** Rows or devices that the phase finished. */
  done: count,
  /** The phase total, or null when the phase counts no total, as Prepare download does. */
  total: count.nullable(),
});
export type JobPhase = z.infer<typeof jobPhaseSchema>;

/** The two export purposes of design sections 1 and 5. An edit export writes the template. A report
 * export writes the visible grid columns. */
export const JOB_EXPORT_PURPOSES = ['edit', 'report'] as const;
export const jobExportPurposeSchema = z.enum(JOB_EXPORT_PURPOSES);
export type JobExportPurpose = z.infer<typeof jobExportPurposeSchema>;

/** The export summary block of the Jobs grid (state 26). It stays null for another kind of job. */
export const jobExportSummarySchema = z.strictObject({
  purpose: jobExportPurposeSchema,
});
export type JobExportSummary = z.infer<typeof jobExportSummarySchema>;

/** One person behind a job: its requester or its confirmer. */
export const jobPersonSchema = z.strictObject({
  id: z.uuid(),
  displayName,
});
export type JobPerson = z.infer<typeof jobPersonSchema>;

/** One stored cancel request: when a person asked, and who (design section 1). */
export const jobCancelRequestSchema = z.strictObject({
  at: timestamp,
  by: jobPersonSchema,
});
export type JobCancelRequest = z.infer<typeof jobCancelRequestSchema>;

export const jobScopeSchema = z.strictObject({
  kind: z.enum(['devices', 'all-devices', 'rows']),
  /** The target count. A running full sync holds null. A rows scope holds the row count. */
  deviceCount: count.nullable(),
});
export type JobScope = z.infer<typeof jobScopeSchema>;

/** The plan states of design section 1. The API derives `expired` from the expiry. */
export const JOB_IMPORT_PLAN_STATES = [
  'open',
  'executed',
  'cancelled',
  'expired',
] as const;
export const jobImportPlanStateSchema = z.enum(JOB_IMPORT_PLAN_STATES);
export type JobImportPlanState = z.infer<typeof jobImportPlanStateSchema>;

/** The plan facts of a validation job (design section 1, `td:667`). */
export const jobImportPlanSchema = z.strictObject({
  planId: z.uuid(),
  revision,
  state: jobImportPlanStateSchema,
  expiresAt: timestamp,
  /** The person and the time of the state change. An open plan carries neither. */
  changedBy: jobPersonSchema.nullable(),
  changedAt: timestamp.nullable(),
});
export type JobImportPlan = z.infer<typeof jobImportPlanSchema>;

/** The import summary block of the Jobs grid (state 26). It stays null for another kind of job. */
export const jobImportSummarySchema = z.strictObject({
  mode: deviceImportModeSchema,
  /** The plan state, or null before the report creates a plan. */
  planState: jobImportPlanStateSchema.nullable(),
  proposed: count,
  rejected: count,
  /** The refusal code of a failed header check (design section 6). */
  refusal: z.string().min(1).max(64).nullable(),
});
export type JobImportSummary = z.infer<typeof jobImportSummarySchema>;

/** The changes of an executed import plan by outcome (design section 8). A change that Execute
 * never ran counts under `notRun`. */
export const jobExecutionCountsSchema = z.strictObject({
  succeeded: count,
  failed: count,
  unknown: count,
  skipped: count,
  expired: count,
  cancelled: count,
  pending: count,
  notRun: count,
});
export type JobExecutionCounts = z.infer<typeof jobExecutionCountsSchema>;

/** One job row of the Jobs grid (section 2.5). */
export const jobSummarySchema = z
  .strictObject({
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
    /** The phase of an export or a validation job (design section 2). It stays null for another
     * kind of job, and before the worker writes the first phase. */
    phase: jobPhaseSchema.nullable(),
    /** The export summary of the Jobs grid (state 26). It stays null for another kind of job. */
    exportSummary: jobExportSummarySchema.nullable(),
    /** The import summary of the Jobs grid (state 26). It stays null for another kind of job. */
    importSummary: jobImportSummarySchema.nullable(),
    failure: jobFailureSchema.nullable(),
    /** The stored cancel request. It stays null until a person asks to cancel the job. */
    cancelRequest: jobCancelRequestSchema.nullable(),
  })
  .refine(
    (summary) =>
      summary.exportSummary === null ||
      summary.action === 'export-devices',
    { message: 'Only an export job carries an export summary.' },
  )
  .refine(
    (summary) =>
      summary.importSummary === null ||
      summary.action === 'validate-device-import',
    { message: 'Only a validation job carries an import summary.' },
  )
  .refine(
    (summary) =>
      summary.phase === null ||
      summary.action === 'export-devices' ||
      summary.action === 'validate-device-import',
    { message: 'Only an export or a validation job carries a phase.' },
  );
export type JobSummary = z.infer<typeof jobSummarySchema>;

/** The four refusals of the cancel route (design section 1). */
export const jobCancelRefusalSchema = z.enum([
  'job-not-found',
  'cancel-not-permitted',
  'job-finished',
  'nothing-to-stop',
]);
export type JobCancelRefusal = z.infer<typeof jobCancelRefusalSchema>;

/** The operation outcomes that the API shows. A dispatched or issued operation reads pending. */
export const jobOutcomeSchema = z.enum([
  'pending',
  'succeeded',
  'failed',
  'unknown',
  'skipped',
  'expired',
  /** An operation that never left the worker (design section 1). */
  'cancelled',
]);
export type JobOutcome = z.infer<typeof jobOutcomeSchema>;

export const jobVerifiedBySchema = z.enum(['write-response', 'read-back']);
export type JobVerifiedBy = z.infer<typeof jobVerifiedBySchema>;

/** The stored command states that one poll can observe (section 1, command operation states). */
export const jobCommandStateSchema = z.enum([
  'pending-delivery',
  'sent',
  'acknowledged',
]);
export type JobCommandState = z.infer<typeof jobCommandStateSchema>;

/** One operation of a write job (section 1.4). The command fields stay null outside a command job. */
export const jobOperationSchema = z.strictObject({
  operationId: jobOperationIdSchema,
  deviceId,
  serialNumber,
  orgUnitPath,
  /** The written field of an update row. It stays null for a command or a status row. */
  field: jobOperationFieldSchema.nullable(),
  operation: z.enum([
    'replace',
    'clear',
    'move',
    'reboot',
    'wipe-users',
    'powerwash',
    'disable',
    'reenable',
    'deprovision',
  ]),
  baselineValue: z.string().max(4096).nullable(),
  requestedValue: z.string().max(4096).nullable(),
  outcome: jobOutcomeSchema,
  outcomeReason: productCode.nullable(),
  googleStatus: z.number().int().min(100).max(599).nullable(),
  googleReason: z.string().min(1).max(256).nullable(),
  observedValue: z.string().max(4096).nullable(),
  verifiedBy: jobVerifiedBySchema.nullable(),
  /** The Google command ID of an issued command (section 1, command operation states). */
  commandId: z
    .string()
    .regex(/^[0-9]{1,20}$/)
    .nullable(),
  commandState: jobCommandStateSchema.nullable(),
  /** The expiry that Google returned, or null before the first poll stores it. */
  commandExpiresAt: timestamp.nullable(),
  commandExecutedAt: timestamp.nullable(),
  updatedAt: timestamp,
});
export type JobOperation = z.infer<typeof jobOperationSchema>;

/** One failed sample of the Latest activity line. */
export const jobFailedActivityOperationSchema = z.strictObject({
  operationId: jobOperationIdSchema,
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
  operationId: jobOperationIdSchema,
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
export const jobDetailSchema = jobSummarySchema
  .extend({
    confirmedBy: jobPersonSchema.nullable(),
    previewDisplayId: previewDisplayIdSchema.nullable(),
    /** The frozen changes of a selection job, in contract order. Null for an edit-list job and
     * outside an update job. */
    changes: deviceUpdateChangesSchema.nullable(),
    /** The Google command of a command job. It stays null for another job. */
    commandType: z
      .enum(['REBOOT', 'WIPE_USERS', 'REMOTE_POWERWASH'])
      .nullable(),
    /** The request of a status job. It stays null for another job. */
    statusAction: z.enum(['disable', 'reenable', 'deprovision']).nullable(),
    /** The frozen reason of a Deprovision job. It stays null for another job. */
    deprovisionReason: deprovisionReasonSchema.nullable(),
    targetOrgUnitPaths: z.array(orgUnitPath).max(10000).nullable(),
    /** The published file of an export job (design sections 1 and 5). It stays null for another
     * job. */
    exportFile: z
      .strictObject({
        name: z.string().min(1).max(255),
        sizeBytes: count,
        rows: count,
        columns: count,
        expiresAt: timestamp,
      })
      .nullable(),
    /** The uploaded file of a validation job (design sections 1 and 6). It stays null for another
     * job. */
    importSource: z
      .strictObject({
        name: z.string().min(1).max(255),
        sizeBytes: count,
        rowsRead: count,
        candidateRows: count,
        /** The refusal text of a failed header check, for states 23 and 26. */
        refusalText: z.string().min(1).max(1024).nullable(),
      })
      .nullable(),
    /** The plan of a validation job (design section 1). It stays null for another job. */
    plan: jobImportPlanSchema.nullable(),
    /** The validation job that created this write job (design section 8). */
    importDisplayId: jobDisplayIdSchema.nullable(),
    /** The update job that this status job of an import waits for (design section 3). */
    waitsForDisplayId: jobDisplayIdSchema.nullable(),
    /** The status jobs that wait for this update job (design section 3). */
    waitingDisplayIds: z.array(jobDisplayIdSchema).max(6).nullable(),
    /** The jobs of an executed plan (design section 8). */
    planJobs: z.array(jobSummarySchema).max(7).nullable(),
    /** The changes of an executed plan by outcome (design section 8). */
    executionCounts: jobExecutionCountsSchema.nullable(),
    correlationId: z.uuid(),
    latestActivity: jobLatestActivitySchema,
  })
  .refine(
    (detail) =>
      (detail.action === 'deprovision-devices') ===
      (detail.deprovisionReason !== null),
    {
      message:
        'A Deprovision job carries its reason, and another job carries none.',
    },
  );
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

/** The list answer of section 2.5. `nextCursor` pages the keyset sort. */
export const jobListSchema = z.strictObject({
  jobs: z.array(jobSummarySchema),
  matching: count,
  nextCursor: z.string().min(1).max(1024).nullable(),
  observedAt: timestamp,
});
export type JobList = z.infer<typeof jobListSchema>;

/** One page of operations of section 2.5. */
export const jobOperationsPageSchema = z.strictObject({
  operations: z.array(jobOperationSchema).max(1000),
  nextCursor: z.string().min(1).max(1024).nullable(),
});
export type JobOperationsPage = z.infer<typeof jobOperationsPageSchema>;

/** The requesters answer of section 2.5. */
export const jobRequestersSchema = z.strictObject({
  requesters: z.array(jobPersonSchema).max(20),
});
export type JobRequesters = z.infer<typeof jobRequestersSchema>;

/** The answer of `POST /api/jobs/activity/seen`. */
export const jobSeenSchema = z.strictObject({ seenAt: timestamp });
export type JobSeen = z.infer<typeof jobSeenSchema>;

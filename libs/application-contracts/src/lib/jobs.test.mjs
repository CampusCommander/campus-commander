import assert from 'node:assert/strict';
import test from 'node:test';
import { entityEventSchema } from './entity-cache.ts';
import {
  DEPROVISION_REASON_LABELS,
  DEPROVISION_REASONS,
  deprovisionReasonSchema,
} from './devices.ts';
import {
  JOB_ACTION_LABELS,
  jobActionSchema,
  jobActivitySchema,
  jobCancelRefusalSchema,
  jobCommandStateSchema,
  jobDetailSchema,
  jobDisplayIdSchema,
  jobEventSchema,
  jobEventsChannel,
  jobExecutionCountsSchema,
  jobExportPurposeSchema,
  jobImportPlanStateSchema,
  jobLatestActivitySchema,
  jobListSchema,
  jobOperationIdSchema,
  jobOperationSchema,
  jobOperationsPageSchema,
  jobOutcomeSchema,
  jobPhaseNameSchema,
  jobPhaseSchema,
  jobProgressSchema,
  jobRequestersSchema,
  jobSeenSchema,
  jobStatusSchema,
  jobSummarySchema,
} from './jobs.ts';
import {
  DEVICE_EDIT_DUPLICATE_HEADER_REFUSAL_MAX_LENGTH,
  DEVICE_EDIT_TEMPLATE_COLUMNS,
  matchDeviceEditHeaders,
} from './device-edit-template.ts';
import { deviceImportRefusalText } from './device-import.ts';
import { CSV_MAX_CELL_LENGTH } from './csv.ts';

const jobId = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';
const requesterId = '1a2b3c4d-5e6f-7081-92a3-b4c5d6e7f809';
const at = '2026-10-17T12:00:00.000Z';

const summary = {
  jobId,
  displayId: 'UPD-006',
  revision: 3,
  action: 'update-device-annotations',
  status: 'running',
  scope: { kind: 'devices', deviceCount: 12 },
  requestedBy: { id: requesterId, displayName: 'Alex Rivera' },
  createdAt: at,
  startedAt: at,
  finishedAt: null,
  progress: {
    total: 12,
    succeeded: 4,
    failed: 1,
    unknown: 0,
    skipped: 0,
    expired: 0,
    cancelled: 0,
    pending: 7,
  },
  phase: null,
  exportSummary: null,
  importSummary: null,
  failure: null,
  cancelRequest: null,
};

const operation = {
  operationId: 'UPD-006-3',
  deviceId: 'device-3',
  serialNumber: 'C0A1-7F2D',
  orgUnitPath: '/School A',
  field: 'annotatedLocation',
  operation: 'replace',
  baselineValue: 'Room 7',
  requestedValue: 'Room 12',
  outcome: 'pending',
  outcomeReason: null,
  googleStatus: null,
  googleReason: null,
  observedValue: null,
  verifiedBy: null,
  commandId: null,
  commandState: null,
  commandExpiresAt: null,
  commandExecutedAt: null,
  updatedAt: at,
};

test('display IDs and statuses carry the job vocabulary', () => {
  for (const id of [
    'UPD-006',
    'REF-031',
    'UPD-1000',
    'CMD-001',
    'STS-001',
    'CMD-1000',
    'EXP-001',
    'IMP-007',
    'EXP-1000',
  ])
    assert.equal(jobDisplayIdSchema.safeParse(id).success, true);
  for (const id of [
    'PV-006',
    'UPD-06',
    'UPD-006-3',
    'upd-006',
    'UPD',
    'EXP-01',
    'IMPORT-001',
    'exp-001',
  ])
    assert.equal(jobDisplayIdSchema.safeParse(id).success, false);
  assert.deepEqual(jobStatusSchema.options, [
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
  assert.deepEqual(jobActionSchema.options, [
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
  assert.deepEqual(JOB_ACTION_LABELS, {
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
  });
});

test('the Deprovision contract takes Google four admin reasons only', () => {
  assert.deepEqual(DEPROVISION_REASONS, [
    'DEPROVISION_REASON_RETIRING_DEVICE',
    'DEPROVISION_REASON_DIFFERENT_MODEL_REPLACEMENT',
    'DEPROVISION_REASON_SAME_MODEL_REPLACEMENT',
    'DEPROVISION_REASON_UPGRADE_TRANSFER',
  ]);
  assert.deepEqual(deprovisionReasonSchema.options, DEPROVISION_REASONS);
  assert.deepEqual(DEPROVISION_REASON_LABELS, {
    DEPROVISION_REASON_RETIRING_DEVICE: 'Retiring from fleet',
    DEPROVISION_REASON_DIFFERENT_MODEL_REPLACEMENT:
      'Different model replacement',
    DEPROVISION_REASON_SAME_MODEL_REPLACEMENT: 'Same model replacement',
    DEPROVISION_REASON_UPGRADE_TRANSFER: 'ChromeOS Flex upgrade transfer',
  });
  for (const value of DEPROVISION_REASONS)
    assert.equal(deprovisionReasonSchema.safeParse(value).success, true);
  // The seven values outside the four fail the schema before any Google call (record D11).
  for (const value of [
    'DEPROVISION_REASON_UNSPECIFIED',
    'DEPROVISION_REASON_UPGRADE',
    'DEPROVISION_REASON_DOMAIN_MOVE',
    'DEPROVISION_REASON_SERVICE_EXPIRATION',
    'DEPROVISION_REASON_OTHER',
    'DEPROVISION_REASON_NOT_REQUIRED',
    'DEPROVISION_REASON_REPAIR_CENTER',
  ])
    assert.equal(
      deprovisionReasonSchema.safeParse(value).success,
      false,
      `${value} must fail.`,
    );
  assert.equal(deprovisionReasonSchema.safeParse(undefined).success, false);
});

test('the command and status vocabulary is accepted', () => {
  // Display IDs of the two new kinds, and a command operation ID of each kind.
  assert.equal(jobDisplayIdSchema.safeParse('CMD-001').success, true);
  assert.equal(jobDisplayIdSchema.safeParse('STS-001').success, true);
  assert.equal(jobStatusSchema.safeParse('awaiting-devices').success, true);
  assert.equal(jobOutcomeSchema.safeParse('expired').success, true);
  assert.equal(jobCommandStateSchema.safeParse('sent').success, true);
  assert.equal(jobCommandStateSchema.safeParse('delivered').success, false);
  for (const operationId of [
    'CMD-001-1',
    'STS-001-12',
    'UPD-006-3',
    'UPD-006-3-annotatedLocation',
    'UPD-006-3-annotatedAssetId',
    'UPD-006-3-annotatedUser',
    'UPD-006-3-notes',
    'UPD-006-3-orgUnitPath',
  ])
    assert.equal(jobOperationIdSchema.safeParse(operationId).success, true);
  for (const operationId of [
    'REF-001-1',
    'CMD-01-1',
    'CMD-001',
    'UPD-006-3-assetTag',
    'UPD-006-3-annotatedlocation',
  ])
    assert.equal(jobOperationIdSchema.safeParse(operationId).success, false);
  // A command row names no field, and an update row names exactly one of the five.
  assert.equal(
    jobOperationSchema.safeParse({ ...operation, field: null }).success,
    true,
  );
  assert.equal(
    jobOperationSchema.safeParse({
      ...operation,
      field: 'annotatedAssetId',
    }).success,
    true,
  );
  assert.equal(
    jobOperationSchema.safeParse({ ...operation, field: 'assetTag' }).success,
    false,
  );
  assert.equal(
    jobOperationSchema.safeParse({ ...operation, field: undefined }).success,
    false,
  );
  // One command summary and one operation carry the new fields.
  const command = {
    ...summary,
    displayId: 'CMD-001',
    action: 'reboot-devices',
    status: 'awaiting-devices',
    progress: {
      ...summary.progress,
      total: 1,
      succeeded: 0,
      failed: 0,
      pending: 1,
    },
  };
  assert.equal(jobSummarySchema.safeParse(command).success, true);
  const issued = {
    ...operation,
    operationId: 'CMD-001-1',
    operation: 'reboot',
    requestedValue: null,
    baselineValue: 'ACTIVE',
    commandId: '4100000001',
    commandState: 'pending-delivery',
    commandExpiresAt: at,
    commandExecutedAt: null,
  };
  assert.deepEqual(jobOperationSchema.parse(issued), issued);
  assert.equal(
    jobOperationSchema.safeParse({ ...issued, commandId: 'abc' }).success,
    false,
  );
  assert.equal(
    jobOperationSchema.safeParse({ ...issued, commandState: 'expired' })
      .success,
    false,
  );
  const expired = {
    ...operation,
    operationId: 'STS-001-2',
    operation: 'disable',
    outcome: 'expired',
  };
  assert.equal(jobOperationSchema.safeParse(expired).success, true);
  // Each command and status operation word parses (design section 1).
  for (const word of [
    'reboot',
    'wipe-users',
    'powerwash',
    'disable',
    'reenable',
    'deprovision',
  ])
    assert.equal(
      jobOperationSchema.safeParse({ ...issued, operation: word }).success,
      true,
      `${word} must parse.`,
    );
  assert.equal(
    jobOperationSchema.safeParse({ ...issued, operation: 'powerwash-devices' })
      .success,
    false,
  );
});

test('job summaries are strict objects', () => {
  assert.deepEqual(jobSummarySchema.parse(summary), summary);
  assert.equal(
    jobSummarySchema.safeParse({ ...summary, extra: true }).success,
    false,
  );
  assert.equal(
    jobSummarySchema.safeParse({ ...summary, status: 'cancelled' }).success,
    true,
  );
  assert.equal(
    jobSummarySchema.safeParse({ ...summary, revision: 0 }).success,
    false,
  );
  assert.equal(
    jobSummarySchema.safeParse({ ...summary, failure: 'permission-changed' })
      .success,
    true,
  );
  assert.equal(
    jobSummarySchema.safeParse({ ...summary, failure: 'interrupted' }).success,
    true,
  );
  assert.equal(
    jobSummarySchema.safeParse({ ...summary, failure: 'unknown-code' }).success,
    false,
  );
  const missing = { ...summary };
  delete missing.displayId;
  assert.equal(jobSummarySchema.safeParse(missing).success, false);
});

test('progress counts total and pending together', () => {
  const running = {
    total: null,
    succeeded: 5,
    failed: 0,
    unknown: 1,
    skipped: 0,
    expired: 0,
    cancelled: 0,
    pending: null,
  };
  assert.equal(jobProgressSchema.safeParse(running).success, true);
  assert.equal(
    jobProgressSchema.safeParse({ ...running, pending: 0 }).success,
    false,
  );
  assert.equal(
    jobProgressSchema.safeParse({ ...running, total: 6 }).success,
    false,
  );
  assert.equal(
    jobProgressSchema.safeParse({ ...running, total: 6, pending: 1 }).success,
    true,
  );
  assert.equal(
    jobProgressSchema.safeParse({ ...running, extra: 1 }).success,
    false,
  );
});

test('a progress carries a required cancelled count', () => {
  assert.equal(jobProgressSchema.safeParse(summary.progress).success, true);
  assert.equal(summary.progress.cancelled, 0);
  const cancelled = {
    ...summary.progress,
    succeeded: 4,
    cancelled: 8,
    pending: 0,
  };
  assert.equal(jobProgressSchema.safeParse(cancelled).success, true);
  assert.equal(jobProgressSchema.parse(cancelled).cancelled, 8);
  // A progress without the count fails, so a reader never invents it.
  const withoutCancelled = { ...summary.progress };
  delete withoutCancelled.cancelled;
  assert.equal(jobProgressSchema.safeParse(withoutCancelled).success, false);
  assert.equal(
    jobProgressSchema.safeParse({ ...summary.progress, cancelled: -1 }).success,
    false,
  );
  assert.equal(
    jobProgressSchema.safeParse({ ...summary.progress, cancelled: 1.5 })
      .success,
    false,
  );
});

test('the cancelled status and outcome parse', () => {
  assert.equal(jobStatusSchema.safeParse('cancelled').success, true);
  assert.equal(jobOutcomeSchema.safeParse('cancelled').success, true);
  const cancelled = {
    ...summary,
    status: 'cancelled',
    finishedAt: at,
    progress: { ...summary.progress, succeeded: 4, cancelled: 8, pending: 0 },
  };
  assert.deepEqual(jobSummarySchema.parse(cancelled), cancelled);
  assert.equal(
    jobOperationSchema.safeParse({ ...operation, outcome: 'cancelled' })
      .success,
    true,
  );
});

test('a cancel request names one person and one time', () => {
  const request = {
    at,
    by: { id: requesterId, displayName: 'Alex Rivera' },
  };
  const requested = { ...summary, cancelRequest: request };
  assert.deepEqual(jobSummarySchema.parse(requested), requested);
  assert.equal(
    jobSummarySchema.safeParse({ ...summary, cancelRequest: {} }).success,
    false,
  );
  assert.equal(
    jobSummarySchema.safeParse({ ...summary, cancelRequest: { at } }).success,
    false,
    'A request names the person who asked.',
  );
  assert.equal(
    jobSummarySchema.safeParse({
      ...summary,
      cancelRequest: { ...request, by: requesterId },
    }).success,
    false,
    'The person holds the job person shape.',
  );
  assert.equal(
    jobSummarySchema.safeParse({
      ...summary,
      cancelRequest: { ...request, at: '2026-10-17' },
    }).success,
    false,
  );
  assert.equal(
    jobSummarySchema.safeParse({
      ...summary,
      cancelRequest: { ...request, extra: true },
    }).success,
    false,
  );
  // The detail inherits the request of the summary.
  const detail = {
    ...requested,
    confirmedBy: null,
    previewDisplayId: null,
    changes: null,
    commandType: null,
    statusAction: null,
    deprovisionReason: null,
    targetOrgUnitPaths: null,
    exportFile: null,
    importSource: null,
    plan: null,
    importDisplayId: null,
    waitsForDisplayId: null,
    waitingDisplayIds: null,
    planJobs: null,
    executionCounts: null,
    correlationId: jobId,
    latestActivity: {
      at,
      failed: { count: 0, operations: [] },
      unknown: { count: 0, operations: [] },
    },
  };
  assert.deepEqual(jobDetailSchema.parse(detail).cancelRequest, request);
  assert.equal(
    jobDetailSchema.safeParse({ ...detail, cancelRequest: undefined }).success,
    false,
    'The detail requires the request field.',
  );
});

test('the cancel route answers four refusal reasons', () => {
  assert.deepEqual(jobCancelRefusalSchema.options, [
    'job-not-found',
    'cancel-not-permitted',
    'job-finished',
    'nothing-to-stop',
  ]);
  assert.equal(
    jobCancelRefusalSchema.safeParse('job-cancelled').success,
    false,
  );
});

test('operations report the API outcome vocabulary', () => {
  assert.deepEqual(jobOperationSchema.parse(operation), operation);
  assert.equal(
    jobOperationSchema.safeParse({ ...operation, outcome: 'dispatched' })
      .success,
    false,
  );
  assert.equal(
    jobOperationSchema.safeParse({ ...operation, verifiedBy: 'read-back' })
      .success,
    true,
  );
  assert.equal(
    jobOperationSchema.safeParse({ ...operation, operationId: 'REF-031-1' })
      .success,
    false,
  );
  assert.equal(
    jobOperationSchema.safeParse({ ...operation, updatedAt: null }).success,
    false,
  );
  assert.equal(
    jobOperationSchema.safeParse({ ...operation, extra: true }).success,
    false,
  );
});

test('job detail extends the summary with the write fields', () => {
  const detail = {
    ...summary,
    confirmedBy: { id: requesterId, displayName: 'Alex Rivera' },
    previewDisplayId: 'PV-006',
    changes: [
      { field: 'annotatedUser', mode: 'replace', value: 'A person' },
      { field: 'notes', mode: 'clear' },
    ],
    commandType: null,
    statusAction: null,
    deprovisionReason: null,
    targetOrgUnitPaths: ['/School A'],
    exportFile: null,
    importSource: null,
    plan: null,
    importDisplayId: null,
    waitsForDisplayId: null,
    waitingDisplayIds: null,
    planJobs: null,
    executionCounts: null,
    correlationId: jobId,
    latestActivity: {
      at,
      failed: { count: 0, operations: [] },
      unknown: { count: 0, operations: [] },
    },
  };
  assert.deepEqual(jobDetailSchema.parse(detail), detail);
  assert.equal(
    jobDetailSchema.safeParse({ ...detail, extra: true }).success,
    false,
  );
  assert.equal(
    jobDetailSchema.safeParse({ ...detail, previewDisplayId: 'UPD-006' })
      .success,
    false,
  );
  assert.equal(
    jobDetailSchema.safeParse({
      ...detail,
      changes: [{ field: 'notes', mode: 'clear', value: 'Room 12' }],
    }).success,
    false,
    'A clear change carries no value.',
  );
  assert.equal(
    jobDetailSchema.safeParse({ ...detail, changes: [] }).success,
    false,
    'A write job carries at least one change.',
  );
  assert.equal(
    jobDetailSchema.safeParse({ ...detail, changes: null }).success,
    true,
    'A command or status job carries no changes.',
  );
  assert.equal(
    jobDetailSchema.safeParse({
      ...detail,
      changes: [{ field: 'annotatedAssetId', mode: 'replace', value: 'AT-42' }],
    }).success,
    false,
    'An edit-list job answers no changes, never its per-row requests.',
  );
  const refresh = {
    ...detail,
    displayId: 'REF-031',
    action: 'refresh-inventory',
    confirmedBy: null,
    previewDisplayId: null,
    changes: null,
    targetOrgUnitPaths: null,
  };
  assert.equal(jobDetailSchema.safeParse(refresh).success, true);
  const command = {
    ...detail,
    displayId: 'CMD-001',
    action: 'reboot-devices',
    changes: null,
    commandType: 'REBOOT',
  };
  assert.equal(jobDetailSchema.safeParse(command).success, true);
  assert.equal(
    jobDetailSchema.safeParse({
      ...command,
      action: 'powerwash-devices',
      commandType: 'REMOTE_POWERWASH',
    }).success,
    true,
  );
  assert.equal(
    jobDetailSchema.safeParse({
      ...command,
      action: 'wipe-user-data',
      commandType: 'WIPE_USERS',
    }).success,
    true,
  );
  assert.equal(
    jobDetailSchema.safeParse({ ...command, commandType: 'POWERWASH' }).success,
    false,
    'The contract names the Google command type.',
  );
  const status = {
    ...detail,
    displayId: 'STS-001',
    action: 'disable-devices',
    changes: null,
    statusAction: 'disable',
  };
  assert.equal(jobDetailSchema.safeParse(status).success, true);
  const deprovision = {
    ...status,
    displayId: 'STS-002',
    action: 'deprovision-devices',
    statusAction: 'deprovision',
    deprovisionReason: 'DEPROVISION_REASON_RETIRING_DEVICE',
  };
  assert.equal(jobDetailSchema.safeParse(deprovision).success, true);
  assert.equal(
    jobDetailSchema.safeParse({ ...deprovision, deprovisionReason: null })
      .success,
    false,
    'A Deprovision job carries its reason.',
  );
  assert.equal(
    jobDetailSchema.safeParse({
      ...status,
      deprovisionReason: 'DEPROVISION_REASON_RETIRING_DEVICE',
    }).success,
    false,
    'Another job carries no reason.',
  );
  assert.equal(
    jobDetailSchema.safeParse({ ...status, statusAction: 'powerwash' }).success,
    false,
  );
});

test('activity caps rows and reports a null window', () => {
  const activity = {
    running: { count: 1, jobs: [summary] },
    waiting: { count: 0, jobs: [] },
    recent: { count: 1, jobs: [summary], nextExpiryAt: at },
    attention: true,
    seenAt: null,
    observedAt: at,
  };
  assert.equal(jobActivitySchema.safeParse(activity).success, true);
  assert.equal(
    jobActivitySchema.safeParse({
      ...activity,
      recent: { ...activity.recent, nextExpiryAt: null },
    }).success,
    true,
  );
  assert.equal(
    jobActivitySchema.safeParse({
      ...activity,
      running: { count: 51, jobs: Array(51).fill(summary) },
    }).success,
    false,
  );
  assert.equal(
    jobActivitySchema.safeParse({
      ...activity,
      waiting: { count: 51, jobs: Array(51).fill(summary) },
    }).success,
    false,
  );
  assert.equal(
    jobActivitySchema.safeParse({
      ...activity,
      recent: { count: 11, jobs: Array(11).fill(summary) },
    }).success,
    false,
  );
  assert.equal(
    jobActivitySchema.safeParse({ ...activity, extra: true }).success,
    false,
  );
});

test('latest activity stops at three samples per outcome', () => {
  const sample = {
    operationId: 'UPD-006-3',
    deviceId: 'device-3',
    serialNumber: 'C0A1-7F2D',
    updatedAt: at,
  };
  const failedSample = {
    ...sample,
    outcomeReason: 'quota',
    googleStatus: 403,
    googleReason: 'forbidden',
  };
  const latest = {
    at,
    failed: { count: 9, operations: Array(3).fill(failedSample) },
    unknown: { count: 4, operations: Array(3).fill(sample) },
  };
  assert.equal(jobLatestActivitySchema.safeParse(latest).success, true);
  assert.equal(
    jobLatestActivitySchema.safeParse({
      ...latest,
      failed: { count: 9, operations: Array(4).fill(failedSample) },
    }).success,
    false,
  );
  assert.equal(
    jobLatestActivitySchema.safeParse({
      ...latest,
      unknown: { count: 4, operations: Array(4).fill(sample) },
    }).success,
    false,
  );
  const withoutUpdatedAt = {
    operationId: 'UPD-006-3',
    deviceId: 'device-3',
    serialNumber: 'C0A1-7F2D',
  };
  assert.equal(
    jobLatestActivitySchema.safeParse({
      ...latest,
      unknown: { count: 1, operations: [withoutUpdatedAt] },
    }).success,
    false,
  );
  assert.equal(
    jobLatestActivitySchema.safeParse({
      ...latest,
      failed: { count: 1, operations: [{ ...failedSample, extra: true }] },
    }).success,
    false,
  );
});

test('job events accept only job-changed and require a requester', () => {
  const event = {
    type: 'job-changed',
    jobId,
    displayId: 'UPD-006',
    revision: 3,
    requestedBy: requesterId,
  };
  assert.deepEqual(jobEventSchema.parse(event), event);
  assert.equal(
    jobEventSchema.safeParse({ type: 'other', jobId }).success,
    false,
  );
  const withoutRequester = { ...event };
  delete withoutRequester.requestedBy;
  assert.equal(jobEventSchema.safeParse(withoutRequester).success, false);
  assert.equal(entityEventSchema.safeParse(event).success, false);
  assert.equal(jobEventsChannel('C0123456'), 'cc:job-events:C0123456');
});

test('the list answer carries the page, the matching count, and the next cursor', () => {
  const list = {
    jobs: [summary],
    matching: 1,
    nextCursor: null,
    observedAt: at,
  };
  assert.deepEqual(jobListSchema.parse(list), list);
  assert.equal(
    jobListSchema.safeParse({ ...list, extra: true }).success,
    false,
  );
  assert.equal(
    jobListSchema.safeParse({ ...list, nextCursor: '' }).success,
    false,
  );
});

test('the operations page caps at 1,000 rows and pages with a string cursor', () => {
  const page = { operations: [operation], nextCursor: '3' };
  assert.deepEqual(jobOperationsPageSchema.parse(page), page);
  assert.equal(
    jobOperationsPageSchema.safeParse({ operations: [], nextCursor: null })
      .success,
    true,
  );
  assert.equal(
    jobOperationsPageSchema.safeParse({ ...page, extra: true }).success,
    false,
  );
});

test('the requesters answer caps at 20 people', () => {
  assert.deepEqual(
    jobRequestersSchema.parse({
      requesters: [{ id: requesterId, displayName: 'Alex Rivera' }],
    }),
    { requesters: [{ id: requesterId, displayName: 'Alex Rivera' }] },
  );
  assert.equal(
    jobRequestersSchema.safeParse({ requesters: [{ id: requesterId }] })
      .success,
    false,
  );
});

test('the seen answer carries the stored time', () => {
  assert.deepEqual(jobSeenSchema.parse({ seenAt: at }), { seenAt: at });
  assert.equal(jobSeenSchema.safeParse({}).success, false);
});

const detailOf = (row) => ({
  ...row,
  confirmedBy: null,
  previewDisplayId: null,
  changes: null,
  commandType: null,
  statusAction: null,
  deprovisionReason: null,
  targetOrgUnitPaths: null,
  exportFile: null,
  importSource: null,
  plan: null,
  importDisplayId: null,
  waitsForDisplayId: null,
  waitingDisplayIds: null,
  planJobs: null,
  executionCounts: null,
  correlationId: jobId,
  latestActivity: {
    at,
    failed: { count: 0, operations: [] },
    unknown: { count: 0, operations: [] },
  },
});

test('the export phases and purpose parse', () => {
  assert.deepEqual(jobPhaseNameSchema.options, [
    'write-rows',
    'create-sheet',
    'prepare-download',
    'drive-read',
    'header-check',
    'refresh',
    'compare',
    'report',
  ]);
  assert.deepEqual(jobExportPurposeSchema.options, ['edit', 'report']);
  const phase = { name: 'write-rows', done: 32, total: 48 };
  assert.deepEqual(jobPhaseSchema.parse(phase), phase);
  // A phase without a total parses, and one outside the six names fails.
  assert.equal(
    jobPhaseSchema.safeParse({ name: 'prepare-download', done: 0, total: null })
      .success,
    true,
  );
  assert.equal(
    jobPhaseSchema.safeParse({ name: 'upload', done: 0, total: null }).success,
    false,
  );
  assert.equal(
    jobPhaseSchema.safeParse({ ...phase, extra: true }).success,
    false,
  );
  assert.equal(jobPhaseSchema.safeParse({ ...phase, done: -1 }).success, false);
});

test('an export job carries its phase, its summary, and its file', () => {
  const row = {
    ...summary,
    displayId: 'EXP-001',
    action: 'export-devices',
    scope: { kind: 'rows', deviceCount: 48 },
    phase: { name: 'write-rows', done: 32, total: 48 },
    exportSummary: { purpose: 'edit' },
  };
  assert.deepEqual(jobSummarySchema.parse(row), row);
  const detail = {
    ...detailOf(row),
    exportFile: {
      name: 'devices-for-editing-EXP-001.csv',
      sizeBytes: 7987,
      rows: 48,
      columns: 10,
      expiresAt: at,
    },
  };
  // A built fixture takes the CSV defaults (Drive slice design section 1).
  const parsed = jobDetailSchema.parse(detail);
  assert.deepEqual(parsed.exportFile, {
    ...detail.exportFile,
    format: 'csv',
    sheetUrl: null,
  });
  assert.equal(
    jobDetailSchema.safeParse({
      ...detail,
      exportFile: { ...detail.exportFile, columns: -1 },
    }).success,
    false,
  );
  // A Sheet file carries its link and no size or expiry (design section 1, notes:225).
  const sheet = {
    ...detail,
    exportFile: {
      name: 'devices-for-editing-EXP-003',
      format: 'sheet',
      sizeBytes: null,
      rows: 48,
      columns: 10,
      expiresAt: null,
      sheetUrl: 'https://docs.google.com/spreadsheets/d/1Abc_def-ghi/edit',
    },
  };
  assert.deepEqual(jobDetailSchema.parse(sheet), sheet);
  assert.equal(
    jobDetailSchema.safeParse({
      ...sheet,
      exportFile: { ...sheet.exportFile, sheetUrl: 'not a url' },
    }).success,
    false,
  );
});

test('a validation job carries its phase, its summary, the plan, and the counts', () => {
  const row = {
    ...summary,
    displayId: 'IMP-001',
    action: 'validate-device-import',
    scope: { kind: 'rows', deviceCount: 48 },
    phase: { name: 'refresh', done: 6, total: 9 },
    importSummary: {
      mode: 'sync-changes',
      planState: 'open',
      proposed: 11,
      rejected: 4,
      refusal: null,
    },
  };
  assert.deepEqual(jobSummarySchema.parse(row), row);
  const detail = {
    ...detailOf(row),
    importSource: {
      name: 'devices-for-editing-EXP-001.csv',
      sizeBytes: 7987,
      rowsRead: 48,
      candidateRows: 13,
      refusalText: null,
    },
    plan: {
      planId: jobId,
      revision: 1,
      state: 'open',
      expiresAt: at,
      changedBy: null,
      changedAt: null,
    },
    planJobs: [
      {
        ...row,
        displayId: 'UPD-001',
        exportSummary: null,
        importSummary: null,
        phase: null,
      },
    ],
    executionCounts: {
      succeeded: 4,
      failed: 1,
      unknown: 0,
      skipped: 0,
      expired: 0,
      cancelled: 0,
      pending: 6,
      notRun: 2,
    },
  };
  // A built fixture takes the CSV defaults (Drive slice design section 1).
  const parsed = jobDetailSchema.parse(detail);
  assert.deepEqual(parsed.importSource, {
    ...detail.importSource,
    sourceType: 'csv',
    tabTitle: null,
  });
  // A Drive source names its type and, for a Sheet, the chosen tab (design section 1).
  const drive = {
    ...detail,
    importSource: {
      ...detail.importSource,
      name: 'devices-for-editing-EXP-003',
      sourceType: 'drive-sheet',
      tabTitle: 'Devices',
    },
  };
  assert.deepEqual(jobDetailSchema.parse(drive), drive);
  for (const state of ['open', 'executed', 'cancelled', 'expired'])
    assert.equal(
      jobImportPlanStateSchema.safeParse(state).success,
      true,
      `${state} must parse.`,
    );
  assert.equal(jobImportPlanStateSchema.safeParse('draft').success, false);
  // A refused validation stores its code and its text for states 23 and 26.
  const refused = {
    ...row,
    importSummary: { ...row.importSummary, refusal: 'header-refused' },
  };
  assert.equal(jobSummarySchema.safeParse(refused).success, true);
  assert.equal(
    jobSummarySchema.safeParse({
      ...row,
      importSummary: { ...row.importSummary, refusal: 'x'.repeat(65) },
    }).success,
    false,
  );
  // The execution counts name every term of design section 8.
  const counts = detail.executionCounts;
  for (const term of Object.keys(counts)) {
    const missing = { ...counts };
    delete missing[term];
    assert.equal(
      jobExecutionCountsSchema.safeParse(missing).success,
      false,
      `${term} is required.`,
    );
  }
});

test('the longest header refusal fits the import source of a validation job', () => {
  // A duplicate unknown header of the longest cell refuses the file, and the refusal repeats
  // that whole header label.
  const header = 'x'.repeat(CSV_MAX_CELL_LENGTH);
  const refused = matchDeviceEditHeaders([
    ...DEVICE_EDIT_TEMPLATE_COLUMNS.map((column) => column.header),
    header,
    header,
  ]);
  assert.equal(refused.ok, false);
  if (refused.ok) throw new Error('The header must refuse.');
  assert.match(refused.reason, /^The file holds two /);
  const refusalText = deviceImportRefusalText('header-refused', refused.reason);
  assert.equal(refusalText, refused.reason);
  assert.ok(refusalText.length > 1024, 'The refusal passes the old cap.');
  assert.ok(
    refusalText.length <= DEVICE_EDIT_DUPLICATE_HEADER_REFUSAL_MAX_LENGTH,
  );
  const validation = detailOf({
    ...summary,
    displayId: 'IMP-001',
    action: 'validate-device-import',
    scope: { kind: 'rows', deviceCount: 0 },
  });
  const detail = {
    ...validation,
    importSource: {
      name: 'devices-for-editing-EXP-001.csv',
      sourceType: 'csv',
      sizeBytes: 7987,
      rowsRead: 0,
      candidateRows: 0,
      tabTitle: null,
      refusalText,
    },
  };
  assert.deepEqual(jobDetailSchema.parse(detail), detail);
  // The domain holds the longest refusal, and one character more is refused.
  const atLimit = {
    ...detail,
    importSource: {
      ...detail.importSource,
      refusalText: 'x'.repeat(DEVICE_EDIT_DUPLICATE_HEADER_REFUSAL_MAX_LENGTH),
    },
  };
  assert.equal(jobDetailSchema.safeParse(atLimit).success, true);
  assert.equal(
    jobDetailSchema.safeParse({
      ...atLimit,
      importSource: {
        ...atLimit.importSource,
        refusalText: 'x'.repeat(
          DEVICE_EDIT_DUPLICATE_HEADER_REFUSAL_MAX_LENGTH + 1,
        ),
      },
    }).success,
    false,
  );
});

test('each new block stays null for another kind of job', () => {
  assert.equal(
    jobSummarySchema.safeParse({
      ...summary,
      exportSummary: { purpose: 'edit' },
    }).success,
    false,
    'An update job carries no export summary.',
  );
  assert.equal(
    jobSummarySchema.safeParse({
      ...summary,
      importSummary: {
        mode: 'sync-changes',
        planState: null,
        proposed: 0,
        rejected: 0,
        refusal: null,
      },
    }).success,
    false,
    'An update job carries no import summary.',
  );
  assert.equal(
    jobSummarySchema.safeParse({
      ...summary,
      phase: { name: 'compare', done: 1, total: 2 },
    }).success,
    false,
    'An update job carries no phase.',
  );
  // A validation job answers no export summary, and an export job no import summary.
  const validation = {
    ...summary,
    displayId: 'IMP-001',
    action: 'validate-device-import',
  };
  assert.equal(
    jobSummarySchema.safeParse({
      ...validation,
      exportSummary: { purpose: 'report' },
    }).success,
    false,
  );
  const exported = {
    ...summary,
    displayId: 'EXP-001',
    action: 'export-devices',
  };
  assert.equal(
    jobSummarySchema.safeParse({
      ...exported,
      importSummary: {
        mode: 'sync-changes',
        planState: null,
        proposed: 0,
        rejected: 0,
        refusal: null,
      },
    }).success,
    false,
  );
});

test('the export and import failure codes parse', () => {
  for (const failure of [
    'storage-unavailable',
    'inventory-unavailable',
    'export-too-large',
    'drive-unavailable',
    'sheet-write-failed',
  ])
    assert.equal(
      jobSummarySchema.safeParse({ ...summary, failure }).success,
      true,
      `${failure} must parse.`,
    );
  assert.equal(
    jobSummarySchema.safeParse({ ...summary, failure: 'disk-full' }).success,
    false,
  );
  // A failed validation keeps the phase of its refusal.
  const failed = {
    ...summary,
    displayId: 'IMP-006',
    action: 'validate-device-import',
    status: 'failed',
    failure: 'storage-unavailable',
    phase: { name: 'header-check', done: 0, total: null },
    importSummary: {
      mode: 'sync-changes',
      planState: null,
      proposed: 0,
      rejected: 0,
      refusal: 'header-refused',
    },
  };
  assert.equal(jobSummarySchema.safeParse(failed).success, true);
});

test('each detail block belongs to its kind of job', () => {
  const update = detailOf({
    ...summary,
    displayId: 'UPD-001',
    action: 'update-device-annotations',
  });
  const exported = detailOf({
    ...summary,
    displayId: 'EXP-001',
    action: 'export-devices',
    scope: { kind: 'rows', deviceCount: 48 },
  });
  const validation = detailOf({
    ...summary,
    displayId: 'IMP-001',
    action: 'validate-device-import',
    scope: { kind: 'rows', deviceCount: 48 },
  });
  const file = {
    name: 'devices-for-editing-EXP-001.csv',
    sizeBytes: 7987,
    rows: 48,
    columns: 10,
    expiresAt: at,
  };
  const source = {
    name: 'devices-for-editing-EXP-001.csv',
    sizeBytes: 7987,
    rowsRead: 48,
    candidateRows: 13,
    refusalText: null,
  };
  // The blocks of one kind.
  assert.equal(
    jobDetailSchema.safeParse({ ...exported, exportFile: file }).success,
    true,
  );
  assert.equal(
    jobDetailSchema.safeParse({ ...validation, importSource: source }).success,
    true,
  );
  assert.equal(
    jobDetailSchema.safeParse({ ...validation, planJobs: [] }).success,
    true,
  );
  // A block of another kind.
  assert.equal(
    jobDetailSchema.safeParse({ ...update, exportFile: file }).success,
    false,
  );
  assert.equal(
    jobDetailSchema.safeParse({ ...validation, exportFile: file }).success,
    false,
  );
  assert.equal(
    jobDetailSchema.safeParse({ ...update, importSource: source }).success,
    false,
  );
  assert.equal(
    jobDetailSchema.safeParse({
      ...update,
      executionCounts: null,
      planJobs: [],
    }).success,
    false,
  );
  // A validation job links no other job, because its plan links its own jobs.
  assert.equal(
    jobDetailSchema.safeParse({ ...validation, importDisplayId: 'IMP-001' })
      .success,
    false,
  );
  assert.equal(
    jobDetailSchema.safeParse({ ...validation, waitsForDisplayId: 'UPD-001' })
      .success,
    false,
  );
  // A status job of a plan names the update job that it waits for.
  const status = detailOf({
    ...summary,
    displayId: 'STS-001',
    action: 'disable-devices',
    statusAction: 'disable',
  });
  assert.equal(
    jobDetailSchema.safeParse({ ...status, waitsForDisplayId: 'UPD-001' })
      .success,
    true,
  );
  assert.equal(
    jobDetailSchema.safeParse({ ...status, importDisplayId: 'IMP-001' })
      .success,
    true,
  );
  // An update job of a plan names the validation job and the status jobs that wait for it.
  assert.equal(
    jobDetailSchema.safeParse({
      ...update,
      importDisplayId: 'IMP-001',
      waitingDisplayIds: ['STS-001', 'STS-002'],
    }).success,
    true,
  );
});

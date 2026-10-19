import assert from 'node:assert/strict';
import test from 'node:test';
import { entityEventSchema } from './entity-cache.ts';
import {
  JOB_ACTION_LABELS,
  jobActionSchema,
  jobActivitySchema,
  jobDetailSchema,
  jobDisplayIdSchema,
  jobEventSchema,
  jobEventsChannel,
  jobLatestActivitySchema,
  jobListSchema,
  jobOperationSchema,
  jobOperationsPageSchema,
  jobProgressSchema,
  jobRequestersSchema,
  jobSeenSchema,
  jobStatusSchema,
  jobSummarySchema,
} from './jobs.ts';

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
    pending: 7,
  },
  failure: null,
};

const operation = {
  operationId: 'UPD-006-3',
  deviceId: 'device-3',
  serialNumber: 'C0A1-7F2D',
  orgUnitPath: '/School A',
  operation: 'replace',
  baselineValue: 'Room 7',
  requestedValue: 'Room 12',
  outcome: 'pending',
  outcomeReason: null,
  googleStatus: null,
  googleReason: null,
  observedValue: null,
  verifiedBy: null,
  updatedAt: at,
};

test('display IDs and statuses carry the job vocabulary', () => {
  for (const id of ['UPD-006', 'REF-031', 'UPD-1000'])
    assert.equal(jobDisplayIdSchema.safeParse(id).success, true);
  for (const id of ['PV-006', 'UPD-06', 'UPD-006-3', 'upd-006', 'UPD'])
    assert.equal(jobDisplayIdSchema.safeParse(id).success, false);
  assert.deepEqual(jobStatusSchema.options, [
    'accepted',
    'queued',
    'held',
    'running',
    'completed',
    'completed-with-errors',
    'failed',
    'needs-review',
  ]);
  assert.deepEqual(jobActionSchema.options, [
    'update-device-annotations',
    'refresh-inventory',
  ]);
  assert.deepEqual(JOB_ACTION_LABELS, {
    'update-device-annotations': 'Update device annotations',
    'refresh-inventory': 'Refresh inventory',
  });
});

test('job summaries are strict objects', () => {
  assert.deepEqual(jobSummarySchema.parse(summary), summary);
  assert.equal(
    jobSummarySchema.safeParse({ ...summary, extra: true }).success,
    false,
  );
  assert.equal(
    jobSummarySchema.safeParse({ ...summary, status: 'cancelled' }).success,
    false,
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
    field: 'annotatedLocation',
    mode: 'replace',
    requestedValue: 'Room 12',
    targetOrgUnitPaths: ['/School A'],
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
  const refresh = {
    ...detail,
    displayId: 'REF-031',
    action: 'refresh-inventory',
    confirmedBy: null,
    previewDisplayId: null,
    field: null,
    mode: null,
    requestedValue: null,
    targetOrgUnitPaths: null,
  };
  assert.equal(jobDetailSchema.safeParse(refresh).success, true);
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

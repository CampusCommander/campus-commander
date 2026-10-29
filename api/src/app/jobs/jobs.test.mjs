import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  decodeCursor,
  encodeCursor,
  jobOperation,
  jobSummary,
  latestActivity,
  Jobs,
  operationCursor,
  operationCursorSchema,
  seesEveryJob,
} from './jobs.ts';

const REQUESTER = '22222222-2222-4222-8222-222222222222';
const ACTOR = '44444444-4444-4444-8444-444444444444';

const jobRow = (overrides = {}) => ({
  job_id: '11111111-1111-4111-8111-111111111111',
  display_id: 'REF-001',
  customer_id: 'C0123456',
  kind: 'inventory-refresh',
  scope_kind: 'devices',
  status: 'completed',
  requested_by: REQUESTER,
  requested_by_name: 'Ada Lovelace',
  generation: 1,
  target_count: 3,
  target_org_unit_paths: ['/Schools/A'],
  succeeded: 2,
  failed: 1,
  unknown: 0,
  skipped: 0,
  expired: 0,
  failure: null,
  revision: 4,
  changed_at: new Date('2026-10-06T12:05:00.000Z'),
  correlation_id: '33333333-3333-4333-8333-333333333333',
  created_at: new Date('2026-10-06T12:00:00.000Z'),
  admitted_at: null,
  started_at: new Date('2026-10-06T12:00:00.000Z'),
  finished_at: new Date('2026-10-06T12:02:00.000Z'),
  confirmed_by: null,
  changes: null,
  deprovision_reason: null,
  confirmed_by_name: null,
  preview_display_id: null,
  ...overrides,
});

const session = (grants = []) => ({
  identity: {
    id: ACTOR,
    displayName: 'Grace Hopper',
    permissions: ['identity:read'],
    permissionVersion: 1,
    grants,
    preferences: { theme: 'system', navigationCollapsed: false },
  },
  expiresAt: '2026-10-06T13:00:00.000Z',
  csrfToken: 'a'.repeat(64),
});

/** A database whose answers match a needle of the statement text. Every call is recorded. */
function database(routes) {
  const calls = [];
  return {
    calls,
    connection: {
      async query(text, values = []) {
        calls.push([text, values]);
        // PostgreSQL binds by number: every parameter the text names must have a value, and every
        // value must be named. An off-by-one placeholder answers 08P01 in production.
        const used = new Set(
          [...text.matchAll(/\$(\d+)/g)].map((match) => Number(match[1])),
        );
        const highest = used.size ? Math.max(...used) : 0;
        if (used.size !== highest || highest !== values.length)
          throw Object.assign(
            new Error(
              `bind message supplies ${values.length} parameters, but prepared statement requires ${highest}`,
            ),
            { code: '08P01' },
          );
        for (const [needle, answer] of routes) {
          if (text.includes(needle))
            return {
              rows:
                typeof answer === 'function' ? answer(values, text) : answer,
            };
        }
        throw new Error(`Unexpected statement: ${text}`);
      },
    },
  };
}

/** The columns `j.*` expands in a job statement. */
const jobColumns = new Set([
  'job_id',
  'display_id',
  'customer_id',
  'kind',
  'scope_kind',
  'status',
  'requested_by',
  'generation',
  'target_count',
  'target_org_unit_paths',
  'succeeded',
  'failed',
  'unknown',
  'skipped',
  'expired',
  'cancelled',
  'cancel_requested_at',
  'cancel_requested_by',
  'phase',
  'phase_done',
  'phase_total',
  'failure',
  'revision',
  'changed_at',
  'correlation_id',
  'created_at',
  'admitted_at',
  'started_at',
  'finished_at',
]);

/**
 * One header row as PostgreSQL returns it. Every column of `j.*` arrives. Any other column arrives
 * only when the statement names it. A database double that answers every column whatever the
 * statement selects hides a missing projection (review R1).
 */
function headerRow(text, stored) {
  return Object.fromEntries(
    Object.entries(stored).filter(
      ([column]) =>
        jobColumns.has(column) || new RegExp(`\\b${column}\\b`).test(text),
    ),
  );
}

test('a refresh summary reads the REF- action, its requester, and its counters', () => {
  const summary = jobSummary(jobRow());
  assert.equal(summary.action, 'refresh-inventory');
  assert.equal(summary.displayId, 'REF-001');
  assert.deepEqual(summary.requestedBy, {
    id: REQUESTER,
    displayName: 'Ada Lovelace',
  });
  assert.deepEqual(summary.progress, {
    total: 3,
    succeeded: 2,
    failed: 1,
    unknown: 0,
    skipped: 0,
    expired: 0,
    cancelled: 0,
    pending: 0,
  });
  assert.equal(summary.cancelRequest, null);
  assert.equal(summary.scope.kind, 'devices');
  assert.equal(summary.revision, 4);
});

test('a running full sync reports a null total and a null pending count', () => {
  const summary = jobSummary(
    jobRow({
      display_id: 'REF-007',
      scope_kind: 'all-devices',
      status: 'running',
      target_count: null,
      target_org_unit_paths: null,
      succeeded: 42,
      failed: 0,
      finished_at: null,
    }),
  );
  assert.equal(summary.progress.total, null);
  assert.equal(summary.progress.pending, null);
  assert.equal(summary.progress.succeeded, 42);
  assert.equal(summary.scope.deviceCount, null);
});

test('a write summary reads the UPD- action', () => {
  const summary = jobSummary(
    jobRow({ kind: 'device-update', display_id: 'UPD-006', status: 'failed' }),
  );
  assert.equal(summary.action, 'update-device-annotations');
});

/** The clock of the state 26 fixtures. Each plan expiry is compared against it. */
const STATE_26_NOW = Date.parse('2026-10-28T15:12:00.000Z');

test('an export summary carries its phase and its purpose', () => {
  const running = jobSummary(
    jobRow({
      kind: 'device-export',
      display_id: 'EXP-001',
      scope_kind: 'rows',
      status: 'running',
      target_count: 48,
      succeeded: 32,
      finished_at: null,
      phase: 'write-rows',
      phase_done: 32,
      phase_total: 48,
      export_purpose: 'edit',
    }),
    STATE_26_NOW,
  );
  assert.equal(running.action, 'export-devices');
  assert.deepEqual(running.phase, { name: 'write-rows', done: 32, total: 48 });
  assert.deepEqual(running.exportSummary, { purpose: 'edit' });
  assert.equal(running.importSummary, null);
  assert.deepEqual(running.scope, { kind: 'rows', deviceCount: 48 });

  const ready = jobSummary(
    jobRow({
      kind: 'device-export',
      display_id: 'EXP-002',
      scope_kind: 'rows',
      status: 'completed',
      target_count: 48,
      succeeded: 48,
      phase: 'prepare-download',
      phase_done: 0,
      phase_total: null,
      export_purpose: 'report',
    }),
    STATE_26_NOW,
  );
  assert.deepEqual(ready.phase, {
    name: 'prepare-download',
    done: 0,
    total: null,
  });
  assert.deepEqual(ready.exportSummary, { purpose: 'report' });
});

test('each new import row of state 26 carries the data it shows', () => {
  const rows = [
    {
      display_id: 'IMP-001',
      status: 'completed',
      target_count: 48,
      phase: 'report',
      phase_done: 11,
      phase_total: 11,
      import_mode: 'sync-changes',
      plan_state: 'executed',
      proposed: 7,
      rejected: 0,
      refusal: null,
      expected: {
        mode: 'sync-changes',
        planState: 'executed',
        proposed: 7,
        rejected: 0,
        refusal: null,
      },
    },
    {
      // The plan stays open in the store. The API derives its expiry (design section 1).
      display_id: 'IMP-002',
      status: 'completed',
      target_count: 30,
      phase: 'report',
      phase_done: 11,
      phase_total: 11,
      import_mode: 'sync-all-rows',
      plan_state: 'open',
      plan_expires_at: new Date('2026-10-28T10:15:00.000Z'),
      proposed: 11,
      rejected: 0,
      refusal: null,
      expected: {
        mode: 'sync-all-rows',
        planState: 'expired',
        proposed: 11,
        rejected: 0,
        refusal: null,
      },
    },
    {
      display_id: 'IMP-003',
      status: 'completed',
      target_count: 5,
      phase: 'report',
      phase_done: 1,
      phase_total: 1,
      import_mode: 'sync-changes',
      plan_state: 'cancelled',
      proposed: 1,
      rejected: 0,
      refusal: null,
      expected: {
        mode: 'sync-changes',
        planState: 'cancelled',
        proposed: 1,
        rejected: 0,
        refusal: null,
      },
    },
    {
      display_id: 'IMP-004',
      status: 'completed',
      target_count: 48,
      phase: 'report',
      phase_done: 0,
      phase_total: 0,
      import_mode: 'sync-changes',
      plan_state: null,
      proposed: 0,
      rejected: 0,
      refusal: null,
      expected: {
        mode: 'sync-changes',
        planState: null,
        proposed: 0,
        rejected: 0,
        refusal: null,
      },
    },
    {
      display_id: 'IMP-005',
      status: 'completed-with-errors',
      target_count: 6,
      phase: 'report',
      phase_done: 0,
      phase_total: 0,
      import_mode: 'sync-changes',
      plan_state: null,
      proposed: 0,
      rejected: 4,
      refusal: null,
      expected: {
        mode: 'sync-changes',
        planState: null,
        proposed: 0,
        rejected: 4,
        refusal: null,
      },
    },
    {
      display_id: 'IMP-006',
      status: 'failed',
      target_count: null,
      phase: 'header-check',
      phase_done: 0,
      phase_total: null,
      import_mode: 'sync-changes',
      plan_state: null,
      proposed: 0,
      rejected: 0,
      refusal: 'checksum-column-missing',
      expected: {
        mode: 'sync-changes',
        planState: null,
        proposed: 0,
        rejected: 0,
        refusal: 'checksum-column-missing',
      },
    },
    {
      display_id: 'IMP-007',
      status: 'cancelled',
      target_count: 30,
      cancelled: 30,
      phase: 'refresh',
      phase_done: 4,
      phase_total: 12,
      import_mode: 'sync-all-rows',
      plan_state: null,
      proposed: 0,
      rejected: 0,
      refusal: null,
      expected: {
        mode: 'sync-all-rows',
        planState: null,
        proposed: 0,
        rejected: 0,
        refusal: null,
      },
    },
  ];
  for (const { display_id, expected, ...row } of rows) {
    const summary = jobSummary(
      jobRow({ kind: 'device-import', scope_kind: 'rows', display_id, ...row }),
      STATE_26_NOW,
    );
    assert.equal(summary.action, 'validate-device-import');
    assert.deepEqual(
      summary.importSummary,
      expected,
      `${display_id} carries its import block.`,
    );
    assert.deepEqual(
      summary.phase,
      {
        name: row.phase,
        done: row.phase_done,
        total: row.phase_total,
      },
      `${display_id} carries its phase.`,
    );
    assert.equal(summary.exportSummary, null);
    assert.deepEqual(summary.scope, {
      kind: 'rows',
      deviceCount: row.target_count,
    });
  }
});

test('an open plan reads expired at its expiry and open before it', () => {
  const row = jobRow({
    kind: 'device-import',
    scope_kind: 'rows',
    display_id: 'IMP-002',
    import_mode: 'sync-all-rows',
    plan_state: 'open',
    plan_expires_at: new Date('2026-10-28T11:42:00.000Z'),
  });
  const at = (iso) => jobSummary(row, Date.parse(iso)).importSummary.planState;
  assert.equal(at('2026-10-28T11:41:59.999Z'), 'open');
  assert.equal(at('2026-10-28T11:42:00.000Z'), 'expired');
  // Execute keeps the state after the expiry, so a finished plan never reopens.
  assert.equal(
    jobSummary(
      { ...row, plan_state: 'executed' },
      Date.parse('2026-10-31T00:00:00.000Z'),
    ).importSummary.planState,
    'executed',
  );
});

test('a cursor round-trips the created time and the display ID', () => {
  const cursor = encodeCursor({
    created_at: new Date('2026-10-06T12:00:00.000Z'),
    display_id: 'UPD-006',
  });
  assert.deepEqual(decodeCursor(cursor), {
    createdAt: '2026-10-06T12:00:00.000Z',
    displayId: 'UPD-006',
  });
  assert.equal(decodeCursor(undefined), null);
  assert.throws(() => decodeCursor('not-a-cursor'), BadRequestException);
});

test('a cursor keeps the exact database time, not the rounded Date', () => {
  const cursor = encodeCursor({
    created_at: new Date('2026-10-06T12:00:00.123Z'),
    created_at_cursor: '2026-10-06T12:00:00.123900Z',
    display_id: 'REF-003',
  });
  assert.deepEqual(decodeCursor(cursor), {
    createdAt: '2026-10-06T12:00:00.123900Z',
    displayId: 'REF-003',
  });
});

test('the list applies every filter, the keyset, and the page limit', async () => {
  const db = database([
    [
      'AS matching',
      [{ matching: 2, observed_at: new Date('2026-10-06T12:10:00.000Z') }],
    ],
    [
      'ORDER BY j.created_at DESC',
      [jobRow({ display_id: 'REF-002' }), jobRow({ display_id: 'REF-001' })],
    ],
  ]);
  const jobs = new Jobs(db);
  const cursor = encodeCursor({
    created_at: new Date('2026-10-06T11:00:00.000Z'),
    display_id: 'REF-009',
  });
  const page = await jobs.list(
    session(),
    'C0123456',
    {
      status: ['failed', 'completed'],
      action: ['refresh-inventory'],
      requestedBy: [REQUESTER],
      createdFrom: '2026-10-01T00:00:00.000Z',
      createdTo: '2026-10-09T00:00:00.000Z',
      finishedFrom: '2026-10-01T00:00:00.000Z',
      finishedTo: '2026-10-09T00:00:00.000Z',
    },
    cursor,
    10,
  );
  assert.equal(page.matching, 2);
  assert.equal(page.nextCursor, null);
  assert.equal(page.observedAt, '2026-10-06T12:10:00.000Z');
  assert.deepEqual(
    page.jobs.map((job) => job.displayId),
    ['REF-002', 'REF-001'],
  );
  const [counted] = db.calls;
  assert.ok(counted[0].includes('cc.job_visible($1,$2,$3,j.requested_by)'));
  assert.ok(counted[0].includes('j.status=ANY($4::text[])'));
  assert.ok(counted[0].includes('j.kind=ANY($5::text[])'));
  assert.ok(counted[0].includes('j.requested_by=ANY($6::uuid[])'));
  assert.ok(counted[0].includes('j.created_at>=$7::timestamptz'));
  assert.deepEqual(counted[1].slice(0, 3), [ACTOR, 1, 'C0123456']);
  assert.deepEqual(counted[1][3], ['failed', 'completed']);
  assert.deepEqual(counted[1][4], ['inventory-refresh']);
  const [paged, pagedValues] = db.calls[1];
  assert.ok(paged.includes('(j.created_at,j.display_id)<'));
  assert.equal(pagedValues.at(-1), 11);
});

test('the list answers a next cursor when more rows exist', async () => {
  const rows = Array.from({ length: 3 }, (_, index) =>
    jobRow({
      display_id: `REF-00${3 - index}`,
      created_at: new Date(`2026-10-06T12:0${3 - index}:00.000Z`),
    }),
  );
  const db = database([
    ['AS matching', [{ matching: 9, observed_at: new Date() }]],
    ['ORDER BY j.created_at DESC', rows],
  ]);
  const page = await new Jobs(db).list(session(), 'C0123456', {}, undefined, 2);
  assert.equal(page.jobs.length, 2);
  assert.deepEqual(decodeCursor(page.nextCursor), {
    createdAt: '2026-10-06T12:02:00.000Z',
    displayId: 'REF-002',
  });
});

test('the list filters both new actions and carries their blocks', async () => {
  const db = database([
    [
      'AS matching',
      [{ matching: 2, observed_at: new Date('2026-10-28T15:12:00.000Z') }],
    ],
    [
      'ORDER BY j.created_at DESC',
      [
        jobRow({
          kind: 'device-import',
          display_id: 'IMP-002',
          scope_kind: 'rows',
          status: 'completed',
          target_count: 30,
          phase: 'report',
          phase_done: 11,
          phase_total: 11,
          import_mode: 'sync-all-rows',
          // The plan stays open in the store and expired on the read clock.
          plan_state: 'open',
          plan_expires_at: new Date(Date.now() - 60_000),
          proposed: 11,
          rejected: 0,
          refusal: null,
        }),
        jobRow({
          kind: 'device-export',
          display_id: 'EXP-001',
          scope_kind: 'rows',
          status: 'completed',
          target_count: 48,
          succeeded: 48,
          phase: 'prepare-download',
          phase_done: 0,
          phase_total: null,
          export_purpose: 'edit',
        }),
      ],
    ],
  ]);
  const page = await new Jobs(db).list(
    session(),
    'C0123456',
    { action: ['export-devices', 'validate-device-import'] },
    undefined,
    50,
  );
  assert.deepEqual(
    page.jobs.map((job) => job.displayId),
    ['IMP-002', 'EXP-001'],
  );
  assert.deepEqual(page.jobs[0].importSummary, {
    mode: 'sync-all-rows',
    planState: 'expired',
    proposed: 11,
    rejected: 0,
    refusal: null,
  });
  assert.deepEqual(page.jobs[1].exportSummary, { purpose: 'edit' });
  const [counted, countedValues] = db.calls[0];
  assert.ok(counted.includes('j.kind=ANY($4::text[])'));
  assert.deepEqual(countedValues[3], ['device-export', 'device-import']);
  const [paged, pagedValues] = db.calls[1];
  assert.ok(
    paged.includes('LEFT JOIN cc.device_export_jobs e ON e.job_id=j.job_id'),
  );
  assert.ok(
    paged.includes('LEFT JOIN cc.device_import_jobs i ON i.job_id=j.job_id'),
  );
  assert.ok(paged.includes('e.purpose AS export_purpose'));
  assert.ok(paged.includes('i.mode AS import_mode'));
  assert.deepEqual(pagedValues[3], ['device-export', 'device-import']);
});

test('the detail joins the write fields and derives Latest activity from every operation', async () => {
  const db = database([
    [
      'LEFT JOIN cc.device_update_jobs u',
      [
        jobRow({
          kind: 'device-update',
          display_id: 'UPD-006',
          status: 'needs-review',
          target_count: 300,
          succeeded: 297,
          failed: 1,
          unknown: 2,
          confirmed_by: '55555555-5555-4555-8555-555555555555',
          confirmed_by_name: 'Katherine Johnson',
          changes: [
            { field: 'annotatedLocation', mode: 'replace', value: 'Room 10' },
          ],
          preview_display_id: 'PV-006',
        }),
      ],
    ],
    [
      'FROM cc.device_update_operations',
      (values) =>
        values[1] === 'failed'
          ? [
              {
                operation_number: 299,
                device_id: 'd299',
                serial_number: 'C0A1-0001',
                outcome_reason: 'not-found',
                google_status: 404,
                google_reason: 'notFound',
                updated_at: new Date('2026-10-06T12:04:00.000Z'),
              },
            ]
          : [
              {
                operation_number: 7,
                device_id: 'd7',
                serial_number: 'C0A1-0002',
                updated_at: new Date('2026-10-06T12:03:00.000Z'),
              },
            ],
    ],
  ]);
  const detail = await new Jobs(db).detail(session(), 'C0123456', 'UPD-006');
  assert.equal(detail.displayId, 'UPD-006');
  // Until the cancel route lands, every detail reports no request and no cancelled count.
  assert.equal(detail.cancelRequest, null);
  assert.equal(detail.progress.cancelled, 0);
  assert.equal(detail.confirmedBy.displayName, 'Katherine Johnson');
  assert.equal(detail.previewDisplayId, 'PV-006');
  assert.deepEqual(detail.changes, [
    { field: 'annotatedLocation', mode: 'replace', value: 'Room 10' },
  ]);
  assert.equal(detail.latestActivity.at, '2026-10-06T12:05:00.000Z');
  assert.equal(detail.latestActivity.failed.count, 1);
  assert.deepEqual(detail.latestActivity.failed.operations[0], {
    operationId: 'UPD-006-299',
    deviceId: 'd299',
    serialNumber: 'C0A1-0001',
    outcomeReason: 'not-found',
    googleStatus: 404,
    googleReason: 'notFound',
    updatedAt: '2026-10-06T12:04:00.000Z',
  });
  assert.equal(
    detail.latestActivity.unknown.operations[0].operationId,
    'UPD-006-7',
  );
});

test('the detail carries the file of a completed export', async () => {
  const db = database([
    [
      'LEFT JOIN cc.device_update_jobs u',
      [
        jobRow({
          kind: 'device-export',
          display_id: 'EXP-001',
          scope_kind: 'rows',
          status: 'completed',
          target_count: 48,
          succeeded: 48,
          phase: 'prepare-download',
          phase_done: 0,
          phase_total: null,
          export_purpose: 'edit',
          file_name: 'devices-for-editing-EXP-001.csv',
          file_size_bytes: 7987,
          file_row_count: 48,
          file_column_count: 10,
          file_expires_at: new Date('2026-11-27T15:31:00.000Z'),
        }),
      ],
    ],
    ['WHERE job_id=$1 AND status=$2', []],
  ]);
  const detail = await new Jobs(db).detail(session(), 'C0123456', 'EXP-001');
  assert.deepEqual(detail.exportFile, {
    name: 'devices-for-editing-EXP-001.csv',
    sizeBytes: 7987,
    rows: 48,
    columns: 10,
    expiresAt: '2026-11-27T15:31:00.000Z',
  });
  assert.deepEqual(detail.exportSummary, { purpose: 'edit' });
  assert.deepEqual(detail.phase, {
    name: 'prepare-download',
    done: 0,
    total: null,
  });
  assert.equal(detail.importSource, null);
  assert.equal(detail.plan, null);
  assert.equal(detail.planJobs, null);
  assert.equal(detail.executionCounts, null);
});

test('the detail carries the source and the open plan of a validation job', async () => {
  const planId = '77777777-7777-4777-8777-777777777777';
  const db = database([
    [
      'LEFT JOIN cc.device_update_jobs u',
      [
        jobRow({
          kind: 'device-import',
          display_id: 'IMP-001',
          scope_kind: 'rows',
          status: 'completed',
          target_count: 48,
          phase: 'report',
          phase_done: 11,
          phase_total: 11,
          import_mode: 'sync-changes',
          source_name: 'devices-for-editing-EXP-001.csv',
          source_size_bytes: 7987,
          rows_read: 48,
          candidate_rows: 13,
          refusal: null,
          refusal_text: null,
          plan_id: planId,
          plan_revision: 1,
          plan_state: 'open',
          // The plan is still open on the read clock.
          plan_expires_at: new Date(Date.now() + 3_600_000),
          plan_changed_by: null,
          plan_changed_at: null,
          proposed: 7,
          rejected: 0,
        }),
      ],
    ],
    ['WHERE job_id=$1 AND status=$2', []],
  ]);
  const detail = await new Jobs(db).detail(session(), 'C0123456', 'IMP-001');
  assert.deepEqual(detail.importSummary, {
    mode: 'sync-changes',
    planState: 'open',
    proposed: 7,
    rejected: 0,
    refusal: null,
  });
  assert.deepEqual(detail.importSource, {
    name: 'devices-for-editing-EXP-001.csv',
    sizeBytes: 7987,
    rowsRead: 48,
    candidateRows: 13,
    refusalText: null,
  });
  assert.equal(detail.plan.planId, planId);
  assert.equal(detail.plan.revision, 1);
  assert.equal(detail.plan.state, 'open');
  assert.deepEqual(detail.plan.changedBy, null);
  assert.equal(detail.plan.changedAt, null);
  assert.equal(detail.exportFile, null);
  // An open plan holds no job and no result yet.
  assert.equal(detail.planJobs, null);
  assert.equal(detail.executionCounts, null);
  assert.equal(
    db.calls.some(([text]) => text.includes('FROM cc.device_import_changes c')),
    false,
    'An open plan reads no execution counts.',
  );
});

test('the import detail and cancel answer carry both stored summary counts', async () => {
  // The counts are nonzero and differ, so a missing projection reads 0 in place of each one.
  const stored = jobRow({
    kind: 'device-import',
    display_id: 'IMP-008',
    scope_kind: 'rows',
    status: 'completed',
    target_count: 48,
    succeeded: 39,
    failed: 2,
    phase: 'report',
    phase_done: 11,
    phase_total: 11,
    import_mode: 'sync-changes',
    source_name: 'devices-for-editing-EXP-001.csv',
    source_size_bytes: 7987,
    rows_read: 48,
    candidate_rows: 11,
    refusal: null,
    refusal_text: null,
    plan_id: null,
    plan_revision: null,
    plan_state: null,
    plan_expires_at: null,
    plan_changed_by: null,
    plan_changed_at: null,
    proposed: 7,
    rejected: 2,
  });
  const db = database([
    [
      'LEFT JOIN cc.device_update_jobs u',
      (values, text) => [headerRow(text, stored)],
    ],
    ['WHERE job_id=$1 AND status=$2', []],
    ['cc.request_job_cancel', [{ result: { outcome: 'requested' } }]],
  ]);
  const jobs = new Jobs(db);
  // The detail route of design section 1.
  const detail = await jobs.detail(session(), 'C0123456', 'IMP-008');
  assert.equal(detail.importSummary.proposed, 7);
  assert.equal(detail.importSummary.rejected, 2);
  // The cancel route builds its summary from the same header.
  const cancelled = await jobs.cancel(
    session(),
    'C0123456',
    'IMP-008',
    '55555555-5555-4555-8555-555555555555',
  );
  assert.equal(cancelled.importSummary.proposed, 7);
  assert.equal(cancelled.importSummary.rejected, 2);
  const headers = db.calls.filter(([text]) =>
    text.includes('LEFT JOIN cc.device_update_jobs u'),
  );
  assert.equal(headers.length, 2, 'Detail and cancel each read one header.');
});

test('the detail of an executed plan carries its jobs and the counts of state 17b', async () => {
  const planJob = (overrides) =>
    jobRow({
      requested_by: REQUESTER,
      requested_by_name: 'Ada Lovelace',
      revision: 3,
      scope_kind: 'devices',
      failure: null,
      cancel_requested_at: null,
      cancel_requested_by: null,
      cancel_requested_by_name: null,
      ...overrides,
    });
  const db = database([
    [
      'LEFT JOIN cc.device_update_jobs u',
      [
        jobRow({
          kind: 'device-import',
          display_id: 'IMP-001',
          scope_kind: 'rows',
          status: 'completed',
          target_count: 48,
          phase: 'report',
          phase_done: 11,
          phase_total: 11,
          import_mode: 'sync-changes',
          source_name: 'devices-for-editing-EXP-001.csv',
          source_size_bytes: 7987,
          rows_read: 48,
          candidate_rows: 13,
          refusal: null,
          refusal_text: null,
          plan_id: '77777777-7777-4777-8777-777777777777',
          plan_revision: 2,
          plan_state: 'executed',
          plan_expires_at: new Date(Date.now() - 3_600_000),
          plan_changed_by: ACTOR,
          plan_changed_by_name: 'Review administrator',
          plan_changed_at: new Date(Date.now() - 3_600_000),
          proposed: 7,
          rejected: 0,
        }),
      ],
    ],
    ['WHERE job_id=$1 AND status=$2', []],
    [
      'FROM cc.device_update_jobs u',
      [
        planJob({
          job_id: '88888888-8888-4888-8888-888888888881',
          display_id: 'UPD-001',
          kind: 'device-update',
          action: 'annotated-location',
          status: 'completed',
          target_count: 6,
          succeeded: 6,
          finished_at: new Date('2026-10-28T14:44:00.000Z'),
        }),
        planJob({
          job_id: '88888888-8888-4888-8888-888888888882',
          display_id: 'STS-001',
          kind: 'device-status',
          action: 'disable',
          status: 'completed',
          target_count: 1,
          succeeded: 1,
          finished_at: new Date('2026-10-28T14:44:00.000Z'),
        }),
        planJob({
          job_id: '88888888-8888-4888-8888-888888888883',
          display_id: 'STS-002',
          kind: 'device-status',
          action: 'reenable',
          status: 'failed',
          target_count: 1,
          succeeded: 0,
          failed: 1,
          finished_at: new Date('2026-10-28T14:44:00.000Z'),
        }),
        planJob({
          job_id: '88888888-8888-4888-8888-888888888884',
          display_id: 'STS-003',
          kind: 'device-status',
          action: 'deprovision',
          status: 'completed',
          target_count: 1,
          succeeded: 1,
          finished_at: new Date('2026-10-28T14:44:00.000Z'),
        }),
      ],
    ],
    [
      'FROM cc.device_import_changes c',
      [
        {
          not_run: 0,
          succeeded: 10,
          failed: 1,
          unknown: 0,
          skipped: 0,
          expired: 0,
          cancelled: 0,
          pending: 0,
        },
      ],
    ],
  ]);
  const detail = await new Jobs(db).detail(session(), 'C0123456', 'IMP-001');
  assert.equal(detail.plan.state, 'executed');
  assert.deepEqual(
    detail.planJobs.map((job) => [job.displayId, job.action, job.status]),
    [
      ['UPD-001', 'update-device-annotations', 'completed'],
      ['STS-001', 'disable-devices', 'completed'],
      ['STS-002', 'reenable-devices', 'failed'],
      ['STS-003', 'deprovision-devices', 'completed'],
    ],
  );
  assert.deepEqual(detail.executionCounts, {
    succeeded: 10,
    failed: 1,
    unknown: 0,
    skipped: 0,
    expired: 0,
    cancelled: 0,
    pending: 0,
    notRun: 0,
  });
  // State 17b: 11 changes = 10 Succeeded + 1 Failed.
  const counts = detail.executionCounts;
  assert.equal(
    counts.succeeded +
      counts.failed +
      counts.unknown +
      counts.skipped +
      counts.expired +
      counts.cancelled +
      counts.pending +
      counts.notRun,
    11,
    'The eight terms sum to the 11 changes of state 17b.',
  );
  const queries = db.calls.filter(([text]) =>
    text.includes('FROM cc.device_import_changes c'),
  );
  assert.equal(queries.length, 1, 'One aggregate query fills the counts.');
  for (const term of [
    'c.linked_job_id IS NULL',
    "o.status='succeeded'",
    "o.status='failed'",
    "o.status='unknown'",
    "o.status='skipped'",
    "o.status='expired'",
    "o.status='cancelled'",
    "o.status IN ('pending','dispatched','issued')",
  ])
    assert.ok(queries[0][0].includes(term), `The aggregate counts ${term}.`);
});

test('a write job of an import names its import and the job it waits for', async () => {
  const db = database([
    [
      'LEFT JOIN cc.device_update_jobs u',
      [
        jobRow({
          kind: 'device-status',
          display_id: 'STS-002',
          action: 'reenable',
          status: 'failed',
          target_count: 1,
          succeeded: 0,
          failed: 1,
          import_display_id: 'IMP-001',
          waits_for_display_id: 'UPD-001',
        }),
      ],
    ],
    ['WHERE job_id=$1 AND status=$2', []],
  ]);
  const detail = await new Jobs(db).detail(session(), 'C0123456', 'STS-002');
  assert.equal(detail.importDisplayId, 'IMP-001');
  assert.equal(detail.waitsForDisplayId, 'UPD-001');
  assert.equal(detail.waitingDisplayIds, null);
  assert.equal(detail.planJobs, null);
  assert.equal(detail.executionCounts, null);
});

test('an update job of an import names the status jobs that wait for it', async () => {
  const db = database([
    [
      'LEFT JOIN cc.device_update_jobs u',
      [
        jobRow({
          kind: 'device-update',
          display_id: 'UPD-001',
          action: 'annotated-location',
          status: 'completed',
          target_count: 6,
          succeeded: 6,
          import_display_id: 'IMP-001',
          waits_for_display_id: null,
          waiting_display_ids: ['STS-001', 'STS-002', 'STS-003'],
        }),
      ],
    ],
    ['WHERE job_id=$1 AND status=$2', []],
  ]);
  const detail = await new Jobs(db).detail(session(), 'C0123456', 'UPD-001');
  assert.equal(detail.importDisplayId, 'IMP-001');
  assert.equal(detail.waitsForDisplayId, null);
  assert.deepEqual(detail.waitingDisplayIds, ['STS-001', 'STS-002', 'STS-003']);
});

test('an unknown or purged job answers 404', async () => {
  const db = database([['LEFT JOIN cc.device_update_jobs u', []]]);
  await assert.rejects(
    new Jobs(db).detail(session(), 'C0123456', 'UPD-999'),
    (error) => error instanceof NotFoundException,
  );
});

test('a Powerwash job detail answers powerwash-devices and REMOTE_POWERWASH', async () => {
  const row = jobRow({
    kind: 'device-command',
    display_id: 'CMD-002',
    action: 'powerwash',
    status: 'awaiting-devices',
    target_count: 1,
  });
  const db = database([
    ['pr.deprovision_reason', [row]],
    ['FROM cc.device_update_operations', []],
  ]);
  const detail = await new Jobs(db).detail(session(), 'C0123456', 'CMD-002');
  assert.equal(detail.action, 'powerwash-devices');
  assert.equal(detail.commandType, 'REMOTE_POWERWASH');
  assert.equal(detail.statusAction, null);
  assert.equal(detail.deprovisionReason, null);
  assert.ok(
    db.calls[0][0].includes('pr.deprovision_reason'),
    'The header reads the reason from the preview.',
  );
});

test('a Deprovision job detail answers deprovision and its reason', async () => {
  const reason = 'DEPROVISION_REASON_SAME_MODEL_REPLACEMENT';
  const row = jobRow({
    kind: 'device-status',
    display_id: 'STS-002',
    action: 'deprovision',
    status: 'completed',
    deprovision_reason: reason,
    preview_display_id: 'PV-002',
  });
  const db = database([
    ['pr.deprovision_reason', [row]],
    ['FROM cc.device_update_operations', []],
  ]);
  const detail = await new Jobs(db).detail(session(), 'C0123456', 'STS-002');
  assert.equal(detail.action, 'deprovision-devices');
  assert.equal(detail.statusAction, 'deprovision');
  assert.equal(detail.commandType, null);
  assert.equal(detail.deprovisionReason, reason);
  assert.equal(detail.previewDisplayId, 'PV-002');
});

test('the operations page filters attention and pages by operation and field', async () => {
  const db = database([
    [
      'FROM cc.device_update_operations o',
      [
        {
          operation_number: 4,
          device_id: 'd4',
          serial_number: 'C0A1-0004',
          org_unit_path: '/Schools/A',
          status: 'dispatched',
          action: 'annotated-location',
          mode: 'replace',
          field: 'annotatedLocation',
          baseline_value: 'Room 1',
          requested_value: 'Room 4',
          field_baseline_value: 'Room 1',
          field_requested_value: 'Room 4',
          field_observed_value: null,
          field_position: 1,
          outcome_reason: null,
          google_status: null,
          google_reason: null,
          observed_value: null,
          verified_by: null,
          updated_at: new Date('2026-10-06T12:04:00.000Z'),
        },
        {
          operation_number: 4,
          device_id: 'd4',
          serial_number: 'C0A1-0004',
          org_unit_path: '/Schools/A',
          status: 'dispatched',
          action: 'annotated-location',
          mode: 'replace',
          field: 'notes',
          baseline_value: 'Room 1',
          requested_value: 'Room 4',
          field_baseline_value: null,
          field_requested_value: 'Front desk',
          field_observed_value: null,
          field_position: 3,
          outcome_reason: null,
          google_status: null,
          google_reason: null,
          observed_value: null,
          verified_by: null,
          updated_at: new Date('2026-10-06T12:04:00.000Z'),
        },
      ],
    ],
    ['LEFT JOIN cc.device_update_jobs u', [jobRow({ kind: 'device-update' })]],
  ]);
  const page = await new Jobs(db).operations(
    session(),
    'C0123456',
    'UPD-006',
    true,
    '3:0',
    1,
  );
  assert.deepEqual(
    page.operations.map((operation) => operation.operationId),
    ['UPD-006-4-annotatedLocation'],
  );
  assert.equal(page.operations[0].outcome, 'pending');
  assert.equal(page.operations[0].operation, 'replace');
  assert.equal(page.operations[0].field, 'annotatedLocation');
  assert.equal(page.operations[0].baselineValue, 'Room 1');
  assert.equal(page.operations[0].requestedValue, 'Room 4');
  assert.equal(page.nextCursor, '4:1');
  const [, values] = db.calls[1];
  assert.equal(values[4], true);
  assert.equal(values[5], 3);
  assert.equal(values[7], 0);
  assert.deepEqual(values[6], [
    'annotatedLocation',
    'annotatedAssetId',
    'annotatedUser',
    'notes',
    'orgUnitPath',
  ]);
});

test('an operation cursor that is not two positions answers job-not-found', async () => {
  for (const cursor of ['3', '3:0:1', 'x:0', '0:0', '3:-1']) {
    const db = database([
      [
        'LEFT JOIN cc.device_update_jobs u',
        [jobRow({ kind: 'device-update' })],
      ],
    ]);
    await assert.rejects(
      new Jobs(db).operations(
        session(),
        'C0123456',
        'UPD-006',
        false,
        cursor,
        100,
      ),
      (error) =>
        error instanceof NotFoundException &&
        error.getResponse().reason === 'job-not-found',
      `The cursor ${cursor} must be refused.`,
    );
  }
});

test('the operations page reads the numbers of one results page', async () => {
  const routes = () => [
    ['FROM cc.device_update_operations o', []],
    ['LEFT JOIN cc.device_update_jobs u', [jobRow({ kind: 'device-update' })]],
  ];
  const filtered = database(routes());
  const page = await new Jobs(filtered).operations(
    session(),
    'C0123456',
    'UPD-006',
    false,
    undefined,
    100,
    [3, 7, 8],
  );
  assert.deepEqual(page.operations, []);
  const [sql, values] = filtered.calls[1];
  assert.ok(sql.includes('o.operation_number=ANY($10::integer[])'));
  assert.deepEqual(values[9], [3, 7, 8]);

  // A call without numbers reads every operation of the job.
  const whole = database(routes());
  await new Jobs(whole).operations(
    session(),
    'C0123456',
    'UPD-006',
    false,
    undefined,
    100,
  );
  assert.equal(whole.calls[1][1][9], null);
});

test('the operations route schema accepts the cursor format the route answers', () => {
  // The service answers "<operation>:<fieldPosition>", with position 0 for a command or status row.
  assert.equal(operationCursorSchema.parse('1:0'), '1:0');
  assert.equal(operationCursorSchema.parse('1002:4'), '1002:4');
  for (const cursor of ['3', '3:0:1', 'x:0', '3:-1', ''])
    assert.equal(
      operationCursorSchema.safeParse(cursor).success,
      false,
      `The route must refuse ${cursor}.`,
    );
});

test('each annotation row reports its own replace or clear mode', () => {
  const row = (field, requested, mode = 'replace') => ({
    operation_number: 4,
    device_id: 'd4',
    serial_number: 'C0A1-0004',
    org_unit_path: '/Schools/A',
    status: 'succeeded',
    action: 'annotated-location',
    mode,
    field,
    baseline_value: 'Room 1',
    requested_value: 'Room 4',
    field_baseline_value: 'Room 1',
    field_requested_value: requested,
    field_observed_value: requested,
    field_position: 1,
    observed_value: null,
    verified_by: 'write-response',
    updated_at: new Date('2026-10-06T12:04:00.000Z'),
  });
  assert.equal(
    jobOperation(row('annotatedLocation', 'Room 4'), 'UPD-006').operation,
    'replace',
  );
  // A null request is Clear, whatever the job-wide header says (addendum section 2).
  assert.equal(
    jobOperation(row('notes', null, 'replace'), 'UPD-006').operation,
    'clear',
  );
  assert.equal(
    jobOperation(row('annotatedLocation', 'Room 4', 'clear'), 'UPD-006')
      .operation,
    'replace',
  );
  assert.equal(
    jobOperation(row('orgUnitPath', '/Schools/B'), 'UPD-006').operation,
    'move',
  );
  // A command and a status row keep the name of their action.
  assert.equal(
    jobOperation({ ...row(null, null), action: 'reboot' }, 'CMD-001').operation,
    'reboot',
  );
  assert.equal(
    jobOperation({ ...row(null, 'DISABLED'), action: 'disable' }, 'STS-002')
      .operation,
    'disable',
  );
});

test('a field row reads its own values and names its field position', () => {
  const row = {
    operation_number: 12,
    device_id: 'd12',
    serial_number: 'C0A1-0012',
    org_unit_path: '/Schools/A',
    status: 'succeeded',
    action: 'annotated-location',
    mode: 'replace',
    field: 'orgUnitPath',
    baseline_value: 'Room 1',
    requested_value: 'Room 12',
    field_baseline_value: '/Schools/A',
    field_requested_value: '/Schools/B',
    field_observed_value: '/Schools/B',
    field_position: 4,
    observed_value: null,
    verified_by: 'write-response',
    updated_at: new Date('2026-10-06T12:04:00.000Z'),
  };
  assert.deepEqual(jobOperation(row, 'UPD-006'), {
    operationId: 'UPD-006-12-orgUnitPath',
    deviceId: 'd12',
    serialNumber: 'C0A1-0012',
    orgUnitPath: '/Schools/A',
    field: 'orgUnitPath',
    operation: 'move',
    baselineValue: '/Schools/A',
    requestedValue: '/Schools/B',
    observedValue: '/Schools/B',
    outcome: 'succeeded',
    outcomeReason: null,
    googleStatus: null,
    googleReason: null,
    verifiedBy: 'write-response',
    commandId: null,
    commandState: null,
    commandExecutedAt: null,
    commandExpiresAt: null,
    updatedAt: '2026-10-06T12:04:00.000Z',
  });
  assert.equal(operationCursor(row), '12:4');
});

test('the activity answer caps each section and derives the window and attention', async () => {
  let now = 0;
  const db = database([
    [
      'clock_timestamp() AS now',
      [{ now: new Date('2026-10-06T12:00:00.000Z') }],
    ],
    [
      'SELECT seen_at FROM cc.job_activity_seen WHERE principal_id',
      [{ seen_at: new Date('2026-10-06T10:00:00.000Z') }],
    ],
    [
      "j.status IN ('running','awaiting-devices')",
      (values, text) =>
        text.includes('count(*)::int')
          ? [{ count: 51 }]
          : [
              jobRow({
                kind: 'device-export',
                status: 'running',
                display_id: 'EXP-001',
                phase: 'write-rows',
                phase_done: 12,
                phase_total: 48,
                export_purpose: 'edit',
              }),
            ],
    ],
    [
      "j.status IN ('accepted','queued','held')",
      (values, text) =>
        text.includes('count(*)::int')
          ? [{ count: 60 }]
          : [jobRow({ status: 'queued', display_id: 'UPD-008' })],
    ],
    [
      'j.finished_at >= clock_timestamp()',
      (values, text) => {
        now += 1;
        return text.includes('count(*)::int')
          ? [
              {
                count: 12,
                next_expiry_at: new Date('2026-10-07T09:00:00.000Z'),
              },
            ]
          : [jobRow({ status: 'failed', display_id: 'REF-003' })];
      },
    ],
    ['AS attention', [{ attention: true }]],
  ]);
  const activity = await new Jobs(db).activity(session(), 'C0123456');
  assert.equal(activity.running.count, 51);
  assert.equal(activity.waiting.count, 60);
  assert.equal(activity.recent.count, 12);
  assert.equal(activity.recent.nextExpiryAt, '2026-10-07T09:00:00.000Z');
  assert.equal(activity.attention, true);
  assert.equal(activity.seenAt, '2026-10-06T10:00:00.000Z');
  assert.equal(activity.observedAt, '2026-10-06T12:00:00.000Z');
  // A running export row of the panel carries the blocks of its state 26 line.
  assert.deepEqual(activity.running.jobs[0].phase, {
    name: 'write-rows',
    done: 12,
    total: 48,
  });
  assert.deepEqual(activity.running.jobs[0].exportSummary, { purpose: 'edit' });
  assert.equal(now, 2);
  const attentionCall = db.calls.find(([text]) =>
    text.includes('AS attention'),
  );
  assert.equal(attentionCall[1][3], ACTOR);
  assert.ok(
    attentionCall[0].includes('cc.job_activity_seen'),
    'The attention comparison reads the stored seen time.',
  );
  assert.ok(
    !attentionCall[0].includes('$4::timestamptz IS NULL'),
    'The rounded wire time never decides attention.',
  );
});

test('reconcile refuses a command operation with reconcile-unsupported', async () => {
  const db = database([
    [
      'p.display_name AS requested_by_name',
      [
        jobRow({
          kind: 'device-command',
          action: 'reboot',
          status: 'needs-review',
        }),
      ],
    ],
    [
      'o.operation_number=$5',
      [
        {
          operation_number: 1,
          device_id: 'device-1',
          status: 'unknown',
          action: 'reboot',
          mode: null,
        },
      ],
    ],
  ]);
  const orchestration = {
    started: [],
    async startDeviceUpdateReconcile(input) {
      this.started.push(input);
      return 'execution';
    },
  };
  const authorize = authorizer(['read', 'update', 'status']);
  await assert.rejects(
    new Jobs(db).reconcile(
      session(),
      'C0123456',
      'CMD-001',
      1,
      '55555555-5555-4555-8555-555555555555',
      orchestration,
      authorize,
    ),
    (error) =>
      error instanceof ConflictException &&
      error.getResponse().reason === 'reconcile-unsupported',
  );
  assert.deepEqual(orchestration.started, []);
  // No permission allows a command Reconcile, so the kind permission never runs.
  assert.deepEqual(authorize.checks, ['read']);
  // A command operation claims nothing, so no read-back starts.
  assert.equal(claimCount(db), 0);
});

/** A fake Reconcile authorizer. The granted checks stand in for the caller's actions. */
function authorizer(grants) {
  const checks = [];
  const authorize = async (check) => {
    checks.push(check);
    if (!grants.includes(check))
      throw new ForbiddenException(
        'This action requires additional permission.',
      );
  };
  authorize.checks = checks;
  return authorize;
}

const operationRow = (overrides = {}) => ({
  operation_number: 1,
  device_id: 'device-1',
  serial_number: 'C0A1-0001',
  org_unit_path: '/Schools/A',
  action: 'annotated-location',
  mode: 'replace',
  baseline_value: 'Room 1',
  requested_value: 'Room 12',
  status: 'unknown',
  outcome_reason: 'ambiguous',
  google_status: null,
  google_reason: null,
  observed_value: null,
  verified_by: null,
  command_id: null,
  command_state: null,
  command_expires_at: null,
  command_executed_at: null,
  updated_at: new Date('2026-10-21T12:00:00.000Z'),
  ...overrides,
});

/** A database for one Reconcile: the header, the operation row, and the claim. */
function reconcileDatabase(job = {}, operation = {}) {
  return database([
    ['p.display_name AS requested_by_name', [jobRow(job)]],
    ['o.operation_number=$5', [operationRow(operation)]],
    [
      'claim_device_update_verification',
      [{ result: [{ operationNumber: 1 }] }],
    ],
  ]);
}

const reconcileOrchestration = () => ({
  started: [],
  async startDeviceUpdateReconcile(input) {
    this.started.push(input);
    return 'execution';
  },
});

const claimCount = (db) =>
  db.calls.filter(([text]) => text.includes('claim_device_update_verification'))
    .length;

test('reconcile of a status operation takes devices:status and claims the read-back', async () => {
  const db = reconcileDatabase(
    { kind: 'device-status', action: 'disable' },
    { action: 'disable', mode: null, requested_value: 'DISABLED' },
  );
  const orchestration = reconcileOrchestration();
  // jobs:read and devices:status, without devices:write.
  const authorize = authorizer(['read', 'status']);
  const operation = await new Jobs(db).reconcile(
    session(),
    'C0123456',
    'STS-001',
    1,
    '55555555-5555-4555-8555-555555555555',
    orchestration,
    authorize,
  );
  assert.equal(operation.operation, 'disable');
  assert.deepEqual(authorize.checks, ['read', 'status']);
  assert.equal(claimCount(db), 1);
  assert.equal(orchestration.started.length, 1);
});

test('reconcile of a status operation refuses devices:write without devices:status', async () => {
  const db = reconcileDatabase(
    { kind: 'device-status', action: 'disable' },
    { action: 'disable', mode: null },
  );
  const orchestration = reconcileOrchestration();
  // jobs:read and devices:write, without devices:status.
  const authorize = authorizer(['read', 'update']);
  await assert.rejects(
    new Jobs(db).reconcile(
      session(),
      'C0123456',
      'STS-001',
      1,
      '55555555-5555-4555-8555-555555555555',
      orchestration,
      authorize,
    ),
    (error) => error instanceof ForbiddenException && error.getStatus() === 403,
  );
  assert.deepEqual(authorize.checks, ['read', 'status']);
  assert.equal(claimCount(db), 0);
  assert.deepEqual(orchestration.started, []);
});

test('reconcile refuses a Wipe user data operation with reconcile-unsupported', async () => {
  const db = database([
    [
      'p.display_name AS requested_by_name',
      [jobRow({ kind: 'device-command', action: 'wipe-users' })],
    ],
    [
      'o.operation_number=$5',
      [
        {
          operation_number: 1,
          status: 'unknown',
          action: 'wipe-users',
          mode: null,
        },
      ],
    ],
  ]);
  const orchestration = reconcileOrchestration();
  const authorize = authorizer(['read', 'update', 'status', 'deprovision']);
  await assert.rejects(
    new Jobs(db).reconcile(
      session(),
      'C0123456',
      'CMD-003',
      1,
      '55555555-5555-4555-8555-555555555555',
      orchestration,
      authorize,
    ),
    (error) =>
      error instanceof ConflictException &&
      error.getResponse().reason === 'reconcile-unsupported',
  );
  assert.deepEqual(authorize.checks, ['read']);
  assert.equal(claimCount(db), 0);
  assert.deepEqual(orchestration.started, []);
});

test('reconcile refuses a Powerwash operation with reconcile-unsupported', async () => {
  const db = database([
    [
      'p.display_name AS requested_by_name',
      [jobRow({ kind: 'device-command', action: 'powerwash' })],
    ],
    [
      'o.operation_number=$5',
      [
        {
          operation_number: 1,
          status: 'unknown',
          action: 'powerwash',
          mode: null,
        },
      ],
    ],
  ]);
  const orchestration = reconcileOrchestration();
  const authorize = authorizer(['read', 'update', 'status', 'deprovision']);
  await assert.rejects(
    new Jobs(db).reconcile(
      session(),
      'C0123456',
      'CMD-004',
      1,
      '55555555-5555-4555-8555-555555555555',
      orchestration,
      authorize,
    ),
    (error) =>
      error instanceof ConflictException &&
      error.getResponse().reason === 'reconcile-unsupported',
  );
  assert.deepEqual(authorize.checks, ['read']);
  assert.equal(claimCount(db), 0);
  assert.deepEqual(orchestration.started, []);
});

test('reconcile of a Deprovision operation takes devices:deprovision', async () => {
  const db = reconcileDatabase(
    { kind: 'device-status', action: 'deprovision' },
    { action: 'deprovision', mode: null, requested_value: 'DEPROVISIONED' },
  );
  const orchestration = reconcileOrchestration();
  const authorize = authorizer(['read', 'deprovision']);
  const operation = await new Jobs(db).reconcile(
    session(),
    'C0123456',
    'STS-002',
    1,
    '55555555-5555-4555-8555-555555555555',
    orchestration,
    authorize,
  );
  assert.equal(operation.operation, 'deprovision');
  assert.deepEqual(authorize.checks, ['read', 'deprovision']);
  assert.equal(claimCount(db), 1);
  assert.equal(orchestration.started.length, 1);
});

test('reconcile of a Deprovision operation refuses devices:status without devices:deprovision', async () => {
  const db = reconcileDatabase(
    { kind: 'device-status', action: 'deprovision' },
    { action: 'deprovision', mode: null, requested_value: 'DEPROVISIONED' },
  );
  const orchestration = reconcileOrchestration();
  const authorize = authorizer(['read', 'status']);
  await assert.rejects(
    new Jobs(db).reconcile(
      session(),
      'C0123456',
      'STS-002',
      1,
      '55555555-5555-4555-8555-555555555555',
      orchestration,
      authorize,
    ),
    (error) => error instanceof ForbiddenException && error.getStatus() === 403,
  );
  assert.deepEqual(authorize.checks, ['read', 'deprovision']);
  assert.equal(claimCount(db), 0);
  assert.deepEqual(orchestration.started, []);
});

test('reconcile of an update operation refuses devices:status without devices:write', async () => {
  const db = reconcileDatabase();
  const orchestration = reconcileOrchestration();
  // jobs:read and devices:status, without devices:write.
  const authorize = authorizer(['read', 'status']);
  await assert.rejects(
    new Jobs(db).reconcile(
      session(),
      'C0123456',
      'UPD-001',
      1,
      '55555555-5555-4555-8555-555555555555',
      orchestration,
      authorize,
    ),
    (error) => error instanceof ForbiddenException && error.getStatus() === 403,
  );
  assert.deepEqual(authorize.checks, ['read', 'update']);
  assert.equal(claimCount(db), 0);
  assert.deepEqual(orchestration.started, []);
});

test('reconcile refuses a caller without jobs:read before it reads the job', async () => {
  const db = database([]);
  const orchestration = reconcileOrchestration();
  const authorize = authorizer(['update', 'status']);
  await assert.rejects(
    new Jobs(db).reconcile(
      session(),
      'C0123456',
      'UPD-001',
      1,
      '55555555-5555-4555-8555-555555555555',
      orchestration,
      authorize,
    ),
    (error) => error instanceof ForbiddenException && error.getStatus() === 403,
  );
  assert.deepEqual(authorize.checks, ['read']);
  assert.deepEqual(db.calls, []);
  assert.deepEqual(orchestration.started, []);
});

test('reconcile checks the settled state after the kind permission', async () => {
  const db = reconcileDatabase(
    { kind: 'device-status', action: 'reenable' },
    { action: 'reenable', mode: null, status: 'succeeded' },
  );
  const orchestration = reconcileOrchestration();
  const authorize = authorizer(['read', 'status']);
  await assert.rejects(
    new Jobs(db).reconcile(
      session(),
      'C0123456',
      'STS-001',
      1,
      '55555555-5555-4555-8555-555555555555',
      orchestration,
      authorize,
    ),
    (error) =>
      error instanceof ConflictException &&
      error.getResponse().reason === 'operation-settled',
  );
  assert.deepEqual(authorize.checks, ['read', 'status']);
  assert.equal(claimCount(db), 0);
  assert.deepEqual(orchestration.started, []);
});

test('reconcile claims an unknown update operation and starts its read-back', async () => {
  const db = database([
    [
      'p.display_name AS requested_by_name',
      [jobRow({ kind: 'device-update', action: 'annotated-location' })],
    ],
    [
      'o.operation_number=$5',
      [
        {
          operation_number: 1,
          status: 'unknown',
          action: 'annotated-location',
          mode: 'replace',
        },
      ],
    ],
    [
      'claim_device_update_verification',
      [{ result: [{ operationNumber: 1 }] }],
    ],
  ]);
  const orchestration = {
    started: [],
    async startDeviceUpdateReconcile(input) {
      this.started.push(input);
      return 'execution';
    },
  };
  const operation = await new Jobs(db).reconcile(
    session(),
    'C0123456',
    'UPD-001',
    1,
    '55555555-5555-4555-8555-555555555555',
    orchestration,
    authorizer(['read', 'update']),
  );
  assert.equal(operation.operationId, 'UPD-001-1');
  assert.equal(orchestration.started.length, 1);
  assert.equal(orchestration.started[0].operationNumber, 1);
});

test('an empty activity window gives a null next expiry', async () => {
  const db = database([
    ['clock_timestamp() AS now', [{ now: new Date() }]],
    ['SELECT seen_at FROM cc.job_activity_seen WHERE principal_id', []],
    [
      "j.status IN ('running','awaiting-devices')",
      (v, text) => (text.includes('count(*)') ? [{ count: 0 }] : []),
    ],
    [
      "j.status IN ('accepted','queued','held')",
      (v, text) => (text.includes('count(*)') ? [{ count: 0 }] : []),
    ],
    [
      'j.finished_at >= clock_timestamp()',
      (v, text) =>
        text.includes('count(*)') ? [{ count: 0, next_expiry_at: null }] : [],
    ],
    ['AS attention', [{ attention: false }]],
  ]);
  const activity = await new Jobs(db).activity(session(), 'C0123456');
  assert.equal(activity.recent.nextExpiryAt, null);
  assert.equal(activity.seenAt, null);
  assert.equal(activity.attention, false);
});

test('the seen answer returns the stored time', async () => {
  const db = database([
    [
      'cc.record_job_activity_seen',
      [{ seen_at: new Date('2026-10-06T12:08:00.000Z') }],
    ],
  ]);
  const seen = await new Jobs(db).seen(session());
  assert.equal(seen.seenAt, '2026-10-06T12:08:00.000Z');
});

test('the requesters answer reads the prefix and caps the list', async () => {
  const db = database([
    [
      'FROM cc.application_principals p',
      [{ id: REQUESTER, display_name: 'Ada Lovelace' }],
    ],
  ]);
  const requesters = await new Jobs(db).requesters(
    session(),
    'C0123456',
    'Ada',
    20,
  );
  assert.deepEqual(requesters.requesters, [
    { id: REQUESTER, displayName: 'Ada Lovelace' },
  ]);
  const [, values] = db.calls[0];
  assert.equal(values[3], 'Ada');
  assert.equal(values[4], 20);
});

test('an unauthorized caller answers 403 and a missing connection answers 503', async () => {
  const denied = new Jobs({
    connection: {
      async query() {
        throw Object.assign(new Error('denied'), { code: '42501' });
      },
    },
  });
  await assert.rejects(
    denied.customer(session()),
    (error) => error instanceof ForbiddenException,
  );
  const empty = new Jobs({
    connection: {
      async query() {
        return { rows: [] };
      },
    },
  });
  await assert.rejects(empty.customer(session()));
});

test('the visibility check reads cc.job_visible for the requested requester', async () => {
  let values;
  const jobs = new Jobs({
    connection: {
      async query(_text, supplied) {
        values = supplied;
        return { rows: [{ visible: false }] };
      },
    },
  });
  assert.equal(await jobs.visible(session(), 'C0123456', REQUESTER), false);
  assert.deepEqual(values, [ACTOR, 1, 'C0123456', REQUESTER]);
});

test('a dispatched operation reads pending on the page', () => {
  const operation = jobOperation(
    {
      operation_number: 3,
      device_id: 'd3',
      serial_number: 'C0A1-0003',
      org_unit_path: '/Schools/A',
      field: 'annotatedLocation',
      field_baseline_value: 'Room 3',
      field_requested_value: null,
      status: 'dispatched',
      outcome_reason: null,
      google_status: null,
      google_reason: null,
      observed_value: null,
      verified_by: null,
      updated_at: new Date('2026-10-06T12:00:00.000Z'),
    },
    'UPD-006',
  );
  assert.equal(operation.outcome, 'pending');
  assert.equal(operation.operation, 'clear');
});

const commandOperationRow = (overrides = {}) => ({
  operation_number: 4,
  device_id: 'd4',
  serial_number: 'C0A1-0004',
  org_unit_path: '/Schools/A',
  action: 'reboot',
  mode: null,
  baseline_value: 'ACTIVE',
  requested_value: null,
  status: 'issued',
  outcome_reason: null,
  google_status: null,
  google_reason: null,
  observed_value: null,
  verified_by: null,
  command_id: '4100000001',
  command_state: 'acknowledged',
  command_expires_at: new Date('2026-10-28T12:00:00.000Z'),
  command_executed_at: null,
  updated_at: new Date('2026-10-21T12:00:00.000Z'),
  ...overrides,
});

test('each command and status operation row names its own operation word', () => {
  for (const [action, word] of [
    ['reboot', 'reboot'],
    ['wipe-users', 'wipe-users'],
    ['powerwash', 'powerwash'],
    ['disable', 'disable'],
    ['reenable', 'reenable'],
    ['deprovision', 'deprovision'],
  ])
    assert.equal(
      jobOperation(commandOperationRow({ action }), 'CMD-006').operation,
      word,
      `${action} reads ${word}.`,
    );
});

test('an issued command exposes its last observation and keeps the command id', () => {
  const operation = jobOperation(commandOperationRow(), 'CMD-006');
  assert.equal(operation.operation, 'reboot');
  assert.equal(operation.outcome, 'pending');
  assert.equal(operation.commandId, '4100000001');
  assert.equal(operation.commandState, 'acknowledged');
  assert.equal(operation.commandExpiresAt, '2026-10-28T12:00:00.000Z');
});

test('a settled command hides the last observation and keeps the stored command id', () => {
  for (const outcome of ['succeeded', 'failed', 'expired', 'unknown']) {
    const operation = jobOperation(
      commandOperationRow({ status: outcome }),
      'CMD-006',
    );
    assert.equal(operation.outcome, outcome);
    assert.equal(operation.commandState, null, `${outcome} reads null`);
    assert.equal(operation.commandId, '4100000001');
  }
});

test('each command and status action filter narrows its stored action in both queries', async () => {
  const selections = [
    {
      action: ['disable-devices'],
      stored: ['disable'],
      kinds: ['device-status'],
    },
    {
      action: ['reenable-devices'],
      stored: ['reenable'],
      kinds: ['device-status'],
    },
    {
      action: ['deprovision-devices'],
      stored: ['deprovision'],
      kinds: ['device-status'],
    },
    {
      action: ['disable-devices', 'reenable-devices'],
      stored: ['disable', 'reenable'],
      kinds: ['device-status'],
    },
    {
      action: ['reboot-devices'],
      stored: ['reboot'],
      kinds: ['device-command'],
    },
    {
      action: ['powerwash-devices'],
      stored: ['powerwash'],
      kinds: ['device-command'],
    },
    {
      action: ['wipe-user-data'],
      stored: ['wipe-users'],
      kinds: ['device-command'],
    },
    {
      action: ['reboot-devices', 'powerwash-devices'],
      stored: ['reboot', 'powerwash'],
      kinds: ['device-command'],
    },
    {
      action: ['reboot-devices', 'disable-devices'],
      stored: ['reboot', 'disable'],
      kinds: ['device-command', 'device-status'],
    },
    {
      action: ['refresh-inventory'],
      stored: null,
      kinds: ['inventory-refresh'],
    },
    {
      action: ['refresh-inventory', 'reboot-devices'],
      stored: ['reboot'],
      kinds: ['inventory-refresh', 'device-command'],
    },
  ];
  for (const selection of selections) {
    const db = database([
      ['AS matching', [{ matching: 0, observed_at: new Date() }]],
      ['ORDER BY j.created_at DESC', []],
    ]);
    await new Jobs(db).list(
      session(),
      'C0123456',
      { action: selection.action },
      undefined,
      100,
    );
    assert.equal(db.calls.length, 2);
    for (const [index, [text, values]] of db.calls.entries()) {
      assert.deepEqual(values[3], selection.kinds);
      const named = selection.stored === null ? 4 : 5;
      assert.equal(values.length, named + (index === 1 ? 1 : 0));
      if (selection.stored === null) {
        assert.equal(
          text.includes('u.action='),
          false,
          'An update or refresh action needs no detail predicate.',
        );
      } else {
        assert.ok(
          text.includes(
            "(j.kind NOT IN ('device-command','device-status') OR u.action=ANY($5::text[]))",
          ),
        );
        assert.deepEqual(values[4], selection.stored);
      }
    }
  }
});

test('the filter reboot-devices excludes a Powerwash job', async () => {
  const db = database([
    ['AS matching', [{ matching: 1, observed_at: new Date() }]],
    [
      'ORDER BY j.created_at DESC',
      [
        jobRow({
          kind: 'device-command',
          action: 'reboot',
          display_id: 'CMD-001',
        }),
      ],
    ],
  ]);
  const page = await new Jobs(db).list(
    session(),
    'C0123456',
    { action: ['reboot-devices'] },
    undefined,
    100,
  );
  assert.deepEqual(
    page.jobs.map((job) => job.action),
    ['reboot-devices'],
  );
  // The kind selects every command job, and the stored action removes the Powerwash job.
  assert.ok(db.calls[0][0].includes('u.action=ANY($5::text[])'));
  assert.deepEqual(db.calls[0][1][4], ['reboot']);
  assert.deepEqual(db.calls[1][1][4], ['reboot']);
});

test('Latest activity keeps the counters from the header, not from the samples', () => {
  const activity = latestActivity(
    jobRow({ failed: 260, unknown: 40 }),
    [
      {
        operation_number: 1,
        device_id: 'd1',
        serial_number: 'C0A1-0001',
        outcome_reason: 'quota',
        google_status: 429,
        google_reason: 'rateLimitExceeded',
        updated_at: new Date('2026-10-06T12:00:00.000Z'),
      },
    ],
    [],
    'UPD-006',
  );
  assert.equal(activity.failed.count, 260);
  assert.equal(activity.unknown.count, 40);
  assert.equal(activity.failed.operations.length, 1);
  assert.equal(activity.unknown.operations.length, 0);
});

const CANCEL_AT = new Date('2026-10-26T12:06:00.000Z');

/** A header row of a job that a person asked to cancel. */
const cancelledRow = (overrides = {}) =>
  jobRow({
    status: 'cancelled',
    finished_at: new Date('2026-10-26T12:06:05.000Z'),
    cancel_requested_at: CANCEL_AT,
    cancel_requested_by: REQUESTER,
    cancel_requested_by_name: 'Ada Lovelace',
    ...overrides,
  });

test('a summary maps the cancelled counter and the stored cancel request', () => {
  const summary = jobSummary(
    cancelledRow({
      kind: 'device-update',
      display_id: 'UPD-004',
      target_count: 8,
      succeeded: 3,
      failed: 1,
      unknown: 0,
      cancelled: 2,
    }),
  );
  assert.equal(summary.status, 'cancelled');
  assert.equal(summary.progress.cancelled, 2);
  // An operation that never left the worker has settled, so it is not pending.
  assert.equal(summary.progress.pending, 2);
  assert.deepEqual(summary.cancelRequest, {
    at: CANCEL_AT.toISOString(),
    by: { id: REQUESTER, displayName: 'Ada Lovelace' },
  });
});

test('a summary without a request answers a null cancel request', () => {
  assert.equal(jobSummary(jobRow()).cancelRequest, null);
});

test('the list joins the person of the stored cancel request', async () => {
  const db = database([
    ['AS matching', [{ matching: 1, observed_at: new Date() }]],
    ['ORDER BY j.created_at DESC', [cancelledRow({ display_id: 'UPD-004' })]],
  ]);
  const page = await new Jobs(db).list(
    session(),
    'C0123456',
    {},
    undefined,
    50,
  );
  assert.deepEqual(page.jobs[0].cancelRequest, {
    at: CANCEL_AT.toISOString(),
    by: { id: REQUESTER, displayName: 'Ada Lovelace' },
  });
  const [paged] = db.calls.at(-1);
  assert.ok(
    paged.includes(
      'LEFT JOIN cc.application_principals cb ON cb.id=j.cancel_requested_by',
    ),
    'The list reads the cancel person of each row.',
  );
  assert.ok(paged.includes('cb.display_name AS cancel_requested_by_name'));
});

test('the detail carries the cancel request of its header', async () => {
  const db = database([
    ['p.display_name AS requested_by_name', [cancelledRow()]],
    ['WHERE job_id=$1 AND status=$2', []],
  ]);
  const detail = await new Jobs(db).detail(session(), 'C0123456', 'REF-001');
  assert.deepEqual(detail.cancelRequest, {
    at: CANCEL_AT.toISOString(),
    by: { id: REQUESTER, displayName: 'Ada Lovelace' },
  });
  const [header] = db.calls;
  assert.ok(
    header[0].includes(
      'LEFT JOIN cc.application_principals cb ON cb.id=j.cancel_requested_by',
    ),
  );
});

test('attention counts a cancelled job only with a failed or Unknown operation', async () => {
  const db = database([
    [
      'clock_timestamp() AS now',
      [{ now: new Date('2026-10-26T12:10:00.000Z') }],
    ],
    [
      'SELECT seen_at FROM cc.job_activity_seen WHERE principal_id',
      [{ seen_at: new Date('2026-10-26T10:00:00.000Z') }],
    ],
    [
      "j.status IN ('running','awaiting-devices')",
      (v, text) => (text.includes('count(*)') ? [{ count: 0 }] : []),
    ],
    [
      "j.status IN ('accepted','queued','held')",
      (v, text) => (text.includes('count(*)') ? [{ count: 0 }] : []),
    ],
    [
      'j.finished_at >= clock_timestamp()',
      (v, text) =>
        text.includes('count(*)')
          ? [{ count: 1, next_expiry_at: null }]
          : [cancelledRow({ failed: 1 })],
    ],
    ['AS attention', [{ attention: true }]],
  ]);
  const activity = await new Jobs(db).activity(session(), 'C0123456');
  assert.equal(activity.attention, true);
  assert.equal(activity.recent.jobs[0].status, 'cancelled');
  const [[sql]] = db.calls.filter(([text]) => text.includes('AS attention'));
  assert.ok(
    sql.includes(
      "j.status IN ('needs-review','completed-with-errors','failed')",
    ),
    'The built rule stays.',
  );
  assert.ok(
    sql.includes("(j.status='cancelled' AND (j.failed>0 OR j.unknown>0))"),
    'A cancelled job raises attention only with a failed or Unknown operation.',
  );
});

test('a cancelled job counts as finished, not running', async () => {
  const db = database([
    [
      'clock_timestamp() AS now',
      [{ now: new Date('2026-10-26T12:10:00.000Z') }],
    ],
    [
      'SELECT seen_at FROM cc.job_activity_seen WHERE principal_id',
      [{ seen_at: null }],
    ],
    [
      "j.status IN ('running','awaiting-devices')",
      (v, text) => (text.includes('count(*)') ? [{ count: 0 }] : []),
    ],
    [
      "j.status IN ('accepted','queued','held')",
      (v, text) => (text.includes('count(*)') ? [{ count: 0 }] : []),
    ],
    [
      'j.finished_at >= clock_timestamp()',
      (v, text) =>
        text.includes('count(*)')
          ? [{ count: 1, next_expiry_at: null }]
          : [cancelledRow({ cancelled: 2 })],
    ],
    ['AS attention', [{ attention: false }]],
  ]);
  const activity = await new Jobs(db).activity(session(), 'C0123456');
  assert.equal(activity.running.count, 0);
  assert.deepEqual(
    activity.recent.jobs.map((job) => job.status),
    ['cancelled'],
  );
  const runningRows = db.calls.find(
    ([text]) =>
      text.includes("j.status IN ('running','awaiting-devices')") &&
      text.includes('ORDER BY'),
  );
  assert.equal(
    runningRows[0].includes("'cancelled'"),
    false,
    'The running count and list hold no cancelled job.',
  );
});

test('seesEveryJob accepts jobs:read or jobs:manage at the customer scope', () => {
  const district = (action, customerId = 'C0123456') =>
    session([{ action, scope: { kind: 'district', customerId } }]);
  assert.equal(seesEveryJob(district('jobs:read'), 'C0123456'), true);
  assert.equal(seesEveryJob(district('jobs:manage'), 'C0123456'), true);
  assert.equal(
    seesEveryJob(
      session([{ action: 'jobs:manage', scope: { kind: 'platform' } }]),
      'C0123456',
    ),
    true,
  );
  // Another customer's manage grant sees nothing here, and so does a caller with no grant.
  assert.equal(
    seesEveryJob(district('jobs:manage', 'C-other'), 'C0123456'),
    false,
  );
  assert.equal(seesEveryJob(session(), 'C0123456'), false);
});

test('an Unknown row of a cancelled job keeps Reconcile', async () => {
  const db = reconcileDatabase(
    {
      status: 'cancelled',
      cancelled: 1,
      finished_at: new Date('2026-10-26T12:06:05.000Z'),
      cancel_requested_at: CANCEL_AT,
      cancel_requested_by: REQUESTER,
      cancel_requested_by_name: 'Ada Lovelace',
    },
    { status: 'unknown' },
  );
  const orchestration = reconcileOrchestration();
  const operation = await new Jobs(db).reconcile(
    session(),
    'C0123456',
    'UPD-001',
    1,
    '55555555-5555-4555-8555-555555555555',
    orchestration,
    authorizer(['read', 'update']),
  );
  assert.equal(operation.outcome, 'unknown');
  assert.equal(claimCount(db), 1, 'The cancelled job keeps its read-back.');
  assert.equal(orchestration.started.length, 1);
});

test('a Cancelled row holds no Reconcile', async () => {
  const db = reconcileDatabase(
    { status: 'cancelled', cancelled: 1 },
    { status: 'cancelled' },
  );
  const orchestration = reconcileOrchestration();
  await assert.rejects(
    new Jobs(db).reconcile(
      session(),
      'C0123456',
      'UPD-001',
      1,
      '55555555-5555-4555-8555-555555555555',
      orchestration,
      authorizer(['read', 'update']),
    ),
    (error) =>
      error instanceof ConflictException &&
      error.getResponse().reason === 'operation-settled',
  );
  assert.equal(claimCount(db), 0);
  assert.deepEqual(orchestration.started, []);
});

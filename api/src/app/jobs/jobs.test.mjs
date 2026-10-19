import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BadRequestException,
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
  failure: null,
  revision: 4,
  changed_at: new Date('2026-10-06T12:05:00.000Z'),
  correlation_id: '33333333-3333-4333-8333-333333333333',
  created_at: new Date('2026-10-06T12:00:00.000Z'),
  admitted_at: null,
  started_at: new Date('2026-10-06T12:00:00.000Z'),
  finished_at: new Date('2026-10-06T12:02:00.000Z'),
  confirmed_by: null,
  field: null,
  mode: null,
  requested_value: null,
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
    pending: 0,
  });
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
          field: 'annotatedLocation',
          mode: 'replace',
          requested_value: 'Room 10',
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
  assert.equal(detail.confirmedBy.displayName, 'Katherine Johnson');
  assert.equal(detail.previewDisplayId, 'PV-006');
  assert.equal(detail.requestedValue, 'Room 10');
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

test('an unknown or purged job answers 404', async () => {
  const db = database([['LEFT JOIN cc.device_update_jobs u', []]]);
  await assert.rejects(
    new Jobs(db).detail(session(), 'C0123456', 'UPD-999'),
    (error) => error instanceof NotFoundException,
  );
});

test('the operations page filters attention, pages by number, and reads dispatched as pending', async () => {
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
          baseline_value: 'Room 1',
          requested_value: 'Room 4',
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
    '3',
    100,
  );
  assert.equal(page.operations[0].outcome, 'pending');
  assert.equal(page.operations[0].operation, 'replace');
  assert.equal(page.operations[0].operationId, 'UPD-006-4');
  assert.equal(page.nextCursor, null);
  const [, values] = db.calls[1];
  assert.equal(values[4], true);
  assert.equal(values[5], 3);
});

test('the activity answer caps each section and derives the window and attention', async () => {
  let now = 0;
  const db = database([
    [
      'clock_timestamp() AS now',
      [{ now: new Date('2026-10-06T12:00:00.000Z') }],
    ],
    [
      'FROM cc.job_activity_seen',
      [{ seen_at: new Date('2026-10-06T10:00:00.000Z') }],
    ],
    [
      "j.status='running'",
      (values, text) =>
        text.includes('count(*)::int')
          ? [{ count: 51 }]
          : [jobRow({ status: 'running', display_id: 'UPD-009' })],
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
  assert.equal(now, 2);
  const attentionCall = db.calls.find(([text]) =>
    text.includes('AS attention'),
  );
  assert.equal(attentionCall[1][3], '2026-10-06T10:00:00.000Z');
});

test('an empty activity window gives a null next expiry', async () => {
  const db = database([
    ['clock_timestamp() AS now', [{ now: new Date() }]],
    ['FROM cc.job_activity_seen', []],
    [
      "j.status='running'",
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
      mode: 'clear',
      baseline_value: 'Room 3',
      requested_value: null,
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

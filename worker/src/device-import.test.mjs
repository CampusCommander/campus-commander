/**
 * The validation job against a fake store, reader, and database (design section 6, W2).
 * No Google call runs here. `device-import-mock.test.mjs` covers the Google reads.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import test from 'node:test';
import {
  DEVICE_EDIT_TEMPLATE_COLUMNS,
  DEVICE_EDIT_TEMPLATE_HEADERS,
  DEVICE_IMPORT_ROW_LIMIT,
  deviceEditRowChecksum,
  deviceImportDuplicateTagWarning,
  deviceImportExportOnlyStatusWarning,
  deviceImportPermissionRejectionText,
  deviceImportRefusalText,
  deviceImportUnitRejectionText,
} from '@campus/application-contracts';
import {
  DEVICE_IMPORT_BATCH_SIZE,
  DEVICE_IMPORT_LINE_BATCH,
  DEVICE_IMPORT_LINE_BYTES,
  DEVICE_IMPORT_MALFORMED_CHECKSUM_WARNING,
  DeviceImportJobs,
  deviceImportRequestSchema,
} from './device-import.ts';
import { handleDeviceImportDispatch } from './dispatch.ts';

const customerId = 'C0123456';
const jobId = randomUUID();
const leaseId = randomUUID();
const correlationId = randomUUID();
const request = { customerId, jobId, leaseId, correlationId };
const signal = new AbortController().signal;
const secret = 's'.repeat(32);
const artifactId = 'artifact-1';
const stamp = '2026-10-29T12:00:00.000Z';

/** The index of each template column. The file keeps template order. */
const column = (key) =>
  DEVICE_EDIT_TEMPLATE_COLUMNS.findIndex((entry) => entry.key === key);

/** One row of ten cells, built by column key. */
function cellsOf(fields = {}) {
  const cells = DEVICE_EDIT_TEMPLATE_COLUMNS.map(() => '');
  for (const [key, value] of Object.entries(fields))
    cells[column(key)] = value ?? '';
  return cells;
}

/** One CSV file with its header row. */
function csvText(rows, headers = DEVICE_EDIT_TEMPLATE_HEADERS) {
  const quote = (cell) =>
    /[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
  return `${[headers, ...rows]
    .map((cells) => cells.map(quote).join(','))
    .join('\r\n')}\r\n`;
}

/** The checksum of one row, as the export writes it. */
function checksumOf(fields) {
  return deviceEditRowChecksum({
    deviceId: fields.deviceId,
    status: fields.status ?? '',
    annotatedAssetId: fields.annotatedAssetId ?? '',
    annotatedLocation: fields.annotatedLocation ?? '',
    annotatedUser: fields.annotatedUser ?? '',
    notes: fields.notes ?? '',
    orgUnitPath: fields.orgUnitPath ?? '',
  });
}

/** One stored device row of `cc.devices`. */
function device(deviceId, overrides = {}) {
  return {
    device_id: deviceId,
    status: 'ACTIVE',
    asset_tag: null,
    annotated_location: null,
    annotated_user: null,
    notes: null,
    org_unit_path: '/Schools/North',
    last_entity_sync: new Date('2026-09-01T00:00:00.000Z'),
    removed_at: null,
    ...overrides,
  };
}

/** The stale mark of the design: a read more than 24 hours ago (ac/entity-cache.ts). */
const stale = () => new Date('2026-09-01T00:00:00.000Z');
const fresh = () => new Date();

/** Timers whose callbacks the test fires by hand. */
function fakeTimers() {
  const intervals = new Map();
  let sequence = 0;
  return {
    setInterval(callback) {
      sequence += 1;
      intervals.set(sequence, callback);
      return sequence;
    },
    clearInterval(handle) {
      intervals.delete(handle);
    },
    async fire() {
      for (const callback of [...intervals.values()]) await callback();
    },
    get active() {
      return intervals.size;
    },
  };
}

/** A store that serves the uploaded file in chunks that break pairs and quoted cells. */
function fakeStore(text, options = {}) {
  const calls = [];
  return {
    calls,
    async *openRead(id) {
      calls.push(id);
      if (options.readFailure) throw new Error('The artifact read failed.');
      const size = options.chunkSize ?? 7;
      for (let start = 0; start < text.length; start += size)
        yield Buffer.from(text.slice(start, start + size), 'utf8');
    },
  };
}

/** One Google device observation, in the shape that `deviceStates` answers. */
function observation(deviceId, overrides = {}) {
  return {
    deviceId,
    status: 'ACTIVE',
    serialNumber: `serial-${deviceId}`,
    model: 'Chromebook 300e',
    assetTag: null,
    orgUnitPath: '/Schools/North',
    lastContact: '2026-10-20T00:00:00.000Z',
    annotatedLocation: null,
    annotatedUser: null,
    notes: null,
    ...overrides,
  };
}

/** A reader that answers the states and the tree of one test. */
function fakeReader(options = {}) {
  const calls = { states: [], tree: [] };
  return {
    calls,
    async deviceStates(_credential, id, deviceIds) {
      calls.states.push([...deviceIds]);
      options.events?.push('deviceStates');
      if (options.deviceStates)
        return options.deviceStates([...deviceIds], calls.states.length);
      return deviceIds.map((deviceId) => {
        const state = (options.states ?? []).find(
          (entry) => entry.deviceId === deviceId,
        );
        return (
          state ?? { deviceId, status: 'found', device: observation(deviceId) }
        );
      });
    },
    async readOrgUnitTree() {
      calls.tree.push(1);
      options.events?.push('readOrgUnitTree');
      if (options.treeFailure) throw new Error('The tree read failed.');
      return options.tree ?? [{ orgUnitPath: '/Schools/North', name: 'North' }];
    },
  };
}

/**
 * A database that answers the import functions and the device reads, and records every call. The
 * `upsert_devices` answer changes the stored row, as the real function does, so the compare pass
 * reads the fresh values.
 */
function fakeDatabase(options = {}) {
  const calls = {
    claim: [],
    renew: [],
    lines: [],
    finish: [],
    lookup: [],
    compare: [],
    tags: [],
    upsert: [],
    removed: [],
    transactions: 0,
    order: [],
  };
  const devices = options.devices ?? new Map();
  const job = { status: null, cancelRequested: false };
  const lease = { fenced: false };
  const events = options.events ?? [];
  let lineCount = 0;

  const database = {
    calls,
    get status() {
      return job.status;
    },
    get lineCount() {
      return lineCount;
    },
    /** Another connection stores the cancel request (design section 5). */
    requestCancel() {
      job.cancelRequested = true;
    },
    async query(sql, values) {
      const name = /cc\.([a-z_]+)\(/.exec(sql)?.[1];
      if (name === 'claim_device_import_job') {
        calls.claim.push(values);
        if (options.claim) return { rows: [{ result: options.claim(values) }] };
        if (job.status !== null || job.cancelRequested)
          return { rows: [{ result: { outcome: 'done' } }] };
        return {
          rows: [
            {
              result: {
                outcome: 'claimed',
                displayId: options.displayId ?? 'IMP-001',
                mode: options.mode ?? 'sync-changes',
                sourceArtifactId: options.missingArtifact ? null : artifactId,
                generation: options.noCredential ? null : 1,
                credentialId: options.noCredential ? null : randomUUID(),
                envelope: options.noCredential
                  ? null
                  : { ciphertext: 'cipher' },
                statusPermissions: options.statusPermissions ?? [
                  'disable',
                  'reenable',
                  'deprovision',
                ],
              },
            },
          ],
        };
      }
      if (name === 'renew_device_import_job') {
        const [phase, done, total] = values.slice(3, 6);
        calls.renew.push({ phase, done, total });
        let outcome;
        if (options.renew) outcome = options.renew(phase, done, total);
        else if (lease.fenced) outcome = 'fenced';
        else if (job.status !== null || job.cancelRequested) outcome = 'done';
        else outcome = 'renewed';
        if (outcome === 'done') job.cancelRequested = true;
        if (outcome === 'fenced') lease.fenced = true;
        return { rows: [{ result: { outcome } }] };
      }
      if (name === 'store_device_import_lines') {
        const lines = JSON.parse(values[3]);
        calls.lines.push(lines);
        calls.order.push('lines');
        lineCount += lines.length;
        if (options.linesFenced)
          return { rows: [{ result: { outcome: 'fenced' } }] };
        if (job.status !== null || job.cancelRequested)
          return { rows: [{ result: { outcome: 'done' } }] };
        return { rows: [{ result: { outcome: 'stored' } }] };
      }
      if (name === 'finish_device_import_job') {
        const counts = values[3] === null ? null : JSON.parse(values[3]);
        const failure = values[4] ?? null;
        const refusal = values[5] ?? null;
        const refusalText = values[6] ?? null;
        calls.finish.push({ counts, failure, refusal, refusalText });
        if (options.finish)
          return { rows: [{ result: options.finish(values) }] };
        if (job.status !== null)
          return {
            rows: [{ result: { outcome: 'finished', status: job.status } }],
          };
        if (lease.fenced) return { rows: [{ result: { outcome: 'fenced' } }] };
        if (job.cancelRequested) {
          job.status = 'cancelled';
          return {
            rows: [{ result: { outcome: 'finished', status: 'cancelled' } }],
          };
        }
        if (failure !== null) {
          job.status = 'failed';
          return {
            rows: [{ result: { outcome: 'finished', status: 'failed' } }],
          };
        }
        if (counts === null)
          throw new Error(
            'The import finish requires the counts or a failure.',
          );
        if (
          counts.rows !==
          counts.unchanged +
            counts.noChangeNeeded +
            counts.proposed +
            counts.rejected
        )
          throw new Error('The import counts are invalid.');
        const status =
          counts.proposed === 0 && counts.rejected > 0
            ? 'completed-with-errors'
            : 'completed';
        job.status = status;
        return {
          rows: [
            {
              result: {
                outcome: 'finished',
                status,
                plan:
                  counts.proposed > 0
                    ? {
                        planId: randomUUID(),
                        revision: 1,
                        state: 'open',
                        expiresAt: '2026-10-29T13:00:00.000Z',
                      }
                    : null,
              },
            },
          ],
        };
      }
      if (sql.includes('clock_timestamp')) {
        if (options.stampFailure) throw new Error('The clock read failed.');
        events.push('stamp');
        return { rows: [{ result: new Date(stamp) }] };
      }
      if (name === 'upsert_devices') {
        const observed = JSON.parse(values[1]);
        calls.upsert.push({ devices: observed, syncedAt: values[2] });
        for (const entry of observed) {
          const row = devices.get(entry.deviceId);
          if (row === undefined) continue;
          row.status = entry.status;
          row.asset_tag = entry.assetTag;
          row.annotated_location = entry.annotatedLocation;
          row.annotated_user = entry.annotatedUser;
          row.notes = entry.notes;
          row.org_unit_path = entry.orgUnitPath;
          row.last_entity_sync = new Date(values[2]);
        }
        return { rows: [{ result: observed.length }] };
      }
      if (name === 'soft_delete_devices') {
        const removed = JSON.parse(values[1]);
        calls.removed.push(removed);
        for (const deviceId of removed) {
          const row = devices.get(deviceId);
          if (row !== undefined) row.removed_at = new Date(stamp);
        }
        return { rows: [{ result: removed.length }] };
      }
      if (sql.includes('asset_tag=ANY')) {
        const [tagCustomer, tags] = values;
        assert.equal(tagCustomer, customerId);
        calls.tags.push(tags);
        return {
          rows: [...devices.values()].filter(
            (row) => row.asset_tag !== null && tags.includes(row.asset_tag),
          ),
        };
      }
      if (sql.includes('annotated_location')) {
        calls.compare.push(values[1]);
        return {
          rows: values[1].flatMap((id) => {
            const row = devices.get(id);
            return row === undefined ? [] : [row];
          }),
        };
      }
      if (sql.includes('FROM cc.devices')) {
        if (options.lookupFailure) throw new Error('The lookup failed.');
        calls.lookup.push(values[1]);
        calls.order.push('lookup');
        return {
          rows: values[1].flatMap((id) => {
            const row = devices.get(id);
            return row === undefined
              ? []
              : [
                  {
                    device_id: row.device_id,
                    removed_at: row.removed_at,
                    last_entity_sync: row.last_entity_sync,
                  },
                ];
          }),
        };
      }
      throw new Error(`Unexpected call: ${sql}`);
    },
    async transaction(run) {
      calls.transactions += 1;
      return run({ query: (sql, values) => database.query(sql, values) });
    },
  };
  return database;
}

/** One validation run over the given file and fixtures. */
function harness(options = {}) {
  const events = options.events ?? [];
  const devices =
    options.devices instanceof Map
      ? options.devices
      : new Map((options.devices ?? []).map((row) => [row.device_id, row]));
  const database = fakeDatabase({
    devices,
    events,
    mode: options.mode,
    ...(options.database ?? {}),
  });
  const text =
    options.text ??
    csvText([cellsOf({ deviceId: 'dev-a', orgUnitPath: '/Schools/North' })]);
  const store = fakeStore(text, options.store ?? {});
  const reader = fakeReader({ events, ...(options.reader ?? {}) });
  const timers = options.timers ?? fakeTimers();
  const jobs = new DeviceImportJobs(
    database,
    store,
    reader,
    { open: () => options.credential ?? { serviceAccount: {}, subject: '' } },
    { batchSize: options.batchSize ?? DEVICE_IMPORT_BATCH_SIZE, timers },
  );
  return {
    database,
    store,
    reader,
    timers,
    events,
    run: (extra = {}) => jobs.run({ ...request, ...extra }, signal),
  };
}

test('a validation stores the counts, the changes, and the plan', async () => {
  const unchangedRow = {
    deviceId: 'dev-a',
    status: 'ACTIVE',
    notes: 'note',
    orgUnitPath: '/Schools/North',
  };
  const text = csvText([
    cellsOf({ ...unchangedRow, checksum: await checksumOf(unchangedRow) }),
    cellsOf({
      deviceId: 'dev-b',
      status: 'DISABLED',
      notes: 'a new note',
      orgUnitPath: '/Schools/North',
    }),
    cellsOf({
      deviceId: 'dev-c',
      notes: 'same',
      orgUnitPath: '/Schools/North',
    }),
  ]);
  const harnessed = harness({
    text,
    devices: [
      device('dev-a', { notes: 'note', last_entity_sync: fresh() }),
      device('dev-b', { notes: 'old', last_entity_sync: stale() }),
      device('dev-c', {
        notes: 'same',
        last_entity_sync: new Date('2026-09-15T00:00:00.000Z'),
      }),
    ],
    reader: {
      states: [
        {
          deviceId: 'dev-b',
          status: 'found',
          device: observation('dev-b', { notes: 'old' }),
        },
        {
          deviceId: 'dev-c',
          status: 'found',
          device: observation('dev-c', { notes: 'same' }),
        },
      ],
    },
  });

  const answer = await harnessed.run();

  assert.equal(answer.outcome, 'completed');
  assert.equal(answer.status, 'completed');
  assert.equal(answer.displayId, 'IMP-001');
  assert.deepEqual(answer.counts, {
    rows: 3,
    unchanged: 1,
    noChangeNeeded: 1,
    proposed: 1,
    rejected: 0,
    candidateRows: 2,
    staleDevicesRead: 2,
    oldestObservedAt: stamp,
  });
  assert.equal(answer.plan?.state, 'open');
  assert.equal(answer.plan?.revision, 1);
  assert.equal(answer.plan?.expiresAt, '2026-10-29T13:00:00.000Z');
  // Only the stale candidate devices reach Google (design section 6, step 8).
  assert.deepEqual(harnessed.reader.calls.states, [['dev-b', 'dev-c']]);
  // One tree read serves the whole job (design section 6, step 13).
  assert.equal(harnessed.reader.calls.tree.length, 1);
  assert.deepEqual(harnessed.database.calls.lines.flat(), [
    {
      kind: 'change',
      sourceRow: 2,
      deviceId: 'dev-b',
      changeType: 'field',
      field: 'notes',
      mode: 'replace',
      currentValue: 'old',
      newValue: 'a new note',
    },
    {
      kind: 'change',
      sourceRow: 2,
      deviceId: 'dev-b',
      changeType: 'status',
      action: 'disable',
      reason: null,
      currentValue: 'ACTIVE',
      newValue: 'DISABLED',
    },
  ]);
  // The phases of design section 6: header-check, refresh, compare, and report.
  assert.deepEqual(
    harnessed.database.calls.renew.map((call) => call.phase),
    ['header-check', 'refresh', 'refresh', 'compare', 'compare', 'report'],
  );
  assert.deepEqual(
    harnessed.database.calls.renew.map((call) => [call.done, call.total]),
    [
      [3, null],
      [0, 2],
      [2, 2],
      [0, 2],
      [2, 2],
      [2, 2],
    ],
  );
  assert.equal(harnessed.timers.active, 0, 'The tick stops after the finish.');
});

test('every refresh read keeps its stamp before the Google call', async () => {
  const text = csvText([
    cellsOf({ deviceId: 'dev-a', orgUnitPath: '/Schools/North' }),
    cellsOf({ deviceId: 'dev-b', orgUnitPath: '/Schools/North' }),
  ]);
  const events = [];
  const harnessed = harness({
    text,
    events,
    batchSize: 1,
    devices: [
      device('dev-a', { last_entity_sync: stale() }),
      device('dev-b', { last_entity_sync: stale() }),
    ],
  });

  await harnessed.run();

  // Postgres stamps the read time before each Google call (design section 6, step 9). The tree
  // read is one call for the job, so only the refresh reads carry a stamp.
  assert.deepEqual(
    events.filter((event) => event === 'stamp' || event === 'deviceStates'),
    ['stamp', 'deviceStates', 'stamp', 'deviceStates'],
  );
  for (const [index, event] of events.entries())
    if (event === 'deviceStates') assert.equal(events[index - 1], 'stamp');
});

test('a failed device rejects only its own rows', async () => {
  const text = csvText([
    cellsOf({ deviceId: 'dev-a', notes: 'one', orgUnitPath: '/Schools/North' }),
    cellsOf({ deviceId: 'dev-b', notes: 'two', orgUnitPath: '/Schools/North' }),
  ]);
  const harnessed = harness({
    text,
    devices: [device('dev-a'), device('dev-b')],
    reader: {
      deviceStates: (ids) =>
        ids.map((deviceId) =>
          deviceId === 'dev-a'
            ? {
                deviceId,
                status: 'failed',
                failure: { code: 'provider-unavailable' },
              }
            : { deviceId, status: 'found', device: observation(deviceId) },
        ),
    },
  });

  const answer = await harnessed.run();

  assert.equal(answer.outcome, 'completed');
  assert.equal(answer.counts.proposed, 1);
  assert.equal(answer.counts.rejected, 1);
  assert.equal(answer.status, 'completed');
  const lines = harnessed.database.calls.lines.flat();
  const rejected = lines.filter((line) => line.kind === 'rejection');
  assert.deepEqual(
    rejected.map((line) => [line.sourceRow, line.reason]),
    [[1, 'Current values unavailable.']],
  );
  // The rejected row's line carries the ten template cells of its row.
  assert.equal(rejected[0].templateCells.length, 10);
  assert.equal(rejected[0].templateCells[column('deviceId')], 'dev-a');
  // The stored values of the failed device stay: no read is written for it.
  assert.deepEqual(
    harnessed.database.calls.upsert.flatMap((call) =>
      call.devices.map((entry) => entry.deviceId),
    ),
    ['dev-b'],
  );
  assert.deepEqual(
    lines
      .filter((line) => line.kind === 'change')
      .map((line) => [line.deviceId, line.field]),
    [['dev-b', 'notes']],
  );
});

test('a token failure rejects its batch and later batches continue', async () => {
  const text = csvText([
    cellsOf({ deviceId: 'dev-a', notes: 'one', orgUnitPath: '/Schools/North' }),
    cellsOf({ deviceId: 'dev-b', notes: 'two', orgUnitPath: '/Schools/North' }),
    cellsOf({
      deviceId: 'dev-c',
      notes: 'three',
      orgUnitPath: '/Schools/North',
    }),
  ]);
  const harnessed = harness({
    text,
    batchSize: 1,
    devices: [device('dev-a'), device('dev-b'), device('dev-c')],
    reader: {
      deviceStates: (ids, call) => {
        if (call === 1) throw new Error('credential-rejected');
        return ids.map((deviceId) => ({
          deviceId,
          status: 'found',
          device: observation(deviceId),
        }));
      },
    },
  });

  const answer = await harnessed.run();

  assert.equal(answer.outcome, 'completed');
  assert.equal(answer.counts.rejected, 1);
  assert.equal(answer.counts.proposed, 2);
  // Every stale device was sent, including the batch whose read threw.
  assert.equal(answer.counts.staleDevicesRead, 3);
  assert.equal(harnessed.reader.calls.states.length, 3);
  assert.deepEqual(
    harnessed.database.calls.lines
      .flat()
      .filter((line) => line.kind === 'rejection')
      .map((line) => line.sourceRow),
    [1],
  );
  assert.deepEqual(
    harnessed.database.calls.lines
      .flat()
      .filter((line) => line.kind === 'change')
      .map((line) => line.deviceId),
    ['dev-b', 'dev-c'],
  );
});

test('the refresh stores the found and the missing devices in one transaction', async () => {
  const text = csvText([
    cellsOf({ deviceId: 'dev-a', notes: 'one', orgUnitPath: '/Schools/North' }),
    cellsOf({ deviceId: 'dev-b', notes: 'two', orgUnitPath: '/Schools/North' }),
  ]);
  const harnessed = harness({
    text,
    devices: [device('dev-a'), device('dev-b')],
    reader: {
      deviceStates: (ids) =>
        ids.map((deviceId) =>
          deviceId === 'dev-b'
            ? { deviceId, status: 'missing' }
            : {
                deviceId,
                status: 'found',
                device: observation(deviceId, { notes: 'two' }),
              },
        ),
    },
  });

  const answer = await harnessed.run();

  assert.equal(answer.outcome, 'completed');
  assert.equal(harnessed.database.calls.transactions, 1);
  assert.deepEqual(harnessed.database.calls.removed, [['dev-b']]);
  assert.deepEqual(
    harnessed.database.calls.upsert.map((call) => call.syncedAt),
    [stamp],
  );
  assert.deepEqual(
    harnessed.database.calls.upsert[0].devices.map((entry) => entry.deviceId),
    ['dev-a'],
  );
  // A device that Google no longer returns rejects its rows (design section 6, step 11).
  assert.deepEqual(
    harnessed.database.calls.lines
      .flat()
      .filter((line) => line.kind === 'rejection')
      .map((line) => [line.sourceRow, line.reason]),
    [[2, 'Google no longer returns this device.']],
  );
});

test('only stale devices are read', async () => {
  const text = csvText([
    cellsOf({ deviceId: 'dev-fresh', orgUnitPath: '/Schools/North' }),
    cellsOf({ deviceId: 'dev-stale', orgUnitPath: '/Schools/North' }),
  ]);
  const harnessed = harness({
    text,
    devices: [
      device('dev-fresh', { last_entity_sync: fresh() }),
      device('dev-stale', { last_entity_sync: stale() }),
    ],
  });

  const answer = await harnessed.run();

  assert.equal(answer.outcome, 'completed');
  assert.equal(answer.counts.staleDevicesRead, 1);
  assert.deepEqual(harnessed.reader.calls.states, [['dev-stale']]);
});

test('a refused file fails the job with its code and the module text', async () => {
  const ragged = csvText([['dev-a'], ['dev-b']]).replace(
    'dev-b\r\n',
    'dev-b,extra\r\n',
  );
  const harnessed = harness({ text: ragged, devices: [device('dev-a')] });

  const answer = await harnessed.run();

  assert.equal(answer.outcome, 'failed');
  assert.equal(answer.failure, 'invalid-response');
  assert.equal(answer.refusal, 'ragged-record');
  assert.deepEqual(harnessed.database.calls.finish, [
    {
      counts: null,
      failure: 'invalid-response',
      refusal: 'ragged-record',
      refusalText: deviceImportRefusalText('ragged-record'),
    },
  ]);
  assert.equal(harnessed.database.calls.lines.length, 0);
  assert.equal(harnessed.database.calls.transactions, 0);
});

test('a file that is not UTF-8 is refused as unreadable', async () => {
  const harnessed = harness({
    store: { readFailure: true },
    devices: [device('dev-a')],
  });

  const answer = await harnessed.run();

  // A store read fault is a storage failure, not a file refusal (design section 6).
  assert.equal(answer.outcome, 'failed');
  assert.equal(answer.failure, 'storage-unavailable');
  assert.equal(harnessed.database.calls.lines.length, 0);
});

test('Sync changes refuses a file without the Checksum column, and Sync all rows accepts it', async () => {
  const headers = DEVICE_EDIT_TEMPLATE_HEADERS.filter(
    (header) => header !== 'Checksum',
  );
  const text = csvText(
    [
      cellsOf({
        deviceId: 'dev-a',
        notes: 'one',
        orgUnitPath: '/Schools/North',
      }).filter((_cell, index) => column('checksum') !== index),
    ],
    headers,
  );
  const refused = harness({ text, devices: [device('dev-a')] });

  const answer = await refused.run();

  assert.equal(answer.outcome, 'failed');
  assert.equal(answer.refusal, 'header-refused');
  assert.match(answer.failure, /invalid-response/);
  assert.match(refused.database.calls.finish[0].refusalText, /Checksum column/);
  assert.match(refused.database.calls.finish[0].refusalText, /Sync all rows/);

  const accepted = harness({
    text,
    mode: 'sync-all-rows',
    devices: [device('dev-a')],
  });
  const second = await accepted.run();
  assert.equal(second.outcome, 'completed');
  assert.equal(second.counts.candidateRows, 1);
  assert.equal(second.counts.unchanged, 0);
});

test('a cancel keeps no report and no plan', async () => {
  const timers = fakeTimers();
  const text = csvText([
    cellsOf({ deviceId: 'dev-a', notes: 'one', orgUnitPath: '/Schools/North' }),
  ]);
  // The renew reads a stored cancel request and answers `done` (design section 6, step 1).
  const harnessed = harness({
    text,
    timers,
    devices: [device('dev-a')],
    database: { renew: () => 'done' },
  });

  const answer = await harnessed.run();

  assert.equal(answer.outcome, 'cancelled');
  assert.deepEqual(harnessed.database.calls.finish, [
    { counts: null, failure: null, refusal: null, refusalText: null },
  ]);
  assert.equal(harnessed.database.calls.lines.length, 0);
  assert.equal(harnessed.timers.active, 0);
});

test('the row limit refuses a file above 50,000 rows', async () => {
  const rows = Array.from(
    { length: DEVICE_IMPORT_ROW_LIMIT + 1 },
    (_value, index) =>
      cellsOf({
        deviceId: `dev-${index}`,
        orgUnitPath: '/Schools/North',
      }),
  );
  const harnessed = harness({
    text: csvText(rows),
    batchSize: 10_000,
    devices: [],
  });

  const answer = await harnessed.run();

  assert.equal(answer.outcome, 'failed');
  assert.equal(answer.refusal, 'too-many-rows');
  assert.equal(answer.failure, 'invalid-response');
  assert.equal(harnessed.database.lineCount, 0);
});

test('the report closes a call at 1,000 lines', async () => {
  // The tenth column carries the device ID, so an empty ID rejects each row.
  const rows = Array.from({ length: 1_200 }, () =>
    cellsOf({ orgUnitPath: '/Schools/North' }),
  );
  const harnessed = harness({ text: csvText(rows), devices: [] });

  const answer = await harnessed.run();

  assert.equal(answer.outcome, 'completed');
  assert.equal(answer.status, 'completed-with-errors');
  assert.equal(answer.counts.rejected, 1_200);
  assert.equal(answer.counts.proposed, 0);
  assert.deepEqual(
    harnessed.database.calls.lines.map((batch) => batch.length),
    [DEVICE_IMPORT_LINE_BATCH, 200],
  );
  assert.equal(answer.plan, null);
});

test('a busy claim, a fenced lease, and an ended job write nothing', async () => {
  const busy = harness({
    database: { claim: () => ({ outcome: 'busy' }) },
    devices: [device('dev-a')],
  });
  assert.deepEqual(await busy.run(), { outcome: 'busy' });
  assert.equal(busy.database.calls.finish.length, 0);
  assert.equal(busy.database.calls.lines.length, 0);

  const fenced = harness({
    database: { renew: () => 'fenced' },
    devices: [device('dev-a')],
  });
  assert.deepEqual(await fenced.run(), { outcome: 'fenced' });
  assert.equal(fenced.database.calls.finish.length, 0);
  assert.equal(fenced.database.calls.lines.length, 0);

  // An ended job repeats its stored answer. The finish writes nothing (migration 017).
  const ended = harness({
    database: {
      claim: () => ({ outcome: 'done' }),
      finish: () => ({ outcome: 'finished', status: 'completed' }),
    },
    devices: [device('dev-a')],
  });
  assert.deepEqual(await ended.run(), { outcome: 'done' });
  assert.deepEqual(ended.database.calls.finish, [
    { counts: null, failure: null, refusal: null, refusalText: null },
  ]);
});

test('a file of rejected rows stores each call before the next one fills', async () => {
  // Every row but the last holds no Device ID, so pass 1 writes one rejection line per row.
  const rows = Array.from({ length: 2_499 }, () =>
    cellsOf({ orgUnitPath: '/Schools/North' }),
  );
  rows.push(cellsOf({ deviceId: 'dev-a', orgUnitPath: '/Schools/North' }));
  const harnessed = harness({
    text: csvText(rows),
    devices: [device('dev-a', { last_entity_sync: fresh() })],
  });

  const answer = await harnessed.run();

  assert.equal(answer.outcome, 'completed');
  assert.equal(answer.counts.rejected, 2_499);
  assert.equal(answer.counts.noChangeNeeded, 1);
  assert.deepEqual(
    harnessed.database.calls.lines.map((batch) => batch.length),
    [1_000, 1_000, 499],
  );
  // The first two calls land during pass 1, before the inventory lookup.
  assert.deepEqual(harnessed.database.calls.order, [
    'lines',
    'lines',
    'lookup',
    'lines',
  ]);
});

test('a call stays below the 32 MiB that the store accepts', async () => {
  // Ten full cells make a rejection line of about 82 KB, so the byte limit closes the call.
  const cell = 'n'.repeat(16_384);
  const rows = Array.from({ length: 450 }, () =>
    cellsOf({
      annotatedLocation: cell,
      annotatedAssetId: cell,
      annotatedUser: cell,
      notes: cell,
      orgUnitPath: cell,
    }),
  );
  const harnessed = harness({
    text: csvText(rows),
    devices: [],
    store: { chunkSize: 65_536 },
  });

  const answer = await harnessed.run();

  assert.equal(answer.outcome, 'completed');
  assert.equal(answer.counts.rejected, 450);
  assert.ok(
    harnessed.database.calls.lines.length > 1,
    'The byte limit closes the call before 1,000 lines.',
  );
  for (const batch of harnessed.database.calls.lines)
    assert.ok(
      Buffer.byteLength(JSON.stringify(batch), 'utf8') <
        DEVICE_IMPORT_LINE_BYTES,
      'A call stays under the document limit of cc.store_device_import_lines.',
    );
  assert.equal(
    harnessed.database.calls.lines.flat().length,
    450,
    'Every line is stored once.',
  );
});

test('the failure request ends a lost run with interrupted', async () => {
  const harnessed = harness({ devices: [device('dev-a')] });

  const answer = await harnessed.run({ failure: 'interrupted' });

  assert.equal(answer.outcome, 'failed');
  assert.equal(answer.failure, 'interrupted');
  assert.deepEqual(harnessed.database.calls.finish, [
    {
      counts: null,
      failure: 'interrupted',
      refusal: null,
      refusalText: null,
    },
  ]);
  assert.equal(harnessed.store.calls.length, 0);
});

test('the request refuses a failure code of another job', () => {
  const parsed = deviceImportRequestSchema.safeParse({
    ...request,
    failure: 'storage-unavailable',
  });
  assert.equal(parsed.success, false);
});

test('a missing artifact or credential fails the job', async () => {
  const noArtifact = harness({
    database: { missingArtifact: true },
    devices: [device('dev-a')],
  });
  const first = await noArtifact.run();
  assert.equal(first.outcome, 'failed');
  assert.equal(first.failure, 'storage-unavailable');
  assert.equal(noArtifact.store.calls.length, 0);

  const noCredential = harness({
    database: { noCredential: true },
    devices: [device('dev-a')],
  });
  const second = await noCredential.run();
  assert.equal(second.outcome, 'failed');
  assert.equal(second.failure, 'key-unavailable');
  assert.equal(noCredential.store.calls.length, 0);
});

test('a lookup failure fails the job with inventory-unavailable', async () => {
  const harnessed = harness({
    database: { lookupFailure: true },
    devices: [device('dev-a')],
  });

  const answer = await harnessed.run();

  assert.equal(answer.outcome, 'failed');
  assert.equal(answer.failure, 'inventory-unavailable');
  assert.equal(harnessed.database.calls.lines.length, 0);
});

test('an unknown and a removed device each reject their row', async () => {
  const text = csvText([
    cellsOf({ deviceId: 'dev-unknown', orgUnitPath: '/Schools/North' }),
    cellsOf({ deviceId: 'dev-removed', orgUnitPath: '/Schools/North' }),
  ]);
  const harnessed = harness({
    text,
    devices: [
      device('dev-removed', {
        removed_at: new Date('2026-10-01T00:00:00.000Z'),
      }),
    ],
  });

  const answer = await harnessed.run();

  assert.equal(answer.outcome, 'completed');
  assert.equal(answer.status, 'completed-with-errors');
  assert.equal(answer.counts.rejected, 2);
  assert.deepEqual(
    harnessed.database.calls.lines
      .flat()
      .map((line) => [line.sourceRow, line.reason]),
    [
      [
        1,
        'Campus Commander holds no device with this ID. Import never creates devices.',
      ],
      [2, 'Google no longer returns this device.'],
    ],
  );
  assert.equal(harnessed.reader.calls.states.length, 0);
});

test('a missing, a malformed, and a duplicated device ID each reject their row', async () => {
  const text = csvText([
    cellsOf({ deviceId: 'dev-a', notes: 'one', orgUnitPath: '/Schools/North' }),
    cellsOf({
      deviceId: 'dev a!',
      notes: 'two',
      orgUnitPath: '/Schools/North',
    }),
    cellsOf({
      deviceId: 'dev-a',
      notes: 'three',
      orgUnitPath: '/Schools/North',
    }),
    cellsOf({ deviceId: '', notes: 'four', orgUnitPath: '/Schools/North' }),
  ]);
  const harnessed = harness({ text, devices: [device('dev-a')] });

  const answer = await harnessed.run();

  assert.equal(answer.outcome, 'completed');
  assert.equal(answer.counts.unchanged, 0);
  assert.equal(answer.counts.rejected, 3);
  assert.equal(answer.counts.proposed, 1);
  assert.deepEqual(
    harnessed.database.calls.lines
      .flat()
      .filter((line) => line.kind === 'rejection')
      .map((line) => [line.sourceRow, line.reason]),
    [
      [
        2,
        'The Device ID holds 1 to 128 letters, digits, hyphens, or underscores.',
      ],
      [3, 'Another row uses this Device ID.'],
      [4, 'The row holds no Device ID.'],
    ],
  );
});

test('a status code without its permission rejects its row', async () => {
  const text = csvText([
    cellsOf({
      deviceId: 'dev-a',
      status: 'DEPROVISION:RETIRING_DEVICE',
      orgUnitPath: '/Schools/North',
    }),
  ]);
  const harnessed = harness({
    text,
    database: { statusPermissions: ['disable'] },
    devices: [device('dev-a')],
  });

  const answer = await harnessed.run();

  assert.equal(answer.outcome, 'completed');
  assert.equal(answer.counts.rejected, 1);
  assert.equal(harnessed.reader.calls.states.length, 0);
  assert.deepEqual(
    harnessed.database.calls.lines.flat().map((line) => line.reason),
    [deviceImportPermissionRejectionText('deprovision')],
  );
});

test('an unknown unit rejects its row, and a failed tree read rejects every unit change', async () => {
  const text = csvText([
    cellsOf({ deviceId: 'dev-a', orgUnitPath: '/Schools/Nowhere' }),
    cellsOf({ deviceId: 'dev-b', orgUnitPath: '/Schools/North' }),
  ]);
  const unknown = harness({
    text,
    devices: [device('dev-a'), device('dev-b')],
  });

  const first = await unknown.run();

  assert.equal(first.outcome, 'completed');
  assert.equal(first.counts.rejected, 1);
  assert.deepEqual(
    unknown.database.calls.lines
      .flat()
      .filter((line) => line.kind === 'rejection')
      .map((line) => [line.sourceRow, line.reason]),
    [[1, deviceImportUnitRejectionText('/Schools/Nowhere')]],
  );

  const failed = harness({
    text,
    devices: [device('dev-a'), device('dev-b')],
    reader: { treeFailure: true },
  });

  const second = await failed.run();

  assert.equal(second.outcome, 'completed');
  assert.equal(second.counts.rejected, 2);
  assert.deepEqual(
    failed.database.calls.lines
      .flat()
      .filter((line) => line.kind === 'rejection')
      .map((line) => line.sourceRow),
    [1, 2],
  );
});

test('the warnings never block a change', async () => {
  const headers = [...DEVICE_EDIT_TEMPLATE_HEADERS, 'Room'];
  const text = csvText(
    [
      [...cellsOf({ deviceId: 'dev-a' }), 'B12'],
      [
        ...cellsOf({
          deviceId: 'dev-b',
          checksum: '0.bad',
          status: 'INACTIVE',
          annotatedAssetId: 'SHARED',
          orgUnitPath: '/Schools/North',
        }),
        'B13',
      ],
    ],
    headers,
  );
  const harnessed = harness({
    text,
    devices: [
      device('dev-a', { asset_tag: 'TAKEN', last_entity_sync: fresh() }),
      device('dev-b', { last_entity_sync: fresh() }),
      device('dev-other', { asset_tag: 'SHARED', last_entity_sync: fresh() }),
    ],
    reader: {
      states: [
        {
          deviceId: 'dev-a',
          status: 'found',
          device: observation('dev-a', { assetTag: 'TAKEN' }),
        },
      ],
    },
  });

  const answer = await harnessed.run();

  assert.equal(answer.outcome, 'completed');
  assert.equal(answer.counts.proposed, 1);
  const warnings = harnessed.database.calls.lines
    .flat()
    .filter((line) => line.kind === 'warning')
    .map((line) => line.warning);
  assert.deepEqual(warnings, [
    'The column "Room" is unknown. It stays out of every write.',
    DEVICE_IMPORT_MALFORMED_CHECKSUM_WARNING,
    deviceImportExportOnlyStatusWarning('INACTIVE', 'ACTIVE'),
    deviceImportDuplicateTagWarning('SHARED'),
  ]);
  assert.deepEqual(
    harnessed.database.calls.lines
      .flat()
      .filter((line) => line.kind === 'change')
      .map((line) => [line.deviceId, line.field, line.newValue]),
    [['dev-b', 'annotatedAssetId', 'SHARED']],
  );
});

test('a row that only warns needs no change', async () => {
  const text = csvText([
    cellsOf({
      deviceId: 'dev-a',
      status: 'INACTIVE',
      orgUnitPath: '/Schools/North',
    }),
  ]);
  const harnessed = harness({ text, devices: [device('dev-a')] });

  const answer = await harnessed.run();

  assert.equal(answer.outcome, 'completed');
  assert.equal(answer.counts.noChangeNeeded, 1);
  assert.equal(answer.counts.proposed, 0);
  assert.equal(answer.plan, null);
});

test('a field value past its limit rejects its row', async () => {
  const long = 'n'.repeat(4097);
  const text = csvText([
    cellsOf({ deviceId: 'dev-a', notes: long, orgUnitPath: '/Schools/North' }),
  ]);
  const harnessed = harness({ text, devices: [device('dev-a')] });

  const answer = await harnessed.run();

  assert.equal(answer.outcome, 'completed');
  assert.equal(answer.counts.rejected, 1);
  assert.match(
    harnessed.database.calls.lines.flat()[0].reason,
    /Notes holds 1 to 500 characters\./,
  );
});

test('the dispatch route answers one validation request', async () => {
  const answers = [];
  const google = {
    async importDevices(input) {
      answers.push(input);
      return {
        outcome: 'completed',
        displayId: 'IMP-001',
        status: 'completed-with-errors',
        counts: {
          rows: 2,
          unchanged: 0,
          noChangeNeeded: 0,
          proposed: 1,
          rejected: 1,
          candidateRows: 2,
          staleDevicesRead: 1,
          oldestObservedAt: null,
        },
        plan: null,
      };
    },
  };
  const response = recorded();
  const handled = await handleDeviceImportDispatch(
    inbound({ executionId: 'exec-1', ...request }),
    response,
    { secret, signal },
    google,
  );

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  // The route answers the job outcome and the stored status of a completed job.
  assert.equal(response.payload.outcome, 'completed');
  assert.equal(response.payload.status, 'completed-with-errors');
  assert.equal(response.payload.executionId, 'exec-1');
  assert.equal(response.payload.correlationId, correlationId);
  assert.equal(response.payload.displayId, 'IMP-001');
  assert.deepEqual(answers, [request]);
});

test('the dispatch route retries a store failure and refuses a bad payload', async () => {
  const unavailable = recorded();
  await handleDeviceImportDispatch(
    inbound({ executionId: 'exec-1', ...request }),
    unavailable,
    { secret, signal },
    {
      async importDevices() {
        throw new Error('artifact-store-failed');
      },
    },
  );
  assert.equal(unavailable.statusCode, 503);
  assert.deepEqual(unavailable.payload, { error: 'device-import-unavailable' });

  const invalid = recorded();
  await handleDeviceImportDispatch(
    inbound({ ...request, leaseId: 'not-a-uuid' }),
    invalid,
    { secret, signal },
    {
      async importDevices() {
        return { outcome: 'done' };
      },
    },
  );
  assert.equal(invalid.statusCode, 400);
  assert.deepEqual(invalid.payload, { error: 'invalid-payload' });

  const unauthorized = recorded();
  await handleDeviceImportDispatch(
    inbound({ executionId: 'exec-1', ...request }, 'Bearer ' + 'x'.repeat(32)),
    unauthorized,
    { secret, signal },
    {
      async importDevices() {
        return { outcome: 'done' };
      },
    },
  );
  assert.equal(unauthorized.statusCode, 401);
});

/** One JSON request of the dispatch route. */
function inbound(body, authorization = `Bearer ${secret}`) {
  const stream = Readable.from([Buffer.from(JSON.stringify(body))]);
  stream.method = 'POST';
  stream.url = '/dispatch/device-import';
  stream.headers = {
    authorization,
    'content-type': 'application/json',
  };
  return stream;
}

/** One recorded answer of the dispatch route. */
function recorded() {
  return {
    statusCode: 0,
    payload: null,
    writeHead(statusCode) {
      this.statusCode = statusCode;
    },
    end(text) {
      this.payload = JSON.parse(text);
    },
  };
}

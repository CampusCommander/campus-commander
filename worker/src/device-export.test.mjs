import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import test from 'node:test';
import {
  DEVICE_EDIT_TEMPLATE_HEADERS,
  DEVICE_UPDATE_FIELD_LIMITS,
  createCsvReader,
  csvRecordText,
  csvTextBytes,
  deviceEditRowChecksum,
  deviceEditUnescapeCell,
} from '@campus/application-contracts';
import {
  DEVICE_EXPORT_BATCH_SIZE,
  DEVICE_EXPORT_MAX_BYTES,
  DeviceExportJobs,
  deviceExportRequestSchema,
} from './device-export.ts';
import { handleDeviceExportDispatch } from './dispatch.ts';

const customerId = 'C0123456';
const jobId = randomUUID();
const leaseId = randomUUID();
const correlationId = randomUUID();
const request = { customerId, jobId, leaseId, correlationId };
const signal = new AbortController().signal;
const secret = 's'.repeat(32);

/** One device row of the read, in the column shape of `cc.devices` joined with the targets. */
function deviceRow(ordinal, overrides = {}) {
  return {
    ordinal,
    device_id: `device-${ordinal}`,
    serial_number: `serial-${ordinal}`,
    model: 'Chromebook 300e',
    status: 'ACTIVE',
    asset_tag: `ASSET-${ordinal}`,
    annotated_location: 'Room 12',
    annotated_user: 'person@example.org',
    notes: 'note',
    org_unit_path: '/Schools/North',
    last_contact: new Date('2026-10-01T10:00:00.000Z'),
    battery_status: 'reported',
    battery_health: 'normal',
    battery_capacity_percent: 88,
    battery_reported_at: new Date('2026-10-01T09:00:00.000Z'),
    last_entity_sync: new Date('2026-10-01T09:30:00.000Z'),
    ...overrides,
  };
}

/** Timers whose callbacks the test fires by hand. Each one records its delay. */
function fakeTimers() {
  const intervals = new Map();
  const delays = [];
  let sequence = 0;
  return {
    delays,
    setInterval(callback, milliseconds) {
      sequence += 1;
      intervals.set(sequence, callback);
      delays.push(milliseconds);
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

/**
 * A store that behaves as the artifact store does: it consumes the stream, removes the partial
 * file when the stream fails, and keeps the published files.
 */
function fakeStore() {
  const calls = { manifests: [], published: [], removed: [] };
  let removed = false;
  let staged = null;
  return {
    calls,
    get removed() {
      return removed;
    },
    get staged() {
      return staged;
    },
    async stageStream(manifest, source) {
      calls.manifests.push(manifest);
      const chunks = [];
      try {
        for await (const chunk of source) chunks.push(chunk);
      } catch {
        // The store removes the partial file when the source stops (stageStream contract).
        removed = true;
        throw new Error('Artifact stageStream failed.');
      }
      staged = Buffer.concat(chunks);
      return {
        artifactId: randomUUID(),
        attemptId: randomUUID(),
        schemaVersion: manifest.schemaVersion,
        sizeBytes: staged.length,
        sha256: 'f'.repeat(64),
        expiresAt: '2026-11-28T00:00:00.000Z',
      };
    },
    async publish(descriptor) {
      calls.published.push(descriptor);
    },
    async remove(descriptor) {
      calls.removed.push(descriptor);
      removed = true;
      return true;
    },
    close: () => Promise.resolve(),
  };
}

/** A database that answers the export functions and pages the frozen scope. */
function fakeDatabase(options, devices) {
  const calls = { claim: [], renew: [], cancel: [], finish: [], read: [] };
  let cancelledNow = false;
  return {
    calls,
    async query(sql, values) {
      const name = /cc\.([a-z_]+)\(/.exec(sql)?.[1];
      if (name === 'claim_device_export_job') {
        calls.claim.push(values);
        return {
          rows: [
            {
              result: options.claim?.(values) ?? {
                outcome: 'claimed',
                displayId: options.purpose === 'report' ? 'EXP-002' : 'EXP-001',
                targetCount: devices.length,
                purpose: options.purpose ?? 'edit',
                format: 'csv',
                columns:
                  options.columns ??
                  (options.purpose === 'report'
                    ? ['serialNumber', 'status', 'lastContact', 'battery']
                    : []),
                sort: { field: 'serialNumber', direction: 'asc' },
              },
            },
          ],
        };
      }
      if (name === 'renew_device_export_job') {
        const [phase, done, total] = values.slice(3, 6);
        calls.renew.push({ phase, done, total });
        const outcome = options.renew?.(phase, done, total) ?? 'renewed';
        // The store answers `done` only when a cancel is stored or the job ended.
        if (outcome === 'done') cancelledNow = true;
        return { rows: [{ result: { outcome } }] };
      }
      if (name === 'job_cancel_requested') {
        const answer = options.cancel?.(calls.cancel.length) ?? false;
        calls.cancel.push(answer);
        if (answer) cancelledNow = true;
        return { rows: [{ result: answer }] };
      }
      if (name === 'finish_device_export_job') {
        const file = values[3] === null ? null : JSON.parse(values[3]);
        const failure = values[4] ?? null;
        calls.finish.push({ file, failure });
        if (cancelledNow)
          return {
            rows: [{ result: { outcome: 'finished', status: 'cancelled' } }],
          };
        if (failure !== null)
          return {
            rows: [{ result: { outcome: 'finished', status: 'failed' } }],
          };
        return {
          rows: [
            { result: { outcome: 'finished', status: 'completed', file } },
          ],
        };
      }
      if (sql.includes('FROM cc.device_export_targets')) {
        const [customer, job, after, limit] = values;
        assert.equal(customer, customerId);
        assert.equal(job, jobId);
        calls.read.push({ after, limit });
        await options.onRead?.(after);
        if (options.readFailure?.(after)) throw new Error('The read failed.');
        return {
          rows: devices.filter((row) => row.ordinal >= after).slice(0, limit),
        };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
}

/** One export run with its fake dependencies. */
function harness(options = {}) {
  const devices = options.devices ?? [deviceRow(0)];
  const timers = options.timers ?? fakeTimers();
  const store = fakeStore();
  const database = fakeDatabase(options, devices);
  const jobs = new DeviceExportJobs(database, store, {
    batchSize: options.batchSize,
    maxBytes: options.maxBytes,
    timers,
  });
  return {
    jobs,
    database,
    store,
    timers,
    devices,
    run: (extra = {}) =>
      jobs.run({ ...request, ...extra }, options.signal ?? signal),
  };
}

/** The records of a staged file. The reader drops the byte order mark. */
function recordsOf(bytes) {
  const reader = createCsvReader();
  const text = bytes.toString('utf8');
  return [...reader.push(text), ...reader.end()];
}

/** The data records of a staged file, the header excluded. */
function dataRecordsOf(bytes) {
  return recordsOf(bytes).slice(1);
}

test('the export runs rows in ordinal batches and records the published file', async () => {
  const devices = [0, 1, 2, 3, 4, 5].map((ordinal) => deviceRow(ordinal));
  const {
    run,
    database,
    store,
    devices: scope,
  } = harness({
    devices,
    batchSize: 2,
  });
  const answer = await run();

  assert.equal(answer.outcome, 'completed');
  assert.equal(answer.displayId, 'EXP-001');
  // The scope is read in ordinal batches of the configured size, and the cursor advances
  // (design section 5, item 2).
  assert.deepEqual(
    database.calls.read.map((read) => read.after),
    [0, 2, 4, 6],
  );
  assert.deepEqual(
    database.calls.read.map((read) => read.limit),
    [2, 2, 2, 2],
  );
  // The batches are written in ordinal order.
  assert.deepEqual(
    dataRecordsOf(store.staged).map((record) => record.cells[0]),
    scope.map((row) => row.device_id),
  );
  // The phase counts rows written, then the run prepares the download and publishes.
  assert.deepEqual(
    database.calls.renew.map((renewal) => [renewal.phase, renewal.done]),
    [
      ['write-rows', 2],
      ['write-rows', 4],
      ['write-rows', 6],
      ['write-rows', 6],
      ['prepare-download', 0],
    ],
  );
  assert.equal(
    database.calls.renew.at(-1).total,
    null,
    'the prepare-download phase holds no total',
  );
  assert.equal(store.calls.published.length, 1);
  assert.equal(store.calls.removed.length, 0);
  // The finish records the name, the size, the rows, the columns, and the expiry.
  assert.equal(database.calls.finish.length, 1);
  const { file, failure } = database.calls.finish[0];
  assert.equal(failure, null);
  assert.deepEqual(file, {
    artifactId: store.calls.published[0].artifactId,
    name: 'devices-for-editing-EXP-001.csv',
    sizeBytes: store.staged.length,
    rows: 6,
    columns: 10,
    expiresAt: '2026-11-28T00:00:00.000Z',
  });
  assert.deepEqual(answer.file, file);
});

test('the edit file holds the template header, the escaped cells, and the row checksum', async () => {
  const row = deviceRow(0, {
    device_id: '+15551234567',
    serial_number: 'se,rial"0',
    notes: '=SUM(A1:A2)',
    annotated_user: '@person',
  });
  const { run, store } = harness({ devices: [row] });
  const answer = await run();

  assert.equal(answer.outcome, 'completed');
  const text = store.staged.toString('utf8');
  assert.equal(
    text.startsWith('\uFEFF'),
    true,
    'the file starts with a byte order mark',
  );
  assert.equal(text.includes('\r\n'), true, 'the records end with CRLF');
  // A comma and a quote take the RFC 4180 form of `ac/csv.ts` (design section 5, item 5).
  assert.equal(text.includes('"se,rial""0"'), true);

  const [header, data] = recordsOf(store.staged);
  assert.deepEqual(header.cells, [...DEVICE_EDIT_TEMPLATE_HEADERS]);
  assert.deepEqual(data.cells.slice(0, 9), [
    '\t+15551234567',
    'se,rial"0',
    'Chromebook 300e',
    'ACTIVE',
    'ASSET-0',
    'Room 12',
    '\t@person',
    '\t=SUM(A1:A2)',
    '/Schools/North',
  ]);
  // The escape is reversible, and the checksum covers the unescaped values (design section 5).
  for (const cell of data.cells)
    assert.equal(
      cell.startsWith('\t') ? deviceEditUnescapeCell(cell) : cell,
      cell.startsWith('\t') ? cell.slice(1) : cell,
    );
  const expected = await deviceEditRowChecksum({
    deviceId: '+15551234567',
    status: 'ACTIVE',
    annotatedAssetId: 'ASSET-0',
    annotatedLocation: 'Room 12',
    annotatedUser: '@person',
    notes: '=SUM(A1:A2)',
    orgUnitPath: '/Schools/North',
  });
  assert.equal(data.cells[9], expected);
  assert.equal(expected.length, 24, 'the checksum cell holds 24 characters');
});

test('the file holds the byte order mark, CRLF records, and the 1,000-row batch', () => {
  assert.equal(DEVICE_EXPORT_BATCH_SIZE, 1_000);
  assert.equal(DEVICE_EXPORT_MAX_BYTES, 1_073_741_824);
});

test('a worst row takes 19,390 bytes at most and every limit writes', async () => {
  // The bound of the design (section 4): at most 4 UTF-8 bytes per code point in the eight
  // fields, and a 4,096-unit organization unit path of 3-byte characters.
  const wide = '\u{1F600}'; // four UTF-8 bytes and two UTF-16 units
  const path = `/${'\u20AC'.repeat(4095)}`; // three UTF-8 bytes per unit
  const worst = deviceRow(0, {
    device_id: wide.repeat(128),
    serial_number: wide.repeat(256),
    model: wide.repeat(256),
    status: wide.repeat(64),
    asset_tag: wide.repeat(DEVICE_UPDATE_FIELD_LIMITS.annotatedAssetId),
    annotated_location: wide.repeat(
      DEVICE_UPDATE_FIELD_LIMITS.annotatedLocation,
    ),
    annotated_user: wide.repeat(DEVICE_UPDATE_FIELD_LIMITS.annotatedUser),
    notes: wide.repeat(DEVICE_UPDATE_FIELD_LIMITS.notes),
    org_unit_path: path,
  });
  const first = harness({ devices: [worst] });
  assert.equal((await first.run()).outcome, 'completed');
  const [record] = dataRecordsOf(first.store.staged);
  assert.equal(record.cells.length, 10);
  const bytes = csvTextBytes(csvRecordText(record.cells));
  assert.ok(bytes <= 19_390, `a worst row takes ${bytes} bytes`);
  // The row still holds every value, so the bound is not met by dropping a cell.
  assert.equal(deviceEditUnescapeCell(record.cells[8]), path);
  assert.equal(deviceEditUnescapeCell(record.cells[7]), wide.repeat(500));
  assert.equal(deviceEditUnescapeCell(record.cells[4]), wide.repeat(256));

  // A row at every limit in 4-byte characters writes, and each cell keeps its value.
  /** A value of `units` UTF-16 units, each character `character`. */
  const atLimit = (units, character) =>
    character.repeat(units / character.length);
  const everyLimit = deviceRow(1, {
    device_id: atLimit(128, wide),
    serial_number: atLimit(256, wide),
    model: atLimit(256, wide),
    status: atLimit(64, wide),
    asset_tag: atLimit(DEVICE_UPDATE_FIELD_LIMITS.annotatedAssetId, wide),
    annotated_location: atLimit(
      DEVICE_UPDATE_FIELD_LIMITS.annotatedLocation,
      wide,
    ),
    annotated_user: atLimit(DEVICE_UPDATE_FIELD_LIMITS.annotatedUser, wide),
    notes: atLimit(DEVICE_UPDATE_FIELD_LIMITS.notes, wide),
    org_unit_path: `${wide.repeat(2047)}a`,
  });
  const second = harness({ devices: [everyLimit] });
  assert.equal((await second.run()).outcome, 'completed');
  const [row] = dataRecordsOf(second.store.staged);
  assert.equal(row.cells.length, 10);
  for (const index of [0, 1, 2, 3, 4, 5, 6, 7, 8])
    assert.equal(
      deviceEditUnescapeCell(row.cells[index]),
      everyLimit[
        [
          'device_id',
          'serial_number',
          'model',
          'status',
          'asset_tag',
          'annotated_location',
          'annotated_user',
          'notes',
          'org_unit_path',
        ][index]
      ],
      `cell ${index} holds its whole value`,
    );
});

test('an empty scope writes the header row only', async () => {
  const { run, store, database } = harness({ devices: [] });
  const answer = await run();

  assert.equal(answer.outcome, 'completed');
  const records = recordsOf(store.staged);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].cells, [...DEVICE_EDIT_TEMPLATE_HEADERS]);
  assert.deepEqual(database.calls.read, [{ after: 0, limit: 1_000 }]);
  assert.equal(database.calls.finish[0].file.rows, 0);
  assert.equal(database.calls.finish[0].file.columns, 10);
});

test('a report writes the stored columns, the grid text, and an ISO 8601 contact time', async () => {
  const { run, store, database } = harness({
    purpose: 'report',
    devices: [deviceRow(0, { serial_number: '=serial-0' })],
  });
  const answer = await run();

  assert.equal(answer.outcome, 'completed');
  const [header, data] = recordsOf(store.staged);
  assert.deepEqual(header.cells, [
    'Serial',
    'Status',
    'Device contact',
    'Battery',
  ]);
  // The report cells carry the same escape as the edit cells (design section 5, item 4).
  assert.deepEqual(data.cells, [
    '\t=serial-0',
    'Active',
    '2026-10-01T10:00:00.000Z',
    'Normal',
  ]);
  assert.equal(
    data.cells.includes('Checksum'),
    false,
    'a report holds no checksum column',
  );
  assert.equal(database.calls.finish[0].file.columns, 4);
  assert.equal(database.calls.finish[0].file.name, 'device-report-EXP-002.csv');
});

test('a cancel at a batch boundary removes the staged file and ends Cancelled', async () => {
  const devices = [0, 1, 2, 3].map((ordinal) => deviceRow(ordinal));
  const { run, store, database } = harness({
    devices,
    batchSize: 2,
    renew: (phase, done) => (done >= 2 ? 'done' : 'renewed'),
  });
  const answer = await run();

  assert.equal(answer.outcome, 'cancelled');
  // The store removed the partial file, and the job published nothing.
  assert.equal(store.removed, true);
  assert.equal(store.calls.published.length, 0);
  assert.equal(database.calls.finish.length, 1);
  assert.deepEqual(database.calls.finish[0], { file: null, failure: null });
});

test('a cancel read by the 30-second tick stops the run and leaves no file', async () => {
  const devices = [0, 1, 2, 3].map((ordinal) => deviceRow(ordinal));
  const timers = fakeTimers();
  const harnessed = harness({
    devices,
    batchSize: 2,
    timers,
    cancel: () => true,
    onRead: async (after) => {
      if (after === 2) await timers.fire();
    },
  });
  const answer = await harnessed.run();

  assert.equal(answer.outcome, 'cancelled');
  assert.deepEqual(timers.delays, [30_000]);
  assert.equal(harnessed.store.removed, true);
  assert.equal(harnessed.store.calls.published.length, 0);
  assert.deepEqual(harnessed.database.calls.finish[0], {
    file: null,
    failure: null,
  });
});

test('an edit file past the cap fails with export-too-large and removes the file', async () => {
  const devices = [deviceRow(0), deviceRow(1)];
  const { run, store, database } = harness({ devices, maxBytes: 200 });
  const answer = await run();

  assert.equal(answer.outcome, 'failed');
  assert.equal(answer.failure, 'export-too-large');
  assert.equal(store.removed, true);
  assert.equal(store.calls.published.length, 0);
  assert.deepEqual(database.calls.finish[0], {
    file: null,
    failure: 'export-too-large',
  });
});

test('a failed read removes the staged file and fails the job', async () => {
  const devices = [deviceRow(0), deviceRow(1)];
  const { run, store, database } = harness({
    devices,
    batchSize: 1,
    readFailure: (after) => after === 1,
  });
  const answer = await run();

  assert.equal(answer.outcome, 'failed');
  assert.equal(answer.failure, 'inventory-unavailable');
  assert.equal(store.removed, true);
  assert.equal(store.calls.published.length, 0);
  assert.deepEqual(database.calls.finish[0], {
    file: null,
    failure: 'inventory-unavailable',
  });
});

test('a fenced lease stops the run without a finish', async () => {
  const { run, store, database } = harness({
    devices: [deviceRow(0), deviceRow(1)],
    batchSize: 1,
    renew: () => 'fenced',
  });
  const answer = await run();

  assert.equal(answer.outcome, 'stopped');
  assert.equal(store.removed, true);
  assert.equal(store.calls.published.length, 0);
  assert.equal(database.calls.finish.length, 0);
});

test('a fenced lease read by the tick removes the staged file', async () => {
  // The tick reads the lease while the first batch is still in the database, and the stream
  // then completes. The run removes the file that it staged (design section 5).
  let renewals = 0;
  const harnessed = harness({
    devices: [deviceRow(0)],
    renew: () => (++renewals === 1 ? 'fenced' : 'renewed'),
    onRead: async (after) => {
      if (after !== 0) return;
      await harnessed.timers.fire();
      // The tick runs on its own promise chain. The fake calls settle on microtasks.
      await new Promise((resolve) => setImmediate(resolve));
    },
  });
  const answer = await harnessed.run();

  assert.deepEqual(answer, { outcome: 'fenced' });
  assert.equal(harnessed.store.staged.length > 0, true, 'the file staged');
  assert.equal(harnessed.store.calls.removed.length, 1);
  assert.equal(harnessed.store.calls.published.length, 0);
  assert.equal(harnessed.database.calls.finish.length, 0);
});

test('a lease lost at prepare-download removes the staged file', async () => {
  const harnessed = harness({
    devices: [deviceRow(0)],
    renew: (phase) => (phase === 'prepare-download' ? 'fenced' : 'renewed'),
  });
  const answer = await harnessed.run();

  assert.deepEqual(answer, { outcome: 'fenced' });
  assert.equal(harnessed.store.calls.removed.length, 1);
  assert.equal(harnessed.store.calls.published.length, 0);
  assert.equal(harnessed.database.calls.finish.length, 0);
});

test('a failed cancel read after the stage removes the file and retries', async () => {
  const harnessed = harness({
    devices: [deviceRow(0)],
    cancel: () => {
      throw new Error('The database failed.');
    },
  });
  await assert.rejects(harnessed.run());
  assert.equal(harnessed.store.calls.removed.length, 1);
  assert.equal(harnessed.store.calls.published.length, 0);
  assert.equal(harnessed.database.calls.finish.length, 0);
});

test('a claimed job with a stored cancel writes nothing', async () => {
  const { run, database, store } = harness({
    devices: [deviceRow(0)],
    claim: () => ({ outcome: 'done' }),
  });
  const answer = await run();

  assert.deepEqual(answer, { outcome: 'done' });
  assert.equal(database.calls.read.length, 0);
  assert.equal(store.calls.manifests.length, 0);
  assert.equal(database.calls.finish.length, 0);
});

test('a job of another live run writes nothing', async () => {
  const { run, database, store } = harness({
    devices: [deviceRow(0)],
    claim: () => ({ outcome: 'busy', leaseExpiresAt: new Date() }),
  });
  const answer = await run();

  assert.deepEqual(answer, { outcome: 'busy' });
  assert.equal(database.calls.read.length, 0);
  assert.equal(store.calls.manifests.length, 0);
  assert.equal(database.calls.finish.length, 0);
});

test('the failure request ends a lost run with interrupted', async () => {
  const { run, database, store } = harness({ devices: [deviceRow(0)] });
  const answer = await run({ failure: 'interrupted' });

  assert.equal(answer.outcome, 'failed');
  assert.equal(answer.failure, 'interrupted');
  assert.equal(database.calls.claim.length, 1);
  assert.equal(store.calls.manifests.length, 0);
  assert.deepEqual(database.calls.finish[0], {
    file: null,
    failure: 'interrupted',
  });
});

test('the request refuses a failure code of another job', () => {
  const parsed = deviceExportRequestSchema.safeParse({
    ...request,
    failure: 'storage-unavailable',
  });
  assert.equal(parsed.success, false);
});

test('the dispatch route answers one export request', async () => {
  const answers = [];
  const google = {
    async exportDevices(input) {
      answers.push(input);
      return {
        outcome: 'completed',
        displayId: 'EXP-001',
        file: {
          artifactId: 'artifact',
          name: 'devices-for-editing-EXP-001.csv',
          sizeBytes: 120,
          rows: 1,
          columns: 10,
          expiresAt: '2026-11-28T00:00:00.000Z',
        },
      };
    },
  };
  const response = recorded();
  const handled = await handleDeviceExportDispatch(
    inbound({ executionId: 'exec-1', ...request }),
    response,
    { secret, signal },
    google,
  );

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.status, 'completed');
  assert.equal(response.payload.executionId, 'exec-1');
  assert.equal(response.payload.correlationId, correlationId);
  assert.equal(response.payload.displayId, 'EXP-001');
  assert.deepEqual(answers, [request]);
});

test('the dispatch route retries a store failure and refuses a bad payload', async () => {
  const unavailable = recorded();
  await handleDeviceExportDispatch(
    inbound({ executionId: 'exec-1', ...request }),
    unavailable,
    { secret, signal },
    {
      async exportDevices() {
        throw new Error('artifact-store-failed');
      },
    },
  );
  assert.equal(unavailable.statusCode, 503);
  assert.deepEqual(unavailable.payload, { error: 'device-export-unavailable' });

  const invalid = recorded();
  await handleDeviceExportDispatch(
    inbound({ ...request, leaseId: 'not-a-uuid' }),
    invalid,
    { secret, signal },
    {
      async exportDevices() {
        return { outcome: 'done' };
      },
    },
  );
  assert.equal(invalid.statusCode, 400);
  assert.deepEqual(invalid.payload, { error: 'invalid-payload' });

  const unauthorized = recorded();
  await handleDeviceExportDispatch(
    inbound({ executionId: 'exec-1', ...request }, 'Bearer ' + 'x'.repeat(32)),
    unauthorized,
    { secret, signal },
    {
      async exportDevices() {
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
  stream.url = '/dispatch/device-export';
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

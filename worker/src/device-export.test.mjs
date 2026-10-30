import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import test from 'node:test';
import { GoogleDriveClient } from '@campus/google-connection';
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
import {
  fakeDrive,
  googleError,
} from '../../libs/google-connection/src/lib/drive-fake.mjs';

const customerId = 'C0123456';
const jobId = randomUUID();
const leaseId = randomUUID();
const correlationId = randomUUID();
/** The connection credential of a Sheet job (design section 4). */
const credentialId = randomUUID();
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
 * file when the stream fails, reads a published file only, and keeps the published files.
 */
function fakeStore(options = {}) {
  const calls = { manifests: [], published: [], removed: [], opened: [] };
  /** The files of the store, by artifact ID: their state and their bytes. */
  const files = new Map();
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
      const descriptor = {
        artifactId: randomUUID(),
        attemptId: randomUUID(),
        schemaVersion: manifest.schemaVersion,
        sizeBytes: staged.length,
        sha256: 'f'.repeat(64),
        expiresAt: '2026-11-28T00:00:00.000Z',
      };
      files.set(descriptor.artifactId, { state: 'staging', bytes: staged });
      return descriptor;
    },
    async publish(descriptor) {
      calls.published.push(descriptor);
      const file = files.get(descriptor.artifactId);
      // The store verifies the whole file and syncs the filesystem before it answers.
      await options.onPublish?.(descriptor);
      if (file === undefined || file.state !== 'staging')
        throw new Error('Artifact cannot be published.');
      file.state = 'ready';
    },
    async *openRead(artifactId) {
      calls.opened.push(artifactId);
      const file = files.get(artifactId);
      // The store reads a ready file only.
      if (file === undefined || file.state !== 'ready')
        throw new Error('Artifact is not ready.');
      await options.onOpenRead?.(artifactId);
      // Small chunks split multi-byte characters and record ends, as a file read does.
      for (let index = 0; index < file.bytes.length; index += 7)
        yield file.bytes.subarray(index, index + 7);
    },
    async remove(descriptor) {
      calls.removed.push(descriptor);
      removed = true;
      const file = files.get(descriptor.artifactId);
      if (file !== undefined) file.state = 'deleted';
      return true;
    },
    close: () => Promise.resolve(),
  };
}

/** A database that answers the export functions, pages the scope, and holds the job state. */
function fakeDatabase(options, devices) {
  const calls = {
    claim: [],
    renew: [],
    cancel: [],
    finish: [],
    read: [],
    start: [],
  };
  // The stored job state that the functions change (design section 5).
  const job = {
    status: options.jobStatus ?? null,
    cancelRequested: options.cancelRequested ?? false,
    sheetStarted: options.sheetStarted ?? false,
    startedAt: null,
  };
  // The two-minute lease. A test that models the clock advances it (design section 5).
  const lease = { expiresAt: Number.POSITIVE_INFINITY, fenced: false };
  const now = options.now ?? (() => 0);
  return {
    calls,
    get status() {
      return job.status;
    },
    /** Another connection stores the cancel request (design section 5). */
    requestCancel() {
      job.cancelRequested = true;
    },
    async query(sql, values) {
      const name = /cc\.([a-z_]+)\(/.exec(sql)?.[1];
      if (name === 'claim_device_export_job') {
        calls.claim.push(values);
        if (options.claim) return { rows: [{ result: options.claim(values) }] };
        // A stored cancel request, or an ended job, answers `done` (migration 017).
        if (job.status !== null || job.cancelRequested)
          return { rows: [{ result: { outcome: 'done' } }] };
        lease.expiresAt = now() + 120_000;
        return {
          rows: [
            {
              result: {
                outcome: 'claimed',
                displayId: options.purpose === 'report' ? 'EXP-002' : 'EXP-001',
                targetCount: devices.length,
                purpose: options.purpose ?? 'edit',
                format: options.format ?? 'csv',
                driveSubject:
                  (options.format ?? 'csv') === 'sheet'
                    ? (options.subject ?? 'editor@example.org')
                    : null,
                generation: (options.format ?? 'csv') === 'sheet' ? 3 : null,
                credentialId:
                  (options.format ?? 'csv') === 'sheet' ? credentialId : null,
                envelope:
                  (options.format ?? 'csv') === 'sheet'
                    ? {
                        format: 1,
                        keyId: 'test-key-1',
                        iv: 'iv',
                        tag: 'tag',
                        ciphertext: 'ciphertext',
                      }
                    : null,
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
        let outcome;
        if (options.renew) outcome = options.renew(phase, done, total);
        else if (now() > lease.expiresAt) outcome = 'fenced';
        else if (job.status !== null || job.cancelRequested) outcome = 'done';
        else {
          lease.expiresAt = now() + 120_000;
          outcome = 'renewed';
        }
        // The store answers `done` only when a cancel is stored or the job ended.
        if (outcome === 'done') job.cancelRequested = true;
        if (outcome === 'fenced') lease.fenced = true;
        return { rows: [{ result: { outcome } }] };
      }
      if (name === 'start_device_export_sheet') {
        calls.start.push(values);
        // The stamp is the one create permission (design section 6, step 3).
        options.onStart?.();
        let result;
        if (options.start) result = options.start(values);
        else if (job.cancelRequested) result = { outcome: 'cancelled' };
        else if (lease.fenced || now() > lease.expiresAt)
          result = { outcome: 'fenced' };
        else if (job.sheetStarted)
          result = { outcome: 'repeated', startedAt: job.startedAt };
        else result = { outcome: 'started', startedAt: new Date(now()) };
        // The function stores what it answers, so a repeat reads it (migration 017).
        if (result.outcome === 'cancelled') job.status = 'cancelled';
        if (result.outcome === 'started') {
          job.sheetStarted = true;
          job.startedAt = result.startedAt;
        }
        return { rows: [{ result }] };
      }
      if (name === 'job_cancel_requested') {
        const answer = options.cancel
          ? options.cancel(calls.cancel.length)
          : job.cancelRequested;
        calls.cancel.push(answer);
        if (answer) job.cancelRequested = true;
        return { rows: [{ result: answer }] };
      }
      if (name === 'finish_device_export_job') {
        const file = values[3] === null ? null : JSON.parse(values[3]);
        const failure = values[4] ?? null;
        calls.finish.push({ file, failure });
        if (options.finish)
          return { rows: [{ result: options.finish(file, failure) }] };
        if (job.status !== null)
          return {
            rows: [{ result: { outcome: 'finished', status: job.status } }],
          };
        if (lease.fenced || now() > lease.expiresAt)
          return { rows: [{ result: { outcome: 'fenced' } }] };
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
        if (file === null)
          throw new Error('The export finish requires a file or a failure.');
        job.status = 'completed';
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
  const store = fakeStore(options);
  const database = fakeDatabase(options, devices);
  const jobs = new DeviceExportJobs(database, store, {
    batchSize: options.batchSize,
    maxBytes: options.maxBytes,
    timers,
    drive: options.drive,
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
    format: 'csv',
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

test('a claimed job with a stored cancel writes no file and finishes the cancellation', async () => {
  const { run, database, store } = harness({
    devices: [deviceRow(0)],
    cancelRequested: true,
  });
  const answer = await run();

  assert.deepEqual(answer, { outcome: 'done' });
  assert.equal(database.calls.read.length, 0);
  assert.equal(store.calls.manifests.length, 0);
  // The claim answers `done` for a stored cancel request. The finish ends the job (design
  // section 5).
  assert.deepEqual(database.calls.finish, [{ file: null, failure: null }]);
  assert.equal(database.status, 'cancelled');
});

test('a retry after a failed cancel read finishes the stored cancellation', async () => {
  let first = true;
  const harnessed = harness({
    devices: [deviceRow(0)],
    cancel: () => {
      if (!first) return true;
      first = false;
      // Another connection stores the cancel request, and then the read fails.
      harnessed.database.requestCancel();
      throw new Error('The database failed.');
    },
  });

  await assert.rejects(harnessed.run());
  assert.equal(harnessed.store.calls.removed.length, 1);
  assert.equal(harnessed.database.calls.finish.length, 0);
  assert.equal(harnessed.database.status, null);

  // The retry carries the same lease. It writes no second file and ends the cancellation.
  const answer = await harnessed.run();
  assert.deepEqual(answer, { outcome: 'done' });
  assert.equal(harnessed.store.calls.manifests.length, 1);
  assert.equal(harnessed.database.calls.read.length, 2);
  assert.deepEqual(harnessed.database.calls.finish, [
    { file: null, failure: null },
  ]);
  assert.equal(harnessed.database.status, 'cancelled');
});

test('the interrupted error request ends a stored cancellation', async () => {
  const harnessed = harness({
    devices: [deviceRow(0)],
    cancelRequested: true,
  });
  const answer = await harnessed.run({ failure: 'interrupted' });

  assert.deepEqual(answer, { outcome: 'done' });
  assert.equal(harnessed.database.calls.claim.length, 1);
  assert.equal(harnessed.store.calls.manifests.length, 0);
  assert.deepEqual(harnessed.database.calls.finish, [
    { file: null, failure: 'interrupted' },
  ]);
  assert.equal(harnessed.database.status, 'cancelled');
});

test('a retry of an ended job writes nothing and keeps its stored status', async () => {
  const harnessed = harness({
    devices: [deviceRow(0)],
    jobStatus: 'completed',
  });
  const answer = await harnessed.run();

  assert.deepEqual(answer, { outcome: 'done' });
  assert.equal(harnessed.store.calls.manifests.length, 0);
  assert.deepEqual(harnessed.database.calls.finish, [
    { file: null, failure: null },
  ]);
  assert.equal(harnessed.database.status, 'completed');
});

test('a retry without a live lease leaves the cancellation to recovery', async () => {
  const harnessed = harness({
    devices: [deviceRow(0)],
    cancelRequested: true,
    finish: () => ({ outcome: 'fenced' }),
  });
  const answer = await harnessed.run();

  assert.deepEqual(answer, { outcome: 'fenced' });
  assert.equal(harnessed.store.calls.manifests.length, 0);
  assert.equal(harnessed.database.status, null);
});

test('a cancel stored after publication removes the published file', async () => {
  const harnessed = harness({
    devices: [deviceRow(0)],
    onPublish: () => harnessed.database.requestCancel(),
  });
  const answer = await harnessed.run();

  assert.deepEqual(answer, { outcome: 'cancelled', displayId: 'EXP-001' });
  assert.equal(harnessed.store.calls.published.length, 1);
  assert.deepEqual(harnessed.store.calls.removed, [
    harnessed.store.calls.published[0],
  ]);
  assert.equal(harnessed.database.calls.finish.length, 1);
  assert.equal(harnessed.database.calls.finish[0].failure, null);
  assert.equal(harnessed.database.status, 'cancelled');
});

test('a fenced finish removes the published file', async () => {
  const harnessed = harness({
    devices: [deviceRow(0)],
    finish: () => ({ outcome: 'fenced' }),
  });
  const answer = await harnessed.run();

  assert.deepEqual(answer, { outcome: 'fenced' });
  assert.equal(harnessed.store.calls.published.length, 1);
  assert.deepEqual(harnessed.store.calls.removed, [
    harnessed.store.calls.published[0],
  ]);
});

test('a stored failed status removes the published file', async () => {
  const harnessed = harness({
    devices: [deviceRow(0)],
    finish: () => ({ outcome: 'finished', status: 'failed' }),
  });
  const answer = await harnessed.run();

  assert.equal(answer.outcome, 'failed');
  assert.equal(answer.failure, 'storage-unavailable');
  assert.equal(harnessed.store.calls.published.length, 1);
  assert.deepEqual(harnessed.store.calls.removed, [
    harnessed.store.calls.published[0],
  ]);
});

test('a failed finish keeps the published file because the commit may have landed', async () => {
  const harnessed = harness({
    devices: [deviceRow(0)],
    finish: () => {
      throw new Error('The connection failed.');
    },
  });

  await assert.rejects(harnessed.run());
  assert.equal(harnessed.store.calls.published.length, 1);
  assert.equal(harnessed.store.calls.removed.length, 0);
});

test('publication keeps the lease renewed and the export completes', async () => {
  let clock = 0;
  const timers = fakeTimers();
  const harnessed = harness({
    devices: [deviceRow(0)],
    timers,
    now: () => clock,
    // Five intervals pass while the store verifies and syncs the file. The lease would expire
    // without the renewal tick (design section 5).
    onPublish: async () => {
      for (let tick = 0; tick < 5; tick += 1) {
        clock += 30_000;
        await timers.fire();
      }
    },
  });
  const answer = await harnessed.run();

  assert.equal(answer.outcome, 'completed');
  assert.equal(
    harnessed.database.calls.renew.filter(
      (renewal) => renewal.phase === 'prepare-download',
    ).length,
    6,
    'the tick renewed five times through publication',
  );
  assert.equal(
    harnessed.timers.active,
    0,
    'the ticker closed after the finish',
  );
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

/** The Sheets answers of W1: one Sheet, its text format, and its values. */
function sheetAnswer(call) {
  if (call.method === 'POST' && call.path === '/v4/spreadsheets')
    return {
      status: 200,
      data: {
        spreadsheetId: 'example-sheet-1',
        sheets: [{ properties: { sheetId: 7 } }],
      },
    };
  if (call.path.endsWith(':batchUpdate')) return { status: 200, data: {} };
  if (call.method === 'PUT' && call.path.includes('/values/'))
    return { status: 200, data: { updatedRows: call.body.values.length } };
  throw new Error(`Unexpected Sheets call ${call.method} ${call.url}`);
}

/**
 * One Sheet export over the fake transport of the Google client (design section 9, W1). The
 * transport serves tests only.
 */
function sheetHarness(options = {}) {
  const order = [];
  const transport = fakeDrive((call, index) => {
    order.push(`sheets:${call.method} ${call.path}`);
    return options.answer
      ? options.answer(call, index)
      : sheetAnswer(call, index);
  });
  const client = new GoogleDriveClient(transport.client, signal, {
    sleep: async () => undefined,
    random: () => 0,
  });
  const harnessed = harness({
    ...options,
    format: 'sheet',
    drive: options.drive ?? (async () => client),
    onStart: () => order.push('stamp'),
  });
  return { ...harnessed, order, client, calls: transport.sent };
}

test('a Sheet export creates the Devices tab, freezes the header, and writes RAW rows', async () => {
  const devices = [
    deviceRow(0, { device_id: '+155****0000', notes: '=SUM(A1:A2)' }),
    deviceRow(1, { device_id: '-device-1', serial_number: 'serial,one' }),
  ];
  const sheet = sheetHarness({ devices });
  const answer = await sheet.run();

  assert.equal(answer.outcome, 'completed');
  // Step 1: the staged rows skip the formula tab, because RAW stores text.
  const [header, ...staged] = recordsOf(sheet.store.staged);
  assert.deepEqual(header.cells, [...DEVICE_EDIT_TEMPLATE_HEADERS]);
  assert.deepEqual(
    staged.map((record) => record.cells[0]),
    ['+155****0000', '-device-1'],
  );
  assert.equal(staged[0].cells[7], '=SUM(A1:A2)');
  // Step 4: one Sheet named for the job, with the Devices tab and its frozen header row.
  const create = sheet.calls.find(
    (call) => call.method === 'POST' && call.path === '/v4/spreadsheets',
  );
  assert.deepEqual(create.body, {
    properties: { title: 'devices-for-editing-EXP-001' },
    sheets: [
      {
        properties: {
          title: 'Devices',
          gridProperties: { frozenRowCount: 1 },
        },
      },
    ],
  });
  // Step 5: the text number format of columns A to J.
  const format = sheet.calls.find((call) => call.path.endsWith(':batchUpdate'));
  assert.deepEqual(format.body.requests, [
    {
      repeatCell: {
        range: {
          sheetId: 7,
          startRowIndex: 0,
          startColumnIndex: 0,
          endColumnIndex: 10,
        },
        cell: { userEnteredFormat: { numberFormat: { type: 'TEXT' } } },
        fields: 'userEnteredFormat.numberFormat',
      },
    },
  ]);
  // Step 6: RAW values, the header first, and the rows in ordinal order.
  const writes = sheet.calls.filter((call) => call.method === 'PUT');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].query.valueInputOption, 'RAW');
  assert.equal(writes[0].body.range, "'Devices'!A1:J3");
  assert.equal(writes[0].body.majorDimension, 'ROWS');
  assert.deepEqual(writes[0].body.values[0], [...DEVICE_EDIT_TEMPLATE_HEADERS]);
  assert.deepEqual(
    writes[0].body.values.slice(1).map((row) => row[0]),
    ['+155****0000', '-device-1'],
  );
  // The Sheet takes the value itself: no formula tab, and the CSV quoting is gone.
  assert.equal(writes[0].body.values[1][7], '=SUM(A1:A2)');
  assert.equal(writes[0].body.values[2][1], 'serial,one');
  // Step 2: the row checksum is the checksum of a CSV row.
  assert.equal(
    writes[0].body.values[1][9],
    await deviceEditRowChecksum({
      deviceId: '+155****0000',
      status: 'ACTIVE',
      annotatedAssetId: 'ASSET-0',
      annotatedLocation: 'Room 12',
      annotatedUser: 'person@example.org',
      notes: '=SUM(A1:A2)',
      orgUnitPath: '/Schools/North',
    }),
  );
  // Step 7: the finish records the Sheet facts, and the run removes the stage it read.
  assert.deepEqual(sheet.database.calls.finish, [
    {
      file: {
        format: 'sheet',
        name: 'devices-for-editing-EXP-001',
        rows: 2,
        columns: 10,
        spreadsheetId: 'example-sheet-1',
      },
      failure: null,
    },
  ]);
  assert.deepEqual(answer.file, sheet.database.calls.finish[0].file);
  // The store reads a ready file only, so the run publishes the stage, reads it once, and removes
  // it (design section 6, step 7).
  assert.equal(sheet.store.calls.published.length, 1);
  assert.deepEqual(sheet.store.calls.opened, [
    sheet.store.calls.published[0].artifactId,
  ]);
  assert.equal(sheet.store.calls.removed.length, 1);
});

test('the Sheet writes the header and 1,000 rows per call in row order', async () => {
  const devices = Array.from({ length: 1_001 }, (_, ordinal) =>
    deviceRow(ordinal),
  );
  const sheet = sheetHarness({ devices });
  const answer = await sheet.run();

  assert.equal(answer.outcome, 'completed');
  const writes = sheet.calls.filter((call) => call.method === 'PUT');
  assert.deepEqual(
    writes.map((call) => call.body.range),
    ["'Devices'!A1:J1000", "'Devices'!A1001:J1002"],
  );
  assert.deepEqual(
    writes[0].body.values.slice(1).map((row) => row[0]),
    devices.slice(0, 999).map((row) => row.device_id),
  );
  // The second chunk starts after the header, so it carries only data rows.
  assert.deepEqual(
    writes[1].body.values.map((row) => row[0]),
    devices.slice(999).map((row) => row.device_id),
  );
  assert.equal(answer.file.rows, 1_001);
});

test('the Sheet stamp precedes the first Sheets call', async () => {
  const sheet = sheetHarness({ devices: [deviceRow(0)] });
  const answer = await sheet.run();

  assert.equal(answer.outcome, 'completed');
  assert.deepEqual(sheet.order.slice(0, 2), [
    'stamp',
    'sheets:POST /v4/spreadsheets',
  ]);
});

test('an inventory edit after staging keeps the staged values in the Sheet', async () => {
  const devices = [
    deviceRow(0, { notes: 'staged note — ünïcode' }),
    deviceRow(1, { notes: 'second staged note' }),
  ];
  const sheet = sheetHarness({
    devices,
    answer: (call) => {
      // A person edits the live inventory after the rows staged and before the Sheet fills.
      if (call.method === 'POST' && call.path === '/v4/spreadsheets') {
        devices[0].notes = 'later note';
        devices[1].notes = 'later second note';
      }
      return sheetAnswer(call);
    },
  });
  const answer = await sheet.run();

  assert.equal(answer.outcome, 'completed');
  // The stage is the only inventory read: one page of two rows, then the empty page.
  assert.equal(sheet.database.calls.read.length, 2);
  const write = sheet.calls.find((call) => call.method === 'PUT');
  assert.deepEqual(
    write.body.values.slice(1).map((row) => row[7]),
    ['staged note — ünïcode', 'second staged note'],
  );
  // The checksum still covers the staged value, so a later import detects an edit against it.
  assert.equal(
    write.body.values[1][9],
    await deviceEditRowChecksum({
      deviceId: 'device-0',
      status: 'ACTIVE',
      annotatedAssetId: 'ASSET-0',
      annotatedLocation: 'Room 12',
      annotatedUser: 'person@example.org',
      notes: 'staged note — ünïcode',
      orgUnitPath: '/Schools/North',
    }),
  );
  assert.equal(answer.file.rows, 2);
  assert.equal(sheet.store.calls.removed.length, 1);
});

test('a staged cell keeps its quote and its line end in the Sheet', async () => {
  const notes = 'first "quoted" line\r\nsecond line';
  const sheet = sheetHarness({ devices: [deviceRow(0, { notes })] });
  const answer = await sheet.run();

  assert.equal(answer.outcome, 'completed');
  const write = sheet.calls.find((call) => call.method === 'PUT');
  assert.equal(write.body.values[1][7], notes);
  assert.equal(answer.file.rows, 1);
});

test('a device removed after staging still fills the staged rows', async () => {
  const devices = [deviceRow(0), deviceRow(1)];
  const sheet = sheetHarness({
    devices,
    answer: (call) => {
      // Another session removes both devices after the rows staged.
      if (call.method === 'POST' && call.path === '/v4/spreadsheets')
        devices.length = 0;
      return sheetAnswer(call);
    },
  });
  const answer = await sheet.run();

  assert.equal(answer.outcome, 'completed');
  assert.equal(sheet.database.calls.read.length, 2);
  const write = sheet.calls.find((call) => call.method === 'PUT');
  assert.deepEqual(
    write.body.values.slice(1).map((row) => row[0]),
    ['device-0', 'device-1'],
  );
  assert.equal(answer.file.rows, 2);
  assert.equal(sheet.store.calls.removed.length, 1);
});

test('a failed inventory read after staging changes no staged row', async () => {
  let failReads = false;
  const sheet = sheetHarness({
    devices: [deviceRow(0)],
    readFailure: () => failReads,
    answer: (call) => {
      // Every inventory read after the stage fails, as an unreachable database does.
      if (call.method === 'POST' && call.path === '/v4/spreadsheets')
        failReads = true;
      return sheetAnswer(call);
    },
  });
  const answer = await sheet.run();

  assert.equal(answer.outcome, 'completed');
  assert.equal(answer.file.rows, 1);
  assert.equal(sheet.database.calls.read.length, 2);
  const write = sheet.calls.find((call) => call.method === 'PUT');
  assert.deepEqual(
    write.body.values.slice(1).map((row) => row[0]),
    ['device-0'],
  );
});

test('a lost create answer fails the job without a second create', async () => {
  const sheet = sheetHarness({
    devices: [deviceRow(0)],
    answer: (call) => {
      if (call.method === 'POST' && call.path === '/v4/spreadsheets')
        return new Error('socket hang up');
      throw new Error(`Unexpected Sheets call ${call.method} ${call.url}`);
    },
  });
  const answer = await sheet.run();

  assert.equal(answer.outcome, 'failed');
  assert.equal(answer.failure, 'sheet-write-failed');
  assert.equal(
    sheet.calls.filter(
      (call) => call.method === 'POST' && call.path === '/v4/spreadsheets',
    ).length,
    1,
  );
  assert.deepEqual(sheet.database.calls.finish, [
    { file: null, failure: 'sheet-write-failed' },
  ]);
  assert.equal(sheet.store.calls.published.length, 0);
  assert.equal(sheet.store.calls.removed.length, 1);
});

test('a quota answer to values.update repeats the same range', async () => {
  let writes = 0;
  const sheet = sheetHarness({
    devices: [deviceRow(0)],
    answer: (call) => {
      if (call.method === 'PUT') {
        writes += 1;
        return writes === 1
          ? googleError(429, 'rateLimitExceeded')
          : { status: 200, data: { updatedRows: call.body.values.length } };
      }
      return sheetAnswer(call);
    },
  });
  const answer = await sheet.run();

  assert.equal(answer.outcome, 'completed');
  const ranges = sheet.calls
    .filter((call) => call.method === 'PUT')
    .map((call) => call.body.range);
  assert.deepEqual(ranges, ["'Devices'!A1:J2", "'Devices'!A1:J2"]);
});

test('a refused token fails the job drive-unavailable and creates no Sheet', async () => {
  const sheet = sheetHarness({
    devices: [deviceRow(0)],
    drive: async () => {
      throw new Error('delegation-not-authorized');
    },
  });
  const answer = await sheet.run();

  assert.equal(answer.outcome, 'failed');
  assert.equal(answer.failure, 'drive-unavailable');
  assert.equal(sheet.calls.length, 0);
  assert.deepEqual(sheet.database.calls.finish, [
    { file: null, failure: 'drive-unavailable' },
  ]);
  assert.equal(sheet.store.calls.removed.length, 1);
});

test('a cancel stored before the stamp ends Cancelled and leaves no Sheet', async () => {
  const sheet = sheetHarness({ devices: [deviceRow(0)], cancel: () => true });
  const answer = await sheet.run();

  assert.deepEqual(answer, { outcome: 'cancelled', displayId: 'EXP-001' });
  assert.equal(sheet.database.calls.start.length, 0);
  assert.equal(sheet.calls.length, 0);
  assert.equal(sheet.store.calls.published.length, 0);
  assert.equal(sheet.store.calls.removed.length, 1);
});

test('a cancel read by the stamp ends Cancelled and leaves no Sheet', async () => {
  const sheet = sheetHarness({
    devices: [deviceRow(0)],
    start: () => ({ outcome: 'cancelled' }),
  });
  const answer = await sheet.run();

  assert.deepEqual(answer, { outcome: 'cancelled', displayId: 'EXP-001' });
  assert.equal(sheet.calls.length, 0);
  assert.deepEqual(sheet.database.calls.finish, [
    { file: null, failure: null },
  ]);
  assert.equal(sheet.store.calls.removed.length, 1);
});

test('a repeated stamp creates no second Sheet', async () => {
  const sheet = sheetHarness({
    devices: [deviceRow(0)],
    sheetStarted: true,
  });
  const answer = await sheet.run();

  assert.deepEqual(answer, { outcome: 'done' });
  assert.equal(sheet.calls.length, 0);
  assert.equal(sheet.database.calls.finish.length, 0);
  assert.equal(sheet.store.calls.removed.length, 1);
});

test('a fenced stamp creates no Sheet and writes nothing', async () => {
  const sheet = sheetHarness({
    devices: [deviceRow(0)],
    start: () => ({ outcome: 'fenced' }),
  });
  const answer = await sheet.run();

  assert.deepEqual(answer, { outcome: 'fenced' });
  assert.equal(sheet.calls.length, 0);
  assert.equal(sheet.database.calls.finish.length, 0);
  assert.equal(sheet.store.calls.removed.length, 1);
});

test('an empty Sheet scope writes the header row and no data rows', async () => {
  const sheet = sheetHarness({ devices: [] });
  const answer = await sheet.run();

  assert.equal(answer.outcome, 'completed');
  const writes = sheet.calls.filter((call) => call.method === 'PUT');
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].body.values, [[...DEVICE_EDIT_TEMPLATE_HEADERS]]);
  assert.equal(answer.file.rows, 0);
});

test('the Sheet client is minted for the claimed subject and credential', async () => {
  const granted = [];
  const sheet = sheetHarness({
    devices: [deviceRow(0)],
    drive: async (access) => {
      granted.push(access);
      throw new Error('delegation-not-authorized');
    },
  });
  await sheet.run();

  // The claim carries the connection credential, and the worker mints the token for the subject of
  // the job (design section 4).
  assert.deepEqual(granted, [
    {
      customerId,
      subject: 'editor@example.org',
      credentialId,
      generation: 3,
      envelope: {
        format: 1,
        keyId: 'test-key-1',
        iv: 'iv',
        tag: 'tag',
        ciphertext: 'ciphertext',
      },
    },
  ]);
});

test('a CSV export mints no Drive client', async () => {
  let minted = 0;
  const csv = harness({
    drive: async () => {
      minted += 1;
      throw new Error('the CSV path creates no Sheet');
    },
  });
  const answer = await csv.run();

  assert.equal(answer.outcome, 'completed');
  assert.equal(answer.file.format, 'csv');
  assert.equal(minted, 0);
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

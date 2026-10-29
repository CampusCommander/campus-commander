/**
 * The refresh and the organization unit tree read against admin-sdk-mock v0.2.0 (design section 6,
 * W3). The mock answers the Directory API in process, so the real reader runs and no live Google
 * call leaves the test. The store and the database are fakes.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { startMock } from '@campuscommander/admin-sdk-mock';
import {
  GoogleDeviceReader,
  validateServiceAccount,
} from '@campus/google-connection';
import {
  DEVICE_EDIT_TEMPLATE_COLUMNS,
  DEVICE_EDIT_TEMPLATE_HEADERS,
  GOOGLE_CAPABILITIES,
  deviceImportUnitRejectionText,
} from '@campus/application-contracts';
import { DeviceImportJobs } from './device-import.ts';

/** The two reads of the validation job: the device read and the unit tree read. */
const scopes = ['device-inventory', 'school-ou-references'].map(
  (id) => GOOGLE_CAPABILITIES.find((capability) => capability.id === id).scope,
);

/** The stamp that Postgres answers before each refresh read. */
const stamp = '2026-10-29T12:00:00.000Z';
const artifactId = 'artifact-import-1';
const jobId = randomUUID();
const leaseId = randomUUID();
const correlationId = randomUUID();

let mock;
let domain;
let credential;
let reader;
let devices;
let mistypedUnit;

/** The real reader, with the order of its Google calls recorded next to the database stamps. */
function recording(events) {
  return {
    async deviceStates(...args) {
      events.push('deviceStates');
      return reader.deviceStates(...args);
    },
    async readOrgUnitTree(...args) {
      events.push('readOrgUnitTree');
      return reader.readOrgUnitTree(...args);
    },
  };
}

/** One row of ten cells, built by column key. */
function cellsOf(fields = {}) {
  const cells = DEVICE_EDIT_TEMPLATE_COLUMNS.map(() => '');
  for (const [key, value] of Object.entries(fields))
    cells[DEVICE_EDIT_TEMPLATE_COLUMNS.findIndex((column) => column.key === key)] =
      value ?? '';
  return cells;
}

/** One CSV file with its header row. */
function csvText(rows) {
  const quote = (cell) =>
    /[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
  return `${[DEVICE_EDIT_TEMPLATE_HEADERS, ...rows]
    .map((cells) => cells.map(quote).join(','))
    .join('\r\n')}\r\n`;
}

/** A store that serves the uploaded file in small chunks. */
function fakeStore(text) {
  const calls = [];
  return {
    calls,
    async *openRead(id) {
      calls.push(id);
      for (let start = 0; start < text.length; start += 7)
        yield Buffer.from(text.slice(start, start + 7), 'utf8');
    },
  };
}

/**
 * The stored inventory of the job, and a database that answers the import functions. Each refresh
 * read writes the Google observation into `stored`, as `cc.upsert_devices` does, so the compare
 * pass reads the fresh values.
 */
function fakeDatabase(stored, events) {
  const calls = { upsert: [], lines: [], finish: [], transactions: 0 };
  let lineCount = 0;
  return {
    calls,
    stored,
    get lineCount() {
      return lineCount;
    },
    async query(sql, values) {
      const name = /cc\.([a-z_]+)\(/.exec(sql)?.[1];
      if (name === 'claim_device_import_job')
        return {
          rows: [
            {
              result: {
                outcome: 'claimed',
                displayId: 'IMP-001',
                mode: 'sync-changes',
                sourceArtifactId: artifactId,
                generation: 1,
                credentialId: randomUUID(),
                envelope: { ciphertext: 'cipher' },
                statusPermissions: ['disable', 'reenable', 'deprovision'],
              },
            },
          ],
        };
      if (name === 'renew_device_import_job')
        return { rows: [{ result: { outcome: 'renewed' } }] };
      if (name === 'store_device_import_lines') {
        const lines = JSON.parse(values[3]);
        calls.lines.push(lines);
        lineCount += lines.length;
        return { rows: [{ result: { outcome: 'stored' } }] };
      }
      if (name === 'finish_device_import_job') {
        const counts = values[3] === null ? null : JSON.parse(values[3]);
        calls.finish.push({ counts, failure: values[4] ?? null });
        assert.notEqual(counts, null, 'A completed run stores its counts.');
        assert.equal(
          counts.rows,
          counts.unchanged +
            counts.noChangeNeeded +
            counts.proposed +
            counts.rejected,
          'The counts satisfy the check of the finish function.',
        );
        const status =
          counts.proposed === 0 && counts.rejected > 0
            ? 'completed-with-errors'
            : 'completed';
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
      // Postgres stamps the read time before the Google call (design section 6, step 9).
      if (sql.includes('clock_timestamp')) {
        events.push('stamp');
        return { rows: [{ result: new Date(stamp) }] };
      }
      if (name === 'upsert_devices') {
        const observed = JSON.parse(values[1]);
        calls.upsert.push({ devices: observed, syncedAt: values[2] });
        for (const entry of observed) {
          const row = stored.get(entry.deviceId);
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
        for (const deviceId of JSON.parse(values[1])) {
          const row = stored.get(deviceId);
          if (row !== undefined) row.removed_at = new Date(stamp);
        }
        return { rows: [{ result: 0 }] };
      }
      if (sql.includes('asset_tag=ANY')) return { rows: [] };
      if (sql.includes('annotated_location'))
        return {
          rows: values[1].flatMap((id) =>
            stored.has(id) ? [stored.get(id)] : [],
          ),
        };
      if (sql.includes('FROM cc.devices'))
        return {
          rows: values[1].flatMap((id) => {
            const row = stored.get(id);
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
      throw new Error(`Unexpected call: ${sql}`);
    },
    async transaction(run) {
      calls.transactions += 1;
      return run({ query: (sql, values) => this.query(sql, values) });
    },
  };
}

before(async () => {
  mock = await startMock();
  mock.useInProcess();
  domain = await mock.createDomain({ tier: 'small', seed: 'import-validation' });
  const key = mock.credential(domain.customerId, scopes);
  credential = {
    serviceAccount: validateServiceAccount(key, key.client_id),
    subject: domain.adminEmail,
  };
  reader = new GoogleDeviceReader();
  const all = [];
  for await (const page of reader.devicePages(
    credential,
    domain.customerId,
    AbortSignal.timeout(60_000),
  ))
    all.push(...page);
  assert.ok(all.length >= 3, 'The mock seeds at least three devices.');
  // The three devices of the file: a change, a mistyped unit, and a row with no change.
  devices = all.slice(0, 3);
  const tree = await reader.readOrgUnitTree(
    credential,
    domain.customerId,
    AbortSignal.timeout(60_000),
  );
  // A path that no organization unit holds (design section 6, step 13).
  mistypedUnit = '/Schools/Not-A-Real-Unit';
  assert.equal(
    tree.some((unit) => unit.orgUnitPath.toLowerCase() === mistypedUnit.toLowerCase()),
    false,
  );
});

after(async () => {
  await mock?.close();
});

test('the refresh reads the stale devices and the tree, and the compare uses the fresh values', async () => {
  const [changed, unknownUnit, unchanged] = devices;
  const text = csvText([
    cellsOf({
      deviceId: changed.deviceId,
      notes: 'Imported note',
      // Paths compare without case, so the upper case of the stored path still matches.
      orgUnitPath: changed.orgUnitPath.toUpperCase(),
    }),
    cellsOf({ deviceId: unknownUnit.deviceId, orgUnitPath: mistypedUnit }),
    cellsOf({ deviceId: unchanged.deviceId }),
  ]);
  // Every candidate device is stale, so each one is read (design section 6, step 8).
  const stored = new Map(
    devices.map((device) => [
      device.deviceId,
      {
        device_id: device.deviceId,
        status: 'ACTIVE',
        asset_tag: null,
        annotated_location: null,
        annotated_user: null,
        notes: null,
        org_unit_path: device.orgUnitPath,
        last_entity_sync: new Date('2026-01-01T00:00:00.000Z'),
        removed_at: null,
      },
    ]),
  );
  const events = [];
  const database = fakeDatabase(stored, events);
  const store = fakeStore(text);
  const jobs = new DeviceImportJobs(
    database,
    store,
    recording(events),
    { open: () => credential },
    { batchSize: 1_000 },
  );

  const answer = await jobs.run(
    { customerId: domain.customerId, jobId, leaseId, correlationId },
    AbortSignal.timeout(60_000),
  );

  // Postgres stamped the one refresh read before the Google call (design section 6, step 9).
  assert.deepEqual(
    events.filter((event) => event === 'stamp' || event === 'deviceStates'),
    ['stamp', 'deviceStates'],
  );
  // One tree read served the job (design section 6, step 13).
  assert.equal(
    events.filter((event) => event === 'readOrgUnitTree').length,
    1,
  );
  // Each pass streams the file: pass 1 checks and pass 2 compares (design section 6).
  assert.deepEqual(store.calls, [artifactId, artifactId]);
  // The read stored Google's values, not the values of the file (design section 6, step 10).
  const upserted = database.calls.upsert.flatMap((call) =>
    call.devices.map((device) => [device.deviceId, device]),
  );
  assert.deepEqual(
    upserted.map(([deviceId]) => deviceId),
    [changed.deviceId, unchanged.deviceId],
    'The mistyped unit rejects its row before any read.',
  );
  const [, observation] = upserted[0];
  assert.equal(observation.orgUnitPath, changed.orgUnitPath);
  assert.equal(observation.serialNumber, changed.serialNumber);
  assert.equal(observation.status, changed.status);
  assert.deepEqual(database.calls.upsert.map((call) => call.syncedAt), [stamp]);
  assert.equal(database.calls.transactions, 1);
  // The unit tree read accepted the stored path in another case and refused the mistyped one.
  const lines = database.calls.lines.flat();
  assert.deepEqual(
    lines
      .filter((line) => line.kind === 'rejection')
      .map((line) => [line.sourceRow, line.reason]),
    [[2, deviceImportUnitRejectionText(mistypedUnit)]],
  );
  // The change holds the value that Google answered, which only the refresh could supply.
  assert.deepEqual(
    lines
      .filter((line) => line.kind === 'change')
      .map((line) => [
        line.deviceId,
        line.field,
        line.currentValue,
        line.newValue,
      ]),
    [[changed.deviceId, 'notes', changed.notes, 'Imported note']],
  );
  assert.deepEqual(answer, {
    outcome: 'completed',
    displayId: 'IMP-001',
    status: 'completed',
    counts: {
      rows: 3,
      unchanged: 0,
      noChangeNeeded: 1,
      proposed: 1,
      rejected: 1,
      candidateRows: 3,
      staleDevicesRead: 2,
      oldestObservedAt: stamp,
    },
    plan: {
      planId: answer.plan.planId,
      revision: 1,
      state: 'open',
      expiresAt: '2026-10-29T13:00:00.000Z',
    },
  });
  assert.deepEqual(database.calls.finish.map((call) => call.counts), [
    answer.counts,
  ]);
});

test('each refresh batch keeps its own stamp before the Google call', async () => {
  const [, first, second] = devices;
  const text = csvText([
    cellsOf({ deviceId: first.deviceId }),
    cellsOf({ deviceId: second.deviceId }),
  ]);
  const stored = new Map(
    [first, second].map((device) => [
      device.deviceId,
      {
        device_id: device.deviceId,
        status: 'ACTIVE',
        asset_tag: null,
        annotated_location: null,
        annotated_user: null,
        notes: null,
        org_unit_path: device.orgUnitPath,
        last_entity_sync: new Date('2026-01-01T00:00:00.000Z'),
        removed_at: null,
      },
    ]),
  );
  const events = [];
  const database = fakeDatabase(stored, events);
  // One device per batch, so the job reads Google twice and stamps each read.
  const jobs = new DeviceImportJobs(
    database,
    fakeStore(text),
    recording(events),
    { open: () => credential },
    { batchSize: 1 },
  );

  const answer = await jobs.run(
    { customerId: domain.customerId, jobId, leaseId, correlationId },
    AbortSignal.timeout(60_000),
  );

  assert.deepEqual(events, [
    'stamp',
    'deviceStates',
    'stamp',
    'deviceStates',
  ]);
  assert.deepEqual(
    database.calls.upsert.map((call) =>
      call.devices.map((device) => device.deviceId),
    ),
    [[first.deviceId], [second.deviceId]],
  );
  assert.deepEqual(database.calls.upsert.map((call) => call.syncedAt), [
    stamp,
    stamp,
  ]);
  assert.equal(answer.outcome, 'completed');
  assert.equal(answer.counts.noChangeNeeded, 2);
  assert.equal(answer.counts.proposed, 0);
  assert.equal(answer.counts.staleDevicesRead, 2);
  assert.equal(answer.status, 'completed');
  assert.equal(database.calls.transactions, 2);
});
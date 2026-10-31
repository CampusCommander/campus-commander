/**
 * The worker reads against admin-sdk-mock 0.3.0 (design section 9, W3). The refresh and the
 * organization unit tree read answer through the Directory API; a Sheet export, a tab read, and a
 * Drive CSV read answer through the Drive and Sheets APIs. The mock runs in process, so the real
 * clients run and no live Google call leaves the test. The store and the database are fakes.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { startMock } from '@campuscommander/admin-sdk-mock';
import {
  GoogleDeviceReader,
  personDriveClient,
  validateServiceAccount,
} from '@campus/google-connection';
import {
  DEVICE_EDIT_TEMPLATE_COLUMNS,
  DEVICE_EDIT_TEMPLATE_HEADERS,
  GOOGLE_CAPABILITIES,
  deviceImportUnitRejectionText,
} from '@campus/application-contracts';
import { DeviceExportJobs } from './device-export.ts';
import { DeviceImportJobs } from './device-import.ts';

/**
 * The Google reads of the file: the device read, the unit tree read, and the person's Drive token
 * (design sections 4 and 7).
 */
const scopes = ['device-inventory', 'school-ou-references', 'drive-files'].map(
  (id) => GOOGLE_CAPABILITIES.find((capability) => capability.id === id).scope,
);

/** The stamp that Postgres answers before each refresh read. */
const stamp = '2026-10-29T12:00:00.000Z';
/** The deadline of one Google call in the mock tests. */
const timeout = 60_000;
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
    cells[
      DEVICE_EDIT_TEMPLATE_COLUMNS.findIndex((column) => column.key === key)
    ] = value ?? '';
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

/**
 * A store that serves the uploaded file in small chunks, and stages, publishes, and removes the
 * source of a Drive import, as `deployment/storage` does.
 */
function fakeStore(text) {
  const calls = [];
  const manifests = [];
  const published = [];
  const removed = [];
  const stages = new Map();
  let sequence = 0;
  const uploaded = Buffer.from(text ?? '', 'utf8');
  return {
    calls,
    /** The stage manifests that the job asked for. */
    manifests,
    /** The artifacts that the job published, in order. */
    published,
    /** The artifacts that the job removed, in order. */
    removed,
    /** The staged bytes of one artifact, or undefined. */
    staged(artifactId) {
      return stages.get(artifactId)?.bytes;
    },
    async stageStream(manifest, source) {
      manifests.push(manifest);
      const parts = [];
      for await (const chunk of source) parts.push(Buffer.from(chunk));
      sequence += 1;
      const artifactId = `stage-${sequence}`;
      const bytes = Buffer.concat(parts);
      stages.set(artifactId, { bytes, published: false });
      return {
        artifactId,
        attemptId: `attempt-${sequence}`,
        schemaVersion: manifest.schemaVersion,
        sizeBytes: bytes.length,
        sha256: '0'.repeat(64),
        expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      };
    },
    async publish(descriptor) {
      const stage = stages.get(descriptor.artifactId);
      if (stage === undefined) throw new Error('The artifact is not staged.');
      stage.published = true;
      published.push(descriptor.artifactId);
    },
    async remove(descriptor) {
      removed.push(descriptor.artifactId);
      const stage = stages.get(descriptor.artifactId);
      // The worker removes the source after the finish; the test still inspects the bytes.
      if (stage !== undefined) stage.removed = true;
      return true;
    },
    async *openRead(id) {
      calls.push(id);
      const stage = stages.get(id);
      // The store reads a published artifact only (design section 4).
      if (stage !== undefined && !stage.published)
        throw new Error('The artifact is not ready.');
      const bytes = stage?.bytes ?? uploaded;
      for (let start = 0; start < bytes.length; start += 7)
        yield bytes.subarray(start, start + 7);
    },
  };
}

/**
 * The stored inventory of the job, and a database that answers the import functions. Each refresh
 * read writes the Google observation into `stored`, as `cc.upsert_devices` does, so the compare
 * pass reads the fresh values. The options carry the claim of a Drive source and the stage link.
 */
function fakeDatabase(stored, events, options = {}) {
  const calls = {
    upsert: [],
    lines: [],
    finish: [],
    source: [],
    renew: [],
    transactions: 0,
  };
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
                attempt: 1,
                displayId: 'IMP-001',
                mode: 'sync-changes',
                sourceArtifactId:
                  options.sourceArtifactId === undefined
                    ? artifactId
                    : options.sourceArtifactId,
                sourceType: options.sourceType ?? 'csv',
                sourceName: options.sourceName ?? 'devices.csv',
                sourceFileId: options.sourceFileId ?? null,
                sourceTabId: options.sourceTabId ?? null,
                sourceTabTitle: options.sourceTabTitle ?? null,
                driveSubject: options.driveSubject ?? null,
                generation: 1,
                credentialId: randomUUID(),
                envelope: { ciphertext: 'cipher' },
                statusPermissions: ['disable', 'reenable', 'deprovision'],
              },
            },
          ],
        };
      if (name === 'renew_device_import_job') {
        const [attempt, phase, done, total] = values.slice(3, 7);
        calls.renew.push({ attempt, phase, done, total });
        return { rows: [{ result: { outcome: 'renewed' } }] };
      }
      if (name === 'store_device_import_source') {
        const attempt = values[3];
        const storedId = values[4];
        const sizeBytes = values[5];
        calls.source.push({ attempt, artifactId: storedId, sizeBytes });
        return {
          rows: [
            { result: { outcome: 'stored', artifactId: storedId, sizeBytes } },
          ],
        };
      }
      if (name === 'store_device_import_lines') {
        assert.equal(
          values[3],
          1,
          'The store carries the attempt of the claim.',
        );
        const lines = JSON.parse(values[4]);
        calls.lines.push(lines);
        lineCount += lines.length;
        return { rows: [{ result: { outcome: 'stored' } }] };
      }
      if (name === 'finish_device_import_job') {
        assert.equal(
          values[3],
          1,
          'The finish carries the attempt of the claim.',
        );
        const counts = values[4] === null ? null : JSON.parse(values[4]);
        calls.finish.push({ counts, failure: values[5] ?? null });
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
  domain = await mock.createDomain({
    tier: 'small',
    seed: 'import-validation',
  });
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
    tree.some(
      (unit) => unit.orgUnitPath.toLowerCase() === mistypedUnit.toLowerCase(),
    ),
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
  assert.equal(events.filter((event) => event === 'readOrgUnitTree').length, 1);
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
  assert.deepEqual(
    database.calls.upsert.map((call) => call.syncedAt),
    [stamp],
  );
  assert.equal(database.calls.transactions, 1);
  // The unit tree read accepted the stored path in another case and refused the mistyped one.
  const lines = database.calls.lines.flat();
  assert.deepEqual(
    lines
      .filter((line) => line.kind === 'rejection')
      .map((line) => [line.sourceRow, line.reason]),
    [[3, deviceImportUnitRejectionText(mistypedUnit)]],
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
  assert.deepEqual(
    database.calls.finish.map((call) => call.counts),
    [answer.counts],
  );
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

  assert.deepEqual(events, ['stamp', 'deviceStates', 'stamp', 'deviceStates']);
  assert.deepEqual(
    database.calls.upsert.map((call) =>
      call.devices.map((device) => device.deviceId),
    ),
    [[first.deviceId], [second.deviceId]],
  );
  assert.deepEqual(
    database.calls.upsert.map((call) => call.syncedAt),
    [stamp, stamp],
  );
  assert.equal(answer.outcome, 'completed');
  assert.equal(answer.counts.noChangeNeeded, 2);
  assert.equal(answer.counts.proposed, 0);
  assert.equal(answer.counts.staleDevicesRead, 2);
  assert.equal(answer.status, 'completed');
  assert.equal(database.calls.transactions, 2);
});

/** The Drive service of one call, as the person of the job (design section 4). */
function driveClient() {
  return personDriveClient(
    credential,
    domain.adminEmail,
    AbortSignal.timeout(timeout),
  );
}

/** One row of the export scope, in the shape that `cc.device_export_targets` answers. */
function exportRow(ordinal, device, overrides = {}) {
  const time = new Date(Date.now() - 3 * 3_600_000);
  return {
    ordinal,
    device_id: device.deviceId,
    serial_number: device.serialNumber,
    model: device.model,
    status: device.status,
    asset_tag: device.assetTag,
    annotated_location: device.annotatedLocation,
    annotated_user: device.annotatedUser,
    notes: device.notes,
    org_unit_path: device.orgUnitPath,
    last_contact: time,
    battery_status: 'reported',
    battery_health: 'normal',
    battery_capacity_percent: 88,
    battery_reported_at: time,
    last_entity_sync: time,
    ...overrides,
  };
}

/**
 * A database that answers the Sheet export functions (design section 6, steps 1 to 7) and pages
 * the frozen scope in ordinal order.
 */
function exportDatabase(rows) {
  const calls = {
    claim: [],
    renew: [],
    start: [],
    cancel: [],
    finish: [],
    read: [],
  };
  return {
    calls,
    async query(sql, values) {
      const name = /cc\.([a-z_]+)\(/.exec(sql)?.[1];
      if (name === 'claim_device_export_job') {
        calls.claim.push(values);
        return {
          rows: [
            {
              result: {
                outcome: 'claimed',
                displayId: 'EXP-001',
                targetCount: rows.length,
                purpose: 'edit',
                format: 'sheet',
                driveSubject: domain.adminEmail,
                generation: 1,
                credentialId: randomUUID(),
                envelope: { ciphertext: 'cipher' },
                columns: [],
                sort: { field: 'serialNumber', direction: 'asc' },
              },
            },
          ],
        };
      }
      if (name === 'renew_device_export_job') {
        calls.renew.push(values.slice(3, 6));
        return { rows: [{ result: { outcome: 'renewed' } }] };
      }
      if (name === 'start_device_export_sheet') {
        calls.start.push(values);
        return {
          rows: [{ result: { outcome: 'started', startedAt: new Date() } }],
        };
      }
      if (name === 'job_cancel_requested') {
        calls.cancel.push(values);
        return { rows: [{ result: false }] };
      }
      if (name === 'finish_device_export_job') {
        const file = values[3] === null ? null : JSON.parse(values[3]);
        const failure = values[4] ?? null;
        calls.finish.push({ file, failure });
        return {
          rows: [
            {
              result: {
                outcome: 'finished',
                status: failure === null ? 'completed' : 'failed',
              },
            },
          ],
        };
      }
      if (sql.includes('FROM cc.device_export_targets')) {
        const [customer, job, after, limit] = values;
        assert.equal(customer, domain.customerId);
        assert.equal(job, jobId);
        calls.read.push({ after, limit });
        return {
          rows: rows.filter((row) => row.ordinal >= after).slice(0, limit),
        };
      }
      throw new Error(`Unexpected call: ${sql}`);
    },
  };
}

/** One Sheet export of the data set through the mock, with its fake store and database. */
async function exportSheet(rows) {
  const subjects = [];
  const database = exportDatabase(rows);
  const store = fakeStore('');
  const jobs = new DeviceExportJobs(database, store, {
    drive: async (access, signal) => {
      subjects.push(access.subject);
      return personDriveClient(credential, access.subject, signal);
    },
  });
  const answer = await jobs.run(
    { customerId: domain.customerId, jobId, leaseId, correlationId },
    AbortSignal.timeout(timeout),
  );
  return { answer, database, store, subjects };
}

/**
 * One Drive import over one source, with the real Drive client and reader through the mock. The
 * stored devices are stale, so the refresh reads each one from the mock (design section 6, step 8).
 */
function driveImport(options) {
  const subjects = [];
  const stored = new Map(
    options.devices.map((device) => [
      device.deviceId,
      {
        device_id: device.deviceId,
        status: device.status,
        asset_tag: device.assetTag,
        annotated_location: device.annotatedLocation,
        annotated_user: device.annotatedUser,
        notes: device.notes,
        org_unit_path: device.orgUnitPath,
        last_entity_sync: new Date(0),
        removed_at: null,
      },
    ]),
  );
  const database = fakeDatabase(stored, [], {
    sourceArtifactId: null,
    sourceType: options.sourceType,
    sourceName: options.sourceName,
    sourceFileId: options.fileId,
    sourceTabId: options.tabId ?? null,
    sourceTabTitle: options.tabTitle ?? null,
    driveSubject: domain.adminEmail,
  });
  const store = fakeStore('');
  const jobs = new DeviceImportJobs(
    database,
    store,
    reader,
    { open: () => credential },
    {
      batchSize: 1_000,
      drive: (passed, subject, signal) => {
        subjects.push(subject);
        return personDriveClient(passed, subject, signal);
      },
    },
  );
  return {
    database,
    store,
    subjects,
    run: () =>
      jobs.run(
        { customerId: domain.customerId, jobId, leaseId, correlationId },
        AbortSignal.timeout(timeout),
      ),
  };
}

test('a Sheet export writes the data set to the mock Drive', async () => {
  const note = 'Imported "Drive" note, ready';
  const rows = [
    exportRow(0, devices[0], { notes: note }),
    exportRow(1, devices[1]),
    exportRow(2, devices[2]),
  ];
  const { answer, database, store, subjects } = await exportSheet(rows);

  assert.equal(answer.outcome, 'completed');
  assert.equal(answer.file.format, 'sheet');
  assert.equal(answer.file.name, 'devices-for-editing-EXP-001');
  assert.equal(answer.file.columns, DEVICE_EDIT_TEMPLATE_COLUMNS.length);
  assert.equal(answer.file.rows, rows.length);
  // The export opened one Drive client as the claim's subject (design section 6, step 4).
  assert.deepEqual(subjects, [domain.adminEmail]);
  // The one create permission ran, and the stage that the Sheet read is removed after the finish.
  assert.equal(database.calls.start.length, 1);
  assert.equal(database.calls.finish.length, 1);
  assert.equal(database.calls.finish[0].failure, null);
  assert.deepEqual(store.published, ['stage-1']);
  assert.deepEqual(store.removed, ['stage-1']);

  // The tab read answers the header and every data row of the export through the mock.
  const client = await driveClient();
  const tabs = await client.tabs(answer.file.spreadsheetId);
  assert.deepEqual(
    tabs.tabs.map((tab) => tab.title),
    ['Devices'],
  );
  const tab = await client.readTab(
    answer.file.spreadsheetId,
    tabs.tabs[0].tabId,
  );
  const written = [];
  for await (const row of tab.rows()) written.push(row);
  assert.deepEqual(written[0], [...DEVICE_EDIT_TEMPLATE_HEADERS]);
  assert.deepEqual(
    written.slice(1).map((row) => [row[0], row[7]]),
    [
      [devices[0].deviceId, note],
      [devices[1].deviceId, devices[1].notes ?? ''],
      [devices[2].deviceId, devices[2].notes ?? ''],
    ],
  );
});

test('the same data set gives one report from a Sheet and from a Drive CSV', async () => {
  const note = 'Imported "Drive" note, ready';
  const rows = [
    exportRow(0, devices[0]),
    exportRow(1, devices[1]),
    exportRow(2, devices[2]),
  ];
  const exported = await exportSheet(rows);
  assert.equal(exported.answer.outcome, 'completed');
  const spreadsheetId = exported.answer.file.spreadsheetId;

  // A person edits one cell of the exported Sheet, as the edit template invites. The checksum
  // stays the one of the export, so the row is checked in full (design section 6).
  const client = await driveClient();
  const tabs = await client.tabs(spreadsheetId);
  const tabId = tabs.tabs[0].tabId;
  const tab = await client.readTab(spreadsheetId, tabId);
  const worked = [];
  for await (const row of tab.rows()) worked.push(row);
  worked[1] = [...worked[1]];
  worked[1][7] = note;
  await mock.control(
    'PUT',
    `/domains/${domain.customerId}/drive/files/${spreadsheetId}`,
    { tabs: [{ title: tabs.tabs[0].title, rows: worked }] },
  );
  // The CSV source carries the same logical rows: the header and the edited data rows.
  const text = csvText(worked.slice(1));
  const seeded = await mock.control(
    'POST',
    `/domains/${domain.customerId}/drive/files`,
    {
      name: 'devices-for-editing-EXP-001.csv',
      mimeType: 'text/csv',
      content: text,
      owner: domain.adminEmail,
    },
  );

  const sheet = driveImport({
    devices,
    sourceType: 'drive-sheet',
    sourceName: tabs.tabs[0].title,
    fileId: spreadsheetId,
    tabId,
    tabTitle: tabs.tabs[0].title,
  });
  const sheetAnswer = await sheet.run();
  const csv = driveImport({
    devices,
    sourceType: 'drive-csv',
    sourceName: seeded.name,
    fileId: seeded.id,
  });
  const csvAnswer = await csv.run();

  assert.equal(sheetAnswer.outcome, 'completed');
  assert.equal(csvAnswer.outcome, 'completed');
  // Each source minted its Drive token for the subject of the claim (design section 4).
  assert.deepEqual(sheet.subjects, [domain.adminEmail]);
  assert.deepEqual(csv.subjects, [domain.adminEmail]);
  // Both sources read their bytes into a stage: the Sheet adds the byte order mark of an export,
  // and the CSV file keeps its own bytes (design section 7, step 5).
  assert.deepEqual(sheet.store.staged('stage-1'), Buffer.from(`\uFEFF${text}`));
  assert.deepEqual(csv.store.staged('stage-1'), Buffer.from(text));
  assert.deepEqual(
    sheet.database.calls.renew.slice(0, 3).map((call) => call.phase),
    ['drive-read', 'drive-read', 'header-check'],
  );
  // The report of the edited row through the Sheet holds the one change. The two untouched rows
  // keep the checksum of the export, so each counts unchanged and reads no device.
  assert.deepEqual(sheetAnswer.counts, {
    rows: 3,
    unchanged: 2,
    noChangeNeeded: 0,
    proposed: 1,
    rejected: 0,
    candidateRows: 1,
    staleDevicesRead: 1,
    oldestObservedAt: stamp,
  });
  assert.deepEqual(
    sheet.database.calls.lines
      .flat()
      .filter((line) => line.kind === 'change')
      .map((line) => [
        line.deviceId,
        line.field,
        line.currentValue,
        line.newValue,
      ]),
    [[devices[0].deviceId, 'notes', devices[0].notes, note]],
  );
  // One data set gives one report (td:1183).
  assert.deepEqual(csvAnswer.counts, sheetAnswer.counts);
  assert.deepEqual(csv.database.calls.lines, sheet.database.calls.lines);
  assert.deepEqual(
    csv.database.calls.finish.map((call) => call.counts),
    sheet.database.calls.finish.map((call) => call.counts),
  );
});

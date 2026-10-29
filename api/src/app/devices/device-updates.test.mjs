import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  deviceSelectionSpecSchema,
  deviceUpdatePreviewRequestSchema,
} from '@campus/application-contracts';
import { storeJsonDocument } from '../storage/json-artifact.ts';
import { authorizeAction } from '../auth/authorize-action.ts';
import {
  DeviceUpdates,
  displayNumber,
  editPreviewInput,
  editPreviewTargets,
  manifestDigest,
  previewInput,
  previewTargets,
} from './device-updates.ts';
import {
  parseIntCursor,
  previewTargetRow,
  targetCursor,
} from './device-update-rows.ts';

const customer = 'C0123456';
const actor = '11111111-1111-4111-8111-111111111111';
const key = { gridId: 'devices', tabId: 't1' };
const session = {
  identity: {
    id: actor,
    displayName: 'Test person',
    permissions: [],
    permissionVersion: 1,
    grants: [],
    preferences: {},
  },
  expiresAt: '2026-10-19T12:00:00.000Z',
  csrfToken: 'a'.repeat(64),
};
const current = {
  customerId: customer,
  generation: 1,
  status: 'ready',
  observedAt: null,
  deviceCount: 1,
  failure: null,
  telemetryFailure: null,
  startedAt: null,
  checkedAt: null,
  stale: false,
};
const device = (id, extra = {}) => ({
  device_id: id,
  serial_number: `SN-${id}`,
  org_unit_path: '/School A',
  annotated_location: null,
  annotated_user: null,
  notes: null,
  last_entity_sync: new Date().toISOString(),
  removed_at: null,
  ...extra,
});
const location = (mode, value) =>
  value === undefined
    ? { field: 'annotatedLocation', mode }
    : { field: 'annotatedLocation', mode, value };

test('the preview freezes eligible, unchanged, and excluded targets', () => {
  const targets = previewTargets(
    [
      device('d1'),
      device('d2', { annotated_location: 'Room 12' }),
      device('d3', { annotated_location: 'Room 12' }),
      device('d4', { removed_at: new Date() }),
      device('bad id!'),
    ],
    [location('replace', 'Room 12')],
  );
  assert.deepEqual(
    targets.map((target) => [target.deviceId, target.disposition]),
    [
      ['d1', 'eligible'],
      ['d2', 'unchanged'],
      ['d3', 'unchanged'],
      ['d4', 'excluded'],
      ['bad id!', 'excluded'],
    ],
  );
  assert.equal(targets[3].exclusionReason, 'removed');
  assert.equal(targets[4].exclusionReason, 'invalid-device-id');
  assert.deepEqual(
    targets[0].fields,
    [
      {
        field: 'annotatedLocation',
        requestedValue: 'Room 12',
        observedValue: null,
        baselineValue: null,
        disposition: 'eligible',
      },
    ],
    'A target holds one field row per change, with its request and its baseline.',
  );
  assert.deepEqual(
    targets[1].fields[0],
    {
      field: 'annotatedLocation',
      requestedValue: 'Room 12',
      observedValue: 'Room 12',
      baselineValue: 'Room 12',
      disposition: 'unchanged',
    },
    'A selection row stores its observed value as its baseline.',
  );
});

test('a device is eligible when one of its fields changes', () => {
  const targets = previewTargets(
    [
      device('d1', { annotated_user: 'A person', notes: 'Room 12' }),
      device('d2', { annotated_user: 'A person', notes: null }),
    ],
    [
      { field: 'annotatedUser', mode: 'replace', value: 'A person' },
      { field: 'notes', mode: 'replace', value: 'Room 12' },
    ],
  );
  assert.deepEqual(
    targets.map((target) => [
      target.deviceId,
      target.disposition,
      target.fields.map((field) => field.disposition),
    ]),
    [
      ['d1', 'unchanged', ['unchanged', 'unchanged']],
      ['d2', 'eligible', ['unchanged', 'eligible']],
    ],
  );
});

test('a path compares without case', () => {
  const targets = previewTargets(
    [device('d1', { org_unit_path: '/high school' })],
    [{ field: 'orgUnitPath', mode: 'move', value: '/High School' }],
  );
  assert.equal(targets[0].disposition, 'unchanged');
  assert.equal(targets[0].fields[0].disposition, 'unchanged');
});

test('Clear makes an empty observed value unchanged and writes a null value', () => {
  const targets = previewTargets([device('d1')], [location('clear')]);
  assert.equal(targets[0].disposition, 'unchanged');
  assert.equal(targets[0].fields[0].observedValue, null);
});

test('the version 3 digest covers each eligible row request, observation, and baseline', () => {
  // A fixed selection input: two text changes on two devices.
  const changes = [
    { field: 'notes', mode: 'replace', value: 'Room 12' },
    { field: 'annotatedUser', mode: 'clear' },
  ];
  const targets = previewTargets(
    [
      device('d2', { notes: 'Room 12', annotated_user: 'A person' }),
      device('d1', { annotated_user: 'A person' }),
    ],
    changes,
  );
  const digest = manifestDigest(targets);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(digest, manifestDigest(targets));
  assert.equal(
    digest,
    createHash('sha256')
      .update(
        '{"actionVersion":3,"targets":[' +
          '["d1",[["annotatedUser",null,"A person","A person"],["notes","Room 12",null,null]]],' +
          '["d2",[["annotatedUser",null,"A person","A person"]]]]}',
      )
      .digest('hex'),
    'The canonical form holds the action version and each eligible row in contract order.',
  );
  assert.equal(
    digest,
    'e2b78bfe48e45d7663b2df6365f4ce49adcb0e353534d23ebd057bc97580418c',
    'A fixed selection input keeps its version 3 digest.',
  );
  // The digest drops the change list, because each row carries its own request.
  assert.notEqual(
    digest,
    manifestDigest(
      previewTargets([device('d1', { annotated_user: 'A person' })], changes),
    ),
  );
  // A different baseline changes the digest, even when the request and the observation stay.
  const rebound = previewTargets(
    [device('d1', { annotated_user: 'A person' })],
    changes,
  );
  rebound[0].fields[0].baselineValue = 'Someone else';
  assert.notEqual(digest, manifestDigest(rebound));
});

test('the version 3 digest of a fixed edit list covers a value per device', () => {
  const targets = [
    {
      ordinal: 0,
      deviceId: 'd2',
      serialNumber: 'SN-d2',
      orgUnitPath: '/School A',
      observedAt: null,
      disposition: 'eligible',
      exclusionReason: null,
      fields: [
        {
          field: 'notes',
          requestedValue: 'Room 12',
          observedValue: 'Room 12',
          baselineValue: 'Room 11',
          disposition: 'eligible',
        },
      ],
    },
    {
      ordinal: 1,
      deviceId: 'd1',
      serialNumber: 'SN-d1',
      orgUnitPath: '/School A',
      observedAt: null,
      disposition: 'eligible',
      exclusionReason: null,
      fields: [
        {
          field: 'annotatedAssetId',
          requestedValue: 'AT-42',
          observedValue: 'AT-41',
          baselineValue: null,
          disposition: 'eligible',
        },
      ],
    },
  ];
  assert.equal(
    manifestDigest(targets),
    createHash('sha256')
      .update(
        '{"actionVersion":3,"targets":[' +
          '["d1",[["annotatedAssetId","AT-42","AT-41",null]]],' +
          '["d2",[["notes","Room 12","Room 12","Room 11"]]]]}',
      )
      .digest('hex'),
    'The digest sorts the devices and keeps each row request, observation, and baseline.',
  );
  assert.equal(
    manifestDigest(targets),
    'df65f8b4fcf5d22f150f8252d5e71f59160f8b9a1486bb237b96805f46d9e3bf',
    'A fixed edit list keeps its version 3 digest.',
  );
});

test('the targets page reads each request and baseline from its frozen row', async () => {
  const reads = [];
  const updates = new DeviceUpdates(
    {
      connection: {
        query: async (text, values) => {
          reads.push({ text, values });
          if (text.includes('FROM cc.device_update_previews'))
            return { rows: [previewRow()] };
          if (text.includes('FROM cc.device_update_preview_targets'))
            return {
              rows: [
                {
                  ordinal: 0,
                  device_id: 'd1',
                  serial_number: 'SN-1',
                  org_unit_path: '/School A',
                  field: 'annotatedAssetId',
                  requested_value: 'AT-42',
                  observed_value: 'AT-41',
                  baseline_value: null,
                  disposition: 'conflict',
                  exclusion_reason: null,
                },
              ],
            };
          return { rows: [] };
        },
      },
      transaction: async () => {
        throw new Error('No write is allowed.');
      },
    },
    { get: async () => null },
    { storeJson: async () => 'unused' },
  );
  const page = await updates.targets(session, previewId, 'conflict');
  assert.deepEqual(page, {
    targets: [
      {
        deviceId: 'd1',
        serialNumber: 'SN-1',
        field: 'annotatedAssetId',
        observedValue: 'AT-41',
        baselineValue: null,
        approvedValue: 'AT-42',
        duplicateSerialNumber: null,
        disposition: 'conflict',
        exclusionReason: null,
      },
    ],
    nextCursor: null,
  });
  assert.equal(
    reads.some((read) => read.text.includes('cc.device_update_changes')),
    false,
    'Each row carries its own request, so the page reads no change list.',
  );
  assert.equal(
    reads.find((read) => read.text.includes('cc.device_update_preview_targets'))
      .values[1],
    'conflict',
    'The page filters on the frozen conflict disposition.',
  );
});

test('a display number keeps at least three digits without truncating 1000', () => {
  assert.equal(displayNumber('PV', 6), 'PV-006');
  assert.equal(displayNumber('UPD', 999), 'UPD-999');
  assert.equal(displayNumber('UPD', 1000), 'UPD-1000');
});

test('a targets cursor names the ordinal and the one-based field position', () => {
  // The query compares against array_position, which counts the first field as 1.
  assert.equal(targetCursor(0, 'annotatedLocation'), '0:1');
  assert.equal(targetCursor(4, 'annotatedAssetId'), '4:2');
  assert.equal(targetCursor(4, 'annotatedUser'), '4:3');
  assert.equal(targetCursor(4, 'notes'), '4:4');
  assert.equal(targetCursor(4, 'orgUnitPath'), '4:5');
  assert.equal(targetCursor(4, 'status'), null);
  assert.equal(targetCursor('4', 'notes'), null);
  assert.deepEqual(parseIntCursor('4:2'), { ordinal: 4, position: 2 });
  assert.deepEqual(parseIntCursor(undefined), { ordinal: -1, position: -1 });
  for (const cursor of ['', 'x', '1:2:3', '1:-2', '-1:2', '1.5:2'])
    assert.deepEqual(
      parseIntCursor(cursor),
      { ordinal: -1, position: -1 },
      `The cursor ${JSON.stringify(cursor)} starts at the first row.`,
    );
});

test('a target row reports its own request, observation, and baseline', () => {
  assert.deepEqual(
    previewTargetRow({
      device_id: 'd1',
      serial_number: 'SN-1',
      field: 'annotatedLocation',
      requested_value: 'Room 12',
      observed_value: 'Room 1',
      baseline_value: 'Room 1',
      disposition: 'eligible',
      exclusion_reason: null,
    }),
    {
      deviceId: 'd1',
      serialNumber: 'SN-1',
      field: 'annotatedLocation',
      observedValue: 'Room 1',
      baselineValue: 'Room 1',
      approvedValue: 'Room 12',
      duplicateSerialNumber: null,
      disposition: 'eligible',
      exclusionReason: null,
    },
    'The approved value comes from the frozen row, not from a change list.',
  );
  const cleared = previewTargetRow({
    device_id: 'd1',
    serial_number: 'SN-1',
    field: 'notes',
    requested_value: null,
    observed_value: 'Room 1',
    baseline_value: 'Room 1',
    disposition: 'conflict',
    exclusion_reason: null,
  });
  assert.equal(cleared.approvedValue, null, 'A Clear row approves no value.');
  assert.equal(cleared.disposition, 'conflict');
  assert.equal(cleared.baselineValue, 'Room 1');
});

test('the selection contract requires expiredAt as a timestamp or null', () => {
  const base = {
    terms: [],
    groups: [],
    added: 0,
    excluded: 0,
    selectedCount: 0,
  };
  assert.throws(
    () => deviceSelectionSpecSchema.parse(base),
    /expiredAt/,
    'An omitted expiredAt is refused.',
  );
  assert.equal(
    deviceSelectionSpecSchema.parse({ ...base, expiredAt: null }).expiredAt,
    null,
  );
  assert.equal(
    deviceSelectionSpecSchema.parse({
      ...base,
      expiredAt: '2026-10-18T12:00:00.000Z',
    }).expiredAt,
    '2026-10-18T12:00:00.000Z',
  );
  assert.throws(
    () =>
      deviceSelectionSpecSchema.parse({
        ...base,
        expiredAt: '2026-10-18T12:00:00',
      }),
    /expiredAt/,
  );
  assert.throws(
    () => deviceSelectionSpecSchema.parse({ ...base, expiredAt: 'yesterday' }),
    /expiredAt/,
  );
});

test('a missing bulk-actions grant answers 403 and audits access-denied', async () => {
  const audits = [];
  const request = {
    session: {
      ...session,
      identity: {
        ...session.identity,
        grants: [
          {
            action: 'devices:read',
            scope: { kind: 'district', customerId: customer },
          },
          {
            action: 'devices:write',
            scope: { kind: 'district', customerId: customer },
          },
        ],
      },
    },
    correlationId: '22222222-2222-4222-8222-222222222222',
  };
  await assert.rejects(
    authorizeAction(
      {
        phase: 3,
        audit: async (...args) => audits.push(args),
      },
      request.session,
      'devices:bulk-actions',
      { kind: 'district', customerId: customer },
      request.correlationId,
    ),
    (error) => {
      assert.ok(error instanceof ForbiddenException);
      assert.equal(error.getStatus(), 403);
      return true;
    },
  );
  assert.deepEqual(audits, [
    ['access-denied', request.correlationId, actor, 'devices:bulk-actions'],
  ]);
});

test('an expired selection answers 409 selection-expired with its expiry time', async () => {
  const changedAt = '2026-10-18T00:00:00.000Z';
  const updates = new DeviceUpdates(
    {
      connection: { query: async () => ({ rows: [] }) },
      transaction: async () => ({}),
    },
    {
      get: async () =>
        JSON.stringify({
          terms: [[]],
          groups: [],
          additions: ['d1'],
          exceptions: [],
          changedAt,
        }),
    },
    { storeJson: async () => 'artifact' },
  );
  await assert.rejects(
    updates.preview(session, current, {
      ...key,
      changes: [{ field: 'annotatedLocation', mode: 'clear' }],
    }),
    (error) => {
      assert.equal(error.getStatus(), 409);
      assert.deepEqual(error.getResponse(), {
        reason: 'selection-expired',
        expiredAt: '2026-10-18T12:00:00.000Z',
      });
      return true;
    },
  );
});

test('an empty selection answers 422 nothing-selected', async () => {
  const updates = new DeviceUpdates(
    {
      connection: { query: async () => ({ rows: [] }) },
      transaction: async () => ({}),
    },
    { get: async () => null },
    { storeJson: async () => 'artifact' },
  );
  await assert.rejects(
    updates.preview(session, current, {
      ...key,
      changes: [{ field: 'annotatedLocation', mode: 'clear' }],
    }),
    (error) => {
      assert.equal(error.getStatus(), 422);
      assert.deepEqual(error.getResponse(), { reason: 'nothing-selected' });
      return true;
    },
  );
});

test('the preview request refuses a value on Clear', () => {
  assert.throws(() =>
    deviceUpdatePreviewRequestSchema.parse({
      ...key,
      changes: [{ field: 'annotatedLocation', mode: 'clear' }],
      value: 'Room 12',
    }),
  );
});

test('a JSON document is staged and published as one artifact', async () => {
  const calls = [];
  const store = {
    stage: async (manifest, chunks) => {
      calls.push({ name: 'stage', manifest, chunks });
      return { ...manifest, sizeBytes: manifest.expectedSizeBytes };
    },
    publish: async (descriptor) => {
      calls.push({ name: 'publish', descriptor });
    },
  };
  const artifactId = await storeJsonDocument(store, { hello: 'world' });
  assert.equal(artifactId, calls[0].manifest.artifactId);
  const bytes = Buffer.concat(calls[0].chunks);
  assert.equal(bytes.toString(), '{"hello":"world"}\n');
  assert.equal(
    calls[0].manifest.expectedSha256,
    createHash('sha256').update(bytes).digest('hex'),
  );
  assert.equal(calls[1].name, 'publish');
});

test('an artifact failure fails the confirmation', async () => {
  const calls = [];
  const previewId = '33333333-3333-4333-8333-333333333333';
  const manifest = {
    preview: { previewId, manifestDigest: 'a'.repeat(64) },
    targets: [],
    requester: actor,
    confirmer: actor,
  };
  const updates = new DeviceUpdates(
    {
      connection: {
        query: async (text) => {
          calls.push(text);
          if (text.includes('cc.read_device_update_preview_manifest'))
            return { rows: [{ result: { outcome: 'manifest', manifest } }] };
          if (text.includes('cc.confirm_device_update_preview'))
            return {
              rows: [
                {
                  result: {
                    outcome: 'created',
                    receipt: {
                      jobId: '44444444-4444-4444-8444-444444444444',
                      displayId: 'UPD-001',
                      status: 'accepted',
                      deviceCount: 1,
                      updateCount: 1,
                    },
                  },
                },
              ],
            };
          return { rows: [] };
        },
      },
      transaction: async () => {
        throw new Error('The transaction must not run.');
      },
    },
    { get: async () => null },
    {
      storeJson: async () => {
        throw new Error('The artifact store is unavailable.');
      },
    },
  );
  await assert.rejects(
    updates.confirm(session, current, previewId, {
      manifestDigest: 'a'.repeat(64),
      acknowledged: true,
    }),
    /artifact store is unavailable/,
  );
  assert.match(calls[0], /cc\.read_device_update_preview_manifest/);
});
test('a selection above the 100,000 cap answers 422 selection-too-large', async () => {
  const rows = Array.from({ length: 100_001 }, (_, index) => ({
    device_id: `device-${index}`,
    serial_number: `SN-${index}`,
    org_unit_path: '/School',
    observed_value: null,
    observed_at: null,
    removed_at: null,
  }));
  const updates = new DeviceUpdates(
    {
      connection: { query: async () => ({ rows }) },
      transaction: async () => {
        throw new Error('No preview write is allowed.');
      },
    },
    {
      get: async () =>
        JSON.stringify({
          terms: [],
          groups: [],
          additions: ['device-1', 'device-2'],
          exceptions: [],
          changedAt: new Date().toISOString(),
        }),
    },
    { storeJson: async () => 'unused' },
  );
  await assert.rejects(
    updates.preview(session, current, {
      ...key,
      changes: [{ field: 'annotatedLocation', mode: 'clear' }],
    }),
    (error) => {
      assert.equal(error.getStatus(), 422);
      assert.equal(error.getResponse().reason, 'selection-too-large');
      return true;
    },
  );
});

test('an unknown preview answers 404 preview-not-found', async () => {
  const updates = new DeviceUpdates(
    {
      connection: { query: async () => ({ rows: [] }) },
      transaction: async () => {
        throw new Error('No write is allowed.');
      },
    },
    { get: async () => null },
    { storeJson: async () => 'unused' },
  );
  await assert.rejects(
    updates.previewById(session, '33333333-3333-4333-8333-333333333333'),
    (error) => {
      assert.equal(error.getStatus(), 404);
      assert.equal(error.getResponse().reason, 'preview-not-found');
      return true;
    },
  );
});

const previewId = '33333333-3333-4333-8333-333333333333';
const jobId = '44444444-4444-4444-8444-444444444444';
test('a preview without change rows answers no changes and its conflict count', async () => {
  let reads = 0;
  const updates = new DeviceUpdates(
    {
      connection: {
        query: async (text) => {
          reads += 1;
          if (text.includes('cc.device_update_previews'))
            return {
              rows: [
                previewRow({
                  field_changes: 3,
                  selected: 3,
                  eligible: 1,
                  conflicts: 2,
                }),
              ],
            };
          // An edit-list preview stores one request per row, so this join finds no change.
          return { rows: [] };
        },
      },
      transaction: async () => {
        throw new Error('No write is allowed.');
      },
    },
    { get: async () => null },
    { storeJson: async () => 'unused' },
  );
  const preview = await updates.previewById(session, previewId);
  assert.equal(reads, 2, 'The answer reads the preview and its change rows.');
  assert.equal(preview.changes, null);
  assert.equal(preview.conflicts, 2);
  assert.equal(preview.fieldChanges, 3);
});

const previewRow = (extra = {}) => ({
  preview_id: previewId,
  display_id: 'PV-001',
  customer_id: customer,
  created_by: actor,
  permission_version: 1,
  generation: 1,
  field_changes: 1,
  selected: 1,
  eligible: 1,
  unchanged: 0,
  excluded: 0,
  conflicts: 0,
  oldest_observed_at: new Date(),
  manifest_digest: 'a'.repeat(64),
  prepared_at: new Date(),
  expires_at: new Date(Date.now() + 600_000),
  job_id: null,
  ...extra,
});
const manifestDocument = () => ({
  preview: { previewId, manifestDigest: 'a'.repeat(64) },
  targets: [],
  requester: actor,
  confirmer: actor,
});
const selectionJson = JSON.stringify({
  terms: [],
  groups: [],
  additions: ['d1'],
  exceptions: [],
  changedAt: new Date().toISOString(),
});

test('the preview create function freezes every target', async () => {
  const calls = [];
  const updates = new DeviceUpdates(
    {
      connection: {
        query: async (text, values) => {
          calls.push({ text, values });
          if (text.includes('cc.create_device_update_preview'))
            return {
              rows: [{ result: { outcome: 'created', preview: previewRow() } }],
            };
          return { rows: [device('d1')] };
        },
      },
      transaction: async (run) =>
        run({
          query: async (text) => {
            calls.push({ text });
            return text.includes('INSERT INTO cc.device_update_previews')
              ? { rows: [previewRow()] }
              : { rows: [{}] };
          },
        }),
    },
    { get: async () => selectionJson },
    { storeJson: async () => 'unused' },
  );
  const result = await updates.preview(session, current, {
    ...key,
    changes: [
      { field: 'annotatedLocation', mode: 'replace', value: 'Room 12' },
    ],
  });
  assert.ok(
    calls.some((call) => call.text.includes('cc.create_device_update_preview')),
    'The preview is created by the SECURITY DEFINER function.',
  );
  const create = calls.find((call) =>
    call.text.includes('cc.create_device_update_preview'),
  );
  assert.deepEqual(
    JSON.parse(create.values[7])[0].fields,
    [
      {
        field: 'annotatedLocation',
        requested_value: 'Room 12',
        observed_value: null,
        baseline_value: null,
        disposition: 'eligible',
      },
    ],
    'The frozen target row carries its request and its baseline.',
  );
  assert.equal(result.displayId, 'PV-001');
  assert.equal(result.eligible, 1);
});

test('a forbidden preview create answers 403', async () => {
  const calls = [];
  const updates = new DeviceUpdates(
    {
      connection: {
        query: async (text) => {
          calls.push(text);
          if (text.includes('cc.create_device_update_preview'))
            return { rows: [{ result: { outcome: 'forbidden' } }] };
          return { rows: [device('d1')] };
        },
      },
      transaction: async (run) => run({ query: async () => ({ rows: [{}] }) }),
    },
    { get: async () => selectionJson },
    { storeJson: async () => 'unused' },
  );
  await assert.rejects(
    updates.preview(session, current, {
      ...key,
      changes: [{ field: 'annotatedLocation', mode: 'clear' }],
    }),
    (error) => {
      assert.equal(error.getStatus(), 403);
      return true;
    },
  );
  assert.match(calls.join('\n'), /cc\.create_device_update_preview/);
});

test('a lost grant stores no manifest artifact', async () => {
  const calls = [];
  const stored = [];
  const updates = new DeviceUpdates(
    {
      connection: {
        query: async (text) => {
          calls.push(text);
          if (text.includes('cc.read_device_update_preview_manifest'))
            return { rows: [{ result: { outcome: 'permission-changed' } }] };
          if (text.includes('FROM cc.device_update_previews'))
            return { rows: [previewRow()] };
          return { rows: [] };
        },
      },
      transaction: async (run) =>
        run({
          query: async (text) =>
            text.includes('SELECT CASE')
              ? { rows: [{ reason: 'permission-changed' }] }
              : { rows: [{}] },
        }),
    },
    { get: async () => null },
    {
      storeJson: async (document) => {
        stored.push(document);
        return 'artifact';
      },
    },
  );
  let error;
  try {
    await updates.confirm(session, current, previewId, {
      manifestDigest: 'a'.repeat(64),
      acknowledged: true,
    });
  } catch (failure) {
    error = failure;
  }
  assert.match(
    calls[0],
    /cc\.read_device_update_preview_manifest/,
    'The manifest function runs first.',
  );
  assert.equal(error?.getStatus(), 409);
  assert.equal(error?.getResponse()?.reason, 'permission-changed');
  assert.equal(stored.length, 0);
});

test('a preview with a conflict stores no manifest artifact and answers preview-conflict', async () => {
  const calls = [];
  const stored = [];
  const updates = new DeviceUpdates(
    {
      connection: {
        query: async (text) => {
          calls.push(text);
          if (text.includes('cc.read_device_update_preview_manifest'))
            return { rows: [{ result: { outcome: 'preview-conflict' } }] };
          if (text.includes('FROM cc.device_update_previews'))
            return { rows: [previewRow({ conflicts: 1 })] };
          return { rows: [] };
        },
      },
      transaction: async () => {
        throw new Error('A conflict preview writes nothing.');
      },
    },
    { get: async () => null },
    {
      storeJson: async (document) => {
        stored.push(document);
        return 'artifact';
      },
    },
  );
  await assert.rejects(
    updates.confirm(session, current, previewId, {
      manifestDigest: 'a'.repeat(64),
      acknowledged: true,
    }),
    (error) => {
      assert.equal(error.getStatus(), 409);
      assert.equal(error.getResponse()?.reason, 'preview-conflict');
      return true;
    },
  );
  assert.match(
    calls[0],
    /cc\.read_device_update_preview_manifest/,
    'The conflict answers before the confirm function runs.',
  );
  assert.equal(
    calls.some((text) => text.includes('cc.confirm_device_update_preview')),
    false,
    'A conflict preview creates no job.',
  );
  assert.equal(stored.length, 0, 'A conflict preview stores no artifact.');
});

test('every confirmation outcome maps to its status and code', async () => {
  const cases = [
    [
      { outcome: 'preview-expired', expiresAt: '2026-10-19T12:00:00.000Z' },
      410,
      'preview-expired',
    ],
    [{ outcome: 'preview-changed' }, 409, 'preview-changed'],
    [{ outcome: 'preview-conflict' }, 409, 'preview-conflict'],
    [{ outcome: 'preview-unsealed' }, 409, 'preview-unsealed'],
    [{ outcome: 'connection-changed' }, 409, 'connection-changed'],
    [{ outcome: 'nothing-to-update' }, 422, 'nothing-to-update'],
    [{ outcome: 'not-found' }, 404, 'preview-not-found'],
  ];
  for (const [result, status, reason] of cases) {
    const calls = [];
    const updates = new DeviceUpdates(
      {
        connection: {
          query: async (text) => {
            calls.push(text);
            if (text.includes('cc.read_device_update_preview_manifest'))
              return {
                rows: [
                  {
                    result: {
                      outcome: 'manifest',
                      manifest: manifestDocument(),
                    },
                  },
                ],
              };
            if (text.includes('cc.confirm_device_update_preview'))
              return { rows: [{ result }] };
            if (text.includes('FROM cc.device_update_previews'))
              return { rows: [previewRow()] };
            return { rows: [] };
          },
        },
        transaction: async (run) =>
          run({
            query: async (text) =>
              text.includes('SELECT CASE')
                ? { rows: [{ reason: null }] }
                : { rows: [{}] },
          }),
      },
      { get: async () => null },
      { storeJson: async () => 'artifact' },
    );
    let error;
    try {
      await updates.confirm(session, current, previewId, {
        manifestDigest: 'a'.repeat(64),
        acknowledged: true,
      });
    } catch (failure) {
      error = failure;
    }
    assert.match(
      calls[0],
      /cc\.read_device_update_preview_manifest/,
      `${result.outcome} reads the manifest first.`,
    );
    assert.equal(error?.getStatus(), status, `${result.outcome} status.`);
    assert.equal(
      error?.getResponse()?.reason,
      reason,
      `${result.outcome} reason.`,
    );
  }
});

test('a selection that resolves to no devices answers 422 nothing-selected', async () => {
  const updates = new DeviceUpdates(
    {
      connection: {
        query: async (text) =>
          text.includes('cc.create_device_update_preview')
            ? {
                rows: [
                  { result: { outcome: 'created', preview: previewRow() } },
                ],
              }
            : { rows: [] },
      },
      transaction: async () => {
        throw new Error('No preview write is allowed.');
      },
    },
    {
      get: async () =>
        JSON.stringify({
          terms: [
            [
              {
                field: 'serialNumber',
                operator: 'startsWith',
                value: 'ZZZ-no-device',
              },
            ],
          ],
          groups: [],
          additions: [],
          exceptions: [],
          changedAt: new Date().toISOString(),
        }),
    },
    { storeJson: async () => 'unused' },
  );
  await assert.rejects(
    updates.preview(session, current, {
      ...key,
      changes: [{ field: 'annotatedLocation', mode: 'clear' }],
    }),
    (error) => {
      assert.equal(error.getStatus(), 422);
      assert.deepEqual(error.getResponse(), { reason: 'nothing-selected' });
      return true;
    },
  );
});

test('a missing manifest artifact fails the confirmation', async () => {
  const missing = '55555555-5555-4555-8555-555555555555';
  const updates = new DeviceUpdates(
    {
      connection: {
        query: async (text) => {
          if (text.includes('cc.read_device_update_preview_manifest'))
            return {
              rows: [
                {
                  result: {
                    outcome: 'manifest',
                    manifest: manifestDocument(),
                  },
                },
              ],
            };
          if (text.includes('cc.confirm_device_update_preview'))
            return { rows: [{ result: { outcome: 'artifact-missing' } }] };
          return { rows: [] };
        },
      },
      transaction: async (run) => run({ query: async () => ({ rows: [] }) }),
    },
    { get: async () => null },
    { storeJson: async () => missing },
  );
  let error;
  try {
    await updates.confirm(session, current, previewId, {
      manifestDigest: 'a'.repeat(64),
      acknowledged: true,
    });
  } catch (failure) {
    error = failure;
  }
  assert.equal(
    typeof error?.getStatus,
    'function',
    'The confirmation answers with an HTTP error.',
  );
  assert.equal(error.getStatus(), 500);
  assert.match(String(error.message), /manifest artifact/i);
});

test('the preview route names the field and its limit for every over-limit value', () => {
  // The selection key of a preview route needs a UUID tab; `key` above is for the pure helpers.
  const routeKey = {
    gridId: 'devices',
    tabId: '6f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10',
  };
  const body = (field, mode, value) => ({
    ...routeKey,
    changes: [{ field, mode, value }],
  });
  const refused = (input) => {
    try {
      previewInput(input);
    } catch (failure) {
      assert.ok(
        failure instanceof BadRequestException,
        'A refused change answers with a 400.',
      );
      return failure.getResponse();
    }
    return assert.fail('The preview input accepted an over-limit value.');
  };

  // A body of 65,537 UTF-16 units answers the field label and its own limit (review R1).
  const huge = 'x'.repeat(65_537);
  const rows = [
    ['annotatedLocation', 'replace', huge, 'Annotated location', 200],
    ['annotatedUser', 'replace', huge, 'Annotated user', 100],
    ['notes', 'replace', huge, 'Notes', 500],
    [
      'orgUnitPath',
      'move',
      `/${'a'.repeat(65_536)}`,
      'Organization unit',
      4096,
    ],
  ];
  for (const [field, mode, value, label, limit] of rows) {
    const answer = refused(body(field, mode, value));
    assert.equal(answer.reason, 'invalid-change');
    assert.match(answer.message, new RegExp(label));
    assert.match(answer.message, new RegExp(String(limit)));
  }

  // The ordinary N+1 value keeps the same answer.
  const overByOne = refused(body('notes', 'replace', 'x'.repeat(501)));
  assert.equal(overByOne.reason, 'invalid-change');
  assert.equal(overByOne.message, 'Notes holds 1 to 500 characters.');

  // A supplementary character counts as one code point: 100 preview, 101 refuse.
  const fourByteCharacter = '\u{1D306}';
  const accepted = previewInput(
    body('annotatedUser', 'replace', fourByteCharacter.repeat(100)),
  );
  assert.deepEqual(accepted.changes, [
    {
      field: 'annotatedUser',
      mode: 'replace',
      value: fourByteCharacter.repeat(100),
    },
  ]);
  const refusedSupplementary = refused(
    body('annotatedUser', 'replace', fourByteCharacter.repeat(101)),
  );
  assert.equal(refusedSupplementary.reason, 'invalid-change');
  assert.equal(
    refusedSupplementary.message,
    'Annotated user holds 1 to 100 characters.',
  );
});

// ---------------------------------------------------------------------------------------------
// The edit list: fresh rows, the compare of section 4, and the duplicate warning of section 6.
// ---------------------------------------------------------------------------------------------

/** One stored row, as the fresh read leaves it in Postgres. */
const freshRow = (deviceId, extra = {}) => ({
  device_id: deviceId,
  serial_number: `SN-${deviceId}`,
  org_unit_path: '/School A',
  asset_tag: null,
  annotated_location: null,
  annotated_user: null,
  notes: null,
  removed_at: null,
  last_entity_sync: '2026-10-23T12:00:01.000Z',
  ...extra,
});
const edit = (deviceId, field, mode, value, baselineValue) =>
  value === undefined
    ? { deviceId, field, mode, baselineValue: baselineValue ?? null }
    : { deviceId, field, mode, value, baselineValue: baselineValue ?? null };

test('the edit compare takes the first match of the table: removed, invalid, unchanged, conflict, eligible', () => {
  const rows = [
    freshRow('d1', {
      removed_at: new Date('2026-10-23T11:00:00.000Z'),
      notes: 'Room 12',
    }),
    freshRow('bad id!'),
    freshRow('d2', { notes: 'Room 12' }),
    freshRow('d3', { notes: 'Room 12' }),
    freshRow('d4', { notes: 'Room 12' }),
    freshRow('d5'),
    freshRow('d6', { notes: 'Room 12' }),
  ];
  const targets = editPreviewTargets(rows, [
    edit('d1', 'notes', 'replace', 'Room 9', 'Room 12'),
    edit('bad id!', 'notes', 'replace', 'Room 9', null),
    // C equals R: Google already holds the request.
    edit('d2', 'notes', 'replace', 'Room 12', null),
    // C differs from B: the value changed since the edit began.
    edit('d3', 'notes', 'replace', 'Room 9', 'Room 9'),
    // C equals B: the edit is eligible.
    edit('d4', 'notes', 'replace', 'Room 9', 'Room 12'),
    // A null baseline and a null current value are equal.
    edit('d5', 'notes', 'replace', 'Room 9', null),
    // A current value against a null baseline is a conflict.
    edit('d6', 'notes', 'replace', 'Room 9', null),
  ]);

  assert.deepEqual(
    targets.map((target) => [
      target.deviceId,
      target.disposition,
      target.exclusionReason,
      target.fields[0].disposition,
    ]),
    [
      ['bad id!', 'excluded', 'invalid-device-id', 'excluded'],
      ['d1', 'excluded', 'removed', 'excluded'],
      ['d2', 'unchanged', null, 'unchanged'],
      ['d3', 'conflict', null, 'conflict'],
      ['d4', 'eligible', null, 'eligible'],
      ['d5', 'eligible', null, 'eligible'],
      ['d6', 'conflict', null, 'conflict'],
    ],
  );
  assert.equal(
    targets[0].fields[0].baselineValue,
    null,
    'The row keeps the baseline that the edit carried.',
  );
  assert.equal(
    targets[1].fields[0].observedValue,
    'Room 12',
    'The row keeps the value that the fresh read observed.',
  );
  assert.deepEqual(
    targets[1].fields[0],
    {
      field: 'notes',
      requestedValue: 'Room 9',
      observedValue: 'Room 12',
      baselineValue: 'Room 12',
      disposition: 'excluded',
    },
    'An excluded device excludes every field row.',
  );
});

test('a device follows the first row match: excluded, then conflict, then eligible, else unchanged', () => {
  const rows = [freshRow('d1', { notes: 'N', annotated_user: 'U' })];
  const disposition = (edits) => editPreviewTargets(rows, edits)[0].disposition;

  assert.equal(
    disposition([
      edit('d1', 'annotatedUser', 'replace', 'U', null),
      edit('d1', 'notes', 'replace', 'N', null),
    ]),
    'unchanged',
  );
  assert.equal(
    disposition([
      edit('d1', 'annotatedUser', 'replace', 'U', null),
      edit('d1', 'notes', 'replace', 'Next', 'N'),
    ]),
    'eligible',
  );
  assert.equal(
    disposition([
      edit('d1', 'annotatedUser', 'replace', 'U', null),
      edit('d1', 'notes', 'replace', 'Next', 'Room 12'),
    ]),
    'conflict',
  );
});

test('the edit compare keeps text exact and compares paths without case', () => {
  const rows = [freshRow('d1', { org_unit_path: '/School A' })];
  const [target] = editPreviewTargets(rows, [
    edit('d1', 'orgUnitPath', 'move', '/school a', '/SCHOOL A'),
  ]);
  assert.equal(
    target.fields[0].disposition,
    'unchanged',
    'A path that differs only by case already holds the request.',
  );

  const [eligible] = editPreviewTargets(rows, [
    edit('d1', 'orgUnitPath', 'move', '/School B', '/school a'),
  ]);
  assert.equal(
    eligible.fields[0].disposition,
    'eligible',
    'A baseline that differs by case from the current path still equals it.',
  );

  const [text] = editPreviewTargets(
    [freshRow('d1', { notes: 'Room 12' })],
    [edit('d1', 'notes', 'replace', 'room 12', 'Room 12')],
  );
  assert.equal(
    text.fields[0].disposition,
    'eligible',
    'Text compares exactly, so a different case is a change.',
  );
});

test('a target lists one row per edit, in contract order, sorted by device ID', () => {
  const targets = editPreviewTargets(
    [freshRow('d2'), freshRow('d1')],
    [
      edit('d2', 'notes', 'replace', 'N', null),
      edit('d1', 'annotatedAssetId', 'replace', 'AT-1', null),
      edit('d2', 'annotatedLocation', 'replace', 'L', null),
      edit('d1', 'annotatedLocation', 'replace', 'L', null),
    ],
  );
  assert.deepEqual(
    targets.map((target) => target.deviceId),
    ['d1', 'd2'],
  );
  assert.deepEqual(
    targets.map((target) => target.fields.map((field) => field.field)),
    [
      ['annotatedLocation', 'annotatedAssetId'],
      ['annotatedLocation', 'notes'],
    ],
  );
  assert.deepEqual(
    targets.map((target) => target.ordinal),
    [0, 1],
  );
  assert.equal(targets[0].observedAt, '2026-10-23T12:00:01.000Z');
});

test('the edit preview freezes no change list and stores every row value', async () => {
  const calls = [];
  const updates = new DeviceUpdates(
    {
      connection: {
        query: async (text, values) => {
          calls.push({ text, values });
          return {
            rows: [
              {
                result: {
                  outcome: 'created',
                  preview: previewRow({
                    field_changes: 2,
                    selected: 1,
                    eligible: 1,
                  }),
                },
              },
            ],
          };
        },
      },
      transaction: async () => {
        throw new Error('No write is allowed.');
      },
    },
    { get: async () => null },
    { storeJson: async () => 'unused' },
  );
  const rows = [freshRow('d1', { notes: 'Old note' })];
  const edits = [
    edit('d1', 'notes', 'replace', 'New note', 'Old note'),
    edit('d1', 'annotatedAssetId', 'replace', 'AT-9', null),
  ];
  const preview = await updates.editPreview(session, current, { edits }, rows);

  assert.equal(
    preview.changes,
    null,
    'An edit preview answers no change list.',
  );
  const [create] = calls;
  assert.match(create.text, /cc\.create_device_update_preview/);
  assert.equal(
    create.values[5],
    null,
    'A null change list marks an edit list.',
  );
  assert.deepEqual(
    JSON.parse(create.values[7]),
    [
      {
        ordinal: 0,
        device_id: 'd1',
        serial_number: 'SN-d1',
        org_unit_path: '/School A',
        observed_at: '2026-10-23T12:00:01.000Z',
        disposition: 'eligible',
        exclusion_reason: null,
        fields: [
          {
            field: 'annotatedAssetId',
            requested_value: 'AT-9',
            observed_value: null,
            baseline_value: null,
            disposition: 'eligible',
          },
          {
            field: 'notes',
            requested_value: 'New note',
            observed_value: 'Old note',
            baseline_value: 'Old note',
            disposition: 'eligible',
          },
        ],
      },
    ],
    'Every row stores its request, its observation, and its baseline.',
  );
  assert.equal(
    create.values[6],
    manifestDigest(editPreviewTargets(rows, edits)),
    'The digest covers the edit-list targets.',
  );
});

test('a conflict preview is created, and only confirmation refuses it', async () => {
  const updates = new DeviceUpdates(
    {
      connection: {
        query: async () => ({
          rows: [
            {
              result: {
                outcome: 'created',
                preview: previewRow({
                  conflicts: 1,
                  eligible: 0,
                  field_changes: 0,
                }),
              },
            },
          ],
        }),
      },
      transaction: async () => ({}),
    },
    { get: async () => null },
    { storeJson: async () => 'unused' },
  );
  const preview = await updates.editPreview(
    session,
    current,
    { edits: [edit('d1', 'notes', 'replace', 'New', 'Stale')] },
    [freshRow('d1', { notes: 'Someone else' })],
  );
  assert.equal(preview.conflicts, 1);
});

test('the edit preview input answers the first refusal with its field label', () => {
  assert.throws(
    () =>
      editPreviewInput({
        edits: [edit('d1', 'annotatedAssetId', 'clear')],
      }),
    (error) => {
      assert.ok(error instanceof BadRequestException);
      assert.deepEqual(error.getResponse(), {
        reason: 'invalid-change',
        message: 'Asset tag offers Replace only.',
      });
      return true;
    },
  );
  // An edit whose request equals its baseline changes nothing.
  assert.throws(
    () =>
      editPreviewInput({ edits: [edit('d1', 'notes', 'replace', 'N', 'N')] }),
    (error) => {
      assert.deepEqual(error.getResponse(), {
        reason: 'invalid-change',
        message: 'Notes already holds this value.',
      });
      return true;
    },
  );
  assert.deepEqual(
    editPreviewInput({
      edits: [edit('d1', 'notes', 'replace', 'N', 'Old')],
    }).edits,
    [
      {
        deviceId: 'd1',
        field: 'notes',
        mode: 'replace',
        value: 'N',
        baselineValue: 'Old',
      },
    ],
  );
});

/** One frozen Asset tag row of the targets page. */
const assetPageRow = (deviceId, requested, extra = {}) => ({
  ordinal: Number(deviceId.slice(1)) - 1,
  device_id: deviceId,
  serial_number: `SN-${deviceId}`,
  org_unit_path: '/School A',
  field: 'annotatedAssetId',
  requested_value: requested,
  observed_value: null,
  baseline_value: null,
  disposition: 'eligible',
  exclusion_reason: null,
  ...extra,
});

/** The targets read with the duplicate lookup of addendum section 6. */
function duplicateUpdates({ page, previewTags, holders }) {
  const calls = [];
  const updates = new DeviceUpdates(
    {
      connection: {
        query: async (text, values) => {
          calls.push({ text, values });
          if (text.includes('FROM cc.device_update_previews'))
            return { rows: [previewRow()] };
          if (text.includes("AND f.field='annotatedAssetId'"))
            return { rows: previewTags };
          if (text.includes('d.asset_tag=ANY')) return { rows: holders };
          return { rows: page };
        },
      },
      transaction: async () => ({}),
    },
    { get: async () => null },
    { storeJson: async () => 'unused' },
  );
  return { updates, calls };
}

const duplicatesOf = async (harness) =>
  (
    await harness.updates.targets(session, previewId, undefined, undefined, 100)
  ).targets.map((target) => [target.deviceId, target.duplicateSerialNumber]);

test('a request equal to another device Asset tag names that serial number', async () => {
  const harness = duplicateUpdates({
    page: [assetPageRow('d1', 'AT-2')],
    previewTags: [
      { device_id: 'd1', serial_number: 'SN-d1', requested_value: 'AT-2' },
    ],
    holders: [{ asset_tag: 'AT-2', device_id: 'd3', serial_number: 'SN-d3' }],
  });
  assert.deepEqual(await duplicatesOf(harness), [['d1', 'SN-d3']]);
  assert.deepEqual(
    harness.calls.find((call) => call.text.includes('d.asset_tag=ANY')).values,
    [customer, ['AT-2']],
    'The lookup asks the index for the requested tag alone.',
  );
});

test('a swap of two Asset tags names no device', async () => {
  const harness = duplicateUpdates({
    page: [assetPageRow('d1', 'AT-2'), assetPageRow('d2', 'AT-1')],
    previewTags: [
      { device_id: 'd1', serial_number: 'SN-d1', requested_value: 'AT-2' },
      { device_id: 'd2', serial_number: 'SN-d2', requested_value: 'AT-1' },
    ],
    holders: [
      { asset_tag: 'AT-1', device_id: 'd1', serial_number: 'SN-d1' },
      { asset_tag: 'AT-2', device_id: 'd2', serial_number: 'SN-d2' },
    ],
  });
  assert.deepEqual(await duplicatesOf(harness), [
    ['d1', null],
    ['d2', null],
  ]);
});

test('a device that this preview moves to another tag holds no duplicate', async () => {
  const harness = duplicateUpdates({
    page: [assetPageRow('d1', 'AT-2')],
    previewTags: [
      { device_id: 'd1', serial_number: 'SN-d1', requested_value: 'AT-2' },
      { device_id: 'd2', serial_number: 'SN-d2', requested_value: 'AT-9' },
    ],
    holders: [{ asset_tag: 'AT-2', device_id: 'd2', serial_number: 'SN-d2' }],
  });
  assert.deepEqual(await duplicatesOf(harness), [['d1', null]]);
});

test('another row of the preview with the same request counts as a duplicate', async () => {
  const harness = duplicateUpdates({
    page: [assetPageRow('d1', 'AT-2'), assetPageRow('d2', 'AT-2')],
    previewTags: [
      { device_id: 'd1', serial_number: 'SN-d1', requested_value: 'AT-2' },
      { device_id: 'd2', serial_number: 'SN-d2', requested_value: 'AT-2' },
    ],
    holders: [],
  });
  assert.deepEqual(await duplicatesOf(harness), [
    ['d1', 'SN-d2'],
    ['d2', 'SN-d1'],
  ]);
});

test('the duplicate warning never fills a non-Asset row or a blocked row', async () => {
  const harness = duplicateUpdates({
    page: [
      {
        ...assetPageRow('d1', null),
        field: 'notes',
        requested_value: 'Room 9',
        disposition: 'conflict',
      },
      assetPageRow('d2', 'AT-2', { disposition: 'unchanged' }),
    ],
    previewTags: [],
    holders: [{ asset_tag: 'AT-2', device_id: 'd3', serial_number: 'SN-d3' }],
  });
  assert.deepEqual(await duplicatesOf(harness), [
    ['d1', null],
    ['d2', null],
  ]);
});

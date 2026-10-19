import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { ForbiddenException } from '@nestjs/common';
import {
  deviceSelectionSpecSchema,
  deviceUpdatePreviewRequestSchema,
} from '@campus/application-contracts';
import { storeJsonDocument } from '../storage/json-artifact.ts';
import { authorizeAction } from '../auth/authorize-action.ts';
import {
  DeviceUpdates,
  displayNumber,
  manifestDigest,
  previewTargets,
} from './device-updates.ts';
import { previewTargetRow } from './device-update-rows.ts';

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
  last_entity_sync: new Date().toISOString(),
  removed_at: null,
  ...extra,
});

test('the preview freezes eligible, unchanged, and excluded targets', () => {
  const targets = previewTargets(
    [
      device('d1'),
      device('d2', { annotated_location: 'Room 12' }),
      device('d3', { annotated_location: 'Room 12' }),
      device('d4', { removed_at: new Date() }),
      device('bad id!'),
    ],
    'replace',
    'Room 12',
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
});

test('Clear makes an empty observed value unchanged and writes a null value', () => {
  const targets = previewTargets([device('d1')], 'clear', null);
  assert.equal(targets[0].disposition, 'unchanged');
  assert.equal(targets[0].observedValue, null);
});

test('the manifest digest covers the value and every eligible baseline', () => {
  const targets = previewTargets(
    [device('d1'), device('d2', { annotated_location: 'Room 12' })],
    'replace',
    'Room 12',
  );
  const digest = manifestDigest('replace', 'Room 12', targets);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(digest, manifestDigest('replace', 'Room 12', targets));
  assert.notEqual(digest, manifestDigest('replace', 'Room 13', targets));
  const changed = previewTargets(
    [device('d1', { annotated_location: 'Room 1' }), device('d2')],
    'replace',
    'Room 12',
  );
  assert.notEqual(digest, manifestDigest('replace', 'Room 12', changed));
});

test('a display number keeps at least three digits without truncating 1000', () => {
  assert.equal(displayNumber('PV', 6), 'PV-006');
  assert.equal(displayNumber('UPD', 999), 'UPD-999');
  assert.equal(displayNumber('UPD', 1000), 'UPD-1000');
});

test('a target row reports the approved value and its exclusion reason', () => {
  assert.deepEqual(
    previewTargetRow(
      {
        device_id: 'd1',
        serial_number: 'SN-1',
        observed_value: 'Room 1',
        disposition: 'eligible',
        exclusion_reason: null,
      },
      'replace',
      'Room 12',
    ),
    {
      deviceId: 'd1',
      serialNumber: 'SN-1',
      field: 'annotatedLocation',
      observedValue: 'Room 1',
      approvedValue: 'Room 12',
      disposition: 'eligible',
      exclusionReason: null,
    },
  );
});

test('the selection contract requires expiredAt as a timestamp or null', () => {
  const base = {
    terms: [],
    groups: [],
    added: 0,
    excluded: 0,
    selectedCount: 0,
  };
  assert.equal(deviceSelectionSpecSchema.parse(base).expiredAt, null);
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
      mode: 'clear',
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
    updates.preview(session, current, { ...key, mode: 'clear' }),
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
      mode: 'clear',
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
    updates.preview(session, current, { ...key, mode: 'clear' }),
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
const previewRow = (extra = {}) => ({
  preview_id: previewId,
  display_id: 'PV-001',
  customer_id: customer,
  created_by: actor,
  permission_version: 1,
  generation: 1,
  field: 'annotatedLocation',
  mode: 'replace',
  value: 'Room 12',
  selected: 1,
  eligible: 1,
  unchanged: 0,
  excluded: 0,
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
    mode: 'replace',
    value: 'Room 12',
  });
  assert.ok(
    calls.some((call) => call.text.includes('cc.create_device_update_preview')),
    'The preview is created by the SECURITY DEFINER function.',
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
    updates.preview(session, current, { ...key, mode: 'clear' }),
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

test('every confirmation outcome maps to its status and code', async () => {
  const cases = [
    [
      { outcome: 'preview-expired', expiresAt: '2026-10-19T12:00:00.000Z' },
      410,
      'preview-expired',
    ],
    [{ outcome: 'preview-changed' }, 409, 'preview-changed'],
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

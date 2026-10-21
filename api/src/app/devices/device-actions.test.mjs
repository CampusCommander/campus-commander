import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { ForbiddenException } from '@nestjs/common';
import {
  STATUS_PREVIEW_FAMILY,
  DeviceActions,
  actionManifestDigest,
  actionTargetRow,
  actionTargets,
  statusExclusion,
} from './device-actions.ts';
import {
  DEVICE_COMMAND_ROUTE_ACTIONS,
  DEVICE_STATUS_ROUTE_ACTIONS,
  requireDeviceActions,
} from './device-updates-actions.ts';

const customer = 'C0123456';
const actor = '11111111-1111-4111-8111-111111111111';
const correlationId = '22222222-2222-4222-8222-222222222222';
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
  expiresAt: '2026-10-21T12:00:00.000Z',
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
const stamp = new Date('2026-10-21T10:00:00.000Z');
const device = (id, status, extra = {}) => ({
  device_id: id,
  serial_number: `SN-${id}`,
  org_unit_path: '/School A',
  status,
  status_observed_at: stamp,
  removed_at: null,
  ...extra,
});
const selectionJson = JSON.stringify({
  terms: [],
  groups: [],
  additions: ['d1'],
  exceptions: [],
  changedAt: new Date().toISOString(),
});
const previewId = '33333333-3333-4333-8333-333333333333';
const previewRow = (extra = {}) => ({
  preview_id: previewId,
  display_id: 'PV-001',
  customer_id: customer,
  created_by: actor,
  permission_version: 1,
  generation: 1,
  action: 'reenable',
  field: null,
  mode: null,
  value: null,
  selected: 1,
  eligible: 0,
  unchanged: 0,
  excluded: 1,
  oldest_observed_at: null,
  manifest_digest: 'a'.repeat(64),
  prepared_at: new Date(),
  expires_at: new Date(Date.now() + 600_000),
  job_id: null,
  ...extra,
});
const actionsWith = (database) =>
  new DeviceActions(
    database,
    { get: async () => selectionJson },
    { storeJson: async () => 'unused' },
  );
const databaseOf = (query) => ({
  connection: { query },
  transaction: async (run) => run({ query: async () => ({ rows: [] }) }),
});

test('a Reboot preview lists the exclusion reason of every cached status', () => {
  const targets = actionTargets(
    [
      device('active', 'ACTIVE'),
      device('disabled', 'DISABLED'),
      device('deprovisioned', 'DEPROVISIONED'),
      device('missing', null),
      device('other', 'UNSPECIFIED'),
    ],
    'reboot',
  );
  assert.deepEqual(
    targets.map((target) => [
      target.deviceId,
      target.disposition,
      target.exclusionReason,
    ]),
    [
      ['active', 'eligible', null],
      ['disabled', 'excluded', 'device-disabled'],
      ['deprovisioned', 'excluded', 'device-deprovisioned'],
      ['missing', 'excluded', 'status-unknown'],
      ['other', 'excluded', 'status-unknown'],
    ],
  );
});

test('a Disable preview accepts ACTIVE only and names each refusal', () => {
  assert.equal(statusExclusion('disable', 'ACTIVE'), null);
  assert.equal(statusExclusion('disable', 'DISABLED'), 'device-disabled');
  assert.equal(
    statusExclusion('disable', 'DEPROVISIONED'),
    'device-deprovisioned',
  );
  assert.equal(statusExclusion('disable', null), 'status-unknown');
});

test('a Re-enable preview excludes an ACTIVE device and accepts a DISABLED one', () => {
  const targets = actionTargets(
    [
      device('active', 'ACTIVE'),
      device('disabled', 'DISABLED'),
      device('deprovisioned', 'DEPROVISIONED'),
    ],
    'reenable',
  );
  assert.deepEqual(
    targets.map((target) => [
      target.deviceId,
      target.disposition,
      target.exclusionReason,
    ]),
    [
      ['active', 'excluded', 'device-active'],
      ['disabled', 'eligible', null],
      ['deprovisioned', 'excluded', 'device-deprovisioned'],
    ],
  );
});

test('a removed or invalid device stays excluded before its status is read', () => {
  const targets = actionTargets(
    [
      device('gone', 'ACTIVE', { removed_at: new Date() }),
      device('bad id!', 'ACTIVE'),
    ],
    'reboot',
  );
  assert.deepEqual(
    targets.map((target) => [target.disposition, target.exclusionReason]),
    [
      ['excluded', 'removed'],
      ['excluded', 'invalid-device-id'],
    ],
  );
});

test('a target freezes the cached status and its observation stamp', () => {
  const target = actionTargets([device('d1', 'DISABLED')], 'reenable')[0];
  assert.deepEqual(target, {
    ordinal: 0,
    deviceId: 'd1',
    serialNumber: 'SN-d1',
    orgUnitPath: '/School A',
    observedStatus: 'DISABLED',
    observedAt: '2026-10-21T10:00:00.000Z',
    disposition: 'eligible',
    exclusionReason: null,
  });
});

test('the action digest covers the action, its version, the Google action, and each eligible baseline', () => {
  const rows = [device('d2', 'ACTIVE'), device('d1', 'ACTIVE')];
  const digest = actionManifestDigest('reboot', actionTargets(rows, 'reboot'));
  assert.equal(
    digest,
    createHash('sha256')
      .update(
        JSON.stringify({
          action: 'reboot',
          actionVersion: 1,
          googleAction: 'REBOOT',
          targets: [
            ['d1', 'ACTIVE'],
            ['d2', 'ACTIVE'],
          ],
        }),
      )
      .digest('hex'),
  );
  assert.equal(
    digest,
    actionManifestDigest(
      'reboot',
      actionTargets([...rows].reverse(), 'reboot'),
    ),
    'The device order does not matter.',
  );
  assert.notEqual(
    digest,
    actionManifestDigest('disable', actionTargets(rows, 'disable')),
    'Another action has another Google action.',
  );
  assert.notEqual(
    digest,
    actionManifestDigest(
      'reboot',
      actionTargets([device('d1', 'ACTIVE')], 'reboot'),
    ),
    'A device outside the manifest changes the digest.',
  );
});

test('a frozen action target row carries the cached status and its reason', () => {
  assert.deepEqual(
    actionTargetRow({
      device_id: 'd1',
      serial_number: 'SN-d1',
      org_unit_path: '/School A',
      observed_value: 'DISABLED',
      observed_at: '2026-10-21T10:00:00.000Z',
      disposition: 'excluded',
      exclusion_reason: 'device-disabled',
    }),
    {
      deviceId: 'd1',
      serialNumber: 'SN-d1',
      orgUnitPath: '/School A',
      observedStatus: 'DISABLED',
      observedAt: '2026-10-21T10:00:00.000Z',
      disposition: 'excluded',
      exclusionReason: 'device-disabled',
    },
  );
});

test('a Re-enable preview of ACTIVE devices freezes zero eligible and confirm answers 422', async () => {
  const calls = [];
  const actions = actionsWith(
    databaseOf(async (text, values) => {
      calls.push({ text, values });
      if (text.includes('FROM cc.device_sync_state'))
        return { rows: [device('d1', 'ACTIVE')] };
      if (text.includes('cc.create_device_update_preview'))
        return {
          rows: [{ result: { outcome: 'created', preview: previewRow() } }],
        };
      return { rows: [] };
    }),
  );
  const preview = await actions.preview(session, current, 'reenable', key);
  assert.equal(preview.action, 'reenable');
  assert.equal(preview.statusAction, 'reenable');
  assert.equal(preview.commandType, null);
  assert.equal(preview.eligible, 0);
  assert.equal(preview.excluded, 1);
  const create = calls.find((call) =>
    call.text.includes('cc.create_device_update_preview'),
  );
  assert.equal(create.values[4], 'reenable', 'The preview stores the action.');
  assert.equal(create.values[5], null, 'A status preview carries no mode.');
  assert.equal(create.values[6], null, 'A status preview carries no value.');
  assert.match(create.values[7], /^[a-f0-9]{64}$/);
  const targets = JSON.parse(create.values[8]);
  assert.deepEqual(
    targets.map((target) => [
      target.device_id,
      target.observed_value,
      target.disposition,
      target.exclusion_reason,
    ]),
    [['d1', 'ACTIVE', 'excluded', 'device-active']],
  );
});

test('a confirmation with no eligible target answers 422 nothing-to-update', async () => {
  const actions = actionsWith(
    databaseOf(async (text) => {
      if (text.includes('FROM cc.device_update_previews'))
        return { rows: [previewRow()] };
      if (text.includes('cc.read_device_update_preview_manifest'))
        return {
          rows: [
            {
              result: {
                outcome: 'manifest',
                manifest: {
                  preview: { previewId, manifestDigest: 'a'.repeat(64) },
                  targets: [],
                  requester: actor,
                  confirmer: actor,
                },
              },
            },
          ],
        };
      if (text.includes('cc.confirm_device_update_preview'))
        return { rows: [{ result: { outcome: 'nothing-to-update' } }] };
      return { rows: [] };
    }),
  );
  await assert.rejects(
    actions.confirm(
      session,
      current,
      previewId,
      { manifestDigest: 'a'.repeat(64), acknowledged: true },
      STATUS_PREVIEW_FAMILY,
    ),
    (error) => {
      assert.equal(error.getStatus(), 422);
      assert.deepEqual(error.getResponse(), { reason: 'nothing-to-update' });
      return true;
    },
  );
});

test('a status route does not read a command preview', async () => {
  const actions = actionsWith(
    databaseOf(async (text) =>
      text.includes('FROM cc.device_update_previews')
        ? { rows: [previewRow({ action: 'reboot' })] }
        : { rows: [] },
    ),
  );
  await assert.rejects(
    actions.previewById(session, previewId, STATUS_PREVIEW_FAMILY),
    (error) => {
      assert.equal(error.getStatus(), 404);
      assert.deepEqual(error.getResponse(), { reason: 'preview-not-found' });
      return true;
    },
  );
});

test('an empty selection answers 422 nothing-selected before any query', async () => {
  let queried = false;
  const actions = new DeviceActions(
    {
      connection: {
        query: async () => {
          queried = true;
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
  await assert.rejects(
    actions.preview(session, current, 'reboot', key),
    (error) => {
      assert.equal(error.getStatus(), 422);
      assert.deepEqual(error.getResponse(), { reason: 'nothing-selected' });
      return true;
    },
  );
  assert.equal(queried, false, 'An empty selection reaches no database.');
});

test('the command route requires devices:commands after read and Bulk Actions', async () => {
  const calls = [];
  const auth = {
    authorize: async (_session, action) => {
      calls.push(action);
      if (action === 'devices:commands')
        throw new ForbiddenException(
          'This action requires additional permission.',
        );
    },
  };
  await assert.rejects(
    requireDeviceActions(
      auth,
      session,
      customer,
      correlationId,
      DEVICE_COMMAND_ROUTE_ACTIONS,
    ),
    (error) => {
      assert.ok(error instanceof ForbiddenException);
      assert.equal(error.getStatus(), 403);
      return true;
    },
  );
  assert.deepEqual(calls, [
    'devices:read',
    'devices:bulk-actions',
    'devices:commands',
  ]);
});

test('the status route requires devices:status after read and Bulk Actions', async () => {
  const calls = [];
  const auth = {
    authorize: async (_session, action) => {
      calls.push(action);
      if (action === 'devices:status')
        throw new ForbiddenException(
          'This action requires additional permission.',
        );
    },
  };
  await assert.rejects(
    requireDeviceActions(
      auth,
      session,
      customer,
      correlationId,
      DEVICE_STATUS_ROUTE_ACTIONS,
    ),
    (error) => {
      assert.ok(error instanceof ForbiddenException);
      assert.equal(error.getStatus(), 403);
      return true;
    },
  );
  assert.deepEqual(calls, [
    'devices:read',
    'devices:bulk-actions',
    'devices:status',
  ]);
});

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
  DEVICE_ACTION_ROUTE_ACTIONS,
  requireDeviceAction,
  requireDeviceActions,
  requireReconcileActions,
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
  deprovision_reason: null,
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

test('a Powerwash preview accepts an ACTIVE device and names both refusals', () => {
  const targets = actionTargets(
    [
      device('active', 'ACTIVE'),
      device('disabled', 'DISABLED'),
      device('deprovisioned', 'DEPROVISIONED'),
      device('missing', null),
    ],
    'powerwash',
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
    ],
  );
});

test('a Deprovision preview accepts ACTIVE and DISABLED and refuses a DEPROVISIONED device', () => {
  const targets = actionTargets(
    [
      device('active', 'ACTIVE'),
      device('disabled', 'DISABLED'),
      device('deprovisioned', 'DEPROVISIONED'),
      device('missing', null),
    ],
    'deprovision',
  );
  assert.deepEqual(
    targets.map((target) => [
      target.deviceId,
      target.disposition,
      target.exclusionReason,
    ]),
    [
      ['active', 'eligible', null],
      ['disabled', 'eligible', null],
      ['deprovisioned', 'excluded', 'device-deprovisioned'],
      ['missing', 'excluded', 'status-unknown'],
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

test('a Deprovision digest covers its reason, and the other actions keep their object', () => {
  const rows = [device('d1', 'ACTIVE')];
  const retiring = actionManifestDigest(
    'deprovision',
    actionTargets(rows, 'deprovision'),
    'DEPROVISION_REASON_RETIRING_DEVICE',
  );
  assert.equal(
    retiring,
    createHash('sha256')
      .update(
        JSON.stringify({
          action: 'deprovision',
          actionVersion: 1,
          googleAction: 'DEPROVISION',
          deprovisionReason: 'DEPROVISION_REASON_RETIRING_DEVICE',
          targets: [['d1', 'ACTIVE']],
        }),
      )
      .digest('hex'),
  );
  assert.notEqual(
    retiring,
    actionManifestDigest(
      'deprovision',
      actionTargets(rows, 'deprovision'),
      'DEPROVISION_REASON_SAME_MODEL_REPLACEMENT',
    ),
    'Another reason needs another preview.',
  );
  assert.equal(
    actionManifestDigest('powerwash', actionTargets(rows, 'powerwash')),
    createHash('sha256')
      .update(
        JSON.stringify({
          action: 'powerwash',
          actionVersion: 1,
          googleAction: 'REMOTE_POWERWASH',
          targets: [['d1', 'ACTIVE']],
        }),
      )
      .digest('hex'),
    'A command digest holds no reason key.',
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
  assert.equal(create.values[5], null, 'A status preview carries no changes.');
  assert.match(create.values[6], /^[a-f0-9]{64}$/);
  const targets = JSON.parse(create.values[7]);
  assert.deepEqual(
    targets.map((target) => [
      target.device_id,
      target.observed_value,
      target.disposition,
      target.exclusion_reason,
    ]),
    [['d1', 'ACTIVE', 'excluded', 'device-active']],
  );
  assert.equal(create.values[8], 15, 'The preview expires in 15 minutes.');
  assert.equal(
    create.values[9],
    null,
    'A non-Deprovision preview carries no reason.',
  );
});

test('a Deprovision preview freezes its reason, its digest, and its SQL argument', async () => {
  const calls = [];
  const reason = 'DEPROVISION_REASON_SAME_MODEL_REPLACEMENT';
  const actions = actionsWith(
    databaseOf(async (text, values) => {
      calls.push({ text, values });
      if (text.includes('FROM cc.device_sync_state'))
        return { rows: [device('d1', 'ACTIVE'), device('d2', 'DISABLED')] };
      if (text.includes('cc.create_device_update_preview'))
        return {
          rows: [
            {
              result: {
                outcome: 'created',
                preview: previewRow({
                  action: 'deprovision',
                  deprovision_reason: reason,
                  selected: 2,
                  eligible: 2,
                  excluded: 0,
                }),
              },
            },
          ],
        };
      return { rows: [] };
    }),
  );
  const preview = await actions.preview(
    session,
    current,
    'deprovision',
    key,
    undefined,
    reason,
  );
  assert.equal(preview.action, 'deprovision');
  assert.equal(preview.commandType, null);
  assert.equal(preview.statusAction, 'deprovision');
  assert.equal(preview.deprovisionReason, reason);
  const create = calls.find((call) =>
    call.text.includes('cc.create_device_update_preview'),
  );
  assert.equal(
    create.values[4],
    'deprovision',
    'The preview stores the action.',
  );
  assert.equal(create.values[9], reason, 'The preview stores the reason.');
  assert.equal(
    create.values[6],
    actionManifestDigest(
      'deprovision',
      actionTargets(
        [device('d1', 'ACTIVE'), device('d2', 'DISABLED')],
        'deprovision',
      ),
      reason,
    ),
    'The digest covers the reason.',
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

test('the family guard checks read and Bulk Actions, then the permission of each requested action', async () => {
  const calls = [];
  const auth = { authorize: async (_session, action) => calls.push(action) };
  await requireDeviceActions(
    auth,
    session,
    customer,
    correlationId,
    DEVICE_ACTION_ROUTE_ACTIONS,
  );
  for (const action of [
    'reboot',
    'wipe-users',
    'powerwash',
    'disable',
    'reenable',
    'deprovision',
  ])
    await requireDeviceAction(auth, session, customer, correlationId, action);
  assert.deepEqual(calls, [
    'devices:read',
    'devices:bulk-actions',
    'devices:commands',
    'devices:wipe',
    'devices:wipe',
    'devices:status',
    'devices:status',
    'devices:deprovision',
  ]);
});

test('an action refusal answers 403 and the read checks still run first', async () => {
  const calls = [];
  const auth = {
    authorize: async (_session, action) => {
      calls.push(action);
      if (action === 'devices:wipe')
        throw new ForbiddenException(
          'This action requires additional permission.',
        );
    },
  };
  await requireDeviceActions(
    auth,
    session,
    customer,
    correlationId,
    DEVICE_ACTION_ROUTE_ACTIONS,
  );
  await assert.rejects(
    requireDeviceAction(auth, session, customer, correlationId, 'powerwash'),
    (error) => {
      assert.ok(error instanceof ForbiddenException);
      assert.equal(error.getStatus(), 403);
      return true;
    },
  );
  assert.deepEqual(calls, [
    'devices:read',
    'devices:bulk-actions',
    'devices:wipe',
  ]);
});

test('a preview read checks the permission of the stored action', async () => {
  const calls = [];
  const reason = 'DEPROVISION_REASON_RETIRING_DEVICE';
  const actions = actionsWith(
    databaseOf(async (text) =>
      text.includes('FROM cc.device_update_previews')
        ? {
            rows: [
              previewRow({ action: 'deprovision', deprovision_reason: reason }),
            ],
          }
        : { rows: [] },
    ),
  );
  const preview = await actions.previewById(
    session,
    previewId,
    STATUS_PREVIEW_FAMILY,
    async (action) => calls.push(action),
  );
  assert.equal(preview.action, 'deprovision');
  assert.equal(preview.deprovisionReason, reason);
  assert.deepEqual(calls, ['deprovision']);
});

test("another person's preview answers 404 before the action check", async () => {
  const calls = [];
  const actions = actionsWith(
    databaseOf(async (text) =>
      text.includes('FROM cc.device_update_previews')
        ? { rows: [previewRow({ created_by: 'other-person' })] }
        : { rows: [] },
    ),
  );
  await assert.rejects(
    actions.previewById(
      session,
      previewId,
      STATUS_PREVIEW_FAMILY,
      async (action) => calls.push(action),
    ),
    (error) => {
      assert.equal(error.getStatus(), 404);
      assert.deepEqual(error.getResponse(), { reason: 'preview-not-found' });
      return true;
    },
  );
  assert.deepEqual(calls, [], 'The refused lookup checks no action.');
});

test('a stored action that the person may not use answers 403', async () => {
  const actions = actionsWith(
    databaseOf(async (text) =>
      text.includes('FROM cc.device_update_previews')
        ? {
            rows: [
              previewRow({
                action: 'deprovision',
                deprovision_reason: 'DEPROVISION_REASON_RETIRING_DEVICE',
              }),
            ],
          }
        : { rows: [] },
    ),
  );
  await assert.rejects(
    actions.previewById(session, previewId, STATUS_PREVIEW_FAMILY, async () => {
      throw new ForbiddenException(
        'This action requires additional permission.',
      );
    }),
    (error) => {
      assert.equal(error.getStatus(), 403);
      return true;
    },
  );
});

test('a typed phrase mismatch answers 422 and stores no manifest', async () => {
  let stored = 0;
  let confirmed = 0;
  const reason = 'DEPROVISION_REASON_RETIRING_DEVICE';
  const actions = new DeviceActions(
    databaseOf(async (text) => {
      if (text.includes('FROM cc.device_update_previews'))
        return {
          rows: [
            previewRow({ action: 'deprovision', deprovision_reason: reason }),
          ],
        };
      if (text.includes('cc.read_device_update_preview_manifest'))
        return {
          rows: [
            {
              result: {
                outcome: 'manifest',
                manifest: {
                  preview: {
                    previewId,
                    action: 'deprovision',
                    manifestDigest: 'a'.repeat(64),
                  },
                  targets: [],
                },
              },
            },
          ],
        };
      if (text.includes('cc.confirm_device_update_preview')) {
        confirmed += 1;
        return { rows: [] };
      }
      return { rows: [] };
    }),
    { get: async () => selectionJson },
    {
      storeJson: async () => {
        stored += 1;
        return 'artifact';
      },
    },
  );
  for (const typedPhrase of ['WIPE', 'wipe', ' DEPROVISIONX ']) {
    await assert.rejects(
      actions.confirm(
        session,
        current,
        previewId,
        { manifestDigest: 'a'.repeat(64), acknowledged: true, typedPhrase },
        STATUS_PREVIEW_FAMILY,
      ),
      (error) => {
        assert.equal(error.getStatus(), 422, typedPhrase);
        assert.deepEqual(error.getResponse(), { reason: 'phrase-mismatch' });
        return true;
      },
    );
  }
  assert.equal(stored, 0, 'A mismatch stores no manifest.');
  assert.equal(confirmed, 0, 'A mismatch calls no confirmation function.');
});

test('the trimmed phrase reaches the confirmation function', async () => {
  const reason = 'DEPROVISION_REASON_RETIRING_DEVICE';
  let confirmValues;
  const actions = new DeviceActions(
    databaseOf(async (text, values) => {
      if (text.includes('FROM cc.device_update_previews'))
        return {
          rows: [
            previewRow({ action: 'deprovision', deprovision_reason: reason }),
          ],
        };
      if (text.includes('cc.read_device_update_preview_manifest'))
        return {
          rows: [
            {
              result: {
                outcome: 'manifest',
                manifest: {
                  preview: { previewId, manifestDigest: 'a'.repeat(64) },
                  targets: [],
                },
              },
            },
          ],
        };
      if (text.includes('cc.confirm_device_update_preview')) {
        confirmValues = values;
        return {
          rows: [
            {
              result: {
                outcome: 'created',
                receipt: {
                  jobId: '44444444-4444-4444-8444-444444444444',
                  displayId: 'STS-001',
                  status: 'accepted',
                  deviceCount: 1,
                  updateCount: 1,
                },
              },
            },
          ],
        };
      }
      return { rows: [] };
    }),
    { get: async () => selectionJson },
    { storeJson: async () => 'artifact' },
  );
  const result = await actions.confirm(
    session,
    current,
    previewId,
    {
      manifestDigest: 'a'.repeat(64),
      acknowledged: true,
      typedPhrase: ' DEPROVISION ',
    },
    STATUS_PREVIEW_FAMILY,
  );
  assert.equal(result.existing, false);
  assert.equal(confirmValues[7], 'DEPROVISION', 'The API trims the phrase.');
});

test('each Reconcile check runs its own action at the district scope', async () => {
  const cases = [
    { check: 'read', action: 'jobs:read' },
    { check: 'update', action: 'devices:write' },
    { check: 'status', action: 'devices:status' },
    { check: 'deprovision', action: 'devices:deprovision' },
  ];
  for (const { check, action } of cases) {
    const calls = [];
    const auth = {
      authorize: async (_session, granted, resource, correlation) => {
        calls.push([granted, resource, correlation]);
      },
    };
    await requireReconcileActions(
      auth,
      session,
      customer,
      correlationId,
      check,
    );
    assert.deepEqual(calls, [
      [action, { kind: 'district', customerId: customer }, correlationId],
    ]);
  }
});

test('a jobs:manage-only person reads and reconciles with the manage action', async () => {
  const manager = {
    ...session,
    identity: {
      ...session.identity,
      grants: [
        {
          action: 'jobs:manage',
          scope: { kind: 'district', customerId: customer },
        },
      ],
    },
  };
  const calls = [];
  const auth = {
    authorize: async (_session, granted, resource, correlation) => {
      calls.push([granted, resource, correlation]);
    },
  };
  await requireReconcileActions(auth, manager, customer, correlationId, 'read');
  // The manage grant carries the job read, so the read check never asks for jobs:read as well.
  assert.deepEqual(calls, [
    ['jobs:manage', { kind: 'district', customerId: customer }, correlationId],
  ]);
  // The device action of each Reconcile stays.
  calls.length = 0;
  await requireReconcileActions(
    auth,
    manager,
    customer,
    correlationId,
    'update',
  );
  assert.deepEqual(
    calls.map(([action]) => action),
    ['devices:write'],
  );
});

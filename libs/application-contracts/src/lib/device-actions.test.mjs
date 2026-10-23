import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEVICE_ACTION_PERMISSIONS,
  DEVICE_ACTION_PHRASES,
  deviceActionConfirmRequestSchema,
  deviceActionJobReceiptSchema,
  deviceActionPreviewRequestSchema,
  deviceActionPreviewSchema,
  deviceActionSchema,
  deviceActionTargetSchema,
  deviceActionTargetsPageSchema,
  deviceCommandPreviewRequestSchema,
  deviceStatusPreviewRequestSchema,
} from './device-actions.ts';

const at = '2026-10-21T12:00:00.000Z';
const digest = 'a'.repeat(64);
const selection = {
  gridId: 'devices',
  tabId: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
};

const preview = {
  previewId: '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0',
  displayId: 'PV-001',
  action: 'reboot',
  commandType: 'REBOOT',
  statusAction: null,
  deprovisionReason: null,
  selected: 3,
  eligible: 2,
  excluded: 1,
  oldestObservedAt: at,
  stale: false,
  preparedAt: at,
  expiresAt: at,
  manifestDigest: digest,
};
const reason = 'DEPROVISION_REASON_RETIRING_DEVICE';

test('the device action vocabulary holds the six actions of the second build', () => {
  assert.deepEqual(deviceActionSchema.options, [
    'reboot',
    'wipe-users',
    'powerwash',
    'disable',
    'reenable',
    'deprovision',
  ]);
  assert.equal(
    deviceActionSchema.safeParse('annotated-location').success,
    false,
  );
});

test('each action names its permission and its typed phrase', () => {
  assert.deepEqual(DEVICE_ACTION_PERMISSIONS, {
    reboot: 'devices:commands',
    'wipe-users': 'devices:wipe',
    powerwash: 'devices:wipe',
    disable: 'devices:status',
    reenable: 'devices:status',
    deprovision: 'devices:deprovision',
  });
  assert.deepEqual(DEVICE_ACTION_PHRASES, {
    'wipe-users': 'WIPE',
    powerwash: 'POWERWASH',
    deprovision: 'DEPROVISION',
  });
  assert.equal(DEVICE_ACTION_PHRASES.reboot, undefined);
});

test('the preview bodies carry the selection key and one request', () => {
  assert.deepEqual(
    deviceCommandPreviewRequestSchema.parse({
      ...selection,
      commandType: 'REBOOT',
    }),
    { ...selection, commandType: 'REBOOT' },
  );
  assert.deepEqual(
    deviceStatusPreviewRequestSchema.parse({
      ...selection,
      statusAction: 'disable',
    }),
    { ...selection, statusAction: 'disable' },
  );
  assert.equal(
    deviceActionPreviewRequestSchema.safeParse({
      ...selection,
      commandType: 'REBOOT',
      statusAction: 'disable',
    }).success,
    false,
  );
  assert.equal(
    deviceCommandPreviewRequestSchema.safeParse({
      ...selection,
      commandType: 'POWERWASH',
    }).success,
    false,
  );
  assert.deepEqual(
    deviceCommandPreviewRequestSchema.parse({
      ...selection,
      commandType: 'REMOTE_POWERWASH',
    }),
    { ...selection, commandType: 'REMOTE_POWERWASH' },
  );
  assert.deepEqual(
    deviceStatusPreviewRequestSchema.parse({
      ...selection,
      statusAction: 'deprovision',
      deprovisionReason: reason,
    }),
    { ...selection, statusAction: 'deprovision', deprovisionReason: reason },
  );
  assert.equal(
    deviceStatusPreviewRequestSchema.safeParse({
      ...selection,
      statusAction: 'deprovision',
    }).success,
    false,
  );
  assert.equal(
    deviceStatusPreviewRequestSchema.safeParse({
      ...selection,
      statusAction: 'deprovision',
      deprovisionReason: 'DEPROVISION_REASON_OTHER',
    }).success,
    false,
  );
  assert.equal(
    deviceStatusPreviewRequestSchema.safeParse({
      ...selection,
      statusAction: 'disable',
      deprovisionReason: reason,
    }).success,
    false,
  );
  assert.equal(
    deviceStatusPreviewRequestSchema.safeParse({
      ...selection,
      statusAction: 'reboot',
    }).success,
    false,
  );
});

test('a preview counts eligible and excluded only, and a Deprovision preview holds its reason', () => {
  assert.deepEqual(deviceActionPreviewSchema.parse(preview), preview);
  assert.equal(
    deviceActionPreviewSchema.safeParse({ ...preview, unchanged: 0 }).success,
    false,
  );
  assert.equal(
    deviceActionPreviewSchema.safeParse({ ...preview, eligible: 1 }).success,
    false,
  );
  assert.equal(
    deviceActionPreviewSchema.safeParse({
      ...preview,
      action: 'disable',
      commandType: null,
      statusAction: 'disable',
    }).success,
    true,
  );
  assert.equal(
    deviceActionPreviewSchema.safeParse({
      ...preview,
      action: 'reboot',
      commandType: null,
    }).success,
    false,
  );
  assert.deepEqual(
    deviceActionPreviewSchema.parse({
      ...preview,
      action: 'powerwash',
      commandType: 'REMOTE_POWERWASH',
    }),
    { ...preview, action: 'powerwash', commandType: 'REMOTE_POWERWASH' },
  );
  assert.deepEqual(
    deviceActionPreviewSchema.parse({
      ...preview,
      action: 'deprovision',
      commandType: null,
      statusAction: 'deprovision',
      deprovisionReason: reason,
    }),
    {
      ...preview,
      action: 'deprovision',
      commandType: null,
      statusAction: 'deprovision',
      deprovisionReason: reason,
    },
  );
  assert.equal(
    deviceActionPreviewSchema.safeParse({
      ...preview,
      action: 'deprovision',
      commandType: null,
      statusAction: 'deprovision',
      deprovisionReason: null,
    }).success,
    false,
    'A Deprovision preview carries a reason.',
  );
  assert.equal(
    deviceActionPreviewSchema.safeParse({
      ...preview,
      deprovisionReason: reason,
    }).success,
    false,
    'Another action carries none.',
  );
});

test('a target carries its cached status and one of two dispositions', () => {
  const target = {
    deviceId: 'device-1',
    serialNumber: 'SN-1',
    orgUnitPath: '/School A',
    observedStatus: 'ACTIVE',
    observedAt: at,
    disposition: 'eligible',
    exclusionReason: null,
  };
  assert.deepEqual(deviceActionTargetSchema.parse(target), target);
  assert.equal(
    deviceActionTargetSchema.safeParse({
      ...target,
      disposition: 'excluded',
      exclusionReason: 'device-disabled',
    }).success,
    true,
  );
  assert.equal(
    deviceActionTargetSchema.safeParse({ ...target, disposition: 'unchanged' })
      .success,
    false,
  );
  assert.equal(
    deviceActionTargetSchema.safeParse({ ...target, observedStatus: null })
      .success,
    true,
  );
  assert.equal(
    deviceActionTargetsPageSchema.safeParse({
      targets: Array(1001).fill(target),
      nextCursor: null,
    }).success,
    false,
  );
  assert.equal(
    deviceActionTargetsPageSchema.safeParse({
      targets: [target],
      nextCursor: '1',
    }).success,
    true,
  );
});

test('the confirm body and the receipt reuse the step 4 shapes', () => {
  assert.deepEqual(
    deviceActionConfirmRequestSchema.parse({
      manifestDigest: digest,
      acknowledged: true,
    }),
    { manifestDigest: digest, acknowledged: true },
  );
  assert.deepEqual(
    deviceActionConfirmRequestSchema.parse({
      manifestDigest: digest,
      acknowledged: true,
      typedPhrase: 'DEPROVISION',
    }),
    { manifestDigest: digest, acknowledged: true, typedPhrase: 'DEPROVISION' },
  );
  assert.equal(
    deviceActionConfirmRequestSchema.safeParse({
      manifestDigest: digest,
      acknowledged: true,
      typedPhrase: 'D'.repeat(65),
    }).success,
    false,
    'The phrase holds at most 64 characters.',
  );
  assert.equal(
    deviceActionConfirmRequestSchema.safeParse({
      manifestDigest: digest,
      acknowledged: true,
      typedPhrase: 7,
    }).success,
    false,
  );
  assert.equal(
    deviceActionConfirmRequestSchema.safeParse({
      manifestDigest: digest,
      acknowledged: false,
    }).success,
    false,
  );
  assert.deepEqual(
    deviceActionJobReceiptSchema.parse({
      jobId: '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0',
      displayId: 'CMD-001',
      status: 'accepted',
      deviceCount: 3,
      updateCount: 2,
    }).displayId,
    'CMD-001',
  );
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
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
  selected: 3,
  eligible: 2,
  excluded: 1,
  oldestObservedAt: at,
  stale: false,
  preparedAt: at,
  expiresAt: at,
  manifestDigest: digest,
};

test('the device action vocabulary holds the three actions of this build', () => {
  assert.deepEqual(deviceActionSchema.options, [
    'reboot',
    'disable',
    'reenable',
  ]);
  assert.equal(deviceActionSchema.safeParse('powerwash').success, false);
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
  assert.equal(
    deviceStatusPreviewRequestSchema.safeParse({
      ...selection,
      statusAction: 'reboot',
    }).success,
    false,
  );
});

test('a preview counts eligible and excluded only', () => {
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

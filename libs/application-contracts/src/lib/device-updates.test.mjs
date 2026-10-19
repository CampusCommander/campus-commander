import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEVICE_UPDATE_VALUE_MAX,
  DEVICE_WRITE_ACCESS_DENIED_MESSAGE,
  deviceUpdateConfirmRequestSchema,
  deviceUpdateJobReceiptSchema,
  deviceUpdatePreviewRequestSchema,
  deviceUpdatePreviewSchema,
  deviceUpdateTargetSchema,
  deviceUpdateTargetsSchema,
  deviceUpdateValueSchema,
  deviceWriteAccessMessage,
  deviceWriteAccessSchema,
} from './device-updates.ts';

const tabId = '6f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10';
const previewId = '9a8b7c6d-5e4f-4031-8273-6a5b4c3d2e1f';
const jobId = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';
const at = '2026-10-17T12:00:00.000Z';
const digest = 'c'.repeat(64);
const key = { gridId: 'devices', tabId };

test('preview values hold 1 to 200 code points', () => {
  // U+1D306 is one code point and two UTF-16 units.
  const fourByteCharacter = '\u{1D306}';
  assert.equal(DEVICE_UPDATE_VALUE_MAX, 200);
  assert.equal(
    deviceUpdateValueSchema.safeParse(fourByteCharacter.repeat(200)).success,
    true,
  );
  assert.equal(
    deviceUpdateValueSchema.safeParse(fourByteCharacter.repeat(201)).success,
    false,
  );
  assert.equal(deviceUpdateValueSchema.safeParse('Room 12').success, true);
  assert.equal(deviceUpdateValueSchema.safeParse(' Room 12 ').success, true);
  assert.equal(deviceUpdateValueSchema.safeParse('   ').success, false);
  assert.equal(deviceUpdateValueSchema.safeParse('').success, false);
});

test('a clear preview takes no value', () => {
  const ok = (body) => deviceUpdatePreviewRequestSchema.safeParse(body).success;
  assert.equal(ok({ ...key, mode: 'replace', value: 'Room 12' }), true);
  assert.equal(ok({ ...key, mode: 'clear' }), true);
  assert.equal(ok({ ...key, mode: 'clear', value: 'Room 12' }), false);
  assert.equal(ok({ ...key, mode: 'replace' }), false);
  assert.equal(
    ok({ ...key, mode: 'replace', value: 'Room 12', extra: true }),
    false,
  );
  assert.equal(ok({ gridId: 'users', tabId, mode: 'clear' }), false);
});

test('preview summaries carry the counts and the digest', () => {
  const preview = {
    previewId,
    displayId: 'PV-006',
    mode: 'replace',
    value: 'Room 12',
    selected: 12,
    eligible: 10,
    unchanged: 1,
    excluded: 1,
    oldestObservedAt: at,
    stale: false,
    preparedAt: at,
    expiresAt: at,
    manifestDigest: digest,
  };
  assert.deepEqual(deviceUpdatePreviewSchema.parse(preview), preview);
  assert.equal(
    deviceUpdatePreviewSchema.safeParse({ ...preview, selected: 11 }).success,
    false,
  );
  assert.equal(
    deviceUpdatePreviewSchema.safeParse({ ...preview, displayId: 'UPD-006' })
      .success,
    false,
  );
  assert.equal(
    deviceUpdatePreviewSchema.safeParse({ ...preview, manifestDigest: 'abc' })
      .success,
    false,
  );
  assert.equal(
    deviceUpdatePreviewSchema.safeParse({ ...preview, mode: 'clear' }).success,
    false,
  );
  assert.equal(
    deviceUpdatePreviewSchema.safeParse({
      ...preview,
      mode: 'clear',
      value: null,
    }).success,
    true,
  );
  assert.equal(
    deviceUpdatePreviewSchema.safeParse({ ...preview, extra: true }).success,
    false,
  );
});

test('preview targets carry the frozen rows', () => {
  const target = {
    deviceId: 'device-1',
    serialNumber: 'C0A1-7F2D',
    field: 'annotatedLocation',
    observedValue: 'Room 7',
    approvedValue: 'Room 12',
    disposition: 'eligible',
    exclusionReason: null,
  };
  assert.deepEqual(deviceUpdateTargetSchema.parse(target), target);
  assert.equal(
    deviceUpdateTargetSchema.safeParse({ ...target, disposition: 'pending' })
      .success,
    false,
  );
  assert.equal(
    deviceUpdateTargetSchema.safeParse({ ...target, extra: true }).success,
    false,
  );
  assert.equal(deviceUpdateTargetsSchema.safeParse([target]).success, true);
  assert.equal(
    deviceUpdateTargetsSchema.safeParse(Array(1000).fill(target)).success,
    true,
  );
  assert.equal(
    deviceUpdateTargetsSchema.safeParse(Array(1001).fill(target)).success,
    false,
  );
});

test('confirmation requires the digest and the acknowledgment', () => {
  const ok = (body) => deviceUpdateConfirmRequestSchema.safeParse(body).success;
  assert.equal(ok({ manifestDigest: digest, acknowledged: true }), true);
  assert.equal(ok({ manifestDigest: digest, acknowledged: false }), false);
  assert.equal(ok({ acknowledged: true }), false);
  assert.equal(
    ok({ manifestDigest: digest, acknowledged: true, extra: 1 }),
    false,
  );
  const receipt = {
    jobId,
    displayId: 'UPD-006',
    status: 'accepted',
    deviceCount: 12,
    updateCount: 10,
  };
  assert.deepEqual(deviceUpdateJobReceiptSchema.parse(receipt), receipt);
  assert.equal(
    deviceUpdateJobReceiptSchema.safeParse({ ...receipt, status: 'queued' })
      .success,
    false,
  );
});

test('write access reports the four states', () => {
  for (const state of ['granted', 'denied', 'unavailable', 'unchecked'])
    assert.equal(
      deviceWriteAccessSchema.safeParse({
        state,
        scope: null,
        failure: null,
        checkedAt: null,
      }).success,
      true,
    );
  assert.equal(
    deviceWriteAccessSchema.safeParse({
      state: 'denied',
      scope: 'https://www.googleapis.com/auth/admin.directory.device.chromeos',
      failure: 'delegation-not-authorized',
      checkedAt: at,
    }).success,
    true,
  );
  assert.equal(
    deviceWriteAccessSchema.safeParse({
      state: 'pending',
      scope: null,
      failure: null,
      checkedAt: null,
    }).success,
    false,
  );
  assert.equal(
    deviceWriteAccessSchema.safeParse({
      state: 'unavailable',
      scope: null,
      failure: 'other',
      checkedAt: at,
    }).success,
    false,
  );
  assert.equal(
    deviceWriteAccessSchema.safeParse({
      state: 'granted',
      scope: null,
      failure: null,
      checkedAt: at,
      extra: true,
    }).success,
    false,
  );
});

test('the denied write access names the write scope in its exact message', () => {
  const denied = {
    state: 'denied',
    scope: 'https://www.googleapis.com/auth/admin.directory.device.chromeos',
    failure: 'delegation-not-authorized',
    checkedAt: at,
  };
  assert.equal(
    DEVICE_WRITE_ACCESS_DENIED_MESSAGE,
    'Google denied device changes. Add https://www.googleapis.com/auth/admin.directory.device.chromeos to the delegation client in the Google Admin Console.',
  );
  assert.equal(
    deviceWriteAccessMessage(denied),
    'Google denied device changes. Add https://www.googleapis.com/auth/admin.directory.device.chromeos to the delegation client in the Google Admin Console.',
  );
  for (const state of ['granted', 'unavailable', 'unchecked'])
    assert.equal(
      deviceWriteAccessMessage({
        state,
        scope: state === 'unchecked' ? null : denied.scope,
        failure: state === 'unavailable' ? 'network-failure' : null,
        checkedAt: state === 'unchecked' ? null : at,
      }),
      null,
    );
});

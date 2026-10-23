import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEVICE_UPDATE_FIELD_LABELS,
  DEVICE_UPDATE_FIELD_LIMITS,
  DEVICE_UPDATE_FIELD_ORDER,
  DEVICE_UPDATE_SELECTION_FIELDS,
  deviceUpdateChangeSchema,
  deviceUpdateChangesInOrder,
  deviceUpdateEditSchema,
} from './devices.ts';
import {
  DEVICE_UPDATE_EDITS_LIMIT,
  DEVICE_UPDATE_VALUE_MAX,
  DEVICE_WRITE_ACCESS_BUSY_ANSWER,
  DEVICE_WRITE_ACCESS_DENIED_MESSAGE,
  deviceUpdateConfirmRequestSchema,
  deviceUpdateEditPreviewRequestSchema,
  deviceUpdateEditsSchema,
  deviceUpdateJobReceiptSchema,
  deviceUpdatePreviewRequestSchema,
  deviceUpdatePreviewSchema,
  deviceUpdateTargetSchema,
  deviceUpdateTargetsSchema,
  deviceUpdateValueSchema,
  deviceWriteAccessMessage,
  deviceWriteAccessSchema,
} from './device-updates.ts';
import { applicationErrorSchema } from './application-contracts.ts';

const tabId = '6f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10';
const previewId = '9a8b7c6d-5e4f-4031-8273-6a5b4c3d2e1f';
const jobId = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';
const at = '2026-10-17T12:00:00.000Z';
const digest = 'c'.repeat(64);
const key = { gridId: 'devices', tabId };
const change = (field, mode, value) =>
  value === undefined ? { field, mode } : { field, mode, value };
const edit = (deviceId, field, mode, value, baselineValue = null) =>
  value === undefined
    ? { deviceId, field, mode, baselineValue }
    : { deviceId, field, mode, value, baselineValue };

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

test('each field refuses a value over its limit and names its label', () => {
  const fourByteCharacter = '\u{1D306}';
  const cases = [
    ['annotatedLocation', 200],
    ['annotatedAssetId', 256],
    ['annotatedUser', 100],
    ['notes', 500],
  ];
  for (const [field, limit] of cases) {
    assert.equal(DEVICE_UPDATE_FIELD_LIMITS[field], limit);
    const label = DEVICE_UPDATE_FIELD_LABELS[field];
    // A supplementary character counts as one code point and two UTF-16 units.
    const full = change(field, 'replace', fourByteCharacter.repeat(limit));
    assert.equal(deviceUpdateChangeSchema.safeParse(full).success, true);
    const over = deviceUpdateChangeSchema.safeParse(
      change(field, 'replace', fourByteCharacter.repeat(limit + 1)),
    );
    assert.equal(over.success, false);
    assert.match(over.error.issues[0].message, new RegExp(label));
    assert.match(over.error.issues[0].message, new RegExp(String(limit)));
    // A value far above any field limit still names the field and its limit (review R1).
    const huge = deviceUpdateChangeSchema.safeParse(
      change(field, 'replace', 'x'.repeat(65_537)),
    );
    assert.equal(huge.success, false);
    assert.match(huge.error.issues[0].message, new RegExp(label));
    assert.match(huge.error.issues[0].message, new RegExp(String(limit)));
  }
  assert.equal(DEVICE_UPDATE_FIELD_LIMITS.orgUnitPath, 4096);
  assert.equal(
    deviceUpdateChangeSchema.safeParse(
      change('orgUnitPath', 'move', `/${'a'.repeat(4095)}`),
    ).success,
    true,
    'A path of 4,096 UTF-16 units is accepted.',
  );
  assert.match(
    deviceUpdateChangeSchema.safeParse(
      change('orgUnitPath', 'move', `/${'a'.repeat(4096)}`),
    ).error.issues[0].message,
    /Organization unit/,
  );
  // The preliminary bound never replaces the path rule (review R1).
  const hugePath = deviceUpdateChangeSchema.safeParse(
    change('orgUnitPath', 'move', `/${'a'.repeat(65_536)}`),
  );
  assert.equal(hugePath.success, false);
  assert.match(hugePath.error.issues[0].message, /Organization unit/);
  assert.match(hugePath.error.issues[0].message, /4096/);
});

test('an over-limit value answers the preview request with the field label', () => {
  const over = deviceUpdatePreviewRequestSchema.safeParse({
    ...key,
    changes: [change('notes', 'replace', 'x'.repeat(501))],
  });
  assert.equal(over.success, false);
  assert.match(
    over.error.issues[0].message,
    /Notes holds 1 to 500 characters\./,
  );
  const empty = deviceUpdatePreviewRequestSchema.safeParse({
    ...key,
    changes: [change('annotatedUser', 'replace', '   ')],
  });
  assert.equal(empty.success, false);
  assert.match(empty.error.issues[0].message, /Annotated user needs a visible/);
});

test('a clear change takes no value and a move takes a path', () => {
  const ok = (body) => deviceUpdatePreviewRequestSchema.safeParse(body).success;
  assert.equal(
    ok({
      ...key,
      changes: [change('annotatedLocation', 'replace', 'Room 12')],
    }),
    true,
  );
  assert.equal(
    ok({ ...key, changes: [change('annotatedLocation', 'clear')] }),
    true,
  );
  assert.equal(
    ok({ ...key, changes: [change('annotatedUser', 'clear')] }),
    true,
  );
  assert.equal(
    ok({ ...key, changes: [change('notes', 'clear', 'Room 12')] }),
    false,
    'A clear change carries no value.',
  );
  assert.equal(
    ok({ ...key, changes: [change('notes', 'replace')] }),
    false,
    'A replace change needs a value.',
  );
  assert.equal(
    ok({ ...key, changes: [change('orgUnitPath', 'move', '/High School')] }),
    true,
  );
  assert.equal(
    ok({ ...key, changes: [change('orgUnitPath', 'move', 'High School')] }),
    false,
    'A move needs a leading slash.',
  );
  assert.equal(
    ok({ ...key, changes: [change('orgUnitPath', 'replace', '/High School')] }),
    false,
    'Organization unit offers Move only.',
  );
  assert.equal(
    ok({ ...key, changes: [change('notes', 'move', '/High School')] }),
    false,
    'A text field offers no Move.',
  );
  assert.equal(
    ok({ ...key, changes: [{ ...change('notes', 'clear'), extra: true }] }),
    false,
  );
  assert.equal(ok({ gridId: 'users', tabId, changes: [] }), false);
});

test('a preview holds one to four changes and each field once', () => {
  const ok = (changes) =>
    deviceUpdatePreviewRequestSchema.safeParse({ ...key, changes }).success;
  assert.equal(ok([]), false);
  assert.equal(ok([change('notes', 'clear')]), true);
  assert.equal(
    ok([
      change('annotatedLocation', 'clear'),
      change('annotatedUser', 'clear'),
      change('notes', 'clear'),
      change('orgUnitPath', 'move', '/School A'),
    ]),
    true,
  );
  assert.equal(
    ok([
      change('notes', 'clear'),
      change('notes', 'replace', 'Room 12'),
      change('annotatedUser', 'clear'),
      change('annotatedUser', 'clear'),
      change('orgUnitPath', 'move', '/School A'),
    ]),
    false,
    'Five changes fail.',
  );
  assert.equal(
    ok([change('notes', 'clear'), change('notes', 'replace', 'Room 12')]),
    false,
    'A repeated field fails.',
  );
});

test('the record order holds five fields and the selection keeps four', () => {
  assert.deepEqual(DEVICE_UPDATE_FIELD_ORDER, [
    'annotatedLocation',
    'annotatedAssetId',
    'annotatedUser',
    'notes',
    'orgUnitPath',
  ]);
  assert.deepEqual(DEVICE_UPDATE_SELECTION_FIELDS, [
    'annotatedLocation',
    'annotatedUser',
    'notes',
    'orgUnitPath',
  ]);
});

test('Asset tag offers Replace only and needs a visible character without a trim', () => {
  assert.equal(DEVICE_UPDATE_FIELD_LABELS.annotatedAssetId, 'Asset tag');
  assert.equal(DEVICE_UPDATE_FIELD_LIMITS.annotatedAssetId, 256);
  const parse = (body) => deviceUpdateChangeSchema.safeParse(body);
  const accepted = parse(change('annotatedAssetId', 'replace', ' AT-42 '));
  assert.equal(accepted.success, true);
  assert.equal(
    accepted.data.value,
    ' AT-42 ',
    'The rule keeps the value exactly as the request holds it.',
  );
  const clear = parse(change('annotatedAssetId', 'clear'));
  assert.equal(clear.success, false);
  assert.equal(clear.error.issues[0].message, 'Asset tag offers Replace only.');
  const move = parse(change('annotatedAssetId', 'move', '/School A'));
  assert.equal(move.success, false);
  assert.equal(move.error.issues[0].message, 'Asset tag offers Replace only.');
  const spaces = parse(change('annotatedAssetId', 'replace', '   '));
  assert.equal(spaces.success, false);
  assert.equal(
    spaces.error.issues[0].message,
    'Asset tag needs a visible character.',
  );
  const missing = parse(change('annotatedAssetId', 'replace'));
  assert.equal(missing.success, false);
  assert.equal(missing.error.issues[0].message, 'Asset tag needs a value.');
});

test('a selection change of Asset tag fails', () => {
  const selection = deviceUpdatePreviewRequestSchema.safeParse({
    ...key,
    changes: [change('annotatedAssetId', 'replace', 'AT-42')],
  });
  assert.equal(selection.success, false);
  const edits = deviceUpdateEditPreviewRequestSchema.safeParse({
    edits: [edit('device-1', 'annotatedAssetId', 'replace', 'AT-42')],
  });
  assert.equal(
    edits.success,
    true,
    'An edit list accepts the field that the selection refuses.',
  );
});

test('one edit carries a device, a change, and its baseline', () => {
  const parse = (body) => deviceUpdateEditSchema.safeParse(body);
  assert.equal(
    parse({
      deviceId: 'device-1',
      field: 'notes',
      mode: 'replace',
      value: 'Room 12',
      baselineValue: null,
    }).success,
    true,
  );
  assert.equal(
    parse({
      deviceId: 'device-1',
      field: 'notes',
      mode: 'clear',
      baselineValue: 'Room 12',
    }).success,
    true,
  );
  assert.equal(
    parse({
      deviceId: '',
      field: 'notes',
      mode: 'clear',
      baselineValue: 'Room 12',
    }).success,
    false,
    'An empty device ID fails.',
  );
  assert.equal(
    parse({
      deviceId: 'd'.repeat(129),
      field: 'notes',
      mode: 'clear',
      baselineValue: 'Room 12',
    }).success,
    false,
    'A device ID above 128 units fails.',
  );
  assert.equal(
    parse({ deviceId: 'device-1', field: 'notes', mode: 'clear' }).success,
    false,
    'An omitted baseline fails.',
  );
  assert.equal(
    parse({
      deviceId: 'device-1',
      field: 'notes',
      mode: 'replace',
      value: 'Room 12',
      baselineValue: 'a'.repeat(4096),
    }).success,
    true,
    'A baseline holds 4,096 UTF-16 units.',
  );
  assert.equal(
    parse({
      deviceId: 'device-1',
      field: 'notes',
      mode: 'replace',
      value: 'Room 12',
      baselineValue: 'a'.repeat(4097),
    }).success,
    false,
    'A baseline above 4,096 units fails.',
  );
  assert.equal(
    parse({
      deviceId: 'device-1',
      field: 'notes',
      mode: 'replace',
      value: 'Room 12',
      baselineValue: null,
      extra: true,
    }).success,
    false,
  );
  assert.equal(
    parse({
      deviceId: 'device-1',
      field: 'assetTag',
      mode: 'replace',
      value: 'AT-42',
      baselineValue: null,
    }).success,
    false,
    'The record key is not the field ID.',
  );
});

test('an edit whose request equals its baseline fails', () => {
  const equal = (body) => {
    const parsed = deviceUpdateEditSchema.safeParse(body);
    assert.equal(parsed.success, false);
    return parsed.error.issues[0].message;
  };
  assert.equal(
    equal({
      deviceId: 'device-1',
      field: 'notes',
      mode: 'replace',
      value: 'Room 12',
      baselineValue: 'Room 12',
    }),
    'Notes already holds this value.',
  );
  assert.equal(
    equal({
      deviceId: 'device-1',
      field: 'notes',
      mode: 'clear',
      baselineValue: null,
    }),
    'Notes already holds this value.',
    'A Clear of a field that holds no value changes nothing.',
  );
  assert.equal(
    equal({
      deviceId: 'device-1',
      field: 'orgUnitPath',
      mode: 'move',
      value: '/School A',
      baselineValue: '/school a',
    }),
    'Organization unit already holds this value.',
    'Paths compare without case.',
  );
  assert.equal(
    deviceUpdateEditSchema.safeParse({
      deviceId: 'device-1',
      field: 'orgUnitPath',
      mode: 'move',
      value: '/School B',
      baselineValue: '/school a',
    }).success,
    true,
  );
  assert.equal(
    deviceUpdateEditSchema.safeParse({
      deviceId: 'device-1',
      field: 'notes',
      mode: 'replace',
      value: 'Room 12',
      baselineValue: 'Room 1',
    }).success,
    true,
    'A text baseline compares exactly.',
  );
});

test('an edit list holds 1 to 2,500 edits on at most 500 devices', () => {
  const devices = (count) =>
    Array.from({ length: count }, (_, index) => `device-${index + 1}`);
  const everyField = (deviceId) =>
    DEVICE_UPDATE_FIELD_ORDER.map((field) =>
      field === 'orgUnitPath'
        ? edit(deviceId, field, 'move', '/School A')
        : edit(deviceId, field, 'replace', 'value'),
    );
  assert.equal(DEVICE_UPDATE_EDITS_LIMIT, 2500);
  assert.equal(deviceUpdateEditsSchema.safeParse([]).success, false);
  assert.equal(
    deviceUpdateEditsSchema.safeParse([...everyField('device-1')]).success,
    true,
  );
  // 500 devices with all five fields fill the edit cap exactly.
  const full = devices(500).flatMap(everyField);
  assert.equal(full.length, DEVICE_UPDATE_EDITS_LIMIT);
  assert.equal(deviceUpdateEditsSchema.safeParse(full).success, true);
  assert.equal(
    deviceUpdateEditsSchema.safeParse([
      ...full,
      edit('device-1', 'notes', 'replace', 'another value'),
    ]).success,
    false,
    'A 2,501st edit fails.',
  );
  const refusedDevices = deviceUpdateEditsSchema.safeParse(
    devices(501).map((deviceId) => edit(deviceId, 'notes', 'replace', 'value')),
  );
  assert.equal(refusedDevices.success, false);
  assert.equal(
    refusedDevices.error.issues[0].message,
    'An edit list holds at most 500 devices.',
  );
  const repeated = deviceUpdateEditsSchema.safeParse([
    edit('device-1', 'notes', 'replace', 'value'),
    edit('device-1', 'notes', 'replace', 'another value'),
  ]);
  assert.equal(repeated.success, false);
  assert.equal(
    repeated.error.issues[0].message,
    'A device and field occur once.',
  );
  assert.equal(
    deviceUpdateEditsSchema.safeParse([
      edit('device-1', 'notes', 'replace', 'value'),
      edit('device-1', 'annotatedUser', 'replace', 'value'),
    ]).success,
    true,
    'One device may hold several fields.',
  );
});

test('an edit-list request takes the edits alone', () => {
  const request = {
    edits: [edit('device-1', 'notes', 'replace', 'Room 12')],
  };
  assert.deepEqual(
    deviceUpdateEditPreviewRequestSchema.parse(request),
    request,
  );
  assert.equal(
    deviceUpdateEditPreviewRequestSchema.safeParse({ ...request, ...key })
      .success,
    false,
    'The edit list carries no selection key.',
  );
  assert.equal(
    deviceUpdateEditPreviewRequestSchema.safeParse({}).success,
    false,
  );
});

test('a preview summary answers no changes for an edit list and counts conflicts', () => {
  const editList = {
    previewId,
    displayId: 'PV-006',
    changes: null,
    fieldChanges: 9,
    selected: 8,
    eligible: 4,
    unchanged: 1,
    excluded: 1,
    conflicts: 2,
    oldestObservedAt: at,
    stale: false,
    preparedAt: at,
    expiresAt: at,
    manifestDigest: digest,
  };
  assert.deepEqual(deviceUpdatePreviewSchema.parse(editList), editList);
  assert.equal(
    deviceUpdatePreviewSchema.safeParse({ ...editList, conflicts: undefined })
      .success,
    false,
    'A summary always counts its conflicts.',
  );
  assert.equal(
    deviceUpdatePreviewSchema.safeParse({ ...editList, selected: 6 }).success,
    false,
    'Selected equals eligible, unchanged, excluded, and conflicts.',
  );
  assert.equal(
    deviceUpdatePreviewSchema.safeParse({
      ...editList,
      changes: [change('notes', 'clear')],
    }).success,
    true,
    'A selection preview still carries its changes.',
  );
});

test('a target row carries its baseline, a duplicate serial number, and a conflict', () => {
  const conflict = {
    deviceId: 'device-1',
    serialNumber: 'C0A1-7F2D',
    field: 'annotatedAssetId',
    observedValue: 'AT-02',
    baselineValue: 'AT-01',
    approvedValue: 'AT-02',
    duplicateSerialNumber: 'C0A1-7F2E',
    disposition: 'conflict',
    exclusionReason: null,
  };
  assert.deepEqual(deviceUpdateTargetSchema.parse(conflict), conflict);
  assert.equal(
    deviceUpdateTargetSchema.safeParse({
      ...conflict,
      baselineValue: null,
      duplicateSerialNumber: null,
    }).success,
    true,
  );
  assert.equal(
    deviceUpdateTargetSchema.safeParse({
      ...conflict,
      baselineValue: 'a'.repeat(4097),
    }).success,
    false,
  );
  assert.equal(
    deviceUpdateTargetSchema.safeParse({
      ...conflict,
      duplicateSerialNumber: 'S'.repeat(257),
    }).success,
    false,
  );
  for (const key of ['baselineValue', 'duplicateSerialNumber']) {
    const target = { ...conflict };
    delete target[key];
    assert.equal(
      deviceUpdateTargetSchema.safeParse(target).success,
      false,
      `${key} is required.`,
    );
  }
});

test('preview summaries carry the changes, fieldChanges, and the counts', () => {
  const changes = [
    change('annotatedUser', 'replace', 'A person'),
    change('notes', 'replace', 'Room 12'),
  ];
  const preview = {
    previewId,
    displayId: 'PV-006',
    changes,
    fieldChanges: 11,
    selected: 12,
    eligible: 6,
    unchanged: 5,
    excluded: 1,
    conflicts: 0,
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
    deviceUpdatePreviewSchema.safeParse({ ...preview, changes: [] }).success,
    false,
    'A preview carries at least one change.',
  );
  assert.equal(
    deviceUpdatePreviewSchema.safeParse({ ...preview, fieldChanges: -1 })
      .success,
    false,
  );
  assert.equal(
    deviceUpdatePreviewSchema.safeParse({ ...preview, extra: true }).success,
    false,
  );
  assert.equal(
    deviceUpdatePreviewSchema.safeParse({ ...preview, mode: 'replace' })
      .success,
    false,
    'The summary no longer carries one mode.',
  );
});

test('changes sort into contract order', () => {
  assert.deepEqual(
    deviceUpdateChangesInOrder([
      change('orgUnitPath', 'move', '/School A'),
      change('notes', 'clear'),
      change('annotatedLocation', 'replace', 'Room 12'),
    ]).map((entry) => entry.field),
    ['annotatedLocation', 'notes', 'orgUnitPath'],
  );
});

test('preview targets carry the frozen rows of one field', () => {
  const target = {
    deviceId: 'device-1',
    serialNumber: 'C0A1-7F2D',
    field: 'annotatedUser',
    observedValue: 'A person',
    baselineValue: 'A person',
    approvedValue: 'Another person',
    duplicateSerialNumber: null,
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
    deviceUpdateTargetSchema.safeParse({ ...target, field: 'assetTag' })
      .success,
    false,
  );
  assert.equal(
    deviceUpdateTargetSchema.safeParse({
      ...target,
      approvedValue: 'a'.repeat(4096),
    }).success,
    true,
    'An approved value widens to 4,096 UTF-16 units.',
  );
  assert.equal(
    deviceUpdateTargetSchema.safeParse({
      ...target,
      approvedValue: 'a'.repeat(4097),
    }).success,
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

test('the check route documents the busy answer inside the interval', () => {
  assert.deepEqual(DEVICE_WRITE_ACCESS_BUSY_ANSWER, {
    status: 429,
    reason: 'busy',
  });
  assert.equal(
    applicationErrorSchema.safeParse({
      code: 'busy',
      message: 'A check is already running. Wait before another request.',
      correlationId: '33333333-3333-4333-8333-333333333333',
    }).success,
    true,
    'The busy code is part of the application error vocabulary.',
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

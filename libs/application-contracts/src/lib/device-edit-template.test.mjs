import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  DEPROVISION_REASON_LABELS,
  DEPROVISION_REASONS,
  DEVICE_UPDATE_FIELD_LABELS,
  DEVICE_UPDATE_FIELD_LIMITS,
  deviceUpdateChangeSchema,
} from './devices.ts';
import {
  DEVICE_DEPROVISION_CODES,
  DEVICE_DEPROVISION_REASON_CODES,
  DEVICE_EDIT_CLEAR_TOKEN,
  DEVICE_EDIT_TEMPLATE_COLUMNS,
  DEVICE_EDIT_TEMPLATE_HEADERS,
  DEVICE_EDIT_TEMPLATE_SCHEMA_VERSION,
  DEVICE_IMPORT_MODES,
  DEVICE_IMPORT_MODE_DEFAULT,
  DEVICE_IMPORT_MODE_LABELS,
  DEVICE_STATUS_CELL_CODES,
  DEVICE_STATUS_CELL_REFUSAL,
  GOOGLE_DEVICE_STATUSES,
  deviceEditCanonicalFieldValue,
  deviceEditCanonicalStatusCell,
  deviceEditCanonicalValue,
  deviceEditChecksumIsWellFormed,
  deviceEditColumnRoleSchema,
  deviceEditEscapeCell,
  deviceEditFieldCellIntent,
  deviceEditFieldChange,
  deviceEditRowChecksum,
  deviceEditRowChecksumValues,
  deviceEditStatusCellIntent,
  deviceEditUnescapeCell,
  deviceImportModeSchema,
  matchDeviceEditHeaders,
} from './device-edit-template.ts';

const columns = DEVICE_EDIT_TEMPLATE_COLUMNS;
const column = (key) => {
  const found = columns.find((entry) => entry.key === key);
  assert.notEqual(found, undefined);
  return found;
};
const goldenRow = {
  deviceId: 'DEV-0001',
  status: 'ACTIVE',
  annotatedAssetId: 'A-00042',
  annotatedLocation: 'Main Office',
  annotatedUser: 'jdoe@example.org',
  notes: 'Line one\nLine two',
  orgUnitPath: '/Schools/East/Main',
};
const row = (overrides) => ({ ...goldenRow, ...overrides });
const fields = [
  'annotatedAssetId',
  'annotatedLocation',
  'annotatedUser',
  'notes',
  'orgUnitPath',
];
const statusOf = (cell) => deviceEditStatusCellIntent(cell);
const changeOf = (field, cell) => deviceEditFieldChange(field, cell);

test('the template holds the ten columns of section 7.1 in template order', () => {
  assert.equal(DEVICE_EDIT_TEMPLATE_SCHEMA_VERSION, 1);
  assert.deepEqual(
    columns.map((entry) => entry.key),
    [
      'deviceId',
      'serialNumber',
      'model',
      'status',
      'annotatedAssetId',
      'annotatedLocation',
      'annotatedUser',
      'notes',
      'orgUnitPath',
      'checksum',
    ],
  );
  assert.deepEqual(
    columns.map((entry) => entry.role),
    [
      'identity',
      'context',
      'context',
      'editable',
      'editable',
      'editable',
      'editable',
      'editable',
      'editable',
      'checksum',
    ],
  );
  assert.deepEqual(
    columns.filter((entry) => entry.checksummed).map((entry) => entry.key),
    [
      'deviceId',
      'status',
      'annotatedAssetId',
      'annotatedLocation',
      'annotatedUser',
      'notes',
      'orgUnitPath',
    ],
  );
  assert.deepEqual(DEVICE_EDIT_TEMPLATE_HEADERS, [
    'Device ID',
    'Serial number',
    'Model',
    'Status',
    'Asset tag',
    'Annotated location',
    'Annotated user',
    'Notes',
    'Organization unit',
    'Checksum',
  ]);
  for (const entry of columns)
    assert.equal(
      deviceEditColumnRoleSchema.safeParse(entry.role).success,
      true,
    );
});

test('the five field headers are the labels and the limits stay in devices.ts', () => {
  const editable = columns.filter((entry) => entry.field !== undefined);
  assert.deepEqual(
    editable.map((entry) => entry.field),
    [
      'annotatedAssetId',
      'annotatedLocation',
      'annotatedUser',
      'notes',
      'orgUnitPath',
    ],
  );
  for (const entry of editable) {
    assert.equal(entry.header, DEVICE_UPDATE_FIELD_LABELS[entry.field]);
    assert.equal(
      Number.isInteger(DEVICE_UPDATE_FIELD_LIMITS[entry.field]),
      true,
    );
    // No column copies a field rule. The change schema reads the limit.
    assert.deepEqual(Object.keys(entry).sort(), [
      'checksummed',
      'field',
      'header',
      'key',
      'role',
    ]);
  }
  assert.equal(column('status').field, undefined);
  assert.deepEqual(Object.keys(column('deviceId')).sort(), [
    'checksummed',
    'header',
    'key',
    'role',
  ]);
});

test('the import modes of section 8.5 export their schema', () => {
  assert.deepEqual(DEVICE_IMPORT_MODES, ['sync-changes', 'sync-all-rows']);
  assert.equal(DEVICE_IMPORT_MODE_DEFAULT, 'sync-changes');
  assert.deepEqual(DEVICE_IMPORT_MODE_LABELS, {
    'sync-changes': 'Sync changes',
    'sync-all-rows': 'Sync all rows',
  });
  for (const mode of DEVICE_IMPORT_MODES) {
    assert.equal(deviceImportModeSchema.safeParse(mode).success, true);
    assert.equal(DEVICE_IMPORT_MODE_LABELS[mode].length > 0, true);
  }
  for (const mode of ['sync', 'Sync changes', '', 'sync-all'])
    assert.equal(deviceImportModeSchema.safeParse(mode).success, false);
});

test('the four reason codes derive from DEPROVISION_REASONS with their labels', () => {
  assert.deepEqual(DEPROVISION_REASONS, [
    'DEPROVISION_REASON_RETIRING_DEVICE',
    'DEPROVISION_REASON_DIFFERENT_MODEL_REPLACEMENT',
    'DEPROVISION_REASON_SAME_MODEL_REPLACEMENT',
    'DEPROVISION_REASON_UPGRADE_TRANSFER',
  ]);
  assert.deepEqual(
    DEVICE_DEPROVISION_CODES.map((entry) => entry.code),
    [
      'RETIRING_DEVICE',
      'DIFFERENT_MODEL_REPLACEMENT',
      'SAME_MODEL_REPLACEMENT',
      'UPGRADE_TRANSFER',
    ],
  );
  assert.deepEqual(DEVICE_DEPROVISION_REASON_CODES, [
    'RETIRING_DEVICE',
    'DIFFERENT_MODEL_REPLACEMENT',
    'SAME_MODEL_REPLACEMENT',
    'UPGRADE_TRANSFER',
  ]);
  for (const entry of DEVICE_DEPROVISION_CODES) {
    assert.equal(`DEPROVISION_REASON_${entry.code}`, entry.reason);
    assert.equal(entry.label, DEPROVISION_REASON_LABELS[entry.reason]);
  }
});

test('a golden vector pins the checksum of one fixed row', async () => {
  const input =
    '[1,"DEV-0001","ACTIVE","A-00042","Main Office","jdoe@example.org","Line one\\nLine two","/schools/east/main"]';
  const digest = createHash('sha256').update(input, 'utf8').digest();
  const firstBytes = digest.subarray(0, 16);
  assert.equal(firstBytes.toString('base64url').length, 22);
  const expected = `1.${firstBytes.toString('base64url')}`;
  assert.equal(DEVICE_EDIT_TEMPLATE_SCHEMA_VERSION, 1);
  assert.equal(JSON.stringify(deviceEditRowChecksumValues(goldenRow)), input);
  assert.deepEqual(deviceEditRowChecksumValues(goldenRow), JSON.parse(input));
  assert.equal(await deviceEditRowChecksum(goldenRow), expected);
  assert.equal(expected.length, 24);
  assert.equal(/^1\.[A-Za-z0-9_-]{22}$/.test(expected), true);
  assert.equal(deviceEditChecksumIsWellFormed(expected), true);
});

test('canonical text unifies line ends and Unicode and keeps inner spaces', () => {
  assert.equal(deviceEditCanonicalValue(''), '');
  assert.equal(deviceEditCanonicalValue('   '), '');
  assert.equal(deviceEditCanonicalValue('\t\r\n'), '');
  assert.equal(
    deviceEditCanonicalValue('Line one\r\nLine two'),
    'Line one\nLine two',
  );
  assert.equal(
    deviceEditCanonicalValue('Line one\rLine two'),
    'Line one\nLine two',
  );
  assert.equal(
    deviceEditCanonicalValue('Line one\nLine two'),
    'Line one\nLine two',
  );
  assert.equal(deviceEditCanonicalValue('Cafe\u0301'), 'Caf\u00e9');
  assert.equal(deviceEditCanonicalValue(' Room 12 '), ' Room 12 ');
  assert.equal(
    deviceEditCanonicalValue('He said "hello", twice.'),
    'He said "hello", twice.',
  );
  assert.equal(deviceEditCanonicalValue('0001234'), '0001234');
  // The Status cell keeps its letter case and drops its outer spaces.
  assert.equal(deviceEditCanonicalStatusCell(' ACTIVE '), 'ACTIVE');
  assert.equal(deviceEditCanonicalStatusCell(' active '), 'active');
  // An Organization unit path compares without case.
  assert.equal(
    deviceEditCanonicalFieldValue('orgUnitPath', '/Schools/East/Main'),
    '/schools/east/main',
  );
  assert.equal(
    deviceEditCanonicalFieldValue('annotatedLocation', ' Main Office '),
    ' Main Office ',
  );
});

test('NFC and NFD, CRLF and CR and LF, and path case give one checksum', async () => {
  const base = await deviceEditRowChecksum(goldenRow);
  assert.equal(
    base,
    await deviceEditRowChecksum(row({ notes: 'Line one\r\nLine two' })),
  );
  assert.equal(
    base,
    await deviceEditRowChecksum(row({ notes: 'Line one\rLine two' })),
  );
  assert.equal(
    base,
    await deviceEditRowChecksum(row({ notes: 'Line one\nLine two' })),
  );
  assert.equal(
    base,
    await deviceEditRowChecksum(row({ orgUnitPath: '/schools/EAST/main' })),
  );
  assert.equal(
    base,
    await deviceEditRowChecksum(row({ orgUnitPath: '/SCHOOLS/EAST/MAIN' })),
  );
  const composed = await deviceEditRowChecksum(row({ notes: 'Caf\u00e9' }));
  const decomposed = await deviceEditRowChecksum(row({ notes: 'Cafe\u0301' }));
  assert.equal(composed, decomposed);
  assert.notEqual(
    composed,
    await deviceEditRowChecksum(row({ notes: 'Cafe' })),
  );
  // A four-byte character takes part in the digest and a trailing space counts.
  const music = '\u{1D306}';
  assert.equal(
    await deviceEditRowChecksum(row({ notes: music })),
    await deviceEditRowChecksum(row({ notes: music })),
  );
  assert.notEqual(
    await deviceEditRowChecksum(row({ notes: music })),
    await deviceEditRowChecksum(row({ notes: `${music} ` })),
  );
});

test('a clear and a blank give two checksums, and a clear token has one form', async () => {
  const blank = await deviceEditRowChecksum(row({ notes: '' }));
  const clear = await deviceEditRowChecksum(
    row({ notes: DEVICE_EDIT_CLEAR_TOKEN }),
  );
  assert.notEqual(blank, clear);
  assert.equal(clear, await deviceEditRowChecksum(row({ notes: '[CLEAR]' })));
  assert.equal(
    clear,
    await deviceEditRowChecksum(row({ notes: '  [Clear]  ' })),
  );
  assert.notEqual(
    await deviceEditRowChecksum(row({ notes: '[ clear ]' })),
    clear,
  );
  assert.equal(
    deviceEditRowChecksumValues(row({ notes: '[CLEAR]' }))[6],
    DEVICE_EDIT_CLEAR_TOKEN,
  );
});

test('the status cell changes the checksum and a blank does not add a value', async () => {
  const active = await deviceEditRowChecksum(row({ status: 'ACTIVE' }));
  assert.notEqual(
    active,
    await deviceEditRowChecksum(row({ status: 'DISABLED' })),
  );
  assert.notEqual(
    active,
    await deviceEditRowChecksum(row({ status: 'DEPROVISIONED' })),
  );
  assert.equal(
    active,
    await deviceEditRowChecksum(row({ status: ' ACTIVE ' })),
  );
  assert.notEqual(
    await deviceEditRowChecksum(row({ status: 'active' })),
    active,
  );
  assert.equal(deviceEditRowChecksumValues(row({ status: '' }))[2], '');
});

test('a null cell is empty text at the canonical boundary (section 8.2)', async () => {
  // Section 8.2: null, empty text, and spaces only become empty text.
  assert.equal(deviceEditCanonicalValue(null), '');
  assert.equal(deviceEditCanonicalStatusCell(null), '');
  for (const field of fields)
    assert.equal(deviceEditCanonicalFieldValue(field, null), '', field);
  const emptyRow = {
    deviceId: 'DEV-0001',
    status: null,
    annotatedAssetId: null,
    annotatedLocation: null,
    annotatedUser: null,
    notes: null,
    orgUnitPath: null,
  };
  assert.deepEqual(deviceEditRowChecksumValues(emptyRow), [
    1,
    'DEV-0001',
    '',
    '',
    '',
    '',
    '',
    '',
  ]);
  // A null cell, an empty cell, and a spaces-only cell give one checksum.
  const goldenBlank = await deviceEditRowChecksum(row({ notes: '' }));
  assert.equal(await deviceEditRowChecksum(row({ notes: null })), goldenBlank);
  assert.equal(await deviceEditRowChecksum(row({ notes: '   ' })), goldenBlank);
  for (const field of fields) {
    const empty = await deviceEditRowChecksum(row({ [field]: '' }));
    assert.equal(
      await deviceEditRowChecksum(row({ [field]: null })),
      empty,
      field,
    );
    assert.equal(
      await deviceEditRowChecksum(row({ [field]: ' \t ' })),
      empty,
      field,
    );
    // The clear token keeps its own value in every position.
    assert.notEqual(
      await deviceEditRowChecksum(row({ [field]: DEVICE_EDIT_CLEAR_TOKEN })),
      empty,
      field,
    );
  }
  const blankStatus = await deviceEditRowChecksum(row({ status: '' }));
  assert.equal(await deviceEditRowChecksum(row({ status: null })), blankStatus);
  assert.equal(
    await deviceEditRowChecksum(row({ status: '   ' })),
    blankStatus,
  );
  assert.equal(deviceEditRowChecksumValues(row({ status: null }))[2], '');
});

test('a row with quotes, commas, and leading zeros keeps its values', async () => {
  const special = row({
    annotatedAssetId: '0001234',
    annotatedLocation: 'Room 12, Building A',
    notes: 'He said "hello", twice.\nRoom 12.',
  });
  assert.deepEqual(deviceEditRowChecksumValues(special), [
    1,
    'DEV-0001',
    'ACTIVE',
    '0001234',
    'Room 12, Building A',
    'jdoe@example.org',
    'He said "hello", twice.\nRoom 12.',
    '/schools/east/main',
  ]);
  const cell = await deviceEditRowChecksum(special);
  assert.equal(deviceEditChecksumIsWellFormed(cell), true);
  assert.equal(
    cell,
    await deviceEditRowChecksum(
      row({ ...special, notes: 'He said "hello", twice.\nRoom 12.' }),
    ),
  );
});

test('each row of the status table maps to its effect', () => {
  assert.deepEqual(statusOf(''), {
    ok: true,
    intent: { intent: 'none', status: null },
  });
  assert.deepEqual(statusOf('   '), {
    ok: true,
    intent: { intent: 'none', status: null },
  });
  assert.deepEqual(statusOf(' ACTIVE '), {
    ok: true,
    intent: { intent: 'reenable' },
  });
  assert.deepEqual(statusOf('DISABLED'), {
    ok: true,
    intent: { intent: 'disable' },
  });
  for (const status of GOOGLE_DEVICE_STATUSES) {
    const result = statusOf(status);
    assert.equal(result.ok, true, status);
    if (status === 'ACTIVE')
      assert.equal(result.intent.intent, 'reenable', status);
    else if (status === 'DISABLED')
      assert.equal(result.intent.intent, 'disable', status);
    else {
      assert.deepEqual(result.intent, { intent: 'none', status }, status);
    }
  }
  for (const entry of DEVICE_DEPROVISION_CODES) {
    assert.deepEqual(statusOf(`DEPROVISION:${entry.code}`), {
      ok: true,
      intent: { intent: 'deprovision', reason: entry.reason },
    });
    assert.deepEqual(statusOf(`  DEPROVISION:${entry.code} `), {
      ok: true,
      intent: { intent: 'deprovision', reason: entry.reason },
    });
  }
});

test('a Status cell that holds no code rejects and names the code list', () => {
  for (const cell of [
    'active',
    'Active',
    'DISABLD',
    'DEPROVISION',
    'DEPROVISION:',
    'DEPROVISION:FOO',
    'deprovision:RETIRING_DEVICE',
    '[clear]',
    '[CLEAR]',
    'ENABLED',
    'Disabled',
  ]) {
    const result = statusOf(cell);
    assert.equal(result.ok, false, cell);
    assert.equal(result.reason, DEVICE_STATUS_CELL_REFUSAL, cell);
    for (const name of [
      'ACTIVE',
      'DISABLED',
      'DEPROVISION:',
      ...DEVICE_DEPROVISION_REASON_CODES,
    ])
      assert.equal(result.reason.includes(name), true, `${cell} names ${name}`);
  }
  // An export-only Google value requests nothing and does not reject.
  assert.deepEqual(statusOf('DEPROVISIONED'), {
    ok: true,
    intent: { intent: 'none', status: 'DEPROVISIONED' },
  });
});

test('the Status cell codes of section 7.5 are listed for the import sheet', () => {
  assert.deepEqual(DEVICE_STATUS_CELL_CODES, [
    'ACTIVE',
    'DISABLED',
    'DEPROVISION:<reason code>',
  ]);
  assert.equal(
    DEVICE_STATUS_CELL_REFUSAL.includes('DEPROVISION:<reason code>'),
    true,
  );
});

test('a field cell keeps, clears, or assigns (section 7.3)', () => {
  assert.deepEqual(deviceEditFieldCellIntent(''), { intent: 'keep' });
  assert.deepEqual(deviceEditFieldCellIntent('   '), { intent: 'keep' });
  assert.deepEqual(deviceEditFieldCellIntent('[clear]'), { intent: 'clear' });
  assert.deepEqual(deviceEditFieldCellIntent('[CLEAR]'), { intent: 'clear' });
  assert.deepEqual(deviceEditFieldCellIntent(' [Clear] '), { intent: 'clear' });
  assert.deepEqual(deviceEditFieldCellIntent(' Room 12 '), {
    intent: 'assign',
    value: ' Room 12 ',
  });
  assert.deepEqual(deviceEditFieldCellIntent('[ clear ]'), {
    intent: 'assign',
    value: '[ clear ]',
  });
});

test('a field change passes deviceUpdateChangeSchema or returns its reason', () => {
  assert.deepEqual(changeOf('notes', ''), { ok: true, change: null });
  const assign = changeOf('notes', 'Room 12\nSecond line');
  assert.deepEqual(assign, {
    ok: true,
    change: {
      field: 'notes',
      mode: 'replace',
      value: 'Room 12\nSecond line',
    },
  });
  assert.equal(deviceUpdateChangeSchema.safeParse(assign.change).success, true);
  const spaced = changeOf('annotatedUser', ' Room 12 ');
  assert.deepEqual(spaced.change.value, ' Room 12 ');
  for (const field of ['annotatedLocation', 'annotatedUser', 'notes']) {
    const clear = changeOf(field, '[clear]');
    assert.deepEqual(clear, { ok: true, change: { field, mode: 'clear' } });
    assert.equal(
      deviceUpdateChangeSchema.safeParse(clear.change).success,
      true,
    );
  }
  for (const field of ['annotatedAssetId', 'orgUnitPath']) {
    const clear = changeOf(field, '[clear]');
    assert.equal(clear.ok, false, field);
    assert.equal(
      clear.reason.includes(DEVICE_UPDATE_FIELD_LABELS[field]),
      true,
    );
    assert.equal(clear.reason.includes('cannot be cleared'), true);
  }
  const move = changeOf('orgUnitPath', '/Schools/East/Main');
  assert.deepEqual(move, {
    ok: true,
    change: {
      field: 'orgUnitPath',
      mode: 'move',
      value: '/Schools/East/Main',
    },
  });
  assert.equal(deviceUpdateChangeSchema.safeParse(move.change).success, true);
  const noPath = changeOf('orgUnitPath', 'Schools/East');
  assert.equal(noPath.ok, false);
  assert.equal(noPath.reason.includes('Organization unit'), true);
  assert.equal(noPath.reason.includes('starts with /'), true);
  // The limits come from DEVICE_UPDATE_FIELD_LIMITS.
  for (const field of [
    'annotatedAssetId',
    'annotatedLocation',
    'annotatedUser',
    'notes',
    'orgUnitPath',
  ]) {
    const limit = DEVICE_UPDATE_FIELD_LIMITS[field];
    const atLimit =
      field === 'orgUnitPath' ? `/${'a'.repeat(limit - 1)}` : 'a'.repeat(limit);
    const overLimit =
      field === 'orgUnitPath' ? `/${'a'.repeat(limit)}` : 'a'.repeat(limit + 1);
    assert.equal(changeOf(field, atLimit).ok, true, field);
    const refused = changeOf(field, overLimit);
    assert.equal(refused.ok, false, field);
    assert.equal(refused.reason.includes(String(limit)), true, field);
  }
});

test('the formula escape round trip restores each value', () => {
  for (const value of [
    '=SUM(A1:A2)',
    '+1',
    '-1',
    '@example.org',
    '\tHello',
    '\rHello',
    '\r\nHello',
    '\t\tHello',
    '-2,000',
  ])
    assert.equal(
      deviceEditUnescapeCell(deviceEditEscapeCell(value)),
      value,
      value,
    );
  for (const value of ['=SUM(A1:A2)', '+1', '-1', '@x', '\tHello', '\rHello'])
    assert.equal(deviceEditEscapeCell(value), `\t${value}`, value);
  assert.equal(deviceEditEscapeCell('Room 12'), 'Room 12');
  assert.equal(deviceEditEscapeCell(''), '');
  assert.equal(deviceEditUnescapeCell('Room 12'), 'Room 12');
  assert.equal(deviceEditUnescapeCell(''), '');
  // A value that a person starts with a tab and another character stays unchanged.
  assert.equal(deviceEditUnescapeCell('\tHello'), '\tHello');
  assert.equal(deviceEditUnescapeCell('\t'), '\t');
  // The export tab of a value that starts with a tab is removed once.
  assert.equal(deviceEditUnescapeCell('\t\tHello'), '\tHello');
});

const templateHeaders = DEVICE_EDIT_TEMPLATE_HEADERS;

test('header matching maps the template in any order, letter case, and padding', () => {
  const direct = matchDeviceEditHeaders(templateHeaders);
  assert.equal(direct.ok, true);
  assert.deepEqual(
    direct.match.columns.map((entry) => entry.key),
    columns.map((entry) => entry.key),
  );
  assert.deepEqual(
    direct.match.columns.map((entry) => entry.index),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  );
  assert.deepEqual(direct.match.unknown, []);
  assert.deepEqual(direct.match.warnings, []);
  const reordered = [...templateHeaders]
    .reverse()
    .map((header, index) =>
      index % 2 === 0 ? ` ${header.toUpperCase()} ` : header.toLowerCase(),
    );
  const shuffled = matchDeviceEditHeaders(reordered);
  assert.equal(shuffled.ok, true);
  for (const [position, entry] of shuffled.match.columns.entries()) {
    assert.equal(entry.key, columns[position].key);
    assert.equal(entry.index, templateHeaders.length - 1 - position);
  }
  // A byte order mark on the first header stays outside the match.
  const marked = templateHeaders.map((header, index) =>
    index === 0 ? `\uFEFF${header}` : header,
  );
  assert.equal(matchDeviceEditHeaders(marked).ok, true);
});

test('header matching refuses a missing column and names it', () => {
  const missingModel = matchDeviceEditHeaders(
    templateHeaders.filter((header) => header !== 'Model'),
  );
  assert.equal(missingModel.ok, false);
  assert.equal(missingModel.reason, 'The file is missing the Model column.');
  const missingChecksum = matchDeviceEditHeaders(templateHeaders.slice(0, -1));
  assert.equal(missingChecksum.ok, false);
  assert.equal(
    missingChecksum.reason,
    'The file is missing the Checksum column.',
  );
  const misspelled = matchDeviceEditHeaders(
    templateHeaders.map((header) =>
      header === 'Asset tag' ? 'Assett tag' : header,
    ),
  );
  assert.equal(misspelled.ok, false);
  assert.equal(misspelled.reason.includes('Asset tag'), true);
  const sparse = matchDeviceEditHeaders(['Device ID', 'Status', 'Checksum']);
  assert.equal(sparse.ok, false);
  assert.equal(
    sparse.reason,
    'The file is missing the Serial number, Model, Asset tag, Annotated location, Annotated user, Notes, and Organization unit columns.',
  );
});

test('header matching refuses a duplicate header', () => {
  const duplicate = matchDeviceEditHeaders([...templateHeaders, 'Status']);
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.reason.includes('Status'), true);
  assert.equal(duplicate.reason.includes('two'), true);
  assert.equal(duplicate.reason.includes('Remove one'), true);
  const byCase = matchDeviceEditHeaders(['device id', ...templateHeaders]);
  assert.equal(byCase.ok, false);
  assert.equal(byCase.reason.includes('Device ID'), true);
});

test('header matching refuses an unknown duplicate header in both modes', () => {
  for (const mode of [undefined, 'sync-changes', 'sync-all-rows']) {
    const identical = matchDeviceEditHeaders(
      [...templateHeaders, 'Grade', 'Grade'],
      mode,
    );
    assert.equal(identical.ok, false, String(mode));
    assert.equal(
      identical.reason,
      'The file holds two "Grade" columns, at positions 11 and 12. Remove one.',
      String(mode),
    );
    const byCase = matchDeviceEditHeaders(
      [...templateHeaders, ' Grade ', 'gRaDe'],
      mode,
    );
    assert.equal(byCase.ok, false, String(mode));
    assert.equal(byCase.reason.includes('Grade'), true);
    assert.equal(byCase.reason.includes('positions 11 and 12'), true);
    const blank = matchDeviceEditHeaders([...templateHeaders, '', '  '], mode);
    assert.equal(blank.ok, false, String(mode));
    assert.equal(blank.reason.includes('positions 11 and 12'), true);
    // One unknown column stays accepted, warned, and out of the mapping.
    const single = matchDeviceEditHeaders(
      [...templateHeaders, ' Grade '],
      mode,
    );
    assert.equal(single.ok, true, String(mode));
    assert.deepEqual(single.match.unknown, [{ header: ' Grade ', index: 10 }]);
    assert.equal(single.match.warnings.length, 1);
    assert.equal(
      single.match.columns.some((entry) => entry.header === ' Grade '),
      false,
    );
  }
});

test('header matching warns on an unknown column and keeps it out of the mapping', () => {
  const result = matchDeviceEditHeaders([...templateHeaders, 'Grade']);
  assert.equal(result.ok, true);
  assert.deepEqual(result.match.unknown, [{ header: 'Grade', index: 10 }]);
  assert.equal(result.match.warnings.length, 1);
  assert.equal(result.match.warnings[0].includes('Grade'), true);
  assert.equal(
    result.match.columns.some((entry) => entry.header === 'Grade'),
    false,
  );
  assert.equal(result.match.columns.length, 10);
  const spaced = matchDeviceEditHeaders(['  Grade  ', ...templateHeaders]);
  assert.equal(spaced.ok, true);
  assert.deepEqual(spaced.match.unknown, [{ header: '  Grade  ', index: 0 }]);
});

test('Checksum is optional in sync-all-rows only', () => {
  const withoutChecksum = templateHeaders.slice(0, -1);
  assert.equal(
    matchDeviceEditHeaders(withoutChecksum, 'sync-changes').ok,
    false,
  );
  const allRows = matchDeviceEditHeaders(withoutChecksum, 'sync-all-rows');
  assert.equal(allRows.ok, true);
  assert.deepEqual(
    allRows.match.columns.map((entry) => entry.key),
    [
      'deviceId',
      'serialNumber',
      'model',
      'status',
      'annotatedAssetId',
      'annotatedLocation',
      'annotatedUser',
      'notes',
      'orgUnitPath',
    ],
  );
  assert.equal(
    matchDeviceEditHeaders(templateHeaders, 'sync-all-rows').ok,
    true,
  );
  assert.equal(
    matchDeviceEditHeaders([...withoutChecksum, ' Extra '], 'sync-changes').ok,
    false,
  );
});

test('a checksum cell is well formed or malformed (section 8.3)', async () => {
  const cell = await deviceEditRowChecksum(goldenRow);
  assert.equal(deviceEditChecksumIsWellFormed(cell), true);
  assert.equal(deviceEditChecksumIsWellFormed(cell.slice(0, -1)), false);
  assert.equal(deviceEditChecksumIsWellFormed(`${cell}A`), false);
  assert.equal(deviceEditChecksumIsWellFormed(cell.replace('1.', '2.')), false);
  assert.equal(deviceEditChecksumIsWellFormed(''), false);
  assert.equal(deviceEditChecksumIsWellFormed('malformed'), false);
  assert.equal(deviceEditChecksumIsWellFormed(` ${cell}`), false);
  assert.equal(deviceEditChecksumIsWellFormed(`1.${'A'.repeat(22)}`), true);
  assert.equal(deviceEditChecksumIsWellFormed(`1.${'A'.repeat(21)}`), false);
  assert.equal(deviceEditChecksumIsWellFormed(`1.${'A'.repeat(23)}`), false);
  assert.equal(deviceEditChecksumIsWellFormed(`1.${'A'.repeat(21)}+`), false);
  assert.equal(deviceEditChecksumIsWellFormed(`1.${'A'.repeat(21)}-`), true);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEVICE_DRIVE_SOURCE_TYPES,
  DEVICE_IMPORT_SOURCE_TYPES,
  GOOGLE_DRIVE_CAUSES,
  deviceDriveSourceTypeSchema,
  deviceImportSourceTypeSchema,
  googleDriveAccessSchema,
  googleDriveCauseSchema,
  googleDriveFileIdSchema,
  googleDriveImportReceiptSchema,
  googleDriveImportRequestSchema,
  googleDrivePickerApiKeySchema,
  googleDriveProjectNumberSchema,
  googleDriveSessionRequestSchema,
  googleDriveSessionSchema,
  googleDriveSettingsAnswerSchema,
  googleDriveSettingsSchema,
  googleDriveTabIdSchema,
  googleDriveTabListSchema,
  googleDriveTabSchema,
} from './google-drive.ts';

const at = '2026-10-30T15:05:00.000Z';
const fileId = '1Abc-def_ghi';
// The sample of the notes keeps the length and the form of a Google browser key (notes:145).
const apiKey = 'synthetic-picker-api-key-00000000000000';

test('the source types name the uploaded file and the two Drive sources', () => {
  assert.deepEqual(DEVICE_IMPORT_SOURCE_TYPES, [
    'csv',
    'drive-sheet',
    'drive-csv',
  ]);
  assert.deepEqual(DEVICE_DRIVE_SOURCE_TYPES, ['drive-sheet', 'drive-csv']);
  for (const sourceType of DEVICE_IMPORT_SOURCE_TYPES)
    assert.equal(
      deviceImportSourceTypeSchema.safeParse(sourceType).success,
      true,
    );
  for (const sourceType of DEVICE_DRIVE_SOURCE_TYPES)
    assert.equal(
      deviceDriveSourceTypeSchema.safeParse(sourceType).success,
      true,
    );
  // The Drive receipt never carries the uploaded file type.
  assert.equal(deviceDriveSourceTypeSchema.safeParse('csv').success, false);
  assert.equal(deviceImportSourceTypeSchema.safeParse('drive').success, false);
});

test('a Drive file ID holds 1 to 128 letters, digits, hyphens, or underscores', () => {
  assert.deepEqual(googleDriveFileIdSchema.parse(fileId), fileId);
  assert.equal(
    googleDriveFileIdSchema.safeParse('a'.repeat(128)).success,
    true,
  );
  assert.equal(
    googleDriveFileIdSchema.safeParse('a'.repeat(129)).success,
    false,
  );
  for (const refused of ['', 'has space', 'has.dot', 'has/slash', 'has@sign'])
    assert.equal(
      googleDriveFileIdSchema.safeParse(refused).success,
      false,
      `${JSON.stringify(refused)} refuses.`,
    );
});

test('the integer tab ID of the Sheets API refuses a negative or a fractional ID', () => {
  assert.equal(googleDriveTabIdSchema.safeParse(0).success, true);
  assert.equal(googleDriveTabIdSchema.safeParse(123456789).success, true);
  assert.equal(googleDriveTabIdSchema.safeParse(-1).success, false);
  assert.equal(googleDriveTabIdSchema.safeParse(1.5).success, false);
  assert.equal(googleDriveTabIdSchema.safeParse('0').success, false);
});

test('one tab and the tab list hold the limits of Google', () => {
  const tab = { tabId: 0, title: 'Devices', index: 0 };
  assert.deepEqual(googleDriveTabSchema.parse(tab), tab);
  assert.equal(
    googleDriveTabSchema.safeParse({ ...tab, title: '' }).success,
    false,
  );
  assert.equal(
    googleDriveTabSchema.safeParse({ ...tab, title: 'a'.repeat(255) }).success,
    true,
  );
  assert.equal(
    googleDriveTabSchema.safeParse({ ...tab, title: 'a'.repeat(256) }).success,
    false,
  );
  assert.equal(
    googleDriveTabSchema.safeParse({ ...tab, index: -1 }).success,
    false,
  );
  const list = { fileId, tabs: [tab, { tabId: 7, title: 'Edits', index: 1 }] };
  assert.deepEqual(googleDriveTabListSchema.parse(list), list);
  assert.equal(
    googleDriveTabListSchema.safeParse({ fileId, tabs: [] }).success,
    false,
    'A tab list holds one tab at least.',
  );
  assert.equal(
    googleDriveTabListSchema.safeParse({
      fileId,
      tabs: Array.from({ length: 1000 }, (_, index) => ({
        tabId: index,
        title: `Tab ${index}`,
        index,
      })),
    }).success,
    true,
  );
  assert.equal(
    googleDriveTabListSchema.safeParse({
      fileId,
      tabs: Array.from({ length: 1001 }, (_, index) => ({
        tabId: index,
        title: `Tab ${index}`,
        index,
      })),
    }).success,
    false,
  );
  assert.equal(
    googleDriveTabListSchema.safeParse({ ...list, extra: true }).success,
    false,
  );
});

test('the Drive import request names its mode, its file, and the tab of a Sheet', () => {
  const sheet = { mode: 'sync-changes', fileId, tabId: 0 };
  assert.deepEqual(googleDriveImportRequestSchema.parse(sheet), sheet);
  // A CSV file in Drive names no tab, so the request may leave it out.
  const csv = { mode: 'sync-all-rows', fileId };
  assert.deepEqual(googleDriveImportRequestSchema.parse(csv), {
    ...csv,
    tabId: null,
  });
  assert.equal(
    googleDriveImportRequestSchema.safeParse({ ...csv, tabId: null }).success,
    true,
  );
  for (const refused of [
    { ...sheet, mode: 'merge' },
    { ...sheet, fileId: 'has space' },
    { ...sheet, fileId: 'a'.repeat(129) },
    { ...sheet, tabId: -1 },
    { ...sheet, tabId: 1.5 },
    { ...sheet, extra: true },
  ])
    assert.equal(
      googleDriveImportRequestSchema.safeParse(refused).success,
      false,
      `${JSON.stringify(refused)} refuses.`,
    );
});

test('the Drive import receipt names its job, its mode, its name, and its source', () => {
  const receipt = {
    jobId: '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0',
    displayId: 'IMP-010',
    status: 'accepted',
    mode: 'sync-changes',
    name: 'devices-for-editing-EXP-003',
    sourceType: 'drive-sheet',
    tabTitle: 'Devices',
  };
  assert.deepEqual(googleDriveImportReceiptSchema.parse(receipt), receipt);
  const csv = {
    ...receipt,
    displayId: 'IMP-011',
    name: 'devices-for-editing-EXP-001.csv',
    sourceType: 'drive-csv',
    tabTitle: null,
  };
  assert.deepEqual(googleDriveImportReceiptSchema.parse(csv), csv);
  for (const refused of [
    { ...receipt, status: 'running' },
    { ...receipt, sourceType: 'csv' },
    { ...receipt, name: '' },
    { ...receipt, extra: true },
  ])
    assert.equal(
      googleDriveImportReceiptSchema.safeParse(refused).success,
      false,
      `${JSON.stringify(refused)} refuses.`,
    );
});

test('the access answer reports each cause of an unavailable Drive', () => {
  assert.deepEqual(GOOGLE_DRIVE_CAUSES, ['setup', 'delegation', 'account']);
  for (const cause of GOOGLE_DRIVE_CAUSES)
    assert.equal(
      googleDriveCauseSchema.safeParse(cause).success,
      true,
      `${cause} parses.`,
    );
  const available = {
    sheetExport: { available: true },
    driveImport: { available: true },
  };
  assert.deepEqual(googleDriveAccessSchema.parse(available), available);
  // Every cause applies to an import, because the Picker needs the settings and the token.
  for (const cause of GOOGLE_DRIVE_CAUSES) {
    const answer = {
      sheetExport: { available: false, cause: 'delegation' },
      driveImport: { available: false, cause },
    };
    assert.deepEqual(googleDriveAccessSchema.parse(answer), answer);
  }
  // A Sheet export opens no Picker, so setup never applies to it (design section 1).
  assert.equal(
    googleDriveAccessSchema.safeParse({
      sheetExport: { available: false, cause: 'setup' },
      driveImport: { available: true },
    }).success,
    false,
  );
  assert.equal(
    googleDriveAccessSchema.safeParse({
      sheetExport: { available: false, cause: 'account' },
      driveImport: { available: true },
    }).success,
    true,
  );
  assert.equal(
    googleDriveAccessSchema.safeParse({
      sheetExport: { available: true },
      driveImport: { available: true },
      extra: true,
    }).success,
    false,
  );
  assert.equal(
    googleDriveAccessSchema.safeParse({ sheetExport: { available: true } })
      .success,
    false,
  );
});

test('the session request is empty and the answer carries the one-hour token', () => {
  assert.deepEqual(googleDriveSessionRequestSchema.parse({}), {});
  assert.equal(
    googleDriveSessionRequestSchema.safeParse({ subject: 'a@example.org' })
      .success,
    false,
  );
  const session = {
    accessToken: 'ya29.example-token',
    expiresAt: at,
    apiKey,
    appId: '123456789012',
  };
  assert.deepEqual(googleDriveSessionSchema.parse(session), session);
  for (const refused of [
    { ...session, accessToken: '' },
    { ...session, expiresAt: '2026-10-30' },
    { ...session, apiKey: apiKey.slice(0, 38) },
    { ...session, appId: '012345678901' },
    { ...session, appId: '0' },
    { ...session, extra: true },
  ])
    assert.equal(
      googleDriveSessionSchema.safeParse(refused).success,
      false,
      `${JSON.stringify(refused)} refuses.`,
    );
});

test('the Picker API key holds exactly 39 letters, digits, hyphens, or underscores', () => {
  assert.equal(googleDrivePickerApiKeySchema.safeParse(apiKey).success, true);
  // K1: a 38-character key refuses.
  assert.equal(
    googleDrivePickerApiKeySchema.safeParse(apiKey.slice(0, 38)).success,
    false,
  );
  assert.equal(
    googleDrivePickerApiKeySchema.safeParse(`${apiKey}a`).success,
    false,
  );
  assert.equal(
    googleDrivePickerApiKeySchema.safeParse('a'.repeat(38) + '.').success,
    false,
  );
  assert.equal(
    googleDrivePickerApiKeySchema.safeParse('a'.repeat(39)).success,
    true,
  );
});

test('the project number holds 1 to 20 digits and no leading zero', () => {
  assert.equal(googleDriveProjectNumberSchema.safeParse('1').success, true);
  assert.equal(
    googleDriveProjectNumberSchema.safeParse('123456789012').success,
    true,
  );
  assert.equal(
    googleDriveProjectNumberSchema.safeParse('1'.repeat(20)).success,
    true,
  );
  for (const refused of ['', '0', '012345678901', '1'.repeat(21), '12a'])
    assert.equal(
      googleDriveProjectNumberSchema.safeParse(refused).success,
      false,
      `${JSON.stringify(refused)} refuses.`,
    );
});

test('the settings answer holds the saved settings or null', () => {
  const settings = { pickerApiKey: apiKey, projectNumber: '123456789012' };
  assert.deepEqual(googleDriveSettingsSchema.parse(settings), settings);
  assert.deepEqual(googleDriveSettingsAnswerSchema.parse({ drive: null }), {
    drive: null,
  });
  assert.deepEqual(googleDriveSettingsAnswerSchema.parse({ drive: settings }), {
    drive: settings,
  });
  assert.equal(
    googleDriveSettingsAnswerSchema.safeParse({ drive: settings, extra: true })
      .success,
    false,
  );
  assert.equal(
    googleDriveSettingsAnswerSchema.safeParse({
      drive: {
        pickerApiKey: apiKey.slice(0, 38),
        projectNumber: '123456789012',
      },
    }).success,
    false,
  );
  assert.equal(
    googleDriveSettingsAnswerSchema.safeParse({
      drive: { pickerApiKey: apiKey, projectNumber: '012345678901' },
    }).success,
    false,
  );
});

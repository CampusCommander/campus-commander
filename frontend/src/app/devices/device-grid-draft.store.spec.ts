import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { DeviceRow } from '@campus/application-contracts';
import { AuthStore } from '../auth.store';
import {
  DEVICE_GRID_DRAFT_DEVICE_LIMIT_MESSAGE,
  DEVICE_GRID_DRAFT_STORAGE_ERROR,
  DEVICE_GRID_DRAFT_WRITE_ERROR,
  DeviceGridDraftStore,
  baselineFor,
  gridDraftRestoreError,
  rowValueFor,
} from './device-grid-draft.store';

const principal = '4f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10';
const storageKey = `cc.device-update-draft.${principal}`;

function row(overrides: Partial<DeviceRow> = {}): DeviceRow {
  return {
    deviceId: 'd1',
    serialNumber: 'C0A1-0000',
    model: null,
    assetTag: null,
    orgUnitPath: '/ChromeOS/Lowell',
    lastContact: '2026-10-05T12:00:00.000Z',
    annotatedLocation: null,
    annotatedUser: null,
    notes: null,
    status: 'ACTIVE',
    battery: { status: 'no-report' },
    lastEntitySync: '2026-10-04T12:00:00.000Z',
    stale: false,
    ...overrides,
  };
}

function configure(id = principal) {
  TestBed.configureTestingModule({
    providers: [
      {
        provide: AuthStore,
        useValue: {
          session: signal({
            identity: { id },
            expiresAt: '2026-10-20T12:00:00.000Z',
            csrfToken: 'a'.repeat(64),
          }),
        },
      },
    ],
  });
  return TestBed.inject(DeviceGridDraftStore);
}

function document(): unknown {
  return JSON.parse(sessionStorage.getItem(storageKey) ?? 'null');
}

beforeEach(() => sessionStorage.clear());

it('stages a text edit in the draft and writes only its own document part', () => {
  sessionStorage.setItem(
    storageKey,
    JSON.stringify({
      sheet: {
        fields: [
          { field: 'notes', mode: 'replace', value: 'Sheet draft value' },
        ],
      },
    }),
  );
  const draft = configure();
  draft.stageText(row(), 'annotatedLocation', 'North lab');
  expect(draft.entries()).toEqual([
    {
      deviceId: 'd1',
      serialNumber: 'C0A1-0000',
      field: 'annotatedLocation',
      mode: 'replace',
      value: 'North lab',
      baseline: null,
      orgUnitId: null,
      state: 'pending',
    },
  ]);
  expect(draft.counts()).toEqual({ changes: 1, devices: 1 });
  expect(draft.countLine()).toBe('1 pending change · 1 device');
  expect(draft.valueFor('d1', 'annotatedLocation', '')).toBe('North lab');
  expect(document()).toEqual({
    sheet: {
      fields: [{ field: 'notes', mode: 'replace', value: 'Sheet draft value' }],
    },
    grid: {
      entries: [
        {
          deviceId: 'd1',
          serialNumber: 'C0A1-0000',
          field: 'annotatedLocation',
          mode: 'replace',
          value: 'North lab',
          baseline: null,
          orgUnitId: null,
          state: 'pending',
        },
      ],
    },
  });
});

it('removes an entry when the value returns to its baseline', () => {
  const draft = configure();
  const device = row({ notes: 'Cart 7 loaner pool' });
  draft.stageText(device, 'notes', 'Cart 7 loaner pool');
  expect(draft.entries()).toEqual([]);
  draft.stageText(device, 'notes', 'Changed');
  expect(draft.entries()).toHaveLength(1);
  draft.stageText(device, 'notes', 'Cart 7 loaner pool');
  expect(draft.entries()).toEqual([]);
  expect(document()).toBeNull();
});

it('stages Clear value for an emptied field and keeps an empty asset tag invalid', () => {
  const draft = configure();
  draft.stageText(
    row({ annotatedUser: 'maya@example.org' }),
    'annotatedUser',
    '',
  );
  expect(draft.entries()[0]).toMatchObject({
    field: 'annotatedUser',
    mode: 'clear',
    value: '',
    state: 'pending',
  });
  expect(draft.valueFor('d1', 'annotatedUser', 'maya@example.org')).toBe('');
  draft.stageText(row({ assetTag: 'CB123' }), 'annotatedAssetId', '');
  expect(draft.entries().at(-1)).toMatchObject({
    field: 'annotatedAssetId',
    mode: 'replace',
    value: '',
    state: 'invalid',
  });
});

it('refuses a value of spaces alone and keeps it in the cell and the entry', () => {
  const draft = configure();
  draft.stageText(row(), 'notes', '   ');
  expect(draft.entries()[0]).toMatchObject({
    field: 'notes',
    value: '   ',
    state: 'invalid',
  });
  expect(draft.valueFor('d1', 'notes', '')).toBe('   ');
  expect(draft.blocked()).toBe(true);
  expect(draft.line()).toEqual({
    text: '1 change cannot be saved. C0A1-0000 · Notes needs a visible character.',
    tone: 'error',
  });
});

it('counts code points, not UTF-16 units', () => {
  const draft = configure();
  draft.stageText(row(), 'notes', '😀'.repeat(500));
  expect(draft.entries()[0].state).toBe('pending');
  draft.stageText(row(), 'notes', '😀'.repeat(501));
  expect(draft.entries()[0].state).toBe('invalid');
  expect(draft.line().text).toContain('Notes holds 1 to 500 characters.');
});

it('counts entries and their devices', () => {
  const draft = configure();
  draft.stageText(row(), 'notes', 'One');
  draft.stageText(row(), 'annotatedUser', 'maya@example.org');
  draft.stageText(row({ deviceId: 'd2' }), 'notes', 'Two');
  expect(draft.countLine()).toBe('3 pending changes · 2 devices');
});

it('counts an open editor before it stages', () => {
  const draft = configure();
  draft.beginLive({
    deviceId: 'd1',
    field: 'notes',
    baseline: 'Old',
    value: 'Old',
  });
  expect(draft.counts()).toEqual({ changes: 0, devices: 0 });
  draft.updateLive('New');
  expect(draft.counts()).toEqual({ changes: 1, devices: 1 });
  expect(draft.line()).toEqual({
    text: 'Editing notes · Enter or Tab stages this value · Escape cancels',
    tone: '',
  });
  draft.updateLive('');
  // An emptied Notes cell counts as Clear value.
  expect(draft.counts()).toEqual({ changes: 1, devices: 1 });
  draft.updateLive('Old');
  expect(draft.counts()).toEqual({ changes: 0, devices: 0 });
});

it('reverts one entry, then every entry after the one question', () => {
  const draft = configure();
  draft.stageText(row(), 'notes', 'One');
  draft.stageText(row(), 'annotatedUser', 'maya@example.org');
  draft.stageText(row({ deviceId: 'd2' }), 'notes', 'Two');
  draft.revert('d1', 'notes');
  expect(draft.entries().map((entry) => entry.field)).toEqual([
    'annotatedUser',
    'notes',
  ]);
  expect(draft.counts()).toEqual({ changes: 2, devices: 2 });
  draft.revertAll();
  expect(draft.entries()).toEqual([]);
  expect(draft.visible()).toBe(false);
  expect(document()).toBeNull();
});

it('clears only the grid part when Revert all changes runs', () => {
  sessionStorage.setItem(
    storageKey,
    JSON.stringify({
      sheet: { fields: [] },
      single: { deviceId: 'd1' },
    }),
  );
  const draft = configure();
  draft.stageText(row(), 'annotatedAssetId', 'HS-2');
  draft.revertAll();
  expect(document()).toEqual({
    sheet: { fields: [] },
    single: { deviceId: 'd1' },
  });
});

it('keeps the open editor in its cell when the draft refuses a 501st device', () => {
  const entries = Array.from({ length: 500 }, (_, index) => ({
    deviceId: `d${index}`,
    serialNumber: `S${index}`,
    field: 'notes',
    mode: 'replace',
    value: 'x',
    baseline: null,
    orgUnitId: null,
    state: 'pending',
  }));
  sessionStorage.setItem(storageKey, JSON.stringify({ grid: { entries } }));
  const draft = configure();
  expect(draft.entries()).toHaveLength(500);
  const result = draft.stageText(
    row({ deviceId: 'd500' }),
    'notes',
    'one more',
  );
  expect(result).toEqual({ ok: false, reason: 'device-limit' });
  expect(draft.entries()).toHaveLength(500);
  expect(draft.refusal()).toBe(DEVICE_GRID_DRAFT_DEVICE_LIMIT_MESSAGE);
  expect(draft.line()).toEqual({
    text: DEVICE_GRID_DRAFT_DEVICE_LIMIT_MESSAGE,
    tone: 'error',
  });
});

it('stages a Move with its path and unit ID, and removes a move to the baseline', () => {
  const draft = configure();
  draft.stageMove(row(), {
    id: 'ou-2',
    path: '/ChromeOS/Pine',
  });
  expect(draft.entries()[0]).toMatchObject({
    field: 'orgUnitPath',
    mode: 'move',
    value: '/ChromeOS/Pine',
    baseline: '/ChromeOS/Lowell',
    orgUnitId: 'ou-2',
    state: 'pending',
  });
  expect(draft.valueFor('d1', 'orgUnitPath', '/ChromeOS/Lowell')).toBe(
    '/ChromeOS/Pine',
  );
  draft.stageMove(row(), {
    id: 'ou-1',
    path: '/chromeos/lowell',
  });
  expect(draft.entries()).toEqual([]);
});

it('refuses a Move without a unit or a path', () => {
  const draft = configure();
  draft.stage({
    deviceId: 'd1',
    serialNumber: 'C0A1-0000',
    field: 'orgUnitPath',
    mode: 'move',
    value: '/ChromeOS/Pine',
    baseline: '/ChromeOS/Lowell',
    orgUnitId: null,
  });
  expect(draft.entries()[0].state).toBe('invalid');
  expect(draft.line().text).toContain('Organization unit needs a chosen unit.');
});

it('restores the grid draft of this person from the tab document', () => {
  const draft = configure();
  draft.stageText(row(), 'notes', 'One');
  draft.stageText(row({ deviceId: 'd2' }), 'annotatedUser', 'maya@example.org');
  TestBed.resetTestingModule();
  const restored = configure();
  expect(restored.entries()).toEqual(draft.entries());
  expect(restored.countLine()).toBe('2 pending changes · 2 devices');
  expect(restored.storageError()).toBe('');
});

it('does not read another person or another grid document', () => {
  sessionStorage.setItem(
    `cc.device-update-draft.${principal}-other`,
    JSON.stringify({
      grid: {
        entries: [
          {
            deviceId: 'd1',
            serialNumber: 'C0A1-0000',
            field: 'notes',
            mode: 'replace',
            value: 'Other tab',
            baseline: null,
            orgUnitId: null,
            state: 'pending',
          },
        ],
      },
    }),
  );
  const draft = configure();
  expect(draft.entries()).toEqual([]);
  expect(draft.storageError()).toBe('');
});

it('reports a stored entry that this tab cannot read and keeps the sheet part', () => {
  sessionStorage.setItem(
    storageKey,
    JSON.stringify({
      sheet: { fields: [] },
      grid: { entries: [{ deviceId: 'd1' }] },
    }),
  );
  const draft = configure();
  expect(draft.entries()).toEqual([]);
  expect(draft.storageError()).toBe(gridDraftRestoreError(1));
  expect(draft.line()).toEqual({
    text: gridDraftRestoreError(1),
    tone: 'error',
  });
  expect(draft.panelVisible()).toBe(true);
  expect(document()).toEqual({
    sheet: { fields: [] },
    grid: { entries: [{ deviceId: 'd1' }] },
  });
});

it('reports a grid part that has no entry list', () => {
  sessionStorage.setItem(
    storageKey,
    JSON.stringify({ grid: { entries: 'not a list' } }),
  );
  const draft = configure();
  expect(draft.entries()).toEqual([]);
  expect(draft.storageError()).toBe(DEVICE_GRID_DRAFT_STORAGE_ERROR);
  expect(draft.panelVisible()).toBe(true);
});

it('keeps the entries in memory when tab storage refuses the write', () => {
  const draft = configure();
  const setItem = vi
    .spyOn(Storage.prototype, 'setItem')
    .mockImplementation(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    });
  draft.stageText(row(), 'notes', 'Kept in memory');
  expect(draft.entries()).toHaveLength(1);
  expect(draft.valueFor('d1', 'notes', '')).toBe('Kept in memory');
  expect(draft.storageError()).toBe(DEVICE_GRID_DRAFT_WRITE_ERROR);
  expect(draft.line()).toEqual({
    text: DEVICE_GRID_DRAFT_WRITE_ERROR,
    tone: 'error',
  });
  setItem.mockRestore();
});

it('marks a conflict, blocks Save, and applies both answers', () => {
  const draft = configure();
  draft.stageText(
    row({ annotatedLocation: 'Front Office' }),
    'annotatedLocation',
    'Library',
  );
  draft.markConflict('d1', 'annotatedLocation', 'Media center');
  expect(draft.entries()[0]).toMatchObject({
    state: 'conflict',
    currentValue: 'Media center',
    baseline: 'Front Office',
    value: 'Library',
  });
  expect(draft.blocked()).toBe(true);
  expect(draft.line()).toEqual({
    text: '1 conflict. Annotated location of C0A1-0000 changed in Google after your edit. Resolve it to save.',
    tone: 'warning',
  });
  draft.keepCurrent('d1', 'annotatedLocation');
  expect(draft.entries()).toEqual([]);
  expect(draft.blocked()).toBe(false);

  draft.stageText(row(), 'notes', 'Library');
  draft.markConflict('d1', 'notes', 'Media center');
  draft.keepDraft('d1', 'notes');
  expect(draft.entries()[0]).toMatchObject({
    state: 'pending',
    baseline: 'Media center',
    value: 'Library',
  });
  expect('currentValue' in draft.entries()[0]).toBe(false);
  expect(draft.blocked()).toBe(false);
});

it('reads the row value of each editable field', () => {
  const device = row({
    assetTag: 'CB123',
    orgUnitPath: '/ChromeOS/Pine',
    annotatedLocation: 'Library',
    annotatedUser: 'maya@example.org',
    notes: 'Cart 7',
  });
  expect(rowValueFor(device, 'annotatedAssetId')).toBe('CB123');
  expect(rowValueFor(device, 'orgUnitPath')).toBe('/ChromeOS/Pine');
  expect(rowValueFor(device, 'annotatedLocation')).toBe('Library');
  expect(rowValueFor(device, 'annotatedUser')).toBe('maya@example.org');
  expect(rowValueFor(device, 'notes')).toBe('Cart 7');
});

it('keeps a null baseline through a changed row and a later edit', () => {
  const draft = configure();
  draft.stageText(row(), 'annotatedAssetId', 'FIRST');
  // The inventory reports a value after the first edit. The entry keeps what the person saw.
  draft.stageText(row({ assetTag: 'REMOTE' }), 'annotatedAssetId', 'SECOND');
  expect(draft.entryFor('d1', 'annotatedAssetId')).toMatchObject({
    value: 'SECOND',
    baseline: null,
  });

  // The non-null control keeps the first value the person saw.
  draft.stageText(
    row({ deviceId: 'd2', assetTag: 'HS-0001' }),
    'annotatedAssetId',
    'FIRST',
  );
  draft.stageText(
    row({ deviceId: 'd2', assetTag: 'HS-0002' }),
    'annotatedAssetId',
    'SECOND',
  );
  expect(draft.entryFor('d2', 'annotatedAssetId')).toMatchObject({
    value: 'SECOND',
    baseline: 'HS-0001',
  });
});

it('distinguishes a missing entry from an entry with a null baseline', () => {
  const changed = row({ notes: 'Remote value' });
  expect(baselineFor(null, changed, 'notes')).toBe('Remote value');
  expect(baselineFor({ baseline: null }, changed, 'notes')).toBeNull();
  expect(baselineFor({ baseline: 'First value' }, changed, 'notes')).toBe(
    'First value',
  );
});

it('round-trips an invalid value beside a valid entry', () => {
  const draft = configure();
  const long = 'x'.repeat(4097);
  draft.stageText(row(), 'annotatedAssetId', long);
  draft.stageText(row({ deviceId: 'd2' }), 'annotatedAssetId', 'CB-VALID');
  expect(draft.entryFor('d1', 'annotatedAssetId')).toMatchObject({
    value: long,
    state: 'invalid',
  });

  TestBed.resetTestingModule();
  const restored = configure();
  expect(restored.entryFor('d1', 'annotatedAssetId')).toMatchObject({
    value: long,
    state: 'invalid',
  });
  expect(restored.entryFor('d2', 'annotatedAssetId')).toMatchObject({
    value: 'CB-VALID',
    state: 'pending',
  });
  expect(restored.countLine()).toBe('2 pending changes · 2 devices');
  expect(restored.storageError()).toBe('');
});

it('keeps the valid entries when one stored entry is malformed', () => {
  sessionStorage.setItem(
    storageKey,
    JSON.stringify({
      grid: {
        entries: [
          { deviceId: 'd1' },
          {
            deviceId: 'd2',
            serialNumber: 'C0A1-0002',
            field: 'notes',
            mode: 'replace',
            value: 'Still here',
            baseline: null,
            orgUnitId: null,
            state: 'pending',
          },
        ],
      },
    }),
  );
  const draft = configure();
  expect(draft.entries()).toHaveLength(1);
  expect(draft.entryFor('d2', 'notes')).toMatchObject({
    value: 'Still here',
    state: 'pending',
  });
  expect(draft.storageError()).toBe(gridDraftRestoreError(1));
  expect(draft.panelVisible()).toBe(true);
});

it('keeps the current value of a conflict through invalid input and correction', () => {
  const draft = configure();
  draft.stageText(row({ assetTag: 'HS-0001' }), 'annotatedAssetId', 'DRAFT');
  draft.markConflict('d1', 'annotatedAssetId', 'REMOTE');

  draft.stageText(row({ assetTag: 'HS-0001' }), 'annotatedAssetId', '');
  expect(draft.entryFor('d1', 'annotatedAssetId')).toMatchObject({
    state: 'invalid',
    value: '',
    currentValue: 'REMOTE',
  });
  expect(draft.blocked()).toBe(true);
  expect(draft.line().tone).toBe('error');

  draft.stageText(
    row({ assetTag: 'HS-0001' }),
    'annotatedAssetId',
    'NEW-DRAFT',
  );
  expect(draft.entryFor('d1', 'annotatedAssetId')).toMatchObject({
    state: 'conflict',
    value: 'NEW-DRAFT',
    baseline: 'HS-0001',
    currentValue: 'REMOTE',
  });
  expect(draft.blocked()).toBe(true);
  expect(draft.line().text).toContain('1 conflict.');
});

it('restores a conflict that is stored with an invalid value', () => {
  sessionStorage.setItem(
    storageKey,
    JSON.stringify({
      grid: {
        entries: [
          {
            deviceId: 'd1',
            serialNumber: 'C0A1-0000',
            field: 'annotatedAssetId',
            mode: 'replace',
            value: '',
            baseline: 'HS-0001',
            orgUnitId: null,
            state: 'invalid',
            currentValue: 'REMOTE',
          },
        ],
      },
    }),
  );
  const draft = configure();
  expect(draft.entryFor('d1', 'annotatedAssetId')).toMatchObject({
    state: 'invalid',
    currentValue: 'REMOTE',
  });
  draft.stageText(
    row({ assetTag: 'HS-0001' }),
    'annotatedAssetId',
    'NEW-DRAFT',
  );
  expect(draft.entryFor('d1', 'annotatedAssetId')).toMatchObject({
    state: 'conflict',
    currentValue: 'REMOTE',
  });
  expect(draft.blocked()).toBe(true);
});

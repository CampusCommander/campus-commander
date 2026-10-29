import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type {
  DeviceRow,
  DeviceUpdateField,
  DeviceUpdateTarget,
  JobDetail,
  JobStatus,
} from '@campus/application-contracts';
import { AuthStore } from '../auth.store';
import {
  DEVICE_GRID_DRAFT_DEVICE_LIMIT_MESSAGE,
  DEVICE_GRID_DRAFT_STORAGE_ERROR,
  DEVICE_GRID_DRAFT_WRITE_ERROR,
  DeviceGridDraftStore,
  baselineFor,
  gridDraftRestoreError,
  rowValueFor,
  type DeviceGridObservedValue,
} from './device-grid-draft.store';
import type { JobEventSource } from '../jobs/job-stream';

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

/** A store whose person answers the job and device reads that settlement makes. */
function configureWith(
  request: (path: string) => Promise<Response> | Response,
  id = principal,
) {
  const session = signal({
    identity: { id },
    expiresAt: '2026-10-20T12:00:00.000Z',
    csrfToken: 'a'.repeat(64),
  });
  TestBed.configureTestingModule({
    providers: [
      {
        provide: AuthStore,
        useValue: { session, request },
      },
    ],
  });
  const draft = TestBed.inject(DeviceGridDraftStore);
  return { draft, session };
}

/** One frozen target row of an edit list. */
function target(
  deviceId: string,
  field: DeviceUpdateField,
  disposition: 'eligible' | 'unchanged' | 'conflict' | 'excluded',
  approvedValue: string | null,
  observedValue: string | null = null,
): DeviceUpdateTarget {
  return {
    deviceId,
    serialNumber: deviceId,
    field,
    observedValue,
    baselineValue: observedValue,
    approvedValue,
    duplicateSerialNumber: null,
    disposition,
    exclusionReason: disposition === 'excluded' ? 'removed' : null,
  };
}

/** A job detail with the written outcome that settlement reads. */
function jobOf(
  displayId: string,
  status: JobStatus,
  counts: { total: number; succeeded: number; failed: number },
): JobDetail {
  return {
    jobId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    displayId,
    revision: 1,
    action: 'update-device-annotations',
    status,
    scope: { kind: 'devices', deviceCount: counts.total },
    requestedBy: { id: principal, displayName: 'District operator' },
    createdAt: '2026-10-21T18:03:00.000Z',
    startedAt: '2026-10-21T18:03:01.000Z',
    finishedAt: '2026-10-21T18:03:02.000Z',
    progress: {
      total: counts.total,
      succeeded: counts.succeeded,
      failed: counts.failed,
      unknown: 0,
      skipped: 0,
      expired: 0,
      cancelled: 0,
      pending: 0,
    },
    failure: null,
    cancelRequest: null,
    confirmedBy: { id: principal, displayName: 'District operator' },
    previewDisplayId: 'PV-006',
    changes: null,
    commandType: null,
    statusAction: null,
    deprovisionReason: null,
    targetOrgUnitPaths: [],
    correlationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    latestActivity: {
      at: '2026-10-21T18:03:00.000Z',
      failed: { count: 0, operations: [] },
      unknown: { count: 0, operations: [] },
    },
    phase: null,
    exportSummary: null,
    importSummary: null,
    exportFile: null,
    importSource: null,
    plan: null,
    importDisplayId: null,
    waitsForDisplayId: null,
    waitingDisplayIds: null,
    planJobs: null,
    executionCounts: null,
  };
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
    serialNumber: 'CB-1',
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

it('settles an accepted cell only on authoritative evidence (B4)', () => {
  const draft = configure();
  draft.stageText(row({ notes: 'OLD-VALUE' }), 'notes', 'APPROVED-VALUE');
  draft.accept(
    draft.edits(),
    [target('d1', 'notes', 'eligible', 'APPROVED-VALUE', 'OLD-VALUE')],
    'UPD-006',
  );
  expect(draft.acceptedFor('d1', 'notes')).not.toBeNull();

  // A partial row proves nothing, and an unrelated refresh still holds the old value.
  draft.settleAccepted([{ deviceId: 'd1' }]);
  expect(draft.acceptedFor('d1', 'notes')).not.toBeNull();
  draft.settleAccepted([row({ notes: 'OLD-VALUE' })]);
  expect(draft.acceptedFor('d1', 'notes')).not.toBeNull();
  expect(draft.valueFor('d1', 'notes', 'OLD-VALUE')).toBe('APPROVED-VALUE');

  // The row that holds the request is success evidence, so the mark settles.
  draft.settleAccepted([row({ notes: 'APPROVED-VALUE' })]);
  expect(draft.accepted()).toEqual([]);
  expect(draft.valueFor('d1', 'notes', 'APPROVED-VALUE')).toBe(
    'APPROVED-VALUE',
  );
});

/** Let the settlement reads that accept() starts finish. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

it('settles a failed job without a later row event (B4)', async () => {
  const failed = jobOf('UPD-006', 'failed', {
    total: 1,
    succeeded: 0,
    failed: 1,
  });
  const { draft } = configureWith((path) =>
    path === '/api/jobs/UPD-006'
      ? Response.json(failed)
      : Response.json({ rows: [row({ notes: 'OLD-VALUE' })] }),
  );
  draft.stageText(row({ notes: 'OLD-VALUE' }), 'notes', 'FAILED-VALUE');
  draft.accept(
    draft.edits(),
    [target('d1', 'notes', 'eligible', 'FAILED-VALUE', 'OLD-VALUE')],
    'UPD-006',
  );
  await draft.reconcileAccepted();
  await flush();

  expect(draft.accepted()).toEqual([]);
  expect(draft.valueFor('d1', 'notes', 'OLD-VALUE')).toBe('OLD-VALUE');
});

it('keeps an accepted mark while the job runs, and reads a row outside the event', async () => {
  const running = jobOf('UPD-006', 'running', {
    total: 1,
    succeeded: 0,
    failed: 0,
  });
  const { draft } = configureWith((path) =>
    path === '/api/jobs/UPD-006'
      ? Response.json(running)
      : Response.json({ rows: [row({ notes: 'OLD-VALUE' })] }),
  );
  draft.stageText(row({ notes: 'OLD-VALUE' }), 'notes', 'PENDING-VALUE');
  draft.accept(
    draft.edits(),
    [target('d1', 'notes', 'eligible', 'PENDING-VALUE', 'OLD-VALUE')],
    'UPD-006',
  );
  await draft.reconcileAccepted();
  await flush();
  expect(draft.acceptedFor('d1', 'notes')).not.toBeNull();
});

it('settles a row that the event did not name once the job is terminal (B4)', async () => {
  const done = jobOf('UPD-006', 'completed-with-errors', {
    total: 2,
    succeeded: 1,
    failed: 1,
  });
  const { draft } = configureWith((path) =>
    path === '/api/jobs/UPD-006'
      ? Response.json(done)
      : Response.json({
          rows: [
            row({ deviceId: 'd1', notes: 'APPROVED-1' }),
            row({ deviceId: 'd2', notes: 'OLD-2' }),
          ],
        }),
  );
  draft.stageText(
    row({ deviceId: 'd1', notes: 'OLD-1' }),
    'notes',
    'APPROVED-1',
  );
  draft.stageText(
    row({ deviceId: 'd2', notes: 'OLD-2' }),
    'notes',
    'APPROVED-2',
  );
  draft.accept(
    draft.edits(),
    [
      target('d1', 'notes', 'eligible', 'APPROVED-1', 'OLD-1'),
      target('d2', 'notes', 'eligible', 'APPROVED-2', 'OLD-2'),
    ],
    'UPD-006',
  );
  // The event names one device only.
  draft.settleAccepted([row({ deviceId: 'd1', notes: 'APPROVED-1' })]);
  await draft.reconcileAccepted();
  await flush();
  expect(draft.accepted()).toEqual([]);
  expect(draft.valueFor('d2', 'notes', 'OLD-2')).toBe('OLD-2');
});

it('keeps a later draft when a settled accepted value leaves (B4, B7)', async () => {
  const done = jobOf('UPD-006', 'completed', {
    total: 1,
    succeeded: 1,
    failed: 0,
  });
  const { draft } = configureWith((path) =>
    path === '/api/jobs/UPD-006'
      ? Response.json(done)
      : Response.json({ rows: [row({ notes: 'APPROVED' })] }),
  );
  draft.stageText(row({ notes: 'OLD' }), 'notes', 'APPROVED');
  draft.accept(
    draft.edits(),
    [target('d1', 'notes', 'eligible', 'APPROVED', 'OLD')],
    'UPD-006',
  );
  draft.stageText(row({ notes: 'OLD' }), 'notes', 'LATER-EDIT');
  await draft.reconcileAccepted();
  await flush();
  expect(draft.accepted()).toEqual([]);
  expect(draft.entries()).toHaveLength(1);
  expect(draft.entryFor('d1', 'notes')?.value).toBe('LATER-EDIT');
});

it('clears accepted values on a principal switch (B5)', () => {
  const ids = [
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
  ];
  let identity = ids[0];
  const session = signal({
    identity: { id: identity },
    expiresAt: '2026-10-20T12:00:00.000Z',
    csrfToken: 'a'.repeat(64),
  });
  TestBed.configureTestingModule({
    providers: [{ provide: AuthStore, useValue: { session } }],
  });
  const draft = TestBed.inject(DeviceGridDraftStore);
  draft.stageText(row({ notes: 'OLD' }), 'notes', 'PERSON-A-PRIVATE-VALUE');
  draft.accept(
    draft.edits(),
    [target('d1', 'notes', 'eligible', 'PERSON-A-PRIVATE-VALUE', 'OLD')],
    'UPD-006',
  );
  expect(draft.acceptedFor('d1', 'notes')).not.toBeNull();

  identity = ids[1];
  session.set({
    identity: { id: identity },
    expiresAt: '2026-10-20T12:00:00.000Z',
    csrfToken: 'a'.repeat(64),
  });
  TestBed.tick();
  expect(draft.entries()).toEqual([]);
  expect(draft.accepted()).toEqual([]);
  expect(draft.valueFor('d1', 'notes', 'GOOGLE-OLD-VALUE')).toBe(
    'GOOGLE-OLD-VALUE',
  );
});

it('stages a later edit against the accepted value, so input is not lost (B7)', () => {
  const draft = configure();
  const device = row({ notes: 'HS-0001' });
  draft.stageText(device, 'notes', 'APPROVED-VALUE');
  draft.accept(
    draft.edits(),
    [target('d1', 'notes', 'eligible', 'APPROVED-VALUE', 'HS-0001')],
    'UPD-006',
  );
  expect(draft.acceptedFor('d1', 'notes')?.value).toBe('APPROVED-VALUE');

  // The person types the value that Google still holds. It differs from the accepted
  // value that the cell shows, so it becomes a pending change.
  draft.stageText(device, 'notes', 'HS-0001');
  expect(draft.entryFor('d1', 'notes')).toMatchObject({
    value: 'HS-0001',
    baseline: 'APPROVED-VALUE',
    state: 'pending',
  });
  expect(draft.valueFor('d1', 'notes', 'HS-0001')).toBe('HS-0001');
  expect(draft.counts()).toEqual({ changes: 1, devices: 1 });
});

it('stages a later Move against the accepted value, so input is not lost (B7)', () => {
  const draft = configure();
  const device = row({ orgUnitPath: '/Chrome Devices/Old' });
  draft.stageMove(device, { id: 'ou-new', path: '/Chrome Devices/New' });
  draft.accept(
    draft.edits(),
    [
      target(
        'd1',
        'orgUnitPath',
        'eligible',
        '/Chrome Devices/New',
        '/Chrome Devices/Old',
      ),
    ],
    'UPD-006',
  );
  draft.stageMove(device, { id: 'ou-old', path: '/Chrome Devices/Old' });
  expect(draft.entryFor('d1', 'orgUnitPath')).toMatchObject({
    mode: 'move',
    value: '/Chrome Devices/Old',
    baseline: '/Chrome Devices/New',
    state: 'pending',
  });
});

it('commits a live edit against the accepted value (B7)', () => {
  const draft = configure();
  const device = row({ notes: 'HS-0001' });
  draft.stageText(device, 'notes', 'APPROVED-VALUE');
  draft.accept(
    draft.edits(),
    [target('d1', 'notes', 'eligible', 'APPROVED-VALUE', 'HS-0001')],
    'UPD-006',
  );
  // The grid opens the editor with the baseline of the cell, which is the accepted value.
  draft.beginLive({
    deviceId: 'd1',
    serialNumber: 'C0A1-0000',
    field: 'notes',
    baseline: draft.baselineForRow(device, 'notes'),
    value: 'APPROVED-VALUE',
  });
  draft.updateLive('HS-0001');
  expect(draft.commitLive()).toBe(true);
  expect(draft.entryFor('d1', 'notes')).toMatchObject({
    value: 'HS-0001',
    baseline: 'APPROVED-VALUE',
    state: 'pending',
  });
});

it('drops every unchanged row when no row needs a job (B2)', () => {
  const draft = configure();
  draft.stageText(row({ deviceId: 'd1', notes: 'A' }), 'notes', 'GOOGLE-1');
  draft.stageText(row({ deviceId: 'd2', notes: 'B' }), 'notes', 'GOOGLE-2');
  const submitted = draft.edits();
  draft.applyPreview(
    [
      target('d1', 'notes', 'unchanged', 'GOOGLE-1', 'GOOGLE-1'),
      target('d2', 'notes', 'unchanged', 'GOOGLE-2', 'GOOGLE-2'),
    ],
    submitted,
  );
  expect(draft.entries()).toEqual([]);
});

it('drops a submitted unchanged row and keeps a later edit (B2)', () => {
  const draft = configure();
  draft.stageText(row({ notes: 'OLD' }), 'notes', 'GOOGLE-ALREADY-HOLDS');
  const submitted = draft.edits();
  draft.applyPreview(
    [
      target(
        'd1',
        'notes',
        'unchanged',
        'GOOGLE-ALREADY-HOLDS',
        'GOOGLE-ALREADY-HOLDS',
      ),
    ],
    submitted,
  );
  expect(draft.entries()).toEqual([]);
});

it('keeps a later edit when an unchanged answer settles the submitted row (B2)', () => {
  const draft = configure();
  draft.stageText(row({ notes: 'OLD' }), 'notes', 'GOOGLE-ALREADY-HOLDS');
  const submitted = draft.edits();
  draft.stageText(row({ notes: 'OLD' }), 'notes', 'LATER-VALUE');
  draft.dropSubmitted(submitted);
  expect(draft.entryFor('d1', 'notes')?.value).toBe('LATER-VALUE');
});

it('settles an Asset tag from its authoritative row property (B4)', async () => {
  const running = jobOf('UPD-006', 'running', {
    total: 2,
    succeeded: 1,
    failed: 0,
  });
  const { draft } = configureWith((path) =>
    path === '/api/jobs/UPD-006'
      ? Response.json(running)
      : Response.json({ rows: [row({ assetTag: 'APPROVED-TAG' })] }),
  );
  draft.stageText(
    row({ assetTag: 'OLD-TAG' }),
    'annotatedAssetId',
    'APPROVED-TAG',
  );
  draft.accept(
    draft.edits(),
    [target('d1', 'annotatedAssetId', 'eligible', 'APPROVED-TAG', 'OLD-TAG')],
    'UPD-006',
  );
  draft.settleAccepted([row({ assetTag: 'APPROVED-TAG' })]);
  await flush();
  await flush();
  expect(draft.accepted()).toEqual([]);
});

it('removes an older draft when the live input returns to its baseline (B1)', () => {
  const draft = configure();
  const device = row({ assetTag: 'ORIGINAL' });
  draft.stageText(device, 'annotatedAssetId', 'STALE-DRAFT');
  draft.beginLive({
    deviceId: device.deviceId,
    serialNumber: device.serialNumber,
    field: 'annotatedAssetId',
    baseline: 'ORIGINAL',
    value: 'ORIGINAL',
  });
  draft.commitLive();
  expect(draft.edits()).toEqual([]);
});

it('keeps the staged entry when a canceled edit returns to its baseline (B1)', () => {
  const draft = configure();
  const device = row({ assetTag: 'ORIGINAL' });
  draft.stageText(device, 'annotatedAssetId', 'KEEP-STAGED');
  const before = draft.edits();
  draft.beginLive({
    deviceId: device.deviceId,
    serialNumber: device.serialNumber,
    field: 'annotatedAssetId',
    baseline: 'ORIGINAL',
    value: 'KEEP-STAGED',
  });
  draft.updateLive('ORIGINAL');
  // The count hides the cell while the editor shows its baseline, so Save is disabled.
  expect(draft.counts()).toEqual({ changes: 0, devices: 0 });
  // Escape ends the live edit without a cell edit request. The staged entry returns.
  draft.endLive();
  expect(draft.edits()).toEqual(before);
  expect(draft.counts()).toEqual({ changes: 1, devices: 1 });
});

it('removes the older draft when the live input commits at its baseline (B1)', () => {
  const draft = configure();
  const device = row({ assetTag: 'ORIGINAL' });
  draft.stageText(device, 'annotatedAssetId', 'STALE-DRAFT');
  draft.beginLive({
    deviceId: device.deviceId,
    serialNumber: device.serialNumber,
    field: 'annotatedAssetId',
    baseline: 'ORIGINAL',
    value: 'STALE-DRAFT',
  });
  // Enter or Tab commits the input; Save changes commits it too.
  draft.updateLive('ORIGINAL');
  expect(draft.edits()).toHaveLength(1);
  draft.commitLive();
  expect(draft.edits()).toEqual([]);
  expect(draft.counts()).toEqual({ changes: 0, devices: 0 });
});

/** A jobs event source that a test drives directly. */
class FakeJobEvents {
  readonly listeners = new Map<string, ((event: Event) => void)[]>();
  readyState = 1;
  readonly source = this as unknown as JobEventSource;

  addEventListener(name: string, listener: (event: Event) => void): void {
    const list = this.listeners.get(name) ?? [];
    list.push(listener);
    this.listeners.set(name, list);
  }

  close(): void {
    this.readyState = 2;
  }

  emit(name: string, data?: unknown): void {
    const event =
      data === undefined
        ? new Event(name)
        : new MessageEvent(name, { data: JSON.stringify(data) });
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }
}

it('settles through the jobs channel when no device event publishes the failure (B4)', async () => {
  let status: JobStatus = 'running';
  let jobReads = 0;
  const { draft } = configureWith((path) => {
    if (path === '/api/jobs/UPD-006') {
      jobReads += 1;
      return Response.json(
        jobOf('UPD-006', status, {
          total: 1,
          succeeded: 0,
          failed: status === 'failed' ? 1 : 0,
        }),
      );
    }
    return Response.json({ rows: [row({ notes: 'OLD-VALUE' })] });
  });
  const stream = new FakeJobEvents();
  draft.jobEventSource = () => stream.source;
  draft.stageText(row({ notes: 'OLD-VALUE' }), 'notes', 'FAILED-WRITE');
  draft.accept(
    draft.edits(),
    [target('d1', 'notes', 'eligible', 'FAILED-WRITE', 'OLD-VALUE')],
    'UPD-006',
  );
  await flush();
  await flush();
  expect(draft.acceptedFor('d1', 'notes')).not.toBeNull();
  const before = jobReads;

  // The worker publishes no device row for a failed write. The job event is the evidence.
  status = 'failed';
  stream.emit('job-changed', {
    type: 'job-changed',
    jobId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    displayId: 'UPD-006',
    revision: 2,
    requestedBy: principal,
  });
  await flush();
  await flush();
  expect(jobReads).toBeGreaterThan(before);
  expect(draft.accepted()).toEqual([]);
  expect(draft.valueFor('d1', 'notes', 'OLD-VALUE')).toBe('OLD-VALUE');
});

it('applies the authoritative row before the accepted mark clears (B4)', async () => {
  const done = jobOf('UPD-006', 'completed', {
    total: 1,
    succeeded: 1,
    failed: 0,
  });
  const { draft } = configureWith((path) =>
    path === '/api/jobs/UPD-006'
      ? Response.json(done)
      : Response.json({ rows: [row({ notes: 'WRITTEN-BEFORE-RECEIPT' })] }),
  );
  const applied: DeviceRow[][] = [];
  draft.applyRows = (rows) => applied.push([...rows]);
  draft.stageText(
    row({ notes: 'OLD-VALUE' }),
    'notes',
    'WRITTEN-BEFORE-RECEIPT',
  );
  draft.accept(
    draft.edits(),
    [target('d1', 'notes', 'eligible', 'WRITTEN-BEFORE-RECEIPT', 'OLD-VALUE')],
    'UPD-006',
  );
  await draft.reconcileAccepted();
  await flush();
  expect(applied).toEqual([[row({ notes: 'WRITTEN-BEFORE-RECEIPT' })]]);
  expect(draft.accepted()).toEqual([]);
});

it('applies the Google value of an unchanged answer to the grid (B4)', () => {
  const draft = configure();
  const applied: DeviceGridObservedValue[] = [];
  draft.applyValues = (values) => applied.push(...values);
  draft.stageText(row({ notes: 'OLD' }), 'notes', 'ALREADY-WRITTEN');
  const submitted = draft.edits();
  draft.applyPreview(
    [target('d1', 'notes', 'unchanged', 'ALREADY-WRITTEN', 'ALREADY-WRITTEN')],
    submitted,
  );
  expect(applied).toEqual([
    { deviceId: 'd1', field: 'notes', value: 'ALREADY-WRITTEN' },
  ]);
  expect(draft.entries()).toEqual([]);
});

it('keeps a later text change through an unchanged answer while its job runs (B7)', () => {
  const draft = configure();
  const device = row({ notes: 'HS-0001' });
  draft.stageText(device, 'notes', 'FIRST-JOB-WILL-WRITE');
  draft.accept(
    draft.edits(),
    [target('d1', 'notes', 'eligible', 'FIRST-JOB-WILL-WRITE', 'HS-0001')],
    'UPD-006',
  );
  draft.stageText(device, 'notes', 'HS-0001');
  const submitted = draft.edits();
  draft.applyPreview(
    [target('d1', 'notes', 'unchanged', 'HS-0001', 'HS-0001')],
    submitted,
  );
  expect(draft.entryFor('d1', 'notes')).toMatchObject({
    value: 'HS-0001',
    baseline: 'FIRST-JOB-WILL-WRITE',
    state: 'pending',
  });
  expect(draft.keptUnchanged()).toBe(1);
  expect(draft.counts()).toEqual({ changes: 1, devices: 1 });
});

it('keeps a later Move through an unchanged answer while its job runs (B7)', () => {
  const draft = configure();
  const device = row({ orgUnitPath: '/Chrome Devices/Old' });
  draft.stageMove(device, { id: 'ou-new', path: '/Chrome Devices/New' });
  draft.accept(
    draft.edits(),
    [
      target(
        'd1',
        'orgUnitPath',
        'eligible',
        '/Chrome Devices/New',
        '/Chrome Devices/Old',
      ),
    ],
    'UPD-006',
  );
  draft.stageMove(device, { id: 'ou-old', path: '/Chrome Devices/Old' });
  const submitted = draft.edits();
  draft.applyPreview(
    [
      target(
        'd1',
        'orgUnitPath',
        'unchanged',
        '/Chrome Devices/Old',
        '/Chrome Devices/Old',
      ),
    ],
    submitted,
  );
  expect(draft.entryFor('d1', 'orgUnitPath')).toMatchObject({
    mode: 'move',
    value: '/Chrome Devices/Old',
    baseline: '/Chrome Devices/New',
  });
  expect(draft.keptUnchanged()).toBe(1);
});

it('keeps a later live edit through an unchanged answer while its job runs (B7)', () => {
  const draft = configure();
  const device = row({ notes: 'HS-0001' });
  draft.stageText(device, 'notes', 'FIRST-JOB-WILL-WRITE');
  draft.accept(
    draft.edits(),
    [target('d1', 'notes', 'eligible', 'FIRST-JOB-WILL-WRITE', 'HS-0001')],
    'UPD-006',
  );
  draft.beginLive({
    deviceId: 'd1',
    serialNumber: 'C0A1-0000',
    field: 'notes',
    baseline: draft.baselineForRow(device, 'notes'),
    value: 'FIRST-JOB-WILL-WRITE',
  });
  draft.updateLive('HS-0001');
  expect(draft.commitLive()).toBe(true);
  const submitted = draft.edits();
  draft.applyPreview(
    [target('d1', 'notes', 'unchanged', 'HS-0001', 'HS-0001')],
    submitted,
  );
  expect(draft.entryFor('d1', 'notes')).toMatchObject({
    value: 'HS-0001',
    baseline: 'FIRST-JOB-WILL-WRITE',
  });
  expect(draft.keptUnchanged()).toBe(1);
});

it('keeps a successful accepted value when its row read fails or omits the device (B4)', async () => {
  const done = jobOf('UPD-006', 'completed', {
    total: 1,
    succeeded: 1,
    failed: 0,
  });
  let read: 'fail' | 'missing' | 'written' = 'fail';
  const { draft } = configureWith((path) => {
    if (path === '/api/jobs/UPD-006') return Response.json(done);
    if (read === 'fail')
      return Response.json({ code: 'network-failure' }, { status: 503 });
    if (read === 'missing') return Response.json({ rows: [] });
    return Response.json({ rows: [row({ assetTag: 'GOOGLE-WRITTEN' })] });
  });
  draft.stageText(
    row({ assetTag: 'GOOGLE-OLD' }),
    'annotatedAssetId',
    'GOOGLE-WRITTEN',
  );
  draft.accept(
    draft.edits(),
    [
      target(
        'd1',
        'annotatedAssetId',
        'eligible',
        'GOOGLE-WRITTEN',
        'GOOGLE-OLD',
      ),
    ],
    'UPD-006',
  );
  await flush();
  await flush();

  // A successful terminal job may hold the value. A failed read proves nothing, so the
  // grid must not expose the old row as the settled value (B4).
  expect(draft.acceptedFor('d1', 'annotatedAssetId')).not.toBeNull();
  expect(draft.valueFor('d1', 'annotatedAssetId', 'GOOGLE-OLD')).toBe(
    'GOOGLE-WRITTEN',
  );

  // A read that omits the device is no evidence either.
  read = 'missing';
  await draft.reconcileAccepted();
  expect(draft.acceptedFor('d1', 'annotatedAssetId')).not.toBeNull();
  expect(draft.valueFor('d1', 'annotatedAssetId', 'GOOGLE-OLD')).toBe(
    'GOOGLE-WRITTEN',
  );

  // The authoritative value recovers the observation and settles the mark.
  read = 'written';
  await draft.reconcileAccepted();
  expect(draft.accepted()).toEqual([]);
  expect(draft.valueFor('d1', 'annotatedAssetId', 'GOOGLE-WRITTEN')).toBe(
    'GOOGLE-WRITTEN',
  );
});

it('keeps a partially applied failed value when its row read fails or omits the device (B4)', async () => {
  // A value-differs operation is marked failed after HTTP 200 and can still hold some of
  // its requested fields. Zero succeeded operations therefore do not prove that Google
  // wrote nothing, so a missing row must not expose the old value as settled.
  const failed = jobOf('UPD-006', 'failed', {
    total: 1,
    succeeded: 0,
    failed: 1,
  });
  failed.latestActivity.failed = {
    count: 1,
    operations: [
      {
        operationId: 'UPD-006-1-annotatedAssetId',
        deviceId: 'd1',
        serialNumber: 'C0A1-0000',
        outcomeReason: 'value-differs',
        googleStatus: 200,
        googleReason: null,
        updatedAt: '2026-10-21T18:03:02.000Z',
      },
    ],
  };
  let read: 'fail' | 'missing' | 'written' = 'fail';
  const { draft } = configureWith((requestPath) => {
    if (requestPath === '/api/jobs/UPD-006') return Response.json(failed);
    if (read === 'fail')
      return Response.json({ code: 'network-failure' }, { status: 503 });
    if (read === 'missing') return Response.json({ rows: [] });
    return Response.json({
      rows: [
        row({ assetTag: 'REQUESTED-TAG', notes: 'Google normalized note' }),
      ],
    });
  });
  const old = row({ assetTag: 'HS-0001', notes: 'Old note' });
  draft.stageText(old, 'annotatedAssetId', 'REQUESTED-TAG');
  draft.stageText(old, 'notes', 'Requested note');
  draft.accept(
    draft.edits(),
    [
      target('d1', 'annotatedAssetId', 'eligible', 'REQUESTED-TAG', 'HS-0001'),
      target('d1', 'notes', 'eligible', 'Requested note', 'Old note'),
    ],
    'UPD-006',
  );
  await draft.reconcileAccepted();
  await flush();

  // A failed read proves nothing: the Asset tag may hold REQUESTED-TAG even though the
  // operation failed on the normalized Move value.
  expect(draft.acceptedFor('d1', 'annotatedAssetId')).not.toBeNull();
  expect(draft.valueFor('d1', 'annotatedAssetId', 'HS-0001')).toBe(
    'REQUESTED-TAG',
  );

  // A read that omits the device is no evidence either.
  read = 'missing';
  await draft.reconcileAccepted();
  expect(draft.acceptedFor('d1', 'annotatedAssetId')).not.toBeNull();
  expect(draft.valueFor('d1', 'annotatedAssetId', 'HS-0001')).toBe(
    'REQUESTED-TAG',
  );

  // A later authoritative row proves the partial write, applies it, and settles the marks.
  read = 'written';
  await draft.reconcileAccepted();
  expect(draft.accepted()).toEqual([]);
  expect(draft.acceptedFor('d1', 'annotatedAssetId')).toBeNull();
  expect(draft.valueFor('d1', 'annotatedAssetId', 'REQUESTED-TAG')).toBe(
    'REQUESTED-TAG',
  );
});

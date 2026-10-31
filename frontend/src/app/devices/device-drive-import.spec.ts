import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import {
  DEVICE_EDIT_TEMPLATE_HEADERS,
  type JobDetail,
} from '@campus/application-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthStore } from '../auth.store';
import { DeviceExportImportDialog } from './device-export-import-dialog';
import { DeviceExportImportStore } from './device-export-import.store';
import { GoogleDrivePicker } from './google-drive-picker';
import { GoogleDriveRead } from './google-drive-read';
import { importDriveFailureText } from './device-import-messages';

/**
 * The Drive source of the import (design states 05 to 13, behaviors 2 to 8). The Picker and the
 * Google reads are stubs; the API answers are routed by path.
 */

const jobId = '2f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a12';
const person = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  displayName: 'District Admin',
};
const token = 'example-drive-token-0001';
const apiKey = 'example-picker-key-00000000000000000000';
const appId = '123456789012';
const header = [...DEVICE_EDIT_TEMPLATE_HEADERS];
const dataRow = header.map((_, index) => (index < 2 ? 'C0A1-0001' : ''));
const csvBytes = new TextEncoder().encode(
  `${header.join(',')}\r\n${dataRow.join(',')}\r\n`,
);
const sheetId = 'drive-sheet-exp-003';
const csvId = 'drive-csv-exp-001.csv';

const response = (body: unknown, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as unknown as Response;

const sheetDocument = {
  fileId: sheetId,
  name: 'devices-for-editing-EXP-003',
  mimeType: 'application/vnd.google-apps.spreadsheet',
  sizeBytes: null,
  lastEditedUtc: Date.now() - 3 * 60_000,
};
const csvDocument = {
  fileId: csvId,
  name: 'devices-for-editing-EXP-001.csv',
  mimeType: 'text/csv',
  sizeBytes: 7987,
  lastEditedUtc: Date.now() - 60 * 60_000,
};

const runningImport = (): JobDetail => ({
  jobId,
  displayId: 'IMP-010',
  revision: 4,
  action: 'validate-device-import',
  status: 'running',
  scope: { kind: 'rows', deviceCount: 48 },
  requestedBy: person,
  createdAt: new Date(Date.now() - 120_000).toISOString(),
  startedAt: new Date(Date.now() - 110_000).toISOString(),
  finishedAt: null,
  progress: {
    total: 48,
    succeeded: 0,
    failed: 0,
    unknown: 0,
    skipped: 0,
    expired: 0,
    cancelled: 0,
    pending: 48,
  },
  phase: { name: 'refresh', done: 6, total: 9 },
  exportSummary: null,
  exportFile: null,
  importSummary: {
    mode: 'sync-changes',
    planState: null,
    proposed: 13,
    rejected: 0,
    refusal: null,
  },
  cancelRequest: null,
  failure: null,
  confirmedBy: null,
  previewDisplayId: null,
  changes: null,
  commandType: null,
  statusAction: null,
  deprovisionReason: null,
  targetOrgUnitPaths: null,
  importSource: {
    name: sheetDocument.name,
    sourceType: 'drive-sheet',
    sizeBytes: 12_800,
    rowsRead: 48,
    candidateRows: 13,
    tabTitle: 'Devices',
    refusalText: null,
  },
  plan: null,
  importDisplayId: null,
  waitsForDisplayId: null,
  waitingDisplayIds: null,
  planJobs: null,
  executionCounts: null,
  correlationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  latestActivity: {
    at: new Date().toISOString(),
    failed: { count: 0, operations: [] },
    unknown: { count: 0, operations: [] },
  },
});

interface SetupOptions {
  readonly access?: unknown;
  readonly picker?: GoogleDrivePicker['open'];
  readonly sheetRows?: GoogleDriveRead['sheetRows'];
  readonly fileHead?: GoogleDriveRead['fileHead'];
  readonly tabs?: (fileId: string) => Response;
  readonly session?: () => Promise<Response>;
  readonly submit?: (body: unknown) => Response;
  readonly job?: JobDetail;
}

const accessAvailable = {
  sheetExport: { available: false, cause: 'account' },
  driveImport: { available: true },
};

function setup(options: SetupOptions = {}) {
  const picker = { open: vi.fn(options.picker ?? (async () => null)) };
  const read = {
    sheetRows: vi.fn(
      options.sheetRows ??
        (async () => [header, dataRow] as readonly (readonly string[])[]),
    ),
    fileHead: vi.fn(options.fileHead ?? (async () => csvBytes)),
  };
  const request = vi.fn(async (path: string, body?: unknown) => {
    if (path === '/api/google/drive')
      return response(options.access ?? accessAvailable);
    if (path === '/api/google/drive/session')
      return options.session
        ? options.session()
        : response({
            accessToken: token,
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            apiKey,
            appId,
          });
    if (path.endsWith('/tabs'))
      return options.tabs
        ? options.tabs(path)
        : response({
            fileId: sheetId,
            tabs: [
              { tabId: 0, title: 'Devices', index: 0 },
              { tabId: 1, title: 'Notes', index: 1 },
            ],
          });
    if (path === '/api/devices/imports/drive')
      return options.submit
        ? options.submit(body)
        : response(
            {
              jobId,
              displayId: 'IMP-010',
              status: 'accepted',
              mode: 'sync-changes',
              name: sheetDocument.name,
              sourceType: 'drive-sheet',
              tabTitle: 'Devices',
            },
            202,
          );
    if (path === '/api/jobs/IMP-010')
      return response(options.job ?? runningImport());
    return response({});
  });
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      {
        provide: AuthStore,
        useValue: { session: () => null, can: () => true, request },
      },
      { provide: GoogleDrivePicker, useValue: picker },
      { provide: GoogleDriveRead, useValue: read },
    ],
  });
  const fixture = TestBed.createComponent(DeviceExportImportDialog);
  fixture.componentRef.setInput(
    'tabId',
    '6f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10',
  );
  const store = TestBed.inject(DeviceExportImportStore);
  store.eventSource = () =>
    ({
      addEventListener: () => undefined,
      close: () => undefined,
    }) as never;
  fixture.detectChanges();
  const render = async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const panel = () =>
    (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>(
      'section[role="dialog"]',
    );
  const text = () => panel()?.textContent?.replace(/\s+/g, ' ') ?? '';
  return { fixture, store, render, panel, text, request, picker, read };
}

afterEach(() => {
  TestBed.resetTestingModule();
  vi.useRealTimers();
});

beforeEach(() => {
  TestBed.resetTestingModule();
});

describe('Drive import', () => {
  it('enables the Drive card only from the access answer (states 05 and 11)', async () => {
    const { store, render, panel } = setup();
    store.openImport();
    await render();
    const driveInput = () =>
      panel()?.querySelectorAll<HTMLInputElement>(
        'section[aria-labelledby="source-label"] mat-radio-button input',
      )[1];
    expect(driveInput()?.disabled).toBe(false);
    store.setImportSource('drive');
    await render();
    expect(store.importSource()).toBe('drive');
    expect(panel()?.textContent).toContain('A Sheet or a CSV file');
  });

  it('keeps Upload selected when the setup is missing (state 11)', async () => {
    const { store, render, panel } = setup({
      access: {
        sheetExport: { available: false, cause: 'account' },
        driveImport: { available: false, cause: 'setup' },
      },
    });
    store.openImport();
    await render();
    const cards = panel()?.querySelectorAll<HTMLInputElement>(
      'section[aria-labelledby="source-label"] mat-radio-button input',
    );
    expect(cards?.[0].checked).toBe(true);
    expect(cards?.[1].disabled).toBe(true);
    expect(panel()?.textContent).toContain(
      'Google Drive needs the Picker API key and the project number.',
    );
    store.setImportSource('drive');
    expect(store.importSource()).toBe('upload');
  });

  it('takes the session token to the Picker and keeps state 05 on cancel (state 06)', async () => {
    const { store, render, picker } = setup();
    store.openImport();
    await render();
    store.setImportSource('drive');
    await store.openDrivePicker();
    expect(picker.open).toHaveBeenCalledWith(token, apiKey, appId);
    expect(store.driveFile()).toBeNull();
    expect(store.importSource()).toBe('drive');
    expect(store.importReady()).toBe(false);
  });

  it('renews the session inside the five-minute window', async () => {
    let issued = 0;
    const { store, render, request } = setup({
      session: async () => {
        issued++;
        return response({
          accessToken: `example-drive-token-000${issued}`,
          // The first token expires inside the renewal window. The next one lasts an hour.
          expiresAt: new Date(
            Date.now() + (issued === 1 ? 4 * 60_000 : 3_600_000),
          ).toISOString(),
          apiKey,
          appId,
        });
      },
    });
    store.openImport();
    await render();
    store.setImportSource('drive');
    await store.openDrivePicker();
    await store.openDrivePicker();
    const posts = request.mock.calls.filter(
      ([path]) => path === '/api/google/drive/session',
    );
    expect(posts).toHaveLength(2);
    await store.openDrivePicker();
    expect(
      request.mock.calls.filter(
        ([path]) => path === '/api/google/drive/session',
      ),
    ).toHaveLength(2);
  });

  it('shows the chosen Sheet with its tabs and checks the first tab (state 07)', async () => {
    const { store, render, panel, read } = setup({
      picker: async () => sheetDocument,
    });
    store.openImport();
    await render();
    store.setImportSource('drive');
    await store.openDrivePicker();
    await render();
    const file = store.driveFile();
    expect(file?.tabs.map((tab) => tab.title)).toEqual(['Devices', 'Notes']);
    expect(file?.tabId).toBe(0);
    expect(file?.check).toBe('passed');
    expect(read.sheetRows).toHaveBeenCalledWith(token, sheetId, 'Devices');
    expect(panel()?.textContent).toContain('Google Sheet');
    expect(panel()?.textContent).toContain('2 tabs');
    expect(panel()?.querySelector('mat-select')).not.toBeNull();
    expect(store.importReady()).toBe(true);
  });

  it('checks another tab of the chosen Sheet (state 07)', async () => {
    const { store, render, read } = setup({
      picker: async () => sheetDocument,
    });
    store.openImport();
    await render();
    store.setImportSource('drive');
    await store.openDrivePicker();
    await store.chooseDriveTab(1);
    expect(read.sheetRows).toHaveBeenLastCalledWith(token, sheetId, 'Notes');
    expect(store.driveFile()?.tabId).toBe(1);
    expect(store.driveFile()?.check).toBe('passed');
  });

  it('shows a Drive CSV with its size and columns, and no Tab field (state 08)', async () => {
    const { store, render, panel, read } = setup({
      picker: async () => csvDocument,
    });
    store.openImport();
    await render();
    store.setImportSource('drive');
    await store.openDrivePicker();
    await render();
    expect(read.fileHead).toHaveBeenCalledWith(token, csvId);
    expect(store.driveFile()?.kind).toBe('csv');
    expect(store.driveFile()?.check).toBe('passed');
    expect(panel()?.textContent).toContain('7.8 KB');
    expect(panel()?.textContent).toContain(`${header.length} columns`);
    expect(panel()?.querySelector('mat-select')).toBeNull();
  });

  it('refuses a header that does not match the template (state 10)', async () => {
    const { store, render, panel } = setup({
      picker: async () => sheetDocument,
      sheetRows: async () => [['Serial number'], ['C0A1-0001']],
    });
    store.openImport();
    await render();
    store.setImportSource('drive');
    await store.openDrivePicker();
    await render();
    expect(store.driveFile()?.check).toBe('refused');
    expect(store.importReady()).toBe(false);
    expect(panel()?.querySelector('.check-line.bad')).not.toBeNull();
  });

  it('refuses a file that is neither a Sheet nor a CSV file (C1)', async () => {
    const { store, render } = setup({
      picker: async () => ({ ...csvDocument, mimeType: 'application/pdf' }),
    });
    store.openImport();
    await render();
    store.setImportSource('drive');
    await store.openDrivePicker();
    await render();
    expect(store.driveFile()?.check).toBe('refused');
    expect(store.driveFile()?.refusal).toBe(
      'Choose a Google Sheet or a CSV file.',
    );
  });

  it('refuses a source above 1 GiB from its metadata (C1)', async () => {
    const { store, render } = setup({
      picker: async () => ({ ...csvDocument, sizeBytes: 2 * 1024 ** 3 }),
    });
    store.openImport();
    await render();
    store.setImportSource('drive');
    await store.openDrivePicker();
    expect(store.driveFile()?.check).toBe('refused');
    expect(store.driveFile()?.refusal).toContain('A file holds at most 1 GiB.');
  });

  it('keeps Start disabled when the tab list fails (state 13 cause)', async () => {
    const { store, render, panel } = setup({
      picker: async () => sheetDocument,
      tabs: () => response({ reason: 'google-unavailable' }, 503),
    });
    store.openImport();
    await render();
    store.setImportSource('drive');
    await store.openDrivePicker();
    await render();
    expect(store.driveFile()?.check).toBe('refused');
    expect(panel()?.textContent).toContain(
      'Campus Commander cannot read the tabs of this Sheet. Choose the file again.',
    );
    expect(store.importReady()).toBe(false);
  });

  it('submits the file ID and the tab ID, and takes the receipt (state 10)', async () => {
    const { store, render, request } = setup({
      picker: async () => sheetDocument,
    });
    store.openImport();
    await render();
    store.setImportSource('drive');
    await store.openDrivePicker();
    await store.startValidation();
    const call = request.mock.calls.find(
      ([path]) => path === '/api/devices/imports/drive',
    );
    expect(call?.[1]).toEqual({
      mode: 'sync-changes',
      fileId: sheetId,
      tabId: 0,
    });
    expect(store.displayId()).toBe('IMP-010');
    expect(store.step()).toBe('validation');
  });

  it('names a refused submit in one sentence (C1)', async () => {
    const { store, render, panel } = setup({
      picker: async () => sheetDocument,
      submit: () => response({ reason: 'wrong-file-type' }, 422),
    });
    store.openImport();
    await render();
    store.setImportSource('drive');
    await store.openDrivePicker();
    await store.startValidation();
    await render();
    expect(store.step()).toBe('import');
    expect(panel()?.textContent).toContain(
      'Choose a Google Sheet or a CSV file.',
    );
  });

  it('names each submitted refusal (C1)', () => {
    expect(importDriveFailureText(422, 'wrong-file-type', 'file')).toBe(
      'Choose a Google Sheet or a CSV file.',
    );
    expect(importDriveFailureText(422, 'source-too-large', 'file')).toBe(
      'The file holds more than 1 GiB of data. Remove rows or columns, then import again.',
    );
    expect(importDriveFailureText(422, 'rows-too-large', 'file')).toBe(
      '1,000 rows of this tab hold more than 64 MiB of data. Shorten the long cells, then import again.',
    );
    expect(
      importDriveFailureText(404, 'drive-file-unavailable', 'devices.csv'),
    ).toBe(
      'Campus Commander cannot read devices.csv from Google Drive. Choose the file again in Google Drive, then import again.',
    );
  });

  it('Import again keeps the Drive source and clears the file (state 13)', async () => {
    const { store, render } = setup({
      picker: async () => sheetDocument,
    });
    store.openImport();
    await render();
    store.setImportSource('drive');
    await store.openDrivePicker();
    expect(store.driveFile()?.check).toBe('passed');
    store.importAgain();
    await render();
    expect(store.importSource()).toBe('drive');
    expect(store.driveFile()).toBeNull();
    expect(store.importReady()).toBe(false);
  });

  it('switches to Upload when the account refuses the session (state 12)', async () => {
    const { store, render, panel } = setup({
      session: async () =>
        response({ reason: 'drive-unavailable', cause: 'account' }, 409),
    });
    store.openImport();
    await render();
    store.setImportSource('drive');
    await store.openDrivePicker();
    await render();
    expect(store.importSource()).toBe('upload');
    expect(store.driveImportAvailable()).toBe(false);
    expect(panel()?.textContent).toContain(
      'Google refused Drive access for your account. Upload a CSV file instead.',
    );
    expect(panel()?.textContent).toContain(
      'Google Drive is not available for your account.',
    );
  });
});

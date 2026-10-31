import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { JobDetail } from '@campus/application-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthStore } from '../auth.store';
import { DeviceExportImportDialog } from './device-export-import-dialog';
import { DeviceExportImportStore } from './device-export-import.store';

const jobId = '0f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10';
const person = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  displayName: 'District Admin',
};
/** A future expiry, so a ready file stays ready whenever the suite runs. */
const futureExpiry = () =>
  new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

const exportDetail = (overrides: Partial<JobDetail> = {}): JobDetail => ({
  jobId,
  displayId: 'EXP-001',
  revision: 3,
  action: 'export-devices',
  status: 'running',
  scope: { kind: 'devices', deviceCount: 48 },
  requestedBy: person,
  createdAt: new Date(Date.now() - 60_000).toISOString(),
  startedAt: new Date(Date.now() - 50_000).toISOString(),
  finishedAt: null,
  progress: {
    total: 48,
    // Production writes the phase counters; the outcome counters stay zero until the finish.
    succeeded: 0,
    failed: 0,
    unknown: 0,
    skipped: 0,
    expired: 0,
    cancelled: 0,
    pending: 48,
  },
  phase: { name: 'write-rows', done: 32, total: 48 },
  exportSummary: { purpose: 'edit' },
  exportFile: null,
  importSummary: null,
  cancelRequest: null,
  failure: null,
  confirmedBy: null,
  previewDisplayId: null,
  changes: null,
  commandType: null,
  statusAction: null,
  deprovisionReason: null,
  targetOrgUnitPaths: null,
  importSource: null,
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
  ...overrides,
});

const response = (body: unknown, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as unknown as Response;

/** One answer that the test releases after it changes the principal or the flow. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => (resolve = settle));
  return { promise, resolve };
}

const accepted = (displayId = 'EXP-001') =>
  response({ jobId, displayId, status: 'accepted', rows: 48 });

/** The state class of each phase dot, in list order (design section 9, states 04 and 26). */
function phaseStates(panel: () => HTMLElement | null): string[][] {
  return [...(panel()?.querySelectorAll('.phase') ?? [])].map((phase) =>
    ['is-done', 'is-current', 'is-failed', 'is-stopped'].filter((name) =>
      phase.classList.contains(name),
    ),
  );
}

/** The default access answer: the Sheet export is available (state 01). */
const sheetAccessAvailable = {
  sheetExport: { available: true },
  driveImport: { available: true },
};

function setup(
  detail: JobDetail = exportDetail(),
  requestOverride?: (path: string, body?: unknown) => Promise<Response>,
  session: () => { identity: { id: string } } | null = () => null,
  access: unknown = sheetAccessAvailable,
) {
  const request = vi.fn(async (path: string, body?: unknown) => {
    // The configure step reads the Sheet access before it offers the format (states 01 and 04).
    // A null answer sends the read through the case's own request stub.
    if (path === '/api/google/drive' && access !== null)
      return response(access);
    if (requestOverride) return requestOverride(path, body);
    return path.startsWith('/api/jobs/')
      ? response(detail)
      : response({
          jobId,
          displayId: 'EXP-001',
          status: 'accepted',
          rows: 48,
        });
  });
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      {
        provide: AuthStore,
        useValue: {
          session,
          can: () => true,
          request,
        },
      },
    ],
  });
  const fixture = TestBed.createComponent(DeviceExportImportDialog);
  fixture.componentRef.setInput(
    'tabId',
    '6f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10',
  );
  const store = TestBed.inject(DeviceExportImportStore);
  // The store reads the job through the same request stub, and no stream reaches a server.
  store.eventSource = () =>
    ({
      addEventListener: () => undefined,
      close: () => undefined,
    }) as never;
  fixture.detectChanges();
  const element: HTMLElement = fixture.nativeElement;
  const render = async () => {
    // The job read settles on a microtask and a timer, outside the fixture's own stability.
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const panel = () =>
    element.querySelector<HTMLElement>('section[role="dialog"]');
  const text = () => panel()?.textContent?.replace(/\s+/g, ' ') ?? '';
  return {
    fixture,
    element,
    store,
    render,
    panel,
    text,
    request,
    component: fixture.componentInstance,
  };
}

afterEach(() => {
  TestBed.resetTestingModule();
  vi.useRealTimers();
});

/** The dialog is closed before every case, so one case never borrows another's job. */
beforeEach(() => {
  TestBed.resetTestingModule();
});

describe('DeviceExportImportDialog', () => {
  it('shows the configure step with the count and the available Sheet card', async () => {
    const { store, render, panel, text } = setup();
    store.openExport(48);
    await render();
    expect(panel()?.querySelector('h2')?.textContent?.trim()).toBe(
      'Export devices',
    );
    expect(text()).toContain('48 selected devices · Not submitted');
    // The access read makes the Sheet card available and names where it saves (state 01).
    expect(text()).toContain('Saved in your Google Drive');
    const primary = panel()?.querySelector<HTMLButtonElement>(
      '.export-actions button[mat-flat-button]',
    );
    expect(primary?.textContent?.trim()).toBe('Export 48 devices');
    expect(primary?.disabled).toBe(false);
  });

  it('submits the Sheet format that the person chooses', async () => {
    const { store, render, panel, request } = setup();
    store.openExport(48);
    await render();
    const radios = [
      ...(panel()?.querySelectorAll<HTMLInputElement>(
        'mat-radio-button.option-card input',
      ) ?? []),
    ];
    // CSV is the first card, and the available Sheet card follows it (state 01).
    radios[1]?.click();
    await render();
    expect(store.format()).toBe('sheet');
    panel()
      ?.querySelector<HTMLButtonElement>(
        '.export-actions button[mat-flat-button]',
      )
      ?.click();
    await render();
    const submit = request.mock.calls.find(
      ([path]) => path === '/api/devices/exports',
    );
    expect(submit?.[1]).toMatchObject({ purpose: 'edit', format: 'sheet' });
  });

  it('keeps CSV available when the delegation refuses the Sheet format', async () => {
    const { store, render, panel, text, request } = setup(
      exportDetail(),
      undefined,
      undefined,
      {
        sheetExport: { available: false, cause: 'delegation' },
        driveImport: { available: false, cause: 'delegation' },
      },
    );
    store.openExport(48);
    await render();
    expect(text()).toContain('Google denied Drive access. Add');
    expect(text()).toContain(
      'https://www.googleapis.com/auth/drive.file to the delegation client in the Google Admin Console.',
    );
    const radios = [
      ...(panel()?.querySelectorAll<HTMLInputElement>(
        'mat-radio-button.option-card input',
      ) ?? []),
    ];
    expect(radios[1]?.disabled).toBe(true);
    expect(store.format()).toBe('csv');
    panel()
      ?.querySelector<HTMLButtonElement>(
        '.export-actions button[mat-flat-button]',
      )
      ?.click();
    await render();
    const submit = request.mock.calls.find(
      ([path]) => path === '/api/devices/exports',
    );
    expect(submit?.[1]).toMatchObject({ purpose: 'edit', format: 'csv' });
  });

  it('selects CSV and names the refused account after a refused Sheet export', async () => {
    const request = async (path: string) =>
      path === '/api/devices/exports'
        ? response({ reason: 'drive-unavailable', cause: 'account' }, 409)
        : response({});
    const { store, render, panel, text } = setup(exportDetail(), request);
    store.openExport(48);
    await render();
    store.setFormat('sheet');
    await render();
    panel()
      ?.querySelector<HTMLButtonElement>(
        '.export-actions button[mat-flat-button]',
      )
      ?.click();
    await render();
    expect(text()).toContain(
      'Google refused Drive access for your account. Export a CSV file instead.',
    );
    expect(text()).toContain('Google Drive is not available for your account.');
    expect(store.format()).toBe('csv');
    expect(store.step()).toBe('configure');
  });

  it('keeps the delegation note after Google refused the Sheet format', async () => {
    const request = async (path: string) =>
      path === '/api/devices/exports'
        ? response({ reason: 'drive-unavailable', cause: 'delegation' }, 409)
        : response({});
    const { store, render, panel, text } = setup(exportDetail(), request);
    store.openExport(48);
    await render();
    store.setFormat('sheet');
    await render();
    panel()
      ?.querySelector<HTMLButtonElement>(
        '.export-actions button[mat-flat-button]',
      )
      ?.click();
    await render();
    // Only a refused account shows the export alert. A delegation names its note on the card.
    expect(text()).toContain('Google denied Drive access.');
    expect(text()).not.toContain(
      'Google refused Drive access for your account.',
    );
    expect(store.format()).toBe('csv');
    expect(store.step()).toBe('configure');
  });

  it('names the reachability alert when the access read fails', async () => {
    const request = async (path: string) =>
      path === '/api/google/drive' ? response({}, 503) : response({});
    const { store, render, text } = setup(
      exportDetail(),
      request,
      undefined,
      null,
    );
    store.openExport(48);
    await render();
    expect(text()).toContain(
      'Google Drive is not reachable. Try again, or export a CSV file.',
    );
    expect(store.format()).toBe('csv');
  });

  it('shows Create Google Sheet as the last phase of a running Sheet export', async () => {
    const { store, render, panel, text } = setup(
      exportDetail({ phase: { name: 'create-sheet', done: 0, total: null } }),
    );
    store.openExport(48);
    await render();
    store.setFormat('sheet');
    await render();
    panel()
      ?.querySelector<HTMLButtonElement>(
        '.export-actions button[mat-flat-button]',
      )
      ?.click();
    await render();
    expect(store.step()).toBe('monitor');
    // This tab sent a Sheet export, and the job keeps that format (section 6).
    expect(store.activeJobs().edit).toMatchObject({ format: 'sheet' });
    expect(text()).toContain('Write rows');
    expect(text()).toContain('48 of 48');
    expect(text()).toContain('Create Google Sheet');
    expect(text()).not.toContain('Prepare download');
    // The Sheet phase counts nothing and draws no bar (composition choice 2, state 02).
    expect(phaseStates(panel)).toEqual([['is-done'], ['is-current']]);
    expect(panel()?.querySelector('mat-progress-bar')).toBeNull();
  });

  it('links a ready Sheet and names where it saves', async () => {
    const sheetUrl = 'https://docs.google.com/spreadsheets/d/1Abc_def-ghi/edit';
    const { store, render, panel, text } = setup(
      exportDetail({
        status: 'completed',
        finishedAt: new Date().toISOString(),
        phase: { name: 'create-sheet', done: 0, total: null },
        exportFile: {
          name: 'devices-for-editing-EXP-003',
          format: 'sheet',
          sizeBytes: null,
          rows: 48,
          columns: 10,
          expiresAt: null,
          sheetUrl,
        },
      }),
    );
    store.openJob('EXP-003');
    await render();
    expect(text()).toContain('Google Sheet');
    expect(text()).toContain('48 rows');
    expect(text()).toContain('10 columns');
    expect(text()).toContain('Saved in your Google Drive');
    expect(text()).not.toContain('Download CSV');
    const name = panel()?.querySelector<HTMLAnchorElement>('a.file-name');
    expect(name?.getAttribute('href')).toBe(sheetUrl);
    expect(name?.getAttribute('target')).toBe('_blank');
    expect(name?.getAttribute('rel')).toBe('noopener noreferrer');
    const open = panel()?.querySelector<HTMLAnchorElement>(
      '.export-actions a[mat-flat-button]',
    );
    expect(open?.getAttribute('href')).toBe(sheetUrl);
    expect(open?.getAttribute('target')).toBe('_blank');
    expect(open?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(open?.textContent?.trim()).toBe('Open in Google Sheets');
  });

  it('repeats the account alert when Google refused the Sheet export', async () => {
    const { store, render, text } = setup(
      exportDetail({
        status: 'failed',
        failure: 'drive-unavailable',
        phase: { name: 'write-rows', done: 0, total: 48 },
        finishedAt: new Date().toISOString(),
      }),
    );
    store.openJob('EXP-003');
    await render();
    expect(text()).toContain(
      'Google refused Drive access for your account. Export a CSV file instead.',
    );
  });

  it('names the incomplete Sheet when Google Sheets stopped the export', async () => {
    const { store, render, text } = setup(
      exportDetail({
        status: 'failed',
        failure: 'sheet-write-failed',
        phase: { name: 'create-sheet', done: 0, total: null },
        finishedAt: new Date().toISOString(),
      }),
    );
    store.openJob('EXP-003');
    await render();
    expect(text()).toContain(
      'Google Sheets stopped the export. The Sheet in your Google Drive is incomplete. Export again.',
    );
  });

  it('hides the Google Sheet card in Reports', async () => {
    const { store, render, text } = setup();
    store.openReport(48, ['serialNumber']);
    await render();
    expect(text()).toContain('CSV file');
    expect(text()).not.toContain('Google Sheet');
    expect(text()).not.toContain('Saved in your Google Drive');
  });

  it('names the limit and disables the primary action over the limit', async () => {
    const { store, render, panel, text } = setup();
    store.openExport(62_480);
    await render();
    expect(text()).toContain('An edit export holds at most 50,000 devices.');
    expect(text()).toContain('This selection holds 62,480.');
    const primary = panel()?.querySelector<HTMLButtonElement>(
      '.export-actions button[mat-flat-button]',
    );
    expect(primary?.disabled).toBe(true);
    expect(primary?.textContent?.trim()).toBe('Export 62,480 devices');
  });

  it('writes the report columns in grid order', async () => {
    const { store, render, panel } = setup();
    store.openReport(48, ['serialNumber', 'model', 'assetTag']);
    await render();
    const chips = [...(panel()?.querySelectorAll('.col-chips li') ?? [])].map(
      (chip) => chip.textContent?.trim(),
    );
    expect(chips).toEqual(['Serial', 'Model', 'Asset tag']);
    expect(
      panel()
        ?.querySelector('.export-actions button[mat-flat-button]')
        ?.textContent?.trim(),
    ).toBe('Create report');
  });

  it('follows a running job with the phase list and the bar', async () => {
    const { store, render, panel, text } = setup();
    store.openJob('EXP-001');
    await render();
    expect(text()).toContain('Job EXP-001 · Running');
    expect(text()).toContain('Write rows');
    expect(text()).toContain('32 of 48');
    expect(text()).toContain('Prepare download');
    expect(text()).toContain('Closing this dialog keeps the export running.');
    expect(panel()?.querySelector('mat-progress-bar')).not.toBeNull();
    expect(
      panel()?.querySelector('.export-actions button')?.textContent?.trim(),
    ).toBe('Close');
  });

  it('marks a failure in Write rows and leaves Prepare download untouched', async () => {
    const { store, render, panel } = setup(
      exportDetail({
        status: 'failed',
        failure: 'storage-unavailable',
        phase: { name: 'write-rows', done: 12, total: 48 },
        finishedAt: new Date().toISOString(),
      }),
    );
    store.openJob('EXP-001');
    await render();
    expect(phaseStates(panel)).toEqual([['is-failed'], []]);
    expect(panel()?.textContent).toContain('12 of 48');
  });

  it('keeps the completed Write rows while the file prepares', async () => {
    const { store, render, panel, text } = setup(
      exportDetail({
        phase: { name: 'prepare-download', done: 0, total: null },
      }),
    );
    store.openJob('EXP-001');
    await render();
    expect(text()).toContain('48 of 48');
    expect(phaseStates(panel)).toEqual([['is-done'], ['is-current']]);
  });

  it('marks Write rows done when Prepare download fails', async () => {
    const { store, render, panel } = setup(
      exportDetail({
        status: 'failed',
        failure: 'storage-unavailable',
        phase: { name: 'prepare-download', done: 0, total: null },
        finishedAt: new Date().toISOString(),
      }),
    );
    store.openJob('EXP-001');
    await render();
    expect(phaseStates(panel)).toEqual([['is-done'], ['is-failed']]);
  });

  it('marks the stopping Write rows and leaves Prepare download untouched when cancelled', async () => {
    const { store, render, panel } = setup(
      exportDetail({
        status: 'cancelled',
        phase: { name: 'write-rows', done: 12, total: 48 },
        finishedAt: new Date().toISOString(),
      }),
    );
    store.openJob('EXP-001');
    await render();
    expect(phaseStates(panel)).toEqual([['is-stopped'], []]);
  });

  it('shows the ready file with the facts and the download link', async () => {
    const expiresAt = futureExpiry();
    const { store, render, panel, text } = setup(
      exportDetail({
        status: 'completed',
        finishedAt: new Date().toISOString(),
        phase: null,
        exportFile: {
          name: 'devices-for-editing-EXP-001.csv',
          format: 'csv',
          sizeBytes: 7987,
          rows: 48,
          columns: 10,
          expiresAt,
          sheetUrl: null,
        },
      }),
    );
    store.openJob('EXP-001');
    await render();
    expect(text()).toContain('devices-for-editing-EXP-001.csv');
    expect(text()).toContain('Ready');
    expect(text()).toContain('7.8 KB');
    expect(text()).toContain('48 rows');
    expect(text()).toContain('10 columns');
    const download = panel()?.querySelector<HTMLAnchorElement>(
      '.export-actions a[mat-flat-button]',
    );
    expect(download?.getAttribute('href')).toBe(
      '/api/devices/exports/EXP-001/file',
    );
    expect(download?.textContent?.trim()).toBe('Download CSV');
  });

  it('marks an expired file and disables the download', async () => {
    const { store, render, panel, text } = setup(
      exportDetail({
        status: 'completed',
        finishedAt: new Date().toISOString(),
        phase: null,
        exportFile: {
          name: 'devices-for-editing-EXP-001.csv',
          format: 'csv',
          sizeBytes: 7987,
          rows: 48,
          columns: 10,
          expiresAt: new Date(Date.now() - 86_400_000).toISOString(),
          sheetUrl: null,
        },
      }),
    );
    store.openJob('EXP-001');
    await render();
    expect(text()).toContain('Expired');
    expect(text()).toContain('The file expired');
    expect(
      panel()
        ?.querySelector('.export-actions button[mat-flat-button]')
        ?.hasAttribute('disabled'),
    ).toBe(true);
  });

  it('shows a Sheet file without a byte size or an expiry line', async () => {
    const { store, render, text } = setup(
      exportDetail({
        status: 'completed',
        finishedAt: new Date().toISOString(),
        phase: null,
        exportFile: {
          name: 'devices-for-editing-EXP-003',
          format: 'sheet',
          sizeBytes: null,
          rows: 48,
          columns: 10,
          expiresAt: null,
          sheetUrl: 'https://docs.google.com/spreadsheets/d/1Abc_def-ghi/edit',
        },
      }),
    );
    store.openJob('EXP-003');
    await render();
    expect(text()).toContain('devices-for-editing-EXP-003');
    expect(text()).toContain('Ready');
    expect(text()).toContain('48 rows');
    expect(text()).toContain('10 columns');
    // A Sheet never expires and holds no byte size (Drive slice design section 1).
    expect(text()).not.toContain('Available until');
    expect(text()).not.toContain('KB');
  });

  it('expires an open ready file at its deadline', async () => {
    const { store, render, panel, text } = setup(
      exportDetail({
        status: 'completed',
        finishedAt: new Date().toISOString(),
        phase: null,
        exportFile: {
          name: 'devices-for-editing-EXP-001.csv',
          format: 'csv',
          sizeBytes: 7987,
          rows: 48,
          columns: 10,
          expiresAt: new Date(Date.now() + 300).toISOString(),
          sheetUrl: null,
        },
      }),
    );
    store.openJob('EXP-001');
    await render();
    expect(text()).toContain('Ready');
    expect(
      panel()?.querySelector('.export-actions a[mat-flat-button]'),
    ).not.toBeNull();
    // The deadline passes without a job event or a manual read.
    await new Promise((resolve) => setTimeout(resolve, 450));
    await render();
    expect(text()).toContain('Expired');
    expect(
      panel()?.querySelector('.export-actions a[mat-flat-button]'),
    ).toBeNull();
    expect(
      panel()
        ?.querySelector('.export-actions button[mat-flat-button]')
        ?.hasAttribute('disabled'),
    ).toBe(true);
  });

  it('expires an open ready file at its 30-day deadline', async () => {
    vi.useFakeTimers();
    const deadline = Date.now() + 30 * 24 * 60 * 60 * 1000;
    const { store, fixture, panel, text } = setup(
      exportDetail({
        status: 'completed',
        finishedAt: new Date().toISOString(),
        phase: null,
        exportFile: {
          name: 'devices-for-editing-EXP-001.csv',
          format: 'csv',
          sizeBytes: 7987,
          rows: 48,
          columns: 10,
          expiresAt: new Date(deadline).toISOString(),
          sheetUrl: null,
        },
      }),
    );
    store.openJob('EXP-001');
    // The read settles on microtasks, so the fake clock stays at its start.
    for (let turn = 0; turn < 10; turn++) await Promise.resolve();
    fixture.detectChanges();
    expect(text()).toContain('Ready');
    expect(
      panel()?.querySelector('.export-actions a[mat-flat-button]'),
    ).not.toBeNull();
    // The retention is longer than one native timer, and the file still flips.
    await vi.advanceTimersByTimeAsync(30 * 24 * 60 * 60 * 1000 + 60_000);
    fixture.detectChanges();
    expect(text()).toContain('Expired');
    expect(
      panel()?.querySelector('.export-actions a[mat-flat-button]'),
    ).toBeNull();
    expect(
      panel()
        ?.querySelector('.export-actions button[mat-flat-button]')
        ?.hasAttribute('disabled'),
    ).toBe(true);
  });

  it('marks the checked CSV card with the selected treatment', async () => {
    const { store, render, panel } = setup();
    store.openExport(6);
    await render();
    const cards = [
      ...(panel()?.querySelectorAll('mat-radio-button.option-card') ?? []),
    ];
    expect(cards).toHaveLength(2);
    expect(cards[0].classList.contains('mat-mdc-radio-checked')).toBe(true);
    expect(cards[1].classList.contains('mat-mdc-radio-checked')).toBe(false);
    // The browser suite asserts the computed accent border of this class (state 02).
  });

  it('keeps the phase heading out of the visible layout', async () => {
    const { store, render, panel } = setup();
    store.openJob('EXP-001');
    await render();
    const heading = panel()?.querySelector<HTMLElement>('#phases-label');
    expect(heading?.textContent?.trim()).toBe('Export phases');
    expect(heading?.getAttribute('aria-hidden')).toBeNull();
    const style = getComputedStyle(heading as HTMLElement);
    expect(style.position).toBe('absolute');
    expect(style.width).toBe('1px');
    expect(style.height).toBe('1px');
  });

  it('docks the help pane and switches its topic', async () => {
    const { store, render, element, panel, text } = setup();
    store.openExport(48);
    await render();
    panel()
      ?.querySelector<HTMLButtonElement>(
        'button[aria-label="Export and import help"]',
      )
      ?.click();
    await render();
    expect(panel()?.classList.contains('has-help')).toBe(true);
    const help = element.querySelector('app-device-export-help');
    expect(help?.querySelector('h3')?.textContent?.trim()).toBe(
      'Export and import help',
    );
    expect(text()).toContain('Editing rules');
    const toggles = [
      ...(help?.querySelectorAll<HTMLButtonElement>(
        'mat-button-toggle button',
      ) ?? []),
    ];
    expect(toggles.map((toggle) => toggle.textContent?.trim())).toEqual([
      'Export',
      'Reports',
      'Import',
      'Review',
    ]);
    toggles[1].click();
    await render();
    expect(help?.textContent).toContain(
      'Reports writes the visible grid columns of the selected devices, in grid order.',
    );
  });

  it('closes on Escape and emits closed', async () => {
    const { store, render, panel, component } = setup();
    const closed = vi.fn();
    // The page returns focus through this output (UI-09).
    component.closed.subscribe(closed);
    store.openExport(48);
    await render();
    panel()?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    await render();
    expect(store.open()).toBe(false);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('retains an Activity-opened export for its entry', async () => {
    const { store, render } = setup();
    store.openJob('EXP-001');
    await render();
    expect(store.activeJobs().edit).toEqual({
      displayId: 'EXP-001',
      purpose: 'edit',
      format: 'csv',
    });
    store.close();
    await render();
    store.openExport(0);
    await render();
    expect(store.step()).toBe('monitor');
    expect(store.displayId()).toBe('EXP-001');
  });

  it('keeps one retained job for Export and one for Reports', async () => {
    const reportJobId = '1f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a11';
    const request = async (path: string, body?: unknown) => {
      if (path === '/api/devices/exports') {
        const purpose = (body as { purpose: string }).purpose;
        return response({
          jobId: purpose === 'report' ? reportJobId : jobId,
          displayId: purpose === 'report' ? 'EXP-002' : 'EXP-001',
          status: 'accepted',
          rows: 48,
        });
      }
      if (path === '/api/jobs/EXP-001') return response(exportDetail());
      if (path === '/api/jobs/EXP-002')
        return response(
          exportDetail({
            jobId: reportJobId,
            displayId: 'EXP-002',
            exportSummary: { purpose: 'report' },
          }),
        );
      return response({});
    };
    const { store, render } = setup(exportDetail(), request);
    store.openExport(48);
    await render();
    await store.submit({
      gridId: 'devices',
      tabId: 'tab-1',
      purpose: 'edit',
      format: 'csv',
      sort: { field: 'serialNumber', direction: 'asc' },
      columns: [],
    });
    await render();
    store.close();
    await render();

    store.openReport(48, ['serialNumber']);
    await render();
    expect(store.step()).toBe('configure');
    await store.submit({
      gridId: 'devices',
      tabId: 'tab-1',
      purpose: 'report',
      format: 'csv',
      sort: { field: 'serialNumber', direction: 'asc' },
      columns: ['serialNumber'],
    });
    await render();
    store.close();
    await render();

    store.openExport(0);
    await render();
    expect(store.step()).toBe('monitor');
    expect(store.displayId()).toBe('EXP-001');
    store.close();
    await render();
    store.openReport(0, []);
    await render();
    expect(store.step()).toBe('monitor');
    expect(store.displayId()).toBe('EXP-002');
  });

  it('releases a failed export with Done and starts a fresh configure', async () => {
    const { store, render, panel } = setup(
      exportDetail({
        status: 'failed',
        failure: 'export-too-large',
        phase: { name: 'write-rows', done: 12, total: 48 },
        finishedAt: new Date().toISOString(),
      }),
    );
    store.openJob('EXP-001');
    await render();
    expect(panel()?.textContent).toContain('The file passed the 1 GiB limit');
    const done = [
      ...(panel()?.querySelectorAll<HTMLButtonElement>(
        '.export-actions button',
      ) ?? []),
    ].find((button) => button.textContent?.trim() === 'Done');
    expect(done).toBeDefined();
    done?.click();
    await render();
    expect(store.open()).toBe(false);
    expect(store.activeJobs().edit).toBeNull();
    store.openExport(6);
    await render();
    expect(store.step()).toBe('configure');
  });

  it('releases a cancelled export with Done and starts a fresh configure', async () => {
    const { store, render, panel } = setup(
      exportDetail({
        status: 'cancelled',
        phase: { name: 'prepare-download', done: 0, total: null },
        progress: {
          total: 48,
          succeeded: 0,
          failed: 0,
          unknown: 0,
          skipped: 0,
          expired: 0,
          cancelled: 48,
          pending: 0,
        },
        finishedAt: new Date().toISOString(),
      }),
    );
    store.openJob('EXP-001');
    await render();
    expect(panel()?.textContent).toContain(
      'The export stopped before it finished. No file was written.',
    );
    const done = [
      ...(panel()?.querySelectorAll<HTMLButtonElement>(
        '.export-actions button',
      ) ?? []),
    ].find((button) => button.textContent?.trim() === 'Done');
    expect(done).toBeDefined();
    done?.click();
    await render();
    expect(store.open()).toBe(false);
    expect(store.activeJobs().edit).toBeNull();
    store.openExport(6);
    await render();
    expect(store.step()).toBe('configure');
  });

  it('drops a held receipt after another person takes over', async () => {
    const session = signal<{ identity: { id: string } } | null>({
      identity: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    });
    const held = deferred<Response>();
    const request = async (path: string) =>
      path === '/api/devices/exports' ? held.promise : response(exportDetail());
    const { store, render, fixture } = setup(exportDetail(), request, session);
    store.openExport(48);
    await render();
    const pending = store.submit({
      gridId: 'devices',
      tabId: 'tab-1',
      purpose: 'edit',
      format: 'csv',
      sort: { field: 'serialNumber', direction: 'asc' },
      columns: [],
    });
    session.set({ identity: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } });
    fixture.detectChanges();
    await fixture.whenStable();
    held.resolve(accepted());
    await expect(pending).resolves.toBe(false);
    await render();
    expect(store.activeJobs().edit).toBeNull();
    expect(store.open()).toBe(false);
    expect(store.submitting()).toBe(false);
  });

  it('keeps a successor submit fenced when an earlier body settles', async () => {
    const session = signal<{ identity: { id: string } } | null>({
      identity: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    });
    const first = deferred<Response>();
    const second = deferred<Response>();
    let calls = 0;
    const request = async (path: string) => {
      if (path !== '/api/devices/exports') return response(exportDetail());
      calls += 1;
      return calls === 1 ? first.promise : second.promise;
    };
    const { store, render, fixture } = setup(exportDetail(), request, session);
    const submit = () =>
      store.submit({
        gridId: 'devices',
        tabId: 'tab-1',
        purpose: 'edit',
        format: 'csv',
        sort: { field: 'serialNumber', direction: 'asc' },
        columns: [],
      });
    store.openExport(48);
    await render();
    const earlier = submit();
    session.set({ identity: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } });
    fixture.detectChanges();
    await fixture.whenStable();
    store.openExport(48);
    await render();
    const successor = submit();
    expect(store.submitting()).toBe(true);
    first.resolve(accepted());
    await expect(earlier).resolves.toBe(false);
    // The stale answer must not open the gate for a second click.
    expect(store.submitting()).toBe(true);
    expect(store.activeJobs().edit).toBeNull();
    second.resolve(accepted());
    await expect(successor).resolves.toBe(true);
    expect(store.submitting()).toBe(false);
  });

  it('retains a held receipt without replacing another open flow', async () => {
    const held = deferred<Response>();
    const request = async (path: string) =>
      path === '/api/devices/exports' ? held.promise : response(exportDetail());
    const { store, render } = setup(exportDetail(), request);
    store.openExport(48);
    await render();
    const pending = store.submit({
      gridId: 'devices',
      tabId: 'tab-1',
      purpose: 'edit',
      format: 'csv',
      sort: { field: 'serialNumber', direction: 'asc' },
      columns: [],
    });
    store.close();
    await render();
    store.openImport();
    await render();
    held.resolve(accepted());
    await expect(pending).resolves.toBe(true);
    await render();
    expect(store.step()).toBe('import');
    expect(store.displayId()).toBeNull();
    expect(store.activeJobs().edit).toEqual({
      displayId: 'EXP-001',
      purpose: 'edit',
      format: 'csv',
    });
  });
});

import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import {
  DEVICE_EDIT_TEMPLATE_HEADERS,
  type JobDetail,
} from '@campus/application-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthStore } from '../auth.store';
import { LiveFeeds, type LiveFeedHandlers } from '../jobs/live-feeds';
import { DeviceExportImportDialog } from './device-export-import-dialog';
import { DeviceExportImportStore } from './device-export-import.store';

/**
 * The unit-test DOM has no `Blob.arrayBuffer`, and every browser that runs the app has one. The
 * header read of states 09 and 10 reads a slice through it, so the spec supplies the same
 * contract through `FileReader`.
 */
if (typeof Blob.prototype.arrayBuffer !== 'function') {
  Blob.prototype.arrayBuffer = function arrayBuffer(this: Blob) {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(this);
    });
  };
}

const jobId = '0f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10';
const planId = '9a1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10';
const person = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  displayName: 'District Admin',
};
const future = (days = 7) =>
  new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
const past = () => new Date(Date.now() - 60_000).toISOString();

/** The template header line of the edit CSV, so the header check passes (state 09). */
const goodHeader = `${DEVICE_EDIT_TEMPLATE_HEADERS.join(',')}\r\n`;
/** One data row with exactly as many cells as the template has columns. */
const dataRow = `${DEVICE_EDIT_TEMPLATE_HEADERS.map((_, index) =>
  index === 0 ? 'C0A1-0001' : index === 1 ? 'SN-1' : '',
).join(',')}\r\n`;
const csv = (header: string) => `${header}${dataRow}`;

const importDetail = (overrides: Partial<JobDetail> = {}): JobDetail => ({
  jobId,
  displayId: 'IMP-001',
  revision: 4,
  action: 'validate-device-import',
  status: 'running',
  scope: { kind: 'devices', deviceCount: 48 },
  requestedBy: person,
  createdAt: new Date(Date.now() - 60_000).toISOString(),
  startedAt: new Date(Date.now() - 50_000).toISOString(),
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
  phase: { name: 'refresh', done: 5, total: 48 },
  exportSummary: null,
  exportFile: null,
  importSummary: {
    mode: 'sync-changes',
    planState: null,
    proposed: 0,
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
    name: 'devices.csv',
    sizeBytes: 7_936,
    rowsRead: 5,
    candidateRows: 48,
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
  ...overrides,
});

const counts = {
  rows: 48,
  unchanged: 30,
  noChangeNeeded: 4,
  proposed: 12,
  rejected: 2,
};

const changes = {
  fieldChanges: 7,
  fieldChangeDevices: 6,
  disable: 1,
  reenable: 0,
  deprovision: [],
};

const refresh = { staleDevicesRead: 5, oldestObservedAt: past() };

const proposedLine = {
  row: 2,
  deviceId: 'C0A1-0001',
  serialNumber: 'SN-1',
  change: {
    type: 'field' as const,
    field: 'orgUnitPath' as const,
    operation: 'move' as const,
    currentValue: '/Students/Lowell Academy/Grade 9/Advisory A/Homeroom 12/Section 3',
    newValue: '/Students/Lowell Academy/Grade 10/Advisory B/Homeroom 4/Section 7',
  },
  column: null,
  submittedValue: null,
  reason: null,
  notRun: null,
  jobDisplayId: null,
  operationNumber: null,
  outcome: null,
};

const report = (overrides: Record<string, unknown> = {}) => ({
  jobId,
  displayId: 'IMP-001',
  view: 'proposed',
  page: 0,
  pageCount: 2,
  counts,
  refresh,
  changes,
  lines: [proposedLine],
  total: 12,
  plan: null,
  ...overrides,
});

const response = (body: unknown, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as unknown as Response;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => (resolve = settle));
  return { promise, resolve };
}

/** Every route that the import steps read, with the answers that one case needs. */
interface Routes {
  detail: JobDetail;
  reports?: (view: string, page: number) => unknown;
  upload?: () => Promise<Response>;
  receipt?: unknown;
}

function setup(routes: Routes) {
  const calls: { path: string; body?: unknown }[] = [];
  const request = vi.fn(async (path: string, body?: unknown) => {
    calls.push({ path, body });
    if (path.startsWith('/api/jobs/') && path.endsWith('/cancel'))
      return response({});
    if (path.startsWith('/api/jobs/')) return response(routes.detail);
    if (path.includes('/report?')) {
      const url = new URL(path, 'http://x');
      const view = url.searchParams.get('view') ?? 'proposed';
      const page = Number(url.searchParams.get('page') ?? '0');
      return response(
        routes.reports?.(view, page) ?? report({ view, page }),
      );
    }
    if (path.endsWith('/cancel')) return response({});
    if (path.endsWith('/revalidate'))
      return response(
        routes.receipt ?? { jobId, displayId: 'IMP-001', status: 'accepted' },
      );
    if (path.startsWith('/api/devices/imports')) {
      if (routes.upload) return routes.upload();
      return response(
        routes.receipt ?? {
          jobId,
          displayId: 'IMP-001',
          status: 'accepted',
          mode: 'sync-changes',
          name: 'devices.csv',
          sizeBytes: 7_936,
        },
      );
    }
    return response({}, 404);
  });
  const feedUrls: string[] = [];
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: AuthStore, useValue: { session: () => null, can: () => true, request } },
      {
        provide: LiveFeeds,
        useValue: {
          subscribe: (url: string, _handlers: LiveFeedHandlers) => {
            feedUrls.push(url);
            return {
              active: true,
              connected: true,
              ready: Promise.resolve(),
              close: () => undefined,
              restart: () => undefined,
              resume: () => undefined,
            };
          },
        },
      },
    ],
  });
  const fixture = TestBed.createComponent(DeviceExportImportDialog);
  fixture.componentRef.setInput('tabId', '6f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10');
  const store = TestBed.inject(DeviceExportImportStore);
  fixture.detectChanges();
  const element: HTMLElement = fixture.nativeElement;
  const render = async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const panel = () => element.querySelector<HTMLElement>('section[role="dialog"]');
  const text = () => panel()?.textContent?.replace(/\s+/g, ' ') ?? '';
  const tab = (index: number) =>
    panel()?.querySelectorAll<HTMLElement>('button[mat-tab-link]')[index];
  const button = (name: string | RegExp) =>
    [...(panel()?.querySelectorAll('button, a') ?? [])].find((node) =>
      typeof name === 'string'
        ? node.textContent?.replace(/\s+/g, ' ').trim() === name
        : name.test(node.textContent ?? ''),
    ) as HTMLElement | undefined;
  return { fixture, element, store, render, panel, text, button, tab, request, calls, feedUrls };
}

afterEach(() => {
  TestBed.resetTestingModule();
  vi.useRealTimers();
});

beforeEach(() => {
  TestBed.resetTestingModule();
});

describe('the Import step of the dialog', () => {
  it('shows the setup step with the mode pair, the source choice, and the drop zone', async () => {
    const { render, text, button, store } = setup({ detail: importDetail() });
    store.openImport();
    await render();
    expect(text()).toContain('Import');
    expect(text()).toContain('CSV file · Not submitted');
    expect(text()).toContain('Import mode');
    expect(text()).toContain('Sync changes');
    expect(text()).toContain('Sync all rows');
    expect(text()).toContain('Upload a CSV file');
    expect(text()).toContain('Google Drive');
    expect(text()).toContain('Drop a CSV file here');
    expect(text()).toContain('Choose CSV file');
    expect(button('Start validation')?.hasAttribute('disabled')).toBe(true);
  });

  it('reads the first 64 KiB and passes the header of a chosen file', async () => {
    const { render, text, button, store } = setup({ detail: importDetail() });
    store.openImport();
    await render();
    await store.chooseImportFile(
      new File([csv(goodHeader)], 'devices.csv', { type: 'text/csv' }),
    );
    await render();
    expect(text()).toContain('devices.csv');
    expect(text()).toContain('Header check passed.');
    expect(button('Start validation')?.hasAttribute('disabled')).toBe(false);
  });

  it('refuses a file whose header lacks a column and keeps the primary action disabled', async () => {
    const { render, text, button, store } = setup({ detail: importDetail() });
    store.openImport();
    await render();
    await store.chooseImportFile(
      new File(['Device ID,Serial number\r\n'], 'short.csv'),
    );
    await render();
    expect(text()).toContain('The file is missing the');
    expect(text()).toContain('Sync changes needs the Checksum column.');
    expect(button('Start validation')?.hasAttribute('disabled')).toBe(true);
  });

  it('refuses a file above 1 GiB and never uploads it', async () => {
    const { render, text, button, store, calls } = setup({ detail: importDetail() });
    store.openImport();
    await render();
    const big = new File(['a'], 'huge.csv');
    Object.defineProperty(big, 'size', { value: 1_073_741_825 });
    await store.chooseImportFile(big);
    await render();
    expect(text()).toContain('1 GiB');
    expect(button('Start validation')?.hasAttribute('disabled')).toBe(true);
    button('Start validation')?.click();
    await render();
    expect(calls.filter((call) => call.path.startsWith('/api/devices/imports'))).toHaveLength(0);
  });

  it('uploads the raw file as text/csv and follows the phases and counters', async () => {
    const { render, text, store, calls } = setup({ detail: importDetail() });
    store.openImport();
    await render();
    await store.chooseImportFile(
      new File([csv(goodHeader)], 'devices.csv', { type: 'text/csv' }),
    );
    await render();
    await store.startValidation();
    await render();
    const upload = calls.find((call) => call.path.startsWith('/api/devices/imports?'));
    expect(upload?.path).toContain('mode=sync-changes');
    expect(upload?.path).toContain('name=devices.csv');
    expect(text()).toContain('Job IMP-001');
    expect(text()).toContain('Upload');
    expect(text()).toContain('Header check');
    expect(text()).toContain('Refresh stale devices');
    expect(text()).toContain('5 of 48');
    expect(text()).toContain('Rows read');
    expect(text()).toContain('Edited rows');
    expect(text()).toContain('Stop validation');
    expect(text()).toContain('Closing this dialog keeps the validation running.');
  });

  it('cancels the job when a stop arrives before the receipt', async () => {
    const upload = deferred<Response>();
    const { render, store, calls } = setup({
      detail: importDetail(),
      upload: () => upload.promise,
    });
    store.openImport();
    await render();
    await store.chooseImportFile(
      new File([csv(goodHeader)], 'devices.csv', { type: 'text/csv' }),
    );
    const started = store.startValidation();
    await render();
    await store.stopValidation();
    upload.resolve(
      response({
        jobId,
        displayId: 'IMP-001',
        status: 'accepted',
        mode: 'sync-changes',
        name: 'devices.csv',
        sizeBytes: 7_936,
      }),
    );
    await started;
    await render();
    const cancel = calls.find((call) => call.path === '/api/jobs/IMP-001/cancel');
    expect(cancel).toBeDefined();
  });

  it('shows a refused validation with the reason paragraphs and no report', async () => {
    const { render, text, store } = setup({
      detail: importDetail({
        status: 'failed',
        phase: null,
        failure: 'storage-unavailable',
        importSource: {
          name: 'devices.csv',
          sizeBytes: 7_936,
          rowsRead: 2,
          candidateRows: 0,
          refusalText:
            'The file is not UTF-8 text. Save it as UTF-8 CSV and import it again.',
        },
      }),
    });
    store.openJob('IMP-001');
    await render();
    expect(text()).toContain('No report');
    expect(text()).toContain('The file is not UTF-8 text.');
    expect(text()).toContain('Import again');
  });

  it('shows a stopped validation with the stop line and the stored reads', async () => {
    const { render, text, store } = setup({
      detail: importDetail({
        status: 'cancelled',
        cancelRequest: { by: person, at: past() },
      }),
    });
    store.openJob('IMP-001');
    await render();
    expect(text()).toContain('No report');
    expect(text()).toContain('Cancelled');
    expect(text()).toContain('Import again');
  });

  it('shows the report equation, the change line, and the tabs at 1120 px', async () => {
    const { render, text, store, panel } = setup({
      detail: importDetail({ status: 'completed' }),
      reports: (view) =>
        view === 'proposed'
          ? report({
              plan: {
                planId,
                revision: 1,
                state: 'open',
                expiresAt: future(),
                changedBy: null,
                changedAt: null,
              },
            })
          : report({ view, lines: [], total: 0, pageCount: 1, plan: null }),
    });
    store.openJob('IMP-001');
    await render();
    expect(panel()?.className).toContain('is-wide');
    expect(text()).toContain('48');
    expect(text()).toContain('Unchanged');
    expect(text()).toContain('No change needed');
    expect(text()).toContain('Proposed');
    expect(text()).toContain('Rejected');
    expect(text()).toContain('Proposed changes:');
    expect(text()).toContain('7 field changes on 6 devices');
    expect(text()).toContain('Validation refreshed 5 stale devices');
    expect(text()).toContain('Open');
    expect(text()).toContain('Cancel import');
  });

  it('cuts a long path at a boundary and keeps the whole path in the tooltip', async () => {
    const { render, store, panel } = setup({
      detail: importDetail({ status: 'completed' }),
      reports: (view) =>
        report({
          view,
          lines: view === 'proposed' ? [proposedLine] : [],
          total: view === 'proposed' ? 12 : 0,
          pageCount: view === 'proposed' ? 2 : 1,
        }),
    });
    store.openJob('IMP-001');
    await render();
    const cell = panel()?.querySelector<HTMLElement>('td.col-value .cut');
    expect(cell?.textContent?.trim().startsWith('…/')).toBe(true);
    expect(cell?.textContent?.trim().endsWith('/Section 3')).toBe(true);
    expect(cell?.getAttribute('title')).toBe(
      '/Students/Lowell Academy/Grade 9/Advisory A/Homeroom 12/Section 3',
    );
  });

  it('pages the report ten lines at a time', async () => {
    const { render, text, store, button } = setup({
      detail: importDetail({ status: 'completed' }),
      reports: (view, page) =>
        report({
          view,
          page,
          pageCount: view === 'proposed' ? 2 : 1,
          lines: view === 'proposed' ? [proposedLine] : [],
          total: view === 'proposed' ? 12 : 0,
        }),
    });
    store.openJob('IMP-001');
    await render();
    expect(text()).toContain('Rows 1–1 of 12 proposed changes');
    button('chevron_right')?.click();
    await render();
    expect(text()).toContain('Rows 11–11 of 12 proposed changes');
  });

  it('lists the rejected rows with the reason and the rejected download', async () => {
    const { render, text, store, panel, tab } = setup({
      detail: importDetail({ status: 'completed' }),
      reports: (view) =>
        report({
          view,
          total: view === 'rejected' ? 2 : view === 'proposed' ? 12 : 0,
          lines:
            view === 'rejected'
              ? [
                  {
                    ...proposedLine,
                    change: null,
                    column: 'Status',
                    submittedValue: 'Gone',
                    reason: 'The status "Gone" is not a Google status.',
                  },
                ]
              : [],
        }),
    });
    store.openJob('IMP-001');
    await render();
    tab(1)?.click();
    await render();
    expect(store.reportView()).toBe('rejected');
    expect(text()).toContain('The status "Gone" is not a Google status.');
    expect(text()).toContain('Download rejected rows');
    expect(
      panel()?.querySelector('a.download-rejected')?.getAttribute('href'),
    ).toBe('/api/devices/imports/IMP-001/rejected');
  });

  it('lists the warnings of a validated file', async () => {
    const { render, text, store, tab } = setup({
      detail: importDetail({ status: 'completed' }),
      reports: (view) =>
        report({
          view,
          total: view === 'warnings' ? 1 : view === 'proposed' ? 12 : 0,
          lines:
            view === 'warnings'
              ? [
                  {
                    ...proposedLine,
                    row: null,
                    deviceId: null,
                    change: null,
                    reason: 'The column "Grade" is unknown. It stays out of every write.',
                  },
                ]
              : [],
        }),
    });
    store.openJob('IMP-001');
    await render();
    tab(2)?.click();
    await render();
    expect(text()).toContain('The column "Grade" is unknown.');
  });

  it('offers Validate again at the expiry of an open plan', async () => {
    const { render, text, store } = setup({
      detail: importDetail({ status: 'completed' }),
      reports: (view) =>
        report({
          view,
          total: view === 'proposed' ? 12 : 0,
          lines: view === 'proposed' ? [proposedLine] : [],
          plan:
            view === 'proposed'
              ? {
                  planId,
                  revision: 1,
                  state: 'open',
                  expiresAt: past(),
                  changedBy: null,
                  changedAt: null,
                }
              : null,
        }),
    });
    store.openJob('IMP-001');
    await render();
    expect(text()).toContain('Expired');
    expect(text()).toContain('Validate again');
  });

  it('shows the no-update state with Done and a disabled Execute', async () => {
    const { render, text, store, button } = setup({
      detail: importDetail({ status: 'completed' }),
      reports: (view) =>
        report({
          view,
          counts: {
            rows: 48,
            unchanged: 48,
            noChangeNeeded: 0,
            proposed: 0,
            rejected: 0,
          },
          changes: {
            fieldChanges: 0,
            fieldChangeDevices: 0,
            disable: 0,
            reenable: 0,
            deprovision: [],
          },
          total: 0,
          lines: [],
          pageCount: 1,
        }),
    });
    store.openJob('IMP-001');
    await render();
    expect(text()).toContain('No changes');
    expect(text()).toContain(
      'Every row matches its export checksum. No update is needed.',
    );
    expect(button('Done')?.textContent?.trim()).toBe('Done');
    expect(button(/^Execute/)?.hasAttribute('disabled')).toBe(true);
  });

  it('shows that nothing can run when every row was rejected', async () => {
    const { render, text, store } = setup({
      detail: importDetail({ status: 'completed' }),
      reports: (view) =>
        report({
          view,
          counts: {
            rows: 48,
            unchanged: 0,
            noChangeNeeded: 0,
            proposed: 0,
            rejected: 48,
          },
          changes: {
            fieldChanges: 0,
            fieldChangeDevices: 0,
            disable: 0,
            reenable: 0,
            deprovision: [],
          },
          total: view === 'rejected' ? 48 : 0,
          lines: [],
        }),
    });
    store.openJob('IMP-001');
    await render();
    expect(text()).toContain('No changes');
    expect(text()).toContain('Import again');
    expect(text()).toContain('48 rows are rejected.');
  });

  it('shows the sync-all-rows line on the report', async () => {
    const { render, text, store } = setup({
      detail: importDetail({
        status: 'completed',
        importSummary: {
          mode: 'sync-all-rows',
          planState: null,
          proposed: 12,
          rejected: 0,
          refusal: null,
        },
      }),
      reports: (view) =>
        report({ view, total: view === 'proposed' ? 12 : 0 }),
    });
    store.openJob('IMP-001');
    await render();
    expect(text()).toContain(
      'Sync all rows checks every row, so no row counts as unchanged.',
    );
  });

  it('follows the shared feed and opens no EventSource of its own', async () => {
    const { render, store, feedUrls } = setup({ detail: importDetail() });
    const spy = vi.fn();
    const original = globalThis.EventSource;
    // @ts-expect-error the test replaces the constructor for the length of one case.
    globalThis.EventSource = function EventSource() {
      spy();
    };
    try {
      store.openJob('IMP-001');
      await render();
      expect(feedUrls).toEqual(['/api/jobs/events']);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      globalThis.EventSource = original;
    }
  });
});
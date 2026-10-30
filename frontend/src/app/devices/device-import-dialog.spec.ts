import { signal } from '@angular/core';
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
import { importFailureText } from './device-import-messages';

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
    sourceType: 'csv',
    sizeBytes: 7_936,
    rowsRead: 5,
    candidateRows: 48,
    tabTitle: null,
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
    currentValue:
      '/Students/Lowell Academy/Grade 9/Advisory A/Homeroom 12/Section 3',
    newValue:
      '/Students/Lowell Academy/Grade 10/Advisory B/Homeroom 4/Section 7',
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
  /** The session of the signed-in person. A switch runs the store reset. */
  session?: () => { identity: { id: string } } | null;
  /** A held answer for one route, so a test controls the moment of the result. */
  answer?: (path: string, call: number) => Promise<Response> | undefined;
}

function setup(routes: Routes) {
  const calls: { path: string; body?: unknown }[] = [];
  const request = vi.fn(async (path: string, body?: unknown) => {
    calls.push({ path, body });
    const held = routes.answer?.(path, calls.length);
    if (held) return held;
    if (path.startsWith('/api/jobs/') && path.endsWith('/cancel'))
      return response({});
    if (path.startsWith('/api/jobs/')) return response(routes.detail);
    if (path.includes('/report?')) {
      const url = new URL(path, 'http://x');
      const view = url.searchParams.get('view') ?? 'proposed';
      const page = Number(url.searchParams.get('page') ?? '0');
      return response(routes.reports?.(view, page) ?? report({ view, page }));
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
  /** The handlers of the shared feed, so a test can open it again (R4). */
  const feedHandlers: LiveFeedHandlers[] = [];
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      {
        provide: AuthStore,
        useValue: {
          session: routes.session ?? (() => null),
          can: () => true,
          request,
        },
      },
      {
        provide: LiveFeeds,
        useValue: {
          subscribe: (url: string, handlers: LiveFeedHandlers) => {
            feedUrls.push(url);
            feedHandlers.push(handlers);
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
  fixture.componentRef.setInput(
    'tabId',
    '6f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10',
  );
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
  const panel = () =>
    element.querySelector<HTMLElement>('section[role="dialog"]');
  const text = () => panel()?.textContent?.replace(/\s+/g, ' ') ?? '';
  const tab = (index: number) =>
    panel()?.querySelectorAll<HTMLElement>('button[mat-tab-link]')[index];
  const button = (name: string | RegExp) =>
    [...(panel()?.querySelectorAll('button, a') ?? [])].find((node) => {
      // Angular and Prettier put template whitespace around a label.
      const label = node.textContent?.replace(/\s+/g, ' ').trim() ?? '';
      return typeof name === 'string' ? label === name : name.test(label);
    }) as HTMLElement | undefined;
  return {
    fixture,
    element,
    store,
    render,
    panel,
    text,
    button,
    tab,
    request,
    calls,
    feedUrls,
    feedHandlers,
  };
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

  it('opens the help on the Import topic of state 11 and keeps the four topics', async () => {
    const { render, text, element, store } = setup({ detail: importDetail() });
    store.openImport();
    await render();
    element
      .querySelector<HTMLButtonElement>('button[aria-controls="export-help"]')
      ?.click();
    await render();
    const help = element.querySelector('app-device-export-help');
    expect(help?.textContent).toContain('Export and import help');
    expect(help?.textContent).toContain('Import modes');
    expect(help?.textContent).toContain(
      'Checks every row and resets the devices to the file. Ignores the Checksum column.',
    );
    expect(help?.textContent).toContain('DEPROVISION:<reason code>');
    expect(help?.textContent).toContain('UPGRADE_TRANSFER');
    expect(help?.textContent).toContain(
      'Codes match in upper case, for example DEPROVISION:RETIRING_DEVICE.',
    );
    expect(text()).toContain('Start validation');
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
    const { render, text, button, store, calls } = setup({
      detail: importDetail(),
    });
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
    expect(
      calls.filter((call) => call.path.startsWith('/api/devices/imports')),
    ).toHaveLength(0);
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
    const upload = calls.find((call) =>
      call.path.startsWith('/api/devices/imports?'),
    );
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
    expect(text()).toContain(
      'Closing this dialog keeps the validation running.',
    );
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
    const cancel = calls.find(
      (call) => call.path === '/api/jobs/IMP-001/cancel',
    );
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
          sourceType: 'csv',
          sizeBytes: 7_936,
          rowsRead: 2,
          candidateRows: 0,
          tabTitle: null,
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
                    reason:
                      'The column "Grade" is unknown. It stays out of every write.',
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
      reports: (view) => report({ view, total: view === 'proposed' ? 12 : 0 }),
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
      expect(feedUrls).toEqual(['/api/events']);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      globalThis.EventSource = original;
    }
  });
});

/** An open plan of the report (state 13). */
const openPlan = (overrides: Record<string, unknown> = {}) => ({
  planId,
  revision: 2,
  state: 'open',
  expiresAt: future(),
  changedBy: null,
  changedAt: null,
  ...overrides,
});

/** A validation that finished with a report and an open plan. */
const reportDetail = (overrides: Partial<JobDetail> = {}): JobDetail =>
  importDetail({
    status: 'completed',
    phase: { name: 'report', done: 0, total: null },
    progress: {
      total: 48,
      succeeded: 48,
      failed: 0,
      unknown: 0,
      skipped: 0,
      expired: 0,
      cancelled: 0,
      pending: 0,
    },
    importSummary: {
      mode: 'sync-changes',
      planState: 'open',
      proposed: 12,
      rejected: 2,
      refusal: null,
    },
    importSource: {
      name: 'devices.csv',
      sourceType: 'csv',
      sizeBytes: 7_936,
      rowsRead: 48,
      candidateRows: 48,
      tabTitle: null,
      refusalText: null,
    },
    plan: openPlan() as JobDetail['plan'],
    ...overrides,
  });

const personB = { identity: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } };
const personA = { identity: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } };

describe('the Import entry ownership and report facts', () => {
  it('drops a held plan-cancel answer after a principal switch (R1)', async () => {
    const held = deferred<Response>();
    const session = signal<{ identity: { id: string } } | null>(personA);
    const { render, store } = setup({
      detail: reportDetail(),
      reports: () => report({ plan: openPlan() }),
      session: () => session(),
      answer: (path) => (path.endsWith('/cancel') ? held.promise : undefined),
    });
    store.openImport();
    store.activeImport.set('IMP-001');
    store.openImport();
    await render();
    expect(store.plan()?.state).toBe('open');
    const done = store.cancelImport();
    session.set(personB);
    TestBed.tick();
    await render();
    held.resolve(response({ plan: openPlan({ state: 'cancelled' }) }));
    await done;
    await render();
    // Person B keeps none of person A's report, plan, or busy state.
    expect(store.plan()).toBeNull();
    expect(store.activeImport()).toBeNull();
    expect(store.actionError()).toBe('');
    expect(store.actionBusy()).toBe(false);
  });

  it('does not clear a newer action of the successor (R1)', async () => {
    const heldCancel = deferred<Response>();
    const heldStop = deferred<Response>();
    let heldCancelUsed = false;
    const session = signal<{ identity: { id: string } } | null>(personA);
    const { render, store } = setup({
      detail: reportDetail(),
      reports: () => report({ plan: openPlan() }),
      session: () => session(),
      answer: (path) => {
        if (!path.endsWith('/cancel')) return undefined;
        if (!heldCancelUsed) {
          heldCancelUsed = true;
          return heldCancel.promise;
        }
        return heldStop.promise;
      },
    });
    store.openImport();
    store.activeImport.set('IMP-001');
    store.openImport();
    await render();
    const first = store.cancelImport();
    session.set(personB);
    TestBed.tick();
    await render();
    // The successor starts its own stop on a job that it owns.
    store.activeImport.set('IMP-002');
    store.openJob('IMP-002');
    await render();
    const second = store.stopValidation();
    expect(store.actionBusy()).toBe(true);
    heldCancel.resolve(response({ plan: openPlan({ state: 'cancelled' }) }));
    await first;
    await render();
    expect(store.actionBusy()).toBe(true);
    heldStop.resolve(response({}));
    await second;
    await render();
    expect(store.actionBusy()).toBe(false);
  });

  it('drops a held revalidation receipt after a principal switch (R1)', async () => {
    const held = deferred<Response>();
    const session = signal<{ identity: { id: string } } | null>(personA);
    const { render, store } = setup({
      detail: reportDetail({
        plan: openPlan({
          state: 'expired',
          expiresAt: past(),
        }) as JobDetail['plan'],
      }),
      reports: () =>
        report({ plan: openPlan({ state: 'expired', expiresAt: past() }) }),
      session: () => session(),
      answer: (path) =>
        path.endsWith('/revalidate') ? held.promise : undefined,
    });
    store.openImport();
    store.activeImport.set('IMP-001');
    store.openImport();
    await render();
    const done = store.revalidate();
    session.set(personB);
    TestBed.tick();
    await render();
    held.resolve(response({ jobId, displayId: 'IMP-001', status: 'accepted' }));
    await done;
    await render();
    expect(store.importName()).toBe('');
    expect(store.displayId()).toBeNull();
    expect(store.step()).not.toBe('validation');
    expect(store.actionError()).toBe('');
  });

  it('drops a held file read after the import resets (R2)', async () => {
    const held = deferred<ArrayBuffer>();
    const session = signal<{ identity: { id: string } } | null>(personA);
    const { render, store } = setup({
      detail: importDetail(),
      session: () => session(),
    });
    store.openImport();
    await render();
    const file = new File([csv(goodHeader)], 'devices.csv', {
      type: 'text/csv',
    });
    vi.spyOn(file, 'slice').mockReturnValue({
      arrayBuffer: () => held.promise,
    } as unknown as Blob);
    const read = store.chooseImportFile(file);
    session.set(personB);
    TestBed.tick();
    await render();
    held.resolve(new TextEncoder().encode(csv(goodHeader)).buffer);
    await read;
    await render();
    expect(store.importFile()).toBeNull();
    expect(store.importReady()).toBe(false);
  });

  it('selects the file of a read that belongs to the open entry (R2 control)', async () => {
    const { render, store } = setup({ detail: importDetail() });
    store.openImport();
    await render();
    const file = new File([csv(goodHeader)], 'devices.csv', {
      type: 'text/csv',
    });
    await store.chooseImportFile(file);
    await render();
    expect(store.importFile()?.check).toBe('passed');
    expect(store.importReady()).toBe(true);
  });

  it('keeps the Stop intent of a pending upload and cancels the job that it receives (R3)', async () => {
    const held = deferred<Response>();
    const { render, store, calls } = setup({
      detail: importDetail(),
      upload: () => held.promise,
    });
    store.openImport();
    await render();
    const file = new File([csv(goodHeader)], 'devices.csv', {
      type: 'text/csv',
    });
    await store.chooseImportFile(file);
    await render();
    const upload = store.startValidation();
    expect(store.uploading()).toBe(true);
    await store.stopValidation();
    store.close();
    // Import returns to the upload that this tab still owns, not to a fresh setup (R3).
    store.openImport();
    await render();
    expect(store.step()).toBe('validation');
    expect(store.importName()).toBe('devices.csv');
    held.resolve(
      response({
        jobId,
        displayId: 'IMP-001',
        status: 'accepted',
        mode: 'sync-changes',
        name: 'devices.csv',
        sizeBytes: 7_936,
      }),
    );
    await upload;
    await render();
    expect(
      calls.filter((call) => call.path.startsWith('/api/devices/imports')),
    ).toHaveLength(1);
    expect(calls.some((call) => call.path === '/api/jobs/IMP-001/cancel')).toBe(
      true,
    );
    expect(store.uploading()).toBe(false);
  });

  it('keeps the report facts of the job that produced them (R4)', async () => {
    const held = deferred<Response>();
    let firstPage = true;
    const { render, store } = setup({
      detail: reportDetail(),
      reports: () => report({ plan: openPlan() }),
      answer: (path) => {
        if (!path.includes('/report?')) return undefined;
        if (!firstPage) return undefined;
        firstPage = false;
        return held.promise;
      },
    });
    store.openImport();
    store.activeImport.set('IMP-001');
    store.openImport();
    await render();
    // The first report answer is still held while the job ends its entry.
    store.importAgain();
    await render();
    held.resolve(response(report({ plan: openPlan(), counts })));
    await render();
    expect(store.reportCounts()).toBeNull();
    expect(store.plan()).toBeNull();
    expect(store.step()).toBe('import');
  });

  it('refreshes the shown page when the job revision changes (R4)', async () => {
    let planState = 'open';
    const detail = reportDetail({ revision: 4 });
    const { render, store } = setup({
      detail,
      reports: () =>
        report({
          plan: openPlan({ state: planState }),
          counts,
        }),
    });
    store.openImport();
    store.activeImport.set('IMP-001');
    store.openImport();
    await render();
    expect(store.plan()?.state).toBe('open');
    planState = 'cancelled';
    detail.revision = 5;
    store.openImport();
    await render();
    await render();
    expect(store.plan()?.state).toBe('cancelled');
  });

  it('detaches the old job read when a fresh Import starts (R5)', async () => {
    const held = deferred<Response>();
    const { render, store } = setup({
      detail: importDetail({ displayId: 'IMP-009' }),
      answer: (path) =>
        path === '/api/jobs/IMP-009' ? held.promise : undefined,
    });
    store.openImport();
    store.activeImport.set('IMP-009');
    store.openImport();
    await render();
    store.importAgain();
    await render();
    held.resolve(response(importDetail({ displayId: 'IMP-009' })));
    await render();
    expect(store.job()).toBeNull();
    expect(store.displayId()).toBeNull();
  });

  it('keeps a pending import and its Stop intent when another flow finishes (R3)', async () => {
    const held = deferred<Response>();
    const routes: Routes = {
      detail: importDetail(),
      upload: () => held.promise,
    };
    const { render, store, calls } = setup(routes);
    store.openImport();
    await render();
    await store.chooseImportFile(
      new File([csv(goodHeader)], 'devices.csv', { type: 'text/csv' }),
    );
    const upload = store.startValidation();
    await store.stopValidation();
    store.close();
    // A finished export of another flow is the entry that this Done releases.
    routes.detail = importDetail({
      jobId: '1f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a11',
      displayId: 'EXP-001',
      action: 'export-devices',
      status: 'completed',
      phase: null,
      exportSummary: { purpose: 'edit' },
      exportFile: null,
      importSummary: null,
      importSource: null,
      plan: null,
      finishedAt: past(),
    });
    store.openJob('EXP-001');
    await render();
    expect(store.step()).toBe('monitor');
    store.done();
    await render();
    expect(store.open()).toBe(false);
    held.resolve(
      response({
        jobId,
        displayId: 'IMP-001',
        status: 'accepted',
        mode: 'sync-changes',
        name: 'devices.csv',
        sizeBytes: 7_936,
      }),
    );
    await upload;
    await render();
    // The receipt and the requested Stop survive the other flow's Done.
    expect(store.activeImport()).toBe('IMP-001');
    expect(
      calls.filter((call) => call.path === '/api/jobs/IMP-001/cancel'),
    ).toHaveLength(1);
    expect(store.uploading()).toBe(false);
    expect(store.stopRequested()).toBe(false);
  });

  /** A finished export of another flow, at the step whose Done releases it. */
  const finishedExport = (
    purpose: 'edit' | 'report',
    surface: 'file' | 'monitor',
  ): JobDetail =>
    importDetail({
      jobId: '1f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a11',
      displayId: 'EXP-001',
      action: 'export-devices',
      status: 'completed',
      phase: null,
      exportSummary: { purpose },
      exportFile:
        surface === 'file'
          ? {
              name: 'devices-for-editing-EXP-001.csv',
              format: 'csv',
              sizeBytes: 7_987,
              rows: 48,
              columns: 10,
              expiresAt: future(),
              sheetUrl: null,
            }
          : null,
      importSummary: null,
      importSource: null,
      plan: null,
      finishedAt: past(),
    });

  for (const purpose of ['edit', 'report'] as const) {
    for (const surface of ['file', 'monitor'] as const) {
      it(`restores the retained report after a ${purpose} ${surface} Done (R3)`, async () => {
        const routes: Routes = {
          detail: reportDetail(),
          reports: () => report({ plan: openPlan(), counts }),
        };
        const { render, store, text, button, calls } = setup(routes);
        store.openImport();
        store.activeImport.set('IMP-001');
        store.openImport();
        await render();
        expect(store.step()).toBe('report');
        const reportReads = () =>
          calls.filter((call) => call.path.includes('/report?')).length;
        const before = reportReads();
        // Close Import and finish another flow of the same dialog.
        store.close();
        routes.detail = finishedExport(purpose, surface);
        store.openJob('EXP-001');
        await render();
        expect(store.step()).toBe(surface);
        store.done();
        await render();
        expect(store.open()).toBe(false);
        expect(store.activeImport()).toBe('IMP-001');
        // Import returns to the retained report, even when its job revision did not move.
        routes.detail = reportDetail();
        store.openImport();
        await render();
        expect(store.step()).toBe('report');
        expect(store.reportCounts()).toEqual(counts);
        expect(store.plan()?.state).toBe('open');
        expect(store.reportLines()).toEqual([proposedLine]);
        expect(reportReads()).toBe(before);
        expect(text()).toContain('7 field changes on 6 devices');
        expect(button('Cancel import')).toBeDefined();
      });
    }
  }

  it('restores the retained report when its Activity row opens it again (R3)', async () => {
    const routes: Routes = {
      detail: reportDetail(),
      reports: () => report({ plan: openPlan(), counts }),
    };
    const { render, store, button } = setup(routes);
    store.openImport();
    store.activeImport.set('IMP-001');
    store.openImport();
    await render();
    expect(store.step()).toBe('report');
    // The same skip condition serves reentry through another job's row.
    store.close();
    routes.detail = finishedExport('edit', 'monitor');
    store.openJob('EXP-001');
    await render();
    routes.detail = reportDetail();
    store.openJob('IMP-001');
    await render();
    expect(store.step()).toBe('report');
    expect(store.reportCounts()).toEqual(counts);
    expect(store.plan()?.state).toBe('open');
    expect(button('Cancel import')).toBeDefined();
  });

  for (const view of ['rejected', 'warnings'] as const) {
    it(`recovers the facts and error state of a cached ${view} view (R4)`, async () => {
      let proposedFailed = false;
      const line =
        view === 'rejected'
          ? {
              ...proposedLine,
              change: null,
              column: 'Status',
              submittedValue: 'Gone',
              reason: 'The status "Gone" is not a Google status.',
            }
          : {
              ...proposedLine,
              row: null,
              deviceId: null,
              change: null,
              reason:
                'The column "Grade" is unknown. It stays out of every write.',
            };
      const { render, store, text, button } = setup({
        detail: reportDetail(),
        reports: (reportView, page) =>
          report({
            view: reportView,
            page,
            plan: openPlan(),
            counts,
            total: reportView === view ? 1 : 0,
            lines: reportView === view ? [line] : [],
            pageCount: 1,
          }),
        answer: (path) => {
          if (!path.includes('/report?')) return undefined;
          const url = new URL(path, 'http://x');
          if (!proposedFailed && url.searchParams.get('view') === 'proposed') {
            proposedFailed = true;
            return Promise.resolve(response({}, 503));
          }
          return undefined;
        },
      });
      store.openImport();
      store.activeImport.set('IMP-001');
      store.openImport();
      await render();
      await render();
      // The initial Proposed page failed, and the tab totals kept their own answers.
      expect(store.reportCounts()).toBeNull();
      expect(store.reportError()).toBe('The report is unavailable. Try again.');
      await store.setReportView(view);
      await render();
      // A cached view restores the counts, the plan, and the actions of its own answer.
      expect(store.reportView()).toBe(view);
      expect(store.reportCounts()).toEqual(counts);
      expect(store.plan()?.state).toBe('open');
      expect(store.reportError()).toBe('');
      expect(store.reportLines()).toEqual([line]);
      expect(text()).toContain(
        view === 'rejected' ? 'Download rejected rows' : 'Header row',
      );
      expect(button('Cancel import')).toBeDefined();
      expect(button(/^Execute/)?.hasAttribute('disabled')).toBe(false);
    });
  }

  for (const status of ['running', 'failed', 'cancelled'] as const) {
    it(`clears the report of a finished job when a ${status} successor opens (R4)`, async () => {
      const routes: Routes = {
        detail: reportDetail(),
        reports: () => report({ plan: openPlan(), counts }),
      };
      const { render, store } = setup(routes);
      store.openImport();
      store.activeImport.set('IMP-001');
      store.openImport();
      await render();
      expect(store.step()).toBe('report');
      expect(store.reportCounts()).not.toBeNull();
      expect(store.plan()?.state).toBe('open');
      routes.detail = importDetail({
        jobId: '1f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a12',
        displayId: 'IMP-002',
        status,
      });
      store.openJob('IMP-002');
      await render();
      // The successor is not the report of the completed job before it (R4).
      expect(store.step()).toBe('validation');
      expect(store.reportCounts()).toBeNull();
      expect(store.plan()).toBeNull();
      expect(store.reportLines()).toEqual([]);
    });
  }

  it('keeps a cancelled plan when a page that left before it arrives (R4)', async () => {
    const held = deferred<Response>();
    let heldPage = false;
    const accepted = openPlan({
      revision: 3,
      state: 'cancelled',
      changedBy: person,
      changedAt: past(),
    });
    const { render, store } = setup({
      detail: reportDetail(),
      reports: (view, page) => report({ view, page, plan: openPlan() }),
      answer: (path) => {
        if (path.endsWith('/cancel'))
          return Promise.resolve(response({ plan: accepted }));
        if (!path.includes('/report?')) return undefined;
        const url = new URL(path, 'http://x');
        if (
          !heldPage &&
          url.searchParams.get('view') === 'proposed' &&
          url.searchParams.get('page') === '1'
        ) {
          heldPage = true;
          return held.promise;
        }
        return undefined;
      },
    });
    store.openImport();
    store.activeImport.set('IMP-001');
    store.openImport();
    await render();
    const paging = store.nextReportPage();
    const cancel = store.cancelImport();
    await cancel;
    await render();
    expect(store.plan()?.state).toBe('cancelled');
    expect(store.plan()?.revision).toBe(3);
    held.resolve(
      response(report({ view: 'proposed', page: 1, plan: openPlan() })),
    );
    await paging;
    await render();
    // The older page never restores the open plan that it left with.
    expect(store.plan()?.state).toBe('cancelled');
    expect(store.plan()?.revision).toBe(3);
    expect(store.reportPage()).toBe(0);
  });

  it('never puts an abandoned view error on the shown view (R4)', async () => {
    const held = deferred<Response>();
    let heldPage = false;
    const { render, store } = setup({
      detail: reportDetail(),
      reports: (view, page) => report({ view, page, plan: openPlan() }),
      answer: (path) => {
        if (!path.includes('/report?')) return undefined;
        const url = new URL(path, 'http://x');
        if (
          !heldPage &&
          url.searchParams.get('view') === 'proposed' &&
          url.searchParams.get('page') === '0'
        ) {
          heldPage = true;
          return held.promise;
        }
        return undefined;
      },
    });
    store.openImport();
    store.activeImport.set('IMP-001');
    store.openImport();
    await render();
    // The tab totals fill the rejected view, so selecting it needs no held page.
    await store.setReportView('rejected');
    await render();
    expect(store.reportView()).toBe('rejected');
    held.resolve(response({}, 503));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await render();
    expect(store.reportError()).toBe('');
    expect(store.reportView()).toBe('rejected');
  });

  it('retries a failed shown page when the import reopens (R4)', async () => {
    let failed = false;
    const { render, store } = setup({
      detail: reportDetail(),
      reports: (view, page) => report({ view, page, plan: openPlan(), counts }),
      answer: (path) => {
        if (!path.includes('/report?')) return undefined;
        const url = new URL(path, 'http://x');
        if (
          !failed &&
          url.searchParams.get('view') === 'proposed' &&
          url.searchParams.get('page') === '0'
        ) {
          failed = true;
          return Promise.resolve(response({}, 503));
        }
        return undefined;
      },
    });
    store.openImport();
    store.activeImport.set('IMP-001');
    store.openImport();
    await render();
    await render();
    expect(store.reportCounts()).toBeNull();
    expect(store.reportError()).toBe('The report is unavailable. Try again.');
    store.close();
    store.openImport();
    await render();
    await render();
    // The failed page left no trusted revision, so the same job reads it again.
    expect(store.reportCounts()).not.toBeNull();
    expect(store.reportError()).toBe('');
  });

  it('retries a failed shown page when the shared feed opens again (R4)', async () => {
    let failed = false;
    const { render, store, feedHandlers } = setup({
      detail: reportDetail(),
      reports: (view, page) => report({ view, page, plan: openPlan(), counts }),
      answer: (path) => {
        if (!path.includes('/report?')) return undefined;
        const url = new URL(path, 'http://x');
        if (
          !failed &&
          url.searchParams.get('view') === 'proposed' &&
          url.searchParams.get('page') === '0'
        ) {
          failed = true;
          return Promise.resolve(response({}, 503));
        }
        return undefined;
      },
    });
    store.openImport();
    store.activeImport.set('IMP-001');
    store.openImport();
    await render();
    await render();
    expect(store.reportCounts()).toBeNull();
    store.openImport();
    await render();
    // A same-revision reconnect reads the shown page again.
    feedHandlers.at(-1)?.opened(true);
    await new Promise((resolve) => setTimeout(resolve, 350));
    await render();
    expect(store.reportCounts()).not.toBeNull();
  });

  it('does not present a failed report as a no-change result (R4)', async () => {
    const { render, store, text } = setup({
      detail: reportDetail(),
      answer: (path) =>
        path.includes('/report?')
          ? Promise.resolve(response({}, 503))
          : undefined,
    });
    store.openImport();
    store.activeImport.set('IMP-001');
    store.openImport();
    await render();
    await render();
    expect(store.reportCounts()).toBeNull();
    expect(text()).toContain('The report is unavailable. Try again.');
    expect(text()).not.toContain('No changes');
    expect(text()).not.toContain('Every row matches its export checksum.');
    // A missing total is not a total of zero (R4).
    expect(text()).not.toContain('Proposed changes 0');
  });
});

describe('the approved Import composition', () => {
  it('renders one bounded report panel with the pager inside it (R6)', async () => {
    const { render, store, element } = setup({
      detail: reportDetail(),
      reports: (view, page) =>
        report({
          view,
          page,
          plan: openPlan(),
          lines: Array.from({ length: 10 }, (_, index) => ({
            ...proposedLine,
            row: index + 1,
          })),
          total: 12,
          pageCount: 2,
        }),
    });
    store.openImport();
    store.activeImport.set('IMP-001');
    store.openImport();
    await render();
    const panel = element.querySelector('.report-panel');
    expect(panel).not.toBeNull();
    expect(panel?.querySelector('.report-pager')).not.toBeNull();
    expect(panel?.querySelectorAll('table.report-table col')).toHaveLength(5);
    expect(panel?.querySelector('table.report-table')?.classList).toContain(
      'rv',
    );
    expect(element.querySelector('.report-body')).toBeNull();
    expect(element.querySelectorAll('table.report-table tbody tr').length).toBe(
      10,
    );
  });

  it('offers the compact drop zone of state 09 (R7)', async () => {
    const { render, store, element } = setup({ detail: importDetail() });
    store.openImport();
    await render();
    const zone = element.querySelector('.file-block .drop-zone');
    expect(zone).not.toBeNull();
    expect(zone?.textContent).toContain('upload_file');
    expect(element.querySelector('.drop-label')).toBeNull();
  });

  it('offers Done on a cancelled plan and releases the entry (R8)', async () => {
    const { render, store, text, button } = setup({
      detail: reportDetail({
        plan: openPlan({ state: 'cancelled' }) as JobDetail['plan'],
      }),
      reports: () => report({ plan: openPlan({ state: 'cancelled' }) }),
    });
    store.openImport();
    store.activeImport.set('IMP-001');
    store.openImport();
    await render();
    expect(text()).toContain('Import again');
    const done = button('Done');
    expect(done).toBeDefined();
    done?.click();
    await render();
    expect(store.open()).toBe(false);
    expect(store.activeImport()).toBeNull();
  });

  it('explains a late failure with its own reason and rows read (R10)', async () => {
    const { render, store, text } = setup({
      detail: importDetail({
        status: 'failed',
        failure: 'storage-unavailable',
        phase: { name: 'compare', done: 1000, total: 2000 },
        importSource: {
          name: 'devices.csv',
          sourceType: 'csv',
          sizeBytes: 7_936,
          rowsRead: 3000,
          candidateRows: 3000,
          tabTitle: null,
          refusalText: null,
        },
      }),
    });
    store.openJob('IMP-001');
    await render();
    expect(text()).toContain(
      'Campus Commander could not store the validation report.',
    );
    expect(text()).toContain('Import the file again.');
    expect(text()).toContain('Validation stopped after it read 3,000 rows.');
    expect(text()).not.toContain('before any row check');
  });

  it('states the Sync all rows no-change line (R10)', async () => {
    const { render, store, text } = setup({
      detail: reportDetail({
        importSummary: {
          mode: 'sync-all-rows',
          planState: null,
          proposed: 0,
          rejected: 0,
          refusal: null,
        },
        plan: null,
      }),
      reports: () =>
        report({
          counts: {
            rows: 48,
            unchanged: 0,
            noChangeNeeded: 48,
            proposed: 0,
            rejected: 0,
          },
          lines: [],
          total: 0,
        }),
    });
    store.openImport();
    store.activeImport.set('IMP-001');
    store.openImport();
    await render();
    expect(text()).toContain('Every row already matches the file.');
  });

  it('states the checksum line only when every row is unchanged (R10)', async () => {
    const { render, store, text } = setup({
      detail: reportDetail({ plan: null }),
      reports: () =>
        report({
          counts: {
            rows: 48,
            unchanged: 48,
            noChangeNeeded: 0,
            proposed: 0,
            rejected: 0,
          },
          lines: [],
          total: 0,
        }),
    });
    store.openImport();
    store.activeImport.set('IMP-001');
    store.openImport();
    await render();
    expect(text()).toContain(
      'Every row matches its export checksum. No update is needed.',
    );
  });

  it('states the generic no-update line for edited rows that already match (R10)', async () => {
    const { render, store, text } = setup({
      detail: reportDetail({ plan: null }),
      reports: () =>
        report({
          counts: {
            rows: 48,
            unchanged: 0,
            noChangeNeeded: 48,
            proposed: 0,
            rejected: 0,
          },
          lines: [],
          total: 0,
        }),
    });
    store.openImport();
    store.activeImport.set('IMP-001');
    store.openImport();
    await render();
    expect(text()).toContain('No row needs an update.');
    expect(text()).not.toContain('Every row matches its export checksum.');
  });

  it('reads the stored reads of a stopped validation from its refresh phase (R11)', async () => {
    const { render, store, text } = setup({
      detail: reportDetail({
        status: 'cancelled',
        phase: { name: 'refresh', done: 4, total: 12 },
        importSource: {
          name: 'devices.csv',
          sourceType: 'csv',
          sizeBytes: 7_936,
          rowsRead: 30,
          candidateRows: 30,
          tabTitle: null,
          refusalText: null,
        },
        plan: null,
      }),
      reports: () =>
        report({ refresh: { staleDevicesRead: 9, oldestObservedAt: past() } }),
    });
    store.openImport();
    store.activeImport.set('IMP-001');
    store.openImport();
    await render();
    expect(text()).toContain(
      'The 4 device reads that finished before the stop stay stored.',
    );
    expect(text()).not.toContain('The 9 device reads');
  });

  it('names a failed validation from its stored facts', () => {
    // A header refusal without a stored sentence still reads as a header refusal, not a crash.
    expect(
      importFailureText(
        importDetail({
          status: 'failed',
          importSummary: {
            mode: 'sync-changes',
            planState: null,
            proposed: 0,
            rejected: 0,
            refusal: 'header-refused',
          },
          importSource: {
            name: 'devices.csv',
            sourceType: 'csv',
            sizeBytes: 7_936,
            rowsRead: 0,
            candidateRows: 0,
            tabTitle: null,
            refusalText: null,
          },
        }),
      ),
    ).toBe('The header check failed. Correct the file and import it again.');
    expect(
      importFailureText(
        importDetail({
          status: 'failed',
          importSummary: {
            mode: 'sync-changes',
            planState: null,
            proposed: 0,
            rejected: 0,
            refusal: 'header-refused',
          },
          importSource: {
            name: 'devices.csv',
            sourceType: 'csv',
            sizeBytes: 7_936,
            rowsRead: 0,
            candidateRows: 0,
            tabTitle: null,
            refusalText: 'The Checksum column is missing.',
          },
        }),
      ),
    ).toBe('The Checksum column is missing.');
    // A Drive source refusal names the file, and a missing name keeps the built sentence.
    expect(
      importFailureText(
        importDetail({
          status: 'failed',
          importSummary: {
            mode: 'sync-changes',
            planState: null,
            proposed: 0,
            rejected: 0,
            refusal: 'drive-source-unavailable',
          },
          importSource: {
            name: 'devices-for-editing-EXP-001.csv',
            sourceType: 'drive-csv',
            sizeBytes: 7_936,
            rowsRead: 0,
            candidateRows: 0,
            tabTitle: null,
            refusalText: null,
          },
        }),
      ),
    ).toBe(
      'Campus Commander cannot read devices-for-editing-EXP-001.csv from Google Drive. Choose the file again in Google Drive, then import again.',
    );
    expect(
      importFailureText(
        importDetail({
          status: 'failed',
          importSummary: {
            mode: 'sync-changes',
            planState: null,
            proposed: 0,
            rejected: 0,
            refusal: 'drive-source-unavailable',
          },
          importSource: null,
        }),
      ),
    ).toBe('The validation stopped before it finished. Import the file again.');
  });

  it('lists the field limits of the import template in the help (R12)', async () => {
    const { render, store, text } = setup({ detail: importDetail() });
    store.openImport();
    store.toggleHelp();
    await render();
    expect(text()).toContain('Field limits');
    expect(text()).toContain('Annotated location');
    expect(text()).toContain('200 characters');
    expect(text()).toContain('Organization unit');
    expect(text()).toContain('4,096 characters');
    expect(text()).toContain('Asset tag');
    expect(text()).toContain('256 characters');
  });
});

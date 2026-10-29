import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import {
  DEVICE_EDIT_TEMPLATE_HEADERS,
  devicePageSchema,
} from '@campus/application-contracts';

/**
 * States 09 to 15 and 18 to 24 of the Import steps
 * (`docs/ui/designs/2026-10-28-device-export-import-*.png`) against a mocked API.
 */
const customerId = 'C0123456';
const observedAt = '2026-10-19T12:00:00.000Z';
const impJobId = '0f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10';
const planId = '9a1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10';
const person = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  displayName: 'District operator',
};
const grants = [
  { action: 'devices:read', scope: { kind: 'district', customerId } },
  { action: 'devices:write', scope: { kind: 'district', customerId } },
  { action: 'devices:bulk-actions', scope: { kind: 'district', customerId } },
  { action: 'devices:export', scope: { kind: 'district', customerId } },
  { action: 'connection:diagnose', scope: { kind: 'district', customerId } },
];
const rows = Array.from({ length: 6 }, (_, index) => ({
  deviceId: `synthetic-device-${index + 1}`,
  serialNumber: `C0A1-000${index + 1}`,
  model: 'Lenovo 100e Gen 4',
  assetTag: `HS-040${index + 1}`,
  orgUnitPath: '/School A',
  lastContact: '2026-10-19T11:58:00Z',
  annotatedLocation: null,
  annotatedUser: null,
  notes: null,
  status: 'ACTIVE',
  battery: {
    status: 'reported',
    health: 'normal',
    capacityPercent: 91,
    reportedAt: '2026-10-19T11:00:00Z',
  },
  lastEntitySync: observedAt,
  stale: false,
}));

/** The header of the edit template, so the header check passes (state 09). */
const templateHeader = `${DEVICE_EDIT_TEMPLATE_HEADERS.join(',')}\r\n`;
const templateRow = `${DEVICE_EDIT_TEMPLATE_HEADERS.map((_, index) =>
  index === 0 ? 'C0A1-0001' : index === 1 ? 'C0A1-0001' : '',
).join(',')}\r\n`;
const goodCsv = `${templateHeader}${templateRow}`;
/** A file whose header lacks a column, so the check refuses it (state 10). */
const shortCsv = 'Device ID,Serial number\r\n';

const future = (days = 7) =>
  new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
const past = () => new Date(Date.now() - 5 * 60 * 1000).toISOString();

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
const openPlan = {
  planId,
  revision: 1,
  state: 'open' as const,
  expiresAt: future(),
  changedBy: null,
  changedAt: null,
};

const proposedLines = [
  {
    row: 2,
    deviceId: 'C0A1-0001',
    serialNumber: 'C0A1-0001',
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
  },
  {
    row: 3,
    deviceId: 'C0A1-0002',
    serialNumber: 'C0A1-0002',
    change: {
      type: 'field' as const,
      field: 'annotatedAssetId' as const,
      operation: 'replace' as const,
      currentValue: 'HS-0402',
      newValue: 'HS-0512',
    },
    column: null,
    submittedValue: null,
    reason: null,
    notRun: null,
    jobDisplayId: null,
    operationNumber: null,
    outcome: null,
  },
  {
    row: 4,
    deviceId: 'C0A1-0003',
    serialNumber: 'C0A1-0003',
    change: {
      type: 'status' as const,
      action: 'disable' as const,
      reason: null,
      currentValue: 'ACTIVE',
      newValue: 'DISABLED',
    },
    column: null,
    submittedValue: null,
    reason: null,
    notRun: null,
    jobDisplayId: null,
    operationNumber: null,
    outcome: null,
  },
];

const rejectedLines = [
  {
    row: 5,
    deviceId: 'C0A1-0004',
    serialNumber: 'C0A1-0004',
    change: null,
    column: 'Status',
    submittedValue: 'Gone',
    reason: 'The status "Gone" is not a Google status.',
    notRun: null,
    jobDisplayId: null,
    operationNumber: null,
    outcome: null,
  },
  {
    row: 6,
    deviceId: null,
    serialNumber: null,
    change: null,
    column: 'Device ID',
    submittedValue: 'C0A9-9999',
    reason: 'The device is not in the inventory of this customer.',
    notRun: null,
    jobDisplayId: null,
    operationNumber: null,
    outcome: null,
  },
];

const warningLines = [
  {
    row: null,
    deviceId: null,
    serialNumber: null,
    change: null,
    column: null,
    submittedValue: null,
    reason: 'The column "Grade" is unknown. It stays out of every write.',
    notRun: null,
    jobDisplayId: null,
    operationNumber: null,
    outcome: null,
  },
];

type ImportCase =
  | 'running'
  | 'completed'
  | 'sync-all-rows'
  | 'expired'
  | 'cancelled-plan'
  | 'no-update'
  | 'rejected-only'
  | 'failed'
  | 'cancelled';

const importJob = (name: ImportCase) => ({
  jobId: impJobId,
  displayId: 'IMP-001',
  revision: 4,
  action: 'validate-device-import',
  status:
    name === 'running'
      ? 'running'
      : name === 'failed'
        ? 'failed'
        : name === 'cancelled'
          ? 'cancelled'
          : 'completed',
  scope: { kind: 'devices', deviceCount: 48 },
  requestedBy: person,
  createdAt: new Date(Date.now() - 120_000).toISOString(),
  startedAt: new Date(Date.now() - 110_000).toISOString(),
  finishedAt:
    name === 'running' ? null : new Date(Date.now() - 60_000).toISOString(),
  progress: {
    total: 48,
    succeeded: name === 'running' ? 0 : 48,
    failed: 0,
    unknown: 0,
    skipped: 0,
    expired: 0,
    cancelled: name === 'cancelled' ? 48 : 0,
    pending: name === 'running' ? 48 : 0,
  },
  phase:
    name === 'running'
      ? { name: 'refresh', done: 5, total: 48 }
      : name === 'failed'
        ? { name: 'header-check', done: 0, total: null }
        : name === 'cancelled'
          ? { name: 'refresh', done: 4, total: 12 }
          : { name: 'report', done: 48, total: 48 },
  exportSummary: null,
  exportFile: null,
  importSummary: {
    mode: name === 'sync-all-rows' ? 'sync-all-rows' : 'sync-changes',
    planState:
      name === 'completed' || name === 'sync-all-rows'
        ? 'open'
        : name === 'expired'
          ? 'expired'
          : name === 'cancelled-plan'
            ? 'cancelled'
            : null,
    proposed: name === 'rejected-only' || name === 'no-update' ? 0 : 12,
    rejected: name === 'rejected-only' ? 48 : name === 'no-update' ? 0 : 2,
    refusal: null,
  },
  cancelRequest: name === 'cancelled' ? { by: person, at: past() } : null,
  failure: name === 'failed' ? 'storage-unavailable' : null,
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
    rowsRead: name === 'running' ? 5 : name === 'failed' ? 0 : 30,
    candidateRows: name === 'failed' ? 0 : 30,
    refusalText:
      name === 'failed'
        ? 'The file is not UTF-8 text. Save it as UTF-8 CSV and import it again.'
        : null,
  },
  plan:
    name === 'expired'
      ? { ...openPlan, state: 'open', expiresAt: past() }
      : name === 'cancelled-plan'
        ? {
            ...openPlan,
            state: 'cancelled',
            changedBy: person,
            changedAt: past(),
          }
        : name === 'completed' || name === 'sync-all-rows'
          ? openPlan
          : null,
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

const reportAnswer = (name: ImportCase, view: string, page: number) => {
  const noUpdate = name === 'no-update';
  const rejectedOnly = name === 'rejected-only';
  const viewCounts = noUpdate
    ? { rows: 48, unchanged: 48, noChangeNeeded: 0, proposed: 0, rejected: 0 }
    : rejectedOnly
      ? { rows: 48, unchanged: 0, noChangeNeeded: 0, proposed: 0, rejected: 48 }
      : counts;
  const lines =
    view === 'proposed'
      ? noUpdate || rejectedOnly
        ? []
        : proposedLines
      : view === 'rejected'
        ? rejectedOnly
          ? rejectedLines
          : rejectedLines
        : view === 'warnings'
          ? warningLines
          : [];
  const total =
    view === 'proposed'
      ? viewCounts.proposed
      : view === 'rejected'
        ? viewCounts.rejected
        : view === 'warnings'
          ? 1
          : 0;
  return {
    jobId: impJobId,
    displayId: 'IMP-001',
    view,
    page,
    pageCount: Math.max(1, Math.ceil(total / 10)),
    counts: viewCounts,
    refresh,
    changes:
      noUpdate || rejectedOnly
        ? { ...changes, fieldChanges: 0, fieldChangeDevices: 0, disable: 0 }
        : changes,
    lines: lines.filter(() => total > 0),
    total,
    plan:
      name === 'expired'
        ? { ...openPlan, state: 'open', expiresAt: past() }
        : name === 'cancelled-plan'
          ? {
              ...openPlan,
              state: 'cancelled',
              changedBy: person,
              changedAt: past(),
            }
          : name === 'completed' || name === 'sync-all-rows'
            ? openPlan
            : null,
  };
};

/** A theme and one import answer set on every route that the dialog reads. */
async function signIn(
  page: Page,
  name: ImportCase = 'completed',
  theme: 'light' | 'dark' = 'light',
) {
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const view = new URL(request.url()).searchParams.get('view') ?? 'proposed';
    const pageIndex = Number(
      new URL(request.url()).searchParams.get('page') ?? '0',
    );
    if (path === '/api/application')
      return route.fulfill({
        json: {
          phase: 3,
          authenticationConfigured: true,
          version: 'development',
          build: 'client-review',
        },
      });
    if (path === '/api/auth/session')
      return route.fulfill({
        json: {
          identity: {
            ...person,
            permissionVersion: 1,
            permissions: [],
            grants,
            preferences: { theme, navigationCollapsed: false },
          },
          csrfToken: 'a'.repeat(64),
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        },
      });
    if (path === '/api/devices/selection')
      return route.fulfill({
        json: {
          selection: {
            terms: [],
            groups: [],
            added: rows.length,
            excluded: 0,
            selectedCount: rows.length,
            expiredAt: null,
          },
        },
      });
    if (path === '/api/devices/selection/resolve')
      return route.fulfill({ json: { selected: {} } });
    if (path === '/api/devices/sync')
      return route.fulfill({
        json: {
          sync: {
            customerId,
            generation: 1,
            status: 'ready',
            observedAt,
            deviceCount: rows.length,
            failure: null,
            telemetryFailure: null,
            startedAt: null,
            checkedAt: null,
            stale: false,
          },
        },
      });
    if (path === '/api/devices/query')
      return route.fulfill({
        json: {
          page: devicePageSchema.parse({
            rows,
            matching: rows.length,
            total: rows.length,
            observedAt,
            refreshJobId: null,
          }),
        },
      });
    if (path === '/api/devices/freshness')
      return route.fulfill({
        json: { freshness: { stale: 0, refreshing: false } },
      });
    if (path === '/api/devices/org-units')
      return route.fulfill({ json: { orgUnits: [] } });
    if (path === '/api/devices/events' || path === '/api/jobs/events')
      return route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: '',
      });
    if (path === '/api/devices/updates/access')
      return route.fulfill({
        json: {
          state: 'granted',
          scope:
            'https://www.googleapis.com/auth/admin.directory.device.chromeos',
          failure: null,
          checkedAt: observedAt,
        },
      });
    if (path === '/api/devices/imports' && request.method() === 'POST')
      return route.fulfill({
        status: 202,
        json: {
          jobId: impJobId,
          displayId: 'IMP-001',
          status: 'accepted',
          mode: 'sync-changes',
          name: 'devices.csv',
          sizeBytes: 7_936,
        },
      });
    if (path === '/api/jobs/IMP-001')
      return route.fulfill({ json: importJob(name) });
    if (path === '/api/jobs/IMP-001/cancel')
      return route.fulfill({
        json: { cancelRequest: { by: person, at: past() } },
      });
    if (path === '/api/devices/imports/IMP-001/report')
      return route.fulfill({ json: reportAnswer(name, view, pageIndex) });
    if (path === '/api/devices/imports/IMP-001/rejected')
      return route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/csv' },
        body: 'Row,Device ID,Reason\r\n5,C0A1-0004,The status "Gone" is not a Google status.\r\n',
      });
    if (
      path === '/api/devices/imports/IMP-001/cancel' ||
      path === '/api/devices/imports/IMP-001/revalidate'
    )
      return route.fulfill({ json: {} });
    return route.fulfill({ status: 404, json: {} });
  });
}

async function openDevices(
  page: Page,
  name: ImportCase = 'completed',
  theme: 'light' | 'dark' = 'light',
) {
  await signIn(page, name, theme);
  await page.goto('/devices');
  await expect(
    page.getByRole('heading', { name: 'Devices', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('gridcell', { name: 'C0A1-0001', exact: true }),
  ).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

const dialog = (page: Page) =>
  page.locator('section[role="dialog"][aria-labelledby="export-dialog-title"]');
const bulk = (page: Page) =>
  page.getByRole('button', { name: 'Bulk Actions', exact: true });

async function openImport(page: Page) {
  await bulk(page).click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Import', exact: true }).click();
  await expect(dialog(page)).toBeVisible();
}

async function chooseFile(page: Page, content: string, name = 'devices.csv') {
  await dialog(page)
    .locator('input[type="file"]')
    .setInputFiles({
      name,
      mimeType: 'text/csv',
      buffer: Buffer.from(content, 'utf8'),
    });
}

async function shot(page: Page, name: string) {
  // The pointer leaves the control that opened the step, so no hover state shows.
  await page.mouse.move(4, 4);
  await page.evaluate(() => document.fonts.ready);
  const dir = 'dist/e2e-evidence/export-import';
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: `${dir}/${name}.png` });
}

test.use({
  viewport: { width: 1440, height: 900 },
  timezoneId: 'America/New_York',
});

test.describe('Import', () => {
  test('state 09: the import setup at 480 px', async ({ page }) => {
    await openDevices(page);
    await openImport(page);
    await expect(dialog(page)).toHaveCSS('width', '480px');
    for (const text of [
      'Import mode',
      'Sync changes',
      'Sync all rows',
      'Upload a CSV file',
      'Google Drive is not available for your account.',
      'Drop a CSV file here',
      'Choose CSV file',
    ])
      await expect(dialog(page)).toContainText(text);
    await expect(
      dialog(page).getByRole('button', { name: 'Start validation' }),
    ).toBeDisabled();
    await chooseFile(page, goodCsv);
    await expect(dialog(page)).toContainText('devices.csv');
    await expect(dialog(page)).toContainText('Header check passed.');
    await expect(
      dialog(page).getByRole('button', { name: 'Start validation' }),
    ).toBeEnabled();
    await shot(page, '09-import-dialog');
  });

  test('state 10: a refused header keeps the primary action disabled', async ({
    page,
  }) => {
    await openDevices(page);
    await openImport(page);
    await chooseFile(page, shortCsv, 'short.csv');
    await expect(dialog(page)).toContainText('The file is missing the');
    await expect(dialog(page)).toContainText(
      'Sync changes needs the Checksum column.',
    );
    await expect(
      dialog(page).getByRole('button', { name: 'Start validation' }),
    ).toBeDisabled();
    await shot(page, '10-import-header-check');
  });

  test('state 12: the validation runs with its phases and counters', async ({
    page,
  }) => {
    await openDevices(page, 'running');
    await openImport(page);
    await chooseFile(page, goodCsv);
    await dialog(page)
      .getByRole('button', { name: 'Start validation' })
      .click();
    await expect(dialog(page)).toContainText('Job IMP-001 · Running');
    await expect(dialog(page)).toContainText('Refresh stale devices');
    await expect(dialog(page)).toContainText('5 of 48');
    await expect(dialog(page)).toContainText('Rows read');
    await expect(dialog(page)).toContainText('Edited rows');
    await expect(dialog(page)).toContainText(
      'Closing this dialog keeps the validation running.',
    );
    await expect(
      dialog(page).getByRole('button', { name: 'Stop validation' }),
    ).toBeVisible();
    await shot(page, '12-validation-running');
  });

  test('states 13, 14, and 15: the report tabs at 1120 px', async ({
    page,
  }) => {
    await openDevices(page, 'completed');
    await page.goto('/devices?job=IMP-001');
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page)).toHaveCSS('width', '1120px');
    await expect(dialog(page)).toContainText('Proposed changes:');
    await expect(dialog(page)).toContainText('7 field changes on 6 devices');
    await expect(dialog(page)).toContainText('Open');
    await expect(dialog(page)).toContainText('Cancel import');
    await expect(dialog(page)).toContainText('Execute 8 changes');
    await shot(page, '13-review-proposed');

    await dialog(page)
      .getByRole('tab', { name: /Rejected/ })
      .click();
    await expect(dialog(page)).toContainText(
      'The status "Gone" is not a Google status.',
    );
    await expect(dialog(page)).toContainText('Download rejected rows');
    await shot(page, '14-review-rejected');

    await dialog(page)
      .getByRole('tab', { name: /Warnings/ })
      .click();
    await expect(dialog(page)).toContainText(
      'The column "Grade" is unknown. It stays out of every write.',
    );
    await shot(page, '15-review-warnings');
  });

  test('state 18: sync all rows names its own rule', async ({ page }) => {
    await openDevices(page, 'sync-all-rows');
    await page.goto('/devices?job=IMP-001');
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page)).toContainText(
      'Sync all rows checks every row, so no row counts as unchanged.',
    );
    await shot(page, '18-sync-all-rows-review');
  });

  test('state 19: the plan expires at its deadline', async ({ page }) => {
    await openDevices(page, 'expired');
    await page.goto('/devices?job=IMP-001');
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page)).toContainText('Expired');
    await expect(
      dialog(page).getByRole('button', { name: 'Validate again' }),
    ).toBeEnabled();
    await expect(
      dialog(page).getByRole('button', { name: /^Execute/ }),
    ).toBeDisabled();
    await shot(page, '19-plan-expired');
  });

  test('state 20: a cancelled plan offers Import again', async ({ page }) => {
    await openDevices(page, 'cancelled-plan');
    await page.goto('/devices?job=IMP-001');
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page)).toContainText('Cancelled');
    await expect(dialog(page)).toContainText('District operator');
    await expect(
      dialog(page).getByRole('button', { name: 'Import again' }),
    ).toBeVisible();
    await shot(page, '20-plan-cancelled');
  });

  test('state 21: no row needs an update', async ({ page }) => {
    await openDevices(page, 'no-update');
    await page.goto('/devices?job=IMP-001');
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page)).toContainText('No changes');
    await expect(dialog(page)).toContainText(
      'Every row matches its export checksum. No update is needed.',
    );
    await expect(
      dialog(page).getByRole('button', { name: 'Done' }),
    ).toBeVisible();
    await expect(
      dialog(page).getByRole('button', { name: /^Execute/ }),
    ).toBeDisabled();
    await shot(page, '21-no-update-needed');
  });

  test('state 22: every row is rejected, so nothing can run', async ({
    page,
  }) => {
    await openDevices(page, 'rejected-only');
    await page.goto('/devices?job=IMP-001');
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page)).toContainText('No changes');
    await expect(dialog(page)).toContainText('48 rows are rejected.');
    await expect(
      dialog(page).getByRole('button', { name: 'Import again' }),
    ).toBeVisible();
    await shot(page, '22-rejected-only');
  });

  test('state 23: a refused file shows the reasons and no report', async ({
    page,
  }) => {
    await openDevices(page, 'failed');
    await page.goto('/devices?job=IMP-001');
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page)).toContainText('No report');
    await expect(dialog(page)).toContainText('The file is not UTF-8 text.');
    await expect(
      dialog(page).getByRole('button', { name: 'Import again' }),
    ).toBeVisible();
    await shot(page, '23-validation-failed');
  });

  test('state 24: a stopped validation keeps its reads', async ({ page }) => {
    await openDevices(page, 'cancelled');
    await page.goto('/devices?job=IMP-001');
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page)).toContainText('No report');
    await expect(dialog(page)).toContainText('Cancelled');
    await expect(dialog(page)).toContainText('District operator');
    await shot(page, '24-validation-cancelled');
  });

  test('state 13 in the dark theme', async ({ page }) => {
    await openDevices(page, 'completed', 'dark');
    await page.goto('/devices?job=IMP-001');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page)).toContainText('Proposed changes:');
    await shot(page, '13-review-proposed-dark');
  });

  test('the dialog opens one shared jobs feed and no second connection', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const Original = window.EventSource;
      const opened: string[] = [];
      (window as unknown as { __feeds: string[] }).__feeds = opened;
      window.EventSource = class extends Original {
        constructor(url: string | URL) {
          super(url);
          opened.push(String(url));
        }
      } as typeof EventSource;
    });
    await openDevices(page, 'completed');
    await page.goto('/devices?job=IMP-001');
    await expect(dialog(page)).toBeVisible();
    await page.waitForTimeout(500);
    const feeds = await page.evaluate(
      () => (window as unknown as { __feeds: string[] }).__feeds,
    );
    expect(
      feeds.filter((url) => url.includes('/api/jobs/events')),
    ).toHaveLength(1);
  });
});

import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import {
  devicePageSchema,
  type JobSummary,
} from '@campus/application-contracts';

/**
 * States 01 to 08 of the Export, Reports, and Import dialog
 * (`docs/ui/designs/2026-10-28-device-export-import-0*.png`) against a mocked API.
 */
const customerId = 'C0123456';
const observedAt = '2026-10-19T12:00:00.000Z';
const expJobId = '0f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10';
const reportJobId = '1f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a11';
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

const expiry = () =>
  new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

/** The own running export row of the Activity panel (behavior 5). */
const activityJob: JobSummary = {
  jobId: expJobId,
  displayId: 'EXP-001',
  revision: 2,
  action: 'export-devices',
  status: 'running',
  scope: { kind: 'devices', deviceCount: rows.length },
  requestedBy: person,
  createdAt: new Date(Date.now() - 60_000).toISOString(),
  startedAt: new Date(Date.now() - 50_000).toISOString(),
  finishedAt: null,
  progress: {
    total: rows.length,
    succeeded: 0,
    failed: 0,
    unknown: 0,
    skipped: 0,
    expired: 0,
    cancelled: 0,
    pending: rows.length,
  },
  phase: { name: 'write-rows', done: 3, total: rows.length },
  exportSummary: { purpose: 'edit' },
  importSummary: null,
  failure: null,
  cancelRequest: null,
};

const exportJob = (
  displayId: string,
  purpose: 'edit' | 'report',
  state: 'running' | 'completed',
) => ({
  jobId: displayId === 'EXP-001' ? expJobId : reportJobId,
  displayId,
  revision: state === 'running' ? 2 : 4,
  action: 'export-devices',
  status: state === 'running' ? 'running' : 'completed',
  scope: { kind: 'devices', deviceCount: rows.length },
  requestedBy: person,
  createdAt: new Date(Date.now() - 60_000).toISOString(),
  startedAt: new Date(Date.now() - 50_000).toISOString(),
  finishedAt: state === 'running' ? null : new Date().toISOString(),
  progress: {
    total: rows.length,
    // Production writes the phase counters; the outcome counters stay zero while it runs.
    succeeded: state === 'running' ? 0 : rows.length,
    failed: 0,
    unknown: 0,
    skipped: 0,
    expired: 0,
    cancelled: 0,
    pending: state === 'running' ? rows.length : 0,
  },
  phase:
    state === 'running'
      ? { name: 'write-rows', done: 3, total: rows.length }
      : null,
  exportSummary: { purpose },
  exportFile:
    state === 'running'
      ? null
      : {
          name:
            purpose === 'edit'
              ? `devices-for-editing-${displayId}.csv`
              : `device-report-${displayId}.csv`,
          sizeBytes: 7987,
          rows: rows.length,
          columns: purpose === 'edit' ? 10 : 6,
          expiresAt: expiry(),
        },
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
});

interface MockOptions {
  /** The server-side selection count. State 03 holds 62,480. */
  selectedCount?: number;
  /** The job state that a read of EXP-001 answers. */
  state?: 'running' | 'completed';
  /** The theme of the stored preferences (state 13 of the dark theme). */
  theme?: 'light' | 'dark';
}

/** The Devices page needs the session, a published inventory, and the export routes. */
async function signIn(page: Page, options: MockOptions = {}) {
  const selectedCount = options.selectedCount ?? rows.length;
  const state = {
    job: options.state ?? ('running' as 'running' | 'completed'),
  };
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
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
            preferences: {
              theme: options.theme ?? 'light',
              navigationCollapsed: false,
            },
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
            added: selectedCount,
            excluded: 0,
            selectedCount,
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
    if (
      path === '/api/devices/exports' &&
      route.request().method() === 'POST'
    ) {
      const body = route.request().postDataJSON() as { purpose: string };
      const displayId = body.purpose === 'report' ? 'EXP-002' : 'EXP-001';
      return route.fulfill({
        status: 202,
        json: {
          jobId: displayId === 'EXP-001' ? expJobId : reportJobId,
          displayId,
          status: 'accepted',
          rows: selectedCount,
        },
      });
    }
    if (path === '/api/jobs/EXP-001')
      return route.fulfill({ json: exportJob('EXP-001', 'edit', state.job) });
    if (path === '/api/jobs/EXP-002')
      return route.fulfill({
        json: exportJob('EXP-002', 'report', 'completed'),
      });
    if (path === '/api/jobs/activity/seen')
      return route.fulfill({ json: { seenAt: new Date().toISOString() } });
    if (path === '/api/jobs/activity')
      return route.fulfill({
        json: {
          running: { count: 1, jobs: [activityJob] },
          waiting: { count: 0, jobs: [] },
          recent: { count: 0, jobs: [], nextExpiryAt: null },
          attention: false,
          seenAt: null,
          observedAt: new Date().toISOString(),
        },
      });
    if (path === '/api/customer')
      return route.fulfill({ json: { customer: null } });
    if (path === '/api/google-connection')
      return route.fulfill({ json: { connection: null } });
    if (path === '/api/google-connection/health')
      return route.fulfill({ json: { health: null } });
    if (path === '/api/auth/preferences')
      return route.fulfill({ json: route.request().postDataJSON() });
    return route.fulfill({ status: 404, json: {} });
  });
  return state;
}

async function openDevices(page: Page, options: MockOptions = {}) {
  const state = await signIn(page, options);
  await page.goto('/devices');
  await expect(
    page.getByRole('heading', { name: 'Devices', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('gridcell', { name: 'C0A1-0001', exact: true }),
  ).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  return state;
}

const dialog = (page: Page) => page.getByRole('dialog');
/** The export dialog alone, while the Activity panel is also open. */
const exportDialog = (page: Page) =>
  page.locator('section[role="dialog"][aria-labelledby="export-dialog-title"]');
const bulk = (page: Page) =>
  page.getByRole('button', { name: 'Bulk Actions', exact: true });

async function openEntry(page: Page, name: string) {
  await bulk(page).click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name, exact: true }).click();
  await expect(menu).toBeHidden();
  await expect(dialog(page)).toBeVisible();
}

async function shot(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  const dir = 'dist/e2e-evidence/export-import';
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: `${dir}/${name}.png` });
}

test.use({
  viewport: { width: 1440, height: 900 },
  timezoneId: 'America/New_York',
});

test.describe('Export, Reports, and Import', () => {
  test('state 01: the menu lists the three entries below a divider', async ({
    page,
  }) => {
    await openDevices(page);
    await bulk(page).click();
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await expect(menu).toHaveCSS('opacity', '1');
    const items = menu.getByRole('menuitem');
    await expect(items).toHaveText([
      'Update device',
      'Send command',
      'Change status',
      'Export',
      'Reports',
      'Import',
    ]);
    await expect(menu.locator('mat-divider')).toHaveCount(1);
    await shot(page, '01-bulk-actions-menu');
  });

  test('state 02: configure at 480 px', async ({ page }) => {
    await openDevices(page);
    await openEntry(page, 'Export');
    await expect(dialog(page)).toHaveCSS('width', '480px');
    await expect(dialog(page)).toContainText(
      '6 selected devices · Not submitted',
    );
    await expect(dialog(page)).toContainText('CSV file');
    await expect(dialog(page)).toContainText(
      'Google Drive is not available for your account.',
    );
    await expect(
      dialog(page).getByRole('button', { name: 'Export 6 devices' }),
    ).toBeEnabled();
    // The checked CSV card carries the approved accent border and selected surface (state 02).
    await expect(
      dialog(page).locator('mat-radio-button.option-card').first(),
    ).toHaveCSS('border-color', 'rgb(26, 115, 232)');
    await shot(page, '02-export-dialog');
  });

  test('state 03: the over-limit note disables the primary action', async ({
    page,
  }) => {
    await openDevices(page, { selectedCount: 62_480 });
    await openEntry(page, 'Export');
    await expect(dialog(page)).toContainText(
      'An edit export holds at most 50,000 devices.',
    );
    await expect(dialog(page)).toContainText('This selection holds 62,480.');
    await expect(
      dialog(page).getByRole('button', { name: 'Export 62,480 devices' }),
    ).toBeDisabled();
    await shot(page, '03-export-over-limit');
  });

  test('state 04 and 05: running and ready', async ({ page }) => {
    const state = await openDevices(page);
    await openEntry(page, 'Export');
    await dialog(page)
      .getByRole('button', { name: 'Export 6 devices' })
      .click();
    await expect(dialog(page)).toContainText('Job EXP-001 · Running');
    await expect(dialog(page)).toContainText('3 of 6');
    await expect(dialog(page)).toContainText(
      'Closing this dialog keeps the export running.',
    );
    // The phase heading stays in the accessibility tree and takes no visible space (state 04).
    await expect(dialog(page).locator('#phases-label')).toHaveCSS(
      'position',
      'absolute',
    );
    await expect(dialog(page).locator('#phases-label')).toHaveCSS(
      'width',
      '1px',
    );
    await shot(page, '04-export-running');

    // The job finishes; the entry returns to this tab's own export (behavior 6).
    state.job = 'completed';
    await dialog(page)
      .locator('.export-actions')
      .getByRole('button', { name: 'Close' })
      .click();
    await expect(dialog(page)).toBeHidden();
    await openEntry(page, 'Export');
    await expect(dialog(page)).toContainText('devices-for-editing-EXP-001.csv');
    await expect(dialog(page)).toContainText('Ready');
    const download = dialog(page).getByRole('link', { name: 'Download CSV' });
    await expect(download).toHaveAttribute(
      'href',
      '/api/devices/exports/EXP-001/file',
    );
    await shot(page, '05-export-ready');
  });

  test('state 06: the help pane docks beside Configure', async ({ page }) => {
    await openDevices(page);
    await openEntry(page, 'Export');
    await dialog(page)
      .getByRole('button', { name: 'Export and import help' })
      .click();
    await expect(dialog(page)).toHaveCSS('width', '1000px');
    await expect(
      page.getByRole('heading', { name: 'Export and import help' }),
    ).toBeVisible();
    await expect(dialog(page)).toContainText('Editing rules');
    // The left surface stays the approved Configure step with its action bar.
    await expect(
      dialog(page).getByRole('button', { name: 'Export 6 devices' }),
    ).toBeVisible();
    await expect(
      dialog(page).getByRole('button', { name: 'Cancel' }),
    ).toBeVisible();
    await expect(dialog(page).getByText('Write rows')).toHaveCount(0);
    await shot(page, '06-export-help');
  });

  test('state 07 and 08: the report columns and the ready report', async ({
    page,
  }) => {
    await openDevices(page);
    await openEntry(page, 'Reports');
    await expect(dialog(page)).toHaveCSS('width', '480px');
    await expect(dialog(page)).toContainText('Visible grid columns');
    await expect(dialog(page)).toContainText('Create report');
    await shot(page, '07-reports-dialog');
    await dialog(page).getByRole('button', { name: 'Create report' }).click();
    await expect(dialog(page)).toContainText('device-report-EXP-002.csv');
    await expect(dialog(page)).toContainText('Ready');
    await shot(page, '08-reports-ready');
  });

  test('opens the export at the step of the job in the address', async ({
    page,
  }) => {
    await openDevices(page);
    // An Activity row of an own export job links to this address (behavior 5).
    await page.goto('/devices?job=EXP-002');
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page)).toContainText('Create a report');
    await expect(dialog(page)).toContainText('device-report-EXP-002.csv');
    await expect(dialog(page)).toContainText('Ready');
  });

  test('the same Activity row reopens its export after Close', async ({
    page,
  }) => {
    await openDevices(page);
    const bell = page.getByRole('button', { name: /^Activity:/ });
    const activity = page.getByRole('dialog', { name: 'Activity' });
    await bell.click();
    await activity.getByRole('link', { name: /EXP-001/ }).click();
    await expect(exportDialog(page)).toContainText('Job EXP-001 · Running');
    await expect(page).toHaveURL(/\/devices\?job=EXP-001$/);
    await exportDialog(page)
      .locator('.export-actions')
      .getByRole('button', { name: 'Close' })
      .click();
    await expect(exportDialog(page)).toBeHidden();
    await expect(page).toHaveURL(/\/devices$/);

    // Closing dropped ?job=. The same row must open the dialog again (R3).
    await bell.click();
    await activity.getByRole('link', { name: /EXP-001/ }).click();
    await expect(exportDialog(page)).toContainText('Job EXP-001 · Running');
  });

  test('the dialog holds focus and returns it to Bulk Actions on close', async ({
    page,
  }) => {
    await openDevices(page);
    await openEntry(page, 'Export');
    // cdkTrapFocus moves focus inside the dialog (UI-09).
    await expect
      .poll(() =>
        page.evaluate(
          () => document.activeElement?.closest('[role="dialog"]') !== null,
        ),
      )
      .toBe(true);
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();
    await expect(bulk(page)).toBeFocused();
  });
});

import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  DEVICE_EDIT_TEMPLATE_HEADERS,
  devicePageSchema,
} from '@campus/application-contracts';
import { installLiveStreams } from './live-streams';

/**
 * Drive states 05 to 13 of the Devices dialog
 * (`docs/ui/designs/2026-10-30-device-drive-slice-05-drive-import-dialog.png` to
 * `...-13-drive-source-lost.png`, and the dark state 07) against a mocked API.
 *
 * Playwright answers `https://apis.google.com/js/api.js` with `google-picker-double.js`. The
 * Google header reads go to routed Sheets and Drive answers with the session token.
 */

const customerId = 'C0123456';
const observedAt = '2026-10-30T15:00:00.000Z';
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
  lastContact: '2026-10-30T14:58:00Z',
  annotatedLocation: null,
  annotatedUser: null,
  notes: null,
  status: 'ACTIVE',
  battery: {
    status: 'reported',
    health: 'normal',
    capacityPercent: 91,
    reportedAt: '2026-10-30T14:00:00Z',
  },
  lastEntitySync: observedAt,
  stale: false,
}));

/** The edit template header and one data row, as the browser reads them from a Sheet. */
const templateHeader = [...DEVICE_EDIT_TEMPLATE_HEADERS];
const templateRow = templateHeader.map((_, index) =>
  index === 0 || index === 1 ? 'C0A1-0001' : '',
);
const sheetRows = [templateHeader, templateRow];
const csvText = `${templateHeader.join(',')}\r\n${templateRow.join(',')}\r\n`;

/** The example token of the session route. It has no form of a real Google token. */
const exampleToken = 'example-drive-token-0001';
/** The example Picker key of 39 characters: the length of a browser key, not its form. */
const examplePickerKey = 'example-picker-key-00000000000000000000';
const exampleAppId = '123456789012';

/** The files of the Picker double, as state 06 lists them. */
const pickerFiles = [
  {
    id: 'drive-sheet-exp-003',
    name: 'devices-for-editing-EXP-003',
    mimeType: 'application/vnd.google-apps.spreadsheet',
    sizeBytes: null,
    lastEditedUtc: Date.UTC(2026, 9, 30, 15, 2),
    when: '11:02 AM',
  },
  {
    id: 'drive-csv-exp-001',
    name: 'devices-for-editing-EXP-001.csv',
    mimeType: 'text/csv',
    sizeBytes: 7987,
    lastEditedUtc: Date.UTC(2026, 9, 29, 20, 12),
    when: 'Oct 29',
  },
  {
    id: 'drive-sheet-library-reset',
    name: 'library-reset',
    mimeType: 'application/vnd.google-apps.spreadsheet',
    sizeBytes: null,
    lastEditedUtc: Date.UTC(2026, 9, 26, 18, 0),
    when: 'Oct 26',
  },
  {
    id: 'drive-csv-loaner-carts',
    name: 'loaner-carts.csv',
    mimeType: 'text/csv',
    sizeBytes: 2048,
    lastEditedUtc: Date.UTC(2026, 9, 21, 16, 0),
    when: 'Oct 21',
  },
  {
    id: 'drive-sheet-room-12',
    name: 'Room 12 inventory',
    mimeType: 'application/vnd.google-apps.spreadsheet',
    sizeBytes: null,
    lastEditedUtc: Date.UTC(2026, 9, 14, 15, 0),
    when: 'Oct 14',
  },
  {
    // The shared-file control: an owned-only view hides it (ruling 3, B4).
    id: 'drive-sheet-shared-control',
    name: 'shared-device-roster',
    mimeType: 'application/vnd.google-apps.spreadsheet',
    sizeBytes: null,
    lastEditedUtc: Date.UTC(2026, 9, 12, 15, 0),
    when: 'Oct 12',
    shared: true,
    owner: 'someone@example.org',
  },
];

/** The access cause that `GET /api/google/drive` answers for the import (states 05, 11, 12). */
type DriveAccessCase = 'available' | 'setup' | 'delegation' | 'account';
/** The session answer (state 12 refuses the account). */
type SessionCase = 'ok' | 'account' | 'unavailable';
/** The validation that the job detail answers (states 10 and 13). */
type JobCase = 'running' | 'lost';

interface MockOptions {
  readonly access?: DriveAccessCase;
  readonly session?: SessionCase;
  readonly job?: JobCase;
  readonly theme?: 'light' | 'dark';
  /** The Picker rows of this case. The default is the approved five owned files. */
  readonly files?: readonly unknown[];
  /** The file name of the job and the receipt of this case. */
  readonly jobName?: string;
  /** The tab title of the job and of its tab list. */
  readonly jobTab?: string;
}

const defaultJobName = 'devices-for-editing-EXP-003';
const defaultJobTab = 'Devices';

const accessAnswer = (access: DriveAccessCase) => {
  const driveImport =
    access === 'available'
      ? { available: true as const }
      : { available: false as const, cause: access };
  return { sheetExport: { available: false, cause: 'account' }, driveImport };
};

const importJob = (job: JobCase, name = defaultJobName, tab = defaultJobTab) =>
  job === 'running'
    ? {
        jobId: '2f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a12',
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
          name,
          sourceType: 'drive-sheet',
          sizeBytes: 12_800,
          rowsRead: 48,
          candidateRows: 13,
          tabTitle: tab,
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
      }
    : {
        jobId: '3f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a13',
        displayId: 'IMP-009',
        revision: 5,
        action: 'validate-device-import',
        status: 'failed',
        scope: { kind: 'rows', deviceCount: 48 },
        requestedBy: person,
        createdAt: new Date(Date.now() - 120_000).toISOString(),
        startedAt: new Date(Date.now() - 110_000).toISOString(),
        finishedAt: new Date(Date.now() - 60_000).toISOString(),
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
        phase: { name: 'drive-read', done: 0, total: null },
        exportSummary: null,
        exportFile: null,
        importSummary: {
          mode: 'sync-changes',
          planState: null,
          proposed: 0,
          rejected: 0,
          refusal: 'drive-source-unavailable',
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
          name,
          sourceType: 'drive-csv',
          sizeBytes: 7_987,
          rowsRead: 0,
          candidateRows: 0,
          tabTitle: null,
          refusalText: `Campus Commander cannot read ${name} from Google Drive. Choose the file again in Google Drive, then import again.`,
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
      };

/** The Picker double, served at the real script URL. */
const pickerDouble = (() => {
  let directory = process.cwd();
  for (let step = 0; step < 5; step++) {
    const candidate = join(
      directory,
      'frontend-e2e/src/google-picker-double.js',
    );
    if (existsSync(candidate)) return readFileSync(candidate, 'utf8');
    directory = dirname(directory);
  }
  throw new Error('picker-double-missing');
})();

/** The Google reads of the header check, and the token that each one sends. */
interface GoogleReads {
  readonly sheetRanges: string[];
  readonly sheetTokens: string[];
  readonly fileTokens: string[];
  readonly ranges: (string | null)[];
}

async function signIn(page: Page, options: MockOptions = {}) {
  const reads: GoogleReads = {
    sheetRanges: [],
    sheetTokens: [],
    fileTokens: [],
    ranges: [],
  };
  // The scenario clock: Friday, Oct 30, 2026, 11:05 AM Eastern (state 10).
  await page.clock.setFixedTime(new Date('2026-10-30T15:05:00.000Z'));
  await page.addInitScript(
    ({ files }) => {
      (window as unknown as { __pickerFiles: unknown }).__pickerFiles = files;
    },
    { files: options.files ?? pickerFiles },
  );
  await installLiveStreams(page);
  await page.route('https://apis.google.com/js/api.js', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: pickerDouble,
    }),
  );
  await page.route('https://sheets.googleapis.com/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    reads.sheetRanges.push(
      decodeURIComponent(url.pathname.split('/values/')[1] ?? ''),
    );
    reads.sheetTokens.push(request.headers()['authorization'] ?? '');
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        range: "'Devices'!A1:ZZ2",
        majorDimension: 'ROWS',
        values: sheetRows,
      }),
    });
  });
  await page.route('https://www.googleapis.com/**', async (route) => {
    const request = route.request();
    reads.fileTokens.push(request.headers()['authorization'] ?? '');
    reads.ranges.push(request.headers()['range'] ?? null);
    return route.fulfill({
      status: 200,
      contentType: 'text/csv',
      body: csvText,
    });
  });
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
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
            added: 0,
            excluded: 0,
            selectedCount: 0,
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
    if (path === '/api/google-connection')
      return route.fulfill({
        json: {
          connection: {
            state: 'connected',
            customerId,
            domains: [{ domain: 'example.org', verified: true, primary: true }],
            serviceAccountClientId: '100000000000000000001',
            delegatedAdmin: 'admin@example.org',
            lastSuccessfulReadAt: observedAt,
            failure: null,
          },
        },
      });
    if (path === '/api/google-connection/health')
      return route.fulfill({
        json: {
          health: {
            capabilities: [],
            checkedAt: observedAt,
            stale: false,
            state: 'active',
          },
        },
      });
    if (path === '/api/jobs/activity')
      return route.fulfill({ json: { jobs: [], running: 0 } });
    if (path === '/api/google/drive')
      return route.fulfill({
        json: accessAnswer(options.access ?? 'available'),
      });
    if (path === '/api/google/drive/session' && request.method() === 'POST') {
      const session = options.session ?? 'ok';
      if (session === 'account')
        return route.fulfill({
          status: 409,
          json: { reason: 'drive-unavailable', cause: 'account' },
        });
      if (session === 'unavailable')
        return route.fulfill({
          status: 503,
          json: { reason: 'google-unavailable' },
        });
      return route.fulfill({
        status: 200,
        json: {
          accessToken: exampleToken,
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          apiKey: examplePickerKey,
          appId: exampleAppId,
        },
      });
    }
    if (path === '/api/google/drive/files/drive-sheet-exp-003/tabs')
      return route.fulfill({
        json: {
          fileId: 'drive-sheet-exp-003',
          tabs: [
            { tabId: 0, title: options.jobTab ?? defaultJobTab, index: 0 },
            { tabId: 1, title: 'Notes', index: 1 },
          ],
        },
      });
    if (path === '/api/devices/imports/drive' && request.method() === 'POST')
      return route.fulfill({
        status: 202,
        json:
          options.job === 'lost'
            ? {
                jobId: '3f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a13',
                displayId: 'IMP-009',
                status: 'accepted',
                mode: 'sync-changes',
                name: options.jobName ?? 'devices-for-editing-EXP-001.csv',
                sourceType: 'drive-csv',
                tabTitle: null,
              }
            : {
                jobId: '2f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a12',
                displayId: 'IMP-010',
                status: 'accepted',
                mode: 'sync-changes',
                name: options.jobName ?? defaultJobName,
                sourceType: 'drive-sheet',
                tabTitle: options.jobTab ?? defaultJobTab,
              },
      });
    if (path === '/api/jobs/IMP-010' || path === '/api/jobs/IMP-009')
      return route.fulfill({
        json: importJob(
          options.job ?? 'running',
          options.jobName ??
            (options.job === 'lost'
              ? 'devices-for-editing-EXP-001.csv'
              : defaultJobName),
          options.jobTab ?? defaultJobTab,
        ),
      });
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto('/devices');
  await expect(
    page.getByRole('heading', { name: 'Devices', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('gridcell', { name: 'C0A1-0001', exact: true }),
  ).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  return reads;
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

const driveCard = (page: Page) =>
  dialog(page)
    .locator('section[aria-labelledby="source-label"] mat-radio-button')
    .filter({ hasText: 'Google Drive' });
const uploadCard = (page: Page) =>
  dialog(page)
    .locator('section[aria-labelledby="source-label"] mat-radio-button')
    .filter({ hasText: 'Upload a CSV file' });

async function chooseDrive(page: Page) {
  await driveCard(page).click();
  await expect(driveCard(page).locator('input')).toBeChecked();
}

async function openPicker(page: Page) {
  await chooseDrive(page);
  await dialog(page)
    .getByRole('button', { name: 'Choose from Google Drive' })
    .click();
  const picker = page.getByRole('dialog', { name: 'Select a file' });
  await expect(picker).toBeVisible();
  return picker;
}

async function pickFile(page: Page, name: RegExp) {
  const picker = await openPicker(page);
  await picker.getByRole('option', { name }).click();
  await picker.getByRole('button', { name: 'Select', exact: true }).click();
  await expect(picker).toBeHidden();
}

async function shot(page: Page, name: string) {
  await page.mouse.move(4, 4);
  await page.waitForTimeout(250);
  await page.evaluate(() => document.fonts.ready);
  const dir = 'dist/e2e-evidence/drive-df2';
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: `${dir}/${name}.png` });
}

test.use({
  viewport: { width: 1440, height: 900 },
  timezoneId: 'America/New_York',
});

test.describe('Drive import', () => {
  test('state 05: Google Drive is the second Source card', async ({ page }) => {
    await signIn(page);
    await openImport(page);
    await expect(dialog(page)).toHaveCSS('width', '480px');
    // Upload is the first source, and the available Drive card follows it.
    await expect(uploadCard(page).locator('input')).toBeChecked();
    await expect(driveCard(page).locator('input')).toBeEnabled();
    // The Source cards take the keyboard: focus the Drive input, then select it with Space.
    await driveCard(page).locator('input').focus();
    await page.keyboard.press('Space');
    await expect(driveCard(page).locator('input')).toBeChecked();
    await expect(dialog(page)).toContainText('A Sheet or a CSV file');
    await chooseDrive(page);
    await expect(dialog(page)).toContainText('Google Drive · Not submitted');
    await expect(dialog(page)).toContainText('A Sheet or a CSV file');
    await expect(
      dialog(page).getByRole('button', { name: 'Choose from Google Drive' }),
    ).toBeVisible();
    await expect(
      dialog(page).getByRole('button', { name: 'Start validation' }),
    ).toBeDisabled();
    // The Drive zone keeps the one-row shape of the approved drop zone.
    const zone = dialog(page).locator('.drop-zone.drive-zone');
    const box = await zone.boundingBox();
    expect(box?.height).toBeLessThan(64);
    await shot(page, '05-drive-import-dialog');
  });

  test('state 06: the Picker receives the session token, and Cancel keeps state 05', async ({
    page,
  }) => {
    await signIn(page);
    await openImport(page);
    const picker = await openPicker(page);
    await expect(picker).toContainText('My Drive');
    await expect(picker.getByRole('option')).toHaveCount(5);
    // The owned-only view hides the shared control (ruling 3, B4).
    await expect(
      picker.getByRole('option', { name: /shared-device-roster/ }),
    ).toHaveCount(0);
    const call = await page.evaluate(
      () =>
        (window as unknown as { __googlePicker: { calls: unknown[] } })
          .__googlePicker.calls[0],
    );
    expect(call).toMatchObject({
      token: exampleToken,
      apiKey: examplePickerKey,
      appId: exampleAppId,
      mimeTypes: ['application/vnd.google-apps.spreadsheet,text/csv'],
      ownedByMe: true,
    });
    expect((call as { origin: string }).origin).toBe(
      new URL(page.url()).origin,
    );
    await shot(page, '06-drive-picker');
    // Cancel returns to state 05 unchanged: no file, Drive still selected, Start disabled.
    await picker.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(picker).toBeHidden();
    await expect(dialog(page)).toContainText('Google Drive · Not submitted');
    await expect(dialog(page).locator('.file-item')).toHaveCount(0);
    await expect(
      dialog(page).getByRole('button', { name: 'Start validation' }),
    ).toBeDisabled();
  });

  test('state 07: the chosen Sheet lists its tabs and checks the first tab', async ({
    page,
  }) => {
    const reads = await signIn(page);
    await openImport(page);
    await pickFile(page, /devices-for-editing-EXP-003/);
    const item = dialog(page).locator('.file-item');
    await expect(item).toContainText('devices-for-editing-EXP-003');
    await expect(item.locator('.meta-items')).toContainText('Google Sheet');
    await expect(item.locator('.meta-items')).toContainText('2 tabs');
    await expect(item.locator('.meta-items')).toContainText(
      /Edited Oct 30, 11:02 AM/,
    );
    await expect(item).toContainText('Devices');
    await expect(item).toContainText('Header check passed.');
    await expect(
      dialog(page).getByRole('button', { name: 'Start validation' }),
    ).toBeEnabled();
    // The browser read rows 1 and 2 of the first tab with the session token.
    expect(reads.sheetRanges).toEqual(["'Devices'!A1:ZZ2"]);
    expect(reads.sheetTokens).toEqual([`Bearer ${exampleToken}`]);
    await shot(page, '07-drive-sheet-chosen');
  });

  test('state 07 in the dark theme keeps the Sheet whole', async ({ page }) => {
    await signIn(page, { theme: 'dark' });
    await openImport(page);
    await pickFile(page, /devices-for-editing-EXP-003/);
    await expect(dialog(page).locator('.file-item')).toContainText('2 tabs');
    await expect(dialog(page).locator('.file-item')).toContainText(
      /Edited Oct 30, 11:02 AM/,
    );
    await shot(page, '07-drive-sheet-chosen-dark');
  });

  test('state 08: a Drive CSV shows its size and columns, with no Tab field', async ({
    page,
  }) => {
    const reads = await signIn(page);
    await openImport(page);
    await pickFile(page, /devices-for-editing-EXP-001\.csv/);
    const item = dialog(page).locator('.file-item');
    await expect(item).toContainText('devices-for-editing-EXP-001.csv');
    await expect(item.locator('.meta-items')).toContainText('7.8 KB');
    await expect(item.locator('.meta-items')).toContainText('10 columns');
    await expect(item.locator('.meta-items')).toContainText(
      /Edited Oct 29, 4:12 PM/,
    );
    await expect(item).toContainText('Header check passed.');
    await expect(item.getByRole('combobox')).toHaveCount(0);
    await expect(
      dialog(page).getByRole('button', { name: 'Start validation' }),
    ).toBeEnabled();
    // The browser read the first 64 KiB of the file with the session token.
    expect(reads.ranges).toEqual(['bytes=0-65535']);
    expect(reads.fileTokens).toEqual([`Bearer ${exampleToken}`]);
    await shot(page, '08-drive-csv-chosen');
  });

  test('state 09: the help gains the Google Drive topic', async ({ page }) => {
    await signIn(page);
    await openImport(page);
    await pickFile(page, /devices-for-editing-EXP-003/);
    await dialog(page)
      .getByRole('button', { name: 'Export and import help' })
      .click();
    const help = dialog(page).locator('app-device-export-help');
    await expect(help).toBeVisible();
    await help.getByRole('radio', { name: 'Google Drive' }).click();
    for (const text of [
      'Google Sheet export and Google Drive import use your own Google Drive.',
      'A Google Sheet export creates a Sheet in your Google Drive. You own the Sheet.',
      'Campus Commander keeps only the link. Share the Sheet in Google Drive.',
      'Choose from Google Drive opens the Google Picker. It lists your Google Sheets and CSV files.',
      'For a Google Sheet, choose the tab. The first tab starts selected.',
      'Hidden and filtered rows count as rows.',
      'Validation reads the file when it starts. Import again after later edits.',
      'Campus Commander opens only its own files and the files that you choose.',
    ])
      await expect(help).toContainText(text);
    // The pane docks beside the 480 px step, so the dialog takes 1000 px (state 09).
    await expect(dialog(page)).toHaveCSS('width', '1000px');
    await shot(page, '09-drive-help');
  });

  test('state 10: the validation reads from Google Drive', async ({ page }) => {
    await signIn(page);
    await openImport(page);
    await pickFile(page, /devices-for-editing-EXP-003/);
    await dialog(page)
      .getByRole('button', { name: 'Start validation' })
      .click();
    await expect(dialog(page)).toContainText('Job IMP-010 · Running');
    await expect(dialog(page)).toContainText(
      /Sync changes\s*·\s*devices-for-editing-EXP-003\s*›\s*Devices/,
    );
    const phases = dialog(page).locator('.phase');
    await expect(phases.first()).toContainText('Read from Google Drive');
    await expect(phases.first()).toContainText('48 rows');
    await expect(phases.first()).toHaveClass(/is-done/);
    await expect(phases.nth(1)).toContainText('Header check');
    await expect(phases.nth(1)).toContainText('Passed');
    await expect(phases.nth(2)).toContainText('Refresh stale devices');
    await expect(phases.nth(2)).toContainText('6 of 9');
    await expect(dialog(page)).toContainText('Rows read');
    await expect(dialog(page)).toContainText('Edited rows');
    await expect(dialog(page).locator('.counter').first()).toContainText('48');
    await expect(dialog(page).locator('.counter').nth(1)).toContainText('13');
    await expect(dialog(page)).toContainText(
      'Closing this dialog keeps the validation running.',
    );
    await shot(page, '10-drive-validation-running');
  });

  test('state 07 and 10: long file and tab names keep one line with their full value (B5)', async ({
    page,
  }) => {
    const longName =
      'devices-for-editing-EXP-003-quarterly-inventory-review-for-every-school-in-the-district-2026-final';
    const longTab =
      'Devices imported from the district inventory review of every school and every grade';
    await signIn(page, {
      files: [{ ...pickerFiles[0], name: longName }, ...pickerFiles.slice(1)],
      jobName: longName,
      jobTab: longTab,
    });
    await openImport(page);
    await pickFile(page, /quarterly-inventory-review/);
    const item = dialog(page).locator('.file-item');
    const fileName = item.locator('.file-name');
    await expect(fileName).toHaveText(longName);
    // The card cuts the name on one line and its tooltip holds the whole value (choice 12).
    expect(
      await fileName.evaluate((el) => el.scrollWidth > el.clientWidth),
    ).toBe(true);
    await fileName.hover();
    await expect(page.locator('mat-tooltip-component')).toContainText(longName);
    await page.mouse.move(4, 4);
    await expect(page.locator('mat-tooltip-component')).toBeHidden();
    // The Tab field cuts the long tab on one line and offers the whole title (choice 12).
    const tabField = item.getByRole('combobox');
    await expect(tabField).toContainText(longTab);
    const tabValue = tabField.locator('.mat-mdc-select-value');
    expect(await tabValue.evaluate((el) => el.getClientRects().length)).toBe(1);
    expect(
      await tabValue.evaluate((el) => el.scrollWidth > el.clientWidth),
    ).toBe(true);
    await tabField.hover();
    await expect(page.locator('mat-tooltip-component')).toContainText(longTab);
    await page.mouse.move(4, 4);
    await expect(page.locator('mat-tooltip-component')).toBeHidden();
    await shot(page, '07-drive-sheet-chosen-long-values');
    await dialog(page)
      .getByRole('button', { name: 'Start validation' })
      .click();
    await expect(dialog(page)).toContainText('Job IMP-010 · Running');
    const nameToken = dialog(page).locator('.job-sub .sub-item.name');
    const tabToken = dialog(page).locator('.job-sub .sub-item.tab');
    // The subtitle keeps the mode, the file, and the tab on one 480 px line.
    await expect(dialog(page).locator('.job-sub .sub-item')).toHaveCount(3);
    expect(await nameToken.evaluate((el) => el.getClientRects().length)).toBe(
      1,
    );
    expect(await tabToken.evaluate((el) => el.getClientRects().length)).toBe(1);
    expect(
      await nameToken.evaluate((el) => el.scrollWidth > el.clientWidth),
    ).toBe(true);
    expect(
      await tabToken.evaluate((el) => el.scrollWidth > el.clientWidth),
    ).toBe(true);
    const row = await dialog(page).locator('.job-sub').boundingBox();
    const box = await dialog(page).boundingBox();
    expect((row?.width ?? 0) <= (box?.width ?? 0)).toBe(true);
    await nameToken.hover();
    await expect(page.locator('mat-tooltip-component')).toContainText(longName);
    await page.mouse.move(4, 4);
    await expect(page.locator('mat-tooltip-component')).toBeHidden();
    await tabToken.hover();
    await expect(page.locator('mat-tooltip-component')).toContainText(longTab);
    await page.mouse.move(4, 4);
    await shot(page, '10-drive-validation-long-values');
  });

  test('state 13: a long lost-file name cuts in one token and keeps its full value (B5)', async ({
    page,
  }) => {
    const longName =
      'devices-for-editing-EXP-001-quarterly-inventory-review-for-every-school-in-the-district-2026-final.csv';
    await signIn(page, { job: 'lost', jobName: longName });
    await openImport(page);
    await pickFile(page, /devices-for-editing-EXP-001\.csv/);
    await dialog(page)
      .getByRole('button', { name: 'Start validation' })
      .click();
    await expect(dialog(page)).toContainText('Job IMP-009 · Failed');
    const token = dialog(page)
      .locator('.action-note.error .value-token')
      .first();
    await expect(token).toHaveText(longName);
    expect(await token.evaluate((el) => el.getClientRects().length)).toBe(1);
    expect(await token.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(
      true,
    );
    const note = await dialog(page).locator('.action-note.error').boundingBox();
    const box = await dialog(page).boundingBox();
    expect((note?.width ?? 0) <= (box?.width ?? 0)).toBe(true);
    await token.hover();
    await expect(page.locator('mat-tooltip-component')).toContainText(longName);
    await page.mouse.move(4, 4);
    await shot(page, '13-drive-source-lost-long-name');
  });

  test('state 11: a missing setup disables Google Drive and keeps Upload', async ({
    page,
  }) => {
    await signIn(page, { access: 'setup' });
    await openImport(page);
    await expect(uploadCard(page).locator('input')).toBeChecked();
    await expect(driveCard(page).locator('input')).toBeDisabled();
    await expect(dialog(page)).toContainText(
      'Google Drive needs the Picker API key and the project number. Add them on the Google connection page.',
    );
    await expect(dialog(page)).toContainText('CSV file · Not submitted');
    await expect(dialog(page)).toContainText('Drop a CSV file here');
    await expect(
      dialog(page).getByRole('button', { name: 'Start validation' }),
    ).toBeDisabled();
    await shot(page, '11-drive-setup-missing');
  });

  test('state 12: a refused account selects Upload and shows the alert', async ({
    page,
  }) => {
    await signIn(page, { session: 'account' });
    await openImport(page);
    await chooseDrive(page);
    await dialog(page)
      .getByRole('button', { name: 'Choose from Google Drive' })
      .click();
    await expect(dialog(page)).toContainText(
      'Google refused Drive access for your account. Upload a CSV file instead.',
    );
    await expect(uploadCard(page).locator('input')).toBeChecked();
    await expect(driveCard(page).locator('input')).toBeDisabled();
    await expect(dialog(page)).toContainText(
      'Google Drive is not available for your account.',
    );
    await expect(dialog(page)).toContainText('CSV file · Not submitted');
    await shot(page, '12-drive-access-refused');
  });

  test('state 13: a lost Drive source names the file, and Import again returns to state 05', async ({
    page,
  }) => {
    await signIn(page, { job: 'lost' });
    await openImport(page);
    await pickFile(page, /devices-for-editing-EXP-001\.csv/);
    await dialog(page)
      .getByRole('button', { name: 'Start validation' })
      .click();
    await expect(dialog(page)).toContainText('Job IMP-009 · Failed');
    await expect(dialog(page)).toContainText(
      /Sync changes\s*·\s*devices-for-editing-EXP-001\.csv/,
    );
    const first = dialog(page).locator('.phase').first();
    await expect(first).toContainText('Read from Google Drive');
    await expect(first).toContainText('Failed');
    await expect(first).toHaveClass(/is-failed/);
    await expect(dialog(page)).toContainText(
      'Campus Commander cannot read devices-for-editing-EXP-001.csv from Google Drive.',
    );
    await expect(dialog(page)).toContainText(
      'Choose the file again in Google Drive, then import again.',
    );
    // The file name is its own whole token, never broken after a hyphen (choice 12, B5).
    const lostName = dialog(page)
      .locator('.action-note.error .value-token')
      .first();
    await expect(lostName).toHaveText('devices-for-editing-EXP-001.csv');
    expect(await lostName.evaluate((el) => el.getClientRects().length)).toBe(1);
    await expect(dialog(page)).toContainText(
      'Validation stopped before any row check. No report and no plan exist. Nothing reached Google.',
    );
    await expect(dialog(page)).toContainText('No report');
    await shot(page, '13-drive-source-lost');
    // Import again returns to state 05 with no file chosen.
    await dialog(page).getByRole('button', { name: 'Import again' }).click();
    await expect(dialog(page)).toContainText('Google Drive · Not submitted');
    await expect(driveCard(page).locator('input')).toBeChecked();
    await expect(dialog(page).locator('.file-item')).toHaveCount(0);
    await expect(
      dialog(page).getByRole('button', { name: 'Start validation' }),
    ).toBeDisabled();
  });
});

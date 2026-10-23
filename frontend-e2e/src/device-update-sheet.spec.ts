import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { devicePageSchema } from '@campus/application-contracts';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const customerId = 'C0123456';
const observedAt = '2026-10-19T12:00:00.000Z';
const previewId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const jobId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const evidenceDir = path.join(process.cwd(), 'dist/e2e-evidence');

const grants = [
  { action: 'devices:read', scope: { kind: 'district', customerId } },
  { action: 'devices:write', scope: { kind: 'district', customerId } },
  { action: 'devices:bulk-actions', scope: { kind: 'district', customerId } },
];

const rows = Array.from({ length: 6 }, (_, index) => ({
  deviceId: `synthetic-device-${index + 1}`,
  serialNumber: `C0A1-000${index + 1}`,
  model: 'Lenovo 100e Gen 4',
  assetTag: `HS-040${index + 1}`,
  orgUnitPath: '/School A',
  lastContact: '2026-10-19T11:58:00Z',
  annotatedLocation: 'Science wing',
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

const preview = {
  previewId,
  displayId: 'PV-006',
  changes: [
    { field: 'annotatedLocation', mode: 'replace', value: 'North lab' },
  ],
  fieldChanges: 6,
  selected: 6,
  eligible: 6,
  unchanged: 0,
  excluded: 0,
  conflicts: 0,
  oldestObservedAt: '2026-10-19T10:00:00.000Z',
  stale: false,
  preparedAt: '2026-10-19T12:00:00.000Z',
  expiresAt: '2026-10-19T12:15:00.000Z',
  manifestDigest: 'a'.repeat(64),
};

const targets = rows.map((row) => ({
  deviceId: row.deviceId,
  serialNumber: row.serialNumber,
  field: 'annotatedLocation',
  observedValue: row.annotatedLocation,
  baselineValue: row.annotatedLocation,
  approvedValue: 'North lab',
  duplicateSerialNumber: null,
  disposition: 'eligible',
  exclusionReason: null,
}));

const receipt = {
  jobId,
  displayId: 'UPD-006',
  status: 'accepted',
  deviceCount: 6,
  updateCount: 6,
};

const job = {
  jobId,
  displayId: 'UPD-006',
  revision: 1,
  action: 'update-device-annotations',
  status: 'running',
  scope: { kind: 'devices', deviceCount: 6 },
  requestedBy: {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    displayName: 'District operator',
  },
  createdAt: '2026-10-19T12:00:00.000Z',
  startedAt: '2026-10-19T12:01:00.000Z',
  finishedAt: null,
  progress: {
    total: 6,
    succeeded: 2,
    failed: 0,
    unknown: 0,
    skipped: 0,
    expired: 0,
    pending: 4,
  },
  failure: null,
  confirmedBy: {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    displayName: 'District operator',
  },
  previewDisplayId: 'PV-006',
  changes: [
    { field: 'annotatedLocation', mode: 'replace', value: 'North lab' },
  ],
  commandType: null,
  statusAction: null,
  deprovisionReason: null,
  targetOrgUnitPaths: ['/School A'],
  correlationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  latestActivity: {
    at: '2026-10-19T12:01:00.000Z',
    failed: { count: 0, operations: [] },
    unknown: { count: 0, operations: [] },
  },
};

interface ApiOptions {
  targetsStatus?: 200 | 410;
  confirmStatus?: 200 | 403;
  abortPreview?: boolean;
  /** The frozen preview read that the sheet makes when it enters a step. */
  previewReadStatus?: 410 | 403;
  abortPreviewRead?: boolean;
  /** The answer to each confirm request, in order. `lost` drops the answer. */
  confirmAnswers?: readonly ConfirmAnswer[];
}

type ConfirmAnswer =
  | 'lost'
  | 'accepted'
  | 'forbidden'
  | 'permission-changed'
  | 'preview-changed'
  | 'connection-required'
  | 'connection-changed'
  | 'preview-expired';

/** The Devices page and the update routes needed by the sheet. */
async function mockApi(page: Page, options: ApiOptions = {}) {
  const confirmAnswers = [...(options.confirmAnswers ?? [])];
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const routePath = url.pathname;
    const method = request.method();

    if (method === 'POST' && routePath === '/api/devices/updates/previews') {
      if (options.abortPreview) return route.abort('failed');
      return route.fulfill({ status: 201, json: preview });
    }
    if (
      method === 'GET' &&
      routePath === `/api/devices/updates/previews/${previewId}`
    ) {
      if (options.abortPreviewRead) return route.abort('failed');
      if (options.previewReadStatus === 410)
        return route.fulfill({
          status: 410,
          json: {
            reason: 'preview-expired',
            expiresAt: '2026-10-19T12:15:00.000Z',
          },
        });
      if (options.previewReadStatus === 403)
        return route.fulfill({ status: 403, json: { reason: 'forbidden' } });
      return route.fulfill({ json: preview });
    }
    if (
      method === 'GET' &&
      routePath.startsWith('/api/devices/updates/previews/') &&
      routePath.endsWith('/targets')
    ) {
      if (options.targetsStatus === 410)
        return route.fulfill({
          status: 410,
          json: {
            reason: 'preview-expired',
            expiresAt: '2026-10-19T12:15:00.000Z',
          },
        });
      return route.fulfill({ json: { targets, nextCursor: null } });
    }
    if (method === 'POST' && routePath.endsWith('/confirm')) {
      if (options.confirmStatus === 403)
        return route.fulfill({ status: 403, json: { reason: 'forbidden' } });
      const answer = confirmAnswers.shift() ?? 'accepted';
      if (answer === 'lost') return route.abort('failed');
      if (answer === 'accepted')
        return route.fulfill({ status: 201, json: receipt });
      if (answer === 'preview-expired')
        return route.fulfill({
          status: 410,
          json: { reason: answer, expiresAt: '2026-10-19T12:15:00.000Z' },
        });
      return route.fulfill({
        status: answer === 'forbidden' ? 403 : 409,
        json: { reason: answer },
      });
    }
    if (routePath === '/api/jobs/UPD-006') return route.fulfill({ json: job });
    if (routePath === '/api/application')
      return route.fulfill({
        json: {
          phase: 3,
          authenticationConfigured: true,
          version: 'development',
          build: 'client-review',
        },
      });
    if (routePath === '/api/auth/session')
      return route.fulfill({
        json: {
          identity: {
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            displayName: 'District operator',
            permissionVersion: 1,
            permissions: [],
            grants,
            preferences: { theme: 'light', navigationCollapsed: false },
          },
          csrfToken: 'a'.repeat(64),
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        },
      });
    if (routePath === '/api/devices/selection')
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
    if (routePath === '/api/devices/selection/resolve')
      return route.fulfill({ json: { selected: {} } });
    if (routePath === '/api/devices/sync')
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
    if (routePath === '/api/devices/query')
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
    if (routePath === '/api/devices/freshness')
      return route.fulfill({
        json: { freshness: { stale: 0, refreshing: false } },
      });
    if (routePath === '/api/devices/org-units')
      return route.fulfill({ json: { orgUnits: [] } });
    if (routePath === '/api/devices/events')
      return route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: '',
      });
    if (routePath === '/api/devices/updates/access')
      return route.fulfill({
        json: {
          state: 'granted',
          scope:
            'https://www.googleapis.com/auth/admin.directory.device.chromeos',
          failure: null,
          checkedAt: '2026-10-19T12:00:00.000Z',
        },
      });
    if (routePath === '/api/customer')
      return route.fulfill({ json: { customer: null } });
    if (routePath === '/api/google-connection')
      return route.fulfill({ json: { connection: null } });
    if (routePath === '/api/google-connection/health')
      return route.fulfill({ json: { health: null } });
    if (routePath === '/api/auth/preferences')
      return route.fulfill({ json: request.postDataJSON() });
    return route.fulfill({ status: 404, json: {} });
  });
}

async function openDevices(page: Page) {
  await page.goto('/devices');
  await expect(
    page.getByRole('heading', { name: 'Devices', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Bulk Actions', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('gridcell', { name: 'C0A1-0001', exact: true }),
  ).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

async function openSheet(page: Page) {
  await page.getByRole('button', { name: 'Bulk Actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Update device' }).click();
  const sheet = page.locator('app-device-update-sheet .bulk-sheet');
  await expect(sheet).toHaveClass(/is-open/);
  await expect(sheet).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
  return sheet;
}

async function fillDraft(page: Page, value = 'North lab') {
  const sheet = page.locator('app-device-update-sheet .bulk-sheet');
  await sheet
    .locator('.field-block[data-field="annotatedLocation"]')
    .getByRole('combobox')
    .click();
  await page
    .getByRole('option', { name: 'Update · Replace the existing value' })
    .click();
  const input = sheet
    .locator('.field-block[data-field="annotatedLocation"]')
    .getByLabel('New value');
  await input.fill(value);
  await expect(input).toHaveValue(value);
  return input;
}

async function savePreview(page: Page) {
  const sheet = page.locator('app-device-update-sheet .bulk-sheet');
  await sheet.getByRole('button', { name: 'Save and preview' }).click();
  await expect(
    sheet.getByRole('heading', { name: 'Review 6 device updates' }),
  ).toBeVisible();
  return sheet;
}

async function continueToConfirm(page: Page) {
  const sheet = page.locator('app-device-update-sheet .bulk-sheet');
  await sheet.getByRole('button', { name: 'Continue to confirmation' }).click();
  await expect(
    sheet.getByRole('heading', { name: 'Confirm 6 device updates' }),
  ).toBeVisible();
  return sheet;
}

async function screenshot(page: Page, name: string) {
  mkdirSync(evidenceDir, { recursive: true });
  await page.screenshot({ path: path.join(evidenceDir, name) });
}

async function expectNoAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .exclude('.cdk-overlay-container')
    .analyze();
  expect(results.violations).toEqual([]);
}

test('hides a sheet that starts closed at the first paint', async ({
  page,
}) => {
  // The Devices page renders the closed sheet after the inventory loads. Record
  // the sheet's first painted frame and every transition it starts, so the test
  // fails if the closed sheet is ever painted open or slides out on page load.
  await page.addInitScript(() => {
    const evidence = { visibility: '', transitions: [] as string[] };
    (
      window as unknown as { __sheetFirstPaint: typeof evidence }
    ).__sheetFirstPaint = evidence;
    document.addEventListener(
      'transitionrun',
      (event) => {
        const target = event.target as HTMLElement;
        if (target.classList?.contains('bulk-sheet'))
          evidence.transitions.push(event.propertyName);
      },
      true,
    );
    const sample = () => {
      const sheet = document.querySelector(
        'app-device-update-sheet .bulk-sheet',
      );
      if (sheet && !evidence.visibility) {
        evidence.visibility = getComputedStyle(sheet).visibility;
        return;
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await mockApi(page);
  await page.goto('/devices');
  await expect(
    page.getByRole('button', { name: 'Bulk Actions', exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('app-device-update-sheet .bulk-sheet'),
  ).toBeAttached();
  await page.waitForTimeout(300);
  const evidence = await page.evaluate(
    () =>
      (
        window as unknown as {
          __sheetFirstPaint: { visibility: string; transitions: string[] };
        }
      ).__sheetFirstPaint,
  );
  expect(evidence.visibility).toBe('hidden');
  expect(evidence.transitions).toEqual([]);
  // The loose heading locator of the api-e2e Devices flow resolves to one element.
  await expect(
    page.getByRole('heading', { name: 'Devices', level: 1 }),
  ).toHaveCount(1);
  await expectNoAxeViolations(page);
});

for (const theme of ['light', 'dark'] as const) {
  test(`runs every sheet step in the ${theme} theme`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 990 });
    await mockApi(page);
    await openDevices(page);
    await page.evaluate((value) => {
      document.documentElement.dataset['theme'] = value;
    }, theme);
    const grid = page.locator('app-device-grid');
    const gridBox = await grid.boundingBox();
    expect(gridBox).not.toBeNull();

    const sheet = await openSheet(page);
    await expect(grid).toBeVisible();
    expect((await grid.boundingBox())?.width).toBe(gridBox!.width);
    await expect(page).toHaveURL(/\/devices$/);
    await expect(sheet.getByRole('heading', { level: 1 })).toHaveText(
      'Update 6 devices',
    );
    await expectNoAxeViolations(page);
    await fillDraft(page);
    await sheet
      .locator('.field-block[data-field="annotatedLocation"]')
      .getByLabel('New value')
      .blur();
    await expect(
      sheet.getByRole('button', { name: 'Save and preview' }),
    ).toBeEnabled();
    await page.waitForTimeout(300);
    await screenshot(page, `sheet-edit-${theme}.png`);

    await savePreview(page);
    await expect(sheet.getByText('C0A1-0001')).toBeVisible();
    await expect(sheet.getByText('Preview\u00a0PV\u2011006')).toBeVisible();
    await expect(grid).toBeVisible();
    await expectNoAxeViolations(page);
    await screenshot(page, `sheet-review-${theme}.png`);

    await continueToConfirm(page);
    await expect(sheet.getByRole('checkbox')).not.toBeChecked();
    await expect(
      sheet.getByRole('button', { name: 'Create update job' }),
    ).toBeDisabled();
    await expect(grid).toBeVisible();
    await expectNoAxeViolations(page);
    await sheet.getByRole('checkbox').check();
    await expect(sheet.locator('mat-checkbox')).toHaveClass(
      /mat-mdc-checkbox-checked/,
    );
    await screenshot(page, `sheet-confirm-${theme}.png`);

    await sheet.getByRole('button', { name: 'Create update job' }).click();
    await expect(
      sheet.getByRole('heading', { name: 'Update job created' }),
    ).toBeVisible();
    await expect(sheet.getByText('Job UPD-006 · Running')).toBeVisible();
    await expect(grid).toBeVisible();
    await expectNoAxeViolations(page);
    await screenshot(page, `sheet-done-${theme}.png`);

    await sheet.getByRole('button', { name: 'Done' }).click();
    await expect(sheet).not.toHaveClass(/is-open/);
    await expect(
      page.getByRole('button', { name: 'Bulk Actions', exact: true }),
    ).toBeFocused();
  });
}

test('shows a 410 expired preview inside Review', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 990 });
  await mockApi(page, { targetsStatus: 410 });
  await openDevices(page);
  const sheet = await openSheet(page);
  await fillDraft(page);
  await sheet.getByRole('button', { name: 'Save and preview' }).click();
  await expect(
    sheet.getByRole('heading', { name: 'Preview expired' }),
  ).toBeVisible();
  await expect(
    sheet.getByText('Prepare a new preview before confirming'),
  ).toBeVisible();
  await expect(
    sheet.getByRole('button', { name: 'Continue to confirmation' }),
  ).toHaveCount(0);
  await expectNoAxeViolations(page);
});

test('shows a 410 expired preview inside Confirm before approval', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 990 });
  await mockApi(page, { previewReadStatus: 410 });
  await openDevices(page);
  const sheet = await openSheet(page);
  await fillDraft(page);
  await savePreview(page);
  await sheet.getByRole('button', { name: 'Continue to confirmation' }).click();
  await expect(
    sheet.getByRole('heading', { name: 'Preview expired' }),
  ).toBeVisible();
  await expect(
    sheet.getByText('Prepare a new preview before confirming'),
  ).toBeVisible();
  await expect(
    sheet.getByRole('button', { name: 'Create update job' }),
  ).toHaveCount(0);
  await expect(sheet.locator('li.step.is-active')).toContainText('Confirm');
  await expectNoAxeViolations(page);
});

test('shows a 403 permission change when Confirm opens', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 990 });
  await mockApi(page, { previewReadStatus: 403 });
  await openDevices(page);
  const sheet = await openSheet(page);
  await fillDraft(page);
  await savePreview(page);
  await sheet.getByRole('button', { name: 'Continue to confirmation' }).click();
  await expect(
    sheet.getByRole('heading', { name: 'Update device is unavailable' }),
  ).toBeVisible();
  await expect(
    sheet.getByText('Your access does not permit this update'),
  ).toBeVisible();
  await expect(sheet.locator('li.step.is-active')).toContainText('Confirm');
  await expectNoAxeViolations(page);
});

test('shows the offline state when Confirm opens', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 990 });
  await mockApi(page, { abortPreviewRead: true });
  await openDevices(page);
  const sheet = await openSheet(page);
  await fillDraft(page);
  await savePreview(page);
  await sheet.getByRole('button', { name: 'Continue to confirmation' }).click();
  await expect(
    sheet.getByRole('heading', { name: 'Cannot reach Campus Commander' }),
  ).toBeVisible();
  await expect(
    sheet.getByText(
      'Campus Commander did not answer. Check the connection and retry.',
    ),
  ).toBeVisible();
  await expect(sheet.locator('li.step.is-active')).toContainText('Confirm');
  await expectNoAxeViolations(page);
});

test('shows a 403 permission change inside Confirm', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 990 });
  await mockApi(page, { confirmStatus: 403 });
  await openDevices(page);
  const sheet = await openSheet(page);
  await fillDraft(page);
  await savePreview(page);
  await continueToConfirm(page);
  await sheet.getByRole('checkbox').check();
  await sheet.getByRole('button', { name: 'Create update job' }).click();
  await expect(
    sheet.getByRole('heading', { name: 'Update device is unavailable' }),
  ).toBeVisible();
  await expect(
    sheet.getByText('Your access does not permit this update'),
  ).toBeVisible();
  await expect(sheet.getByRole('checkbox')).toHaveCount(0);
  await expectNoAxeViolations(page);
});

test('shows the offline state inside Edit and keeps the draft', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 990 });
  await mockApi(page, { abortPreview: true });
  await openDevices(page);
  const sheet = await openSheet(page);
  await fillDraft(page);
  await sheet.getByRole('button', { name: 'Save and preview' }).click();
  await expect(
    sheet.getByRole('heading', { name: 'Cannot reach Campus Commander' }),
  ).toBeVisible();
  await expect(
    sheet.getByText(
      'Your draft stays in this tab. Reconnect before you prepare a preview.',
    ),
  ).toBeVisible();
  await expect(
    sheet
      .locator('.field-block[data-field="annotatedLocation"]')
      .getByLabel('New value'),
  ).toHaveValue('North lab');
  await expectNoAxeViolations(page);
});

test('fills a 320 px window as a modal sheet and keeps focus inside', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await mockApi(page);
  await openDevices(page);
  const sheet = await openSheet(page);

  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  const box = await sheet.boundingBox();
  expect(box).not.toBeNull();
  expect(Math.round(box!.width)).toBe(320);
  expect(Math.round(box!.x)).toBe(0);
  await expect(sheet).toHaveAttribute('aria-modal', 'true');
  await expect(
    page.getByRole('dialog', { name: 'Update 6 devices' }),
  ).toBeVisible();

  await page.keyboard.press('Tab');
  expect(
    await page.evaluate(
      () => document.activeElement?.closest('.bulk-sheet') !== null,
    ),
  ).toBe(true);
  for (let index = 0; index < 8; index++) {
    await page.keyboard.press('Tab');
    expect(
      await page.evaluate(
        () => document.activeElement?.closest('.bulk-sheet') !== null,
      ),
    ).toBe(true);
  }
  await page.keyboard.press('Shift+Tab');
  expect(
    await page.evaluate(
      () => document.activeElement?.closest('.bulk-sheet') !== null,
    ),
  ).toBe(true);
  await expectNoAxeViolations(page);
});

test('shows the modal sheet at 375 px without overflow', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await mockApi(page);
  await openDevices(page);
  await openSheet(page);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await screenshot(page, 'sheet-modal-375.png');
});

test('does not slide with reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 990 });
  await mockApi(page);
  await openDevices(page);
  await openSheet(page);
  const duration = await page
    .locator('app-device-update-sheet .bulk-sheet')
    .evaluate((element) => getComputedStyle(element).transitionDuration);
  expect(parseFloat(duration)).toBeLessThan(0.001);
});

/** The retained record of one confirmation in this tab. */
const confirmationKey = `cc.device-update-confirmation.aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.${previewId}`;

function countPreviewPosts(page: Page): () => number {
  let posts = 0;
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      new URL(request.url()).pathname === '/api/devices/updates/previews'
    )
      posts++;
  });
  return () => posts;
}

test('keeps an unresolved update confirmation across a reload and opens its receipt', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 990 });
  await mockApi(page, {
    confirmAnswers: ['lost', 'connection-required', 'accepted'],
  });
  const previewPosts = countPreviewPosts(page);
  const stored = () =>
    page.evaluate((key) => sessionStorage.getItem(key), confirmationKey);
  await openDevices(page);
  let sheet = await openSheet(page);
  await fillDraft(page);
  await savePreview(page);
  await continueToConfirm(page);
  await sheet.getByRole('checkbox').check();
  await sheet.getByRole('button', { name: 'Create update job' }).click();
  await expect(
    sheet.getByRole('heading', {
      level: 1,
      name: 'The confirmation did not finish',
    }),
  ).toBeVisible();
  expect(JSON.parse((await stored()) ?? '{}')).toEqual({
    previewId,
    manifestDigest: 'a'.repeat(64),
  });
  expect(previewPosts()).toBe(1);

  // The same tab reloads. The draft and the record stay.
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Devices', exact: true }),
  ).toBeVisible();
  sheet = await openSheet(page);
  await sheet.getByRole('button', { name: 'Save and preview' }).click();
  await expect(
    sheet.getByRole('heading', { level: 1, name: 'The update job may exist' }),
  ).toBeVisible();
  await expect(sheet.getByText('The receipt is unavailable')).toBeVisible();
  await expect(sheet.getByText('Check Jobs for the update job')).toBeVisible();
  expect(JSON.parse((await stored()) ?? '{}')).toEqual({
    previewId,
    manifestDigest: 'a'.repeat(64),
  });
  // The unresolved replay prepared no replacement preview.
  expect(previewPosts()).toBe(1);
  await expectNoAxeViolations(page);
  await page.waitForTimeout(300);
  await screenshot(page, 'sheet-replay-receipt-unavailable-light.png');

  // A closure keeps the record. The next replay answers the receipt.
  await sheet.getByRole('button', { name: 'Close' }).click();
  await expect(sheet).not.toHaveClass(/is-open/);
  sheet = await openSheet(page);
  await sheet.getByRole('button', { name: 'Save and preview' }).click();
  await expect(
    sheet.getByRole('heading', { name: 'Update job created' }),
  ).toBeVisible();
  await expect(sheet.getByText('Job UPD-006 · Running')).toBeVisible();
  expect(await stored()).toBeNull();
  expect(previewPosts()).toBe(1);
});

test('keeps an unresolved confirmation when the recovery prepares a new preview', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 990 });
  await mockApi(page, {
    targetsStatus: 410,
    confirmAnswers: ['preview-changed'],
  });
  const previewPosts = countPreviewPosts(page);
  await openDevices(page);
  const sheet = await openSheet(page);
  await fillDraft(page);
  await sheet.getByRole('button', { name: 'Save and preview' }).click();
  await expect(
    sheet.getByRole('heading', { name: 'Preview expired' }),
  ).toBeVisible();
  await page.evaluate(
    ({ key, record }) => sessionStorage.setItem(key, JSON.stringify(record)),
    {
      key: confirmationKey,
      record: { previewId, manifestDigest: 'a'.repeat(64) },
    },
  );
  expect(previewPosts()).toBe(1);

  await sheet.getByRole('button', { name: 'Prepare new preview' }).click();
  await expect(
    sheet.getByRole('heading', { level: 1, name: 'The update job may exist' }),
  ).toBeVisible();
  await expect(
    sheet.getByText('Review the Jobs page before you prepare another preview.'),
  ).toBeVisible();
  // The recovery answer kept the record and started no preview.
  expect(previewPosts()).toBe(1);
  expect(
    await page.evaluate((key) => sessionStorage.getItem(key), confirmationKey),
  ).not.toBeNull();
  await expectNoAxeViolations(page);
});

test('clears a retained confirmation that a 410 expires and prepares the preview', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 990 });
  await mockApi(page, { confirmAnswers: ['preview-expired'] });
  const previewPosts = countPreviewPosts(page);
  await openDevices(page);
  await page.evaluate(
    ({ key, record }) => sessionStorage.setItem(key, JSON.stringify(record)),
    {
      key: confirmationKey,
      record: { previewId, manifestDigest: 'a'.repeat(64) },
    },
  );
  const sheet = await openSheet(page);
  await fillDraft(page);
  await savePreview(page);
  await expect(
    sheet.getByRole('heading', { name: 'Review 6 device updates' }),
  ).toBeVisible();
  expect(previewPosts()).toBe(1);
  expect(
    await page.evaluate((key) => sessionStorage.getItem(key), confirmationKey),
  ).toBeNull();
});

test('clears a retained confirmation when the replay answers connection-changed', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 990 });
  await mockApi(page, { confirmAnswers: ['connection-changed'] });
  const previewPosts = countPreviewPosts(page);
  await openDevices(page);
  await page.evaluate(
    ({ key, record }) => sessionStorage.setItem(key, JSON.stringify(record)),
    {
      key: confirmationKey,
      record: { previewId, manifestDigest: 'a'.repeat(64) },
    },
  );
  const sheet = await openSheet(page);
  await fillDraft(page);
  await sheet.getByRole('button', { name: 'Save and preview' }).click();
  await expect(
    sheet.getByText(
      'The Google connection changed. Reconnect Google Workspace before you create the job.',
    ),
  ).toBeVisible();
  expect(previewPosts()).toBe(0);
  expect(
    await page.evaluate((key) => sessionStorage.getItem(key), confirmationKey),
  ).toBeNull();
});

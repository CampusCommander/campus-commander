import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const customerId = 'C0123456';
const observedAt = '2026-10-19T12:00:00.000Z';
const previewId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const nextPreviewId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const principal = '4f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10';
const grants = [
  { action: 'devices:read', scope: { kind: 'district', customerId } },
  { action: 'devices:write', scope: { kind: 'district', customerId } },
  { action: 'devices:bulk-actions', scope: { kind: 'district', customerId } },
  { action: 'jobs:read', scope: { kind: 'district', customerId } },
];

const preview = {
  previewId,
  displayId: 'PV-006',
  mode: 'replace',
  value: 'North lab',
  selected: 6,
  eligible: 6,
  unchanged: 0,
  excluded: 0,
  oldestObservedAt: '2026-10-19T10:00:00.000Z',
  stale: false,
  preparedAt: '2026-10-19T12:00:00.000Z',
  expiresAt: '2026-10-19T12:15:00.000Z',
  manifestDigest: 'a'.repeat(64),
};

const targets = Array.from({ length: 6 }, (_, index) => ({
  deviceId: `synthetic-device-${index + 1}`,
  serialNumber: `C0A1-7F2${index + 1}`,
  field: 'annotatedLocation',
  observedValue: 'Science wing',
  approvedValue: 'North lab',
  disposition: 'eligible',
  exclusionReason: null,
}));

const receipt = {
  jobId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  displayId: 'UPD-006',
  status: 'accepted',
  deviceCount: 6,
  updateCount: 6,
};

const job = {
  jobId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  displayId: 'UPD-006',
  revision: 1,
  action: 'update-device-annotations',
  status: 'accepted',
  scope: { kind: 'devices', deviceCount: 6 },
  requestedBy: { id: principal, displayName: 'District operator' },
  createdAt: observedAt,
  startedAt: null,
  finishedAt: null,
  progress: {
    total: 6,
    succeeded: 0,
    failed: 0,
    unknown: 0,
    skipped: 0,
    pending: 6,
  },
  failure: null,
  confirmedBy: { id: principal, displayName: 'District operator' },
  previewDisplayId: 'PV-006',
  field: 'annotatedLocation',
  mode: 'replace',
  requestedValue: 'North lab',
  targetOrgUnitPaths: ['/School A'],
  correlationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  latestActivity: {
    at: observedAt,
    failed: { count: 0, operations: [] },
    unknown: { count: 0, operations: [] },
  },
};

/**
 * The draft page, the preview, the confirmation, and the receipt need the session,
 * the selection, the write access state, and the job reads.
 */
async function mockApi(
  page: Page,
  options: { expired?: boolean; lostConfirmation?: boolean } = {},
) {
  let previewReads = 0;
  let confirmations = 0;
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
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
            id: principal,
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
    if (path === '/api/devices/selection')
      return route.fulfill({
        json: {
          selection: {
            terms: [],
            groups: [],
            added: 6,
            excluded: 0,
            selectedCount: 6,
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
            deviceCount: 6,
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
          page: {
            rows: [],
            matching: 0,
            total: 0,
            observedAt,
            refreshJobId: null,
          },
        },
      });
    if (path === '/api/devices/freshness')
      return route.fulfill({
        json: { freshness: { stale: 0, refreshing: false } },
      });
    if (path === '/api/devices/org-units')
      return route.fulfill({ json: { orgUnits: [] } });
    if (path === '/api/devices/events')
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
    if (path === '/api/devices/updates/previews' && method === 'POST')
      return route.fulfill({
        status: 201,
        json: options.expired
          ? {
              ...preview,
              previewId: nextPreviewId,
              displayId: 'PV-007',
              preparedAt: '2026-10-19T12:20:00.000Z',
              expiresAt: '2026-10-19T12:35:00.000Z',
              manifestDigest: 'b'.repeat(64),
            }
          : preview,
      });
    if (
      path === `/api/devices/updates/previews/${previewId}/targets` ||
      path === `/api/devices/updates/previews/${nextPreviewId}/targets`
    )
      return route.fulfill({ json: { targets, nextCursor: null } });
    if (path === `/api/devices/updates/previews/${previewId}/confirm`) {
      if (options.lostConfirmation) {
        confirmations += 1;
        if (confirmations === 1) return route.abort('failed');
        return route.fulfill({ status: 200, json: receipt });
      }
      return route.fulfill({ status: 201, json: receipt });
    }
    if (path === `/api/devices/updates/previews/${previewId}`) {
      previewReads += 1;
      if (options.expired || (options.lostConfirmation && previewReads > 1))
        return route.fulfill({
          status: 410,
          json: {
            reason: 'preview-expired',
            expiresAt: '2026-10-19T12:15:00.000Z',
          },
        });
      return route.fulfill({ json: preview });
    }
    if (path === `/api/devices/updates/previews/${nextPreviewId}`)
      return route.fulfill({
        json: {
          ...preview,
          previewId: nextPreviewId,
          displayId: 'PV-007',
        },
      });
    if (path === '/api/jobs/UPD-006') return route.fulfill({ json: job });
    if (path === '/api/customer')
      return route.fulfill({ json: { customer: null } });
    if (path === '/api/google-connection')
      return route.fulfill({ json: { connection: null } });
    if (path === '/api/google-connection/health')
      return route.fulfill({ json: { health: null } });
    if (path === '/api/auth/preferences')
      return route.fulfill({ json: request.postDataJSON() });
    return route.fulfill({ status: 404, json: {} });
  });
}

test('creates an update job from the draft through the receipt', async ({
  page,
}, testInfo) => {
  await mockApi(page);
  await page.goto('/devices/update');
  await expect(
    page.getByRole('heading', { name: 'Update 6 devices', exact: true }),
  ).toBeVisible();
  await page.getByLabel('Annotated location').fill('North lab');
  await page.getByRole('button', { name: 'Save and preview' }).click();

  await expect(
    page.getByRole('heading', { name: 'Review 6 device updates', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('6 devices · 6 field changes · 0 excluded', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText(
      'Targets and final values are frozen. New matching devices will not join this job.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByText('Preview PV-006', { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole('row')).toHaveCount(7);
  await expect(
    page.getByRole('cell', { name: 'North lab' }).first(),
  ).toBeVisible();

  await page.setViewportSize({ width: 1280, height: 960 });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: testInfo.outputPath('device-update-preview.png'),
    fullPage: true,
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.setViewportSize({ width: 320, height: 800 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 1280, height: 960 });

  await page.getByRole('button', { name: 'Continue to confirmation' }).click();
  await expect(
    page.getByRole('heading', {
      name: 'Confirm 6 device updates',
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText(
      'Annotated location changes from Science wing to North lab. Other fields remain unchanged.',
      { exact: true },
    ),
  ).toBeVisible();
  const create = page.getByRole('button', { name: 'Create update job' });
  await expect(create).toBeDisabled();
  await expect(
    page.getByRole('checkbox', {
      name: 'I reviewed all 6 devices and their final values.',
    }),
  ).not.toBeChecked();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: testInfo.outputPath('device-update-confirm.png'),
    fullPage: true,
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  const ack = page.getByRole('checkbox', {
    name: 'I reviewed all 6 devices and their final values.',
  });
  await ack.focus();
  await page.keyboard.press('Space');
  await expect(ack).toBeChecked();
  await expect(create).toBeEnabled();
  await create.focus();
  await page.keyboard.press('Enter');

  await expect(
    page.getByRole('heading', { name: 'Update job created', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Job UPD-006 · Accepted', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      '6 devices · 6 annotated-location updates. Google changes have not completed.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Jobs', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(
    page.getByRole('button', { name: 'Back to devices' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'View job' })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: testInfo.outputPath('job-receipt.png'),
    fullPage: true,
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await page.getByRole('button', { name: 'Choose theme' }).click();
  await page.getByRole('menuitem', { name: 'Use dark theme' }).click();
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: testInfo.outputPath('job-receipt-dark.png'),
    fullPage: true,
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await page.setViewportSize({ width: 320, height: 800 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test('replays an uncertain confirmation and opens its receipt', async ({
  page,
}, testInfo) => {
  await mockApi(page, { lostConfirmation: true });
  await page.goto(`/devices/update/previews/${previewId}/confirm`);
  await expect(
    page.getByRole('heading', {
      name: 'Confirm 6 device updates',
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole('checkbox', {
      name: 'I reviewed all 6 devices and their final values.',
    })
    .check();
  await page.getByRole('button', { name: 'Create update job' }).click();

  await expect(
    page.getByRole('heading', {
      name: 'The confirmation did not finish',
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText('The result is unknown', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Prepare new preview' }),
  ).toHaveCount(0);
  await expect(page.getByText('No job created', { exact: false })).toHaveCount(
    0,
  );

  // A reload keeps the submitted confirmation instead of reading the expired preview.
  await page.reload();
  await expect(
    page.getByRole('heading', {
      name: 'The confirmation did not finish',
      exact: true,
    }),
  ).toBeVisible();

  await page.setViewportSize({ width: 1280, height: 960 });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: testInfo.outputPath('device-update-confirm-uncertain.png'),
    fullPage: true,
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(
    page.getByRole('heading', { name: 'Update job created', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Job UPD-006 · Accepted', { exact: true }),
  ).toBeVisible();
});

test('keeps the draft when the preview expired and prepares a new preview', async ({
  page,
}, testInfo) => {
  await mockApi(page, { expired: true });
  await page.goto('/devices/update');
  await page.getByLabel('Annotated location').fill('North lab');
  await page.goto(`/devices/update/previews/${previewId}`);
  await expect(
    page.getByRole('heading', { name: 'Preview expired', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Draft preserved · No job created', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', {
      name: 'Prepare a new preview before confirming',
      exact: true,
    }),
  ).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 960 });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: testInfo.outputPath('device-update-preview-expired.png'),
    fullPage: true,
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await page.getByRole('button', { name: 'Prepare new preview' }).click();
  await expect(
    page.getByRole('heading', { name: 'Review 6 device updates', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Preview PV-007', { exact: false }),
  ).toBeVisible();
});

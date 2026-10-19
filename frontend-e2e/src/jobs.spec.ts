import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const customerId = 'C0123456';
const observedAt = '2026-10-19T12:00:00.000Z';
const maya = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  displayName: 'Maya Chen',
};
const alex = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  displayName: 'Alex Rivera',
};

const running = {
  jobId: '0f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10',
  displayId: 'UPD-014',
  revision: 3,
  action: 'update-device-annotations',
  status: 'running',
  scope: { kind: 'devices', deviceCount: 48 },
  requestedBy: maya,
  createdAt: '2026-10-19T12:00:00.000Z',
  startedAt: '2026-10-19T12:00:00.000Z',
  finishedAt: null,
  progress: {
    total: 48,
    succeeded: 36,
    failed: 0,
    unknown: 0,
    skipped: 0,
    pending: 12,
  },
  failure: null,
};

const refreshed = {
  jobId: '1f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10',
  displayId: 'REF-004',
  revision: 2,
  action: 'refresh-inventory',
  status: 'completed',
  scope: { kind: 'all-devices', deviceCount: null },
  requestedBy: alex,
  createdAt: '2026-10-19T11:40:00.000Z',
  startedAt: '2026-10-19T11:41:00.000Z',
  finishedAt: '2026-10-19T11:41:42.000Z',
  progress: {
    total: null,
    succeeded: 128,
    failed: 0,
    unknown: 0,
    skipped: 0,
    pending: null,
  },
  failure: null,
};

const review = {
  jobId: '2f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10',
  displayId: 'UPD-006',
  revision: 4,
  action: 'update-device-annotations',
  status: 'needs-review',
  scope: { kind: 'devices', deviceCount: 6 },
  requestedBy: alex,
  createdAt: '2026-10-19T10:15:00.000Z',
  startedAt: '2026-10-19T10:16:00.000Z',
  finishedAt: '2026-10-19T10:19:00.000Z',
  progress: {
    total: 6,
    succeeded: 4,
    failed: 1,
    unknown: 1,
    skipped: 0,
    pending: 0,
  },
  failure: null,
};

const secondPage = {
  ...refreshed,
  jobId: '3f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10',
  displayId: 'REF-009',
  createdAt: '2026-10-18T09:00:00.000Z',
  startedAt: '2026-10-18T09:01:00.000Z',
  finishedAt: '2026-10-18T09:03:00.000Z',
};

const allJobs = [running, refreshed, review];
/** Fifty rows let the page-2 footer check the API page size. */
const manyJobs = Array.from({ length: 50 }, (_, index) => ({
  ...review,
  jobId: `9f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d${String(index).padStart(4, '0')}`,
  displayId: `UPD-${100 + index}`,
  revision: 1,
}));

/**
 * The Jobs page reads the list, opens the event stream, and can load requesters.
 * A failed read switches the page to stale or offline.
 */
async function signIn(
  page: Page,
  options: {
    empty?: boolean;
    many?: boolean;
    delay?: number;
    grants?: string[];
    fail?: 'none' | 'http' | 'abort';
  } = {},
) {
  const state = { fail: options.fail ?? 'none' };
  const grants = options.grants ?? [
    'jobs:read',
    'devices:read',
    'devices:write',
  ];
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
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
            id: maya.id,
            displayName: 'District operator',
            permissionVersion: 1,
            permissions: [],
            grants: grants.map((action) => ({
              action,
              scope: { kind: 'district', customerId },
            })),
            preferences: { theme: 'light', navigationCollapsed: false },
          },
          csrfToken: 'a'.repeat(64),
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        },
      });
    if (path === '/api/jobs/events')
      return route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: '',
      });
    if (path === '/api/jobs/requesters')
      return route.fulfill({ json: { requesters: [maya, alex] } });
    if (path === '/api/jobs') {
      if (options.delay)
        await new Promise((resolve) => setTimeout(resolve, options.delay));
      if (state.fail === 'http') return route.fulfill({ status: 500 });
      if (state.fail === 'abort') return route.abort();
      const cursor = url.searchParams.get('cursor');
      const jobId = url.searchParams.get('jobId');
      const status = url.searchParams.get('status');
      if (options.empty)
        return route.fulfill({
          json: { jobs: [], matching: 0, nextCursor: null, observedAt },
        });
      const matching = allJobs.filter(
        (job) =>
          (!jobId || job.displayId === jobId) &&
          (!status || status.split(',').includes(job.status)),
      );
      const rows = cursor ? [secondPage] : options.many ? manyJobs : matching;
      return route.fulfill({
        json: {
          jobs: rows,
          matching: cursor ? 51 : options.many ? 51 : matching.length,
          nextCursor: cursor ? null : matching.length ? 'cursor-2' : null,
          observedAt,
        },
      });
    }
    if (path === '/api/customer')
      return route.fulfill({ json: { customer: null } });
    return route.fulfill({ json: {} });
  });
  return state;
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
});

test('shows the loading state while the first read is pending', async ({
  page,
}) => {
  await signIn(page, { delay: 1200 });
  await page.goto('/jobs');
  await expect(
    page.getByRole('heading', { name: 'Loading jobs', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Retrieving job status and operation counts.'),
  ).toBeVisible();
  await expect(page.getByText('Loading job count')).toBeVisible();
  await expect(page.getByText('UPD-014')).toBeVisible({ timeout: 5000 });
});

test('shows the unavailable state when the first read fails', async ({
  page,
}, testInfo) => {
  await signIn(page, { fail: 'http' });
  await page.goto('/jobs');
  await expect(page.getByRole('alert')).toHaveText(
    'Job status is unavailable.',
  );
  await expect(page.getByText('0 jobs', { exact: false })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: testInfo.outputPath('jobs-unavailable.png'),
    fullPage: true,
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('renders the Jobs grid, footer, and every job state', async ({
  page,
}, testInfo) => {
  await signIn(page);
  await page.goto('/jobs');
  await expect(
    page.getByRole('heading', { name: 'Jobs', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      'District activity · Updates, commands, imports and exports',
    ),
  ).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Job' })).toBeVisible();
  await expect(
    page.getByRole('columnheader', { name: 'Created' }),
  ).toHaveAttribute('aria-sort', 'descending');
  await expect(page.getByRole('cell', { name: /UPD-014/ })).toBeVisible();
  await expect(page.getByRole('cell', { name: /REF-004/ })).toBeVisible();
  await expect(page.getByRole('cell', { name: /UPD-006/ })).toBeVisible();
  await expect(page.getByText('36 of 48 complete')).toBeVisible();
  await expect(page.getByText('12 pending')).toBeVisible();
  await expect(page.getByText('128 devices read')).toBeVisible();
  await expect(page.getByText('4 succeeded')).toBeVisible();
  await expect(page.getByText('1 failed · 1 unknown')).toBeVisible();
  await expect(page.getByText('Running', { exact: true })).toBeVisible();
  await expect(page.getByText('Completed', { exact: true })).toBeVisible();
  await expect(page.getByText('Needs review', { exact: true })).toBeVisible();
  await expect(page.getByText('Rows 1–3 of 3')).toBeVisible();
  await expect(page.getByText('3 jobs', { exact: false })).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Open details for job UPD-014' }),
  ).toHaveAttribute('href', '/jobs/UPD-014');

  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: testInfo.outputPath('jobs-grid.png'),
    fullPage: true,
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await page.getByRole('button', { name: 'Choose theme' }).click();
  await page.getByRole('menuitem', { name: 'Use dark theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('.cdk-overlay-container > *')).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: testInfo.outputPath('jobs-grid-dark.png'),
    fullPage: true,
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await page.setViewportSize({ width: 320, height: 800 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath('jobs-grid-320.png'),
    fullPage: true,
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('filters by status, edits the chip, and clears the filter', async ({
  page,
}, testInfo) => {
  await signIn(page);
  await page.goto('/jobs');
  await expect(page.getByText('UPD-014')).toBeVisible();

  await page.getByRole('button', { name: 'Add a filter' }).click();
  await page.getByRole('option', { name: 'Status', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Running' }).check();
  await page.getByRole('button', { name: 'Apply' }).click();

  await expect(
    page.getByRole('button', { name: 'Status: Running', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('cell', { name: /REF-004/ })).toHaveCount(0);
  await expect(page.getByText('1 matching job')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: testInfo.outputPath('jobs-filtered.png'),
    fullPage: true,
  });

  await page
    .getByRole('button', { name: 'Status: Running', exact: true })
    .click();
  await page.getByRole('checkbox', { name: 'Completed', exact: true }).check();
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(
    page.getByRole('button', {
      name: 'Status: Running, Completed',
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByRole('cell', { name: /UPD-014/ })).toBeVisible();
  await expect(page.getByRole('cell', { name: /REF-004/ })).toBeVisible();
  await expect(page.getByRole('cell', { name: /UPD-006/ })).toHaveCount(0);

  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page.getByRole('cell', { name: /UPD-014/ })).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('shows no matches and restores rows with Clear filters', async ({
  page,
}, testInfo) => {
  await signIn(page);
  await page.goto('/jobs');
  await expect(page.getByText('UPD-014')).toBeVisible();

  await page.getByRole('button', { name: 'Add a filter' }).click();
  await page.getByRole('option', { name: 'Job ID', exact: true }).click();
  await page.getByRole('textbox', { name: 'Job ID' }).fill('UPD-999');
  await page.getByRole('button', { name: 'Apply' }).click();

  await expect(
    page.getByRole('heading', { name: 'No jobs match these filters' }),
  ).toBeVisible();
  await expect(page.getByText('0 matching jobs')).toBeVisible();
  await expect(page.getByText('0 rows')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: testInfo.outputPath('jobs-no-matches.png'),
    fullPage: true,
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await page.getByRole('button', { name: 'Clear filters' }).first().click();
  await expect(page.getByRole('cell', { name: /UPD-014/ })).toBeVisible();
});

test('shows no jobs yet with Open Devices', async ({ page }, testInfo) => {
  await signIn(page, { empty: true });
  await page.goto('/jobs');
  await expect(
    page.getByRole('heading', { name: 'No jobs yet' }),
  ).toBeVisible();
  await expect(
    page.getByText(
      'Submitted updates, commands, imports, and exports will appear here.',
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Open Devices' }),
  ).toHaveAttribute('href', '/devices');
  await expect(page.getByText('0 jobs', { exact: false })).toBeVisible();
  await expect(page.getByText('0 rows')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: testInfo.outputPath('jobs-no-jobs.png'),
    fullPage: true,
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('keeps the last received rows visible offline', async ({
  page,
}, testInfo) => {
  const state = await signIn(page);
  await page.goto('/jobs');
  await expect(page.getByText('UPD-014')).toBeVisible();

  state.fail = 'abort';
  await page
    .locator('.actions')
    .getByRole('button', { name: 'Refresh' })
    .click();
  await expect(
    page.getByRole('heading', {
      name: 'Offline · Showing the last received job state',
    }),
  ).toBeVisible();
  await expect(
    page.getByText(
      'Reconnect to receive current outcomes. Existing jobs continue on the server.',
    ),
  ).toBeVisible();
  await expect(page.getByText(/Last received/)).toBeVisible();
  await expect(page.getByRole('cell', { name: /UPD-014/ })).toBeVisible();
  await expect(
    page.locator('.actions').getByRole('button', { name: 'Refresh' }),
  ).toBeDisabled();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: testInfo.outputPath('jobs-offline.png'),
    fullPage: true,
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('marks rows stale after a failed refresh and rereads', async ({
  page,
}) => {
  const state = await signIn(page);
  await page.goto('/jobs');
  await expect(page.getByText('UPD-014')).toBeVisible();

  state.fail = 'http';
  await page
    .locator('.actions')
    .getByRole('button', { name: 'Refresh' })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Job state is stale' }),
  ).toBeVisible();
  await expect(page.getByText('UPD-014')).toBeVisible();

  state.fail = 'none';
  await page.getByRole('button', { name: 'Refresh' }).last().click();
  await expect(
    page.getByRole('heading', { name: 'Job state is stale' }),
  ).toHaveCount(0);
});

test('pages with the API cursor and back', async ({ page }) => {
  await signIn(page, { many: true });
  await page.goto('/jobs');
  await expect(page.getByText('UPD-100', { exact: true })).toBeVisible();
  await expect(page.getByText('Rows 1–50 of 51')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Previous page' }),
  ).toBeDisabled();

  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(page.getByRole('cell', { name: /REF-009/ })).toBeVisible();
  await expect(page.getByText('UPD-100', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Rows 51–51 of 51')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Previous page' }),
  ).toBeEnabled();

  await page.getByRole('button', { name: 'Previous page' }).click();
  await expect(page.getByText('UPD-100', { exact: true })).toBeVisible();
  await expect(page.getByText('Rows 1–50 of 51')).toBeVisible();
});

test('shows Jobs to a jobs:read holder and hides Devices', async ({ page }) => {
  await signIn(page, { grants: ['jobs:read'] });
  await page.goto('/jobs');
  await expect(
    page.getByRole('heading', { name: 'Jobs', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Jobs' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Devices' })).toHaveCount(0);
});

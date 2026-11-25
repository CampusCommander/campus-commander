import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { installLiveStreams } from './live-streams';

const customerId = 'C0123456';
const person = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  displayName: 'District Admin',
};

const observedAt = '2026-11-25T15:00:00.000Z';

/** The category job of an edit with a rename and a removal (S2 item 1, CA state 07). */
const categorySummary = {
  jobId: '1a2b3c4d-0000-4000-8000-000000000014',
  displayId: 'CAT-014',
  revision: 6,
  action: 'edit-category',
  status: 'completed',
  entityType: 'user',
  scope: { kind: 'devices', deviceCount: 1 },
  category: { scopeName: 'School Devices' },
  requestedBy: person,
  createdAt: '2026-11-25T14:40:00.000Z',
  startedAt: '2026-11-25T14:40:01.000Z',
  finishedAt: '2026-11-25T14:40:09.000Z',
  progress: {
    total: 1,
    succeeded: 1,
    failed: 0,
    unknown: 0,
    skipped: 0,
    expired: 0,
    cancelled: 0,
    pending: 0,
  },
  cancelRequest: null,
  failure: null,
  phase: null,
  exportSummary: null,
  importSummary: null,
};

/** The value job of 18 users with two failures (UM state 10). */
const valueSummary = {
  jobId: '2b3c4d5e-0000-4000-8000-000000000003',
  displayId: 'UAT-003',
  revision: 9,
  action: 'set-attributes',
  status: 'completed-with-errors',
  entityType: 'user',
  scope: { kind: 'devices', deviceCount: 18 },
  requestedBy: person,
  createdAt: '2026-11-25T14:41:00.000Z',
  startedAt: '2026-11-25T14:41:02.000Z',
  finishedAt: '2026-11-25T14:43:20.000Z',
  progress: {
    total: 18,
    succeeded: 16,
    failed: 2,
    unknown: 0,
    skipped: 0,
    expired: 0,
    cancelled: 0,
    pending: 0,
  },
  cancelRequest: null,
  failure: null,
  phase: null,
  exportSummary: null,
  importSummary: null,
};

/** The two result rows of the edit: a rename and a removal. */
const categoryRows = [
  {
    change: 'rename',
    displayName: 'Grade',
    fieldType: null,
    range: null,
    holders: null,
    previousName: 'Year',
    outcome: 'succeeded',
  },
  {
    change: 'removed',
    displayName: 'Asset tag',
    fieldType: 'STRING',
    range: null,
    holders: 3,
    previousName: null,
    outcome: 'succeeded',
  },
];

const categoryDetail = {
  ...categorySummary,
  confirmedBy: person,
  previewDisplayId: 'PV-014',
  changes: null,
  commandType: null,
  statusAction: null,
  deprovisionReason: null,
  targetOrgUnitPaths: null,
  correlationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  latestActivity: {
    at: '2026-11-25T14:40:09.000Z',
    failed: { count: 0, operations: [] },
    unknown: { count: 0, operations: [] },
  },
  exportFile: null,
  importSource: null,
  plan: null,
  importDisplayId: null,
  waitsForDisplayId: null,
  waitingDisplayIds: null,
  planJobs: null,
  executionCounts: null,
  category: {
    scopeName: 'School Devices',
    previousName: 'Year',
    rows: categoryRows,
    total: 2,
    nextCursor: null,
  },
};

const valueDetail = {
  ...valueSummary,
  confirmedBy: person,
  previewDisplayId: 'PV-003',
  changes: null,
  commandType: null,
  statusAction: null,
  deprovisionReason: null,
  targetOrgUnitPaths: null,
  correlationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  latestActivity: {
    at: '2026-11-25T14:43:20.000Z',
    failed: { count: 2, operations: [] },
    unknown: { count: 0, operations: [] },
  },
  exportFile: null,
  importSource: null,
  plan: null,
  importDisplayId: null,
  waitsForDisplayId: null,
  waitingDisplayIds: null,
  planJobs: null,
  executionCounts: null,
};

/** 18 users. The last two rows fail, so the Failed view holds two rows. */
const attributeRows = Array.from({ length: 18 }, (_, index) => {
  const failed = index >= 16;
  return {
    operation: index + 1,
    userId: `synthetic-user-${index + 1}`,
    userName: `Person ${index + 1}`,
    primaryEmail: `person${index + 1}@example.org`,
    attribute: 'attr:grade.name',
    displayName: 'Grade',
    currentValue: index % 3 === 0 ? null : `Grade ${index}`,
    newValue: 'Seven',
    outcome: failed ? 'failed' : 'succeeded',
    failureText: failed ? 'Grade is not a number.' : null,
  };
});

const allRows = attributeRows.slice(0, 10);
const secondRows = attributeRows.slice(10);
const failedRows = attributeRows.filter((row) => row.outcome === 'failed');

async function signIn(page: Page) {
  await installLiveStreams(page);
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
            id: person.id,
            displayName: person.displayName,
            permissionVersion: 1,
            permissions: [],
            grants: ['jobs:read', 'users:read', 'users:write'].map(
              (action) => ({
                action,
                scope: { kind: 'district', customerId },
              }),
            ),
            preferences: { theme: 'light', navigationCollapsed: false },
          },
          csrfToken: 'a'.repeat(64),
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        },
      });
    if (path === '/api/jobs/requesters')
      return route.fulfill({ json: { requesters: [person] } });
    if (path === '/api/jobs')
      return route.fulfill({
        json: {
          jobs: [categorySummary, valueSummary],
          matching: 2,
          nextCursor: null,
          observedAt,
        },
      });
    if (path === '/api/jobs/CAT-014')
      return route.fulfill({ json: categoryDetail });
    if (path === '/api/jobs/UAT-003')
      return route.fulfill({ json: valueDetail });
    if (path === '/api/jobs/UAT-003/attribute-rows') {
      const view = url.searchParams.get('view') ?? 'all';
      const cursor = url.searchParams.get('cursor');
      if (view === 'failed')
        return route.fulfill({
          json: {
            rows: failedRows,
            totals: { all: 18, failed: 2 },
            nextCursor: null,
          },
        });
      return route.fulfill({
        json: {
          rows: cursor ? secondRows : allRows,
          totals: { all: 18, failed: 2 },
          nextCursor: cursor ? null : '10:attr:grade.name',
        },
      });
    }
    if (path === '/api/customer')
      return route.fulfill({ json: { customer: null } });
    return route.fulfill({ json: {} });
  });
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
});

test('lists a category job and a value job with their own titles and scopes', async ({
  page,
}, testInfo) => {
  await signIn(page);
  await page.goto('/jobs');

  const categoryRow = page.getByRole('row', { name: /CAT-014/ });
  await expect(categoryRow).toContainText('Edit category');
  await expect(categoryRow).toContainText('School Devices');
  await expect(categoryRow).not.toContainText('1 user');

  const valueRow = page.getByRole('row', { name: /UAT-003/ });
  await expect(valueRow).toContainText('Set attributes');
  await expect(valueRow).toContainText('18 users');

  // The Actions filter offers the four new actions.
  await page.getByRole('button', { name: 'Add a filter' }).click();
  await page.getByRole('option', { name: 'Action', exact: true }).click();
  await expect(
    page.getByRole('checkbox', { name: 'Create category', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('checkbox', { name: 'Edit category', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('checkbox', { name: 'Delete category', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('checkbox', { name: 'Set attributes', exact: true }),
  ).toBeVisible();
  await page.keyboard.press('Escape');

  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: testInfo.outputPath('jobs-category-value.png'),
    fullPage: true,
  });
  await page.screenshot({
    path: testInfo.outputPath('jobs-category-value-1440x900.png'),
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('shows a category job with its title, its category, and the state 07 table', async ({
  page,
}, testInfo) => {
  await signIn(page);
  await page.goto('/jobs/CAT-014');

  await expect(
    page.getByRole('heading', { name: 'Edit category', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Job CAT-014 · Completed')).toBeVisible();
  await expect(
    page.getByRole('heading', {
      name: 'CAT-014 · School Devices',
      exact: true,
    }),
  ).toBeVisible();

  await expect(
    page.getByRole('columnheader', { name: 'Change', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('columnheader', { name: 'Attribute', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('columnheader', { name: 'Effect', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('columnheader', { name: 'Outcome', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('columnheader', { name: 'Device', exact: true }),
  ).toHaveCount(0);

  const rename = page.locator('.result-table tbody tr').first();
  await expect(rename).toContainText('Rename category');
  await expect(rename).toContainText('Year → Grade');
  await expect(rename).toContainText('No user values change');
  const removal = page.locator('.result-table tbody tr').nth(1);
  await expect(removal).toContainText('Remove attribute');
  await expect(removal).toContainText('Asset tag (Text)');
  await expect(removal).toContainText('Deletes its values on 3 users');
  await expect(page.getByText('Rows 1–2 of 2 changes')).toBeVisible();

  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: testInfo.outputPath('job-category.png'),
    fullPage: true,
  });
  await page.screenshot({
    path: testInfo.outputPath('job-category-1440x900.png'),
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  // The dark theme keeps the tokens of the table.
  await page.getByRole('button', { name: 'Choose theme' }).click();
  await page.getByRole('menuitem', { name: 'Use dark theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('.cdk-overlay-container > *')).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: testInfo.outputPath('job-category-dark.png'),
    fullPage: true,
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  // A narrow viewport keeps the page free of horizontal overflow.
  await page.setViewportSize({ width: 320, height: 800 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath('job-category-320.png'),
    fullPage: true,
  });
});

test('shows a value job with All and Failed, the totals, and a second page', async ({
  page,
}, testInfo) => {
  await signIn(page);
  await page.goto('/jobs/UAT-003');

  await expect(
    page.getByRole('heading', { name: 'Set attributes', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'UAT-003 · 18 users', exact: true }),
  ).toBeVisible();

  await expect(
    page.getByRole('columnheader', { name: 'User', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('columnheader', { name: 'Primary email', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('columnheader', { name: 'Current value', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('columnheader', { name: 'New value', exact: true }),
  ).toBeVisible();

  // The All view reads one page of ten rows and keeps the server total.
  await expect(page.locator('.result-table tbody tr')).toHaveCount(10);
  await expect(page.getByText('1–10 of 18 changes')).toBeVisible();
  const first = page.locator('.result-table tbody tr').first();
  await expect(first).toContainText('Person 1');
  await expect(first).toContainText('person1@example.org');
  await expect(first).toContainText('Not set');
  await expect(first).toContainText('Seven');

  // The approved state 10 user cell: the eye link opens the user details page.
  await expect(
    first.getByRole('link', { name: 'Open details for Person 1' }),
  ).toHaveAttribute('href', '/users/synthetic-user-1');

  // The approved comparison treatment: a muted italic Not set and an arrow before the new value.
  await expect(first.locator('td.val-current')).toHaveClass(/not-set/);
  const currentColor = await first
    .locator('td.val-current')
    .evaluate((cell) => getComputedStyle(cell).color);
  const secondaryColor = await page
    .locator('.footer-count')
    .evaluate((count) => getComputedStyle(count).color);
  expect(currentColor).toBe(secondaryColor);
  expect(
    await first
      .locator('td.val-current')
      .evaluate((cell) => getComputedStyle(cell).fontStyle),
  ).toBe('italic');
  await expect(first.locator('.val-new .material-symbols-outlined')).toHaveText(
    'arrow_forward',
  );
  expect(
    await first
      .locator('.val-new .material-symbols-outlined')
      .evaluate((arrow) => getComputedStyle(arrow).fontSize),
  ).toBe('16px');

  // The views join the table's bordered region.
  await expect(
    page.locator('.result-region .result-views .result-tabs'),
  ).toHaveCount(1);
  await expect(
    page.locator('.result-region .result-table.value-table'),
  ).toHaveCount(1);
  await expect(page.locator('.result-region .grid-footer')).toHaveCount(1);

  await page.getByRole('button', { name: 'Next results page' }).click();
  await expect(page.getByText('11–18 of 18 changes')).toBeVisible();
  await expect(page.locator('.result-table tbody tr')).toHaveCount(8);
  await expect(page.locator('.result-table tbody tr').first()).toContainText(
    'Person 11',
  );
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: testInfo.outputPath('job-value-all.png'),
    fullPage: true,
  });

  // Failed reads its own view from the first page and keeps its rows.
  await page.getByRole('tab', { name: /Failed/ }).click();
  await expect(page.getByText('1–2 of 2 changes')).toBeVisible();
  await expect(page.locator('.result-table tbody tr')).toHaveCount(2);
  const failedFirst = page.locator('.result-table tbody tr').first();
  await expect(failedFirst).toContainText('Grade is not a number.');
  await expect(
    failedFirst.getByRole('link', { name: 'Open details for Person 17' }),
  ).toHaveAttribute('href', '/users/synthetic-user-17');
  await expect(
    failedFirst.locator('.val-new .material-symbols-outlined'),
  ).toHaveText('arrow_forward');
  await expect(failedFirst.locator('td.val-current')).not.toHaveClass(
    /not-set/,
  );
  await expect(
    page.locator('.result-region .result-table.value-table'),
  ).toHaveCount(1);

  // The tab switch moves no page scroll and adds no horizontal overflow.
  expect(await page.evaluate(() => window.scrollX)).toBe(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);

  await page.evaluate(() => window.scrollTo(0, 0));
  // The ink bar of the tab strip settles before the capture.
  await page.waitForTimeout(400);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: testInfo.outputPath('job-value.png'),
    fullPage: true,
  });
  await page.screenshot({
    path: testInfo.outputPath('job-value-1440x900.png'),
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await page.setViewportSize({ width: 320, height: 800 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

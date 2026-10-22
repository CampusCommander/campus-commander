import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const customerId = 'C0123456';
const person = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  displayName: 'District Admin',
};
const alexId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/**
 * The operation rows of frame 104:209. Six rows fill one page.
 * The attention filter keeps the failed and unknown rows only.
 */
const operations = [
  {
    operationId: 'UPD-006-1',
    field: 'annotatedLocation',
    deviceId: 'synthetic-device-1',
    serialNumber: 'C0A1-7F2D',
    orgUnitPath: '/School A',
    operation: 'replace',
    baselineValue: 'Science wing',
    requestedValue: 'North lab',
    outcome: 'succeeded',
    outcomeReason: null,
    googleStatus: 200,
    googleReason: null,
    observedValue: 'North lab',
    verifiedBy: 'write-response',
    commandId: null,
    commandState: null,
    commandExpiresAt: null,
    commandExecutedAt: null,
    updatedAt: '2026-10-19T10:36:00.000Z',
  },
  {
    operationId: 'UPD-006-2',
    field: 'annotatedLocation',
    deviceId: 'synthetic-device-2',
    serialNumber: 'C0A1-7F31',
    orgUnitPath: '/School A',
    operation: 'replace',
    baselineValue: 'Science wing',
    requestedValue: 'North lab',
    outcome: 'succeeded',
    outcomeReason: null,
    googleStatus: 200,
    googleReason: null,
    observedValue: 'North lab',
    verifiedBy: 'write-response',
    commandId: null,
    commandState: null,
    commandExpiresAt: null,
    commandExecutedAt: null,
    updatedAt: '2026-10-19T10:36:00.000Z',
  },
  {
    operationId: 'UPD-006-3',
    field: 'annotatedLocation',
    deviceId: 'synthetic-device-3',
    serialNumber: 'C0A1-7F44',
    orgUnitPath: '/School A',
    operation: 'replace',
    baselineValue: 'Science wing',
    requestedValue: 'North lab',
    outcome: 'succeeded',
    outcomeReason: null,
    googleStatus: 200,
    googleReason: null,
    observedValue: 'North lab',
    verifiedBy: 'write-response',
    commandId: null,
    commandState: null,
    commandExpiresAt: null,
    commandExecutedAt: null,
    updatedAt: '2026-10-19T10:36:00.000Z',
  },
  {
    operationId: 'UPD-006-4',
    field: 'annotatedLocation',
    deviceId: 'synthetic-device-4',
    serialNumber: 'C0A1-7F62',
    orgUnitPath: '/School A',
    operation: 'replace',
    baselineValue: 'Science wing',
    requestedValue: 'North lab',
    outcome: 'succeeded',
    outcomeReason: null,
    googleStatus: 200,
    googleReason: null,
    observedValue: 'North lab',
    verifiedBy: 'write-response',
    commandId: null,
    commandState: null,
    commandExpiresAt: null,
    commandExecutedAt: null,
    updatedAt: '2026-10-19T10:36:00.000Z',
  },
  {
    operationId: 'UPD-006-5',
    field: 'annotatedLocation',
    deviceId: 'synthetic-device-5',
    serialNumber: 'C0A1-7F77',
    orgUnitPath: '/School A',
    operation: 'replace',
    baselineValue: 'Science wing',
    requestedValue: 'North lab',
    outcome: 'failed',
    outcomeReason: 'permission-denied',
    googleStatus: 403,
    googleReason: 'Forbidden',
    observedValue: null,
    verifiedBy: null,
    commandId: null,
    commandState: null,
    commandExpiresAt: null,
    commandExecutedAt: null,
    updatedAt: '2026-10-19T10:35:00.000Z',
  },
  {
    operationId: 'UPD-006-6',
    field: 'annotatedLocation',
    deviceId: 'synthetic-device-6',
    serialNumber: 'C0A1-7F84',
    orgUnitPath: '/School A',
    operation: 'replace',
    baselineValue: 'Science wing',
    requestedValue: 'North lab',
    outcome: 'unknown',
    outcomeReason: null,
    googleStatus: null,
    googleReason: null,
    observedValue: null,
    verifiedBy: null,
    commandId: null,
    commandState: null,
    commandExpiresAt: null,
    commandExecutedAt: null,
    updatedAt: '2026-10-19T10:36:00.000Z',
  },
];

/** The detail card of frame 104:209. */
const reviewJob = {
  jobId: '0f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10',
  displayId: 'UPD-006',
  revision: 4,
  action: 'update-device-annotations',
  status: 'needs-review',
  scope: { kind: 'devices', deviceCount: 6 },
  requestedBy: person,
  createdAt: '2026-10-19T10:31:00.000Z',
  startedAt: '2026-10-19T10:31:00.000Z',
  finishedAt: '2026-10-19T10:36:02.000Z',
  progress: {
    total: 6,
    succeeded: 4,
    failed: 1,
    unknown: 1,
    skipped: 0,
    expired: 0,
    pending: 0,
  },
  failure: null,
  confirmedBy: person,
  previewDisplayId: 'PV-006',
  changes: [{ field: 'annotatedLocation', mode: 'replace', value: 'North lab' }],
  commandType: null,
  statusAction: null,
  targetOrgUnitPaths: ['/School A'],
  correlationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  latestActivity: {
    at: '2026-10-19T10:36:00.000Z',
    failed: {
      count: 1,
      operations: [
        {
          operationId: 'UPD-006-5',
          deviceId: 'synthetic-device-5',
          serialNumber: 'C0A1-7F77',
          outcomeReason: 'permission-denied',
          googleStatus: 403,
          googleReason: 'Forbidden',
          updatedAt: '2026-10-19T10:35:00.000Z',
        },
      ],
    },
    unknown: {
      count: 1,
      operations: [
        {
          operationId: 'UPD-006-6',
          deviceId: 'synthetic-device-6',
          serialNumber: 'C0A1-7F84',
          updatedAt: '2026-10-19T10:36:00.000Z',
        },
      ],
    },
  },
};

/** The running job of frame 228:4524. */
const runningJob = {
  ...reviewJob,
  jobId: '1f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10',
  displayId: 'UPD-014',
  revision: 3,
  status: 'running',
  scope: { kind: 'devices', deviceCount: 48 },
  createdAt: '2026-10-19T10:40:00.000Z',
  startedAt: '2026-10-19T10:40:00.000Z',
  finishedAt: null,
  progress: {
    total: 48,
    succeeded: 36,
    failed: 0,
    unknown: 0,
    skipped: 0,
    expired: 0,
    pending: 12,
  },
  latestActivity: {
    at: '2026-10-19T10:42:08.000Z',
    failed: { count: 0, operations: [] },
    unknown: { count: 0, operations: [] },
  },
};

/** A refresh job holds no operations (design 2.5). */
const refreshJob = {
  jobId: '2f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10',
  displayId: 'REF-004',
  revision: 2,
  action: 'refresh-inventory',
  status: 'completed',
  scope: { kind: 'all-devices', deviceCount: null },
  requestedBy: person,
  createdAt: '2026-10-19T10:20:00.000Z',
  startedAt: '2026-10-19T10:21:00.000Z',
  finishedAt: '2026-10-19T10:21:42.000Z',
  progress: {
    total: null,
    succeeded: 128,
    failed: 0,
    unknown: 0,
    skipped: 0,
    expired: 0,
    pending: null,
  },
  failure: null,
  confirmedBy: null,
  previewDisplayId: null,
  changes: null,
  commandType: null,
  statusAction: null,
  targetOrgUnitPaths: null,
  correlationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  latestActivity: {
    at: '2026-10-19T10:21:42.000Z',
    failed: { count: 0, operations: [] },
    unknown: { count: 0, operations: [] },
  },
};

const runningOperations = operations.map((operation, index) => ({
  ...operation,
  operationId: `UPD-014-${index + 1}`,
  deviceId: `synthetic-device-${index + 1}`,
  outcome: 'succeeded',
  outcomeReason: null,
  googleStatus: 200,
  googleReason: null,
  observedValue: 'North lab',
  verifiedBy: 'write-response',
  updatedAt: '2026-10-19T10:42:08.000Z',
}));

async function signIn(page: Page) {
  const state = {
    reconcileStatus: 202,
    identity: 'district' as 'district' | 'alex',
    fail: false,
  };
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const grants =
      state.identity === 'alex'
        ? ['devices:read']
        : ['jobs:read', 'devices:read', 'devices:write'];
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
            id: state.identity === 'alex' ? alexId : person.id,
            displayName:
              state.identity === 'alex' ? 'Alex Rivera' : person.displayName,
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
    if (path === '/api/jobs/UPD-006')
      return state.fail
        ? route.fulfill({ status: 500 })
        : route.fulfill({ json: reviewJob });
    if (path === '/api/jobs/UPD-014')
      return route.fulfill({ json: runningJob });
    if (path === '/api/jobs/REF-004')
      return route.fulfill({ json: refreshJob });
    if (path === '/api/jobs/UPD-006/operations') {
      if (state.fail) return route.fulfill({ status: 500 });
      const attention = url.searchParams.get('attention') === 'true';
      return route.fulfill({
        json: {
          operations: attention
            ? operations.filter(
                (operation) =>
                  operation.outcome === 'failed' ||
                  operation.outcome === 'unknown',
              )
            : operations,
          nextCursor: null,
        },
      });
    }
    if (path === '/api/jobs/UPD-014/operations')
      return route.fulfill({
        json: {
          operations: runningOperations,
          nextCursor: url.searchParams.get('cursor') ? null : '6',
        },
      });
    if (path === '/api/jobs/REF-004/operations')
      return route.fulfill({ json: { operations: [], nextCursor: null } });
    if (path.endsWith('/reconcile'))
      return route.fulfill({
        status: state.reconcileStatus,
        json:
          state.reconcileStatus === 409 ? { reason: 'operation-settled' } : {},
      });
    if (path === '/api/customer')
      return route.fulfill({ json: { customer: null } });
    return route.fulfill({ json: {} });
  });
  return state;
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
});

test('renders the job of frame 104:209 with identity, counters, operations, and activity', async ({
  page,
}, testInfo) => {
  await signIn(page);
  await page.goto('/jobs/UPD-006');

  await expect(
    page.getByRole('heading', {
      name: 'Update device annotations',
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText('Job UPD-006 · Needs review')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'UPD-006 · 6 devices', exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/Requested by District Admin/)).toBeVisible();
  await expect(page.getByText('Duration: 5m 02s')).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Jobs', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(
    page.getByRole('link', { name: 'Back to jobs' }),
  ).toHaveAttribute('href', '/jobs');

  const counter = (label: string) =>
    page.locator('.counter').filter({ hasText: label });
  await expect(counter('Succeeded')).toContainText('4');
  await expect(counter('Failed')).toContainText('1');
  await expect(counter('Unknown')).toContainText('1');
  await expect(counter('Pending')).toContainText('0');
  await expect(counter('Skipped')).toContainText('0');
  await expect(counter('Cancelled')).toContainText('0');

  await expect(
    page.getByRole('columnheader', { name: 'Device', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('columnheader', { name: 'Operation', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('columnheader', { name: 'Before', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('columnheader', { name: 'Requested', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('columnheader', { name: 'Outcome', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('columnheader', { name: 'Updated', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.operations-table tbody tr')).toHaveCount(6);
  await expect(
    page.getByRole('link', { name: 'Open device C0A1-7F77' }),
  ).toHaveAttribute('href', '/devices/synthetic-device-5');
  await expect(page.getByText('Rows 1–6 of 6 operations')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Next operations page' }),
  ).toBeDisabled();
  await expect(
    page.locator('.activity p').getByText(/Permission failure on C0A1-7F77/),
  ).toBeVisible();
  await expect(
    page.locator('.activity p').getByText(/C0A1-7F84 requires reconciliation/),
  ).toBeVisible();

  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: testInfo.outputPath('job-detail-review.png'),
    fullPage: true,
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await page.getByRole('button', { name: 'Choose theme' }).click();
  await page.getByRole('menuitem', { name: 'Use dark theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('.cdk-overlay-container > *')).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: testInfo.outputPath('job-detail-review-dark.png'),
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
    path: testInfo.outputPath('job-detail-review-320.png'),
    fullPage: true,
  });
});

test('filters to the operations needing attention of frame 231:4707', async ({
  page,
}, testInfo) => {
  await signIn(page);
  await page.goto('/jobs/UPD-006');
  await expect(page.getByText('Rows 1–6 of 6 operations')).toBeVisible();

  await page.getByRole('button', { name: 'Show 2 needing attention' }).click();
  await expect(
    page.getByRole('button', { name: 'Show all operations' }),
  ).toBeVisible();
  await expect(page.locator('.operations-table tbody tr')).toHaveCount(2);
  await expect(page.getByText('2 matching operations · 6 total')).toBeVisible();
  await expect(page.getByRole('cell', { name: /C0A1-7F77/ })).toBeVisible();
  await expect(page.getByRole('cell', { name: /C0A1-7F84/ })).toBeVisible();
  await expect(
    page.locator('.counter').filter({ hasText: 'Succeeded' }),
  ).toContainText('4');

  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: testInfo.outputPath('job-detail-attention.png'),
    fullPage: true,
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await page.getByRole('button', { name: 'Show all operations' }).click();
  await expect(page.locator('.operations-table tbody tr')).toHaveCount(6);
  await expect(page.getByText('Rows 1–6 of 6 operations')).toBeVisible();
});

test('renders the running job of frame 228:4524 with its counter line', async ({
  page,
}, testInfo) => {
  await signIn(page);
  await page.goto('/jobs/UPD-014');

  await expect(
    page.getByRole('heading', { name: 'UPD-014 · 48 devices', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Job UPD-014 · Running')).toBeVisible();
  await expect(page.getByText('Rows 1–6 of 48 operations')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Next operations page' }),
  ).toBeEnabled();
  await expect(page.locator('.activity p')).toHaveText(
    /· 36 updates confirmed\. Twelve operations remain pending\.$/,
  );

  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: testInfo.outputPath('job-detail-running.png'),
    fullPage: true,
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await page.getByRole('button', { name: 'Next operations page' }).click();
  await expect(
    page.getByRole('button', { name: 'Previous operations page' }),
  ).toBeEnabled();
});

test('shows a refresh job with counters and Latest activity only', async ({
  page,
}, testInfo) => {
  await signIn(page);
  await page.goto('/jobs/REF-004');

  await expect(
    page.getByRole('heading', { name: 'Refresh inventory', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Job REF-004 · Completed')).toBeVisible();
  await expect(page.getByText('Operation results')).toHaveCount(0);
  await expect(page.locator('.activity p')).toContainText(
    '128 devices read. The refresh completed.',
  );
  await expect(
    page.locator('.counter').filter({ hasText: 'Succeeded' }),
  ).toContainText('128');
  await expect(
    page.locator('.counter').filter({ hasText: 'Pending' }),
  ).toContainText('—');

  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: testInfo.outputPath('job-detail-refresh.png'),
    fullPage: true,
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('records the row range on the last attention page', async ({
  page,
}, testInfo) => {
  await signIn(page);
  const failedOperation = (index: number) => ({
    ...operations[4],
    operationId: `UPD-006-${index}`,
    deviceId: `synthetic-device-${index}`,
    serialNumber: `C0A1-90${String(index).padStart(2, '0')}`,
  });
  const sevenFailed = Array.from({ length: 7 }, (_, index) =>
    failedOperation(index + 1),
  );
  await page.route('**/api/jobs/UPD-006', (route) =>
    route.fulfill({
      json: {
        ...reviewJob,
        scope: { kind: 'devices', deviceCount: 12 },
        progress: {
          total: 12,
          succeeded: 5,
          failed: 7,
          unknown: 0,
          skipped: 0,
          expired: 0,
          pending: 0,
        },
        latestActivity: {
          at: '2026-10-19T10:36:00.000Z',
          failed: { count: 7, operations: [] },
          unknown: { count: 0, operations: [] },
        },
      },
    }),
  );
  await page.route('**/api/jobs/UPD-006/operations*', (route) => {
    const url = new URL(route.request().url());
    const attention = url.searchParams.get('attention') === 'true';
    const cursor = url.searchParams.get('cursor');
    if (!attention)
      return route.fulfill({
        json: { operations, nextCursor: '6' },
      });
    return route.fulfill({
      json: cursor
        ? { operations: sevenFailed.slice(6), nextCursor: null }
        : { operations: sevenFailed.slice(0, 6), nextCursor: '6' },
    });
  });
  await page.goto('/jobs/UPD-006');
  await expect(page.getByText('Rows 1–6 of 12 operations')).toBeVisible();

  await page.getByRole('button', { name: 'Show 7 needing attention' }).click();
  await expect(
    page.getByText('Rows 1–6 matching operations · 12 total'),
  ).toBeVisible();
  await expect(page.locator('.operations-table tbody tr')).toHaveCount(6);

  await page.getByRole('button', { name: 'Next operations page' }).click();
  await expect(page.locator('.operations-table tbody tr')).toHaveCount(1);
  await expect(
    page.getByText('Rows 7–7 matching operations · 12 total'),
  ).toBeVisible();
  await expect(
    page.getByText(/^7 matching operations · 12 total$/),
  ).toHaveCount(0);

  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: testInfo.outputPath('job-detail-attention-last-page.png'),
    fullPage: true,
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('shows refresh activity with failed device counts', async ({
  page,
}, testInfo) => {
  await signIn(page);
  await page.route('**/api/jobs/REF-004', (route) =>
    route.fulfill({
      json: {
        ...refreshJob,
        status: 'completed-with-errors',
        scope: { kind: 'devices', deviceCount: 12 },
        progress: {
          total: 12,
          succeeded: 6,
          failed: 6,
          unknown: 0,
          skipped: 0,
          expired: 0,
          pending: 0,
        },
        latestActivity: {
          at: '2026-10-19T10:21:42.000Z',
          failed: { count: 6, operations: [] },
          unknown: { count: 0, operations: [] },
        },
      },
    }),
  );
  await page.goto('/jobs/REF-004');

  await expect(page.locator('.activity p')).toContainText(
    '6 devices read. 6 devices could not be read. The refresh completed with errors.',
  );
  await expect(page.getByText('Operation results')).toHaveCount(0);

  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: testInfo.outputPath('job-detail-refresh-errors.png'),
    fullPage: true,
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('keeps long operation values inside the table', async ({
  page,
}, testInfo) => {
  await signIn(page);
  const longSerial = 'C0A1-7F2D-EXTREMELY-LONG-SERIAL-000000000001';
  const longValue =
    'The north laboratory of the science wing, second floor, room 214';
  await page.route('**/api/jobs/UPD-006/operations*', (route) =>
    route.fulfill({
      json: {
        operations: [
          {
            ...operations[0],
            serialNumber: longSerial,
            baselineValue: longValue,
            requestedValue: `${longValue} (annotated)`,
            outcome: 'unknown',
            googleStatus: null,
            verifiedBy: null,
          },
        ],
        nextCursor: null,
      },
    }),
  );
  await page.goto('/jobs/UPD-006');
  await expect(page.getByText(longSerial)).toBeVisible();
  await expect(page.getByText(`${longValue} (annotated)`)).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);

  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: testInfo.outputPath('job-detail-long-content.png'),
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
    path: testInfo.outputPath('job-detail-long-content-320.png'),
    fullPage: true,
  });
});

test('inspects a failure and reconciles an unknown operation', async ({
  page,
}, testInfo) => {
  const state = await signIn(page);
  await page.goto('/jobs/UPD-006');

  await page.getByRole('button', { name: 'Inspect failure' }).click();
  await expect(
    page.getByRole('heading', { name: 'Failure details · C0A1-7F77' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close' })).toBeFocused();
  const panel = page.locator('.failure-panel');
  await expect(panel).toContainText('permission-denied');
  await expect(panel).toContainText('403');
  await expect(panel).toContainText('Forbidden');
  await expect(
    panel.locator('dt').filter({ hasText: 'Updated' }),
  ).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: testInfo.outputPath('job-detail-inspect-failure.png'),
    fullPage: true,
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.locator('.failure-panel')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Inspect failure' }),
  ).toBeFocused();

  await page.getByRole('button', { name: 'Reconcile' }).click();
  await expect(page.getByText('Reconciling')).toBeVisible();
  await expect(
    page.getByText('Reconcile started for C0A1-7F84.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reconcile' })).toHaveCount(0);

  state.reconcileStatus = 409;
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByRole('button', { name: 'Reconcile' })).toBeVisible();
  await page.getByRole('button', { name: 'Reconcile' }).click();
  await expect(
    page.getByText('The operation settled. Reading the job again.'),
  ).toBeVisible();
  await expect(page.getByText('Reconciling')).toHaveCount(0);
});

test('releases the reconciling mark when a 401 interrupts the session', async ({
  page,
}, testInfo) => {
  const state = await signIn(page);
  await page.goto('/jobs/UPD-006');
  await expect(page.getByRole('button', { name: 'Reconcile' })).toBeVisible();

  // AuthStore clears the session before the store sees the 401 answer.
  state.reconcileStatus = 401;
  await page.getByRole('button', { name: 'Reconcile' }).click();
  await expect(
    page.getByRole('button', { name: 'Recheck access' }),
  ).toBeVisible();
  await expect(page.getByText('Reconciling')).toHaveCount(0);

  // The same person recovers with the same grants.
  state.reconcileStatus = 202;
  await page.getByRole('button', { name: 'Recheck access' }).click();
  await expect(page.getByText('Requested by District Admin')).toBeVisible();

  // A successful reread keeps the operation unknown and offers Reconcile again.
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByRole('button', { name: 'Reconcile' })).toBeVisible();
  await expect(page.getByText('Reconciling')).toHaveCount(0);
  await expect(page.getByText('Reconcile started for C0A1-7F84.')).toHaveCount(
    0,
  );

  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: testInfo.outputPath('job-detail-after-interruption.png'),
    fullPage: true,
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('clears the previous person job after another person signs in', async ({
  page,
}) => {
  const state = await signIn(page);
  await page.goto('/jobs/UPD-006');
  await expect(page.getByText('Requested by District Admin')).toBeVisible();
  await expect(page.getByText('C0A1-7F2D')).toBeVisible();
  // The regression only exists while the document keeps the root store.
  await page.evaluate(() => {
    (
      globalThis as unknown as { jobDetailDocument?: string }
    ).jobDetailDocument = 'kept';
  });

  state.identity = 'alex';
  state.fail = true;
  await page.getByRole('button', { name: 'Open user menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(
    page.getByRole('heading', { name: 'Sign in', exact: true }),
  ).toBeVisible();

  await page.goBack();
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { jobDetailDocument?: string }).jobDetailDocument,
    ),
  ).toBe('kept');
  await expect(
    page.getByRole('button', { name: 'Open user menu' }),
  ).toContainText('Alex Rivera');
  await expect(
    page.getByRole('heading', { name: 'Job details are unavailable' }),
  ).toBeVisible();
  // The previous person's requester, counters, and rows are gone.
  await expect(page.getByText('Requested by District Admin')).toHaveCount(0);
  await expect(page.getByText('C0A1-7F2D')).toHaveCount(0);
  await expect(page.getByText('Operation results')).toHaveCount(0);
});

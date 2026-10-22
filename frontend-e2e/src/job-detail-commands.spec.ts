import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/**
 * The browser evidence of card F3. Every answer is mocked. The job detail of a
 * CMD- job matches state 09 of `docs/ui/designs/2026-10-21-device-commands.html`.
 * A command row in Unknown offers no Reconcile. An STS- job shows the requested
 * status of each device.
 */

const customerId = 'C0123456';
const person = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  displayName: 'Review administrator',
};
const commandJobId = '0f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10';
const statusJobId = '1f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10';
const commandFailure = 'The device failed to execute the command.';
/** The fixtures run from test start, so the identity line reads a short duration. */
const testAnchor = Date.now();
const secondsAgo = (seconds: number) =>
  new Date(testAnchor - seconds * 1000).toISOString();

interface OperationFixture {
  operationId: string;
  field: 'annotatedLocation' | 'annotatedUser' | 'notes' | 'orgUnitPath' | null;
  deviceId: string;
  serialNumber: string;
  orgUnitPath: string;
  operation: 'replace' | 'clear' | 'reboot' | 'disable' | 'reenable';
  baselineValue: string | null;
  requestedValue: string | null;
  outcome:
    | 'pending'
    | 'succeeded'
    | 'failed'
    | 'unknown'
    | 'skipped'
    | 'expired';
  outcomeReason: string | null;
  googleStatus: number | null;
  googleReason: string | null;
  observedValue: string | null;
  verifiedBy: 'write-response' | 'read-back' | null;
  commandId: string | null;
  commandState: 'pending-delivery' | 'sent' | 'acknowledged' | null;
  commandExpiresAt: string | null;
  commandExecutedAt: string | null;
  updatedAt: string;
}

const operation = (
  overrides: Partial<OperationFixture> = {},
): OperationFixture => ({
  operationId: 'CMD-001-1',
  field: null,
  deviceId: 'synthetic-device-1',
  serialNumber: 'SYN-01',
  orgUnitPath: '/Schools/Example',
  operation: 'reboot',
  baselineValue: null,
  requestedValue: null,
  outcome: 'succeeded',
  outcomeReason: null,
  googleStatus: null,
  googleReason: null,
  observedValue: null,
  verifiedBy: null,
  commandId: '4100000001',
  commandState: null,
  commandExpiresAt: null,
  commandExecutedAt: secondsAgo(280),
  updatedAt: secondsAgo(280),
  ...overrides,
});

/** The six rows of state 09. The serials are synthetic. */
const state09Operations: OperationFixture[] = [
  operation(),
  operation({
    operationId: 'CMD-001-2',
    deviceId: 'synthetic-device-2',
    serialNumber: 'SYN-02',
    outcome: 'failed',
    outcomeReason: 'command-failed',
    googleReason: commandFailure,
    commandId: '4100000002',
    commandExecutedAt: secondsAgo(100),
    updatedAt: secondsAgo(100),
  }),
  operation({
    operationId: 'CMD-001-3',
    deviceId: 'synthetic-device-3',
    serialNumber: 'SYN-03',
    outcome: 'pending',
    commandId: '4100000003',
    commandState: 'acknowledged',
    commandExpiresAt: '2026-10-25T23:04:00.000Z',
    updatedAt: secondsAgo(340),
  }),
  operation({
    operationId: 'CMD-001-4',
    deviceId: 'synthetic-device-4',
    serialNumber: 'SYN-04',
    outcome: 'pending',
    commandId: '4100000004',
    commandState: 'pending-delivery',
    commandExpiresAt: '2026-10-25T23:03:00.000Z',
    updatedAt: secondsAgo(400),
  }),
  operation({
    operationId: 'CMD-001-5',
    deviceId: 'synthetic-device-5',
    serialNumber: 'SYN-05',
    outcome: 'expired',
    commandId: '4100000005',
    updatedAt: secondsAgo(100),
  }),
  operation({
    operationId: 'CMD-001-6',
    deviceId: 'synthetic-device-6',
    serialNumber: 'SYN-06',
    outcome: 'unknown',
    outcomeReason: 'not-observed',
    commandId: '4100000006',
    updatedAt: secondsAgo(400),
  }),
];

const commandJob = {
  jobId: commandJobId,
  displayId: 'CMD-001',
  revision: 5,
  action: 'reboot-devices',
  status: 'running',
  scope: { kind: 'devices', deviceCount: 6 },
  requestedBy: person,
  createdAt: secondsAgo(400),
  startedAt: secondsAgo(400),
  finishedAt: null,
  progress: {
    total: 6,
    succeeded: 1,
    failed: 1,
    unknown: 1,
    skipped: 0,
    expired: 1,
    pending: 2,
  },
  failure: null,
  confirmedBy: person,
  previewDisplayId: 'PV-002',
  field: null,
  mode: null,
  commandType: 'REBOOT',
  statusAction: null,
  requestedValue: null,
  targetOrgUnitPaths: ['/Schools/Example'],
  correlationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  latestActivity: {
    at: secondsAgo(100),
    failed: {
      count: 1,
      operations: [
        {
          operationId: 'CMD-001-2',
          deviceId: 'synthetic-device-2',
          serialNumber: 'SYN-02',
          outcomeReason: 'command-failed',
          googleStatus: null,
          googleReason: commandFailure,
          updatedAt: secondsAgo(100),
        },
      ],
    },
    unknown: {
      count: 1,
      operations: [
        {
          operationId: 'CMD-001-6',
          deviceId: 'synthetic-device-6',
          serialNumber: 'SYN-06',
          updatedAt: secondsAgo(400),
        },
      ],
    },
  },
};

const statusOperations: OperationFixture[] = [
  operation({
    operationId: 'STS-002-1',
    deviceId: 'synthetic-device-1',
    serialNumber: 'SYN-11',
    operation: 'disable',
    baselineValue: 'ACTIVE',
    requestedValue: 'DISABLED',
    outcome: 'succeeded',
    googleStatus: 200,
    verifiedBy: 'write-response',
    commandId: null,
    commandExecutedAt: null,
    updatedAt: '2026-10-20T22:05:00.000Z',
  }),
  operation({
    operationId: 'STS-002-2',
    deviceId: 'synthetic-device-2',
    serialNumber: 'SYN-12',
    operation: 'disable',
    baselineValue: 'ACTIVE',
    requestedValue: 'DISABLED',
    outcome: 'failed',
    outcomeReason: 'status-conflict',
    googleReason: 'The device status conflicts with the request.',
    commandId: null,
    commandExecutedAt: null,
    updatedAt: '2026-10-20T22:06:00.000Z',
  }),
  operation({
    operationId: 'STS-002-3',
    deviceId: 'synthetic-device-3',
    serialNumber: 'SYN-13',
    operation: 'disable',
    baselineValue: 'ACTIVE',
    requestedValue: 'DISABLED',
    outcome: 'unknown',
    outcomeReason: 'invalid-response',
    commandId: null,
    commandExecutedAt: null,
    updatedAt: '2026-10-20T22:07:00.000Z',
  }),
];

const statusJob = {
  jobId: statusJobId,
  displayId: 'STS-002',
  revision: 3,
  action: 'disable-devices',
  status: 'completed-with-errors',
  scope: { kind: 'devices', deviceCount: 3 },
  requestedBy: person,
  createdAt: '2026-10-20T22:03:00.000Z',
  startedAt: '2026-10-20T22:03:00.000Z',
  finishedAt: '2026-10-20T22:07:00.000Z',
  progress: {
    total: 3,
    succeeded: 1,
    failed: 1,
    unknown: 1,
    skipped: 0,
    expired: 0,
    pending: 0,
  },
  failure: null,
  confirmedBy: person,
  previewDisplayId: 'PV-003',
  field: null,
  mode: null,
  commandType: null,
  statusAction: 'disable',
  requestedValue: null,
  targetOrgUnitPaths: ['/Schools/Example'],
  correlationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  latestActivity: {
    at: '2026-10-20T22:07:00.000Z',
    failed: {
      count: 1,
      operations: [
        {
          operationId: 'STS-002-2',
          deviceId: 'synthetic-device-2',
          serialNumber: 'SYN-12',
          outcomeReason: 'status-conflict',
          googleStatus: null,
          googleReason: 'The device status conflicts with the request.',
          updatedAt: '2026-10-20T22:06:00.000Z',
        },
      ],
    },
    unknown: {
      count: 1,
      operations: [
        {
          operationId: 'STS-002-3',
          deviceId: 'synthetic-device-3',
          serialNumber: 'SYN-13',
          updatedAt: '2026-10-20T22:07:00.000Z',
        },
      ],
    },
  },
};

const summary = (job: {
  jobId: string;
  displayId: string;
  action: string;
  status: string;
  scope: { kind: string; deviceCount: number | null };
  finishedAt: string | null;
}) => ({
  jobId: job.jobId,
  displayId: job.displayId,
  revision: 1,
  action: job.action,
  status: job.status,
  scope: job.scope,
  requestedBy: person,
  createdAt: secondsAgo(400),
  startedAt: secondsAgo(400),
  finishedAt: job.finishedAt ? secondsAgo(60) : null,
  progress: {
    total: job.scope.deviceCount,
    succeeded: 1,
    failed: 0,
    unknown: 0,
    skipped: 0,
    expired: 0,
    pending: 0,
  },
  failure: null,
});

const jobList = {
  jobs: [
    summary({
      jobId: commandJobId,
      displayId: 'CMD-001',
      action: 'reboot-devices',
      status: 'awaiting-devices',
      scope: { kind: 'devices', deviceCount: 6 },
      finishedAt: null,
    }),
    summary({
      jobId: statusJobId,
      displayId: 'STS-002',
      action: 'disable-devices',
      status: 'completed',
      scope: { kind: 'devices', deviceCount: 3 },
      finishedAt: '2026-10-20T22:07:00.000Z',
    }),
  ],
  matching: 2,
  nextCursor: null,
  observedAt: secondsAgo(10),
};

const activity = {
  running: {
    count: 1,
    jobs: [
      summary({
        jobId: commandJobId,
        displayId: 'CMD-001',
        action: 'reboot-devices',
        status: 'awaiting-devices',
        scope: { kind: 'devices', deviceCount: 6 },
        finishedAt: null,
      }),
    ],
  },
  waiting: { count: 0, jobs: [] },
  recent: {
    count: 1,
    jobs: [
      summary({
        jobId: statusJobId,
        displayId: 'STS-002',
        action: 'disable-devices',
        status: 'completed',
        scope: { kind: 'devices', deviceCount: 3 },
        finishedAt: '2026-10-20T22:07:00.000Z',
      }),
    ],
    nextExpiryAt: null,
  },
  attention: false,
  seenAt: null,
  observedAt: secondsAgo(10),
};

/** One mock for every read of the three screens. */
async function signIn(page: Page) {
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
            grants: ['jobs:read', 'devices:read', 'devices:write'].map(
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
    if (path === '/api/jobs/events')
      return route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: '',
      });
    if (path === '/api/jobs/CMD-001')
      return route.fulfill({ json: commandJob });
    if (path === '/api/jobs/CMD-001/operations')
      return route.fulfill({
        json: {
          operations:
            url.searchParams.get('attention') === 'true'
              ? state09Operations.filter(
                  (row) =>
                    row.outcome === 'failed' ||
                    row.outcome === 'unknown' ||
                    row.outcome === 'expired',
                )
              : state09Operations,
          nextCursor: null,
        },
      });
    if (path === '/api/jobs/STS-002') return route.fulfill({ json: statusJob });
    if (path === '/api/jobs/STS-002/operations')
      return route.fulfill({
        json: { operations: statusOperations, nextCursor: null },
      });
    if (path === '/api/jobs/activity') return route.fulfill({ json: activity });
    if (path === '/api/jobs') return route.fulfill({ json: jobList });
    if (path === '/api/jobs/requesters')
      return route.fulfill({ json: { requesters: [person] } });
    if (path === '/api/customer')
      return route.fulfill({ json: { customer: null } });
    return route.fulfill({ json: {} });
  });
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
});

test('renders the command job of state 09 in the light and dark themes', async ({
  page,
}, testInfo) => {
  await signIn(page);
  await page.goto('/jobs/CMD-001');

  await expect(
    page.getByRole('heading', { name: 'Reboot devices', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Job CMD-001 · Running')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'CMD-001 · 6 devices', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(/Requested by Review administrator/),
  ).toBeVisible();

  // State 09 orders Expired after Unknown. Pending counts both waiting states.
  await expect(page.locator('.counter dt')).toHaveText([
    'Succeeded',
    'Failed',
    'Unknown',
    'Expired',
    'Pending',
    'Skipped',
    'Cancelled',
  ]);
  await expect(page.locator('.counter .value')).toHaveText([
    '1',
    '1',
    '1',
    '1',
    '2',
    '0',
    '0',
  ]);

  const rows = page.locator('.operations-table tbody tr');
  await expect(rows).toHaveCount(6);
  for (const row of await rows.all()) await expect(row).toContainText('Reboot');
  await expect(rows.nth(0)).toContainText('Succeeded');
  await expect(rows.nth(1)).toContainText('Failed');
  await expect(rows.nth(1)).toContainText(commandFailure);
  await expect(rows.nth(2)).toContainText('Acknowledged');
  await expect(rows.nth(3)).toContainText('Pending delivery');
  await expect(rows.nth(4)).toContainText('Expired');
  await expect(rows.nth(5)).toContainText('Unknown');
  await expect(
    page.getByRole('button', { name: 'Inspect failure' }),
  ).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Reconcile' })).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Show 3 needing attention' }),
  ).toBeVisible();
  await expect(page.locator('.activity p')).toContainText(
    '1 Reboot command expired before execution.',
  );
  await expect(page.locator('.activity p')).toContainText(
    'SYN-02 reported an execution failure.',
  );
  await expect(page.locator('.activity p')).toContainText(
    '2 commands wait for device execution.',
  );
  await expect(page.locator('.activity p')).not.toContainText('reconciliation');

  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: testInfo.outputPath('job-detail-cmd-light.png'),
    fullPage: true,
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await page.getByRole('button', { name: 'Choose theme' }).click();
  await page.getByRole('menuitem', { name: 'Use dark theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('.cdk-overlay-container > *')).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: testInfo.outputPath('job-detail-cmd-dark.png'),
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
    path: testInfo.outputPath('job-detail-cmd-320.png'),
    fullPage: true,
  });
});

test('gives every command state its chip', async ({ page }, testInfo) => {
  const states: OperationFixture[] = [
    operation({
      operationId: 'CMD-001-1',
      commandState: 'pending-delivery',
      outcome: 'pending',
      updatedAt: '2026-10-20T23:03:00.000Z',
    }),
    operation({
      operationId: 'CMD-001-2',
      deviceId: 'synthetic-device-2',
      serialNumber: 'SYN-02',
      commandState: 'sent',
      outcome: 'pending',
      updatedAt: '2026-10-20T23:04:00.000Z',
    }),
    operation({
      operationId: 'CMD-001-3',
      deviceId: 'synthetic-device-3',
      serialNumber: 'SYN-03',
      commandState: 'acknowledged',
      outcome: 'pending',
      updatedAt: '2026-10-20T23:05:00.000Z',
    }),
    operation({
      operationId: 'CMD-001-4',
      deviceId: 'synthetic-device-4',
      serialNumber: 'SYN-04',
      outcome: 'succeeded',
      updatedAt: '2026-10-20T23:06:00.000Z',
    }),
    operation({
      operationId: 'CMD-001-5',
      deviceId: 'synthetic-device-5',
      serialNumber: 'SYN-05',
      outcome: 'failed',
      outcomeReason: 'command-failed',
      googleReason: commandFailure,
      updatedAt: '2026-10-20T23:07:00.000Z',
    }),
    operation({
      operationId: 'CMD-001-6',
      deviceId: 'synthetic-device-6',
      serialNumber: 'SYN-06',
      outcome: 'expired',
      updatedAt: '2026-10-20T23:08:00.000Z',
    }),
    operation({
      operationId: 'CMD-001-7',
      deviceId: 'synthetic-device-7',
      serialNumber: 'SYN-07',
      outcome: 'unknown',
      outcomeReason: 'not-observed',
      updatedAt: '2026-10-20T23:09:00.000Z',
    }),
  ];
  await signIn(page);
  await page.route('**/api/jobs/CMD-001', (route) =>
    route.fulfill({
      json: {
        ...commandJob,
        scope: { kind: 'devices', deviceCount: 7 },
        progress: {
          total: 7,
          succeeded: 1,
          failed: 1,
          unknown: 1,
          skipped: 0,
          expired: 1,
          pending: 3,
        },
      },
    }),
  );
  await page.route('**/api/jobs/CMD-001/operations*', (route) =>
    route.fulfill({ json: { operations: states, nextCursor: null } }),
  );
  await page.goto('/jobs/CMD-001');

  const rows = page.locator('.operations-table tbody tr');
  await expect(rows).toHaveCount(7);
  await expect(rows.nth(0)).toContainText('Pending delivery');
  await expect(rows.nth(1)).toContainText('Sent');
  await expect(rows.nth(2)).toContainText('Acknowledged');
  await expect(rows.nth(3)).toContainText('Succeeded');
  await expect(rows.nth(4)).toContainText('Failed');
  await expect(rows.nth(5)).toContainText('Expired');
  await expect(rows.nth(6)).toContainText('Unknown');
  // No unknown command row offers Reconcile, even with devices:write.
  await expect(page.getByRole('button', { name: 'Reconcile' })).toHaveCount(0);

  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: testInfo.outputPath('job-detail-cmd-states.png'),
    fullPage: true,
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('renders the operations and requested status of a status job', async ({
  page,
}, testInfo) => {
  await signIn(page);
  await page.goto('/jobs/STS-002');

  await expect(
    page.getByRole('heading', { name: 'Disable devices', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Job STS-002 · Completed with errors'),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'STS-002 · 3 devices', exact: true }),
  ).toBeVisible();

  const rows = page.locator('.operations-table tbody tr');
  await expect(rows).toHaveCount(3);
  for (const row of await rows.all()) {
    await expect(row).toContainText('Disable');
    await expect(row).toContainText('Active');
    await expect(row).toContainText('Disabled');
  }
  await expect(rows.nth(0)).toContainText('Succeeded');
  await expect(rows.nth(1)).toContainText('Failed');
  await expect(rows.nth(1)).toContainText(
    'The device status conflicts with the request.',
  );
  await expect(rows.nth(2)).toContainText('Unknown');
  // A status operation keeps the step 4 Reconcile action.
  await expect(page.getByRole('button', { name: 'Reconcile' })).toHaveCount(1);
  await expect(
    page.getByRole('button', { name: 'Show 2 needing attention' }),
  ).toBeVisible();

  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: testInfo.outputPath('job-detail-sts.png'),
    fullPage: true,
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('reconciles an unknown status operation through its numbered endpoint', async ({
  page,
}, testInfo) => {
  await signIn(page);
  await page.route('**/api/jobs/STS-002', (route) =>
    route.fulfill({ json: { ...statusJob, status: 'needs-review' } }),
  );
  const requests: { method: string; path: string }[] = [];
  await page.route(
    '**/api/jobs/STS-002/operations/*/reconcile',
    async (route) => {
      const request = route.request();
      requests.push({
        method: request.method(),
        path: new URL(request.url()).pathname,
      });
      await route.fulfill({ status: 202, body: '' });
    },
  );
  await page.goto('/jobs/STS-002');

  const row = page.locator('.operations-table tbody tr').nth(2);
  await expect(row).toContainText('Unknown');
  await row.getByRole('button', { name: 'Reconcile' }).click();

  // The click reaches the numbered endpoint and the accepted state remains visible.
  await expect
    .poll(() => requests)
    .toEqual([
      { method: 'POST', path: '/api/jobs/STS-002/operations/3/reconcile' },
    ]);
  await expect(page.getByText('Reconcile started for SYN-13.')).toBeVisible();
  await expect(row).toContainText('Reconciling');
  await expect(row.getByRole('button', { name: 'Reconcile' })).toHaveCount(0);

  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: testInfo.outputPath('job-detail-sts-reconcile.png'),
    fullPage: true,
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('does not call a refused command issue an execution failure', async ({
  page,
}, testInfo) => {
  await signIn(page);
  await page.route('**/api/jobs/CMD-001', (route) =>
    route.fulfill({
      json: {
        ...commandJob,
        latestActivity: {
          at: secondsAgo(100),
          failed: {
            count: 1,
            operations: [
              {
                operationId: 'CMD-001-2',
                deviceId: 'synthetic-device-2',
                serialNumber: 'SYN-02',
                outcomeReason: 'quota',
                googleStatus: 429,
                googleReason: 'Quota exceeded.',
                updatedAt: secondsAgo(100),
              },
            ],
          },
          unknown: { count: 0, operations: [] },
        },
      },
    }),
  );
  await page.goto('/jobs/CMD-001');

  // The issue never reached a device, so the line names the refusal.
  const activity = page.locator('.activity p');
  await expect(activity).toContainText(
    'Google quota stopped the command for SYN-02.',
  );
  await expect(activity).not.toContainText('execution failure');

  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: testInfo.outputPath('job-detail-cmd-issue-refusal.png'),
    fullPage: true,
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('names the new job kinds in the Jobs list and the activity area', async ({
  page,
}, testInfo) => {
  await signIn(page);
  await page.goto('/jobs');

  await expect(page.getByRole('cell', { name: /CMD-001/ })).toContainText(
    'Reboot devices',
  );
  await expect(page.getByRole('cell', { name: /STS-002/ })).toContainText(
    'Disable devices',
  );
  await expect(
    page.getByText('Awaiting devices', { exact: true }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Activity: 1 job running' }).click();
  const panel = page.getByRole('dialog', { name: 'Activity' });
  await expect(panel).toBeVisible();
  await expect(panel.getByText('CMD-001 · Reboot devices')).toBeVisible();
  await expect(panel.getByText('STS-002 · Disable devices')).toBeVisible();

  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: testInfo.outputPath('jobs-command-kinds.png'),
    fullPage: true,
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

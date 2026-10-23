import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/**
 * The browser evidence of card F2. Every answer is mocked.
 * A Powerwash job shows the command states of the approved state 09: pending delivery,
 * acknowledged, failed, and unknown with the watch window and Google's expiry. A Deprovision
 * job shows its reason (approved state 10). No command row offers Reconcile.
 */

const customerId = 'C0123456';
const person = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  displayName: 'Review administrator',
};
const powerwashJobId = '0f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10';
const wipeJobId = '2f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10';
const deprovisionJobId = '1f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10';
const commandFailure = 'The device failed to execute the command.';
const statusConflict =
  'A device with status DEPROVISIONED does not allow this action.';

interface OperationFixture {
  operationId: string;
  field: 'annotatedLocation' | 'annotatedUser' | 'notes' | 'orgUnitPath' | null;
  deviceId: string;
  serialNumber: string;
  orgUnitPath: string;
  operation:
    | 'replace'
    | 'clear'
    | 'move'
    | 'reboot'
    | 'wipe-users'
    | 'powerwash'
    | 'disable'
    | 'reenable'
    | 'deprovision';
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
  operationId: 'CMD-008-1',
  field: null,
  deviceId: 'synthetic-device-1',
  serialNumber: '01P0T1V',
  orgUnitPath: '/Schools/Example',
  operation: 'powerwash',
  baselineValue: null,
  requestedValue: null,
  outcome: 'pending',
  outcomeReason: null,
  googleStatus: null,
  googleReason: null,
  observedValue: null,
  verifiedBy: null,
  commandId: '4200000001',
  commandState: 'acknowledged',
  commandExpiresAt: '2031-10-22T18:11:00.000Z',
  commandExecutedAt: null,
  updatedAt: '2026-10-22T17:12:00.000Z',
  ...overrides,
});

/** The four rows of approved state 09. */
const state09Operations: OperationFixture[] = [
  operation(),
  operation({
    operationId: 'CMD-008-2',
    deviceId: 'synthetic-device-2',
    serialNumber: '02A1MB6',
    outcome: 'failed',
    outcomeReason: 'command-failed',
    googleReason: commandFailure,
    commandId: '4200000002',
    commandState: null,
    commandExpiresAt: null,
    updatedAt: '2026-10-22T18:40:00.000Z',
  }),
  operation({
    operationId: 'CMD-008-3',
    deviceId: 'synthetic-device-3',
    serialNumber: '02QJANY',
    commandId: '4200000003',
    commandState: 'pending-delivery',
  }),
  operation({
    operationId: 'CMD-008-4',
    deviceId: 'synthetic-device-4',
    serialNumber: '04XTBHJ',
    outcome: 'unknown',
    outcomeReason: 'not-observed',
    commandId: '4200000004',
    commandState: null,
    updatedAt: '2026-10-22T18:11:00.000Z',
  }),
];

const powerwashJob = {
  jobId: powerwashJobId,
  displayId: 'CMD-008',
  revision: 5,
  action: 'powerwash-devices',
  status: 'awaiting-devices',
  scope: { kind: 'devices', deviceCount: 4 },
  requestedBy: person,
  createdAt: '2026-10-22T18:11:00.000Z',
  startedAt: '2026-10-22T18:11:00.000Z',
  finishedAt: null,
  progress: {
    total: 4,
    succeeded: 0,
    failed: 1,
    unknown: 1,
    skipped: 0,
    expired: 0,
    pending: 2,
  },
  failure: null,
  confirmedBy: person,
  previewDisplayId: 'PV-018',
  changes: null,
  commandType: 'REMOTE_POWERWASH',
  statusAction: null,
  deprovisionReason: null,
  targetOrgUnitPaths: ['/Schools/Example'],
  correlationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  latestActivity: {
    at: '2026-10-22T18:40:00.000Z',
    failed: {
      count: 1,
      operations: [
        {
          operationId: 'CMD-008-2',
          deviceId: 'synthetic-device-2',
          serialNumber: '02A1MB6',
          outcomeReason: 'command-failed',
          googleStatus: null,
          googleReason: commandFailure,
          updatedAt: '2026-10-22T18:40:00.000Z',
        },
      ],
    },
    unknown: {
      count: 1,
      operations: [
        {
          operationId: 'CMD-008-4',
          deviceId: 'synthetic-device-4',
          serialNumber: '04XTBHJ',
          updatedAt: '2026-10-22T18:11:00.000Z',
        },
      ],
    },
  },
};

/** Every command state of the record, including the two outside state 09. */
const everyStateOperations: OperationFixture[] = [
  ...state09Operations,
  operation({
    operationId: 'CMD-008-5',
    deviceId: 'synthetic-device-5',
    serialNumber: '04A9BVS',
    outcome: 'failed',
    outcomeReason: 'command-cancelled',
    googleStatus: 200,
    googleReason: null,
    commandId: '4200000005',
    commandState: null,
    commandExpiresAt: null,
    updatedAt: '2026-10-22T18:41:00.000Z',
  }),
  operation({
    operationId: 'CMD-008-6',
    deviceId: 'synthetic-device-6',
    serialNumber: '08V5B5S',
    outcome: 'succeeded',
    commandState: null,
    commandExpiresAt: null,
    commandExecutedAt: '2026-10-22T18:30:00.000Z',
    updatedAt: '2026-10-22T18:30:00.000Z',
  }),
  operation({
    operationId: 'CMD-008-7',
    deviceId: 'synthetic-device-7',
    serialNumber: '05C2Z8P',
    outcome: 'expired',
    commandState: null,
    commandExpiresAt: '2026-10-22T18:11:00.000Z',
    updatedAt: '2026-10-22T18:42:00.000Z',
  }),
];

const deprovisionOperations: OperationFixture[] = [
  operation({
    operationId: 'STS-003-1',
    deviceId: 'synthetic-device-1',
    serialNumber: '01P0T1V',
    operation: 'deprovision',
    baselineValue: 'ACTIVE',
    requestedValue: 'DEPROVISIONED',
    outcome: 'succeeded',
    googleStatus: 200,
    verifiedBy: 'write-response',
    observedValue: 'DEPROVISIONED',
    commandId: null,
    commandState: null,
    commandExpiresAt: null,
    updatedAt: '2026-10-22T18:16:00.000Z',
  }),
  operation({
    operationId: 'STS-003-2',
    deviceId: 'synthetic-device-2',
    serialNumber: '02A1MB6',
    operation: 'deprovision',
    baselineValue: 'ACTIVE',
    requestedValue: 'DEPROVISIONED',
    outcome: 'succeeded',
    googleStatus: 200,
    verifiedBy: 'write-response',
    observedValue: 'DEPROVISIONED',
    commandId: null,
    commandState: null,
    commandExpiresAt: null,
    updatedAt: '2026-10-22T18:16:00.000Z',
  }),
  operation({
    operationId: 'STS-003-3',
    deviceId: 'synthetic-device-3',
    serialNumber: '02QJANY',
    operation: 'deprovision',
    baselineValue: 'ACTIVE',
    requestedValue: 'DEPROVISIONED',
    outcome: 'succeeded',
    googleStatus: 200,
    verifiedBy: 'write-response',
    observedValue: 'DEPROVISIONED',
    commandId: null,
    commandState: null,
    commandExpiresAt: null,
    updatedAt: '2026-10-22T18:16:00.000Z',
  }),
  operation({
    operationId: 'STS-003-4',
    deviceId: 'synthetic-device-4',
    serialNumber: '04QVJBY',
    operation: 'deprovision',
    baselineValue: 'DISABLED',
    requestedValue: 'DEPROVISIONED',
    outcome: 'succeeded',
    googleStatus: 200,
    verifiedBy: 'write-response',
    observedValue: 'DEPROVISIONED',
    commandId: null,
    commandState: null,
    commandExpiresAt: null,
    updatedAt: '2026-10-22T18:16:00.000Z',
  }),
  operation({
    operationId: 'STS-003-5',
    deviceId: 'synthetic-device-5',
    serialNumber: '04XTBHJ',
    operation: 'deprovision',
    baselineValue: 'ACTIVE',
    requestedValue: 'DEPROVISIONED',
    outcome: 'failed',
    outcomeReason: 'status-conflict',
    googleStatus: null,
    googleReason: statusConflict,
    commandId: null,
    commandState: null,
    commandExpiresAt: null,
    updatedAt: '2026-10-22T18:16:00.000Z',
  }),
];

const deprovisionJob = {
  jobId: deprovisionJobId,
  displayId: 'STS-003',
  revision: 4,
  action: 'deprovision-devices',
  status: 'completed-with-errors',
  scope: { kind: 'devices', deviceCount: 5 },
  requestedBy: person,
  createdAt: '2026-10-22T18:16:00.000Z',
  startedAt: '2026-10-22T18:16:00.000Z',
  finishedAt: '2026-10-22T18:16:03.000Z',
  progress: {
    total: 5,
    succeeded: 4,
    failed: 1,
    unknown: 0,
    skipped: 0,
    expired: 0,
    pending: 0,
  },
  failure: null,
  confirmedBy: person,
  previewDisplayId: 'PV-019',
  changes: null,
  commandType: null,
  statusAction: 'deprovision',
  deprovisionReason: 'DEPROVISION_REASON_RETIRING_DEVICE',
  targetOrgUnitPaths: ['/Schools/Example'],
  correlationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  latestActivity: {
    at: '2026-10-22T18:16:00.000Z',
    failed: {
      count: 1,
      operations: [
        {
          operationId: 'STS-003-5',
          deviceId: 'synthetic-device-5',
          serialNumber: '04XTBHJ',
          outcomeReason: 'status-conflict',
          googleStatus: null,
          googleReason: statusConflict,
          updatedAt: '2026-10-22T18:16:00.000Z',
        },
      ],
    },
    unknown: { count: 0, operations: [] },
  },
};

const wipeJob = {
  ...powerwashJob,
  jobId: wipeJobId,
  displayId: 'CMD-009',
  revision: 2,
  action: 'wipe-user-data',
  status: 'completed',
  scope: { kind: 'devices', deviceCount: 1 },
  progress: {
    total: 1,
    succeeded: 1,
    failed: 0,
    unknown: 0,
    skipped: 0,
    expired: 0,
    pending: 0,
  },
  commandType: 'WIPE_USERS',
  latestActivity: {
    at: '2026-10-22T18:50:00.000Z',
    failed: { count: 0, operations: [] },
    unknown: { count: 0, operations: [] },
  },
};

const wipeOperations: OperationFixture[] = [
  operation({
    operationId: 'CMD-009-1',
    deviceId: 'synthetic-device-1',
    serialNumber: '01P0T1V',
    operation: 'wipe-users',
    outcome: 'succeeded',
    googleStatus: 200,
    commandState: null,
    commandExpiresAt: null,
    commandExecutedAt: '2026-10-22T18:50:00.000Z',
    updatedAt: '2026-10-22T18:50:00.000Z',
  }),
];

const summary = (job: {
  jobId: string;
  displayId: string;
  action: string;
  status: string;
  scope: { kind: string; deviceCount: number | null };
  createdAt: string;
  finishedAt: string | null;
  progress: {
    total: number | null;
    succeeded: number;
    failed: number;
    unknown: number;
    skipped: number;
    expired: number;
    pending: number | null;
  };
}) => ({
  jobId: job.jobId,
  displayId: job.displayId,
  revision: 1,
  action: job.action,
  status: job.status,
  scope: job.scope,
  requestedBy: person,
  createdAt: job.createdAt,
  startedAt: job.createdAt,
  finishedAt: job.finishedAt,
  progress: job.progress,
  failure: null,
});

const jobList = {
  jobs: [summary(powerwashJob), summary(deprovisionJob), summary(wipeJob)],
  matching: 3,
  nextCursor: null,
  observedAt: '2026-10-22T18:50:00.000Z',
};

const activity = {
  running: { count: 0, jobs: [] },
  waiting: { count: 0, jobs: [] },
  recent: { count: 0, jobs: [] },
  attention: false,
  seenAt: null,
  observedAt: '2026-10-22T18:50:00.000Z',
};

const DEFAULT_GRANTS = ['jobs:read', 'devices:read', 'devices:write'];

/** One mock for every read of the three screens. */
async function signIn(page: Page, grants: readonly string[] = DEFAULT_GRANTS) {
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
    if (path === '/api/jobs/CMD-008')
      return route.fulfill({ json: powerwashJob });
    if (path === '/api/jobs/CMD-008/operations')
      return route.fulfill({
        json: { operations: state09Operations, nextCursor: null },
      });
    if (path === '/api/jobs/CMD-009') return route.fulfill({ json: wipeJob });
    if (path === '/api/jobs/CMD-009/operations')
      return route.fulfill({
        json: { operations: wipeOperations, nextCursor: null },
      });
    if (path === '/api/jobs/STS-003')
      return route.fulfill({ json: deprovisionJob });
    if (path === '/api/jobs/STS-003/operations')
      return route.fulfill({
        json: { operations: deprovisionOperations, nextCursor: null },
      });
    if (path === '/api/jobs/activity') return route.fulfill({ json: activity });
    if (path === '/api/jobs') {
      const action = url.searchParams.get('action');
      const rows = action
        ? jobList.jobs.filter((job) => action.split(',').includes(job.action))
        : jobList.jobs;
      return route.fulfill({
        json: {
          jobs: rows,
          matching: rows.length,
          nextCursor: null,
          observedAt: '2026-10-22T18:50:00.000Z',
        },
      });
    }
    if (path === '/api/jobs/requesters')
      return route.fulfill({ json: { requesters: [person] } });
    if (path === '/api/customer')
      return route.fulfill({ json: { customer: null } });
    return route.fulfill({ json: {} });
  });
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
});

test('renders the Powerwash job of state 09 with Google expiry and no Reconcile', async ({
  page,
}, testInfo) => {
  await signIn(page);
  await page.goto('/jobs/CMD-008');

  await expect(
    page.getByRole('heading', { name: 'Powerwash devices', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Job CMD-008 · Awaiting devices')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'CMD-008 · 4 devices', exact: true }),
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
    '0',
    '1',
    '1',
    '0',
    '2',
    '0',
    '0',
  ]);

  const rows = page.locator('.operations-table tbody tr');
  await expect(rows).toHaveCount(4);
  for (const row of await rows.all()) {
    await expect(row).toContainText('Powerwash');
    await expect(row).toContainText('—');
  }
  const expiry = 'Expires Oct 22, 2031, 2:11 PM';
  await expect(rows.nth(0)).toContainText('Acknowledged');
  await expect(rows.nth(0)).toContainText(expiry);
  await expect(rows.nth(1)).toContainText('Failed');
  await expect(rows.nth(1)).toContainText(commandFailure);
  await expect(rows.nth(2)).toContainText('Pending delivery');
  await expect(rows.nth(2)).toContainText(expiry);
  await expect(rows.nth(3)).toContainText('Unknown');
  await expect(rows.nth(3)).toContainText('No result in 30 days');
  await expect(rows.nth(3)).toContainText(expiry);
  // No command row offers Reconcile.
  await expect(page.getByRole('button', { name: 'Reconcile' })).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Show 2 needing attention' }),
  ).toBeVisible();
  await expect(page.locator('.activity p')).toHaveText(
    '2:40 PM · 02A1MB6 reported an execution failure. The outcome for 04XTBHJ is uncertain. 2 commands wait for device execution.',
  );

  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: testInfo.outputPath('wpd-f2-09-powerwash-job.png'),
    fullPage: true,
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('shows every Powerwash command state, including a cancelled command', async ({
  page,
}, testInfo) => {
  await signIn(page);
  await page.route('**/api/jobs/CMD-008', (route) =>
    route.fulfill({
      json: {
        ...powerwashJob,
        status: 'needs-review',
        scope: { kind: 'devices', deviceCount: 7 },
        progress: {
          total: 7,
          succeeded: 1,
          failed: 2,
          unknown: 1,
          skipped: 0,
          expired: 1,
          pending: 2,
        },
        latestActivity: {
          at: '2026-10-22T18:41:00.000Z',
          failed: {
            count: 2,
            operations: [
              {
                operationId: 'CMD-008-2',
                deviceId: 'synthetic-device-2',
                serialNumber: '02A1MB6',
                outcomeReason: 'command-failed',
                googleStatus: null,
                googleReason: commandFailure,
                updatedAt: '2026-10-22T18:40:00.000Z',
              },
              {
                operationId: 'CMD-008-5',
                deviceId: 'synthetic-device-5',
                serialNumber: '04A9BVS',
                outcomeReason: 'command-cancelled',
                googleStatus: 200,
                googleReason: null,
                updatedAt: '2026-10-22T18:41:00.000Z',
              },
            ],
          },
          unknown: {
            count: 1,
            operations: [
              {
                operationId: 'CMD-008-4',
                deviceId: 'synthetic-device-4',
                serialNumber: '04XTBHJ',
                updatedAt: '2026-10-22T18:11:00.000Z',
              },
            ],
          },
        },
      },
    }),
  );
  await page.route('**/api/jobs/CMD-008/operations*', (route) =>
    route.fulfill({
      json: { operations: everyStateOperations, nextCursor: null },
    }),
  );
  await page.goto('/jobs/CMD-008');

  const rows = page.locator('.operations-table tbody tr');
  await expect(rows).toHaveCount(7);
  await expect(rows.nth(0)).toContainText('Acknowledged');
  await expect(rows.nth(1)).toContainText('Failed');
  await expect(rows.nth(1)).toContainText(commandFailure);
  await expect(rows.nth(2)).toContainText('Pending delivery');
  await expect(rows.nth(3)).toContainText('Unknown');
  await expect(rows.nth(3)).toContainText('No result in 30 days');
  await expect(rows.nth(4)).toContainText('Failed');
  await expect(rows.nth(4)).toContainText('Google cancelled the command.');
  await expect(rows.nth(5)).toContainText('Succeeded');
  await expect(rows.nth(6)).toContainText('Expired');
  await expect(page.getByRole('button', { name: 'Reconcile' })).toHaveCount(0);
  await expect(page.locator('.activity p')).toContainText(
    '1 Powerwash command expired before execution.',
  );
  await expect(page.locator('.activity p')).toContainText(
    'Google cancelled the command for 04A9BVS.',
  );
  await expect(page.locator('.activity p')).not.toContainText('reconciliation');

  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: testInfo.outputPath('wpd-f2-09b-powerwash-states.png'),
    fullPage: true,
  });
  // The operations grid keeps its frame height, so the last rows need a scroll.
  await page.locator('.table-scroll').evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: testInfo.outputPath('wpd-f2-09c-powerwash-states-end.png'),
    fullPage: true,
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('renders the Deprovision job of state 10 with its reason', async ({
  page,
}, testInfo) => {
  await signIn(page);
  await page.goto('/jobs/STS-003');

  await expect(
    page.getByRole('heading', { name: 'Deprovision devices', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Job STS-003 · Completed with errors'),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'STS-003 · 5 devices', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Deprovision reason: Retiring from fleet'),
  ).toBeVisible();

  await expect(page.locator('.counter .value')).toHaveText([
    '4',
    '1',
    '0',
    '0',
    '0',
    '0',
    '0',
  ]);

  const rows = page.locator('.operations-table tbody tr');
  await expect(rows).toHaveCount(5);
  for (const row of await rows.all()) {
    await expect(row).toContainText('Deprovision');
    await expect(row).toContainText('Deprovisioned');
  }
  await expect(rows.nth(0)).toContainText('Active');
  await expect(rows.nth(0)).toContainText('Succeeded');
  await expect(rows.nth(3)).toContainText('Disabled');
  await expect(rows.nth(3)).toContainText('Succeeded');
  await expect(rows.nth(4)).toContainText('Failed');
  await expect(rows.nth(4)).toContainText(statusConflict);
  await expect(
    page.getByRole('button', { name: 'Show 1 needing attention' }),
  ).toBeVisible();
  await expect(page.locator('.activity p')).toHaveText(
    '2:16 PM · Google rejected the status change for 04XTBHJ (status-conflict).',
  );

  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: testInfo.outputPath('wpd-f2-10-deprovision-job.png'),
    fullPage: true,
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('offers Deprovision Reconcile only with devices:deprovision', async ({
  page,
}) => {
  const unknownDeprovision = operation({
    operationId: 'STS-003-1',
    deviceId: 'synthetic-device-1',
    serialNumber: '01P0T1V',
    operation: 'deprovision',
    baselineValue: 'ACTIVE',
    requestedValue: 'DEPROVISIONED',
    outcome: 'unknown',
    outcomeReason: 'invalid-response',
    googleStatus: null,
    verifiedBy: null,
    observedValue: null,
    commandId: null,
    commandState: null,
    commandExpiresAt: null,
    updatedAt: '2026-10-22T18:16:00.000Z',
  });

  await signIn(page, ['jobs:read', 'devices:read', 'devices:status']);
  await page.route('**/api/jobs/STS-003', (route) =>
    route.fulfill({ json: { ...deprovisionJob, status: 'needs-review' } }),
  );
  await page.route('**/api/jobs/STS-003/operations*', (route) =>
    route.fulfill({
      json: { operations: [unknownDeprovision], nextCursor: null },
    }),
  );
  await page.goto('/jobs/STS-003');
  await expect(page.locator('.operations-table tbody tr')).toContainText(
    'Unknown',
  );
  await expect(page.getByRole('button', { name: 'Reconcile' })).toHaveCount(0);

  await signIn(page, ['jobs:read', 'devices:read', 'devices:deprovision']);
  await page.route('**/api/jobs/STS-003', (route) =>
    route.fulfill({ json: { ...deprovisionJob, status: 'needs-review' } }),
  );
  await page.route('**/api/jobs/STS-003/operations*', (route) =>
    route.fulfill({
      json: { operations: [unknownDeprovision], nextCursor: null },
    }),
  );
  await page.goto('/jobs/STS-003');
  await expect(page.getByRole('button', { name: 'Reconcile' })).toBeVisible();
});

test('names the Wipe user data job and its command rows', async ({ page }) => {
  await signIn(page);
  await page.goto('/jobs/CMD-009');

  await expect(
    page.getByRole('heading', { name: 'Wipe user data', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Job CMD-009 · Completed')).toBeVisible();
  const row = page.locator('.operations-table tbody tr');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('Wipe user data');
  await expect(row).toContainText('—');
  await expect(row).toContainText('Succeeded');
  await expect(page.getByRole('button', { name: 'Reconcile' })).toHaveCount(0);
});

test('lists the three job actions in the Jobs Action filter', async ({
  page,
}, testInfo) => {
  await signIn(page);
  await page.goto('/jobs');
  await expect(page.getByText('CMD-008')).toBeVisible();

  await page.getByRole('button', { name: 'Add a filter' }).click();
  await page.getByRole('option', { name: 'Action', exact: true }).click();
  await expect(
    page.getByRole('checkbox', { name: 'Wipe user data', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('checkbox', { name: 'Powerwash devices', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('checkbox', { name: 'Deprovision devices', exact: true }),
  ).toBeVisible();

  await page
    .getByRole('checkbox', { name: 'Powerwash devices', exact: true })
    .check();
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(
    page.getByRole('button', {
      name: 'Action: Powerwash devices',
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByRole('cell', { name: /CMD-008/ })).toBeVisible();
  await expect(page.getByRole('cell', { name: /STS-003/ })).toHaveCount(0);

  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: testInfo.outputPath('wpd-f2-jobs-action-filter.png'),
    fullPage: true,
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

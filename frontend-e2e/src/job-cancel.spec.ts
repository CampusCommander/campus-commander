import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * The cancel states of the approved mockup, on a mocked API.
 * 01 to 07 are `docs/ui/designs/2026-10-26-job-cancel-0*.png`.
 * The two refresh questions come from the O1 ruling on card t_e31b9cb4.
 */

test.use({
  timezoneId: 'America/New_York',
  viewport: { width: 1440, height: 900 },
});

const customerId = 'C0123456';
const person = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  displayName: 'Review administrator',
};
const requester = 'Review administrator';

type UpdState = 'running' | 'requested' | 'cancelled';
type StsState = 'queued' | 'cancelled';

interface MockState {
  upd: UpdState;
  sts: StsState;
}

const scope = { kind: 'devices', deviceCount: 48 };

const summary = (overrides: Record<string, unknown>) => ({
  jobId: '0f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10',
  displayId: 'UPD-001',
  revision: 5,
  action: 'update-device-annotations',
  status: 'running',
  scope,
  requestedBy: person,
  createdAt: '2026-10-26T14:40:00.000Z',
  startedAt: '2026-10-26T14:40:00.000Z',
  finishedAt: null,
  progress: {
    total: 48,
    succeeded: 36,
    failed: 0,
    unknown: 0,
    skipped: 0,
    expired: 0,
    cancelled: 0,
    pending: 12,
  },
  cancelRequest: null,
  failure: null,
  ...overrides,
});

const stopSerialNumbers = [
  '02QJANY',
  '02A1MB6',
  '04XTBHJ',
  '0727D2E',
  '04A9BVS',
  '08V5B5S',
];

const beforeValues = [
  'North lab mvjusgh0',
  'North lab mvjusgh0',
  'Front Office',
  'Not set',
  'Not set',
  'Not set',
];

/** The six rows of operations page 7, before the request. */
const pendingRows = stopSerialNumbers.map((serialNumber, index) => ({
  operationId: `UPD-001-${37 + index}`,
  field: 'annotatedLocation',
  deviceId: `synthetic-device-${37 + index}`,
  serialNumber,
  orgUnitPath: '/Chrome Devices',
  operation: 'replace',
  baselineValue: beforeValues[index],
  requestedValue: 'North lab',
  outcome: 'pending',
  outcomeReason: null,
  googleStatus: null,
  googleReason: null,
  observedValue: null,
  verifiedBy: null,
  commandId: null,
  commandState: null,
  commandExpiresAt: null,
  commandExecutedAt: null,
  updatedAt: '2026-10-26T14:40:00.000Z',
}));

const stopRows = (state: UpdState) => {
  if (state === 'running') return pendingRows;
  const rows: Array<Record<string, unknown>> = pendingRows.map((row) => ({
    ...row,
  }));
  rows[0] = {
    ...rows[0],
    outcome: 'succeeded',
    outcomeReason: null,
    googleStatus: 200,
    observedValue: 'North lab',
    verifiedBy: 'write-response',
    updatedAt: '2026-10-26T14:42:00.000Z',
  };
  rows[1] = {
    ...rows[1],
    outcome: 'succeeded',
    outcomeReason: null,
    googleStatus: 200,
    observedValue: 'North lab',
    verifiedBy: 'write-response',
    updatedAt: '2026-10-26T14:42:00.000Z',
  };
  if (state === 'cancelled') {
    rows[2] = {
      ...rows[2],
      outcome: 'failed',
      outcomeReason: 'quota',
      googleStatus: 429,
      googleReason: 'Quota exceeded',
      updatedAt: '2026-10-26T14:42:00.000Z',
    };
    rows[3] = {
      ...rows[3],
      outcome: 'unknown',
      outcomeReason: null,
      updatedAt: '2026-10-26T14:43:00.000Z',
    };
    for (const index of [4, 5])
      rows[index] = {
        ...rows[index],
        outcome: 'cancelled',
        outcomeReason: 'cancel-requested',
        updatedAt: '2026-10-26T14:43:00.000Z',
      };
  }
  return rows;
};

/** The filler rows of operations pages 1 to 6. */
const fillerRows = (pageNumber: number) =>
  Array.from({ length: 6 }, (_, offset) => {
    const number = (pageNumber - 1) * 6 + offset + 1;
    return {
      operationId: `UPD-001-${number}`,
      field: 'annotatedLocation',
      deviceId: `synthetic-device-${number}`,
      serialNumber: `SYN-${String(number).padStart(3, '0')}`,
      orgUnitPath: '/Chrome Devices',
      operation: 'replace',
      baselineValue: 'North lab',
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
      updatedAt: '2026-10-26T14:41:00.000Z',
    };
  });

const cancelRequest = {
  at: '2026-10-26T14:42:00.000Z',
  by: person,
};

const updBase = {
  ...summary({}),
  confirmedBy: person,
  previewDisplayId: 'PV-001',
  changes: [
    { field: 'annotatedLocation', mode: 'replace', value: 'North lab' },
  ],
  commandType: null,
  statusAction: null,
  deprovisionReason: null,
  targetOrgUnitPaths: null,
  correlationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  latestActivity: {
    at: '2026-10-26T14:42:00.000Z',
    failed: { count: 0, operations: [] },
    unknown: { count: 0, operations: [] },
  },
};

const updDetail = (state: UpdState) => {
  const base = { ...updBase };
  if (state === 'running') return base;
  const requested = {
    ...base,
    revision: 6,
    progress: {
      total: 48,
      succeeded: 38,
      failed: 0,
      unknown: 0,
      skipped: 0,
      expired: 0,
      cancelled: 0,
      pending: 10,
    },
    cancelRequest,
    latestActivity: {
      at: '2026-10-26T14:42:00.000Z',
      failed: { count: 0, operations: [] },
      unknown: { count: 0, operations: [] },
    },
  };
  if (state === 'requested') return requested;
  return {
    ...requested,
    revision: 7,
    status: 'cancelled',
    finishedAt: '2026-10-26T14:42:58.000Z',
    progress: {
      total: 48,
      succeeded: 38,
      failed: 1,
      unknown: 1,
      skipped: 0,
      expired: 0,
      cancelled: 8,
      pending: 0,
    },
    latestActivity: {
      at: '2026-10-26T14:43:00.000Z',
      failed: {
        count: 1,
        operations: [
          {
            operationId: 'UPD-001-39',
            deviceId: 'synthetic-device-39',
            serialNumber: '04XTBHJ',
            outcomeReason: 'quota',
            googleStatus: 429,
            googleReason: 'Quota exceeded',
            updatedAt: '2026-10-26T14:42:00.000Z',
          },
        ],
      },
      unknown: {
        count: 1,
        operations: [
          {
            operationId: 'UPD-001-40',
            deviceId: 'synthetic-device-40',
            serialNumber: '0727D2E',
            updatedAt: '2026-10-26T14:43:00.000Z',
          },
        ],
      },
    },
  };
};

const stsScope = { kind: 'devices', deviceCount: 18 };

const stsBase = {
  jobId: '1f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10',
  displayId: 'STS-001',
  revision: 3,
  action: 'disable-devices',
  status: 'queued',
  scope: stsScope,
  requestedBy: person,
  createdAt: '2026-10-26T14:41:00.000Z',
  startedAt: null,
  finishedAt: null,
  progress: {
    total: 18,
    succeeded: 0,
    failed: 0,
    unknown: 0,
    skipped: 0,
    expired: 0,
    cancelled: 0,
    pending: 18,
  },
  cancelRequest: null,
  failure: null,
  confirmedBy: person,
  previewDisplayId: 'PV-001',
  changes: [
    { field: 'annotatedLocation', mode: 'replace', value: 'North lab' },
  ],
  commandType: null,
  statusAction: 'disable',
  deprovisionReason: null,
  targetOrgUnitPaths: null,
  correlationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  latestActivity: {
    at: '2026-10-26T14:41:00.000Z',
    failed: { count: 0, operations: [] },
    unknown: { count: 0, operations: [] },
  },
};

const stsDetail = (state: StsState) => {
  if (state === 'queued') return { ...stsBase };
  return {
    ...stsBase,
    revision: 4,
    status: 'cancelled',
    finishedAt: '2026-10-26T14:41:00.000Z',
    progress: {
      total: 18,
      succeeded: 0,
      failed: 0,
      unknown: 0,
      skipped: 0,
      expired: 0,
      cancelled: 18,
      pending: 0,
    },
    cancelRequest: { at: '2026-10-26T14:41:00.000Z', by: person },
  };
};

const stsSerials = [
  '01P0T1V',
  '02A1MB6',
  '02QJANY',
  '04A9BVS',
  '04XTBHJ',
  '08V5B5S',
];

const stsRows = (state: StsState) =>
  stsSerials.map((serialNumber, index) => ({
    operationId: `STS-001-${index + 1}`,
    field: null,
    deviceId: `synthetic-device-${index + 1}`,
    serialNumber,
    orgUnitPath: '/Chrome Devices',
    operation: 'disable',
    baselineValue: 'ACTIVE',
    requestedValue: 'DISABLED',
    outcome: state === 'queued' ? 'pending' : 'cancelled',
    outcomeReason: state === 'queued' ? null : 'cancel-requested',
    googleStatus: null,
    googleReason: null,
    observedValue: null,
    verifiedBy: null,
    commandId: null,
    commandState: null,
    commandExpiresAt: null,
    commandExecutedAt: null,
    updatedAt: '2026-10-26T14:41:00.000Z',
  }));

const refreshAll = {
  jobId: '2f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10',
  displayId: 'REF-001',
  revision: 2,
  action: 'refresh-inventory',
  status: 'running',
  scope: { kind: 'all-devices', deviceCount: null },
  requestedBy: person,
  createdAt: '2026-10-26T14:30:00.000Z',
  startedAt: '2026-10-26T14:30:00.000Z',
  finishedAt: null,
  progress: {
    total: null,
    succeeded: 600,
    failed: 0,
    unknown: 0,
    skipped: 0,
    expired: 0,
    cancelled: 0,
    pending: null,
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
  correlationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  latestActivity: {
    at: '2026-10-26T14:42:00.000Z',
    failed: { count: 0, operations: [] },
    unknown: { count: 0, operations: [] },
  },
};

const refreshSelected = {
  ...refreshAll,
  jobId: '3f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10',
  displayId: 'REF-002',
  scope: { kind: 'devices', deviceCount: 1000 },
  progress: {
    total: 1000,
    succeeded: 250,
    failed: 0,
    unknown: 0,
    skipped: 0,
    expired: 0,
    cancelled: 0,
    pending: 750,
  },
  correlationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
};

const listRows = [
  summary({
    jobId: '1f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10',
    displayId: 'STS-001',
    revision: 4,
    action: 'disable-devices',
    status: 'cancelled',
    scope: stsScope,
    createdAt: '2026-10-26T14:41:00.000Z',
    startedAt: null,
    finishedAt: '2026-10-26T14:41:00.000Z',
    progress: {
      total: 18,
      succeeded: 0,
      failed: 0,
      unknown: 0,
      skipped: 0,
      expired: 0,
      cancelled: 18,
      pending: 0,
    },
    cancelRequest,
  }),
  summary({
    revision: 7,
    status: 'cancelled',
    createdAt: '2026-10-26T14:40:00.000Z',
    finishedAt: '2026-10-26T14:43:00.000Z',
    progress: {
      total: 48,
      succeeded: 38,
      failed: 1,
      unknown: 1,
      skipped: 0,
      expired: 0,
      cancelled: 8,
      pending: 0,
    },
    cancelRequest,
  }),
  summary({
    jobId: '2f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10',
    displayId: 'REF-001',
    revision: 2,
    action: 'refresh-inventory',
    status: 'completed',
    scope: { kind: 'all-devices', deviceCount: null },
    createdAt: '2026-10-22T05:21:00.000Z',
    startedAt: '2026-10-22T05:21:00.000Z',
    finishedAt: '2026-10-22T05:22:00.000Z',
    progress: {
      total: null,
      succeeded: 600,
      failed: 0,
      unknown: 0,
      skipped: 0,
      expired: 0,
      cancelled: 0,
      pending: null,
    },
  }),
  summary({
    jobId: '3f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10',
    displayId: 'CMD-005',
    revision: 2,
    action: 'reboot-devices',
    status: 'completed-with-errors',
    scope: { kind: 'devices', deviceCount: 2 },
    createdAt: '2026-10-22T05:26:00.000Z',
    startedAt: '2026-10-22T05:26:00.000Z',
    finishedAt: '2026-10-22T05:27:11.000Z',
    progress: {
      total: 2,
      succeeded: 1,
      failed: 1,
      unknown: 0,
      skipped: 0,
      expired: 0,
      cancelled: 0,
      pending: 0,
    },
  }),
  summary({
    jobId: '4f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10',
    displayId: 'CMD-004',
    revision: 2,
    action: 'reboot-devices',
    status: 'failed',
    scope: { kind: 'devices', deviceCount: 1 },
    createdAt: '2026-10-22T05:25:40.000Z',
    startedAt: '2026-10-22T05:25:40.000Z',
    finishedAt: '2026-10-22T05:26:00.000Z',
    progress: {
      total: 1,
      succeeded: 0,
      failed: 0,
      unknown: 0,
      skipped: 0,
      expired: 1,
      cancelled: 0,
      pending: 0,
    },
  }),
  summary({
    jobId: '5f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10',
    displayId: 'CMD-003',
    revision: 2,
    action: 'reboot-devices',
    status: 'needs-review',
    scope: { kind: 'devices', deviceCount: 1 },
    createdAt: '2026-10-22T05:25:30.000Z',
    startedAt: '2026-10-22T05:25:30.000Z',
    finishedAt: '2026-10-22T05:25:30.000Z',
    progress: {
      total: 1,
      succeeded: 0,
      failed: 0,
      unknown: 1,
      skipped: 0,
      expired: 0,
      cancelled: 0,
      pending: 0,
    },
  }),
  summary({
    jobId: '6f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10',
    displayId: 'CMD-002',
    revision: 2,
    action: 'reboot-devices',
    status: 'needs-review',
    scope: { kind: 'devices', deviceCount: 1 },
    createdAt: '2026-10-22T05:25:20.000Z',
    startedAt: '2026-10-22T05:25:20.000Z',
    finishedAt: '2026-10-22T05:25:30.000Z',
    progress: {
      total: 1,
      succeeded: 0,
      failed: 0,
      unknown: 1,
      skipped: 0,
      expired: 0,
      cancelled: 0,
      pending: 0,
    },
  }),
  summary({
    jobId: '7f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10',
    displayId: 'CMD-001',
    revision: 2,
    action: 'reboot-devices',
    status: 'failed',
    scope: { kind: 'devices', deviceCount: 2 },
    createdAt: '2026-10-22T05:24:20.000Z',
    startedAt: '2026-10-22T05:24:20.000Z',
    finishedAt: '2026-10-22T05:25:32.000Z',
    progress: {
      total: 2,
      succeeded: 0,
      failed: 2,
      unknown: 0,
      skipped: 0,
      expired: 0,
      cancelled: 0,
      pending: 0,
    },
  }),
];

async function signIn(
  page: Page,
  state: MockState,
  theme: 'light' | 'dark' = 'light',
) {
  await page.route('**/api/**', async (route: Route) => {
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
            grants: [
              ...[
                'jobs:read',
                'jobs:manage',
                'devices:read',
                'devices:write',
                'customer:read',
                'connection:read',
                'schools:read',
                'security-events:read',
                'connection:diagnose',
              ].map((action) => ({
                action,
                scope: { kind: 'district' as const, customerId },
              })),
              {
                action: 'platform-users:read',
                scope: { kind: 'platform' as const },
              },
            ],
            preferences: { theme, navigationCollapsed: false },
          },
          csrfToken: 'a'.repeat(64),
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        },
      });
    if (path === '/api/google-connection')
      return route.fulfill({
        json: {
          connection: {
            customerId,
            generation: 1,
            observation: {
              customerId,
              primaryDomain: 'example.org',
              domains: [
                {
                  name: 'example.org',
                  primary: true,
                  verified: true,
                  aliases: [],
                },
              ],
            },
            observedAt: '2026-10-26T14:42:00.000Z',
            confirmedAt: '2026-10-26T14:42:00.000Z',
            clientId: '100000000000000000001',
            subject: 'reviewer@example.org',
          },
        },
      });
    if (path === '/api/google-connection/health')
      return route.fulfill({
        json: {
          health: {
            connectionState: 'active',
            customerId,
            generation: 1,
            observedAt: '2026-10-26T14:42:00.000Z',
            backgroundFailure: null,
            check: null,
            capabilities: [
              'customer-identity',
              'domain-observations',
              'school-ou-references',
              'device-inventory',
              'device-telemetry',
              'device-changes',
            ].map((capability) => ({
              capability,
              scopeVerified: true,
              failure: null,
              checkedAt: '2026-10-26T14:30:00.000Z',
              lastSucceededAt: '2026-10-26T14:30:00.000Z',
              correlationId: null,
            })),
          },
        },
      });
    if (path === '/api/jobs/events')
      return route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: '',
      });
    if (path === '/api/jobs/activity')
      return route.fulfill({
        json: {
          running: {
            count: state.upd === 'cancelled' ? 0 : 1,
            jobs: state.upd === 'cancelled' ? [] : [summary({})],
          },
          waiting: { count: 0, jobs: [] },
          recent: { count: 0, jobs: [], nextExpiryAt: null },
          attention:
            state.upd === 'cancelled' || state.sts === 'cancelled'
              ? true
              : false,
          seenAt: null,
          observedAt: '2026-10-26T14:44:00.000Z',
        },
      });
    if (path === '/api/jobs' && route.request().method() === 'GET')
      return route.fulfill({
        json: {
          jobs: listRows,
          matching: listRows.length,
          nextCursor: null,
          observedAt: '2026-10-26T14:44:00.000Z',
        },
      });
    if (path === '/api/jobs/UPD-001' && route.request().method() === 'GET')
      return route.fulfill({ json: updDetail(state.upd) });
    if (path === '/api/jobs/UPD-001/cancel') {
      state.upd = 'requested';
      return route.fulfill({ json: updDetail('requested') });
    }
    if (path === '/api/jobs/UPD-001/operations') {
      const cursor = url.searchParams.get('cursor');
      if (!cursor)
        return route.fulfill({
          json: { operations: fillerRows(1), nextCursor: '2' },
        });
      const pageNumber = Number(cursor);
      if (pageNumber >= 2 && pageNumber <= 6)
        return route.fulfill({
          json: {
            operations: fillerRows(pageNumber),
            nextCursor: pageNumber === 6 ? '7' : String(pageNumber + 1),
          },
        });
      return route.fulfill({
        json: { operations: stopRows(state.upd), nextCursor: null },
      });
    }
    if (path === '/api/jobs/STS-001' && route.request().method() === 'GET')
      return route.fulfill({ json: stsDetail(state.sts) });
    if (path === '/api/jobs/STS-001/cancel') {
      state.sts = 'cancelled';
      return route.fulfill({ json: stsDetail('cancelled') });
    }
    if (path === '/api/jobs/STS-001/operations')
      return route.fulfill({
        json: {
          operations: stsRows(state.sts),
          nextCursor: url.searchParams.get('cursor') ? null : '2',
        },
      });
    if (path === '/api/jobs/REF-001')
      return route.fulfill({ json: refreshAll });
    if (path === '/api/jobs/REF-002')
      return route.fulfill({ json: refreshSelected });
    if (path === '/api/jobs/REF-001/operations')
      return route.fulfill({ json: { operations: [], nextCursor: null } });
    if (path === '/api/jobs/REF-002/operations')
      return route.fulfill({ json: { operations: [], nextCursor: null } });
    if (path === '/api/customer')
      return route.fulfill({ json: { customer: null } });
    return route.fulfill({ json: {} });
  });
}

/** Page 7 of the operations holds the six rows that the mockup shows. */
async function goToOperationsPage7(page: Page) {
  const next = page.getByRole('button', { name: 'Next operations page' });
  for (const footer of [
    'Rows 7–12 of 48 operations',
    'Rows 13–18 of 48 operations',
    'Rows 19–24 of 48 operations',
    'Rows 25–30 of 48 operations',
    'Rows 31–36 of 48 operations',
    'Rows 37–42 of 48 operations',
  ]) {
    await next.click();
    await expect(page.locator('.footer-count')).toHaveText(footer);
  }
}

/** Freezes the browser clock so a running duration matches the mockup. */
async function freeze(page: Page, iso: string) {
  await page.clock.setFixedTime(new Date(iso));
}

async function top(page: Page) {
  await page.evaluate(() => window.scrollTo(0, 0));
}

async function openCancelQuestion(page: Page) {
  await page.locator('#cancel-job').click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

test('state 01: the running job offers Cancel pending work', async ({
  page,
}, testInfo) => {
  const state: MockState = { upd: 'running', sts: 'queued' };
  await freeze(page, '2026-10-26T14:42:08Z');
  await signIn(page, state);
  await page.goto('/jobs/UPD-001');
  await expect(page.getByText('Job UPD-001 · Running')).toBeVisible();
  await expect(page.locator('#cancel-job')).toHaveText('Cancel pending work');
  await goToOperationsPage7(page);
  await expect(page.getByText('02QJANY', { exact: true })).toBeVisible();
  await top(page);
  await page.screenshot({
    path: testInfo.outputPath('01-running-job.png'),
  });
  await page.screenshot({
    path: testInfo.outputPath('01-running-job-full.png'),
    fullPage: true,
  });
});

test('state 02 and 03: the running question, then Cancellation requested', async ({
  page,
}, testInfo) => {
  const state: MockState = { upd: 'running', sts: 'queued' };
  await freeze(page, '2026-10-26T14:42:27Z');
  await signIn(page, state);
  await page.goto('/jobs/UPD-001');
  await goToOperationsPage7(page);
  await top(page);

  const dialog = await openCancelQuestion(page);
  await expect(
    dialog.getByRole('heading', {
      name: 'Cancel pending work on UPD-001?',
    }),
  ).toBeVisible();
  await expect(dialog.locator('#cancel-question-one')).toHaveText(
    '12 of 48 operations are pending. Those that have not reached Google end Cancelled and never run.',
  );
  await expect(dialog.locator('#cancel-question-two')).toHaveText(
    'Requests already sent to Google finish and keep their results. The 36 confirmed updates stay. Nothing rolls back.',
  );
  await page.screenshot({
    path: testInfo.outputPath('02-cancel-confirm-running.png'),
  });

  // Escape returns focus to the control (UI-09).
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.locator('#cancel-job')).toBeFocused();

  await openCancelQuestion(page);
  await dialog.getByRole('button', { name: 'Cancel pending work' }).click();
  const requested = page.locator('#cancel-job');
  await expect(requested).toHaveText('Cancellation requested');
  await expect(requested).toHaveAttribute('aria-disabled', 'true');
  await expect(requested).toBeFocused();
  await expect(
    page.getByText('Cancellation requested · The job stops within 30 seconds'),
  ).toBeVisible();
  await expect(
    page.getByText(`Cancellation requested by ${requester} · Oct 26, 10:42 AM`),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('03-cancellation-requested.png'),
  });
  await page.screenshot({
    path: testInfo.outputPath('03-cancellation-requested-full.png'),
    fullPage: true,
  });
});

test('state 04: the cancelled result keeps every earlier outcome', async ({
  page,
}, testInfo) => {
  const state: MockState = { upd: 'cancelled', sts: 'queued' };
  await freeze(page, '2026-10-26T14:43:38Z');
  await signIn(page, state);
  await page.goto('/jobs/UPD-001');
  await expect(page.getByText('Job UPD-001 · Cancelled')).toBeVisible();
  await goToOperationsPage7(page);

  const counter = (label: string) =>
    page.locator('.counter').filter({ hasText: label });
  await expect(counter('Succeeded')).toContainText('38');
  await expect(counter('Failed')).toContainText('1');
  await expect(counter('Unknown')).toContainText('1');
  await expect(counter('Pending')).toContainText('0');
  await expect(counter('Cancelled')).toContainText('8');
  await expect(page.getByText('Not sent to Google')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Reconcile' })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Show 2 needing attention' }),
  ).toBeVisible();
  await expect(
    page.getByText(
      '10:43 AM · Cancellation stopped 8 operations before they reached Google. Google quota stopped the update for 04XTBHJ. 0727D2E requires reconciliation before any retry.',
    ),
  ).toBeVisible();
  await top(page);
  await page.screenshot({
    path: testInfo.outputPath('04-cancelled-result.png'),
  });
  await page.screenshot({
    path: testInfo.outputPath('04-cancelled-result-full.png'),
    fullPage: true,
  });
});

test('state 05: the queued job asks before it ends at once', async ({
  page,
}, testInfo) => {
  const state: MockState = { upd: 'running', sts: 'queued' };
  await freeze(page, '2026-10-26T14:41:20Z');
  await signIn(page, state);
  await page.goto('/jobs/STS-001');
  await expect(page.getByText('Job STS-001 · Queued')).toBeVisible();
  await top(page);

  const dialog = await openCancelQuestion(page);
  await expect(
    dialog.getByRole('heading', { name: 'Cancel pending work on STS-001?' }),
  ).toBeVisible();
  await expect(dialog.locator('#cancel-question-one')).toHaveText(
    'No operation has started. All 18 operations end Cancelled.',
  );
  await expect(dialog.locator('#cancel-question-two')).toHaveText(
    'No request reaches Google. The 18 devices keep their current status.',
  );
  await expect(
    dialog.getByRole('button', { name: 'Keep job waiting' }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('05-queued-confirm.png'),
  });
});

test('state 06: the queued job ends cancelled before it starts', async ({
  page,
}, testInfo) => {
  const state: MockState = { upd: 'running', sts: 'cancelled' };
  await freeze(page, '2026-10-26T14:41:00Z');
  await signIn(page, state);
  await page.goto('/jobs/STS-001');
  await expect(page.getByText('Job STS-001 · Cancelled')).toBeVisible();
  await expect(
    page.getByText(`Cancellation requested by ${requester} · Oct 26, 10:41 AM`),
  ).toBeVisible();
  await expect(
    page.locator('.counter').filter({ hasText: 'Cancelled' }),
  ).toContainText('18');
  await expect(
    page.getByText(
      '10:41 AM · Cancellation ended the job before it started. No request reached Google.',
    ),
  ).toBeVisible();
  await top(page);
  await page.screenshot({
    path: testInfo.outputPath('06-queued-job-cancelled.png'),
  });
  await page.screenshot({
    path: testInfo.outputPath('06-queued-job-cancelled-full.png'),
    fullPage: true,
  });
});

test('state 07: the Jobs grid shows the cancelled rows', async ({
  page,
}, testInfo) => {
  const state: MockState = { upd: 'cancelled', sts: 'cancelled' };
  await freeze(page, '2026-10-26T14:44:00Z');
  await signIn(page, state);
  await page.goto('/jobs');
  await expect(page.getByRole('cell', { name: 'STS-001' })).toBeVisible();
  await expect(
    page.getByRole('row', { name: /STS-001/ }).getByText('18 cancelled'),
  ).toBeVisible();
  await expect(
    page
      .getByRole('row', { name: /UPD-001/ })
      .getByText('1 failed · 1 unknown · 8 cancelled'),
  ).toBeVisible();
  await expect(
    page.getByText('8 jobs · Updated Oct 26, 10:44 AM'),
  ).toBeVisible();
  await top(page);
  await page.screenshot({
    path: testInfo.outputPath('07-jobs-grid-cancelled.png'),
  });
  await page.screenshot({
    path: testInfo.outputPath('07-jobs-grid-cancelled-full.png'),
    fullPage: true,
  });
});

test('the question and the requested banner hold in the dark theme', async ({
  page,
}, testInfo) => {
  const state: MockState = { upd: 'running', sts: 'queued' };
  await freeze(page, '2026-10-26T14:42:27Z');
  await signIn(page, state, 'dark');
  await page.goto('/jobs/UPD-001');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  const dialog = await openCancelQuestion(page);
  await top(page);
  await page.screenshot({
    path: testInfo.outputPath('10-dark-cancel-question.png'),
  });
  await dialog.getByRole('button', { name: 'Cancel pending work' }).click();
  await expect(page.locator('#cancel-job')).toHaveText(
    'Cancellation requested',
  );
  await page.screenshot({
    path: testInfo.outputPath('11-dark-cancellation-requested.png'),
  });
});

test('the refresh-all question names the devices read', async ({
  page,
}, testInfo) => {
  const state: MockState = { upd: 'running', sts: 'queued' };
  await freeze(page, '2026-10-26T14:42:00Z');
  await signIn(page, state);
  await page.goto('/jobs/REF-001');
  await expect(page.getByText('Job REF-001 · Running')).toBeVisible();
  await top(page);

  const dialog = await openCancelQuestion(page);
  await expect(
    dialog.getByRole('heading', { name: 'Cancel pending work on REF-001?' }),
  ).toBeVisible();
  await expect(dialog.locator('#cancel-question-one')).toHaveText(
    'The refresh has read 600 devices. It stops at its next page.',
  );
  await expect(dialog.locator('#cancel-question-two')).toHaveText(
    'It saves none of this refresh and marks no device removed. The inventory keeps its earlier data.',
  );
  await page.screenshot({
    path: testInfo.outputPath('08-refresh-all-question.png'),
  });
});

test('the selected-device refresh question names the batches', async ({
  page,
}, testInfo) => {
  const state: MockState = { upd: 'running', sts: 'queued' };
  await freeze(page, '2026-10-26T14:42:00Z');
  await signIn(page, state);
  await page.goto('/jobs/REF-002');
  await expect(page.getByText('Job REF-002 · Running')).toBeVisible();
  await top(page);

  const dialog = await openCancelQuestion(page);
  await expect(
    dialog.getByRole('heading', { name: 'Cancel pending work on REF-002?' }),
  ).toBeVisible();
  await expect(dialog.locator('#cancel-question-one')).toHaveText(
    '250 of 1,000 devices are read. The refresh stops at its next batch.',
  );
  await expect(dialog.locator('#cancel-question-two')).toHaveText(
    'Devices already read keep their new data. The other devices keep their earlier data.',
  );
  await page.screenshot({
    path: testInfo.outputPath('09-refresh-selected-question.png'),
  });
});

import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { installLiveStreams, liveStreams } from './live-streams';

const customerId = 'C0123456';
const now = Date.now();
const observedAt = new Date(now - 60_000).toISOString();
const startedAt = new Date(now - 128_000).toISOString();
const person = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  displayName: 'District operator',
};
const grants = [
  'jobs:read',
  'devices:read',
  'devices:write',
  'devices:bulk-actions',
  'devices:commands',
  'devices:status',
].map((action) => ({
  action,
  scope: { kind: 'district', customerId },
}));

const jobSummary = {
  jobId: '0f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10',
  displayId: 'UPD-014',
  revision: 3,
  action: 'update-device-annotations',
  status: 'running',
  scope: { kind: 'devices', deviceCount: 48 },
  requestedBy: person,
  createdAt: startedAt,
  startedAt,
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
  phase: null,
  exportSummary: null,
  importSummary: null,
};

const jobDetail = {
  ...jobSummary,
  confirmedBy: person,
  previewDisplayId: 'PV-014',
  changes: [
    { field: 'annotatedLocation', mode: 'replace', value: 'North lab' },
  ],
  commandType: null,
  statusAction: null,
  deprovisionReason: null,
  targetOrgUnitPaths: ['/School A'],
  correlationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  latestActivity: {
    at: new Date(now - 10_000).toISOString(),
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
};

const deviceRows = [
  {
    deviceId: 'synthetic-device-1',
    serialNumber: 'C0A1-0001',
    model: 'Lenovo 100e Gen 4',
    assetTag: 'HS-0401',
    orgUnitPath: '/School A',
    lastContact: new Date(now - 120_000).toISOString(),
    annotatedLocation: null,
    annotatedUser: null,
    notes: null,
    status: 'ACTIVE',
    battery: {
      status: 'reported',
      health: 'normal',
      capacityPercent: 91,
      reportedAt: new Date(now - 90_000).toISOString(),
    },
    lastEntitySync: observedAt,
    stale: false,
  },
];

/** Every answer that the shell, the Jobs pages, and the Devices page request. */
async function mockApi(page: Page) {
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
            grants,
            preferences: { theme: 'light', navigationCollapsed: false },
          },
          csrfToken: 'a'.repeat(64),
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        },
      });
    if (path === '/api/auth/preferences')
      return route.fulfill({ json: route.request().postDataJSON() });
    if (path === '/api/jobs/activity')
      return route.fulfill({
        json: {
          running: { count: 1, jobs: [jobSummary] },
          waiting: { count: 0, jobs: [] },
          recent: { count: 0, jobs: [], nextExpiryAt: null },
          attention: false,
          seenAt: null,
          observedAt,
        },
      });
    if (path === '/api/jobs')
      return route.fulfill({
        json: { jobs: [jobSummary], matching: 1, nextCursor: null, observedAt },
      });
    if (path === '/api/jobs/UPD-014') return route.fulfill({ json: jobDetail });
    if (path === '/api/jobs/UPD-014/operations')
      return route.fulfill({ json: { operations: [], nextCursor: null } });
    if (path === '/api/devices/sync')
      return route.fulfill({
        json: {
          sync: {
            customerId,
            generation: 1,
            status: 'ready',
            observedAt,
            deviceCount: deviceRows.length,
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
            rows: deviceRows,
            matching: deviceRows.length,
            total: deviceRows.length,
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
    if (path === '/api/customer')
      return route.fulfill({ json: { customer: null } });
    if (path === '/api/google-connection')
      return route.fulfill({ json: { connection: null } });
    if (path === '/api/google-connection/health')
      return route.fulfill({ json: { health: null } });
    return route.fulfill({ status: 404, json: {} });
  });
}

async function shot(page: Page, testInfo: TestInfo, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: testInfo.outputPath(name),
    fullPage: true,
  });
}

test('holds one connection on every page and none in a hidden tab', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await installLiveStreams(page);
  await mockApi(page);

  await page.goto('/jobs');
  await expect(page.getByRole('cell', { name: /UPD-014/ })).toBeVisible();
  await expect
    .poll(async () => liveStreams(page).openUrls())
    .toEqual(['/api/events']);
  await shot(page, testInfo, 'live-feeds-jobs.png');

  await page.goto('/jobs/UPD-014');
  await expect(
    page.getByRole('heading', { name: 'UPD-014 · 48 devices', exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () => liveStreams(page).openUrls())
    .toEqual(['/api/events']);
  await shot(page, testInfo, 'live-feeds-job-detail.png');

  await page.goto('/devices');
  await expect(
    page.getByRole('gridcell', { name: 'C0A1-0001', exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () => liveStreams(page).openUrls())
    .toEqual(['/api/events']);
  await shot(page, testInfo, 'live-feeds-devices.png');

  // A hidden tab holds no connection. The service keeps its subscribers.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(async () => liveStreams(page).openUrls()).toEqual([]);

  // A visible tab opens the feed again.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect
    .poll(async () => liveStreams(page).openUrls())
    .toEqual(['/api/events']);
});

/**
 * A real server sends a keepalive `ping` every 25 seconds. The app closes a stream that
 * receives no event for 60 seconds, pings included, and replaces it 5 seconds later. A
 * silent fake would therefore be replaced by the app, and a spec that waits past 65
 * seconds would see another `by-ids` read. The construction history shows that
 * replacement, which an open-count snapshot alone hides.
 */
test('keeps the idle feed mounted past the app watchdog', async ({ page }) => {
  test.setTimeout(120_000);
  const nativeEventRequests: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path === '/api/events') nativeEventRequests.push(path);
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await installLiveStreams(page);
  await mockApi(page);

  await page.goto('/devices');
  await expect(
    page.getByRole('gridcell', { name: 'C0A1-0001', exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () => liveStreams(page).openUrls())
    .toEqual(['/api/events']);

  // Past the 60-second idle timeout and the 5-second reopen delay that follows it.
  await page.waitForTimeout(65_500);

  // The one feed still holds its first stream: one construction, no native request.
  expect(await liveStreams(page).openUrls()).toEqual(['/api/events']);
  expect(await liveStreams(page).constructions()).toEqual(['/api/events']);
  expect(nativeEventRequests).toEqual([]);
});

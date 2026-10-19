import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const customerId = 'C0123456';
const observedAt = '2026-10-19T12:00:00.000Z';
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
  annotatedLocation: null,
  notes: null,
  battery: {
    status: 'reported',
    health: 'normal',
    capacityPercent: 91,
    reportedAt: '2026-10-19T11:00:00Z',
  },
  lastEntitySync: observedAt,
  stale: false,
}));

/** The draft page needs the session, the selection spec, and the write access state. */
async function signIn(
  page: Page,
  expiredAt: string | null = null,
  selectedCount = 6000,
) {
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
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
    if (path === '/api/devices/selection')
      return route.fulfill({
        json: {
          selection: {
            terms: [],
            groups: [],
            added: selectedCount,
            excluded: 0,
            selectedCount,
            expiredAt,
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
          page: {
            rows,
            matching: rows.length,
            total: rows.length,
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
          checkedAt: '2026-10-19T12:00:00.000Z',
        },
      });
    if (path === '/api/customer')
      return route.fulfill({ json: { customer: null } });
    if (path === '/api/google-connection')
      return route.fulfill({ json: { connection: null } });
    if (path === '/api/google-connection/health')
      return route.fulfill({ json: { health: null } });
    if (path === '/api/auth/preferences') return route.fulfill({ json: {} });
    return route.fulfill({ status: 404, json: {} });
  });
}

test('updates a draft in place and restores it after a reload', async ({
  page,
}, testInfo) => {
  await signIn(page);
  await page.goto('/devices/update');
  await expect(
    page.getByRole('heading', { name: 'Update 6,000 devices', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('6,000 devices · 0 changed fields · Not submitted', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByLabel('Organization unit')).toHaveCount(0);

  const value = page.getByLabel('Annotated location');
  await value.fill('North lab');
  await expect(
    page.getByText('6,000 devices · 1 changed field · Not submitted', {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByLabel('Change mode').click();
  await page.getByRole('option', { name: 'Clear value', exact: true }).click();
  await expect(value).toHaveJSProperty('readOnly', true);

  await page.reload();
  await expect(value).toHaveValue('North lab');
  await expect(page.getByLabel('Change mode')).toContainText('Clear value');

  await page.setViewportSize({ width: 1280, height: 960 });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: testInfo.outputPath('device-update-draft.png'),
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

test('opens Bulk Actions with only Update device and reaches the draft', async ({
  page,
}, testInfo) => {
  await signIn(page, null, 6);
  await page.goto('/devices');
  await expect(
    page.getByRole('heading', { name: 'Devices', exact: true }),
  ).toBeVisible();
  const bulk = page.getByRole('button', { name: 'Bulk Actions', exact: true });
  await expect(bulk).toBeEnabled();
  await bulk.click();
  const item = page.getByRole('menuitem', {
    name: 'Update device',
    exact: true,
  });
  await expect(item).toBeVisible();
  await expect(page.getByRole('menuitem')).toHaveCount(1);
  await expect(page.locator('.mat-mdc-menu-panel')).toHaveCSS('opacity', '1');
  await page.screenshot({
    path: testInfo.outputPath('devices-bulk-actions.png'),
    fullPage: true,
  });
  await item.click();
  await expect(
    page.getByRole('heading', { name: 'Update 6 devices', exact: true }),
  ).toBeVisible();
});

test('shows the expired selection without losing the draft', async ({
  page,
}, testInfo) => {
  await signIn(page, '2026-10-19T11:00:00.000Z');
  await page.goto('/devices/update');
  await expect(
    page.getByRole('heading', { name: 'Selection expired', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', {
      name: 'Select the devices again',
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText(
      'The browsing selection expired. Approved jobs and their frozen targets remain available.',
      { exact: true },
    ),
  ).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 960 });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: testInfo.outputPath('device-update-expired.png'),
    fullPage: true,
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

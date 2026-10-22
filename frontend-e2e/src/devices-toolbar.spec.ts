import AxeBuilder from '@axe-core/playwright';
import {
  expect,
  test,
  type Locator,
  type Page,
  type TestInfo,
} from '@playwright/test';
import { devicePageSchema } from '@campus/application-contracts';

const customerId = 'C0123456';
const observedAt = '2026-10-19T12:00:00.000Z';
const grants = [
  { action: 'devices:read', scope: { kind: 'district', customerId } },
  { action: 'devices:write', scope: { kind: 'district', customerId } },
  { action: 'devices:bulk-actions', scope: { kind: 'district', customerId } },
  { action: 'connection:diagnose', scope: { kind: 'district', customerId } },
];
const rows = Array.from({ length: 6 }, (_, index) => ({
  deviceId: `synthetic-device-${index + 1}`,
  serialNumber: `C0A1-000${index + 1}`,
  model: 'Lenovo 100e Gen 4',
  assetTag: `HS-040${index + 1}`,
  orgUnitPath: '/School A',
  lastContact: '2026-10-19T11:58:00Z',
  annotatedLocation: null,
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

/** The state after Refresh Domain starts the full sync. */
const running = {
  customerId,
  generation: 1,
  status: 'running',
  observedAt,
  deviceCount: rows.length,
  failure: null,
  telemetryFailure: null,
  startedAt: '2026-10-20T12:00:00.000Z',
  checkedAt: null,
  stale: false,
};

interface SessionOptions {
  /** The server-side selection count. Refresh Selected disables at 0. */
  selectedCount?: number;
  /** The grants of the signed-in person. */
  grants?: typeof grants;
}

/** The Devices page needs the session, a published inventory, and the write access state. */
async function signIn(page: Page, options: SessionOptions = {}) {
  const selectedCount = options.selectedCount ?? rows.length;
  const sessionGrants = options.grants ?? grants;
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
            grants: sessionGrants,
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
            expiredAt: null,
          },
        },
      });
    if (path === '/api/devices/selection/refresh')
      return route.fulfill({
        status: 201,
        json: {
          refresh: {
            jobId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            selected: rows.length,
          },
        },
      });
    if (path === '/api/devices/domain/refresh')
      return route.fulfill({
        status: 201,
        json: {
          refresh: {
            sync: running,
            domain: { status: 'refreshed', reason: null },
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
          page: devicePageSchema.parse({
            rows,
            matching: rows.length,
            total: rows.length,
            observedAt,
            refreshJobId: null,
          }),
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
    if (path === '/api/auth/preferences')
      return route.fulfill({ json: route.request().postDataJSON() });
    return route.fulfill({ status: 404, json: {} });
  });
}

async function openDevices(page: Page, options: SessionOptions = {}) {
  await signIn(page, options);
  await page.goto('/devices');
  await expect(
    page.getByRole('heading', { name: 'Devices', exact: true }),
  ).toBeVisible();
  const refresh = page.getByRole('button', { name: 'Refresh', exact: true });
  const bulk = page.getByRole('button', {
    name: 'Bulk Actions',
    exact: true,
  });
  await expect(refresh).toBeVisible();
  await expect(bulk).toBeVisible();
  await expect(
    page.getByRole('gridcell', { name: 'C0A1-0001', exact: true }),
  ).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  return { refresh, bulk };
}

/** Reads the icon rotation in degrees from its computed transform. */
function rotation(icon: Locator) {
  return icon.evaluate((element) => {
    const matrix = new DOMMatrix(getComputedStyle(element).transform);
    return Math.round((Math.atan2(matrix.b, matrix.a) * 180) / Math.PI);
  });
}

async function openMenu(page: Page, trigger: Locator) {
  const target = trigger.locator('.mat-mdc-button-touch-target');
  const targetBox = await target.boundingBox();
  expect(targetBox).not.toBeNull();
  expect(targetBox!.height).toBeGreaterThanOrEqual(48);
  expect(targetBox!.width).toBeGreaterThanOrEqual(48);
  await trigger.click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  await expect(menu).toHaveCSS('opacity', '1');
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  return menu;
}

/** The menu opens 4 px below the trigger, aligned to the trigger's end edge. */
async function expectMenuPlacement(page: Page, trigger: Locator) {
  const menu = page.getByRole('menu');
  const triggerBox = await trigger.boundingBox();
  const menuBox = await menu.boundingBox();
  expect(triggerBox).not.toBeNull();
  expect(menuBox).not.toBeNull();
  expect(Math.round(menuBox!.y - (triggerBox!.y + triggerBox!.height))).toBe(4);
  expect(
    Math.round(
      triggerBox!.x + triggerBox!.width - (menuBox!.x + menuBox!.width),
    ),
  ).toBe(0);
  const width = page.viewportSize()!.width;
  expect(menuBox!.x).toBeGreaterThanOrEqual(0);
  expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(width);
}

async function screenshot(page: Page, testInfo: TestInfo, name: string) {
  await page.screenshot({
    path: testInfo.outputPath(name),
    fullPage: true,
  });
}

/** A focused screenshot of one control, with room for its surroundings. */
async function screenshotTarget(
  page: Page,
  testInfo: TestInfo,
  name: string,
  target: Locator,
  padding = 16,
) {
  // The footer sits below the fold when the page carries permission notes.
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error('The screenshot target is not visible.');
  await page.screenshot({
    path: testInfo.outputPath(name),
    clip: {
      x: Math.max(0, box.x - padding),
      y: Math.max(0, box.y - padding),
      width: box.width + padding * 2,
      height: box.height + padding * 2,
    },
  });
}

/**
 * Axe reports zero violations for the page and the open menu.
 * The CDK overlay container sits directly under body, outside the page landmarks, so the
 * best-practice region rule cannot pass for overlay content. Every other rule still checks
 * the menu.
 */
async function expectNoAxeViolations(page: Page) {
  const pageResults = await new AxeBuilder({ page })
    .exclude('.cdk-overlay-container')
    .analyze();
  expect(pageResults.violations).toEqual([]);
  const overlayResults = await new AxeBuilder({ page })
    .disableRules(['region'])
    .analyze();
  expect(overlayResults.violations).toEqual([]);
}

for (const theme of ['light', 'dark'] as const) {
  test(`opens both toolbar menus in the ${theme} theme`, async ({
    page,
  }, testInfo) => {
    const { refresh, bulk } = await openDevices(page);
    await page.evaluate((value) => {
      document.documentElement.dataset['theme'] = value;
    }, theme);
    await screenshot(page, testInfo, `devices-toolbar-closed-${theme}.png`);

    const refreshIcon = refresh.locator('.dropdown-icon');
    const bulkIcon = bulk.locator('.dropdown-icon');
    expect(await rotation(refreshIcon)).toBe(0);
    expect(await rotation(bulkIcon)).toBe(0);

    for (const [name, trigger, icon] of [
      ['refresh', refresh, refreshIcon],
      ['bulk', bulk, bulkIcon],
    ] as const) {
      await openMenu(page, trigger);
      await expect.poll(() => rotation(icon)).toBe(180);
      await expectMenuPlacement(page, trigger);
      await expectNoAxeViolations(page);
      await screenshot(page, testInfo, `devices-${name}-menu-${theme}.png`);
      await page.keyboard.press('Escape');
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');
      await expect.poll(() => rotation(icon)).toBe(0);
      await expect(trigger).toBeFocused();
    }
  });
}

const withoutDiagnose = grants.filter(
  (grant) => grant.action !== 'connection:diagnose',
);

for (const theme of ['light', 'dark'] as const) {
  test(`shows each unavailable Refresh item in the ${theme} theme`, async ({
    page,
  }, testInfo) => {
    const { refresh } = await openDevices(page, {
      selectedCount: 0,
      grants: withoutDiagnose,
    });
    await page.evaluate((value) => {
      document.documentElement.dataset['theme'] = value;
    }, theme);
    const menu = await openMenu(page, refresh);
    const items = menu.getByRole('menuitem');
    await expect(items).toHaveCount(3);

    const selected = items.nth(0);
    await expect(selected).toBeDisabled();
    await expect(selected).toContainText('Refresh Selected');
    await expect(selected).toContainText('Select devices to refresh.');
    await expect(items.nth(1)).toBeEnabled();

    const domain = items.nth(2);
    await expect(domain).toBeDisabled();
    await expect(domain).toContainText('Refresh Domain');
    await expect(domain).toContainText(
      'Requires the Check Google connection permission.',
    );

    await expectNoAxeViolations(page);
    await screenshotTarget(
      page,
      testInfo,
      `devices-refresh-unavailable-${theme}.png`,
      menu,
    );
  });
}

test('reaches each enabled Refresh item by keyboard', async ({ page }) => {
  const { refresh } = await openDevices(page);
  await tabTo(page, refresh);
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  const items = menu.getByRole('menuitem');
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toBeFocused();
  await expect(items.nth(0)).toContainText('Refresh Selected');
  await page.keyboard.press('ArrowDown');
  await expect(items.nth(1)).toBeFocused();
  await expect(items.nth(1)).toContainText('Refresh Devices');
  await page.keyboard.press('ArrowDown');
  await expect(items.nth(2)).toBeFocused();
  await expect(items.nth(2)).toContainText('Refresh Domain');
});

for (const theme of ['light', 'dark'] as const) {
  test(`shows the domain refresh status in the footer in the ${theme} theme`, async ({
    page,
  }, testInfo) => {
    const { refresh } = await openDevices(page);
    await page.evaluate((value) => {
      document.documentElement.dataset['theme'] = value;
    }, theme);
    const menu = await openMenu(page, refresh);
    await menu.getByRole('menuitem', { name: /Refresh Domain/ }).click();
    const status = page.getByText('Domain details refreshed.');
    await expect(status).toBeVisible();
    await expectNoAxeViolations(page);
    await screenshotTarget(
      page,
      testInfo,
      `devices-refresh-status-${theme}.png`,
      status.locator('xpath=..'),
      8,
    );
  });
}

test('reaches both toolbar menus by Tab with Escape to close', async ({
  page,
}) => {
  const { refresh, bulk } = await openDevices(page);

  await tabTo(page, refresh);
  await expect(refresh).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(refresh).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(refresh).toBeFocused();

  await page.keyboard.press('Tab');
  await expect(bulk).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(bulk).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(bulk).toBeFocused();
});

test('does not animate the expand icon with reduced motion', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const { refresh } = await openDevices(page);
  const icon = refresh.locator('.dropdown-icon');
  await refresh.click();
  await expect(page.getByRole('menu')).toBeVisible();
  await expect(icon).toHaveCSS('transition-property', 'none');
  await expect.poll(() => rotation(icon)).toBe(180);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect.poll(() => rotation(icon)).toBe(0);
});

test('keeps the toolbar and both menus inside a 320 px window', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 320, height: 800 });
  const { refresh, bulk } = await openDevices(page);

  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);

  await openMenu(page, refresh);
  await expectMenuPlacement(page, refresh);
  await screenshot(page, testInfo, 'devices-toolbar-320-refresh.png');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);

  await openMenu(page, bulk);
  await expectMenuPlacement(page, bulk);
  await screenshot(page, testInfo, 'devices-toolbar-320-bulk.png');
});

/** Presses Tab until the locator holds focus. */
async function tabTo(page: Page, target: Locator) {
  for (let press = 0; press < 80; press += 1) {
    await page.keyboard.press('Tab');
    if (
      await target.evaluate((element) => element === document.activeElement)
    ) {
      return;
    }
  }
  throw new Error('Tab did not reach the target control');
}

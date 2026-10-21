import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type TestInfo } from '@playwright/test';

const customerId = 'C0123456';
const observedAt = '2026-10-19T12:00:00.000Z';
const grants = [
  { action: 'devices:read', scope: { kind: 'district', customerId } },
  { action: 'devices:write', scope: { kind: 'district', customerId } },
  { action: 'devices:bulk-actions', scope: { kind: 'district', customerId } },
];

/**
 * Six devices: one Active, two Disabled, one Deprovisioned, one with no Google status,
 * and one Google value outside the three the filter offers.
 */
const fixtures: { serialNumber: string; status: string | null }[] = [
  { serialNumber: 'C0A1-0001', status: 'ACTIVE' },
  { serialNumber: 'C0A1-0002', status: 'DISABLED' },
  { serialNumber: 'C0A1-0003', status: 'DEPROVISIONED' },
  { serialNumber: 'C0A1-0004', status: 'DISABLED' },
  { serialNumber: 'C0A1-0005', status: null },
  { serialNumber: 'C0A1-0006', status: 'RETIRED' },
];
const rows = fixtures.map(({ serialNumber, status }, index) => ({
  deviceId: `synthetic-device-${index + 1}`,
  serialNumber,
  model: 'Lenovo 100e Gen 4',
  assetTag: `HS-040${index + 1}`,
  orgUnitPath: '/School A',
  lastContact: '2026-10-19T11:58:00Z',
  annotatedLocation: null,
  notes: null,
  status,
  battery: {
    status: 'reported',
    health: 'normal',
    capacityPercent: 91,
    reportedAt: '2026-10-19T11:00:00Z',
  },
  lastEntitySync: observedAt,
  stale: false,
}));

interface QueryAnswer {
  predicates?: { field: string; values?: string[] }[];
  offset?: number;
  limit?: number;
}

/** The Devices page needs the session, a published inventory, and the write access state. */
async function signIn(page: Page) {
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
            added: 0,
            excluded: 0,
            selectedCount: 0,
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
            deviceCount: rows.length,
            failure: null,
            telemetryFailure: null,
            startedAt: null,
            checkedAt: null,
            stale: false,
          },
        },
      });
    if (path === '/api/devices/query') {
      // Apply the status predicate the way the Devices route does, so the test
      // proves the whole path from the grid filter to the query answer.
      const query = route.request().postDataJSON() as QueryAnswer;
      const status = query.predicates?.find(
        (predicate) => predicate.field === 'status',
      );
      const matched = status
        ? rows.filter(
            (row) => row.status !== null && status.values?.includes(row.status),
          )
        : rows;
      const offset = query.offset ?? 0;
      const limit = query.limit ?? 100;
      return route.fulfill({
        json: {
          page: {
            rows: matched.slice(offset, offset + limit),
            matching: matched.length,
            total: rows.length,
            observedAt,
            refreshJobId: null,
          },
        },
      });
    }
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

async function openDevices(page: Page, theme: 'light' | 'dark') {
  await signIn(page);
  await page.goto('/devices');
  await expect(
    page.getByRole('heading', { name: 'Devices', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('gridcell', { name: 'C0A1-0001', exact: true }),
  ).toBeVisible();
  await page.evaluate((value) => {
    document.documentElement.dataset['theme'] = value;
  }, theme);
  await page.evaluate(() => document.fonts.ready);
}

async function screenshot(page: Page, testInfo: TestInfo, name: string) {
  await page.screenshot({
    path: testInfo.outputPath(name),
    fullPage: true,
  });
}

for (const theme of ['light', 'dark'] as const) {
  test(`shows the Status column and filters by status in the ${theme} theme`, async ({
    page,
  }, testInfo) => {
    await openDevices(page, theme);

    // The optional column starts hidden.
    await expect(
      page.getByRole('columnheader', { name: 'Status', exact: true }),
    ).toHaveCount(0);

    // The column picker offers Status, and showing it puts it directly after Serial.
    await page.getByRole('tab', { name: 'Columns', exact: true }).click();
    const showStatus = page.getByRole('checkbox', { name: 'Show Status' });
    await expect(showStatus).toBeVisible();
    await expect(showStatus).not.toBeChecked();
    await showStatus.check();
    // The picker lists every column in grid order, including hidden ones.
    const picker = await page
      .locator('.lgr-columns-row')
      .evaluateAll((list) =>
        list.map((row) => row.getAttribute('data-column-id')),
      );
    expect(picker[picker.indexOf('serialNumber') + 1]).toBe('status');
    // Close the panel so the grid takes the width of the reviewed state.
    await page.getByRole('tab', { name: 'Columns', exact: true }).click();
    await expect(
      page.getByRole('columnheader', { name: 'Status', exact: true }),
    ).toBeVisible();
    // The grid puts Status directly after Serial.
    const columnIndex = async (id: string) =>
      Number(
        await page
          .locator(`.ag-header-cell[col-id="${id}"]`)
          .first()
          .getAttribute('aria-colindex'),
      );
    expect(await columnIndex('status')).toBe(
      (await columnIndex('serialNumber')) + 1,
    );

    // The three Google states read as labels, another value reads as Google sends it,
    // and a null status shows the grid's empty value.
    await expect(
      page.getByRole('gridcell', { name: 'Active', exact: true }),
    ).toHaveCount(1);
    await expect(
      page.getByRole('gridcell', { name: 'Disabled', exact: true }),
    ).toHaveCount(2);
    await expect(
      page.getByRole('gridcell', { name: 'Deprovisioned', exact: true }),
    ).toHaveCount(1);
    await expect(
      page.getByRole('gridcell', { name: 'RETIRED', exact: true }),
    ).toHaveCount(1);
    const noStatus = page.locator('.ag-row', {
      has: page.getByRole('gridcell', { name: 'C0A1-0005', exact: true }),
    });
    await expect(noStatus.locator('.ag-cell[col-id="status"]')).toHaveText('');
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await screenshot(page, testInfo, `devices-status-column-${theme}.png`);

    // Filter to Disabled and Deprovisioned through the same chip editor as Battery.
    await page.getByRole('button', { name: 'Add a filter' }).click();
    await page.getByRole('option', { name: 'Status', exact: true }).click();
    await page.getByRole('checkbox', { name: 'Disabled', exact: true }).check();
    await page
      .getByRole('checkbox', { name: 'Deprovisioned', exact: true })
      .check();
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(
      page.getByRole('button', {
        name: 'Status · Disabled, Deprovisioned',
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByText('3 matching devices · 6 in district'),
    ).toBeVisible();
    for (const serial of ['C0A1-0002', 'C0A1-0003', 'C0A1-0004'])
      await expect(
        page.getByRole('gridcell', { name: serial, exact: true }),
      ).toBeVisible();
    for (const serial of ['C0A1-0001', 'C0A1-0005', 'C0A1-0006'])
      await expect(
        page.getByRole('gridcell', { name: serial, exact: true }),
      ).toHaveCount(0);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await screenshot(page, testInfo, `devices-status-filter-${theme}.png`);

    // Clear filters restores every row.
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(
      page.getByText('6 matching devices · 6 in district'),
    ).toBeVisible();
    for (const row of rows)
      await expect(
        page.getByRole('gridcell', { name: row.serialNumber, exact: true }),
      ).toBeVisible();
  });
}

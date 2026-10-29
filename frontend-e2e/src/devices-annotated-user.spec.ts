import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { DeviceDetail, DeviceRow } from '@campus/application-contracts';
import { installLiveStreams } from './live-streams';

const customerId = 'C0123456';
const observedAt = '2026-10-19T12:00:00.000Z';
const grants = [
  { action: 'devices:read', scope: { kind: 'district', customerId } },
  { action: 'devices:write', scope: { kind: 'district', customerId } },
  { action: 'devices:bulk-actions', scope: { kind: 'district', customerId } },
  { action: 'devices:commands', scope: { kind: 'district', customerId } },
  { action: 'devices:status', scope: { kind: 'district', customerId } },
];

/**
 * Six devices: four one-to-one devices with an Annotated user and two cart
 * devices without one. The filtered device is a one-to-one device.
 */
const fixtures: {
  serialNumber: string;
  orgUnitPath: string;
  annotatedUser: string | null;
}[] = [
  {
    serialNumber: 'C0A1-0001',
    orgUnitPath: '/Chrome Devices/Lowell Academy/One to One',
    annotatedUser: 'maya.chen@example.org',
  },
  {
    serialNumber: 'C0A1-0002',
    orgUnitPath: '/Chrome Devices/Lowell Academy/One to One',
    annotatedUser: 'luis.ortiz@example.org',
  },
  {
    serialNumber: 'C0A1-0003',
    orgUnitPath: '/Chrome Devices/Lowell Academy/One to One',
    annotatedUser: 'liam.foster@example.org',
  },
  {
    serialNumber: 'C0A1-0004',
    orgUnitPath: '/Chrome Devices/Pine Valley Elementary School/Cart Devices',
    annotatedUser: null,
  },
  {
    serialNumber: 'C0A1-0005',
    orgUnitPath: '/Chrome Devices/Hughes Academy/One to One',
    annotatedUser: 'ava.patel@example.org',
  },
  {
    serialNumber: 'C0A1-0006',
    orgUnitPath: '/Chrome Devices/Pine Valley Elementary School/Cart Devices',
    annotatedUser: null,
  },
];
const rows: DeviceRow[] = fixtures.map(
  ({ serialNumber, orgUnitPath, annotatedUser }, index) => ({
    deviceId: `synthetic-device-${index + 1}`,
    serialNumber,
    model: 'Dell Chromebook 3100',
    assetTag: `HS-040${index + 1}`,
    orgUnitPath,
    lastContact: '2026-10-19T11:58:00Z',
    annotatedLocation: null,
    annotatedUser,
    notes: null,
    status: 'ACTIVE',
    battery: { status: 'no-report' },
    lastEntitySync: observedAt,
    stale: false,
  }),
);

/** The details answer of the one-to-one device the filter finds. */
const detail: DeviceDetail = {
  ...rows[2],
  removedAt: null,
  batteryReports: [],
};

interface QueryAnswer {
  predicates?: {
    field: string;
    operator?: string;
    value?: string;
    values?: string[];
  }[];
  offset?: number;
  limit?: number;
}

/** The Devices page needs the session, a published inventory, and the write access state. */
async function signIn(page: Page, detailOverrides: Partial<DeviceDetail> = {}) {
  await installLiveStreams(page);
  const detailAnswer: DeviceDetail = { ...detail, ...detailOverrides };
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
      // Apply the text predicate the way the Devices route does, so the test
      // proves the whole path from the grid filter to the query answer.
      const query = route.request().postDataJSON() as QueryAnswer;
      const annotatedUser = query.predicates?.find(
        (predicate) => predicate.field === 'annotatedUser',
      );
      const wanted = annotatedUser?.value?.toLowerCase();
      const matched =
        wanted === undefined
          ? rows
          : rows.filter((row) =>
              (row.annotatedUser ?? '').toLowerCase().includes(wanted),
            );
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
    if (path === `/api/devices/${detailAnswer.deviceId}`)
      return route.fulfill({ json: { device: detailAnswer } });
    if (path === '/api/devices/freshness')
      return route.fulfill({
        json: { freshness: { stale: 0, refreshing: false } },
      });
    if (path === '/api/devices/org-units')
      return route.fulfill({ json: { orgUnits: [] } });
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

/** The review screenshots use the light theme at 1440 x 900. */
async function lightTheme(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => {
    document.documentElement.dataset['theme'] = 'light';
  });
  await page.evaluate(() => document.fonts.ready);
}

async function openDevices(
  page: Page,
  detailOverrides: Partial<DeviceDetail> = {},
) {
  await signIn(page, detailOverrides);
  await page.goto('/devices');
  await lightTheme(page);
  await expect(
    page.getByRole('heading', { name: 'Devices', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('gridcell', { name: 'C0A1-0001', exact: true }),
  ).toBeVisible();
}

/** The review screenshots use the light theme at 1440 x 900. */
function screenshot(page: Page, testInfo: TestInfo, name: string) {
  return page.screenshot({
    path: testInfo.outputPath(name),
    fullPage: false,
  });
}

test('shows the optional Annotated user column after Asset tag', async ({
  page,
}, testInfo) => {
  await openDevices(page);

  // The optional column starts hidden.
  await expect(
    page.getByRole('columnheader', { name: 'Annotated user', exact: true }),
  ).toHaveCount(0);

  // The column picker offers Annotated user, and showing it puts it after Asset tag.
  await page.getByRole('tab', { name: 'Columns', exact: true }).click();
  const showAnnotatedUser = page.getByRole('checkbox', {
    name: 'Show Annotated user',
  });
  await expect(showAnnotatedUser).toBeVisible();
  await expect(showAnnotatedUser).not.toBeChecked();
  // The shared checkbox takes the keyboard, so the optional column needs no pointer.
  await showAnnotatedUser.focus();
  await page.keyboard.press('Space');
  await expect(showAnnotatedUser).toBeChecked();
  await page.getByRole('tab', { name: 'Columns', exact: true }).click();
  await expect(
    page.getByRole('columnheader', { name: 'Annotated user', exact: true }),
  ).toBeVisible();
  const columnIndex = async (id: string) =>
    Number(
      await page
        .locator(`.ag-header-cell[col-id="${id}"]`)
        .first()
        .getAttribute('aria-colindex'),
    );
  expect(await columnIndex('annotatedUser')).toBe(
    (await columnIndex('assetTag')) + 1,
  );

  // Each value shows in its row, and a device without a value shows an empty cell.
  for (const row of rows)
    await expect(
      page
        .locator('.ag-row', {
          has: page.getByRole('gridcell', {
            name: row.serialNumber,
            exact: true,
          }),
        })
        .locator('.ag-cell[col-id="annotatedUser"]'),
    ).toHaveText(row.annotatedUser ?? '');

  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await screenshot(page, testInfo, 'device-annotated-user-column-light.png');
});

test('finds a device with the Annotated user text filter', async ({
  page,
}, testInfo) => {
  await openDevices(page);

  // Show the optional column so the screenshot pairs the filter with the value.
  await page.getByRole('tab', { name: 'Columns', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Show Annotated user' }).check();
  await page.getByRole('tab', { name: 'Columns', exact: true }).click();

  // The filter chip editor offers the new field as text.
  await page.getByRole('button', { name: 'Add a filter' }).click();
  await page
    .getByRole('option', { name: 'Annotated user', exact: true })
    .click();
  await page.getByLabel('Value').fill('liam.foster@example.org');
  await page.getByRole('button', { name: 'Apply' }).click();

  await expect(
    page.getByRole('button', {
      name: 'Annotated user contains: liam.foster@example.org',
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText('1 matching devices · 6 in district'),
  ).toBeVisible();
  await expect(
    page.getByRole('gridcell', { name: 'C0A1-0003', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('gridcell', {
      name: 'liam.foster@example.org',
      exact: true,
    }),
  ).toBeVisible();
  for (const serial of ['C0A1-0001', 'C0A1-0002', 'C0A1-0004'])
    await expect(
      page.getByRole('gridcell', { name: serial, exact: true }),
    ).toHaveCount(0);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await screenshot(page, testInfo, 'device-annotated-user-filter-light.png');

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

test('shows Annotated user between Annotated location and Notes in the details', async ({
  page,
}, testInfo) => {
  await openDevices(page);
  await page
    .getByRole('button', { name: 'Open details for C0A1-0003', exact: true })
    .click();
  await lightTheme(page);
  await expect(
    page.getByRole('heading', { name: detail.serialNumber, exact: true }),
  ).toBeVisible();

  const annotations = page.locator('.annotation');
  await expect(annotations).toHaveCount(3);
  await expect(annotations.nth(0).locator('dt')).toHaveText(
    'Annotated location',
  );
  await expect(annotations.nth(1).locator('dt')).toHaveText('Annotated user');
  await expect(annotations.nth(1).locator('dd')).toHaveText(
    'liam.foster@example.org',
  );
  await expect(annotations.nth(2).locator('dt')).toHaveText('Notes');
  await expect(annotations.nth(2).locator('dd')).toHaveText('Not set');

  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await screenshot(page, testInfo, 'device-annotated-user-details-light.png');
});

test('wraps a long Annotated user inside the identity card', async ({
  page,
}, testInfo) => {
  // The contract accepts long values, and this one has no natural break point.
  const longUser = `${'w'.repeat(64)}@${'w'.repeat(23)}.example.org`;
  expect(longUser).toHaveLength(100);
  await openDevices(page, { annotatedUser: longUser });
  await page
    .getByRole('button', { name: 'Open details for C0A1-0003', exact: true })
    .click();
  await lightTheme(page);
  await expect(
    page.getByRole('heading', { name: detail.serialNumber, exact: true }),
  ).toBeVisible();

  const annotations = page.locator('.annotations');
  const identityCard = page
    .locator('section.card')
    .filter({ has: annotations })
    .first();
  const annotationRows = annotations.locator('.annotation');
  await expect(annotationRows).toHaveCount(3);
  await expect(annotationRows.nth(1).locator('dd')).toHaveText(longUser);

  // Each annotation row, not only its own text box, stays inside the card.
  const card = (await identityCard.boundingBox())!;
  const list = (await annotations.boundingBox())!;
  for (let index = 0; index < 3; index += 1) {
    const row = annotationRows.nth(index);
    const rowBox = (await row.boundingBox())!;
    const valueBox = (await row.locator('dd').boundingBox())!;
    expect(rowBox.width).toBeLessThanOrEqual(list.width + 0.5);
    expect(rowBox.x).toBeGreaterThanOrEqual(card.x - 0.5);
    expect(rowBox.x + rowBox.width).toBeLessThanOrEqual(
      card.x + card.width + 0.5,
    );
    expect(valueBox.x + valueBox.width).toBeLessThanOrEqual(
      card.x + card.width + 0.5,
    );
  }

  // The full value renders and wraps, so no part of it is clipped.
  const userValue = annotationRows.nth(1).locator('dd');
  expect(
    await userValue.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
  ).toBe(true);
  await screenshot(
    page,
    testInfo,
    'device-annotated-user-long-value-light.png',
  );
});

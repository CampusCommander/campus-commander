/// <reference lib="dom" />
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type { DeviceRow } from '@campus/application-contracts';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { orgUnitTree } from './device-update-u6-simulator';

/**
 * IF2 completion step 2 of `docs/workflows/in-grid-editing.md`: one toggle switches the
 * grid between the pending set and the person's own query. The pending view lists changed
 * rows inside and outside the current filter, and Show all devices restores the query.
 * The API is mocked; no live Google call runs.
 */

const customerId = 'C0123456';
const observedAt = '2026-10-19T12:00:00.000Z';
const principal = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const storageKey = `cc.device-update-draft.${principal}`;
const grants = [
  { action: 'devices:read', scope: { kind: 'district', customerId } },
  { action: 'devices:write', scope: { kind: 'district', customerId } },
  { action: 'devices:bulk-actions', scope: { kind: 'district', customerId } },
];

const evidenceDir =
  process.env['EVIDENCE_DIR'] ?? path.join(process.cwd(), 'dist/e2e-evidence');

interface ApiLog {
  /** The device IDs of each pending view read, in request order. */
  byIds: string[][];
  /** Each selection change the browser sent, in request order. */
  ops: unknown[][];
  /** The sort of each device query, in request order. */
  sorts: Array<{ field: string; direction: string }>;
}

function seedRows(count = 6): DeviceRow[] {
  return Array.from({ length: count }, (_, index) => ({
    deviceId: `d${index}`,
    serialNumber: `C0A1-${String(index + 1).padStart(4, '0')}`,
    model: 'Dell Chromebook 3100',
    assetTag: `HS-${String(index + 1).padStart(4, '0')}`,
    orgUnitPath:
      index % 2 === 0
        ? '/Chrome Devices/Pine Valley Elementary School/Cart Devices'
        : '/Chrome Devices/Lowell Academy/One to One',
    lastContact: '2026-10-19T11:58:00Z',
    annotatedLocation: null,
    annotatedUser: null,
    notes: null,
    status: 'ACTIVE',
    battery: { status: 'no-report' },
    lastEntitySync: observedAt,
    stale: false,
  }));
}

interface Predicate {
  field: string;
  operator: string;
  value?: string;
}

/** The mock applies the serial filter, so the query count follows the person's filter. */
function matches(row: DeviceRow, predicate: Predicate): boolean {
  if (predicate.field !== 'serialNumber' || predicate.value === undefined)
    return true;
  const value = predicate.value.toLowerCase();
  const serial = row.serialNumber.toLowerCase();
  if (predicate.operator === 'startsWith') return serial.startsWith(value);
  if (predicate.operator === 'equals') return serial === value;
  if (predicate.operator === 'isEmpty') return false;
  return serial.includes(value);
}

/**
 * A contract-valid selection store. The footer's "Total Selected" reads its count, so a
 * Select All that expands beyond the pending rows shows up as the wrong number.
 */
class MockSelection {
  private terms: Predicate[][] = [];
  private additions = new Set<string>();
  private exceptions = new Set<string>();

  constructor(private readonly rows: readonly DeviceRow[]) {}

  apply(ops: readonly Record<string, unknown>[]): void {
    for (const op of ops) {
      if (op['op'] === 'selectAll')
        this.terms.push(op['predicates'] as Predicate[]);
      else if (op['op'] === 'deselectAll') {
        this.terms = [];
        this.additions.clear();
        this.exceptions.clear();
      } else if (op['op'] === 'select') {
        for (const id of op['ids'] as string[]) {
          this.additions.add(id);
          this.exceptions.delete(id);
        }
      } else if (op['op'] === 'deselect') {
        for (const id of op['ids'] as string[]) {
          this.additions.delete(id);
          this.exceptions.add(id);
        }
      } else if (op['op'] === 'selectGroup')
        this.terms.push(op['predicates'] as Predicate[]);
    }
  }

  spec() {
    const selected = new Set(this.additions);
    for (const term of this.terms)
      for (const row of this.rows)
        if (term.every((predicate) => matches(row, predicate)))
          selected.add(row.deviceId);
    for (const id of this.exceptions) selected.delete(id);
    return {
      terms: this.terms.map((predicates) => ({ type: 'all', predicates })),
      groups: [],
      added: this.additions.size,
      excluded: this.exceptions.size,
      selectedCount: selected.size,
      expiredAt: null,
    };
  }
}

async function mockApi(
  page: Page,
  rows: DeviceRow[],
  log: ApiLog,
): Promise<void> {
  const selection = new MockSelection(rows);
  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/application')
      return route.fulfill({
        json: {
          phase: 3,
          authenticationConfigured: true,
          version: 'development',
          build: 'client-review',
        },
      });
    if (pathname === '/api/auth/session')
      return route.fulfill({
        json: {
          identity: {
            id: principal,
            displayName: 'District operator',
            permissionVersion: 1,
            permissions: [],
            grants,
            preferences: { theme: 'system', navigationCollapsed: false },
          },
          csrfToken: 'a'.repeat(64),
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        },
      });
    if (pathname === '/api/devices/selection')
      return route.fulfill({ json: { selection: selection.spec() } });
    if (pathname === '/api/devices/selection/ops') {
      const body = route.request().postDataJSON() as {
        ops: Array<Record<string, unknown>>;
      };
      log.ops.push(body.ops);
      selection.apply(body.ops);
      return route.fulfill({ json: { selection: selection.spec() } });
    }
    if (pathname === '/api/devices/selection/resolve')
      return route.fulfill({ json: { selected: {} } });
    if (pathname === '/api/devices/sync')
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
    if (pathname === '/api/devices/query') {
      const query = route.request().postDataJSON() as {
        offset?: number;
        limit?: number;
        predicates?: Predicate[];
        sort?: { field: string; direction: string };
      };
      if (query.sort) log.sorts.push(query.sort);
      const matching = rows.filter((row) =>
        (query.predicates ?? []).every((predicate) => matches(row, predicate)),
      );
      const offset = query.offset ?? 0;
      const limit = query.limit ?? 100;
      return route.fulfill({
        json: {
          page: {
            rows: matching.slice(offset, offset + limit),
            matching: matching.length,
            total: rows.length,
            observedAt,
            refreshJobId: null,
          },
        },
      });
    }
    if (pathname === '/api/devices/groups') {
      const query = route.request().postDataJSON() as {
        predicates?: Predicate[];
        group?: { by: string[] };
      };
      const filtered = rows.filter((row) =>
        (query.predicates ?? []).every((predicate) => matches(row, predicate)),
      );
      const by = query.group?.by?.[0];
      const counts = new Map<string, number>();
      for (const row of filtered) {
        const key = by === 'orgUnitPath' ? row.orgUnitPath : '';
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const groups = [...counts.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, devices]) => ({ key, devices }));
      return route.fulfill({
        json: {
          groups: {
            groups,
            groupCount: groups.length,
            matching: filtered.length,
            total: rows.length,
            observedAt,
          },
        },
      });
    }
    if (pathname === '/api/devices/by-ids') {
      const body = route.request().postDataJSON() as { deviceIds: string[] };
      log.byIds.push(body.deviceIds);
      const wanted = new Set(body.deviceIds);
      return route.fulfill({
        json: { rows: rows.filter((row) => wanted.has(row.deviceId)) },
      });
    }
    if (pathname === '/api/devices/freshness')
      return route.fulfill({
        json: { freshness: { stale: 0, refreshing: false } },
      });
    if (pathname === '/api/devices/org-units')
      return route.fulfill({ json: { orgUnits: [] } });
    if (pathname === '/api/devices/updates/org-units')
      return route.fulfill({ json: orgUnitTree });
    if (pathname === '/api/devices/updates/access')
      return route.fulfill({
        json: {
          state: 'granted',
          scope:
            'https://www.googleapis.com/auth/admin.directory.device.chromeos',
          failure: null,
          checkedAt: '2026-10-19T12:00:00.000Z',
        },
      });
    if (pathname === '/api/devices/events')
      return route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: '',
      });
    if (pathname === '/api/customer')
      return route.fulfill({ json: { customer: null } });
    if (pathname === '/api/google-connection')
      return route.fulfill({ json: { connection: null } });
    if (pathname === '/api/google-connection/health')
      return route.fulfill({ json: { health: null } });
    if (pathname === '/api/auth/preferences')
      return route.fulfill({ json: route.request().postDataJSON() });
    return route.fulfill({ status: 404, json: {} });
  });
}

async function openDevices(
  page: Page,
  rows = seedRows(),
  log: ApiLog = { byIds: [], ops: [], sorts: [] },
): Promise<ApiLog> {
  await mockApi(page, rows, log);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/devices');
  await page.evaluate(() => document.fonts.ready);
  await expect(
    page.getByRole('heading', { name: 'Devices', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('gridcell', { name: rows[0]!.serialNumber, exact: true }),
  ).toBeVisible();
  return log;
}

function cell(page: Page, serial: string, colId: string) {
  return page
    .locator('.ag-row', {
      has: page.getByRole('gridcell', { name: serial, exact: true }),
    })
    .locator(`.ag-cell[col-id="${colId}"]`);
}

async function editText(
  page: Page,
  serial: string,
  colId: string,
  value: string,
): Promise<void> {
  const target = cell(page, serial, colId);
  await target.dblclick();
  const input = target.locator('input');
  await expect(input).toBeVisible();
  await input.fill(value);
  await input.press('Enter');
  await expect(target.locator('input')).toHaveCount(0);
}

async function filterSerial(page: Page, serial: string): Promise<void> {
  await page.getByRole('button', { name: 'Add a filter' }).click();
  await page.getByRole('combobox', { name: 'Filter field' }).fill('Serial');
  await page.getByRole('option', { name: 'Serial', exact: true }).click();
  await page.getByLabel('Value').fill(serial);
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(
    page.getByRole('button', {
      name: `Serial contains: ${serial}`,
      exact: true,
    }),
  ).toBeVisible();
}

async function screenshot(page: Page, name: string): Promise<void> {
  mkdirSync(evidenceDir, { recursive: true });
  await page.screenshot({ path: path.join(evidenceDir, name), fullPage: true });
}

async function axe(page: Page): Promise<void> {
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
}

/** Group the grid by Organization unit through the header menu. */
async function groupByOrgUnit(page: Page): Promise<void> {
  const menu = page.locator('.ag-header-cell[col-id="orgUnitPath"]');
  await menu.locator('.ag-header-cell-menu-button').dispatchEvent('click');
  await page
    .getByRole('menuitem', { name: /Group by Organization unit/ })
    .click();
}

/** The page component and store, through the development build's Angular hooks. */
async function productionStore(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      !!(window as { ng?: unknown }).ng &&
      !!document.querySelector('app-devices'),
  );
}

/** Invoke the production Reconnect handler. */
async function reconnect(page: Page): Promise<void> {
  await productionStore(page);
  await page.evaluate(async () => {
    const component = (
      window as unknown as { ng: { getComponent: (el: Element) => any } }
    ).ng.getComponent(document.querySelector('app-devices')!);
    await component.store.reconnect();
  });
}

/** Deliver a completed full-sync stream event through the production store handler. */
async function fullSync(page: Page, observedAt: string): Promise<void> {
  await productionStore(page);
  await page.evaluate((at) => {
    const component = (
      window as unknown as { ng: { getComponent: (el: Element) => any } }
    ).ng.getComponent(document.querySelector('app-devices')!);
    component.store.onEvent(
      JSON.stringify({
        type: 'full-sync',
        sync: {
          customerId: 'C0123456',
          generation: 1,
          status: 'ready',
          observedAt: at,
          deviceCount: 6,
          failure: null,
          telemetryFailure: null,
          startedAt: null,
          checkedAt: null,
          stale: false,
        },
      }),
    );
  }, observedAt);
}

/** Deliver an entity-batch stream event through the production store handler. */
async function entityBatch(page: Page, deviceIds: string[]): Promise<void> {
  await productionStore(page);
  await page.evaluate((ids) => {
    const component = (
      window as unknown as { ng: { getComponent: (el: Element) => any } }
    ).ng.getComponent(document.querySelector('app-devices')!);
    component.store.onEvent(
      JSON.stringify({
        type: 'entity-batch',
        entityType: 'device',
        deviceIds: ids,
        removedIds: [],
      }),
    );
  }, deviceIds);
}

test('step 2: the pending view lists changed rows outside the filter and returns to the query', async ({
  page,
}) => {
  const rows = seedRows();
  const log = await openDevices(page, rows);

  // Two pending cells on two devices. One of them leaves the person's filter below.
  await editText(page, 'C0A1-0001', 'assetTag', 'CB-IN-FILTER');
  await editText(page, 'C0A1-0004', 'assetTag', 'CB-OUT-FILTER');
  await expect(page.locator('#draft-count')).toHaveText(
    '2 pending changes · 2 devices',
  );
  await expect(
    page.getByRole('button', { name: 'Show pending changes', exact: true }),
  ).toHaveAttribute('aria-pressed', 'false');
  await screenshot(page, 'grid-pending-view-before-filter.png');

  // The person's query keeps one device. The other pending change leaves the filter.
  await filterSerial(page, 'C0A1-0001');
  await expect(
    page.getByText('1 matching devices · 6 in district'),
  ).toBeVisible();
  await expect(
    page.getByRole('gridcell', { name: 'C0A1-0004', exact: true }),
  ).toHaveCount(0);
  await screenshot(page, 'grid-pending-view-filtered-query.png');

  const toggle = page.getByRole('button', {
    name: 'Show pending changes',
    exact: true,
  });
  await toggle.click();
  const back = page.getByRole('button', {
    name: 'Show all devices',
    exact: true,
  });
  await expect(back).toHaveAttribute('aria-pressed', 'true');

  // Both changed rows list, inside and outside the person's filter.
  await expect(
    page.getByRole('gridcell', { name: 'C0A1-0001', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('gridcell', { name: 'C0A1-0004', exact: true }),
  ).toBeVisible();
  await expect(
    cell(page, 'C0A1-0004', 'assetTag').locator('.device-cell-value'),
  ).toHaveText('CB-OUT-FILTER');
  await expect(cell(page, 'C0A1-0004', 'assetTag')).toHaveClass(
    /device-draft-pending/,
  );

  // One read answers the view, and it names exactly the draft's devices.
  expect(log.byIds).toEqual([['d0', 'd3']]);
  // The status line and the panel count the pending view.
  await expect(
    page.getByText('2 matching devices · 6 in district'),
  ).toBeVisible();
  await expect(page.locator('#draft-count')).toHaveText(
    '2 pending changes · 2 devices',
  );
  await expect(page.locator('.draft-line')).toHaveText(
    'Showing only devices with pending changes. Show all devices returns to your filters.',
  );
  // The person's filter chip stays, and the draft keeps both changes.
  await expect(
    page.getByRole('button', {
      name: 'Serial contains: C0A1-0001',
      exact: true,
    }),
  ).toBeVisible();
  await axe(page);
  await screenshot(page, 'grid-pending-view.png');

  // The browser sorts the pending rows by the active sort model.
  await page.locator('.ag-header-cell[col-id="serialNumber"]').click();
  await expect(
    page.locator('.ag-row[row-index="0"] [col-id="serialNumber"]').first(),
  ).toContainText('C0A1-0004');
  await page.locator('.ag-header-cell[col-id="serialNumber"]').click();
  await expect(
    page.locator('.ag-row[row-index="0"] [col-id="serialNumber"]').first(),
  ).toContainText('C0A1-0001');

  // Show all devices restores the person's query: the filter, its count, and its rows.
  await back.click();
  await expect(
    page.getByRole('button', { name: 'Show pending changes', exact: true }),
  ).toHaveAttribute('aria-pressed', 'false');
  await expect(
    page.getByText('1 matching devices · 6 in district'),
  ).toBeVisible();
  await expect(
    page.getByRole('gridcell', { name: 'C0A1-0004', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('gridcell', { name: 'C0A1-0001', exact: true }),
  ).toBeVisible();
  await expect(page.locator('#draft-count')).toHaveText(
    '2 pending changes · 2 devices',
  );
  // Neither switch changed the draft or read the API again.
  expect(log.byIds).toHaveLength(1);
  expect(
    await page.evaluate((key) => {
      const raw = sessionStorage.getItem(key);
      if (!raw) return 0;
      const stored = JSON.parse(raw) as { grid?: { entries?: unknown[] } };
      return stored.grid?.entries?.length ?? 0;
    }, storageKey),
  ).toBe(2);
  await axe(page);
  await screenshot(page, 'grid-pending-view-restored-query.png');
});

test('reverting a pending row in the pending view removes it and keeps the others', async ({
  page,
}) => {
  await openDevices(page);
  await editText(page, 'C0A1-0001', 'assetTag', 'CB-ONE');
  await editText(page, 'C0A1-0002', 'assetTag', 'CB-TWO');
  await page.getByRole('button', { name: 'Show pending changes' }).click();
  await expect(
    page.getByText('2 matching devices · 6 in district'),
  ).toBeVisible();

  await page
    .getByRole('button', { name: 'Revert asset tag of C0A1-0001', exact: true })
    .click();
  await expect(
    page.getByRole('gridcell', { name: 'C0A1-0001', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('gridcell', { name: 'C0A1-0002', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('1 matching devices · 6 in district'),
  ).toBeVisible();
  await expect(page.locator('#draft-count')).toHaveText(
    '1 pending change · 1 device',
  );
  await axe(page);
  await screenshot(page, 'grid-pending-view-one-reverted.png');

  // The last revert leaves no pending change, so the view returns to the query.
  await page
    .getByRole('button', { name: 'Revert asset tag of C0A1-0002', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Show all devices', exact: true }),
  ).toHaveCount(0);
  await expect(page.locator('.draft-bar')).toHaveCount(0);
  await expect(
    page.getByRole('gridcell', { name: 'C0A1-0001', exact: true }),
  ).toBeVisible();
});
test('renders the pending view in the dark theme', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await openDevices(page);
  await editText(page, 'C0A1-0001', 'assetTag', 'CB-DARK');
  await page.getByRole('button', { name: 'Show pending changes' }).click();
  await expect(
    page.getByRole('gridcell', { name: 'C0A1-0001', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.draft-line')).toHaveText(
    'Showing only devices with pending changes. Show all devices returns to your filters.',
  );
  await axe(page);
  await screenshot(page, 'grid-pending-view-dark.png');
});

test('toggles the pending view from the keyboard', async ({ page }) => {
  await openDevices(page);
  await editText(page, 'C0A1-0001', 'assetTag', 'CB-KEYS');

  const toggle = page.getByRole('button', {
    name: 'Show pending changes',
    exact: true,
  });
  await toggle.focus();
  await page.keyboard.press('Enter');
  const back = page.getByRole('button', {
    name: 'Show all devices',
    exact: true,
  });
  // The toggle keeps focus and announces its new state.
  await expect(back).toBeFocused();
  await expect(back).toHaveAttribute('aria-pressed', 'true');
  await expect(
    page.getByRole('gridcell', { name: 'C0A1-0001', exact: true }),
  ).toBeVisible();

  await page.keyboard.press('Space');
  await expect(
    page.getByRole('button', { name: 'Show pending changes', exact: true }),
  ).toBeFocused();
  await expect(page.locator('#draft-count')).toHaveText(
    '1 pending change · 1 device',
  );
});

test('restores the person grouping after the pending view', async ({
  page,
}) => {
  await openDevices(page);
  await editText(page, 'C0A1-0001', 'assetTag', 'CB-GROUPED');
  const menu = page.locator('.ag-header-cell[col-id="orgUnitPath"]');
  await menu.locator('.ag-header-cell-menu-button').dispatchEvent('click');
  await page
    .getByRole('menuitem', { name: /Group by Organization unit/ })
    .click();
  const groupRow = page.locator('.ag-row', {
    hasText: '/Chrome Devices/Lowell Academy/One to One (3)',
  });
  await expect(groupRow).toHaveCount(1);
  await screenshot(page, 'grid-pending-view-grouped-query.png');

  // The pending view is flat: the person's grouping leaves the grid.
  await page.getByRole('button', { name: 'Show pending changes' }).click();
  await expect(
    page.getByRole('columnheader', { name: 'Group', exact: true }),
  ).toHaveCount(0);
  await expect(groupRow).toHaveCount(0);
  await expect(
    page.getByRole('gridcell', { name: 'C0A1-0001', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('1 matching devices · 6 in district'),
  ).toBeVisible();
  await screenshot(page, 'grid-pending-view-from-grouped.png');

  // Show all devices puts the grouping back with the draft unchanged.
  await page.getByRole('button', { name: 'Show all devices' }).click();
  await expect(
    page.getByRole('columnheader', { name: 'Group', exact: true }),
  ).toBeVisible();
  await expect(groupRow).toHaveCount(1);
  await expect(page.locator('#draft-count')).toHaveText(
    '1 pending change · 1 device',
  );
});

test('names a failed pending read and retries it', async ({ page }) => {
  await openDevices(page);
  await editText(page, 'C0A1-0001', 'assetTag', 'CB-RETRY');
  await page.route('**/api/devices/by-ids', (route) =>
    route.fulfill({ status: 503, json: {} }),
  );
  await page.getByRole('button', { name: 'Show pending changes' }).click();

  const alert = page.getByRole('alert');
  await expect(alert).toContainText('The pending devices did not load');
  await expect(alert).toContainText(
    'Show all devices returns to your filters.',
  );
  await expect(page.locator('app-device-grid')).toHaveClass(/hidden/);
  await screenshot(page, 'grid-pending-view-error.png');

  // Try again reads once more. It fails again, so the message stays.
  await alert.getByRole('button', { name: 'Try again' }).click();
  await expect(alert).toContainText('The pending devices did not load');

  // Show all devices restores the query with the draft intact.
  await page.getByRole('button', { name: 'Show all devices' }).click();
  await expect(
    page.getByRole('gridcell', { name: 'C0A1-0001', exact: true }),
  ).toBeVisible();
  await expect(page.locator('#draft-count')).toHaveText(
    '1 pending change · 1 device',
  );
});

test('names an empty pending read and returns to the query', async ({
  page,
}) => {
  await openDevices(page);
  await editText(page, 'C0A1-0001', 'assetTag', 'CB-GONE');
  await page.route('**/api/devices/by-ids', (route) =>
    route.fulfill({ json: { rows: [] } }),
  );
  await page.getByRole('button', { name: 'Show pending changes' }).click();
  await expect(page.getByText('No pending devices were found')).toBeVisible();
  await screenshot(page, 'grid-pending-view-empty.png');

  await page.getByRole('button', { name: 'Show all devices' }).click();
  await expect(
    page.getByRole('gridcell', { name: 'C0A1-0001', exact: true }),
  ).toBeVisible();
});

// B1: Select All in the pending view captures the pending rows, not the inventory.
test('Select All in the pending view selects only the changed devices', async ({
  page,
}) => {
  const rows = seedRows();
  const log = await openDevices(page, rows);
  await editText(page, 'C0A1-0001', 'assetTag', 'CB-ONE');
  await page.getByRole('button', { name: 'Show pending changes' }).click();
  await expect(
    page.getByText('1 matching devices · 6 in district'),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Select All (1)' }).click();
  await expect(page.getByText('Total Selected: 1')).toBeVisible();
  expect(log.ops).toEqual([[{ op: 'select', ids: ['d0'] }]]);
  await screenshot(page, 'grid-pending-view-select-all.png');
});

// B1: the person's own query keeps the query-wide Select All.
test('Select All in the query selects the query, not the draft', async ({
  page,
}) => {
  const log = await openDevices(page);
  await page.getByRole('button', { name: 'Select All (6)' }).click();
  await expect(page.getByText('Total Selected: 6')).toBeVisible();
  expect(log.ops).toEqual([[{ op: 'selectAll', predicates: [] }]]);
});

// B2: a reconnect and a completed full sync reload the view on screen.
test('keeps the pending view through a reconnect and a completed full sync', async ({
  page,
}) => {
  const rows = seedRows();
  const log = await openDevices(page, rows);
  await editText(page, 'C0A1-0001', 'assetTag', 'CB-KEEP');
  await page.getByRole('button', { name: 'Show pending changes' }).click();
  const pendingCell = page.getByRole('gridcell', {
    name: 'C0A1-0001',
    exact: true,
  });
  await expect(pendingCell).toBeVisible();
  const queries = log.sorts.length;

  await reconnect(page);
  await expect(
    page.getByRole('button', { name: 'Show all devices' }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(pendingCell).toBeVisible();
  await expect(
    page.getByText('1 matching devices · 6 in district'),
  ).toBeVisible();
  expect(log.sorts).toHaveLength(queries);
  expect(log.byIds).toHaveLength(2);

  await fullSync(page, '2026-10-23T12:00:00.000Z');
  await expect(pendingCell).toBeVisible();
  await expect(
    page.getByText('1 matching devices · 6 in district'),
  ).toBeVisible();
  expect(log.sorts).toHaveLength(queries);
  expect(log.byIds).toHaveLength(3);
  await expect(page.locator('#draft-count')).toHaveText(
    '1 pending change · 1 device',
  );
  await axe(page);
  await screenshot(page, 'grid-pending-view-reconnect.png');
});

// B3: grouping controls cannot turn the flat pending view into a grouped one.
test('keeps the pending rows flat through the grouping controls', async ({
  page,
}) => {
  await openDevices(page);
  await editText(page, 'C0A1-0001', 'assetTag', 'CB-FLAT');
  await page.getByRole('button', { name: 'Show pending changes' }).click();
  const pendingCell = page.getByRole('gridcell', {
    name: 'C0A1-0001',
    exact: true,
  });
  await expect(pendingCell).toBeVisible();

  // The pending view's column menu offers no grouping.
  await page
    .locator(
      '.ag-header-cell[col-id="orgUnitPath"] .ag-header-cell-menu-button',
    )
    .dispatchEvent('click');
  await expect(
    page.getByRole('menuitem', { name: /Group by Organization unit/ }),
  ).toHaveCount(0);
  await page.keyboard.press('Escape');

  // The Columns panel and API callers can still group. The grid returns to flat rows.
  await page.evaluate(() => {
    const grid = (
      window as unknown as { ng: { getComponent: (el: Element) => any } }
    ).ng.getComponent(document.querySelector('app-device-grid')!);
    grid.api.setRowGroupColumns(['orgUnitPath']);
  });
  await expect(
    page.getByRole('columnheader', { name: 'Group', exact: true }),
  ).toHaveCount(0);
  await expect(pendingCell).toBeVisible();
  await expect(
    page.getByText('1 matching devices · 6 in district'),
  ).toBeVisible();
  await screenshot(page, 'grid-pending-view-flat.png');
});

// B4: a restored grouped query counts the query, not the pending view.
test('restores the grouped query count after the pending view', async ({
  page,
}) => {
  await openDevices(page);
  await editText(page, 'C0A1-0001', 'assetTag', 'CB-GROUP');
  await groupByOrgUnit(page);
  await expect(
    page.getByText('6 matching devices · 6 in district'),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Show pending changes' }).click();
  await expect(
    page.getByText('1 matching devices · 6 in district'),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Show all devices' }).click();
  // Two three-device groups return, and the footer counts the restored query.
  await expect(
    page.getByText('6 matching devices · 6 in district'),
  ).toBeVisible();
  await screenshot(page, 'grid-pending-view-grouped-count.png');
});

// B5: the person's sort returns with Show all devices.
test('restores the person sort after a pending view sort', async ({ page }) => {
  const log = await openDevices(page);
  await editText(page, 'C0A1-0001', 'assetTag', 'CB-SORT');
  expect(log.sorts.at(-1)).toEqual({
    field: 'serialNumber',
    direction: 'asc',
  });

  await page.getByRole('button', { name: 'Show pending changes' }).click();
  await expect(
    page.getByRole('gridcell', { name: 'C0A1-0001', exact: true }),
  ).toBeVisible();
  await page.locator('.ag-header-cell[col-id="serialNumber"]').click();
  await expect(
    page.locator('.ag-header-cell[col-id="serialNumber"]'),
  ).toHaveAttribute('aria-sort', 'descending');

  await page.getByRole('button', { name: 'Show all devices' }).click();
  await expect(
    page.getByRole('gridcell', { name: 'C0A1-0001', exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => log.sorts.at(-1))
    .toEqual({ field: 'serialNumber', direction: 'asc' });
  await expect(
    page.locator('.ag-header-cell[col-id="serialNumber"]'),
  ).toHaveAttribute('aria-sort', 'ascending');
});

// B5: a navigation round trip keeps the person's sort priority, not the column order.
test('keeps the original sort priority across navigation from the pending view', async ({
  page,
}) => {
  const log = await openDevices(page);
  await editText(page, 'C0A1-0001', 'assetTag', 'CB-NAV');

  // The person sorts by Model, then adds Serial as the second sort. Serial sits before
  // Model in column order, so the saved sort model needs the priority, not column order.
  await page.locator('.ag-header-cell[col-id="model"]').click();
  await expect(page.locator('.ag-header-cell[col-id="model"]')).toHaveAttribute(
    'aria-sort',
    'ascending',
  );
  await page
    .locator('.ag-header-cell[col-id="serialNumber"]')
    .click({ modifiers: ['Shift'] });
  await expect(
    page.locator('.ag-header-cell[col-id="serialNumber"]'),
  ).toHaveAttribute('aria-sort', 'ascending');
  await expect
    .poll(() => log.sorts.at(-1))
    .toEqual({ field: 'model', direction: 'asc' });

  // The pending view takes its own sort, then the person navigates away.
  await page.getByRole('button', { name: 'Show pending changes' }).click();
  await page.locator('.ag-header-cell[col-id="assetTag"]').click();
  await expect(
    page.locator('.ag-header-cell[col-id="assetTag"]'),
  ).toHaveAttribute('aria-sort', 'ascending');

  await page.getByRole('link', { name: 'Jobs' }).click();
  await expect(page.getByRole('link', { name: 'Devices' })).toBeVisible();
  await page.getByRole('link', { name: 'Devices' }).click();
  await expect(
    page.getByRole('gridcell', { name: 'C0A1-0001', exact: true }),
  ).toBeVisible();

  // The restored query keeps Model first before the pending view reopens.
  await expect
    .poll(() => log.sorts.at(-1))
    .toEqual({ field: 'model', direction: 'asc' });

  // The restored query and the pending exit both keep Model as the first sort.
  await page.getByRole('button', { name: 'Show pending changes' }).click();
  await page.getByRole('button', { name: 'Show all devices' }).click();
  await expect
    .poll(() => log.sorts.at(-1))
    .toEqual({ field: 'model', direction: 'asc' });
  await expect(page.locator('.ag-header-cell[col-id="model"]')).toHaveAttribute(
    'aria-sort',
    'ascending',
  );
  await screenshot(page, 'grid-pending-view-navigation-sort.png');
});

// B6: a live refresh updates the pending view's cached rows.
test('keeps a refreshed device value when the pending view sorts', async ({
  page,
}) => {
  const rows = seedRows();
  await openDevices(page, rows);
  await editText(page, 'C0A1-0001', 'assetTag', 'CB-REFRESH');
  await page.getByRole('button', { name: 'Show pending changes' }).click();
  const model = cell(page, 'C0A1-0001', 'model');
  await expect(model).toContainText('Dell Chromebook 3100');

  // A live entity-batch refresh changes the model without a new pending read.
  rows[0]!.model = 'CURRENT-MODEL';
  await entityBatch(page, ['d0']);
  await expect(model).toContainText('CURRENT-MODEL');

  // Sorting the pending view keeps the refreshed observation.
  await page.locator('.ag-header-cell[col-id="model"]').click();
  await expect(model).toContainText('CURRENT-MODEL');
  await screenshot(page, 'grid-pending-view-refreshed-sort.png');
});

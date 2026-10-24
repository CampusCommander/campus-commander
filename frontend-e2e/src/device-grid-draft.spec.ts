import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type { DeviceRow } from '@campus/application-contracts';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { deniedOrgUnitTree, orgUnitTree } from './device-update-u6-simulator';

/**
 * IF1 completion steps 1 and 3 of `docs/workflows/in-grid-editing.md`: in-grid editors,
 * the draft count, one-cell revert, revert all after one question, reload restore, a second
 * tab that does not share the draft, the invalid cell, the organization unit picker, and the
 * 500-device limit. The API is mocked; no live Google call runs.
 */

const customerId = 'C0123456';
const observedAt = '2026-10-19T12:00:00.000Z';
const principal = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const storageKey = `cc.device-update-draft.${principal}`;
const SOURCE = '/Chrome Devices/Lowell Academy/One to One';
const DESTINATION = '/Chrome Devices/Cart Devices';
const grants = [
  { action: 'devices:read', scope: { kind: 'district', customerId } },
  { action: 'devices:write', scope: { kind: 'district', customerId } },
  { action: 'devices:bulk-actions', scope: { kind: 'district', customerId } },
];

const evidenceDir =
  process.env['EVIDENCE_DIR'] ?? path.join(process.cwd(), 'dist/e2e-evidence');

function seedRows(count = 6): DeviceRow[] {
  return Array.from({ length: count }, (_, index) => ({
    deviceId: `d${index}`,
    serialNumber: `C0A1-${String(index + 1).padStart(4, '0')}`,
    model: 'Dell Chromebook 3100',
    assetTag: `HS-${String(index + 1).padStart(4, '0')}`,
    orgUnitPath:
      index % 2 === 0
        ? SOURCE
        : '/Chrome Devices/Pine Valley Elementary School/Cart Devices',
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

async function mockApi(
  page: Page,
  rows: DeviceRow[],
  grantList = grants,
  tree: unknown = orgUnitTree,
): Promise<void> {
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
            grants: grantList,
            preferences: { theme: 'light', navigationCollapsed: false },
          },
          csrfToken: 'a'.repeat(64),
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        },
      });
    if (pathname === '/api/devices/selection')
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
      };
      const offset = query.offset ?? 0;
      const limit = query.limit ?? 100;
      return route.fulfill({
        json: {
          page: {
            rows: rows.slice(offset, offset + limit),
            matching: rows.length,
            total: rows.length,
            observedAt,
            refreshJobId: null,
          },
        },
      });
    }
    if (pathname === '/api/devices/freshness')
      return route.fulfill({
        json: { freshness: { stale: 0, refreshing: false } },
      });
    if (pathname === '/api/devices/org-units')
      return route.fulfill({ json: { orgUnits: [] } });
    if (pathname === '/api/devices/updates/org-units')
      return route.fulfill({ json: tree });
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
  grantList = grants,
  tree: unknown = orgUnitTree,
): Promise<void> {
  await mockApi(page, rows, grantList, tree);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/devices');
  await page.evaluate(() => document.fonts.ready);
  await expect(
    page.getByRole('heading', { name: 'Devices', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('gridcell', { name: rows[0]!.serialNumber, exact: true }),
  ).toBeVisible();
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
  key: 'Enter' | 'Tab' | 'Escape' = 'Enter',
): Promise<void> {
  const target = cell(page, serial, colId);
  await target.dblclick();
  const input = target.locator('input');
  await expect(input).toBeVisible();
  await input.fill(value);
  await input.press(key);
  // Enter, Tab, and Escape all end this cell's edit cycle. Wait for it before reading
  // the draft, so an assertion never samples the editor's in-progress value.
  await expect(target.locator('input')).toHaveCount(0);
}

async function axe(page: Page): Promise<void> {
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
}

async function screenshot(page: Page, name: string): Promise<void> {
  mkdirSync(evidenceDir, { recursive: true });
  await page.screenshot({
    path: path.join(evidenceDir, name),
    fullPage: false,
  });
}

/** A focus scheduled after a view closes must not throw inside afterNextRender. */
function watchFocusErrors(page: Page): string[] {
  const errors: string[] = [];
  const check = (text: string) => {
    if (text.includes("reading 'focus'")) errors.push(text);
  };
  page.on('console', (message) => {
    if (message.type() === 'error') check(message.text());
  });
  page.on('pageerror', (error) => check(error.message));
  return errors;
}

test('stages two cells on two devices, reverts one, then reverts all', async ({
  page,
}) => {
  await openDevices(page);
  const first = cell(page, 'C0A1-0001', 'assetTag');
  const second = cell(page, 'C0A1-0002', 'assetTag');
  await screenshot(page, 'grid-draft-empty.png');

  // State 02: a changed value counts while its editor is still open.
  await first.dblclick();
  const firstInput = first.locator('input');
  await expect(firstInput).toBeVisible();
  await firstInput.fill('CB-DRAFT-1');
  await expect(page.locator('#draft-count')).toHaveText(
    '1 pending change · 1 device',
  );
  await expect(page.locator('.draft-line')).toHaveText(
    'Editing asset tag · Enter or Tab stages this value · Escape cancels',
  );
  await screenshot(page, 'grid-draft-editing.png');
  await firstInput.press('Enter');
  await expect(first.locator('.device-cell-value')).toHaveText('CB-DRAFT-1');
  await expect(first).toHaveClass(/device-draft-pending/);
  await expect(page.locator('#draft-count')).toHaveText(
    '1 pending change · 1 device',
  );

  // Tab stages the second value, so Enter and Tab both stage.
  await editText(page, 'C0A1-0002', 'assetTag', 'CB-DRAFT-2', 'Tab');
  await expect(second.locator('.device-cell-value')).toHaveText('CB-DRAFT-2');
  await expect(second).toHaveClass(/device-draft-pending/);
  // Tab starts the next cell's editor. Escape it so the evidence shows the resting grid.
  await page.keyboard.press('Escape');
  await expect(page.locator('.draft-line')).toHaveCount(0);
  await expect(page.locator('#draft-count')).toHaveText(
    '2 pending changes · 2 devices',
  );
  await expect(
    page.getByRole('button', { name: 'Save changes', exact: true }),
  ).toBeDisabled();
  await axe(page);
  await screenshot(page, 'grid-draft-pending.png');

  // Revert one cell restores its baseline and leaves the other change.
  await page
    .getByRole('button', { name: 'Revert asset tag of C0A1-0001', exact: true })
    .click();
  await expect(first.locator('.device-cell-value')).toHaveText('HS-0001');
  await expect(first).not.toHaveClass(/device-draft-pending/);
  await expect(page.locator('#draft-count')).toHaveText(
    '1 pending change · 1 device',
  );

  // Revert all asks once, names the count, then clears the grid draft.
  await page.getByRole('button', { name: 'Revert all changes' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Revert all changes?' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('1 pending change · 1 device');
  await axe(page);
  await screenshot(page, 'grid-draft-revert-all.png');
  await dialog.getByRole('button', { name: 'Revert all changes' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.draft-bar')).toHaveCount(0);
  await expect(second.locator('.device-cell-value')).toHaveText('HS-0002');
  await expect(second).not.toHaveClass(/device-draft-pending/);
  expect(
    await page.evaluate((key) => sessionStorage.getItem(key), storageKey),
  ).toBeNull();
});

test('Escape cancels an edit without a pending change', async ({ page }) => {
  await openDevices(page);
  await editText(page, 'C0A1-0001', 'assetTag', 'Never staged', 'Escape');
  await expect(
    cell(page, 'C0A1-0001', 'assetTag').locator('.device-cell-value'),
  ).toHaveText('HS-0001');
  await expect(page.locator('.draft-bar')).toHaveCount(0);
});

test('keeps the grid read-only without the three update actions', async ({
  page,
}) => {
  await openDevices(page, seedRows(), [
    { action: 'devices:read', scope: { kind: 'district', customerId } },
  ]);
  const target = cell(page, 'C0A1-0001', 'assetTag');
  await target.dblclick();
  await expect(target.locator('input')).toHaveCount(0);
  await expect(target.locator('.edit-hint')).toHaveCount(0);
  const unit = cell(page, 'C0A1-0001', 'orgUnitPath');
  await unit.dblclick();
  await expect(
    page.getByRole('dialog', { name: 'Choose organization unit' }),
  ).toHaveCount(0);
  await expect(page.locator('.draft-bar')).toHaveCount(0);
});

test('restores the draft after a reload, and a second tab does not share it', async ({
  page,
}) => {
  await openDevices(page);
  await editText(page, 'C0A1-0003', 'assetTag', 'CB-RELOAD');
  await expect(page.locator('#draft-count')).toHaveText(
    '1 pending change · 1 device',
  );

  await page.reload();
  await expect(
    page.getByRole('gridcell', { name: 'C0A1-0001', exact: true }),
  ).toBeVisible();
  await expect(page.locator('#draft-count')).toHaveText(
    '1 pending change · 1 device',
  );
  await expect(
    cell(page, 'C0A1-0003', 'assetTag').locator('.device-cell-value'),
  ).toHaveText('CB-RELOAD');

  // A second tab has its own sessionStorage, so the grid draft is not shared.
  const second = await page.context().newPage();
  await mockApi(second, seedRows());
  await second.setViewportSize({ width: 1440, height: 900 });
  await second.goto('/devices');
  await expect(
    second.getByRole('gridcell', { name: 'C0A1-0001', exact: true }),
  ).toBeVisible();
  await expect(second.locator('.draft-bar')).toHaveCount(0);
  await second.close();
});

test('keeps an emptied asset tag in its cell as invalid and disables Save', async ({
  page,
}) => {
  await openDevices(page);
  const target = cell(page, 'C0A1-0001', 'assetTag');
  await editText(page, 'C0A1-0001', 'assetTag', '');
  await expect(target).toHaveClass(/device-draft-invalid/);
  await expect(target.locator('.device-cell-value')).toHaveText('');
  await expect(target.locator('.cell-state.error')).toHaveAttribute(
    'title',
    'Asset tag holds 1 to 256 characters.',
  );
  await expect(page.locator('#draft-count')).toHaveText(
    '1 pending change · 1 device',
  );
  await expect(page.locator('.draft-line')).toHaveText(
    '1 change cannot be saved. C0A1-0001 · Asset tag holds 1 to 256 characters.',
  );
  await expect(
    page.getByRole('button', { name: 'Save changes', exact: true }),
  ).toBeDisabled();
  await axe(page);
  await screenshot(page, 'grid-draft-invalid.png');

  await page
    .getByRole('button', { name: 'Revert asset tag of C0A1-0001', exact: true })
    .click();
  await expect(target.locator('.device-cell-value')).toHaveText('HS-0001');
  await expect(page.locator('.draft-bar')).toHaveCount(0);
});

test('shows a conflict, blocks Save, and resolves to the current value', async ({
  page,
}) => {
  const focusErrors = watchFocusErrors(page);
  await page.addInitScript(
    ({ key, document }) => {
      try {
        sessionStorage.setItem(key, JSON.stringify(document));
      } catch {
        // about:blank has no storage; the app document does.
      }
    },
    {
      key: storageKey,
      document: {
        grid: {
          entries: [
            {
              deviceId: 'd0',
              serialNumber: 'C0A1-0001',
              field: 'annotatedAssetId',
              mode: 'replace',
              value: 'HS-CONFLICT',
              baseline: 'HS-0001',
              orgUnitId: null,
              state: 'conflict',
              currentValue: 'HS-CHANGED',
            },
          ],
        },
      },
    },
  );
  await openDevices(page);
  const target = cell(page, 'C0A1-0001', 'assetTag');
  await expect(target).toHaveClass(/device-draft-conflict/);
  await expect(target.locator('.device-cell-value')).toHaveText('HS-CONFLICT');
  await expect(page.locator('.draft-line')).toHaveText(
    '1 conflict. Asset tag of C0A1-0001 changed in Google after your edit. Resolve it to save.',
  );
  await expect(
    page.getByRole('button', { name: 'Save changes', exact: true }),
  ).toBeDisabled();
  await axe(page);
  await screenshot(page, 'grid-draft-conflict.png');

  await target
    .getByRole('button', {
      name: 'Resolve conflict on asset tag of C0A1-0001',
      exact: true,
    })
    .click();
  const card = page.getByRole('dialog', {
    name: 'The asset tag changed after you began editing',
  });
  await expect(card).toBeVisible();
  await expect(card).toContainText('HS-0001');
  await expect(card).toContainText('HS-CONFLICT');
  await expect(card).toContainText('HS-CHANGED');
  await axe(page);
  await screenshot(page, 'grid-draft-conflict-card.png');
  await card.getByRole('button', { name: 'Keep current value' }).click();
  await expect(card).toBeHidden();
  await expect(target.locator('.device-cell-value')).toHaveText('HS-0001');
  await expect(target).not.toHaveClass(/device-draft-conflict/);
  await expect(page.locator('.draft-bar')).toHaveCount(0);
  expect(focusErrors).toEqual([]);
});

test('opens the organization unit picker from the grid and stages a Move', async ({
  page,
}) => {
  const focusErrors = watchFocusErrors(page);
  await openDevices(page);
  const unit = cell(page, 'C0A1-0001', 'orgUnitPath');
  await unit.click();
  await page.keyboard.press('Enter');
  const picker = page.locator('app-device-org-unit-picker [role="dialog"]');
  await expect(picker).toBeVisible();
  await expect(
    picker.getByRole('heading', { name: 'Choose organization unit' }),
  ).toBeVisible();
  await expect(picker.locator('.current')).toHaveText(
    'C0A1-0001 · Organization unit',
  );
  // The picker reveals the selected unit, so its ancestors may already be open.
  const expand = picker.getByRole('button', {
    name: 'Expand Chrome Devices',
    exact: true,
  });
  if ((await expand.count()) > 0) await expand.click();
  await picker
    .getByRole('treeitem', { name: 'Cart Devices', exact: true })
    .click();
  await expect(picker.getByText(`Selected: ${DESTINATION}`)).toBeVisible();
  await axe(page);
  await screenshot(page, 'grid-draft-org-unit-picker.png');
  await picker
    .getByRole('button', { name: 'Stage change', exact: true })
    .click();
  await expect(picker).toBeHidden();
  await expect(unit.locator('.device-cell-value')).toHaveText(DESTINATION);
  await expect(unit).toHaveClass(/device-draft-pending/);
  await expect(page.locator('#draft-count')).toHaveText(
    '1 pending change · 1 device',
  );
  await screenshot(page, 'grid-draft-org-unit-staged.png');

  // F2 and a double-click open the same picker for the focused device.
  await page.keyboard.press('F2');
  await expect(picker).toBeVisible();
  await picker.getByRole('button', { name: 'Cancel', exact: true }).click();
  await unit.dblclick();
  await expect(picker).toBeVisible();
  await picker.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(picker).toBeHidden();
  expect(focusErrors).toEqual([]);
});

test('refuses a 501st device and names the 500-device limit', async ({
  page,
}) => {
  const rows = seedRows(501);
  const entries = Array.from({ length: 500 }, (_, index) => ({
    deviceId: `d${index + 1}`,
    serialNumber: `C0A1-${String(index + 2).padStart(4, '0')}`,
    field: 'notes',
    mode: 'replace',
    value: 'Seeded change',
    baseline: null,
    orgUnitId: null,
    state: 'pending',
  }));
  await mockApi(page, rows);
  await page.addInitScript(
    ({ key, value }) => {
      sessionStorage.setItem(key, value);
    },
    { key: storageKey, value: JSON.stringify({ grid: { entries } }) },
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/devices');
  await expect(
    page.getByRole('gridcell', { name: 'C0A1-0001', exact: true }),
  ).toBeVisible();
  await expect(page.locator('#draft-count')).toHaveText(
    '500 pending changes · 500 devices',
  );

  await editText(page, 'C0A1-0001', 'assetTag', 'CB-OVER-LIMIT');
  const first = cell(page, 'C0A1-0001', 'assetTag');
  await expect(first).not.toHaveClass(/device-draft-pending/);
  await expect(first.locator('.device-cell-value')).toHaveText('HS-0001');
  await expect(page.locator('.draft-line')).toHaveText(
    'The draft holds at most 500 devices. Revert a change before you edit another device.',
  );
  await expect(page.locator('#draft-count')).toHaveText(
    '500 pending changes · 500 devices',
  );
  await axe(page);
  await screenshot(page, 'grid-draft-device-limit.png');
});

/** The grid part of this tab's draft document, as the browser stored it. */
async function storedEntries(
  page: Page,
): Promise<Array<Record<string, unknown>>> {
  return page.evaluate((key) => {
    const raw = sessionStorage.getItem(key);
    if (!raw) return [];
    const document = JSON.parse(raw) as {
      grid?: { entries?: unknown };
    };
    const entries = document.grid?.entries;
    return Array.isArray(entries)
      ? (entries as Array<Record<string, unknown>>)
      : [];
  }, storageKey);
}

test('restores an invalid value beside a valid entry after a reload', async ({
  page,
}) => {
  await openDevices(page);
  await editText(page, 'C0A1-0002', 'assetTag', 'CB-VALID');
  const long = 'x'.repeat(4097);
  await editText(page, 'C0A1-0001', 'assetTag', long);
  const first = cell(page, 'C0A1-0001', 'assetTag');
  await expect(first).toHaveClass(/device-draft-invalid/);
  await expect(page.locator('#draft-count')).toHaveText(
    '2 pending changes · 2 devices',
  );

  await page.reload();
  await expect(
    page.getByRole('gridcell', { name: 'C0A1-0001', exact: true }),
  ).toBeVisible();
  await expect(page.locator('#draft-count')).toHaveText(
    '2 pending changes · 2 devices',
  );
  await expect(first.locator('.device-cell-value')).toHaveText(long);
  await expect(first).toHaveClass(/device-draft-invalid/);
  await expect(
    cell(page, 'C0A1-0002', 'assetTag').locator('.device-cell-value'),
  ).toHaveText('CB-VALID');
  await expect(page.locator('.draft-line')).toHaveText(
    '1 change cannot be saved. C0A1-0001 · Asset tag holds 1 to 256 characters.',
  );
  // The value itself round-trips, so no restore warning appears.
  await expect(page.getByText('did not restore from this tab')).toHaveCount(0);
  const entries = await storedEntries(page);
  expect(entries.find((entry) => entry['deviceId'] === 'd0')).toMatchObject({
    field: 'annotatedAssetId',
    value: long,
    state: 'invalid',
  });
});

test('keeps a null baseline when the row changes before a later edit', async ({
  page,
}) => {
  const rows = seedRows();
  rows[0]!.assetTag = null;
  await openDevices(page, rows);
  await editText(page, 'C0A1-0001', 'assetTag', 'FIRST');
  const target = cell(page, 'C0A1-0001', 'assetTag');
  await expect(target.locator('.device-cell-value')).toHaveText('FIRST');

  // The inventory reports a value after the first edit. Reload keeps the draft.
  rows[0]!.assetTag = 'REMOTE';
  await page.reload();
  await expect(
    page.getByRole('gridcell', { name: 'C0A1-0001', exact: true }),
  ).toBeVisible();
  await expect(target.locator('.device-cell-value')).toHaveText('FIRST');

  await editText(page, 'C0A1-0001', 'assetTag', 'SECOND');
  await expect(target.locator('.device-cell-value')).toHaveText('SECOND');
  const entries = await storedEntries(page);
  expect(entries.find((entry) => entry['deviceId'] === 'd0')).toMatchObject({
    field: 'annotatedAssetId',
    value: 'SECOND',
    baseline: null,
  });
  await expect(page.locator('#draft-count')).toHaveText(
    '1 pending change · 1 device',
  );
});

test('keeps a conflict through an invalid value, correction, and reload', async ({
  page,
}) => {
  await page.addInitScript(
    ({ key, document }) => {
      try {
        // Seed once. A reload must read the draft that the page stored, not reseed it.
        if (!sessionStorage.getItem(key))
          sessionStorage.setItem(key, JSON.stringify(document));
      } catch {
        // about:blank has no storage; the app document does.
      }
    },
    {
      key: storageKey,
      document: {
        grid: {
          entries: [
            {
              deviceId: 'd0',
              serialNumber: 'C0A1-0001',
              field: 'annotatedAssetId',
              mode: 'replace',
              value: 'DRAFT',
              baseline: 'HS-0001',
              orgUnitId: null,
              state: 'conflict',
              currentValue: 'HS-CHANGED',
            },
          ],
        },
      },
    },
  );
  await openDevices(page);
  const target = cell(page, 'C0A1-0001', 'assetTag');
  await expect(target).toHaveClass(/device-draft-conflict/);

  await editText(page, 'C0A1-0001', 'assetTag', '');
  await expect(target).toHaveClass(/device-draft-invalid/);
  await expect(page.locator('.draft-line')).toHaveText(
    '1 change cannot be saved. C0A1-0001 · Asset tag holds 1 to 256 characters.',
  );

  await editText(page, 'C0A1-0001', 'assetTag', 'HS-NEW');
  await expect(target).toHaveClass(/device-draft-conflict/);
  await expect(
    target.getByRole('button', {
      name: 'Resolve conflict on asset tag of C0A1-0001',
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Save changes', exact: true }),
  ).toBeDisabled();
  await expect(page.locator('.draft-line')).toHaveText(
    '1 conflict. Asset tag of C0A1-0001 changed in Google after your edit. Resolve it to save.',
  );
  expect((await storedEntries(page))[0]).toMatchObject({
    value: 'HS-NEW',
    state: 'conflict',
    currentValue: 'HS-CHANGED',
  });

  await page.reload();
  await expect(
    page.getByRole('gridcell', { name: 'C0A1-0001', exact: true }),
  ).toBeVisible();
  await expect(target).toHaveClass(/device-draft-conflict/);
  await expect(target.locator('.device-cell-value')).toHaveText('HS-NEW');
  await target
    .getByRole('button', {
      name: 'Resolve conflict on asset tag of C0A1-0001',
      exact: true,
    })
    .click();
  const card = page.getByRole('dialog', {
    name: 'The asset tag changed after you began editing',
  });
  await expect(card).toBeVisible();
  await expect(card).toContainText('HS-CHANGED');
});

test('keeps the organization unit hint off when the unit read is denied', async ({
  page,
}) => {
  await openDevices(page, seedRows(), grants, deniedOrgUnitTree);
  await expect(
    cell(page, 'C0A1-0001', 'assetTag').locator('.edit-hint'),
  ).toHaveCount(1);
  const unit = cell(page, 'C0A1-0001', 'orgUnitPath');
  // The first picker attempt reads the tree and receives the denied answer.
  await unit.dblclick();
  await expect(page.locator('#grid-org-unit-note')).toBeVisible();
  await expect(page.locator('#grid-org-unit-note')).toContainText(
    'Google denied organization unit reads.',
  );
  await expect(unit.locator('.edit-hint')).toHaveCount(0);
  await expect(
    page.getByRole('dialog', { name: 'Choose organization unit' }),
  ).toHaveCount(0);
});

test('reverts a pending cell with Shift+Enter without opening an editor', async ({
  page,
}) => {
  await openDevices(page);
  await editText(page, 'C0A1-0001', 'assetTag', 'CB-SHORTCUT');
  const target = cell(page, 'C0A1-0001', 'assetTag');
  await expect(target).toHaveClass(/device-draft-pending/);
  await target.click();
  await page.keyboard.press('Shift+Enter');
  await expect(target.locator('input')).toHaveCount(0);
  await expect(target.locator('.device-cell-value')).toHaveText('HS-0001');
  await expect(page.locator('.draft-bar')).toHaveCount(0);
});

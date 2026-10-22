import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { mockApi } from './device-update-mock';
import {
  deniedOrgUnitTree,
  orgUnitTree,
  type SimulatedDevice,
} from './device-update-u6-simulator';

/**
 * Completion steps 2 and 6 of `docs/workflows/update-device-fields.md`, driven through
 * Chromium: the Organization unit field, its picker, and the Move rows of Review and Confirm
 * (PNG 03), and the disabled field without the read scope (PNG 05).
 *
 * The simulated API answers with the production U6 target calculation, so eligibility is per
 * device and field. Google and PostgreSQL stay simulated; no live API answers this suite.
 */

const SOURCE = '/Chrome Devices/Lowell Academy/One to One';
const DESTINATION = '/Chrome Devices/Cart Devices';

const serials = [
  '01P0T1V',
  '02A1MB6',
  '02QJANY',
  '04QVJBY',
  '04XTBHJ',
  '0727D2E',
];
/** Removed from inventory: the preview excludes it and the move leaves it in place. */
const excludedIndex = 1;

const evidenceDir =
  process.env['EVIDENCE_DIR'] ?? path.join(process.cwd(), 'dist/e2e-evidence');

/** Six devices in the same unit: five eligible and one removed after the selection. */
function seedDevices(): SimulatedDevice[] {
  return serials.map((serialNumber, index) => ({
    serialNumber,
    annotatedLocation: 'Science wing',
    annotatedUser: 'luis.ortiz@example.org',
    notes: null,
    orgUnitPath: SOURCE,
    removed: index === excludedIndex,
  }));
}

async function openDevices(page: Page) {
  await page.goto('/devices');
  await expect(
    page.getByRole('heading', { name: 'Devices', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('gridcell', { name: serials[0]!, exact: true }),
  ).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

async function openSheet(page: Page) {
  await page.getByRole('button', { name: 'Bulk Actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Update device' }).click();
  const sheet = page.locator('app-device-update-sheet .bulk-sheet');
  await expect(sheet).toHaveClass(/is-open/);
  await expect(sheet).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
  return sheet;
}

function field(sheet: ReturnType<Page['locator']>, id: string) {
  return sheet.locator(`.field-block[data-field="${id}"]`);
}

/** The picker sits outside the sheet, so a fixed dialog is not bounded by its transform. */
function picker(page: Page) {
  return page.locator('app-device-org-unit-picker [role="dialog"]');
}

async function chooseMode(
  page: Page,
  sheet: ReturnType<Page['locator']>,
  id: string,
  option: string,
) {
  await field(sheet, id).getByRole('combobox').click();
  await page.getByRole('option', { name: option, exact: true }).click();
  // The option panel animates out; a screenshot taken now would paint it over the fields.
  await expect(page.locator('.mat-mdc-select-panel')).toBeHidden();
}

/** Show and hide grid columns through the Columns side bar. */
async function setColumns(
  page: Page,
  options: { show?: readonly string[]; hide?: readonly string[] },
) {
  await page.getByRole('tab', { name: 'Columns', exact: true }).click();
  for (const name of options.hide ?? [])
    await page.getByRole('checkbox', { name: `Show ${name}` }).uncheck();
  for (const name of options.show ?? [])
    await page.getByRole('checkbox', { name: `Show ${name}` }).check();
  await page.getByRole('tab', { name: 'Columns', exact: true }).click();
}

/** One grid cell of the row whose Serial cell carries `serial`. */
function gridCell(page: Page, serial: string, column: string) {
  return page
    .locator('.ag-row', {
      has: page.getByRole('gridcell', { name: serial, exact: true }),
    })
    .locator(`.ag-cell[col-id="${column}"]`);
}

async function screenshot(page: Page, name: string) {
  mkdirSync(evidenceDir, { recursive: true });
  await page.screenshot({ path: path.join(evidenceDir, name) });
}

async function expectNoAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .exclude('.cdk-overlay-container')
    .analyze();
  expect(results.violations).toEqual([]);
}

test('completion step 2: moves devices with the picker and the grid and the filter show the new unit', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const mock = await mockApi(page, seedDevices());
  await openDevices(page);
  const sheet = await openSheet(page);
  const save = sheet.getByRole('button', { name: 'Save and preview' });
  await expect(save).toBeDisabled();

  // A Move offers its picker at once (design choice 10).
  await chooseMode(page, sheet, 'orgUnitPath', 'Move to an organization unit');
  await expect(picker(page)).toBeVisible();
  await expect(
    picker(page).getByRole('heading', { name: 'Choose organization unit' }),
  ).toBeVisible();
  // The tree starts at the top-level unit, so the nested destination is not shown yet.
  await expect(
    picker(page).getByRole('treeitem', { name: 'Chrome Devices', exact: true }),
  ).toBeVisible();
  await expect(
    picker(page).getByRole('treeitem', { name: 'Cart Devices', exact: true }),
  ).toHaveCount(0);
  // Choose waits for a highlighted unit.
  await expect(
    picker(page).getByRole('button', { name: 'Choose', exact: true }),
  ).toBeDisabled();
  await expectNoAxeViolations(page);

  await picker(page)
    .getByRole('button', { name: 'Expand Chrome Devices', exact: true })
    .click();
  await picker(page)
    .getByRole('treeitem', { name: 'Cart Devices', exact: true })
    .click();
  await expect(
    picker(page).getByText(`Selected: ${DESTINATION}`),
  ).toBeVisible();
  await picker(page)
    .getByRole('button', { name: 'Choose', exact: true })
    .click();
  await expect(picker(page)).toBeHidden();

  // The Destination is read-only and its button reopens the picker.
  const destination = field(sheet, 'orgUnitPath').getByLabel('Destination');
  await expect(destination).toHaveValue(DESTINATION);
  await expect(destination).toHaveJSProperty('readOnly', true);
  await expect(
    field(sheet, 'orgUnitPath').getByRole('button', {
      name: 'Choose organization unit',
    }),
  ).toBeVisible();
  await expect(
    sheet.getByText('6 devices · 1 changed field · Not submitted'),
  ).toBeVisible();
  await expect(save).toBeEnabled();

  await save.click();
  await expect(
    sheet.getByRole('heading', { name: 'Review 5 device updates' }),
  ).toBeVisible();
  expect(mock.posted.changes).toEqual([
    { field: 'orgUnitPath', mode: 'move', value: DESTINATION },
  ]);
  await expect(
    sheet.getByText('6 devices · 5 field changes · 1 excluded'),
  ).toBeVisible();

  // One row per device: the source unit and the destination unit.
  const groups = sheet.locator('.targets tbody');
  await expect(groups).toHaveCount(6);
  const first = groups.first();
  await expect(first.locator('.device-row')).toContainText(serials[0]!);
  await expect(first.locator('th[scope="row"]')).toHaveText([
    'Organization unit',
  ]);
  await expect(first).toContainText(SOURCE);
  await expect(first).toContainText(DESTINATION);
  // Each path breaks after a slash, so a long path wraps instead of overflowing.
  expect(await first.locator('td.approved wbr').count()).toBeGreaterThan(1);
  const excluded = groups.filter({ hasText: serials[excludedIndex]! });
  await expect(excluded.locator('.device-row')).toContainText(
    'Excluded · Removed from inventory',
  );
  await expect(excluded.locator('td.not-updated')).toHaveCount(1);
  await expectNoAxeViolations(page);

  await sheet.getByRole('button', { name: 'Continue to confirmation' }).click();
  await expect(
    sheet.getByRole('heading', { name: 'Confirm 5 device updates' }),
  ).toBeVisible();
  await expect(sheet.locator('.change-list li')).toHaveText([
    `Move 5 devices into ${DESTINATION}. Destination policies apply.`,
  ]);
  await expect(
    sheet.getByText(
      'Annotated location, annotated user, and notes remain unchanged.',
    ),
  ).toBeVisible();
  await expectNoAxeViolations(page);

  await sheet.getByRole('checkbox').check();
  await sheet.getByRole('button', { name: 'Create update job' }).click();
  await expect(
    sheet.getByText(
      '5 devices · 5 field changes. Google changes have not completed.',
    ),
  ).toBeVisible();

  // The worker applies the move and publishes the changed devices.
  await mock.settle();
  await sheet.getByRole('button', { name: 'Done' }).click();

  await setColumns(page, {
    show: ['Organization unit'],
    hide: ['Model', 'Asset tag', 'Battery', 'Device contact'],
  });
  for (const [index, serial] of serials.entries())
    await expect(gridCell(page, serial, 'orgUnitPath')).toHaveText(
      index === excludedIndex ? SOURCE : DESTINATION,
    );

  // The organization unit filter matches the chosen subtree.
  await page.getByRole('button', { name: 'Add a filter' }).click();
  const entry = page.getByRole('combobox', { name: 'Filter field' });
  await entry.fill('Organization unit');
  await page
    .getByRole('option', { name: 'Organization unit', exact: true })
    .click();
  const editor = page.getByRole('dialog', { name: 'Organization unit' });
  await expect(editor).toBeVisible();
  await editor
    .getByRole('checkbox', { name: 'Cart Devices', exact: true })
    .check();
  await editor.getByRole('button', { name: 'Apply' }).click();
  await expect(
    page.getByRole('button', { name: 'Remove filter' }),
  ).toBeVisible();
  // The moved devices are in the destination unit; the excluded device stays in the source.
  await expect(
    page.locator('.ag-row:has([col-id="serialNumber"])'),
  ).toHaveCount(5);
  await expect(
    page.getByRole('gridcell', { name: serials[excludedIndex]!, exact: true }),
  ).toHaveCount(0);
});

test('completion step 6: without the read scope the field is disabled and names the scope', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockApi(page, seedDevices(), { orgUnits: deniedOrgUnitTree });
  await openDevices(page);
  const sheet = await openSheet(page);
  const orgUnit = field(sheet, 'orgUnitPath');

  // The note names the one scope that the read needs (PNG 05).
  await expect(orgUnit).toContainText(
    'Google denied the organization unit tree. Add https://www.googleapis.com/auth/admin.directory.orgunit.readonly to the delegation client in the Google Admin Console.',
  );
  await expect(
    orgUnit.getByRole('button', { name: 'Copy scope' }),
  ).toBeVisible();
  await expect(orgUnit.getByRole('button', { name: 'Recheck' })).toBeVisible();
  // The field is disabled, so no mode panel opens.
  await expect(orgUnit.locator('.mat-form-field-disabled')).toBeVisible();
  await orgUnit.getByRole('combobox').click({ force: true });
  await expect(
    page.getByRole('option', { name: 'Move to an organization unit' }),
  ).toHaveCount(0);
  await expect(picker(page)).toHaveCount(0);
  // The other fields still work, and nothing is submitted with a disabled field.
  await expect(
    sheet.getByRole('button', { name: 'Save and preview' }),
  ).toBeDisabled();
  await expectNoAxeViolations(page);
});

test('regression: a retained Move waits for the organization unit read', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  let granted = true;
  const mock = await mockApi(page, seedDevices(), {
    orgUnitsAnswer: () => (granted ? orgUnitTree : deniedOrgUnitTree),
  });
  await openDevices(page);
  let sheet = await openSheet(page);

  // Choose a destination while the tree read is granted.
  await chooseMode(page, sheet, 'orgUnitPath', 'Move to an organization unit');
  await picker(page)
    .getByRole('button', { name: 'Expand Chrome Devices', exact: true })
    .click();
  await picker(page)
    .getByRole('treeitem', { name: 'Cart Devices', exact: true })
    .click();
  await picker(page)
    .getByRole('button', { name: 'Choose', exact: true })
    .click();
  await expect(picker(page)).toBeHidden();
  await sheet.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(sheet).not.toHaveClass(/is-open/);

  // The next read is refused; the field keeps the destination and disables.
  granted = false;
  sheet = await openSheet(page);
  const orgUnit = field(sheet, 'orgUnitPath');
  const save = sheet.getByRole('button', { name: 'Save and preview' });
  await expect(orgUnit.locator('.mat-form-field-disabled')).toBeVisible();
  await expect(orgUnit.locator('textarea')).toHaveValue(DESTINATION);
  await expect(orgUnit).toContainText(
    'Campus Commander cannot prepare this move until the organization unit read is granted.',
  );
  await expect(
    orgUnit.getByRole('button', { name: 'Discard move', exact: true }),
  ).toBeVisible();
  await expect(
    orgUnit.getByRole('button', { name: 'Choose organization unit' }),
  ).toBeDisabled();
  await expect(save).toBeDisabled();
  await expect(picker(page)).toHaveCount(0);
  // No preview left the page with the disabled Move.
  await expect(mock.posted.changes).toBeUndefined();
  await expectNoAxeViolations(page);
  // The blocked note sits below the scope note; scroll it into the evidence frame.
  await orgUnit
    .getByRole('button', { name: 'Discard move', exact: true })
    .scrollIntoViewIfNeeded();
  await screenshot(page, 'f3-r1-blocked-move.png');

  // A granted Recheck lets the retained destination travel unchanged.
  granted = true;
  await orgUnit.getByRole('button', { name: 'Recheck', exact: true }).click();
  await expect(save).toBeEnabled();
  await save.click();
  await expect(
    sheet.getByRole('heading', { name: 'Review 5 device updates' }),
  ).toBeVisible();
  expect(mock.posted.changes).toEqual([
    { field: 'orgUnitPath', mode: 'move', value: DESTINATION },
  ]);
});

test('regression: closing a reopened picker returns focus to the Destination button', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockApi(page, seedDevices());
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await openDevices(page);
  const sheet = await openSheet(page);

  // The first pick returns focus to the mode select.
  await chooseMode(page, sheet, 'orgUnitPath', 'Move to an organization unit');
  await picker(page)
    .getByRole('button', { name: 'Expand Chrome Devices', exact: true })
    .click();
  await picker(page)
    .getByRole('treeitem', { name: 'Cart Devices', exact: true })
    .click();
  await picker(page)
    .getByRole('button', { name: 'Choose', exact: true })
    .click();
  await expect(picker(page)).toBeHidden();
  await expect(field(sheet, 'orgUnitPath').getByRole('combobox')).toBeFocused();

  const destinationButton = field(sheet, 'orgUnitPath').getByRole('button', {
    name: 'Choose organization unit',
  });
  const reopen = async () => {
    await destinationButton.click();
    await expect(picker(page)).toBeVisible();
  };

  // Cancel returns focus to the Destination button.
  await reopen();
  await picker(page)
    .getByRole('button', { name: 'Cancel', exact: true })
    .click();
  await expect(picker(page)).toBeHidden();
  await expect(destinationButton).toBeFocused();

  // Choose returns it the same way.
  await reopen();
  await picker(page)
    .getByRole('button', { name: 'Choose', exact: true })
    .click();
  await expect(picker(page)).toBeHidden();
  await expect(destinationButton).toBeFocused();

  // Escape closes the picker only.
  await reopen();
  await page.keyboard.press('Escape');
  await expect(picker(page)).toBeHidden();
  await expect(destinationButton).toBeFocused();
  await expect(sheet).toHaveClass(/is-open/);

  // A click on the scrim reaches the same Cancel path.
  await reopen();
  await page.mouse.click(24, 200);
  await expect(picker(page)).toBeHidden();
  await expect(destinationButton).toBeFocused();
  expect(pageErrors).toEqual([]);
});

test('captures the approved states of PNG 03 and PNG 05 at 1440 x 900 in the light theme', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockApi(page, seedDevices());
  await openDevices(page);
  await page.evaluate(() => {
    document.documentElement.dataset['theme'] = 'light';
  });
  const sheet = await openSheet(page);

  // 03: the picker over the sheet, searched by path as the approved screen shows it.
  await chooseMode(page, sheet, 'orgUnitPath', 'Move to an organization unit');
  await expect(picker(page)).toBeVisible();
  await picker(page).locator('input[type="search"]').fill('cart');
  await expect(
    picker(page).getByRole('treeitem', { name: 'Cart Devices', exact: true }),
  ).toBeVisible();
  // A path break paints after each slash; the screenshot shows the wrapped path.
  await screenshot(page, 'f3-03-ou-picker-dialog.png');
  await picker(page)
    .getByRole('treeitem', { name: 'Cart Devices', exact: true })
    .click();
  await expect(
    picker(page).getByText(`Selected: ${DESTINATION}`),
  ).toBeVisible();
  await screenshot(page, 'f3-03b-ou-picker-selected.png');
  await picker(page)
    .getByRole('button', { name: 'Choose', exact: true })
    .click();
  await expect(picker(page)).toBeHidden();

  // 06: the Move rows of the frozen preview.
  await expect(
    sheet.getByRole('button', { name: 'Save and preview' }),
  ).toBeEnabled();
  await sheet.getByRole('button', { name: 'Save and preview' }).click();
  await expect(
    sheet.getByRole('heading', { name: 'Review 5 device updates' }),
  ).toBeVisible();
  await screenshot(page, 'f3-06-review-move-rows.png');

  // 07: the Move row of the confirmation, after the acknowledgement.
  await sheet.getByRole('button', { name: 'Continue to confirmation' }).click();
  await expect(
    sheet.getByRole('heading', { name: 'Confirm 5 device updates' }),
  ).toBeVisible();
  await sheet.getByRole('checkbox').check();
  await expect(sheet.locator('.mdc-checkbox__checkmark')).toHaveCSS(
    'opacity',
    '1',
  );
  await screenshot(page, 'f3-07-confirm-move-row.png');
});

test('captures the disabled field without the read scope (PNG 05)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockApi(page, seedDevices(), { orgUnits: deniedOrgUnitTree });
  await openDevices(page);
  await page.evaluate(() => {
    document.documentElement.dataset['theme'] = 'light';
  });
  const sheet = await openSheet(page);
  await field(sheet, 'orgUnitPath').scrollIntoViewIfNeeded();
  await expect(
    field(sheet, 'orgUnitPath').getByRole('button', { name: 'Copy scope' }),
  ).toBeVisible();
  await screenshot(page, 'f3-05-ou-read-scope-missing.png');
});

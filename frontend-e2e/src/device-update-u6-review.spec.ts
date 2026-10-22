import { expect, test, type Page } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Completion steps 1, 3, 4, and 5 of `docs/workflows/update-device-fields.md`, driven
 * through Chromium against the application API.
 *
 * This spec runs only against a production-U6 runtime: the `api-e2e:client-review-mock`
 * environment (or another running review environment). Every `/api` request reaches the
 * Nest application, PostgreSQL, the worker, and the Admin SDK mock. The mock answers every
 * Google call. No route is intercepted here, so the preview, the frozen targets, the
 * confirmation, the durable job, settlement, the device stream, and the inventory read are
 * the production paths.
 *
 * Start the runtime and this spec together with:
 *
 *   npm exec -- nx run frontend-e2e:client-review-update
 *
 * The normal Chromium suite skips these checks, because it runs without that runtime.
 * `CC_U6_REVIEW=1` and `BASE_URL` pointing at the review URL are the switch.
 */

interface ReviewRuntime {
  url: string;
  customerId: string;
  controlUrl: string;
  deviceCount: number;
  googleServices: string;
  sampleKeyPath: string;
  delegatedEmail: string;
}

const enabled = process.env['CC_U6_REVIEW'] === '1';
const REPLACE = 'Update · Replace the existing value';
const CLEAR = 'Clear value';
const LONG_NOTE = 'x'.repeat(501);

/** The workspace root, whatever directory Playwright runs the spec from. */
function workspaceRoot(): string {
  let directory = process.cwd();
  for (let step = 0; step < 6; step++) {
    if (existsSync(path.join(directory, 'nx.json'))) return directory;
    directory = path.dirname(directory);
  }
  throw new Error(`No workspace root above ${process.cwd()}.`);
}

const evidenceDir =
  process.env['EVIDENCE_DIR'] ??
  path.join(workspaceRoot(), 'dist/e2e-evidence');

function runtime(): ReviewRuntime {
  const file = path.join(workspaceRoot(), 'dist/client-review/runtime.json');
  const value = JSON.parse(readFileSync(file, 'utf8')) as ReviewRuntime;
  if (value.googleServices !== 'admin-sdk-mock')
    throw new Error(
      `Start api-e2e:client-review-mock before this spec: ${file} names ${value.googleServices}.`,
    );
  return value;
}

/** Every data row that carries a Serial cell. Pinned rows do not carry one. */
function dataRows(page: Page) {
  return page.locator('.ag-row:has([col-id="serialNumber"])');
}

function gridCell(page: Page, deviceId: string, column: string) {
  return page.locator(
    `.ag-row[row-id="${deviceId}"]:has([col-id="serialNumber"]) [col-id="${column}"]`,
  );
}

async function screenshot(page: Page, name: string) {
  mkdirSync(evidenceDir, { recursive: true });
  await page.screenshot({ path: path.join(evidenceDir, name) });
}

async function signIn(page: Page) {
  await page.goto('/api/auth/login');
  await page
    .getByRole('button', { name: 'Sign in as review administrator' })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Your account', exact: true }),
  ).toBeVisible({ timeout: 30_000 });
}

/** Connect the mock credential, then publish the inventory if it is empty. */
async function openDevices(page: Page) {
  await page.getByRole('link', { name: 'Devices' }).click();
  await expect(
    page.getByRole('heading', { name: 'Devices', level: 1 }),
  ).toBeVisible();
  const connect = page.getByRole('heading', {
    name: 'Connect Google Workspace',
  });
  const refreshInventory = page.getByRole('button', {
    name: 'Refresh inventory',
  });
  const refresh = page.getByRole('button', { name: 'Refresh', exact: true });
  await expect(connect.or(refreshInventory).or(refresh)).toBeVisible({
    timeout: 120_000,
  });
  if (await connect.isVisible()) {
    const review = runtime();
    await page.getByRole('link', { name: 'Open Google connection' }).click();
    await expect(
      page.getByRole('heading', { name: 'Import a service account' }),
    ).toBeVisible();
    await page
      .getByLabel('Service-account JSON key file')
      .setInputFiles(review.sampleKeyPath);
    await page
      .getByLabel('Delegated administrator email')
      .fill(review.delegatedEmail);
    await page.getByRole('button', { name: 'Check credentials' }).click();
    await expect(
      page.getByRole('heading', { name: 'Review Google customer' }),
    ).toBeVisible({ timeout: 120_000 });
    await page
      .getByRole('checkbox', {
        name: 'I verified this customer ID and primary domain',
      })
      .check();
    await page.getByRole('button', { name: 'Confirm customer' }).click();
    await expect(
      page.getByRole('heading', { name: 'Customer connected' }),
    ).toBeVisible({ timeout: 120_000 });
    await page.getByRole('link', { name: 'Devices' }).click();
    await expect(
      page.getByRole('heading', { name: 'Devices', level: 1 }),
    ).toBeVisible();
    // The store reads the sync state after the page opens, so wait for its control again.
    await expect(refreshInventory.or(refresh)).toBeVisible({
      timeout: 120_000,
    });
  }
  if (await refreshInventory.isVisible()) await refreshInventory.click();
  await expect
    .poll(async () => (await readSync(page))?.status, { timeout: 600_000 })
    .toBe('ready');
  await expect(dataRows(page).first()).toBeVisible({ timeout: 300_000 });
  await page.waitForTimeout(1000);
}

/** Read the inventory projection the grid uses. */
async function readSync(
  page: Page,
): Promise<{ status?: string; checkedAt?: string } | null> {
  return page.evaluate(async () => {
    const response = await fetch('/api/devices/sync', {
      headers: { accept: 'application/json' },
    });
    return (await response.json()).sync;
  }) as Promise<{ status?: string; checkedAt?: string } | null>;
}

/** Show the three annotation columns and hide the columns this check does not read. */
async function showAnnotationColumns(page: Page) {
  await page.getByRole('tab', { name: 'Columns', exact: true }).click();
  for (const name of ['Annotated location', 'Annotated user', 'Notes'])
    await page.getByRole('checkbox', { name: `Show ${name}` }).check();
  for (const name of [
    'Model',
    'Asset tag',
    'Organization unit',
    'Battery',
    'Device contact',
  ])
    await page.getByRole('checkbox', { name: `Show ${name}` }).uncheck();
  await page.getByRole('tab', { name: 'Columns', exact: true }).click();
  await expect(
    page.getByRole('columnheader', { name: 'Annotated location' }),
  ).toBeVisible();
}

interface DeviceValues {
  id: string;
  serial: string;
  location: string;
  user: string;
  notes: string;
}

/** Read the values of the given rows as the grid renders them. */
async function readRows(
  page: Page,
  ids: readonly string[],
): Promise<DeviceValues[]> {
  return Promise.all(
    ids.map(async (id) => ({
      id,
      serial: (await gridCell(page, id, 'serialNumber').innerText()).trim(),
      location: (
        await gridCell(page, id, 'annotatedLocation').innerText()
      ).trim(),
      user: (await gridCell(page, id, 'annotatedUser').innerText()).trim(),
      notes: (await gridCell(page, id, 'notes').innerText()).trim(),
    })),
  );
}

/** The device IDs of the rows at `offset` through `offset + count`. */
async function deviceIds(
  page: Page,
  offset: number,
  count: number,
): Promise<string[]> {
  const rows = dataRows(page);
  await expect(rows.first()).toBeVisible();
  const available = await rows.count();
  if (available < offset + count)
    throw new Error(
      `The grid rendered ${available} rows; ${offset + count} are needed.`,
    );
  const ids: string[] = [];
  for (let index = offset; index < offset + count; index++) {
    const id = await rows.nth(index).getAttribute('row-id');
    if (!id) throw new Error(`Row ${index} carries no device ID.`);
    ids.push(id);
  }
  return ids;
}

/** Replace the current selection with the given rows. */
async function selectDevices(page: Page, ids: readonly string[]) {
  const deselect = page.getByRole('button', { name: 'Deselect All' });
  if ((await deselect.count()) && (await deselect.isEnabled()))
    await deselect.click();
  for (const id of ids)
    await page
      .locator(`.ag-row[row-id="${id}"]`)
      .getByRole('checkbox')
      .first()
      .check();
  await expect(page.getByText(`Total Selected: ${ids.length}`)).toBeVisible({
    timeout: 30_000,
  });
}

/** Check the delegated write scope once per environment. */
async function ensureWriteAccess(page: Page) {
  const recheck = page.getByRole('button', { name: 'Recheck' });
  if (await recheck.isVisible().catch(() => false)) await recheck.click();
  await expect(page.locator('#bulk-note')).toHaveCount(0, { timeout: 60_000 });
}

async function openSheet(page: Page) {
  await page.getByRole('button', { name: 'Bulk Actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Update device' }).click();
  const sheet = page.locator('app-device-update-sheet .bulk-sheet');
  await expect(sheet).toHaveClass(/is-open/);
  // The sheet reads the stored selection before its fields render.
  await expect(sheet.locator('.field-block').first()).toBeVisible({
    timeout: 60_000,
  });
  return sheet;
}

function field(sheet: ReturnType<Page['locator']>, id: string) {
  return sheet.locator(`.field-block[data-field="${id}"]`);
}

async function chooseMode(
  page: Page,
  sheet: ReturnType<Page['locator']>,
  id: string,
  option: string,
) {
  await field(sheet, id).getByRole('combobox').click();
  await page.getByRole('option', { name: option, exact: true }).click();
  await expect(page.locator('.mat-mdc-select-panel')).toBeHidden();
}

async function fillValue(
  page: Page,
  sheet: ReturnType<Page['locator']>,
  id: string,
  value: string,
) {
  const input = field(sheet, id).getByLabel('New value');
  await input.fill(value);
  await expect(input).toHaveValue(value);
}

/** Clear the draft that a previous job left in this tab. */
async function resetDraft(sheet: ReturnType<Page['locator']>) {
  const reset = sheet.getByRole('button', { name: 'Reset', exact: true });
  if (await reset.isEnabled()) await reset.click();
  await expect(
    sheet.getByText(/\d+ devices? · 0 changed fields · Not submitted$/),
  ).toBeVisible();
}

interface SettledJob {
  displayId: string;
  status: string;
  succeeded: number;
}

/** Read the durable job until it reaches a terminal status. */
async function waitForJob(
  page: Page,
  displayId: string,
  timeoutMs = 300_000,
): Promise<SettledJob> {
  const deadline = Date.now() + timeoutMs;
  let job: {
    status?: string;
    progress?: { succeeded?: number };
  } | null = null;
  while (Date.now() < deadline) {
    const answer = (await page.evaluate(async (id) => {
      const response = await fetch(`/api/jobs/${id}`, {
        headers: { accept: 'application/json' },
      });
      return response.ok ? await response.json() : null;
    }, displayId)) as {
      status?: string;
      progress?: { succeeded?: number };
    } | null;
    job = answer;
    if (
      job?.status &&
      ['completed', 'completed-with-errors', 'failed', 'needs-review'].includes(
        job.status,
      )
    )
      return {
        displayId,
        status: job.status,
        succeeded: job.progress?.succeeded ?? 0,
      };
    await page.waitForTimeout(1000);
  }
  throw new Error(`Job ${displayId} did not settle: ${JSON.stringify(job)}`);
}

/** Confirm the acknowledgement, create the job, and read its display ID. */
async function createJob(
  page: Page,
  sheet: ReturnType<Page['locator']>,
): Promise<string> {
  await sheet.getByRole('checkbox').check();
  await sheet.getByRole('button', { name: 'Create update job' }).click();
  await expect(
    sheet.getByRole('heading', { name: 'Your job is saved' }),
  ).toBeVisible({ timeout: 120_000 });
  const subtitle = await sheet.getByText(/^Job UPD-\d+ · /).innerText();
  const displayId = subtitle.match(/UPD-\d+/)?.[0];
  if (!displayId) throw new Error(`No job display ID in ${subtitle}`);
  return displayId;
}

/** Close the sheet and wait for it to leave the viewport before a grid screenshot. */
async function closeSheet(
  page: Page,
  sheet: ReturnType<Page['locator']>,
): Promise<void> {
  await sheet.getByRole('button', { name: 'Done' }).click();
  await expect(sheet).not.toHaveClass(/is-open/, { timeout: 30_000 });
  await page.waitForTimeout(400);
}

/** The API row of each device, read with the session CSRF token. */
async function apiRows(
  page: Page,
  ids: readonly string[],
): Promise<Record<string, Record<string, unknown>>> {
  const rows = await page.evaluate(async (deviceIds) => {
    const sessionResponse = await fetch('/api/auth/session', {
      headers: { accept: 'application/json' },
    });
    const session = (await sessionResponse.json()) as { csrfToken: string };
    const response = await fetch('/api/devices/by-ids', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'x-csrf-token': session.csrfToken,
      },
      body: JSON.stringify({ deviceIds }),
    });
    return response.ok
      ? ((await response.json()) as { rows: Record<string, unknown>[] }).rows
      : [];
  }, ids);
  return Object.fromEntries(rows.map((row) => [String(row['deviceId']), row]));
}

/** Mark one device absent from the mock's directory, then read the inventory again. */
async function removeFromInventory(
  page: Page,
  deviceId: string,
  review: ReviewRuntime,
) {
  const response = await fetch(
    `${review.controlUrl}/domains/${review.customerId}/faults`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'remove-entity', entityId: deviceId }),
    },
  );
  if (!response.ok)
    throw new Error(
      `The mock refused the removal fault: ${response.status} ${await response.text()}`,
    );
  const before = await page.evaluate(async () => {
    const response = await fetch('/api/devices/sync', {
      headers: { accept: 'application/json' },
    });
    return ((await response.json()) as { sync?: { checkedAt?: string } }).sync
      ?.checkedAt;
  });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Refresh Devices' }).click();
  let checkedAt: string | undefined = before;
  for (let attempt = 0; attempt < 300; attempt++) {
    checkedAt = await page
      .evaluate(async () => {
        const response = await fetch('/api/devices/sync', {
          headers: { accept: 'application/json' },
        });
        const sync = (await response.json()) as {
          sync?: { status?: string; checkedAt?: string };
        };
        if (sync.sync?.status === 'failed')
          throw new Error('The inventory refresh failed.');
        return sync.sync?.status === 'ready' ? sync.sync.checkedAt : undefined;
      })
      .catch((error: Error) => {
        throw error;
      });
    if (checkedAt && checkedAt !== before) break;
    await page.waitForTimeout(1000);
  }
  if (!checkedAt || checkedAt === before)
    throw new Error('The inventory refresh did not finish.');
  await page.waitForTimeout(2000);
}

/** Remove the removal fault so a reused environment can publish the device again. */
async function restoreInventory(review: ReviewRuntime) {
  await fetch(`${review.controlUrl}/domains/${review.customerId}/faults`, {
    method: 'DELETE',
  });
}

/** What the Review table shows for an empty value. */
function shown(value: string): string {
  return value === '' ? 'No value' : value;
}

/** One device group of the frozen targets. */
function targetGroup(sheet: ReturnType<Page['locator']>, serial: string) {
  return sheet.locator('.targets tbody').filter({ hasText: serial });
}

const suite = enabled ? test.describe : test.describe.skip;

suite('Update device against the U6 API', () => {
  // The review runtime uses a development certificate for its loopback origin.
  test.use({ ignoreHTTPSErrors: true });

  test('completion steps 1, 3, and 4 settle the job and show the new values in place', async ({
    page,
  }) => {
    test.setTimeout(900_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);
    await openDevices(page);
    await showAnnotationColumns(page);

    const ids = await deviceIds(page, 0, 6);
    const before = await readRows(page, ids);
    await selectDevices(page, ids);
    await ensureWriteAccess(page);

    const stamp = Date.now().toString(36);
    const location = `North lab ${stamp}`;
    const notes = `Cart 7 loaner pool ${stamp}`;
    const user = `maya.chen+${stamp}@example.org`;

    // Step 1: change Annotated location and Notes, leave Annotated user alone.
    let sheet = await openSheet(page);
    const save = sheet.getByRole('button', { name: 'Save and preview' });
    await expect(save).toBeDisabled();
    await chooseMode(page, sheet, 'annotatedLocation', REPLACE);
    await fillValue(page, sheet, 'annotatedLocation', location);
    await chooseMode(page, sheet, 'notes', REPLACE);
    await fillValue(page, sheet, 'notes', notes);
    await expect(
      sheet.getByText('6 devices · 2 changed fields · Not submitted'),
    ).toBeVisible();
    await expect(save).toBeEnabled();
    await save.click();
    await expect(
      sheet.getByRole('heading', { name: 'Review 6 device updates' }),
    ).toBeVisible({ timeout: 120_000 });
    await expect(
      sheet.getByText('6 devices · 12 field changes · 0 excluded'),
    ).toBeVisible();
    await expect(sheet.locator('.targets tbody')).toHaveCount(6, {
      timeout: 120_000,
    });
    const firstGroup = targetGroup(sheet, before[0]!.serial);
    await expect(firstGroup.locator('th[scope="row"]')).toHaveText([
      'Annotated location',
      'Notes',
    ]);
    await expect(firstGroup).toContainText(shown(before[0]!.location));
    await expect(firstGroup).toContainText(location);
    await expect(firstGroup).toContainText(notes);
    await screenshot(page, 'f2-u6-review-preview.png');

    await sheet
      .getByRole('button', { name: 'Continue to confirmation' })
      .click();
    await expect(
      sheet.getByRole('heading', { name: 'Confirm 6 device updates' }),
    ).toBeVisible({ timeout: 60_000 });
    await expect(sheet.locator('.change-list li')).toHaveText([
      `Set the annotated location to ${location} on 6 devices.`,
      `Set the notes to ${notes} on 6 devices.`,
    ]);
    await expect(
      sheet.getByText('Annotated user remains unchanged.'),
    ).toBeVisible();
    await expect(
      sheet.getByText(/^Preview PV-\d+ · 6 devices · 12 field changes$/),
    ).toBeVisible();
    await screenshot(page, 'f2-u6-confirm.png');

    const firstJob = await createJob(page, sheet);
    await expect(
      sheet.getByText(
        '6 devices · 12 field changes. Google changes have not completed.',
      ),
    ).toBeVisible();
    await screenshot(page, 'f2-u6-receipt.png');
    const settled = await waitForJob(page, firstJob);
    expect(settled.status).toBe('completed');
    expect(settled.succeeded).toBe(6);
    await closeSheet(page, sheet);

    // The worker publishes the changed devices; the grid shows the new values in place.
    for (const device of before) {
      await expect(gridCell(page, device.id, 'annotatedLocation')).toHaveText(
        location,
        { timeout: 120_000 },
      );
      await expect(gridCell(page, device.id, 'notes')).toHaveText(notes, {
        timeout: 120_000,
      });
      // The unchanged field keeps the value the device held before the job.
      await expect(gridCell(page, device.id, 'annotatedUser')).toHaveText(
        device.user,
      );
    }
    await screenshot(page, 'f2-u6-grid-after-update.png');
    // The API holds the same values as the grid.
    const afterFirst = await apiRows(page, ids);
    for (const device of before) {
      expect(afterFirst[device.id]?.['annotatedLocation']).toBe(location);
      expect(afterFirst[device.id]?.['notes']).toBe(notes);
      expect(afterFirst[device.id]?.['annotatedUser']).toBe(
        device.user === '' ? null : device.user,
      );
    }

    // Step 3: set Annotated user and show the optional column.
    await selectDevices(page, ids);
    await ensureWriteAccess(page);
    sheet = await openSheet(page);
    await resetDraft(sheet);
    await chooseMode(page, sheet, 'annotatedUser', REPLACE);
    await fillValue(page, sheet, 'annotatedUser', user);
    await sheet.getByRole('button', { name: 'Save and preview' }).click();
    await expect(
      sheet.getByRole('heading', { name: 'Review 6 device updates' }),
    ).toBeVisible({ timeout: 120_000 });
    await expect(
      sheet.getByText('6 devices · 6 field changes · 0 excluded'),
    ).toBeVisible();
    await expect(targetGroup(sheet, before[0]!.serial)).toContainText(user);
    await sheet
      .getByRole('button', { name: 'Continue to confirmation' })
      .click();
    await expect(sheet.locator('.change-list li')).toHaveText([
      `Set the annotated user to ${user} on 6 devices.`,
    ]);
    await expect(
      sheet.getByText('Annotated location and notes remain unchanged.'),
    ).toBeVisible();
    const secondJob = await createJob(page, sheet);
    expect((await waitForJob(page, secondJob)).succeeded).toBe(6);
    await closeSheet(page, sheet);
    for (const device of before)
      await expect(gridCell(page, device.id, 'annotatedUser')).toHaveText(
        user,
        {
          timeout: 120_000,
        },
      );
    await screenshot(page, 'f2-u6-grid-annotated-user.png');

    // Step 4: clear Notes that the first job made nonempty.
    await selectDevices(page, ids);
    await ensureWriteAccess(page);
    sheet = await openSheet(page);
    await resetDraft(sheet);
    await chooseMode(page, sheet, 'notes', CLEAR);
    await expect(
      sheet.getByText('6 devices · 1 changed field · Not submitted'),
    ).toBeVisible();
    await sheet.getByRole('button', { name: 'Save and preview' }).click();
    await expect(
      sheet.getByRole('heading', { name: 'Review 6 device updates' }),
    ).toBeVisible({ timeout: 120_000 });
    await expect(
      sheet.getByText('6 devices · 6 field changes · 0 excluded'),
    ).toBeVisible();
    await expect(targetGroup(sheet, before[0]!.serial)).toContainText(
      'Cleared',
    );
    await sheet
      .getByRole('button', { name: 'Continue to confirmation' })
      .click();
    await expect(sheet.locator('.change-list li')).toHaveText([
      'Clear the notes on 6 devices.',
    ]);
    const thirdJob = await createJob(page, sheet);
    expect((await waitForJob(page, thirdJob)).succeeded).toBe(6);
    await closeSheet(page, sheet);
    for (const device of before)
      await expect(gridCell(page, device.id, 'notes')).toHaveText('', {
        timeout: 120_000,
      });
    const afterClear = await apiRows(page, ids);
    for (const device of before)
      expect(afterClear[device.id]?.['notes']).toBeNull();
    await screenshot(page, 'f2-u6-grid-cleared-notes.png');
  });

  test('completion step 1 keeps an excluded device and its values', async ({
    page,
  }) => {
    test.setTimeout(900_000);
    const review = runtime();
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);
    await openDevices(page);
    await showAnnotationColumns(page);

    // Rows after the six of the previous check, so the two checks do not share devices.
    const ids = await deviceIds(page, 6, 6);
    const before = await readRows(page, ids);
    await selectDevices(page, ids);
    await removeFromInventory(page, ids[0]!, review);
    await ensureWriteAccess(page);

    const location = `North lab excluded ${Date.now().toString(36)}`;
    const sheet = await openSheet(page);
    await chooseMode(page, sheet, 'annotatedLocation', REPLACE);
    await fillValue(page, sheet, 'annotatedLocation', location);
    await sheet.getByRole('button', { name: 'Save and preview' }).click();
    await expect(
      sheet.getByRole('heading', { name: 'Review 5 device updates' }),
    ).toBeVisible({ timeout: 120_000 });
    await expect(
      sheet.getByText('6 devices · 5 field changes · 1 excluded'),
    ).toBeVisible();
    const excluded = sheet
      .locator('.targets tbody')
      .filter({ hasText: before[0]!.serial });
    await expect(excluded.locator('.device-row')).toContainText(
      'Excluded · Removed from inventory',
    );
    await expect(excluded.locator('td.not-updated')).toHaveText('Not updated');
    // The frozen observed value is the one the device held before the removal.
    await expect(excluded).toContainText(shown(before[0]!.location));
    await screenshot(page, 'f2-u6-excluded-review.png');

    await sheet
      .getByRole('button', { name: 'Continue to confirmation' })
      .click();
    await expect(
      sheet.getByRole('heading', { name: 'Update 1 field on 5 devices' }),
    ).toBeVisible({ timeout: 60_000 });
    await expect(sheet.locator('.change-list li')).toHaveText([
      `Set the annotated location to ${location} on 5 devices.`,
    ]);
    const displayId = await createJob(page, sheet);
    await expect(
      sheet.getByText(
        '5 devices · 5 field changes. Google changes have not completed.',
      ),
    ).toBeVisible();
    const settled = await waitForJob(page, displayId);
    expect(settled.status).toBe('completed');
    expect(settled.succeeded).toBe(5);
    await closeSheet(page, sheet);

    for (const device of before.slice(1))
      await expect(gridCell(page, device.id, 'annotatedLocation')).toHaveText(
        location,
        { timeout: 120_000 },
      );
    // The excluded device is gone from the grid, and its cached values never changed.
    const removed = await apiRows(page, [before[0]!.id]);
    expect(removed[before[0]!.id]?.['annotatedLocation']).toBe(
      before[0]!.location === '' ? null : before[0]!.location,
    );
    await restoreInventory(review);
  });

  test('completion step 5 refuses a value over its limit', async ({ page }) => {
    test.setTimeout(600_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);
    await openDevices(page);
    await showAnnotationColumns(page);
    const ids = await deviceIds(page, 12, 1);
    await selectDevices(page, ids);
    await ensureWriteAccess(page);
    const sheet = await openSheet(page);
    const save = sheet.getByRole('button', { name: 'Save and preview' });
    // Requirement 2: no change, no save.
    await expect(save).toBeDisabled();
    await chooseMode(page, sheet, 'notes', REPLACE);
    await fillValue(page, sheet, 'notes', LONG_NOTE);
    await expect(sheet.getByText('501 of 500 characters')).toBeVisible();
    await expect(
      sheet.getByText('Notes holds 1 to 500 characters.'),
    ).toBeVisible();
    await expect(save).toBeDisabled();
    await screenshot(page, 'f2-u6-notes-over-limit.png');
  });
});

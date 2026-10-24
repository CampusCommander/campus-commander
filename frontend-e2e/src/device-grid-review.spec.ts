import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import https from 'node:https';
import path from 'node:path';

/**
 * Completion steps 1 to 7 of `docs/workflows/in-grid-editing.md`, driven through Chromium
 * against the application API.
 *
 * This spec runs only against the `api-e2e:client-review-mock` environment. Every `/api`
 * request reaches the Nest application, PostgreSQL, the worker, and the Admin SDK mock. No
 * route is intercepted, so the draft, the edit preview, the fresh Google read, the confirm,
 * the durable job, the worker write, and the device stream are the production paths.
 *
 * Start the runtime and this spec together with:
 *
 *   node frontend-e2e/client-review-grid.mjs
 *
 * The normal Chromium suite skips these checks, because it runs without that runtime.
 * `CC_IGE_REVIEW=1` and `BASE_URL` pointing at the review URL are the switch.
 */

interface ReviewRuntime {
  url: string;
  customerId: string;
  controlUrl: string;
  caFile: string;
  sampleKeyPath: string;
  delegatedEmail: string;
  googleServices: string;
}

interface JobAnswer {
  status?: string;
  progress?: { succeeded?: number; failed?: number };
}

const enabled = process.env['CC_IGE_REVIEW'] === '1';
const REPLACE = 'Update · Replace the existing value';
const WRITE_SCOPE =
  'https://www.googleapis.com/auth/admin.directory.device.chromeos';

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
  path.join(workspaceRoot(), 'dist/e2e-evidence/ige-review');

function runtime(): ReviewRuntime {
  const file = path.join(workspaceRoot(), 'dist/client-review/runtime.json');
  const value = JSON.parse(readFileSync(file, 'utf8')) as ReviewRuntime;
  if (value.googleServices !== 'admin-sdk-mock')
    throw new Error(
      `Start api-e2e:client-review-mock before this spec: ${file} names ${value.googleServices}.`,
    );
  return value;
}

async function screenshot(page: Page, name: string): Promise<void> {
  mkdirSync(evidenceDir, { recursive: true });
  await page.screenshot({
    path: path.join(evidenceDir, name),
    fullPage: false,
  });
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/api/auth/login');
  await page
    .getByRole('button', { name: 'Sign in as review administrator' })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Your account', exact: true }),
  ).toBeVisible({ timeout: 30_000 });
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

/** Connect the mock credential if the installation has none, then publish the inventory. */
async function openDevices(page: Page): Promise<void> {
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

/** Every data row that carries a Serial cell. Pinned rows do not carry one. */
function dataRows(page: Page) {
  return page.locator('.ag-row:has([col-id="serialNumber"])');
}

function cell(page: Page, serial: string, colId: string) {
  return page
    .locator('.ag-row', {
      has: page.getByRole('gridcell', { name: serial, exact: true }),
    })
    .locator(`.ag-cell[col-id="${colId}"]`);
}

async function readCell(
  page: Page,
  serial: string,
  colId: string,
): Promise<string> {
  return (
    await cell(page, serial, colId).locator('.device-cell-value').innerText()
  ).trim();
}

/** Show and hide grid columns through the Columns tool panel. */
async function setColumns(
  page: Page,
  show: readonly string[],
  hide: readonly string[],
): Promise<void> {
  const tab = page.getByRole('tab', { name: 'Columns', exact: true });
  await tab.click();
  const panel = page.locator('#lgr-side-bar-columns-panel');
  await expect(panel).toBeVisible();
  for (const name of show)
    await panel.getByRole('checkbox', { name: `Show ${name}` }).check();
  for (const name of hide)
    await panel.getByRole('checkbox', { name: `Show ${name}` }).uncheck();
  await tab.click();
  await expect(panel).toBeHidden();
}

/** Open one cell editor, type the value, and commit it with Enter. The Notes field uses
 * AG Grid's large-text editor, which renders in a popup outside the cell. */
async function editText(
  page: Page,
  serial: string,
  colId: string,
  value: string,
): Promise<void> {
  const target = cell(page, serial, colId);
  await target.dblclick();
  const editor =
    colId === 'notes'
      ? page.locator('.ag-popup-editor textarea').first()
      : target.locator('input, textarea').first();
  await expect(editor).toBeVisible();
  await editor.fill(value);
  await editor.press('Enter');
  await expect(editor).toHaveCount(0);
  await expect(target).toHaveClass(/device-draft-pending/);
  await expect(target.locator('.device-cell-value')).toHaveText(value);
}

/** The device IDs and serials of the rows at `offset` through `offset + count`. */
async function firstRows(
  page: Page,
  count: number,
  offset = 0,
): Promise<{ id: string; serial: string }[]> {
  const rows = dataRows(page);
  await expect(rows.first()).toBeVisible();
  const available = await rows.count();
  if (available < offset + count)
    throw new Error(
      `The grid rendered ${available} rows; ${offset + count} are needed.`,
    );
  const found: { id: string; serial: string }[] = [];
  for (let index = offset; index < offset + count; index++) {
    const row = rows.nth(index);
    const id = await row.getAttribute('row-id');
    if (!id) throw new Error(`Row ${index} carries no device ID.`);
    const serial = (
      await row.locator('[col-id="serialNumber"]').innerText()
    ).trim();
    found.push({ id, serial });
  }
  return found;
}

/** Filter the grid to one serial so the other pending row leaves the query. */
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
  await expect(
    page.getByText(/1 matching devices? · 600 in district/),
  ).toBeVisible();
}

/** Read the durable job until it reaches a terminal status. */
async function waitForJob(
  page: Page,
  displayId: string,
  timeoutMs = 300_000,
): Promise<JobAnswer> {
  const deadline = Date.now() + timeoutMs;
  let job: JobAnswer | null = null;
  while (Date.now() < deadline) {
    job = (await page.evaluate(async (id) => {
      const response = await fetch(`/api/jobs/${id}`, {
        headers: { accept: 'application/json' },
      });
      return response.ok ? await response.json() : null;
    }, displayId)) as JobAnswer | null;
    if (
      job?.status &&
      ['completed', 'completed-with-errors', 'failed', 'needs-review'].includes(
        job.status,
      )
    )
      return job;
    await page.waitForTimeout(1000);
  }
  throw new Error(`Job ${displayId} did not settle: ${JSON.stringify(job)}`);
}

/** The display ID of the receipt that the sheet shows. */
async function receiptJobId(page: Page): Promise<string> {
  const subtitle = page.getByText(/^Job UPD-\d+ · /);
  await expect(subtitle).toBeVisible({ timeout: 120_000 });
  const text = await subtitle.innerText();
  const displayId = text.match(/UPD-\d+/)?.[0];
  if (!displayId) throw new Error(`No job display ID in ${text}`);
  return displayId;
}

/** The acknowledgement checkbox of the open Update device sheet. */
function sheetAcknowledgement(page: Page) {
  return page
    .locator('app-device-update-sheet .bulk-sheet')
    .getByRole('checkbox');
}

/** Answer the Review and Confirm steps of a several-change save. */
async function reviewConfirmCreate(page: Page): Promise<string> {
  await expect(
    page.getByRole('heading', { name: /^Review \d+ device updates?$/ }),
  ).toBeVisible({ timeout: 120_000 });
  await page.getByRole('button', { name: 'Continue to confirmation' }).click();
  await expect(
    page.getByRole('heading', { name: /^Confirm \d+ device updates?$/ }),
  ).toBeVisible({ timeout: 120_000 });
  await sheetAcknowledgement(page).check();
  await page.getByRole('button', { name: 'Create update job' }).click();
  await expect(
    page.getByRole('heading', { name: 'Update job created' }),
  ).toBeVisible({ timeout: 120_000 });
  return receiptJobId(page);
}

/** The number of fields each device row of the Review table carries. */
async function reviewRowCounts(page: Page): Promise<number[]> {
  return page
    .locator('.targets tbody')
    .evaluateAll((bodies) =>
      bodies.map((body) => body.querySelectorAll('tr').length),
    );
}

/** One operation row of the job page. */
interface OperationRow {
  device: string;
  operation: string;
  before: string;
  requested: string;
  outcome: string;
}

async function operationRows(page: Page): Promise<OperationRow[]> {
  const rows = page.locator('table.operations-table tbody tr');
  await expect(rows.first()).toBeVisible({ timeout: 120_000 });
  const count = await rows.count();
  const found: OperationRow[] = [];
  for (let index = 0; index < count; index++) {
    const cells = rows.nth(index).locator('td');
    found.push({
      device: (await cells.nth(0).innerText()).trim().split('\n').at(-1) ?? '',
      operation: (await cells.nth(1).innerText()).trim(),
      before: (await cells.nth(2).innerText()).trim(),
      requested: (await cells.nth(3).innerText()).trim(),
      // A failed row appends Google's reason under the chip.
      outcome: (await cells.nth(4).innerText()).trim().split('\n')[0] ?? '',
    });
  }
  return found;
}

/** The mock container that serves the review runtime, found by its control port. */
function mockContainer(controlUrl: string): {
  name: string;
  googlePort: number;
} {
  const controlPort = new URL(controlUrl).port;
  const listing = execFileSync(
    'docker',
    ['ps', '--format', '{{.Names}} {{.Ports}}'],
    { encoding: 'utf8' },
  );
  const line = listing
    .split('\n')
    .find((entry) => entry.includes(`:${controlPort}->8080/tcp`));
  const googlePort = line?.match(/:(\d+)->443\/tcp/)?.[1];
  if (!line || !googlePort)
    throw new Error(
      `No mock container publishes the control port ${controlPort}.\n${listing}`,
    );
  return { name: line.split(' ')[0]!, googlePort: Number(googlePort) };
}

/** Mint an access token for the mock's administrator through its control API. */
async function mockToken(review: ReviewRuntime): Promise<string> {
  const response = await fetch(
    `${review.controlUrl}/domains/${review.customerId}/tokens`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        subject: review.delegatedEmail,
        scopes: [WRITE_SCOPE],
      }),
    },
  );
  if (response.status !== 200)
    throw new Error(`The mock token request answered ${response.status}.`);
  return (await response.json()).access_token as string;
}

/** Add or clear mock fault rules through the control API. */
async function addFault(
  review: ReviewRuntime,
  rule: Record<string, unknown>,
): Promise<void> {
  const response = await fetch(
    `${review.controlUrl}/domains/${review.customerId}/faults`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(rule),
    },
  );
  if (response.status !== 201)
    throw new Error(
      `The mock refused the fault: ${response.status} ${await response.text()}`,
    );
}

async function clearFaults(review: ReviewRuntime): Promise<void> {
  await fetch(`${review.controlUrl}/domains/${review.customerId}/faults`, {
    method: 'DELETE',
  });
}

/** Write one Google path through the mock's published Google port. */
function mockGooglePatch(
  review: ReviewRuntime,
  port: number,
  deviceId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; text: string }> {
  const host = 'admin.googleapis.com';
  const payload = JSON.stringify(body);
  const ca = readFileSync(review.caFile, 'utf8');
  return (async () => {
    const token = await mockToken(review);
    return new Promise((resolve, reject) => {
      const request = https.request(
        {
          host,
          port,
          path: `/admin/directory/v1/customer/${encodeURIComponent(
            review.customerId,
          )}/devices/chromeos/${encodeURIComponent(deviceId)}`,
          method: 'PATCH',
          ca,
          servername: host,
          lookup: (_name, _options, done) =>
            done(null, [{ address: '127.0.0.1', family: 4 }]),
          headers: {
            host,
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
          },
          timeout: 20_000,
        },
        (response) => {
          let text = '';
          response.on('data', (chunk) => (text += chunk));
          response.on('end', () =>
            resolve({ status: response.statusCode ?? 0, text }),
          );
        },
      );
      request.on('error', reject);
      request.on('timeout', () =>
        request.destroy(new Error('The mock Google request timed out.')),
      );
      request.end(payload);
    });
  })();
}

const suite = enabled ? test.describe : test.describe.skip;

suite('In-grid editing against the Admin SDK mock', () => {
  // The review runtime uses a development certificate for its loopback origin.
  test.use({ ignoreHTTPSErrors: true });

  test('step 1: two pending cells on two devices and their count', async ({
    page,
  }) => {
    test.setTimeout(600_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);
    await openDevices(page);
    await setColumns(
      page,
      ['Annotated location', 'Notes'],
      ['Model', 'Battery', 'Device contact', 'Organization unit'],
    );

    const [first, second] = await firstRows(page, 2);
    const stamp = Date.now().toString(36);
    const location = `North lab ${stamp}`;
    const notes = `Cart 7 loaner pool ${stamp}`;
    await editText(page, first!.serial, 'annotatedLocation', location);
    await expect(page.locator('#draft-count')).toHaveText(
      '1 pending change · 1 device',
    );
    await expect(cell(page, first!.serial, 'annotatedLocation')).toHaveClass(
      /device-draft-pending/,
    );
    await editText(page, second!.serial, 'notes', notes);
    await expect(page.locator('#draft-count')).toHaveText(
      '2 pending changes · 2 devices',
    );
    await expect(cell(page, second!.serial, 'notes')).toHaveClass(
      /device-draft-pending/,
    );
    await expect(
      page.getByRole('button', { name: 'Save changes', exact: true }),
    ).toBeEnabled();
    await screenshot(page, 'step1-pending-cells.png');

    // Revert the two cells so the next step starts from the same inventory.
    for (const [row, column] of [
      [first!, 'annotatedLocation'],
      [second!, 'notes'],
    ] as const)
      await page
        .getByRole('button', {
          name: `Revert ${column === 'annotatedLocation' ? 'annotated location' : 'notes'} of ${row.serial}`,
          exact: true,
        })
        .click();
    await expect(page.locator('.draft-bar')).toHaveCount(0);
  });

  test('step 2: the pending view lists changed rows inside and outside the filter', async ({
    page,
  }) => {
    test.setTimeout(600_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);
    await openDevices(page);
    await setColumns(
      page,
      ['Annotated location', 'Notes'],
      ['Model', 'Battery', 'Device contact', 'Organization unit'],
    );

    const [first, second] = await firstRows(page, 2);
    const stamp = Date.now().toString(36);
    await editText(
      page,
      first!.serial,
      'annotatedLocation',
      `In filter ${stamp}`,
    );
    await editText(page, second!.serial, 'notes', `Out of filter ${stamp}`);
    await expect(page.locator('#draft-count')).toHaveText(
      '2 pending changes · 2 devices',
    );

    // The person's query keeps the first device. The second leaves the filter.
    await filterSerial(page, first!.serial);
    await expect(
      page.getByRole('gridcell', { name: second!.serial, exact: true }),
    ).toHaveCount(0);
    await screenshot(page, 'step2-filtered-query.png');

    await page
      .getByRole('button', { name: 'Show pending changes', exact: true })
      .click();
    const back = page.getByRole('button', {
      name: 'Show all devices',
      exact: true,
    });
    await expect(back).toHaveAttribute('aria-pressed', 'true');
    // Both changed rows list, inside and outside the person's filter.
    await expect(
      page.getByRole('gridcell', { name: first!.serial, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('gridcell', { name: second!.serial, exact: true }),
    ).toBeVisible();
    await expect(page.locator('#draft-count')).toHaveText(
      '2 pending changes · 2 devices',
    );
    await expect(page.locator('.draft-line')).toHaveText(
      'Showing only devices with pending changes. Show all devices returns to your filters.',
    );
    await screenshot(page, 'step2-pending-view.png');

    // Show all devices restores the person's query, and the draft keeps both changes.
    await back.click();
    await expect(
      page.getByRole('button', { name: 'Show pending changes', exact: true }),
    ).toHaveAttribute('aria-pressed', 'false');
    await expect(
      page.getByRole('gridcell', { name: second!.serial, exact: true }),
    ).toHaveCount(0);
    await expect(page.locator('#draft-count')).toHaveText(
      '2 pending changes · 2 devices',
    );
    await screenshot(page, 'step2-restored-query.png');

    // Revert both changes so the next step starts from the same inventory.
    await page.getByRole('button', { name: 'Revert all changes' }).click();
    await page
      .getByRole('alertdialog', { name: 'Revert all changes?' })
      .getByRole('button', { name: 'Revert all changes' })
      .click();
    await expect(page.locator('.draft-bar')).toHaveCount(0);
  });

  test('step 3: revert one cell, then revert all names the count and clears', async ({
    page,
  }) => {
    test.setTimeout(600_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);
    await openDevices(page);
    await setColumns(
      page,
      ['Annotated location', 'Notes'],
      ['Model', 'Battery', 'Device contact', 'Organization unit'],
    );

    const [first, second] = await firstRows(page, 2);
    const stamp = Date.now().toString(36);
    const firstBaseline = await readCell(
      page,
      first!.serial,
      'annotatedLocation',
    );
    await editText(
      page,
      first!.serial,
      'annotatedLocation',
      `Revert me ${stamp}`,
    );
    await editText(page, second!.serial, 'notes', `Revert all ${stamp}`);
    await expect(page.locator('#draft-count')).toHaveText(
      '2 pending changes · 2 devices',
    );

    // The cell icon restores the baseline and removes only that change.
    await page
      .getByRole('button', {
        name: `Revert annotated location of ${first!.serial}`,
        exact: true,
      })
      .click();
    await expect(
      cell(page, first!.serial, 'annotatedLocation'),
    ).not.toHaveClass(/device-draft-pending/);
    await expect(
      cell(page, first!.serial, 'annotatedLocation').locator(
        '.device-cell-value',
      ),
    ).toHaveText(firstBaseline);
    await expect(page.locator('#draft-count')).toHaveText(
      '1 pending change · 1 device',
    );

    // Revert all asks once, names the count, then clears the pending set.
    await page.getByRole('button', { name: 'Revert all changes' }).click();
    const dialog = page.getByRole('alertdialog', {
      name: 'Revert all changes?',
    });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('1 pending change · 1 device');
    await screenshot(page, 'step3-revert-all-question.png');
    await dialog.getByRole('button', { name: 'Revert all changes' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('.draft-bar')).toHaveCount(0);
    await expect(cell(page, second!.serial, 'notes')).not.toHaveClass(
      /device-draft-pending/,
    );
    await screenshot(page, 'step3-cleared.png');
  });

  test('step 4: one pending change saves without Review or Confirm', async ({
    page,
  }) => {
    test.setTimeout(600_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);
    await openDevices(page);
    await setColumns(
      page,
      ['Annotated location'],
      ['Model', 'Battery', 'Device contact', 'Organization unit'],
    );

    const [row] = await firstRows(page, 1, 2);
    const value = `One change ${Date.now().toString(36)}`;
    await editText(page, row!.serial, 'annotatedLocation', value);
    await expect(page.locator('#draft-count')).toHaveText(
      '1 pending change · 1 device',
    );
    await screenshot(page, 'step4-before-save.png');

    await page
      .getByRole('button', { name: 'Save changes', exact: true })
      .click();
    // The receipt opens at once: no stepper, no Review, and no Confirm.
    await expect(
      page.getByRole('heading', { name: 'Update job created' }),
    ).toBeVisible({ timeout: 120_000 });
    await expect(page.getByText('Your job is saved')).toBeVisible();
    await expect(
      page.getByRole('list', { name: 'Update device steps' }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Continue to confirmation' }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('heading', { name: /^Review \d+ device updates?$/ }),
    ).toHaveCount(0);
    const displayId = await receiptJobId(page);
    await screenshot(page, 'step4-receipt.png');
    const job = await waitForJob(page, displayId);
    expect(job.status).toBe('completed');
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(page.locator('.draft-bar')).toHaveCount(0);
  });

  test('step 5: several changes pass Review and Confirm into one job of rows', async ({
    page,
  }) => {
    test.setTimeout(900_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);
    await openDevices(page);
    await setColumns(
      page,
      ['Annotated location', 'Notes'],
      ['Model', 'Battery', 'Device contact', 'Organization unit'],
    );

    const [first, second] = await firstRows(page, 2);
    const stamp = Date.now().toString(36);
    const location = `Grid save ${stamp}`;
    const notes = `Two fields on one device ${stamp}`;
    const tag = `QA-STEP5-${stamp}`.toUpperCase();
    const secondTag = await readCell(page, second!.serial, 'assetTag');

    await editText(page, first!.serial, 'annotatedLocation', location);
    await editText(page, first!.serial, 'notes', notes);
    await editText(page, second!.serial, 'assetTag', tag);
    await expect(page.locator('#draft-count')).toHaveText(
      '3 pending changes · 2 devices',
    );

    await page
      .getByRole('button', { name: 'Save changes', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: 'Review 2 device updates' }),
    ).toBeVisible({ timeout: 180_000 });
    await expect(
      page.getByText('2 devices · 3 field changes · 0 excluded'),
    ).toBeVisible();
    await expect(page.locator('.targets tbody')).toHaveCount(2, {
      timeout: 60_000,
    });
    const reviewRows = await reviewRowCounts(page);
    expect(reviewRows.reduce((sum, rows) => sum + rows, 0)).toBe(5);
    await screenshot(page, 'step5-review.png');

    await page
      .getByRole('button', { name: 'Continue to confirmation' })
      .click();
    await expect(
      page.getByRole('heading', { name: 'Update 3 fields on 2 devices' }),
    ).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('.change-list li')).toHaveCount(3);
    const ack = sheetAcknowledgement(page);
    await ack.check();
    await expect(ack).toBeChecked();
    await expect(
      page.locator('app-device-update-sheet mat-checkbox.acknowledgement'),
    ).toHaveClass(/mat-mdc-checkbox-checked/);
    await screenshot(page, 'step5-confirm.png');

    await page.getByRole('button', { name: 'Create update job' }).click();
    await expect(
      page.getByRole('heading', { name: 'Update job created' }),
    ).toBeVisible({ timeout: 120_000 });
    await expect(page.getByText('2 devices · 3 field changes')).toBeVisible();
    const displayId = await receiptJobId(page);
    await screenshot(page, 'step5-receipt.png');

    // One job holds one row per device and field.
    await page.getByRole('button', { name: 'View job' }).click();
    await waitForJob(page, displayId);
    await page.reload();
    await expect(
      page.getByText(new RegExp(`^Job ${displayId} · `)),
    ).toBeVisible({ timeout: 60_000 });
    const rows = await operationRows(page);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.operation).sort()).toEqual([
      'Annotated location',
      'Asset tag',
      'Notes',
    ]);
    expect(rows.map((row) => row.device).sort()).toEqual(
      [first!.serial, first!.serial, second!.serial].sort(),
    );
    expect(rows.find((row) => row.device === second!.serial)?.requested).toBe(
      tag,
    );
    expect(
      rows.find((row) => row.operation === 'Annotated location')?.requested,
    ).toBe(location);
    expect(rows.find((row) => row.operation === 'Notes')?.requested).toBe(
      notes,
    );
    expect(rows.find((row) => row.operation === 'Asset tag')?.device).toBe(
      second!.serial,
    );
    expect(rows.find((row) => row.operation === 'Asset tag')?.before).toBe(
      secondTag,
    );
    expect(rows.every((row) => row.outcome === 'Succeeded')).toBe(true);
    await screenshot(page, 'step5-job.png');
  });

  test('step 6: a partial failure keeps the old value and a stale baseline makes a conflict cell', async ({
    page,
  }) => {
    test.setTimeout(900_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const review = runtime();
    const mock = mockContainer(review.controlUrl);
    await clearFaults(review);

    await signIn(page);
    await openDevices(page);
    await setColumns(
      page,
      ['Annotated location'],
      ['Model', 'Battery', 'Device contact', 'Organization unit'],
    );

    // Partial failure: the first PATCH of the job is refused, so that device keeps its
    // old value and the other device takes its new value.
    const [first, second] = await firstRows(page, 2, 3);
    const stamp = Date.now().toString(36);
    const firstBaseline = await readCell(
      page,
      first!.serial,
      'annotatedLocation',
    );
    const secondBaseline = await readCell(
      page,
      second!.serial,
      'annotatedLocation',
    );
    const firstValue = `Partial fail ${stamp}`;
    const secondValue = `Partial success ${stamp}`;
    await editText(page, first!.serial, 'annotatedLocation', firstValue);
    await editText(page, second!.serial, 'annotatedLocation', secondValue);
    await addFault(review, {
      kind: 'status',
      method: 'directory.chromeosdevices.patch',
      status: 400,
      reason: 'invalid',
      count: 1,
    });

    await page
      .getByRole('button', { name: 'Save changes', exact: true })
      .click();
    const displayId = await reviewConfirmCreate(page);
    await page.getByRole('button', { name: 'View job' }).click();
    const job = await waitForJob(page, displayId);
    expect(job.status).toBe('completed-with-errors');
    await page.reload();
    const rows = await operationRows(page);
    expect(rows).toHaveLength(2);
    const failed = rows.filter((row) => row.outcome === 'Failed');
    const succeeded = rows.filter((row) => row.outcome === 'Succeeded');
    expect(failed).toHaveLength(1);
    expect(succeeded).toHaveLength(1);
    const failedSerial = failed[0]!.device;
    const failedBaseline =
      failedSerial === first!.serial ? firstBaseline : secondBaseline;
    const failedValue =
      failedSerial === first!.serial ? firstValue : secondValue;
    // The job page renders an empty before value as "Not set".
    const shown = (value: string): string => (value === '' ? 'Not set' : value);
    expect(failed[0]!.before).toBe(shown(failedBaseline));
    expect(failed[0]!.requested).toBe(failedValue);
    const succeededSerial = succeeded[0]!.device;
    const succeededValue =
      succeededSerial === first!.serial ? firstValue : secondValue;
    expect(succeeded[0]!.requested).toBe(succeededValue);
    await screenshot(page, 'step6-failed-job.png');

    // The failed device keeps its old value in the grid; the succeeded device shows its
    // new value. The SSE publication settles both cells without a reload.
    await clearFaults(review);
    await page.getByRole('link', { name: 'Devices' }).click();
    await expect(dataRows(page).first()).toBeVisible({ timeout: 120_000 });
    // The Devices page restores its own column set; show the edited column again.
    await setColumns(
      page,
      ['Annotated location'],
      ['Model', 'Battery', 'Device contact', 'Organization unit'],
    );
    const failedCell = cell(page, failedSerial, 'annotatedLocation');
    await expect(failedCell.locator('.device-cell-value')).toHaveText(
      failedBaseline,
      { timeout: 180_000 },
    );
    await expect(failedCell.locator('.cell-state.accepted')).toHaveCount(0);
    const succeededCell = cell(page, succeededSerial, 'annotatedLocation');
    await expect(succeededCell.locator('.device-cell-value')).toHaveText(
      succeededValue,
      { timeout: 180_000 },
    );
    await screenshot(page, 'step6-failed-device-cell.png');

    // Stale baseline: the grid holds the old value, then a direct mock PATCH changes the
    // value in Google. The fresh read at Save makes the row a conflict.
    const [conflict] = await firstRows(page, 1, 5);
    const conflictBaseline = await readCell(
      page,
      conflict!.serial,
      'annotatedLocation',
    );
    const draft = `Grid draft ${stamp}`;
    const outside = `Set outside the app ${stamp}`;
    await editText(page, conflict!.serial, 'annotatedLocation', draft);
    const patched = await mockGooglePatch(
      review,
      mock.googlePort,
      conflict!.id,
      { annotatedLocation: outside },
    );
    expect(patched.status).toBe(200);
    // The direct write changes the value away from the baseline that the grid holds.
    expect(outside).not.toBe(conflictBaseline);
    await page
      .getByRole('button', { name: 'Save changes', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: 'Review 1 device update' }),
    ).toBeVisible({ timeout: 180_000 });
    await expect(
      page.getByText('1 device · 1 field change · 0 excluded · 1 conflict'),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Continue to confirmation' }),
    ).toBeDisabled();
    await screenshot(page, 'step6-conflict-review.png');

    await page.getByRole('button', { name: 'Review pending devices' }).click();
    const sheet = page.locator('app-device-update-sheet .bulk-sheet');
    await expect(sheet).not.toHaveClass(/is-open/, { timeout: 30_000 });
    // Let the 200 ms close transition finish before the screenshot.
    await page.waitForTimeout(450);
    const conflictCell = cell(page, conflict!.serial, 'annotatedLocation');
    await expect(conflictCell).toHaveClass(/device-draft-conflict/);
    await expect(conflictCell).toContainText(`Current value: ${outside}`);
    await expect(
      page.getByRole('button', { name: 'Save changes', exact: true }),
    ).toBeDisabled();
    await screenshot(page, 'step6-conflict-cell.png');

    // Resolve the conflict so the environment is clean for the next step.
    await page
      .getByRole('button', {
        name: `Resolve conflict on annotated location of ${conflict!.serial}`,
      })
      .click();
    await expect(
      page.getByRole('heading', {
        name: 'The location changed after you began editing',
      }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Keep current value' }).click();
    await expect(page.locator('.draft-bar')).toHaveCount(0);
  });

  test('step 7: device details updates one device with Asset tag through Edit, Review, and Confirm', async ({
    page,
  }) => {
    test.setTimeout(900_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);
    await openDevices(page);

    const [row] = await firstRows(page, 1, 6);
    const serial = row!.serial;
    // Open device details from the grid row.
    await page
      .getByRole('button', {
        name: `Open details for ${serial}`,
        exact: true,
      })
      .click();
    await expect(
      page.getByRole('heading', { name: serial, exact: true }),
    ).toBeVisible({ timeout: 60_000 });

    const update = page.getByRole('button', { name: 'Update device' });
    await expect(update).toBeEnabled();
    await screenshot(page, 'step7-device-details.png');
    await update.click();

    const sheet = page.locator('app-device-update-sheet .bulk-sheet');
    await expect(sheet).toHaveClass(/is-open/);
    await expect(
      sheet.getByRole('heading', { name: 'Update 1 device' }),
    ).toBeVisible();
    const order = await sheet
      .locator('.field-block')
      .evaluateAll((blocks) =>
        blocks.map((block) => block.getAttribute('data-field')),
      );
    expect(order).toEqual([
      'annotatedLocation',
      'annotatedAssetId',
      'annotatedUser',
      'notes',
      'orgUnitPath',
    ]);
    const assetBlock = sheet.locator(
      '.field-block[data-field="annotatedAssetId"]',
    );
    await assetBlock.locator('.mat-mdc-select-trigger').click();
    await expect(page.getByRole('option')).toHaveText([
      'Leave unchanged',
      'Update · Replace the existing value',
    ]);
    await page.getByRole('option', { name: REPLACE }).click();
    await expect(page.locator('.mat-mdc-select-panel')).toBeHidden();
    const tag = `QA-STEP7-${Date.now().toString(36)}`.toUpperCase();
    await assetBlock.locator('input').fill(tag);
    await screenshot(page, 'step7-sheet.png');

    await sheet.getByRole('button', { name: 'Save and preview' }).click();
    await expect(
      sheet.getByRole('heading', { name: 'Review 1 device update' }),
    ).toBeVisible({ timeout: 180_000 });
    await expect(sheet).toContainText(tag);
    await screenshot(page, 'step7-review.png');

    await sheet
      .getByRole('button', { name: 'Continue to confirmation' })
      .click();
    await expect(
      sheet.getByRole('heading', { name: 'Confirm 1 device update' }),
    ).toBeVisible({ timeout: 60_000 });
    await sheet.getByRole('checkbox').check();
    const ack = sheetAcknowledgement(page);
    await expect(ack).toBeChecked();
    await expect(
      page.locator('app-device-update-sheet mat-checkbox.acknowledgement'),
    ).toHaveClass(/mat-mdc-checkbox-checked/);
    await screenshot(page, 'step7-confirm.png');

    await sheet.getByRole('button', { name: 'Create update job' }).click();
    await expect(
      sheet.getByRole('heading', { name: 'Update job created' }),
    ).toBeVisible({ timeout: 120_000 });
    const displayId = await receiptJobId(page);
    await screenshot(page, 'step7-receipt.png');
    const job = await waitForJob(page, displayId);
    expect(job.status).toBe('completed');

    await sheet.getByRole('button', { name: 'Back to device' }).click();
    await expect(sheet).not.toHaveClass(/is-open/, { timeout: 30_000 });
    await page.waitForTimeout(450);
    await expect(page.getByText(`· ${tag}`, { exact: false })).toBeVisible({
      timeout: 120_000,
    });
    await screenshot(page, 'step7-details-after.png');
  });
});

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { devicePageSchema } from '@campus/application-contracts';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

/**
 * The Update device sheet with the three text fields of F2 (record 2026-10-21): the Edit
 * step, the rows per device and field, the confirmation, and the receipt for several fields.
 * The mocked answers follow the U6 API shapes: `changes`, `fieldChanges`, and one target row
 * per device and changed field.
 */

const customerId = 'C0123456';
const observedAt = '2026-10-21T12:00:00.000Z';
const previewId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const jobId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const evidenceDir =
  process.env['EVIDENCE_DIR'] ?? path.join(process.cwd(), 'dist/e2e-evidence');

const grants = [
  { action: 'devices:read', scope: { kind: 'district', customerId } },
  { action: 'devices:write', scope: { kind: 'district', customerId } },
  { action: 'devices:bulk-actions', scope: { kind: 'district', customerId } },
];

const devices = [
  { deviceId: 'synthetic-device-1', serialNumber: '01P0T1V' },
  { deviceId: 'synthetic-device-2', serialNumber: '02A1MB6' },
  { deviceId: 'synthetic-device-3', serialNumber: '02QJANY' },
  { deviceId: 'synthetic-device-4', serialNumber: '04QVJBY' },
  { deviceId: 'synthetic-device-5', serialNumber: '04XTBHJ' },
  { deviceId: 'synthetic-device-6', serialNumber: '0727D2E' },
];
/** Removed from inventory: the preview excludes it and every field row reads "Not updated". */
const excludedDeviceId = 'synthetic-device-2';

const observed = {
  annotatedLocation: 'Science wing',
  annotatedUser: 'luis.ortiz@example.org',
  notes: null,
} as const;

const LONG_NOTE =
  'Cart 7 loaner pool. Check the charger and the power strip before each lesson. ' +
  'Students sign the loan sheet at the library desk and return the device before the last bell. ' +
  'Report a cracked screen, a missing key, or a loose hinge to the help desk on the same day. ' +
  'Wipe the keyboard and the screen with the approved cloth at the end of each day. ' +
  'Keep the cart locked when no teacher is in the room. ' +
  'Charge every device overnight and leave the cart plugged in during holidays. ' +
  'The library staff counts the devices every Friday afternoon and logs the result.';

type Change = {
  field: 'annotatedLocation' | 'annotatedUser' | 'notes';
  mode: 'replace' | 'clear';
  value?: string;
};

const rows = devices.map((device, index) => ({
  ...device,
  model: 'Dell Chromebook 3100',
  assetTag: `CB66246${index}`,
  orgUnitPath: '/Chrome Devices/Lowell Academy/One to One',
  lastContact: '2026-10-21T11:58:00Z',
  annotatedLocation: observed.annotatedLocation,
  annotatedUser: observed.annotatedUser,
  notes: observed.notes,
  status: 'ACTIVE',
  battery: {
    status: 'reported' as const,
    health: 'normal' as const,
    capacityPercent: 91,
    reportedAt: '2026-10-21T11:00:00Z',
  },
  lastEntitySync: observedAt,
  stale: false,
}));

/** The preview answer of the posted changes. The excluded device counts as one device. */
function buildPreview(changes: Change[]) {
  const eligible = devices.filter(
    (device) => device.deviceId !== excludedDeviceId,
  ).length;
  return {
    previewId,
    displayId: 'PV-009',
    changes,
    fieldChanges: eligible * changes.length,
    selected: devices.length,
    eligible,
    unchanged: 0,
    excluded: 1,
    oldestObservedAt: '2026-10-21T10:00:00.000Z',
    stale: false,
    preparedAt: '2026-10-21T18:02:00.000Z',
    expiresAt: '2026-10-21T18:17:00.000Z',
    manifestDigest: 'a'.repeat(64),
  };
}

/** One target row per device and change, in the order of the contract. */
function buildTargets(changes: Change[]) {
  return devices.flatMap((device) =>
    changes.map((change) => {
      const excluded = device.deviceId === excludedDeviceId;
      return {
        deviceId: device.deviceId,
        serialNumber: device.serialNumber,
        field: change.field,
        observedValue: excluded ? null : observed[change.field],
        approvedValue:
          excluded || change.mode === 'clear' ? null : (change.value ?? null),
        disposition: excluded ? 'excluded' : 'eligible',
        exclusionReason: excluded ? 'removed' : null,
      };
    }),
  );
}

interface MockOptions {
  /** The preview request body of the last POST, for an assertion. */
  posted?: { changes: Change[] };
}

async function mockApi(page: Page, options: MockOptions = {}) {
  let preview = buildPreview([
    { field: 'annotatedLocation', mode: 'replace', value: 'North lab' },
  ]);
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const routePath = url.pathname;
    const method = request.method();

    if (method === 'POST' && routePath === '/api/devices/updates/previews') {
      const body = request.postDataJSON() as { changes: Change[] };
      options.posted = body;
      preview = buildPreview(body.changes);
      return route.fulfill({ status: 201, json: preview });
    }
    if (
      method === 'GET' &&
      routePath === `/api/devices/updates/previews/${previewId}`
    )
      return route.fulfill({ json: preview });
    if (
      method === 'GET' &&
      routePath.startsWith('/api/devices/updates/previews/') &&
      routePath.endsWith('/targets')
    )
      return route.fulfill({
        json: { targets: buildTargets(preview.changes), nextCursor: null },
      });
    if (method === 'POST' && routePath.endsWith('/confirm'))
      return route.fulfill({
        status: 201,
        json: {
          jobId,
          displayId: 'UPD-007',
          status: 'accepted',
          deviceCount: preview.eligible,
          updateCount: preview.eligible,
        },
      });
    if (routePath === '/api/jobs/UPD-007')
      return route.fulfill({
        json: {
          jobId,
          displayId: 'UPD-007',
          revision: 1,
          action: 'update-device-annotations',
          status: 'accepted',
          scope: { kind: 'devices', deviceCount: preview.eligible },
          requestedBy: {
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            displayName: 'District operator',
          },
          createdAt: '2026-10-21T18:03:00.000Z',
          startedAt: null,
          finishedAt: null,
          progress: {
            total: preview.eligible,
            succeeded: 0,
            failed: 0,
            unknown: 0,
            skipped: 0,
            expired: 0,
            pending: preview.eligible,
          },
          failure: null,
          confirmedBy: {
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            displayName: 'District operator',
          },
          previewDisplayId: 'PV-009',
          changes: preview.changes,
          commandType: null,
          statusAction: null,
          targetOrgUnitPaths: [],
          correlationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          latestActivity: {
            at: '2026-10-21T18:03:00.000Z',
            failed: { count: 0, operations: [] },
            unknown: { count: 0, operations: [] },
          },
        },
      });
    if (routePath === '/api/application')
      return route.fulfill({
        json: {
          phase: 3,
          authenticationConfigured: true,
          version: 'development',
          build: 'client-review',
        },
      });
    if (routePath === '/api/auth/session')
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
    if (routePath === '/api/devices/selection')
      return route.fulfill({
        json: {
          selection: {
            terms: [],
            groups: [],
            added: rows.length,
            excluded: 0,
            selectedCount: rows.length,
            expiredAt: null,
          },
        },
      });
    if (routePath === '/api/devices/selection/resolve')
      return route.fulfill({ json: { selected: {} } });
    if (routePath === '/api/devices/sync')
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
    if (routePath === '/api/devices/query')
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
    if (routePath === '/api/devices/freshness')
      return route.fulfill({
        json: { freshness: { stale: 0, refreshing: false } },
      });
    if (routePath === '/api/devices/org-units')
      return route.fulfill({ json: { orgUnits: [] } });
    if (routePath === '/api/devices/events')
      return route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: '',
      });
    if (routePath === '/api/devices/updates/access')
      return route.fulfill({
        json: {
          state: 'granted',
          scope:
            'https://www.googleapis.com/auth/admin.directory.device.chromeos',
          failure: null,
          checkedAt: '2026-10-21T12:00:00.000Z',
        },
      });
    if (routePath === '/api/customer')
      return route.fulfill({ json: { customer: null } });
    if (routePath === '/api/google-connection')
      return route.fulfill({ json: { connection: null } });
    if (routePath === '/api/google-connection/health')
      return route.fulfill({ json: { health: null } });
    if (routePath === '/api/auth/preferences')
      return route.fulfill({ json: request.postDataJSON() });
    return route.fulfill({ status: 404, json: {} });
  });
}

async function openDevices(page: Page) {
  await page.goto('/devices');
  await expect(
    page.getByRole('heading', { name: 'Devices', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('gridcell', { name: '01P0T1V', exact: true }),
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

async function fillValue(
  page: Page,
  sheet: ReturnType<Page['locator']>,
  id: string,
  value: string,
) {
  const input = field(sheet, id).getByLabel('New value');
  await input.fill(value);
  await expect(input).toHaveValue(value);
  return input;
}

async function expectNoAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .exclude('.cdk-overlay-container')
    .analyze();
  expect(results.violations).toEqual([]);
}

async function screenshot(page: Page, name: string) {
  mkdirSync(evidenceDir, { recursive: true });
  await page.screenshot({ path: path.join(evidenceDir, name) });
}

test('completion step 1: changes Annotated location and Notes and leaves Annotated user unchanged', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const options: MockOptions = {};
  await mockApi(page, options);
  await openDevices(page);
  const sheet = await openSheet(page);

  await chooseMode(
    page,
    sheet,
    'annotatedLocation',
    'Update · Replace the existing value',
  );
  await fillValue(page, sheet, 'annotatedLocation', 'North lab');
  await chooseMode(page, sheet, 'notes', 'Update · Replace the existing value');
  await fillValue(page, sheet, 'notes', 'Cart 7 loaner pool');
  await expect(
    sheet.getByText('6 devices · 2 changed fields · Not submitted'),
  ).toBeVisible();
  await expectNoAxeViolations(page);

  await sheet.getByRole('button', { name: 'Save and preview' }).click();
  await expect(
    sheet.getByRole('heading', { name: 'Review 5 device updates' }),
  ).toBeVisible();
  expect(options.posted?.changes).toEqual([
    { field: 'annotatedLocation', mode: 'replace', value: 'North lab' },
    { field: 'notes', mode: 'replace', value: 'Cart 7 loaner pool' },
  ]);
  await expect(
    sheet.getByText('6 devices · 10 field changes · 1 excluded'),
  ).toBeVisible();
  await expect(sheet.getByText('Field changes', { exact: true })).toBeVisible();

  // One row group per device and one row per changed field.
  const groups = sheet.locator('.targets tbody');
  await expect(groups).toHaveCount(6);
  const first = groups.first();
  await expect(first.locator('.device-row')).toContainText('01P0T1V');
  await expect(first.locator('th[scope="row"]')).toHaveText([
    'Annotated location',
    'Notes',
  ]);
  await expect(first).toContainText('Science wing');
  await expect(first).toContainText('North lab');
  await expect(first).toContainText('No value');
  await expect(first).toContainText('Cart 7 loaner pool');

  const excluded = groups.filter({ hasText: '02A1MB6' });
  await expect(excluded.locator('.device-row')).toContainText(
    'Excluded · Removed from inventory',
  );
  await expect(excluded.locator('td.not-updated')).toHaveCount(2);
  await expectNoAxeViolations(page);

  await sheet.getByRole('button', { name: 'Continue to confirmation' }).click();
  await expect(
    sheet.getByRole('heading', { name: 'Confirm 5 device updates' }),
  ).toBeVisible();
  await expect(
    sheet.getByRole('heading', { name: 'Update 2 fields on 5 devices' }),
  ).toBeVisible();
  await expect(sheet.locator('.change-list li')).toHaveText([
    'Set the annotated location to North lab on 5 devices.',
    'Set the notes to Cart 7 loaner pool on 5 devices.',
  ]);
  await expect(
    sheet.getByText('Annotated user remains unchanged.'),
  ).toBeVisible();
  await expect(
    sheet.getByText('Preview PV-009 · 6 devices · 10 field changes'),
  ).toBeVisible();
  await expectNoAxeViolations(page);

  await sheet.getByRole('checkbox').check();
  await sheet.getByRole('button', { name: 'Create update job' }).click();
  await expect(
    sheet.getByRole('heading', { name: 'Your job is saved' }),
  ).toBeVisible();
  await expect(
    sheet.getByText(
      '5 devices · 10 field changes. Google changes have not completed.',
    ),
  ).toBeVisible();
  await expectNoAxeViolations(page);
});

test('completion step 3: sets Annotated user on the devices', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const options: MockOptions = {};
  await mockApi(page, options);
  await openDevices(page);
  const sheet = await openSheet(page);

  await chooseMode(
    page,
    sheet,
    'annotatedUser',
    'Update · Replace the existing value',
  );
  await fillValue(page, sheet, 'annotatedUser', 'maya.chen@example.org');
  await expect(
    sheet.getByText('6 devices · 1 changed field · Not submitted'),
  ).toBeVisible();
  await sheet.getByRole('button', { name: 'Save and preview' }).click();
  await expect(
    sheet.getByRole('heading', { name: 'Review 5 device updates' }),
  ).toBeVisible();
  expect(options.posted?.changes).toEqual([
    {
      field: 'annotatedUser',
      mode: 'replace',
      value: 'maya.chen@example.org',
    },
  ]);
  const first = sheet.locator('.targets tbody').first();
  await expect(first.locator('th[scope="row"]')).toHaveText(['Annotated user']);
  await expect(first).toContainText('luis.ortiz@example.org');
  await expect(first).toContainText('maya.chen@example.org');

  await sheet.getByRole('button', { name: 'Continue to confirmation' }).click();
  await expect(sheet.locator('.change-list li')).toHaveText([
    'Set the annotated user to maya.chen@example.org on 5 devices.',
  ]);
  await expect(
    sheet.getByText('Annotated location and notes remain unchanged.'),
  ).toBeVisible();
});

test('completion step 4: clears Notes on the devices', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const options: MockOptions = {};
  await mockApi(page, options);
  await openDevices(page);
  const sheet = await openSheet(page);

  await chooseMode(page, sheet, 'notes', 'Clear value');
  await expect(
    sheet.getByText('6 devices · 1 changed field · Not submitted'),
  ).toBeVisible();
  await expect(field(sheet, 'notes').getByLabel('New value')).toHaveCount(0);
  await sheet.getByRole('button', { name: 'Save and preview' }).click();
  await expect(
    sheet.getByRole('heading', { name: 'Review 5 device updates' }),
  ).toBeVisible();
  expect(options.posted?.changes).toEqual([{ field: 'notes', mode: 'clear' }]);
  const first = sheet.locator('.targets tbody').first();
  await expect(first).toContainText('No value');
  await expect(first.locator('td.approved')).toHaveText('Cleared');

  await sheet.getByRole('button', { name: 'Continue to confirmation' }).click();
  await expect(sheet.locator('.change-list li')).toHaveText([
    'Clear the notes on 5 devices.',
  ]);
});

test('completion step 5: refuses a value over its limit and names the field and the limit', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockApi(page);
  await openDevices(page);
  const sheet = await openSheet(page);

  const save = sheet.getByRole('button', { name: 'Save and preview' });
  await expect(save).toBeDisabled();

  await chooseMode(
    page,
    sheet,
    'annotatedLocation',
    'Update · Replace the existing value',
  );
  await fillValue(page, sheet, 'annotatedLocation', 'a'.repeat(201));
  await expect(
    field(sheet, 'annotatedLocation').getByText(
      'Annotated location holds 1 to 200 characters.',
    ),
  ).toBeVisible();
  await expect(
    field(sheet, 'annotatedLocation').getByText('201 of 200 characters'),
  ).toBeVisible();
  await expect(save).toBeDisabled();

  await chooseMode(
    page,
    sheet,
    'annotatedUser',
    'Update · Replace the existing value',
  );
  await fillValue(page, sheet, 'annotatedUser', 'a'.repeat(101));
  await expect(
    field(sheet, 'annotatedUser').getByText(
      'Annotated user holds 1 to 100 characters.',
    ),
  ).toBeVisible();
  await expect(save).toBeDisabled();

  await chooseMode(page, sheet, 'notes', 'Update · Replace the existing value');
  await fillValue(page, sheet, 'notes', LONG_NOTE);
  await expect(
    field(sheet, 'notes').getByText('553 of 500 characters'),
  ).toBeVisible();
  const notesError = field(sheet, 'notes').getByText(
    'Notes holds 1 to 500 characters.',
  );
  await expect(notesError).toBeVisible();
  await expect(notesError).toHaveAttribute('role', 'alert');
  await expect(save).toBeDisabled();
  await expectNoAxeViolations(page);
});

test('captures the six approved states at 1440 x 900 in the light theme', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockApi(page);
  await openDevices(page);
  await page.evaluate(() => {
    document.documentElement.dataset['theme'] = 'light';
  });
  const sheet = await openSheet(page);

  // 01: every field at Leave unchanged.
  await expect(sheet.getByText('Leave unchanged')).toHaveCount(3);
  await screenshot(page, 'f2-01-edit-leave-unchanged.png');

  // 02: three changed fields without Asset tag and Organization unit.
  await chooseMode(
    page,
    sheet,
    'annotatedLocation',
    'Update · Replace the existing value',
  );
  await fillValue(page, sheet, 'annotatedLocation', 'North lab');
  await chooseMode(
    page,
    sheet,
    'annotatedUser',
    'Update · Replace the existing value',
  );
  await fillValue(page, sheet, 'annotatedUser', 'maya.chen@example.org');
  await chooseMode(page, sheet, 'notes', 'Update · Replace the existing value');
  await fillValue(page, sheet, 'notes', 'Cart 7 loaner pool');
  await expect(
    sheet.getByText('6 devices · 3 changed fields · Not submitted'),
  ).toBeVisible();
  await screenshot(page, 'f2-02-edit-three-changes.png');

  // 04: the Notes value is over its limit and Save and preview stays disabled.
  await fillValue(page, sheet, 'notes', LONG_NOTE);
  await expect(
    field(sheet, 'notes').getByText('Notes holds 1 to 500 characters.'),
  ).toBeVisible();
  // Leave the field so the error outline paints instead of the focus ring.
  await field(sheet, 'notes').getByLabel('New value').blur();
  await expect(
    sheet.getByRole('button', { name: 'Save and preview' }),
  ).toBeDisabled();
  await field(sheet, 'notes').scrollIntoViewIfNeeded();
  await screenshot(page, 'f2-04-notes-over-limit.png');
  await fillValue(page, sheet, 'notes', 'Cart 7 loaner pool');

  // 06: the frozen preview with one row group per device.
  await sheet.getByRole('button', { name: 'Save and preview' }).click();
  await expect(
    sheet.getByRole('heading', { name: 'Review 5 device updates' }),
  ).toBeVisible();
  await screenshot(page, 'f2-06-review-preview.png');

  // 07: the confirmation, after the acknowledgement.
  await sheet.getByRole('button', { name: 'Continue to confirmation' }).click();
  await expect(
    sheet.getByRole('heading', { name: 'Confirm 5 device updates' }),
  ).toBeVisible();
  await sheet.getByRole('checkbox').check();
  await expect(sheet.getByRole('checkbox')).toBeChecked();
  // Wait for the check mark to paint, or the capture shows an empty box.
  await expect(sheet.locator('.mdc-checkbox__checkmark')).toHaveCSS(
    'opacity',
    '1',
  );
  await screenshot(page, 'f2-07-confirm.png');

  // 08: the receipt for UPD-007.
  await sheet.getByRole('button', { name: 'Create update job' }).click();
  await expect(
    sheet.getByRole('heading', { name: 'Your job is saved' }),
  ).toBeVisible();
  await screenshot(page, 'f2-08-receipt.png');
});

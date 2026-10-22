import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type { DeviceUpdateChange } from '@campus/application-contracts';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  U6Simulator,
  type SimulatedDevice,
} from './device-update-u6-simulator';

/**
 * The Update device sheet with the three text fields of F2 (record 2026-10-21): the Edit
 * step, the rows per device and field, the confirmation, and the receipt for several fields.
 *
 * The simulated API answers with the production U6 target calculation, so eligibility is
 * per device and field. The completion checks settle the job and read the updated grid.
 * Google and PostgreSQL stay simulated. No live API answers this suite.
 */

const customerId = 'C0123456';
const previewId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const jobDisplayId = 'UPD-007';
const evidenceDir =
  process.env['EVIDENCE_DIR'] ?? path.join(process.cwd(), 'dist/e2e-evidence');

const grants = [
  { action: 'devices:read', scope: { kind: 'district', customerId } },
  { action: 'devices:write', scope: { kind: 'district', customerId } },
  { action: 'devices:bulk-actions', scope: { kind: 'district', customerId } },
];

const serials = [
  '01P0T1V',
  '02A1MB6',
  '02QJANY',
  '04QVJBY',
  '04XTBHJ',
  '0727D2E',
];
/** Removed from inventory: the preview excludes it and every field row reads "Not updated". */
const excludedIndex = 1;

const OBSERVED_LOCATION = 'Science wing';
const OBSERVED_USER = 'luis.ortiz@example.org';

const LONG_NOTE =
  'Cart 7 loaner pool. Check the charger and the power strip before each lesson. ' +
  'Students sign the loan sheet at the library desk and return the device before the last bell. ' +
  'Report a cracked screen, a missing key, or a loose hinge to the help desk on the same day. ' +
  'Wipe the keyboard and the screen with the approved cloth at the end of each day. ' +
  'Keep the cart locked when no teacher is in the room. ' +
  'Charge every device overnight and leave the cart plugged in during holidays. ' +
  'The library staff counts the devices every Friday afternoon and logs the result.';

/** Six devices: five eligible and one removed from the inventory after the selection. */
function seedDevices(
  fields: Partial<Record<number, Partial<SimulatedDevice>>> = {},
): SimulatedDevice[] {
  return serials.map((serialNumber, index) => ({
    serialNumber,
    annotatedLocation: OBSERVED_LOCATION,
    annotatedUser: OBSERVED_USER,
    notes: null,
    removed: index === excludedIndex,
    ...fields[index],
  }));
}

interface Mock {
  sim: U6Simulator;
  /** The last preview request body, for an assertion. */
  posted: { changes?: DeviceUpdateChange[] };
  /** Apply the settled write and publish the U6 `entity-batch` event. */
  settle: () => Promise<void>;
}

/**
 * A stateful U6 answer source. The preview and target rows come from the production U6
 * calculation inside `U6Simulator`; this function only carries them over HTTP.
 */
async function mockApi(
  page: Page,
  devices: SimulatedDevice[] = seedDevices(),
): Promise<Mock> {
  const sim = new U6Simulator(devices);
  const posted: { changes?: DeviceUpdateChange[] } = {};
  await fakeDeviceStream(page);
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const routePath = new URL(request.url()).pathname;
    const method = request.method();

    if (method === 'POST' && routePath === '/api/devices/updates/previews') {
      const body = request.postDataJSON() as { changes: DeviceUpdateChange[] };
      posted.changes = body.changes;
      return route.fulfill({ status: 201, json: sim.prepare(body.changes) });
    }
    if (
      method === 'GET' &&
      routePath === `/api/devices/updates/previews/${previewId}`
    )
      return route.fulfill({ json: sim.current() });
    if (
      method === 'GET' &&
      routePath === `/api/devices/updates/previews/${previewId}/targets`
    )
      return route.fulfill({
        json: { targets: sim.targets(), nextCursor: null },
      });
    if (method === 'POST' && routePath.endsWith('/confirm')) {
      const body = request.postDataJSON() as {
        manifestDigest: string;
        acknowledged: boolean;
      };
      // The client sends the digest of the frozen preview. A stale digest is a 409.
      if (
        body.acknowledged !== true ||
        body.manifestDigest !== sim.current().manifestDigest
      )
        return route.fulfill({
          status: 409,
          json: { reason: 'preview-changed' },
        });
      return route.fulfill({ status: 201, json: sim.confirm() });
    }
    if (routePath === `/api/jobs/${jobDisplayId}`)
      return route.fulfill({ json: sim.jobDetail() });
    if (method === 'POST' && routePath === '/api/devices/query')
      return route.fulfill({ json: { page: sim.page() } });
    if (method === 'POST' && routePath === '/api/devices/by-ids') {
      const body = request.postDataJSON() as { deviceIds: string[] };
      return route.fulfill({ json: { rows: sim.byIds(body.deviceIds) } });
    }
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
            added: serials.length,
            excluded: 0,
            selectedCount: serials.length,
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
            observedAt: '2026-10-21T12:00:00.000Z',
            deviceCount: serials.length,
            failure: null,
            telemetryFailure: null,
            startedAt: null,
            checkedAt: null,
            stale: false,
          },
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
  return {
    sim,
    posted,
    settle: async () => {
      const changed = sim.settle();
      await page.waitForFunction(
        () =>
          (window as unknown as { __deviceSources?: unknown[] }).__deviceSources
            ?.length,
      );
      await page.evaluate(
        (deviceIds) =>
          (
            window as unknown as {
              __emitEntityBatch: (ids: string[]) => void;
            }
          ).__emitEntityBatch(deviceIds),
        changed,
      );
    },
  };
}

/**
 * Playwright cannot hold an SSE response open with `route.fulfill`. The fake opens once and
 * relays the `entity-batch` event that a settled update job publishes.
 */
async function fakeDeviceStream(page: Page) {
  await page.addInitScript(() => {
    const state = window as unknown as {
      __deviceSources: {
        readyState: number;
        emit: (type: string, event: Event) => void;
      }[];
      __emitEntityBatch: (deviceIds: string[]) => void;
    };
    state.__deviceSources = [];
    class FakeEventSource {
      readyState = 0;
      private readonly listeners = new Map<
        string,
        ((event: Event) => void)[]
      >();
      constructor() {
        setTimeout(() => {
          this.readyState = 1;
          this.emit('open', new Event('open'));
        }, 0);
        state.__deviceSources.push(this);
      }
      addEventListener(type: string, listener: (event: Event) => void) {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
      }
      close() {
        this.readyState = 2;
      }
      emit(type: string, event: Event) {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }
    (window as unknown as { EventSource: unknown }).EventSource =
      FakeEventSource;
    state.__emitEntityBatch = (deviceIds: string[]) => {
      for (const source of state.__deviceSources) {
        if (source.readyState === 2) continue;
        source.emit(
          'entity-batch',
          new MessageEvent('entity-batch', {
            data: JSON.stringify({
              type: 'entity-batch',
              entityType: 'device',
              deviceIds,
              removedIds: [],
            }),
          }),
        );
      }
    };
  });
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
  // Device 1 already holds the requested Notes, so Notes has four eligible rows.
  const mock = await mockApi(
    page,
    seedDevices({ 0: { notes: 'Cart 7 loaner pool' } }),
  );
  await openDevices(page);
  const sheet = await openSheet(page);
  const save = sheet.getByRole('button', { name: 'Save and preview' });
  // No field has changed yet.
  await expect(save).toBeDisabled();

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
  await expect(save).toBeEnabled();
  await expectNoAxeViolations(page);

  await save.click();
  await expect(
    sheet.getByRole('heading', { name: 'Review 5 device updates' }),
  ).toBeVisible();
  expect(mock.posted.changes).toEqual([
    { field: 'annotatedLocation', mode: 'replace', value: 'North lab' },
    { field: 'notes', mode: 'replace', value: 'Cart 7 loaner pool' },
  ]);
  // U6 counts nine eligible device-field rows: five locations and four Notes.
  await expect(
    sheet.getByText('6 devices · 9 field changes · 1 excluded'),
  ).toBeVisible();
  await expect(sheet.getByText('Field changes', { exact: true })).toBeVisible();

  // One row group per device and one row per changed field.
  const groups = sheet.locator('.targets tbody');
  await expect(groups).toHaveCount(6);
  const first = groups.first();
  await expect(first.locator('.device-row')).toContainText(serials[0]!);
  await expect(first.locator('th[scope="row"]')).toHaveText([
    'Annotated location',
    'Notes',
  ]);
  await expect(first).toContainText(OBSERVED_LOCATION);
  await expect(first).toContainText('North lab');
  await expect(first).toContainText('Cart 7 loaner pool');
  // Device 1 already holds the Notes value, so its Notes row reads "No change".
  await expect(first).toContainText('No change');

  const excluded = groups.filter({ hasText: serials[excludedIndex]! });
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
  // The Notes sentence counts four rows, not the five eligible devices.
  await expect(sheet.locator('.change-list li')).toHaveText([
    'Set the annotated location to North lab on 5 devices.',
    'Set the notes to Cart 7 loaner pool on 4 devices.',
  ]);
  await expect(
    sheet.getByText('Annotated user remains unchanged.'),
  ).toBeVisible();
  await expect(
    sheet.getByText('Preview PV-009 · 6 devices · 9 field changes'),
  ).toBeVisible();
  await expectNoAxeViolations(page);
  // Evidence for the mixed-eligibility count: Notes changes on four rows, not five.
  await screenshot(page, 'f2-r1-mixed-eligibility-confirm.png');

  await sheet.getByRole('checkbox').check();
  await sheet.getByRole('button', { name: 'Create update job' }).click();
  await expect(
    sheet.getByRole('heading', { name: 'Your job is saved' }),
  ).toBeVisible();
  await expect(
    sheet.getByText(
      '5 devices · 9 field changes. Google changes have not completed.',
    ),
  ).toBeVisible();
  await expectNoAxeViolations(page);

  // The worker settles every eligible field row and publishes the changed devices.
  await mock.settle();
  await sheet.getByRole('button', { name: 'Done' }).click();
  // The sheet takes the width of the grid, so hide the columns this check does not read.
  await setColumns(page, {
    show: ['Annotated location', 'Annotated user', 'Notes'],
    hide: [
      'Model',
      'Asset tag',
      'Organization unit',
      'Battery',
      'Device contact',
    ],
  });

  for (const [index, serial] of serials.entries()) {
    if (index === excludedIndex) {
      // The excluded device keeps every value.
      await expect(gridCell(page, serial, 'annotatedLocation')).toHaveText(
        OBSERVED_LOCATION,
      );
      await expect(gridCell(page, serial, 'notes')).toHaveText('');
      await expect(gridCell(page, serial, 'annotatedUser')).toHaveText(
        OBSERVED_USER,
      );
      continue;
    }
    await expect(gridCell(page, serial, 'annotatedLocation')).toHaveText(
      'North lab',
    );
    await expect(gridCell(page, serial, 'notes')).toHaveText(
      'Cart 7 loaner pool',
    );
    // Annotated user was left unchanged and keeps its value in place.
    await expect(gridCell(page, serial, 'annotatedUser')).toHaveText(
      OBSERVED_USER,
    );
  }
});

test('completion step 3: sets Annotated user and shows the optional column', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const mock = await mockApi(page);
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
  expect(mock.posted.changes).toEqual([
    {
      field: 'annotatedUser',
      mode: 'replace',
      value: 'maya.chen@example.org',
    },
  ]);
  const first = sheet.locator('.targets tbody').first();
  await expect(first.locator('th[scope="row"]')).toHaveText(['Annotated user']);
  await expect(first).toContainText(OBSERVED_USER);
  await expect(first).toContainText('maya.chen@example.org');

  await sheet.getByRole('button', { name: 'Continue to confirmation' }).click();
  await expect(sheet.locator('.change-list li')).toHaveText([
    'Set the annotated user to maya.chen@example.org on 5 devices.',
  ]);
  await expect(
    sheet.getByText('Annotated location and notes remain unchanged.'),
  ).toBeVisible();

  await sheet.getByRole('checkbox').check();
  await sheet.getByRole('button', { name: 'Create update job' }).click();
  await expect(
    sheet.getByText(
      '5 devices · 5 field changes. Google changes have not completed.',
    ),
  ).toBeVisible();

  await mock.settle();
  await sheet.getByRole('button', { name: 'Done' }).click();
  await setColumns(page, { show: ['Annotated user'] });
  await expect(
    page.getByRole('columnheader', { name: 'Annotated user', exact: true }),
  ).toBeVisible();

  for (const [index, serial] of serials.entries()) {
    await expect(gridCell(page, serial, 'annotatedUser')).toHaveText(
      index === excludedIndex ? OBSERVED_USER : 'maya.chen@example.org',
    );
  }
});

test('completion step 4: clears nonempty Notes and shows the empty value', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // Every device starts with Notes. Clearing them is a real U6 write on five devices.
  const seeded: Partial<Record<number, Partial<SimulatedDevice>>> = {};
  for (let index = 0; index < serials.length; index += 1)
    seeded[index] = { notes: 'Cart 7 loaner pool' };
  const mock = await mockApi(page, seedDevices(seeded));
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
  expect(mock.posted.changes).toEqual([{ field: 'notes', mode: 'clear' }]);
  await expect(
    sheet.getByText('6 devices · 5 field changes · 1 excluded'),
  ).toBeVisible();
  const first = sheet.locator('.targets tbody').first();
  await expect(first).toContainText('Cart 7 loaner pool');
  await expect(first.locator('td.approved')).toHaveText('Cleared');

  await sheet.getByRole('button', { name: 'Continue to confirmation' }).click();
  await expect(sheet.locator('.change-list li')).toHaveText([
    'Clear the notes on 5 devices.',
  ]);

  await sheet.getByRole('checkbox').check();
  await sheet.getByRole('button', { name: 'Create update job' }).click();
  await expect(
    sheet.getByText(
      '5 devices · 5 field changes. Google changes have not completed.',
    ),
  ).toBeVisible();

  await mock.settle();
  await sheet.getByRole('button', { name: 'Done' }).click();
  await setColumns(page, {
    show: ['Notes'],
    hide: [
      'Model',
      'Asset tag',
      'Organization unit',
      'Battery',
      'Device contact',
    ],
  });

  for (const [index, serial] of serials.entries())
    await expect(gridCell(page, serial, 'notes')).toHaveText(
      index === excludedIndex ? 'Cart 7 loaner pool' : '',
    );
});

test('completion step 5: refuses a value over its limit and names the field and the limit', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockApi(page);
  await openDevices(page);
  const sheet = await openSheet(page);

  const save = sheet.getByRole('button', { name: 'Save and preview' });
  // No field has changed, so there is nothing to preview.
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
  await mockApi(
    page,
    // The removed device has no observed annotations, as in the approved frames.
    seedDevices({
      [excludedIndex]: {
        annotatedLocation: null,
        annotatedUser: null,
        notes: null,
      },
    }),
  );
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

  // 06: the frozen preview with one row group per device and one row per changed field.
  await sheet.getByRole('button', { name: 'Save and preview' }).click();
  await expect(
    sheet.getByRole('heading', { name: 'Review 5 device updates' }),
  ).toBeVisible();
  // All three fields change on all five eligible devices.
  await expect(
    sheet.getByText('6 devices · 15 field changes · 1 excluded'),
  ).toBeVisible();
  await screenshot(page, 'f2-06-review-preview.png');

  // 07: the confirmation, after the acknowledgement.
  await sheet.getByRole('button', { name: 'Continue to confirmation' }).click();
  await expect(
    sheet.getByRole('heading', { name: 'Confirm 5 device updates' }),
  ).toBeVisible();
  await expect(sheet.locator('.change-list li')).toHaveText([
    'Set the annotated location to North lab on 5 devices.',
    'Set the annotated user to maya.chen@example.org on 5 devices.',
    'Set the notes to Cart 7 loaner pool on 5 devices.',
  ]);
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
  await expect(
    sheet.getByText(
      '5 devices · 15 field changes. Google changes have not completed.',
    ),
  ).toBeVisible();
  await screenshot(page, 'f2-08-receipt.png');
});

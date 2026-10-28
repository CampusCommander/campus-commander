import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type {
  DeviceDetail,
  DeviceRow,
  DeviceUpdateEdit,
  DeviceUpdateTarget,
} from '@campus/application-contracts';
// The edit-list rules of the mock are the production rules: C is the current value, B the
// baseline of the edit, and R the request (addendum section 4).
// eslint-disable-next-line @nx/enforce-module-boundaries
import {
  editPreviewTargets,
  manifestDigest,
  type PreviewTarget,
} from '../../api/src/app/devices/device-updates';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { orgUnitTree } from './device-update-u6-simulator';

/**
 * Completion step 7 of `docs/workflows/in-grid-editing.md`: update one device from device
 * details. The sheet keeps the Edit, Review, and Confirm steps, sends one edit list for the
 * device, and its receipt offers Back to device. Every answer is mocked; no live Google call
 * runs.
 */

const customerId = 'C0123456';
const observedAt = '2026-10-21T12:00:00.000Z';
const previewId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const previewDisplayId = 'PV-012';
const jobId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const jobDisplayId = 'UPD-008';

const fullGrants = [
  { action: 'devices:read', scope: { kind: 'district', customerId } },
  { action: 'devices:write', scope: { kind: 'district', customerId } },
  { action: 'devices:bulk-actions', scope: { kind: 'district', customerId } },
];

const evidenceDir =
  process.env['EVIDENCE_DIR'] ?? path.join(process.cwd(), 'dist/e2e-evidence');

interface SimulatedDevice {
  deviceId: string;
  serialNumber: string;
  assetTag: string | null;
  orgUnitPath: string;
  annotatedLocation: string | null;
  annotatedUser: string | null;
  notes: string | null;
}

function seedDevices(): SimulatedDevice[] {
  return [
    {
      deviceId: 'd0',
      serialNumber: 'C0A1-0001',
      assetTag: 'HS-0401',
      orgUnitPath: '/Chrome Devices/Lowell Academy/One to One',
      annotatedLocation: 'Science wing',
      annotatedUser: 'maya.chen@example.org',
      notes: 'Cart 7 loaner pool',
    },
    {
      deviceId: 'd1',
      serialNumber: 'C0A1-0002',
      assetTag: 'HS-0402',
      orgUnitPath: '/Chrome Devices/Lowell Academy/One to One',
      annotatedLocation: 'Front Office',
      annotatedUser: null,
      notes: null,
    },
  ];
}

/** The edit route of the mock: the production C/B/R rules over two simulated devices. */
class SingleDeviceSimulator {
  readonly confirms: { manifestDigest: string; acknowledged: boolean }[] = [];
  readonly edits: DeviceUpdateEdit[][] = [];
  private readonly devices: SimulatedDevice[];
  private frozen: PreviewTarget[] = [];
  private jobs = 0;

  constructor(devices: SimulatedDevice[]) {
    this.devices = devices.map((device) => ({ ...device }));
  }

  byId(deviceId: string): SimulatedDevice | undefined {
    return this.devices.find((device) => device.deviceId === deviceId);
  }

  detail(deviceId: string): DeviceDetail | null {
    const device = this.byId(deviceId);
    if (!device) return null;
    return {
      deviceId: device.deviceId,
      serialNumber: device.serialNumber,
      model: 'Lenovo 100e Gen 4',
      assetTag: device.assetTag,
      orgUnitPath: device.orgUnitPath,
      lastContact: '2026-10-21T11:58:00Z',
      annotatedLocation: device.annotatedLocation,
      annotatedUser: device.annotatedUser,
      notes: device.notes,
      status: 'ACTIVE',
      battery: { status: 'no-report' },
      lastEntitySync: observedAt,
      stale: false,
      removedAt: null,
      batteryReports: [],
    };
  }

  /** The same devices as grid rows, so device details opens from the Devices page. */
  rows(): DeviceRow[] {
    return this.devices.map((device) => ({
      deviceId: device.deviceId,
      serialNumber: device.serialNumber,
      model: 'Lenovo 100e Gen 4',
      assetTag: device.assetTag,
      orgUnitPath: device.orgUnitPath,
      lastContact: '2026-10-21T11:58:00Z',
      annotatedLocation: device.annotatedLocation,
      annotatedUser: device.annotatedUser,
      notes: device.notes,
      status: 'ACTIVE',
      battery: { status: 'no-report' },
      lastEntitySync: observedAt,
      stale: false,
    }));
  }

  prepare(edits: readonly DeviceUpdateEdit[]) {
    this.edits.push([...edits]);
    this.frozen = editPreviewTargets(
      this.devices.map((device) => ({
        device_id: device.deviceId,
        serial_number: device.serialNumber,
        org_unit_path: device.orgUnitPath,
        asset_tag: device.assetTag,
        annotated_location: device.annotatedLocation,
        annotated_user: device.annotatedUser,
        notes: device.notes,
        removed_at: null,
        last_entity_sync: observedAt,
      })),
      edits,
    );
    return {
      previewId,
      displayId: previewDisplayId,
      changes: null,
      fieldChanges: this.frozen.reduce(
        (total, target) =>
          total +
          target.fields.filter((field) => field.disposition === 'eligible')
            .length,
        0,
      ),
      selected: this.frozen.length,
      eligible: this.count('eligible'),
      unchanged: this.count('unchanged'),
      excluded: this.count('excluded'),
      conflicts: this.count('conflict'),
      oldestObservedAt: observedAt,
      stale: false,
      preparedAt: '2026-10-21T18:02:00.000Z',
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      manifestDigest: manifestDigest(this.frozen),
    };
  }

  preview() {
    return this.frozen.length ? this.summary() : null;
  }

  private summary() {
    return {
      previewId,
      displayId: previewDisplayId,
      changes: null,
      fieldChanges: this.frozen.reduce(
        (total, target) =>
          total +
          target.fields.filter((field) => field.disposition === 'eligible')
            .length,
        0,
      ),
      selected: this.frozen.length,
      eligible: this.count('eligible'),
      unchanged: this.count('unchanged'),
      excluded: this.count('excluded'),
      conflicts: this.count('conflict'),
      oldestObservedAt: observedAt,
      stale: false,
      preparedAt: '2026-10-21T18:02:00.000Z',
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      manifestDigest: manifestDigest(this.frozen),
    };
  }

  private count(disposition: string): number {
    return this.frozen.reduce(
      (total, target) =>
        total +
        target.fields.filter((field) => field.disposition === disposition)
          .length,
      0,
    );
  }

  targets(): DeviceUpdateTarget[] {
    return this.frozen.flatMap((target) =>
      target.fields.map((field) => ({
        deviceId: target.deviceId,
        serialNumber: target.serialNumber,
        field: field.field,
        observedValue: field.observedValue,
        baselineValue: field.baselineValue,
        approvedValue:
          field.disposition === 'excluded' ? null : field.requestedValue,
        duplicateSerialNumber: null,
        disposition: field.disposition,
        exclusionReason: target.exclusionReason,
      })),
    );
  }

  /** Accept the confirmation and write the approved values, as the worker would. */
  accept() {
    this.jobs += 1;
    for (const target of this.frozen) {
      const device = this.byId(target.deviceId);
      if (!device) continue;
      for (const field of target.fields) {
        if (field.disposition !== 'eligible' || field.requestedValue === null)
          continue;
        if (field.field === 'annotatedAssetId')
          device.assetTag = field.requestedValue;
        if (field.field === 'annotatedLocation')
          device.annotatedLocation = field.requestedValue;
        if (field.field === 'annotatedUser')
          device.annotatedUser = field.requestedValue;
        if (field.field === 'notes') device.notes = field.requestedValue;
        if (field.field === 'orgUnitPath')
          device.orgUnitPath = field.requestedValue;
      }
    }
    return this.receipt();
  }

  get jobCount(): number {
    return this.jobs;
  }

  receipt() {
    return {
      jobId,
      displayId: jobDisplayId,
      status: 'accepted',
      deviceCount: 1,
      updateCount: 1,
    };
  }

  jobDetail() {
    return {
      jobId,
      displayId: jobDisplayId,
      revision: 1,
      action: 'update-device-annotations',
      status: 'running',
      scope: { kind: 'devices', deviceCount: 1 },
      requestedBy: {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        displayName: 'District operator',
      },
      createdAt: '2026-10-21T18:02:00.000Z',
      startedAt: '2026-10-21T18:02:01.000Z',
      finishedAt: null,
      progress: {
        total: 1,
        succeeded: 0,
        failed: 0,
        unknown: 0,
        skipped: 0,
        expired: 0,
        cancelled: 0,
        pending: 1,
      },
      cancelRequest: null,
      failure: null,
      confirmedBy: {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        displayName: 'District operator',
      },
      previewDisplayId,
      // An edit-list job carries no frozen selection changes.
      changes: null,
      commandType: null,
      statusAction: null,
      deprovisionReason: null,
      targetOrgUnitPaths: [],
      correlationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      latestActivity: {
        at: '2026-10-21T18:02:01.000Z',
        failed: { count: 0, operations: [] },
        unknown: { count: 0, operations: [] },
      },
    };
  }
}

async function mockApi(
  page: Page,
  sim: SingleDeviceSimulator,
  grants: unknown[],
): Promise<void> {
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const method = request.method();

    if (pathname === '/api/auth/session')
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
    if (pathname === '/api/application')
      return route.fulfill({
        json: {
          phase: 3,
          authenticationConfigured: true,
          version: 'development',
          build: 'client-review',
        },
      });
    if (pathname === '/api/devices/sync')
      return route.fulfill({
        json: {
          sync: {
            customerId,
            generation: 1,
            status: 'ready',
            observedAt,
            deviceCount: 2,
            failure: null,
            telemetryFailure: null,
            startedAt: null,
            checkedAt: null,
            stale: false,
          },
        },
      });
    // The Devices page reads the browsing selection and the grid page.
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
    if (pathname === '/api/devices/query') {
      const query = request.postDataJSON() as {
        offset?: number;
        limit?: number;
      };
      const rows = sim.rows();
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
      return route.fulfill({ json: orgUnitTree });
    if (pathname === '/api/devices/updates/access')
      return route.fulfill({
        json: {
          state: 'granted',
          scope:
            'https://www.googleapis.com/auth/admin.directory.device.chromeos',
          failure: null,
          checkedAt: observedAt,
        },
      });
    if (pathname === '/api/devices/updates/edit-previews') {
      const body = request.postDataJSON() as { edits: DeviceUpdateEdit[] };
      return route.fulfill({ json: sim.prepare(body.edits), status: 201 });
    }
    if (pathname === `/api/devices/updates/previews/${previewId}`)
      return route.fulfill({ json: sim.preview() });
    if (pathname === `/api/devices/updates/previews/${previewId}/targets`)
      return route.fulfill({
        json: { targets: sim.targets(), nextCursor: null },
      });
    if (pathname === `/api/devices/updates/previews/${previewId}/confirm`) {
      const body = request.postDataJSON() as {
        manifestDigest: string;
        acknowledged: boolean;
      };
      sim.confirms.push(body);
      return route.fulfill({ json: sim.accept(), status: 201 });
    }
    if (pathname === `/api/jobs/${jobDisplayId}`)
      return route.fulfill({ json: sim.jobDetail() });
    if (
      method === 'GET' &&
      /^\/api\/devices\/[^/]+$/.test(pathname) &&
      pathname !== '/api/devices/sync' &&
      pathname !== '/api/devices/freshness'
    ) {
      const deviceId = decodeURIComponent(pathname.split('/').pop() ?? '');
      const detail = sim.detail(deviceId);
      return detail
        ? route.fulfill({ json: { device: detail } })
        : route.fulfill({ status: 404, json: { reason: 'unknown-device' } });
    }
    if (pathname === '/api/devices/events')
      return route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: '',
      });
    if (pathname === '/api/jobs/events')
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
      return route.fulfill({ json: request.postDataJSON() });
    return route.fulfill({ status: 404, json: {} });
  });
}

async function openDetails(
  page: Page,
  sim: SingleDeviceSimulator,
  grants: unknown[] = fullGrants,
  deviceId = 'd0',
): Promise<void> {
  await mockApi(page, sim, grants);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/devices/${deviceId}`);
  await page.evaluate(() => document.fonts.ready);
  await expect(
    page.getByRole('heading', {
      name: sim.detail(deviceId)?.serialNumber ?? deviceId,
      exact: true,
    }),
  ).toBeVisible();
}

/** Open the Devices page and follow the details action, so Next device has a position. */
async function openDevicesFromGrid(
  page: Page,
  sim: SingleDeviceSimulator,
): Promise<void> {
  await mockApi(page, sim, fullGrants);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/devices');
  await page.evaluate(() => document.fonts.ready);
  await expect(
    page.getByRole('heading', { name: 'Devices', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('gridcell', { name: 'C0A1-0001', exact: true }),
  ).toBeVisible();
}

async function screenshot(page: Page, name: string): Promise<void> {
  mkdirSync(evidenceDir, { recursive: true });
  await page.screenshot({ path: path.join(evidenceDir, name) });
}

test('updates one device from device details with its Asset tag', async ({
  page,
}) => {
  const sim = new SingleDeviceSimulator(seedDevices());
  await openDetails(page, sim);

  const update = page.getByRole('button', { name: 'Update device' });
  await expect(update).toBeEnabled();
  await screenshot(page, '01-device-details-update-device.png');
  expect(
    await new AxeBuilder({ page })
      .analyze()
      .then((result) => result.violations),
  ).toEqual([]);

  await update.click();
  const sheet = page.getByRole('dialog');
  await expect(
    sheet.getByRole('heading', { name: 'Update 1 device' }),
  ).toBeVisible();
  // The sheet slides in over 250 ms; the screenshot shows the settled position.
  await expect(page.locator('.bulk-sheet')).toHaveCSS(
    'transform',
    'matrix(1, 0, 0, 1, 0, 0)',
  );
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
  await expect(
    sheet.getByRole('button', { name: 'Review pending devices' }),
  ).toHaveCount(0);
  await screenshot(page, '02-single-device-sheet-edit.png');

  const assetBlock = sheet.locator(
    '.field-block[data-field="annotatedAssetId"]',
  );
  await assetBlock.locator('.mat-mdc-select-trigger').click();
  await expect(page.getByRole('option')).toHaveText([
    'Leave unchanged',
    'Update · Replace the existing value',
  ]);
  await page
    .getByRole('option', { name: 'Update · Replace the existing value' })
    .click();
  await assetBlock.locator('input').fill('HS-9001');
  await sheet.getByRole('button', { name: 'Save and preview' }).click();

  await expect(
    sheet.getByRole('heading', { name: 'Review 1 device update' }),
  ).toBeVisible();
  await expect(sheet).toContainText('HS-0401');
  await expect(sheet).toContainText('HS-9001');
  await screenshot(page, '03-single-device-review.png');
  expect(sim.edits).toEqual([
    [
      {
        deviceId: 'd0',
        field: 'annotatedAssetId',
        mode: 'replace',
        value: 'HS-9001',
        baselineValue: 'HS-0401',
      },
    ],
  ]);

  await sheet.getByRole('button', { name: 'Continue to confirmation' }).click();
  await expect(
    sheet.getByRole('heading', { name: 'Confirm 1 device update' }),
  ).toBeVisible();
  await sheet.getByRole('checkbox').check();
  await screenshot(page, '04-single-device-confirm.png');
  await sheet.getByRole('button', { name: 'Create update job' }).click();

  await expect(
    sheet.getByRole('heading', { name: 'Update job created' }),
  ).toBeVisible();
  await expect(sheet).toContainText(jobDisplayId);
  await screenshot(page, '05-single-device-receipt.png');
  expect(sim.jobCount).toBe(1);
  expect(sim.confirms).toHaveLength(1);
  expect(sim.confirms[0]?.acknowledged).toBe(true);

  await sheet.getByRole('button', { name: 'Back to device' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(
    page.getByRole('heading', { name: 'C0A1-0001', exact: true }),
  ).toBeVisible();
  // The page reads the device again, so the details show the accepted value.
  await expect(
    page.getByText('Lenovo 100e Gen 4 · HS-9001', { exact: true }),
  ).toBeVisible();
  await screenshot(page, '06-device-details-after-update.png');
});

test('keeps Update device disabled with the permission note', async ({
  page,
}) => {
  const sim = new SingleDeviceSimulator(seedDevices());
  await openDetails(page, sim, fullGrants.slice(0, 1));

  const update = page.getByRole('button', { name: 'Update device' });
  await expect(update).toBeDisabled();
  await expect(update).toHaveAttribute(
    'aria-describedby',
    'update-device-note',
  );
  await expect(page.locator('#update-device-note')).toHaveText(
    'You need the devices:read, devices:write, and devices:bulk-actions permissions to update devices. Ask your administrator for access.',
  );
  await screenshot(page, '07-device-details-update-denied.png');
  expect(
    await new AxeBuilder({ page })
      .analyze()
      .then((result) => result.violations),
  ).toEqual([]);
});

test('keeps the sheet closed while the next device loads', async ({ page }) => {
  const sim = new SingleDeviceSimulator(seedDevices());
  await openDevicesFromGrid(page, sim);
  await page
    .getByRole('button', { name: 'Open details for C0A1-0001' })
    .click();
  await expect(
    page.getByRole('heading', { name: 'C0A1-0001', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next device' })).toBeEnabled();

  // Hold the next device's details answer while the previous device stays visible.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/devices/d1', async (route) => {
    await held;
    await route.fallback();
  });

  await page.getByRole('button', { name: 'Next device' }).click();
  const update = page.getByRole('button', { name: 'Update device' });
  await expect(page).toHaveURL(/\/devices\/d1$/);
  await expect(
    page.getByRole('heading', { name: 'C0A1-0001', exact: true }),
  ).toBeVisible();
  await expect(update).toBeDisabled();
  await expect(page.locator('#update-device-note')).toHaveText(
    'Loading device details…',
  );
  expect(
    await new AxeBuilder({ page })
      .analyze()
      .then((result) => result.violations),
  ).toEqual([]);
  await screenshot(page, '08-device-details-loading-update-disabled.png');

  release();
  await expect(
    page.getByRole('heading', { name: 'C0A1-0002', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.bulk-sheet')).not.toHaveClass(/is-open/);
  await expect(update).toBeEnabled();

  // The sheet and the submitted edit name the device that the page shows.
  await update.click();
  const sheet = page.getByRole('dialog');
  await expect(
    sheet.getByRole('heading', { name: 'Update 1 device' }),
  ).toBeVisible();
  const assetBlock = sheet.locator(
    '.field-block[data-field="annotatedAssetId"]',
  );
  await assetBlock.locator('.mat-mdc-select-trigger').click();
  await page
    .getByRole('option', { name: 'Update · Replace the existing value' })
    .click();
  await assetBlock.locator('input').fill('HS-9002');
  await sheet.getByRole('button', { name: 'Save and preview' }).click();
  await expect(
    sheet.getByRole('heading', { name: 'Review 1 device update' }),
  ).toBeVisible();
  expect(sim.edits.at(-1)).toEqual([
    {
      deviceId: 'd1',
      field: 'annotatedAssetId',
      mode: 'replace',
      value: 'HS-9002',
      baselineValue: 'HS-0402',
    },
  ]);
  await screenshot(page, '09-device-details-after-navigation.png');
});

test('keeps a Clear of an empty annotation out of the edit list', async ({
  page,
}) => {
  const sim = new SingleDeviceSimulator(seedDevices());
  // The second device has no Notes and no Annotated user.
  await openDetails(page, sim, fullGrants, 'd1');
  await page.getByRole('button', { name: 'Update device' }).click();
  const sheet = page.getByRole('dialog');
  await expect(
    sheet.getByRole('heading', { name: 'Update 1 device' }),
  ).toBeVisible();

  const notes = sheet.locator('.field-block[data-field="notes"]');
  await notes.locator('.mat-mdc-select-trigger').click();
  await page.getByRole('option', { name: 'Clear value' }).click();
  await expect(page.locator('.mat-mdc-select-panel')).toBeHidden();
  await expect(notes).toContainText(
    'Notes is already empty. Clear changes nothing.',
  );
  await expect(
    sheet.getByRole('button', { name: 'Save and preview' }),
  ).toBeDisabled();
  expect(
    await new AxeBuilder({ page })
      .analyze()
      .then((result) => result.violations),
  ).toEqual([]);
  await screenshot(page, '10-device-details-noop-clear.png');

  // A valid sibling change stays usable, and the Clear never reaches the request.
  const assetBlock = sheet.locator(
    '.field-block[data-field="annotatedAssetId"]',
  );
  await assetBlock.locator('.mat-mdc-select-trigger').click();
  await page
    .getByRole('option', { name: 'Update · Replace the existing value' })
    .click();
  await assetBlock.locator('input').fill('HS-9003');
  const save = sheet.getByRole('button', { name: 'Save and preview' });
  await expect(save).toBeEnabled();
  await save.click();
  await expect(
    sheet.getByRole('heading', { name: 'Review 1 device update' }),
  ).toBeVisible();
  expect(sim.edits.at(-1)).toEqual([
    {
      deviceId: 'd1',
      field: 'annotatedAssetId',
      mode: 'replace',
      value: 'HS-9003',
      baselineValue: 'HS-0402',
    },
  ]);
  await screenshot(page, '11-device-details-noop-clear-review.png');
});

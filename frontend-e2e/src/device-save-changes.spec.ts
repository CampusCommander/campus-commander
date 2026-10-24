import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';
import type {
  DeviceRow,
  DeviceUpdateEdit,
  DeviceUpdateTarget,
  JobDetail,
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
 * Completion steps 4, 5, and 6 of `docs/workflows/in-grid-editing.md`: save one pending
 * change, save several pending changes through Review and Confirm, keep the old value of a
 * device that the job does not write, and show a conflict cell when a value changed in
 * Google. Every answer is mocked; no live Google call runs.
 */

const customerId = 'C0123456';
const observedAt = '2026-10-21T12:00:00.000Z';
const principal = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const previewId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const previewDisplayId = 'PV-011';
const jobId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const jobDisplayId = 'UPD-006';
const grants = [
  { action: 'devices:read', scope: { kind: 'district', customerId } },
  { action: 'devices:write', scope: { kind: 'district', customerId } },
  { action: 'devices:bulk-actions', scope: { kind: 'district', customerId } },
];

const evidenceDir =
  process.env['EVIDENCE_DIR'] ?? path.join(process.cwd(), 'dist/e2e-evidence');

/** One device of the mocked inventory. A write lands here, as the worker would. */
interface SimulatedDevice {
  deviceId: string;
  serialNumber: string;
  assetTag: string | null;
  orgUnitPath: string;
  annotatedLocation: string | null;
  annotatedUser: string | null;
  notes: string | null;
  removed?: boolean;
}

function seedDevices(): SimulatedDevice[] {
  return Array.from({ length: 4 }, (_, index) => ({
    deviceId: `d${index}`,
    serialNumber: `C0A1-${String(index + 1).padStart(4, '0')}`,
    assetTag: `HS-${String(index + 1).padStart(4, '0')}`,
    orgUnitPath: '/Chrome Devices/Lowell Academy/One to One',
    annotatedLocation: 'Front Office',
    annotatedUser: null,
    notes: 'Old note',
  }));
}

/** One confirm request that the client sent, as the replay evidence records it. */
interface ConfirmedRequest {
  previewId: string;
  manifestDigest: string;
  acknowledged: boolean;
}

/**
 * The edit route of the mock: the same C/B/R rules as the server, one target row per device
 * and field, and one preview that the confirmation freezes.
 */
class SaveChangesSimulator {
  private devices: SimulatedDevice[];
  private frozen: PreviewTarget[] = [];
  private edits: DeviceUpdateEdit[] = [];
  private confirmed = false;
  /** The devices whose write the simulated worker applies. */
  private written: string[] = [];
  /** The worker has not settled the job until `settle` runs. */
  private settled = false;
  /** How many jobs the confirm route created. */
  private jobs = 0;

  constructor(devices: SimulatedDevice[]) {
    this.devices = devices.map((device) => ({ ...device }));
  }

  rows(): DeviceRow[] {
    return this.devices.map((device) => ({
      deviceId: device.deviceId,
      serialNumber: device.serialNumber,
      model: 'Dell Chromebook 3100',
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

  /** Freeze the preview of one edit list with the production rules. */
  prepare(edits: readonly DeviceUpdateEdit[]) {
    this.edits = [...edits];
    this.confirmed = false;
    this.frozen = editPreviewTargets(
      this.devices.map((device) => ({
        device_id: device.deviceId,
        serial_number: device.serialNumber,
        org_unit_path: device.orgUnitPath,
        asset_tag: device.assetTag,
        annotated_location: device.annotatedLocation,
        annotated_user: device.annotatedUser,
        notes: device.notes,
        removed_at: device.removed ? observedAt : null,
        last_entity_sync: observedAt,
      })),
      this.edits,
    );
    const eligible = this.count('eligible');
    const conflicts = this.count('conflict');
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
      eligible,
      unchanged: this.count('unchanged'),
      excluded: this.count('excluded'),
      conflicts,
      oldestObservedAt: observedAt,
      stale: false,
      preparedAt: '2026-10-21T18:02:00.000Z',
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      manifestDigest: manifestDigest(this.frozen),
    };
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

  /**
   * The route accepted one confirmation. The count proves that a replay created no second
   * job (IF3: a lost answer replays the same preview and digest).
   */
  accept() {
    this.jobs += 1;
    return this.receipt();
  }

  /** The number of jobs that the route created. */
  get jobCount(): number {
    return this.jobs;
  }

  receipt() {
    this.confirmed = true;
    return {
      jobId,
      displayId: jobDisplayId,
      status: 'accepted' as const,
      deviceCount: this.count('eligible'),
      updateCount: this.targets().filter(
        (target) => target.disposition === 'eligible',
      ).length,
    };
  }

  /**
   * The simulated worker: apply the eligible writes of one device list. A device outside the
   * list keeps its old value, as a failed operation does.
   */
  settle(deviceIds?: readonly string[]): void {
    this.settled = true;
    const written = deviceIds ? new Set(deviceIds) : null;
    for (const target of this.frozen) {
      if (target.disposition !== 'eligible') continue;
      if (written && !written.has(target.deviceId)) continue;
      this.written.push(target.deviceId);
      const device = this.devices.find(
        (candidate) => candidate.deviceId === target.deviceId,
      );
      if (!device) continue;
      for (const field of target.fields) {
        if (field.disposition !== 'eligible') continue;
        if (field.field === 'orgUnitPath') {
          if (field.requestedValue !== null)
            device.orgUnitPath = field.requestedValue;
          continue;
        }
        if (field.field === 'annotatedAssetId') {
          device.assetTag = field.requestedValue;
          continue;
        }
        device[field.field] = field.requestedValue;
      }
    }
  }

  /** Change a value behind the person's back, as a Google-side edit does. */
  change(deviceId: string, field: keyof SimulatedDevice, value: string | null) {
    const device = this.devices.find(
      (candidate) => candidate.deviceId === deviceId,
    );
    if (device) (device[field] as string | null) = value;
  }

  jobDetail(): JobDetail {
    // The receipt opens while the worker still runs, as mockup state 09 shows.
    const done = this.confirmed && this.settled;
    const total = this.count('eligible');
    return {
      jobId,
      displayId: jobDisplayId,
      revision: done ? 2 : 1,
      action: 'update-device-annotations',
      status: done ? 'completed' : 'accepted',
      scope: { kind: 'devices', deviceCount: total },
      requestedBy: { id: principal, displayName: 'District operator' },
      createdAt: '2026-10-21T18:03:00.000Z',
      startedAt: done ? '2026-10-21T18:03:01.000Z' : null,
      finishedAt: done ? '2026-10-21T18:03:02.000Z' : null,
      progress: {
        total,
        succeeded: done ? total : 0,
        failed: 0,
        unknown: 0,
        skipped: 0,
        expired: 0,
        pending: done ? 0 : total,
      },
      failure: null,
      confirmedBy: { id: principal, displayName: 'District operator' },
      previewDisplayId,
      changes: null,
      commandType: null,
      statusAction: null,
      deprovisionReason: null,
      targetOrgUnitPaths: [],
      correlationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      latestActivity: {
        at: '2026-10-21T18:03:00.000Z',
        failed: { count: 0, operations: [] },
        unknown: { count: 0, operations: [] },
      },
    };
  }

  private count(disposition: PreviewTarget['disposition']): number {
    return this.frozen.filter((target) => target.disposition === disposition)
      .length;
  }
}

/** The API answers of the Devices page and the edit route. */
async function mockApi(
  page: Page,
  sim: SaveChangesSimulator,
  answers: {
    /** An error answer of the edit route. Omitted answers prepare the edit list. */
    previewError?: { status: number; json?: unknown; body?: string };
    confirm?: () => unknown;
    /** True for the confirm request whose answer never reaches the client. */
    loseConfirm?: (attempt: number) => boolean;
  } = {},
): Promise<ConfirmedRequest[]> {
  /** The preview that the route froze, so a later read answers the same one. */
  let frozen: unknown = null;
  /** Every confirm body that the client sent, in order (IF3 replay evidence). */
  const confirms: ConfirmedRequest[] = [];
  await page.route('**/api/**', async (route: Route) => {
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
            deviceCount: sim.rows().length,
            failure: null,
            telemetryFailure: null,
            startedAt: null,
            checkedAt: null,
            stale: false,
          },
        },
      });
    if (pathname === '/api/devices/by-ids') {
      const body = route.request().postDataJSON() as { deviceIds: string[] };
      const wanted = new Set(body.deviceIds);
      return route.fulfill({
        json: { rows: sim.rows().filter((row) => wanted.has(row.deviceId)) },
      });
    }
    if (pathname === '/api/devices/query') {
      const query = route.request().postDataJSON() as {
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
      const body = route.request().postDataJSON() as {
        edits: DeviceUpdateEdit[];
      };
      if (answers.previewError) {
        const { status, json, body: text } = answers.previewError;
        return json === undefined
          ? route.fulfill({ status, body: text ?? '' })
          : route.fulfill({ status, json });
      }
      frozen = sim.prepare(body.edits);
      return route.fulfill({ json: frozen, status: 201 });
    }
    if (pathname === `/api/devices/updates/previews/${previewId}`)
      return route.fulfill({ json: frozen ?? sim.prepare([]) });
    if (pathname === `/api/devices/updates/previews/${previewId}/targets`)
      return route.fulfill({
        json: { targets: sim.targets(), nextCursor: null },
      });
    if (pathname === `/api/devices/updates/previews/${previewId}/confirm`) {
      const body = route.request().postDataJSON() as {
        previewId: string;
        manifestDigest: string;
        acknowledged: boolean;
      };
      confirms.push(body);
      // The first answer is lost before it reaches the client, as a dropped response is.
      if (answers.loseConfirm?.(confirms.length)) {
        return route.abort('failed');
      }
      return route.fulfill({
        json: answers.confirm ? answers.confirm() : sim.accept(),
        status: 201,
      });
    }
    if (pathname === `/api/jobs/${jobDisplayId}`)
      return route.fulfill({ json: sim.jobDetail() });
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
  return confirms;
}

async function openDevices(
  page: Page,
  sim: SaveChangesSimulator,
  answers: Parameters<typeof mockApi>[2] = {},
): Promise<ConfirmedRequest[]> {
  const confirms = await mockApi(page, sim, answers);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/devices');
  await page.evaluate(() => document.fonts.ready);
  await expect(
    page.getByRole('heading', { name: 'Devices', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('gridcell', { name: 'C0A1-0001', exact: true }),
  ).toBeVisible();
  return confirms;
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
  const input = target.locator('input, textarea');
  await expect(input).toBeVisible();
  await input.fill(value);
  await input.press('Enter');
  await expect(target.locator('input, textarea')).toHaveCount(0);
}

/** Stage a Move from the grid's organization unit picker (addendum section 5). */
async function stageMove(page: Page, serial: string): Promise<void> {
  const unit = cell(page, serial, 'orgUnitPath');
  await unit.click();
  await page.keyboard.press('Enter');
  const picker = page.locator('app-device-org-unit-picker [role="dialog"]');
  await expect(picker).toBeVisible();
  const expand = picker.getByRole('button', {
    name: 'Expand Chrome Devices',
    exact: true,
  });
  if ((await expand.count()) > 0) await expand.click();
  await picker
    .getByRole('treeitem', { name: 'Cart Devices', exact: true })
    .click();
  await picker
    .getByRole('button', { name: 'Stage change', exact: true })
    .click();
  await expect(picker).toBeHidden();
}

async function screenshot(page: Page, name: string): Promise<void> {
  mkdirSync(evidenceDir, { recursive: true });
  await page.screenshot({
    path: path.join(evidenceDir, name),
    fullPage: false,
  });
}

async function axe(page: Page): Promise<void> {
  // Let a Material ripple finish: its overlay is an animation frame, not a resting color.
  await page.waitForTimeout(500);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
}

/** Reload the page, as the person's next visit does, and wait for the grid. */
async function reloadDevices(page: Page): Promise<void> {
  await page.reload();
  await page.evaluate(() => document.fonts.ready);
  await expect(
    page.getByRole('gridcell', { name: 'C0A1-0001', exact: true }),
  ).toBeVisible();
}

test('step 4: one pending change saves without Review or Confirm', async ({
  page,
}) => {
  const sim = new SaveChangesSimulator(seedDevices());
  await openDevices(page, sim);
  await editText(page, 'C0A1-0001', 'assetTag', 'CB-NEW-1');
  await expect(page.locator('#draft-count')).toHaveText(
    '1 pending change · 1 device',
  );
  await expect(
    page.getByRole('button', { name: 'Save changes', exact: true }),
  ).toBeEnabled();

  await page.getByRole('button', { name: 'Save changes', exact: true }).click();

  // The job receipt opens at once: no stepper, no Review, no Confirm.
  await expect(
    page.getByRole('heading', { name: 'Update job created' }),
  ).toBeVisible();
  await expect(page.getByText('Your job is saved')).toBeVisible();
  await expect(page.getByText('1 device · 1 field change')).toBeVisible();
  await expect(
    page.getByText(
      '1 device · 1 field change. Google changes have not completed.',
    ),
  ).toBeVisible();
  await expect(page.getByText('Job UPD-006 · Accepted')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Continue to confirmation' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('list', { name: 'Update device steps' }),
  ).toHaveCount(0);
  await axe(page);
  await screenshot(page, 'save-changes-09-receipt.png');

  await page.getByRole('button', { name: 'Done', exact: true }).click();

  // The cell keeps the accepted value with the job mark until the record arrives.
  const tag = cell(page, 'C0A1-0001', 'assetTag');
  await expect(tag.locator('.device-cell-value')).toHaveText('CB-NEW-1');
  await expect(tag.locator('.cell-state.accepted')).toBeVisible();
  await expect(tag).toHaveClass(/device-draft-accepted/);
  await expect(page.locator('.draft-bar')).toHaveCount(0);
  await screenshot(page, 'save-changes-09-accepted-cell.png');

  // A later visit publishes the written record and no longer shows a job mark.
  sim.settle();
  await reloadDevices(page);
  await expect(tag.locator('.cell-state.accepted')).toHaveCount(0);
  await expect(tag.locator('.device-cell-value')).toHaveText('CB-NEW-1');
});

test('step 5: several changes pass Review and Confirm into one job', async ({
  page,
}) => {
  const sim = new SaveChangesSimulator(seedDevices());
  await openDevices(page, sim);
  await editText(page, 'C0A1-0001', 'assetTag', 'CB-NEW-1');
  await stageMove(page, 'C0A1-0002');
  await expect(page.locator('#draft-count')).toHaveText(
    '2 pending changes · 2 devices',
  );

  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Review 2 device updates' }),
  ).toBeVisible();
  await expect(
    page.getByText('2 devices · 2 field changes · 0 excluded'),
  ).toBeVisible();
  // One row group per device, one row per changed field.
  await expect(page.locator('.targets tbody')).toHaveCount(2);
  await expect(
    page.locator('.targets tbody').first().locator('tr'),
  ).toHaveCount(2);
  await axe(page);
  await screenshot(page, 'save-changes-10-review.png');

  await page.getByRole('button', { name: 'Continue to confirmation' }).click();
  await expect(
    page.getByRole('heading', { name: 'Update 2 fields on 2 devices' }),
  ).toBeVisible();
  const sentences = page.locator('.change-list li');
  await expect(sentences).toHaveCount(2);
  await expect(sentences.nth(0)).toHaveText(
    'Set the asset tag to CB-NEW-1 on C0A1-0001.',
  );
  await expect(sentences.nth(1)).toHaveText(
    'Move C0A1-0002 into /Chrome Devices/Cart Devices. Destination policies apply.',
  );
  await page
    .getByRole('checkbox', { name: /I reviewed all 2 devices/ })
    .check();
  await axe(page);
  await screenshot(page, 'save-changes-11-confirm.png');

  await page.getByRole('button', { name: 'Create update job' }).click();
  await expect(
    page.getByRole('heading', { name: 'Update job created' }),
  ).toBeVisible();
  await expect(page.getByText('2 devices · 2 field changes')).toBeVisible();
  await screenshot(page, 'save-changes-12-job.png');

  // One job holds one row per device and field.
  expect(
    sim.targets().filter((target) => target.disposition === 'eligible'),
  ).toHaveLength(2);

  await page.getByRole('button', { name: 'Done', exact: true }).click();
  // Every confirmed cell shows its accepted value, and the draft is empty.
  await expect(
    cell(page, 'C0A1-0001', 'assetTag').locator('.cell-state.accepted'),
  ).toBeVisible();
  await expect(
    cell(page, 'C0A1-0002', 'orgUnitPath').locator('.cell-state.accepted'),
  ).toBeVisible();
  await expect(page.locator('.draft-bar')).toHaveCount(0);
});

test('step 6: a device that the job does not write keeps its old value', async ({
  page,
}) => {
  const sim = new SaveChangesSimulator(seedDevices());
  await openDevices(page, sim);
  await editText(page, 'C0A1-0001', 'assetTag', 'CB-NEW-1');
  await editText(page, 'C0A1-0002', 'assetTag', 'CB-NEW-2');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.getByRole('button', { name: 'Continue to confirmation' }).click();
  await page
    .getByRole('checkbox', { name: /I reviewed all 2 devices/ })
    .check();
  await page.getByRole('button', { name: 'Create update job' }).click();
  await expect(
    page.getByRole('heading', { name: 'Update job created' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Done', exact: true }).click();

  // The worker writes the first device only, so the second keeps its old value.
  sim.settle(['d0']);
  await reloadDevices(page);
  await expect(
    cell(page, 'C0A1-0001', 'assetTag').locator('.device-cell-value'),
  ).toHaveText('CB-NEW-1');
  await expect(
    cell(page, 'C0A1-0002', 'assetTag').locator('.device-cell-value'),
  ).toHaveText('HS-0002');
  await expect(
    cell(page, 'C0A1-0002', 'assetTag').locator('.cell-state.accepted'),
  ).toHaveCount(0);
  await screenshot(page, 'save-changes-12-failed-device.png');
});

test('step 6: a stale baseline marks the cell as a conflict and blocks Continue', async ({
  page,
}) => {
  const sim = new SaveChangesSimulator(seedDevices());
  await openDevices(page, sim);
  await editText(page, 'C0A1-0003', 'assetTag', 'CB-NEW-3');
  // A value changes in Google after the edit began, so the fresh read differs from the
  // baseline that the edit carried.
  sim.change('d2', 'assetTag', 'CB-CHANGED');

  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Review 1 device update' }),
  ).toBeVisible();
  await expect(
    page.getByText('1 device · 1 field change · 0 excluded · 1 conflict'),
  ).toBeVisible();
  await expect(
    page.getByText('1 conflict. A value changed in Google'),
  ).toBeVisible();
  await expect(
    page.getByText(
      'Resolve the marked cells in the grid, then save the changes again.',
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Continue to confirmation' }),
  ).toBeDisabled();
  await axe(page);
  await screenshot(page, 'save-changes-10-conflict-review.png');

  // The secondary action shows the devices that hold a change, so the person can resolve it.
  await page.getByRole('button', { name: 'Review pending devices' }).click();
  await expect(
    page.locator('section.bulk-sheet[aria-labelledby="bulk-sheet-title"]'),
  ).not.toHaveClass(/is-open/);
  const tag = cell(page, 'C0A1-0003', 'assetTag');
  await expect(page.locator('#draft-count')).toHaveText(
    '1 pending change · 1 device',
  );
  await expect(tag).toHaveClass(/device-draft-conflict/);
  // The cell keeps the draft value and names the current Google value in its state text
  // (mockup state 06).
  await expect(tag.locator('.device-cell-value')).toHaveText('CB-NEW-3');
  await expect(tag).toContainText('Current value: CB-CHANGED');
  await expect(
    page.getByRole('button', { name: 'Save changes', exact: true }),
  ).toBeDisabled();
  await screenshot(page, 'save-changes-06-conflict-cell.png');

  // Keep current value answers the conflict and returns the cell to the row value.
  await page
    .getByRole('button', { name: 'Resolve conflict on asset tag of C0A1-0003' })
    .click();
  await expect(
    page.getByRole('heading', {
      name: 'The asset tag changed after you began editing',
    }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Keep current value' }).click();
  await expect(tag).not.toHaveClass(/device-draft-conflict/);
  await expect(page.locator('.draft-bar')).toHaveCount(0);
});

test('a lost confirm answer replays the same preview and digest, one job', async ({
  page,
}) => {
  const sim = new SaveChangesSimulator(seedDevices());
  // The first confirm answer never reaches the client, so the job may or may not exist.
  const confirms = await openDevices(page, sim, {
    loseConfirm: (attempt) => attempt === 1,
  });
  await editText(page, 'C0A1-0001', 'assetTag', 'CB-NEW-1');
  await editText(page, 'C0A1-0002', 'assetTag', 'CB-NEW-2');

  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.getByRole('button', { name: 'Continue to confirmation' }).click();
  const box = page.getByRole('checkbox', {
    name: 'I reviewed all 2 devices and their final values.',
  });
  await box.check();
  await page.getByRole('button', { name: 'Create update job' }).click();

  // An uncertain answer keeps the review and offers a replay, not a second job.
  await expect(
    page.getByRole('heading', { name: 'Retry the confirmation' }),
  ).toBeVisible();
  await expect(page.getByText('Job UPD-006')).toHaveCount(0);

  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Update job created' }),
  ).toBeVisible();

  // Both requests name the same frozen preview and digest, and the route saw one job.
  expect(confirms).toHaveLength(2);
  expect(confirms[0]?.previewId).toBe(confirms[1]?.previewId);
  expect(confirms[0]?.manifestDigest).toBe(confirms[1]?.manifestDigest);
  expect(confirms.every((body) => body.acknowledged)).toBe(true);
  expect(sim.jobCount).toBe(1);
  await screenshot(page, 'save-changes-09-replayed-confirm.png');
});

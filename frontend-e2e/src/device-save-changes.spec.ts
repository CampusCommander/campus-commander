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
import { installLiveStreams, liveStreams } from './live-streams';

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
  /** Another device that already holds an Asset tag, per device. */
  private readonly duplicateSerials = new Map<string, string>();

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
        duplicateSerialNumber:
          this.duplicateSerials.get(target.deviceId) ?? null,
        disposition: field.disposition,
        exclusionReason: target.exclusionReason,
      })),
    );
  }

  /** Another device already holds the requested Asset tag of this device. */
  duplicate(deviceId: string, serialNumber: string): void {
    this.duplicateSerials.set(deviceId, serialNumber);
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
    // The worker publishes only the devices that its write reached.
    const written = new Set(this.written).size;
    const failed = done ? total - written : 0;
    return {
      jobId,
      displayId: jobDisplayId,
      revision: done ? 2 : 1,
      action: 'update-device-annotations',
      status: !done
        ? 'accepted'
        : failed > 0
          ? 'completed-with-errors'
          : 'completed',
      scope: { kind: 'devices', deviceCount: total },
      requestedBy: { id: principal, displayName: 'District operator' },
      createdAt: '2026-10-21T18:03:00.000Z',
      startedAt: done ? '2026-10-21T18:03:01.000Z' : null,
      finishedAt: done ? '2026-10-21T18:03:02.000Z' : null,
      progress: {
        total,
        succeeded: done ? written : 0,
        failed,
        unknown: 0,
        skipped: 0,
        expired: 0,
        cancelled: 0,
        pending: done ? 0 : total,
      },
      cancelRequest: null,
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
      phase: null,
      exportSummary: null,
      importSummary: null,
      exportFile: null,
      importSource: null,
      plan: null,
      importDisplayId: null,
      waitsForDisplayId: null,
      waitingDisplayIds: null,
      planJobs: null,
      executionCounts: null,
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
    /** Held before the first confirm answer, as a slow server does. */
    holdConfirm?: Promise<void>;
  } = {},
): Promise<ConfirmedRequest[]> {
  /** The preview that the route froze, so a later read answers the same one. */
  let frozen: unknown = null;
  /** Every confirm body that the client sent, in order (IF3 replay evidence). */
  const confirms: ConfirmedRequest[] = [];
  // Every case of this file reaches the page through this startup, so the fake feeds are
  // installed here and before the first navigation.
  await installLiveStreams(page);
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
      if (answers.holdConfirm) await answers.holdConfirm;
      return route.fulfill({
        json: answers.confirm ? answers.confirm() : sim.accept(),
        status: 201,
      });
    }
    if (pathname === `/api/jobs/${jobDisplayId}`)
      return route.fulfill({ json: sim.jobDetail() });
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
  // Let a sheet finish its open movement: evidence must show the resting layout.
  await page.waitForTimeout(350);
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

/** Open a text cell editor and type without Enter, as a click on Save changes interrupts it. */
async function openEditor(
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
  // Playwright can set the value before the app attaches its live listener. One harmless
  // key round trip makes the live input deterministic without changing the value.
  await input.press('End');
  await input.type('X');
  await input.press('Backspace');
}

/** Dispatch one device refresh through the page's own stream handler. */
async function emitDevices(page: Page, ids: string[]): Promise<void> {
  await liveStreams(page).send('/api/events', 'entity-batch', {
    type: 'entity-batch',
    entityType: 'device',
    deviceIds: ids,
    removedIds: [],
  });
}

/**
 * The ordinary startup of this file holds the one live feed with the fake streams. No case that
 * navigates through `openDevices` may fall back to a native EventSource: that stream would
 * answer with a complete 404 body, end, and reopen with another `by-ids` read.
 */
test('the ordinary Devices startup holds the one feed without a native stream', async ({
  page,
}) => {
  const nativeEventRequests: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path === '/api/events') nativeEventRequests.push(path);
  });

  await openDevices(page, new SaveChangesSimulator(seedDevices()));

  // The startup installed the fake before navigation, and the app's own feed uses it.
  await expect
    .poll(async () => liveStreams(page).openUrls())
    .toEqual(['/api/events']);
  expect(nativeEventRequests).toEqual([]);

  // Past the app's five-second reopen delay the feed still holds its first stream, so no
  // stream ended and no stream was replaced.
  await page.waitForTimeout(5_500);
  expect(await liveStreams(page).openUrls()).toEqual(['/api/events']);
  expect(await liveStreams(page).constructedCount('/api/events')).toBe(1);
  expect(nativeEventRequests).toEqual([]);
});

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
  // One device carries two fields, so the job holds one row per device and field.
  await editText(page, 'C0A1-0001', 'assetTag', 'CB-NEW-1');
  await stageMove(page, 'C0A1-0001');
  await editText(page, 'C0A1-0002', 'assetTag', 'CB-NEW-2');
  await expect(page.locator('#draft-count')).toHaveText(
    '3 pending changes · 2 devices',
  );

  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Review 2 device updates' }),
  ).toBeVisible();
  await expect(
    page.getByText('2 devices · 3 field changes · 0 excluded'),
  ).toBeVisible();
  // One row group per device, one row per changed field.
  await expect(page.locator('.targets tbody')).toHaveCount(2);
  await expect(
    page.locator('.targets tbody').first().locator('tr'),
  ).toHaveCount(3);
  await axe(page);
  await screenshot(page, 'save-changes-10-review.png');

  await page.getByRole('button', { name: 'Continue to confirmation' }).click();
  // The heading counts the distinct fields that the rows carry.
  await expect(
    page.getByRole('heading', { name: 'Update 2 fields on 2 devices' }),
  ).toBeVisible();
  const sentences = page.locator('.change-list li');
  await expect(sentences).toHaveCount(3);
  await expect(sentences.nth(0)).toHaveText(
    'Set the asset tag to CB-NEW-1 on C0A1-0001.',
  );
  await expect(sentences.nth(1)).toHaveText(
    'Move C0A1-0001 into /Chrome Devices/Cart Devices. Destination policies apply.',
  );
  await expect(sentences.nth(2)).toHaveText(
    'Set the asset tag to CB-NEW-2 on C0A1-0002.',
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
  await expect(page.getByText('2 devices · 3 field changes')).toBeVisible();
  await screenshot(page, 'save-changes-12-job.png');

  // One job holds one row per device and field.
  expect(
    sim.targets().filter((target) => target.disposition === 'eligible'),
  ).toHaveLength(3);

  await page.getByRole('button', { name: 'Done', exact: true }).click();
  // Every confirmed cell shows its accepted value, and the draft is empty.
  await expect(
    cell(page, 'C0A1-0001', 'assetTag').locator('.cell-state.accepted'),
  ).toBeVisible();
  await expect(
    cell(page, 'C0A1-0001', 'orgUnitPath').locator('.cell-state.accepted'),
  ).toBeVisible();
  await expect(
    cell(page, 'C0A1-0002', 'assetTag').locator('.cell-state.accepted'),
  ).toBeVisible();
  await expect(page.locator('.draft-bar')).toHaveCount(0);
});

test('step 6: a failed device returns to its old value without a reload', async ({
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

  // The worker writes the first device only. Its publication reaches the grid as the
  // production `entity-batch` event; the job records the failure of the second.
  sim.settle(['d0']);
  const refreshed = page.waitForResponse((response) =>
    response.url().endsWith('/api/devices/by-ids'),
  );
  await emitDevices(page, ['d0']);
  await refreshed;

  const first = cell(page, 'C0A1-0001', 'assetTag');
  await expect(first.locator('.cell-state.accepted')).toHaveCount(0);
  await expect(first.locator('.device-cell-value')).toHaveText('CB-NEW-1');
  const second = cell(page, 'C0A1-0002', 'assetTag');
  await expect(second.locator('.device-cell-value')).toHaveText('HS-0002', {
    timeout: 3000,
  });
  await expect(second.locator('.cell-state.accepted')).toHaveCount(0);
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

test('one-click Save includes the live value without Enter', async ({
  page,
}) => {
  const sim = new SaveChangesSimulator(seedDevices());
  const confirms = await openDevices(page, sim);
  await openEditor(page, 'C0A1-0001', 'assetTag', 'LIVE-VALID');
  await expect(page.locator('#draft-count')).toHaveText(
    '1 pending change · 1 device',
  );

  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Update job created' }),
  ).toBeVisible();
  expect(confirms).toHaveLength(1);
  expect(sim.targets()).toHaveLength(1);
  expect(sim.targets()[0]?.approvedValue).toBe('LIVE-VALID');
  await screenshot(page, 'save-changes-09-live-one-click.png');
});

test('a live second value joins the same two-change preview', async ({
  page,
}) => {
  const sim = new SaveChangesSimulator(seedDevices());
  const confirms = await openDevices(page, sim);
  await editText(page, 'C0A1-0001', 'assetTag', 'STAGED-FIRST');
  await expect(page.locator('#draft-count')).toHaveText(
    '1 pending change · 1 device',
  );
  await openEditor(page, 'C0A1-0002', 'assetTag', 'LIVE-SECOND');
  await expect(page.locator('#draft-count')).toHaveText(
    '2 pending changes · 2 devices',
  );

  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Review 2 device updates' }),
  ).toBeVisible();
  // The live value is in the frozen edit list, so no one-change job starts.
  expect(confirms).toHaveLength(0);
  expect(sim.targets()).toHaveLength(2);
  expect(
    sim
      .targets()
      .map((target) => target.approvedValue)
      .sort(),
  ).toEqual(['LIVE-SECOND', 'STAGED-FIRST']);
  await screenshot(page, 'save-changes-10-live-second-review.png');
});

test('an invalid live value blocks the whole save', async ({ page }) => {
  const sim = new SaveChangesSimulator(seedDevices());
  const confirms = await openDevices(page, sim);
  await editText(page, 'C0A1-0001', 'assetTag', 'VALID-PENDING');
  await openEditor(page, 'C0A1-0002', 'assetTag', ' ');
  await expect(page.locator('#draft-count')).toHaveText(
    '2 pending changes · 2 devices',
  );

  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.waitForTimeout(300);
  expect(confirms).toHaveLength(0);
  expect(sim.jobCount).toBe(0);
  await expect(
    page.getByRole('heading', { name: 'Review 2 device updates' }),
  ).toHaveCount(0);
  const second = cell(page, 'C0A1-0002', 'assetTag');
  await expect(second).toHaveClass(/device-draft-invalid/);
  await expect(page.locator('#draft-count')).toHaveText(
    '2 pending changes · 2 devices',
  );
  await screenshot(page, 'save-changes-10-live-invalid-blocked.png');
});

test('an accepted cell keeps a later edit', async ({ page }) => {
  const sim = new SaveChangesSimulator(seedDevices());
  await openDevices(page, sim);
  await editText(page, 'C0A1-0001', 'assetTag', 'APPROVED-VALUE');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Update job created' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  const target = cell(page, 'C0A1-0001', 'assetTag');
  await expect(target.locator('.cell-state.accepted')).toBeVisible();

  // The person edits back to the value that Google still holds. The edit stages against
  // the accepted value that the cell shows, so it is a new pending change, not a removal.
  await editText(page, 'C0A1-0001', 'assetTag', 'HS-0001');
  await expect(target.locator('.device-cell-value')).toHaveText('HS-0001');
  await expect(page.locator('#draft-count')).toHaveText(
    '1 pending change · 1 device',
  );
  await expect(target.locator('.cell-state.accepted')).toHaveCount(0);
  await screenshot(page, 'save-changes-09-accepted-reedit.png');
});

test('an unrelated refresh keeps the accepted mark while the job runs', async ({
  page,
}) => {
  const sim = new SaveChangesSimulator(seedDevices());
  await openDevices(page, sim);
  await editText(page, 'C0A1-0001', 'assetTag', 'PENDING-WRITE');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Update job created' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Done', exact: true }).click();

  // Refresh Selected can publish this ID before the held update writes.
  const refreshed = page.waitForResponse((response) =>
    response.url().endsWith('/api/devices/by-ids'),
  );
  await emitDevices(page, ['d0']);
  await refreshed;
  const target = cell(page, 'C0A1-0001', 'assetTag');
  await expect(target.locator('.cell-state.accepted')).toBeVisible({
    timeout: 3000,
  });
  await expect(target.locator('.device-cell-value')).toHaveText(
    'PENDING-WRITE',
  );
  await screenshot(page, 'save-changes-09-unrelated-refresh.png');
});

test('a record that arrives before the receipt settles the accepted cell', async ({
  page,
}) => {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sim = new SaveChangesSimulator(seedDevices());
  await openDevices(page, sim, { holdConfirm: held });
  await editText(page, 'C0A1-0001', 'assetTag', 'CB-NEW-1');
  const confirming = page.waitForRequest((request) =>
    request.url().endsWith('/confirm'),
  );
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await confirming;

  // The worker publishes the row while the confirmation answer is still in flight.
  sim.settle();
  const refreshed = page.waitForResponse((response) =>
    response.url().endsWith('/api/devices/by-ids'),
  );
  await emitDevices(page, ['d0']);
  await refreshed;
  release();

  await expect(
    page.getByRole('heading', { name: 'Update job created' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  const target = cell(page, 'C0A1-0001', 'assetTag');
  await expect(target.locator('.device-cell-value')).toHaveText('CB-NEW-1');
  await expect(target.locator('.cell-state.accepted')).toHaveCount(0, {
    timeout: 3000,
  });
  await expect(page.locator('.draft-bar')).toHaveCount(0);
  await screenshot(page, 'save-changes-09-record-before-receipt.png');
});

test('a one-cell unchanged answer leaves the draft and creates no job', async ({
  page,
}) => {
  const sim = new SaveChangesSimulator(seedDevices());
  const confirms = await openDevices(page, sim);
  await editText(page, 'C0A1-0001', 'assetTag', 'GOOGLE-ALREADY-HOLDS');
  // Google already holds the value when the edit route reads the device, and the grid
  // receives that record before the save.
  sim.change('d0', 'assetTag', 'GOOGLE-ALREADY-HOLDS');
  const refreshed = page.waitForResponse((response) =>
    response.url().endsWith('/api/devices/by-ids'),
  );
  await emitDevices(page, ['d0']);
  await refreshed;
  await expect(
    cell(page, 'C0A1-0001', 'assetTag').locator('.device-cell-value'),
  ).toHaveText('GOOGLE-ALREADY-HOLDS');

  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Review 1 device update' }),
  ).toBeVisible();
  await expect(
    page.getByText(
      'Google already holds the value. The change left the draft.',
    ),
  ).toBeVisible();
  expect(confirms).toHaveLength(0);
  expect(sim.jobCount).toBe(0);
  await expect(
    page.getByRole('button', { name: 'Continue to confirmation' }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.locator('.draft-bar')).toHaveCount(0);
  await expect(
    cell(page, 'C0A1-0001', 'assetTag').locator('.device-cell-value'),
  ).toHaveText('GOOGLE-ALREADY-HOLDS');
  await screenshot(page, 'save-changes-10-unchanged-one-cell.png');
});

test('one confirm accepted before its lost answer replays without a second job', async ({
  page,
}) => {
  const sim = new SaveChangesSimulator(seedDevices());
  // The route accepts the first request, then its answer is lost on the way back.
  const confirms = await openDevices(page, sim, {
    loseConfirm: (attempt) => {
      if (attempt === 1) {
        sim.accept();
        return true;
      }
      return false;
    },
    confirm: () => sim.receipt(),
  });
  await editText(page, 'C0A1-0001', 'assetTag', 'FIRST-WRITE');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Retry the confirmation' }),
  ).toBeVisible();
  expect(sim.jobCount).toBe(1);

  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Update job created' }),
  ).toBeVisible();
  expect(confirms).toHaveLength(2);
  expect(confirms[1]).toEqual(confirms[0]);
  expect(sim.jobCount).toBe(1);
  await screenshot(page, 'save-changes-09-accepted-before-lost.png');
});

test('both receipts name the duplicate Asset tag serial', async ({ page }) => {
  const sim = new SaveChangesSimulator(seedDevices());
  sim.duplicate('d0', 'OTHER-SERIAL-2');
  await openDevices(page, sim);
  await editText(page, 'C0A1-0001', 'assetTag', 'DUPLICATE-TAG');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Update job created' }),
  ).toBeVisible();
  await expect(
    page.getByText(
      'C0A1-0001 · OTHER-SERIAL-2 already holds DUPLICATE-TAG. The asset tag repeats.',
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Continue to confirmation' }),
  ).toHaveCount(0);
  await screenshot(page, 'save-changes-09-duplicate-receipt.png');
});

test('a several-change receipt names the duplicate after Confirm', async ({
  page,
}) => {
  const sim = new SaveChangesSimulator(seedDevices());
  sim.duplicate('d0', 'OTHER-SERIAL-3');
  await openDevices(page, sim);
  await editText(page, 'C0A1-0001', 'assetTag', 'DUPLICATE-TAG');
  await editText(page, 'C0A1-0002', 'assetTag', 'SECOND-CHANGE');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  const line =
    'C0A1-0001 · OTHER-SERIAL-3 already holds DUPLICATE-TAG. The asset tag repeats.';
  await expect(page.getByText(line)).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Continue to confirmation' }),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Continue to confirmation' }).click();
  await page
    .getByRole('checkbox', { name: /I reviewed all 2 devices/ })
    .check();
  await page.getByRole('button', { name: 'Create update job' }).click();
  await expect(
    page.getByRole('heading', { name: 'Update job created' }),
  ).toBeVisible();
  await expect(page.getByText(line)).toBeVisible();
  await screenshot(page, 'save-changes-12-duplicate-receipt.png');
});

test('an answer after the sheet closes settles the submitted drafts', async ({
  page,
}) => {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sim = new SaveChangesSimulator(seedDevices());
  await openDevices(page, sim, { holdConfirm: held });
  await editText(page, 'C0A1-0001', 'assetTag', 'CB-NEW-1');
  await editText(page, 'C0A1-0002', 'assetTag', 'CB-NEW-2');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.getByRole('button', { name: 'Continue to confirmation' }).click();
  await page
    .getByRole('checkbox', { name: /I reviewed all 2 devices/ })
    .check();
  const confirming = page.waitForRequest((request) =>
    request.url().endsWith('/confirm'),
  );
  await page.getByRole('button', { name: 'Create update job' }).click();
  await confirming;

  // The sheet closes while the answer is in flight. The job exists, so its rows settle.
  await page.getByRole('button', { name: 'Close' }).click();
  release();
  await expect(page.locator('.draft-bar')).toHaveCount(0, { timeout: 3000 });
  await expect(
    cell(page, 'C0A1-0001', 'assetTag').locator('.cell-state.accepted'),
  ).toBeVisible();
  await expect(
    cell(page, 'C0A1-0002', 'assetTag').locator('.cell-state.accepted'),
  ).toBeVisible();
  await screenshot(page, 'save-changes-09-closed-before-answer.png');
});

test('a live return to baseline leaves the preview before Save snapshots it', async ({
  page,
}) => {
  const sim = new SaveChangesSimulator(seedDevices());
  const confirms = await openDevices(page, sim);
  await editText(page, 'C0A1-0001', 'assetTag', 'STALE-DRAFT');
  await editText(page, 'C0A1-0002', 'assetTag', 'KEEP-THIS');
  await expect(page.locator('#draft-count')).toHaveText(
    '2 pending changes · 2 devices',
  );
  await openEditor(page, 'C0A1-0001', 'assetTag', 'HS-0001');
  // Type once more after the editor is fully open, so the live listener is attached.
  const input = cell(page, 'C0A1-0001', 'assetTag').locator('input, textarea');
  await input.press('End');
  await input.type('X');
  await input.press('Backspace');
  await expect(page.locator('#draft-count')).toHaveText(
    '1 pending change · 1 device',
  );

  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Update job created' }),
  ).toBeVisible();
  expect(sim.targets()).toHaveLength(1);
  expect(sim.targets()[0]?.deviceId).toBe('d1');
  expect(confirms).toHaveLength(1);
  await screenshot(page, 'save-changes-09-live-baseline-omitted.png');
});

test('a successful read before a delayed receipt updates the displayed row', async ({
  page,
}) => {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sim = new SaveChangesSimulator(seedDevices());
  await openDevices(page, sim, { holdConfirm: held });
  await editText(page, 'C0A1-0001', 'assetTag', 'WRITTEN-BEFORE-RECEIPT');
  const confirming = page.waitForRequest((request) =>
    request.url().endsWith('/confirm'),
  );
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await confirming;
  // The write lands, but no device event reaches the grid before the answer.
  sim.settle();
  release();
  await expect(
    page.getByRole('heading', { name: 'Update job created' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Done', exact: true }).click();

  const tag = cell(page, 'C0A1-0001', 'assetTag');
  await expect(tag.locator('.cell-state.accepted')).toHaveCount(0);
  await expect(tag.locator('.device-cell-value')).toHaveText(
    'WRITTEN-BEFORE-RECEIPT',
    { timeout: 2000 },
  );
  await screenshot(page, 'save-changes-12-read-before-receipt.png');
});

test('an unchanged answer shows the Google value without a prior grid refresh', async ({
  page,
}) => {
  const sim = new SaveChangesSimulator(seedDevices());
  const confirms = await openDevices(page, sim);
  await editText(page, 'C0A1-0001', 'assetTag', 'ALREADY-WRITTEN');
  sim.change('d0', 'assetTag', 'ALREADY-WRITTEN');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(
    page.getByText(
      'Google already holds the value. The change left the draft.',
    ),
  ).toBeVisible();
  expect(confirms).toHaveLength(0);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.locator('.draft-bar')).toHaveCount(0);
  await expect(
    cell(page, 'C0A1-0001', 'assetTag').locator('.device-cell-value'),
  ).toHaveText('ALREADY-WRITTEN', { timeout: 2000 });
  await screenshot(page, 'save-changes-10-unchanged-google-value.png');
});

test('an all-failed job settles after its job event without a device publication', async ({
  page,
}) => {
  const sim = new SaveChangesSimulator(seedDevices());
  await openDevices(page, sim);
  let jobReads = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === `/api/jobs/${jobDisplayId}`)
      jobReads++;
  });
  await editText(page, 'C0A1-0001', 'assetTag', 'FAILED-WRITE');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Update job created' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.waitForTimeout(200);
  sim.settle([]);
  const before = jobReads;

  // The worker publishes no device row for a failed write. The jobs channel carries it.
  await emitJobChanged(page);
  await page.waitForTimeout(500);
  expect(jobReads).toBeGreaterThan(before);
  const tag = cell(page, 'C0A1-0001', 'assetTag');
  await expect(tag.locator('.device-cell-value')).toHaveText('HS-0001', {
    timeout: 2000,
  });
  await expect(tag.locator('.cell-state.accepted')).toHaveCount(0);
  await screenshot(page, 'save-changes-12-all-failed-settled.png');
});

test('a later save cannot discard a revert while its earlier job remains pending', async ({
  page,
}) => {
  const sim = new SaveChangesSimulator(seedDevices());
  const confirms = await openDevices(page, sim);
  await editText(page, 'C0A1-0001', 'assetTag', 'FIRST-JOB-WILL-WRITE');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Update job created' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await editText(page, 'C0A1-0001', 'assetTag', 'HS-0001');
  await expect(page.locator('#draft-count')).toHaveText(
    '1 pending change · 1 device',
  );
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Review 1 device update' }),
  ).toBeVisible();
  await expect(
    page.getByText(
      'Google still holds the value. The change stays in the draft until the earlier update finishes.',
    ),
  ).toBeVisible();
  expect(confirms).toHaveLength(1);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  const tag = cell(page, 'C0A1-0001', 'assetTag');
  await expect(tag.locator('.device-cell-value')).toHaveText('HS-0001', {
    timeout: 2000,
  });
  await expect(page.locator('#draft-count')).toHaveText(
    '1 pending change · 1 device',
  );
  await screenshot(page, 'save-changes-09-revert-waits-for-job.png');
});

test('Escape after a live baseline visit keeps the staged value (B1)', async ({
  page,
}) => {
  const sim = new SaveChangesSimulator(seedDevices());
  const confirms = await openDevices(page, sim);
  await editText(page, 'C0A1-0001', 'assetTag', 'KEEP-STAGED-VALUE');
  await expect(
    cell(page, 'C0A1-0001', 'assetTag').locator('.device-cell-value'),
  ).toHaveText('KEEP-STAGED-VALUE');

  // Reopen the cell and type its baseline without Enter, then cancel with Escape.
  await openEditor(page, 'C0A1-0001', 'assetTag', 'HS-0001');
  // The draft bar hides while the open editor shows the baseline.
  await expect(page.locator('.draft-bar')).toHaveCount(0);
  const input = cell(page, 'C0A1-0001', 'assetTag').locator('input, textarea');
  await input.press('Escape');

  // The cancellation restores the staged value and leaves the draft untouched.
  await expect(
    cell(page, 'C0A1-0001', 'assetTag').locator('.device-cell-value'),
  ).toHaveText('KEEP-STAGED-VALUE', { timeout: 2000 });
  await expect(page.locator('#draft-count')).toHaveText(
    '1 pending change · 1 device',
  );
  expect(confirms).toHaveLength(0);
  await screenshot(page, 'save-changes-04-escape-keeps-staged.png');
});

test('a grid edit during Review keeps its draft after the frozen confirm (B8)', async ({
  page,
}) => {
  const sim = new SaveChangesSimulator(seedDevices());
  const confirms = await openDevices(page, sim);
  await editText(page, 'C0A1-0001', 'assetTag', 'FIRST-FROZEN-VALUE');
  await editText(page, 'C0A1-0002', 'assetTag', 'SECOND-FROZEN-VALUE');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Review 2 device updates' }),
  ).toBeVisible();

  // The side sheet leaves the grid usable. This edit is later than the frozen preview.
  await editText(page, 'C0A1-0001', 'assetTag', 'LATER-KEEP-ME');
  await expect(
    cell(page, 'C0A1-0001', 'assetTag').locator('.device-cell-value'),
  ).toHaveText('LATER-KEEP-ME');

  await page.getByRole('button', { name: 'Continue to confirmation' }).click();
  await page
    .getByRole('checkbox', { name: /I reviewed all 2 devices/ })
    .check();
  await page.getByRole('button', { name: 'Create update job' }).click();
  await expect(
    page.getByRole('heading', { name: 'Update job created' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Done', exact: true }).click();

  // The job owns the frozen requests. The later edit keeps its own draft.
  expect(confirms).toHaveLength(1);
  expect(
    sim.targets().find((row) => row.deviceId === 'd0')?.approvedValue,
  ).toBe('FIRST-FROZEN-VALUE');
  await expect(page.locator('#draft-count')).toHaveText(
    '1 pending change · 1 device',
    { timeout: 2000 },
  );
  const first = cell(page, 'C0A1-0001', 'assetTag');
  await expect(first.locator('.device-cell-value')).toHaveText('LATER-KEEP-ME');
  // The untouched frozen row is accepted, and the cell shows the request that ran.
  const second = cell(page, 'C0A1-0002', 'assetTag');
  await expect(second.locator('.device-cell-value')).toHaveText(
    'SECOND-FROZEN-VALUE',
  );
  await expect(second.locator('.cell-state.accepted')).toBeVisible();
  await screenshot(page, 'save-changes-10-later-draft-after-confirm.png');
});

test('a grid edit during Review survives the confirm replay (B8)', async ({
  page,
}) => {
  const sim = new SaveChangesSimulator(seedDevices());
  const confirms = await openDevices(page, sim, {
    loseConfirm: (attempt) => attempt === 1,
  });
  await editText(page, 'C0A1-0001', 'assetTag', 'FIRST-FROZEN-VALUE');
  await editText(page, 'C0A1-0002', 'assetTag', 'SECOND-FROZEN-VALUE');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Review 2 device updates' }),
  ).toBeVisible();
  await editText(page, 'C0A1-0001', 'assetTag', 'LATER-KEEP-ME');

  await page.getByRole('button', { name: 'Continue to confirmation' }).click();
  await page
    .getByRole('checkbox', { name: /I reviewed all 2 devices/ })
    .check();
  await page.getByRole('button', { name: 'Create update job' }).click();
  // The first answer is lost, so the retained record replays the same identity.
  await expect(
    page.getByRole('heading', { name: 'Retry the confirmation' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Update job created' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Done', exact: true }).click();

  // The replay settles the frozen list, never the later value.
  expect(confirms).toHaveLength(2);
  expect(confirms[0]?.previewId).toBe(confirms[1]?.previewId);
  expect(confirms[0]?.manifestDigest).toBe(confirms[1]?.manifestDigest);
  expect(sim.jobCount).toBe(1);
  expect(
    sim.targets().find((row) => row.deviceId === 'd0')?.approvedValue,
  ).toBe('FIRST-FROZEN-VALUE');
  await expect(page.locator('#draft-count')).toHaveText(
    '1 pending change · 1 device',
    { timeout: 2000 },
  );
  await expect(
    cell(page, 'C0A1-0001', 'assetTag').locator('.device-cell-value'),
  ).toHaveText('LATER-KEEP-ME');
  await screenshot(page, 'save-changes-09-replayed-later-draft.png');
});

test('a successful terminal job keeps its value until its row read recovers (B4)', async ({
  page,
}) => {
  const sim = new SaveChangesSimulator(seedDevices());
  await openDevices(page, sim);
  await editText(page, 'C0A1-0001', 'assetTag', 'WRITTEN-BUT-READ-UNAVAILABLE');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Update job created' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.waitForTimeout(300);

  // The worker wrote the value, but the next authoritative read fails.
  sim.settle();
  await page.route('**/api/devices/by-ids', (route) =>
    route.fulfill({ status: 503, json: { code: 'network-failure' } }),
  );
  const changed = () => emitJobChanged(page);
  await changed();
  await page.waitForTimeout(500);

  // A failed read proves nothing, so the written value stays with its clock.
  const tag = cell(page, 'C0A1-0001', 'assetTag');
  await expect(tag.locator('.device-cell-value')).toHaveText(
    'WRITTEN-BUT-READ-UNAVAILABLE',
    { timeout: 2000 },
  );
  await expect(tag.locator('.cell-state.accepted')).toBeVisible();
  await screenshot(page, 'save-changes-12-read-unavailable-keeps-value.png');

  // The next read answers, and the authoritative value settles the accepted cell.
  await page.unroute('**/api/devices/by-ids');
  await changed();
  await expect(tag.locator('.cell-state.accepted')).toHaveCount(0, {
    timeout: 2000,
  });
  await expect(tag.locator('.device-cell-value')).toHaveText(
    'WRITTEN-BUT-READ-UNAVAILABLE',
  );
  await screenshot(page, 'save-changes-12-read-recovered.png');
});

/**
 * Dispatch one `job-changed` event through the page's own jobs stream handler. Every API
 * answer stays mocked; this is the test EventSource boundary that the application opens.
 */
async function emitJobChanged(page: Page): Promise<void> {
  await liveStreams(page).send('/api/events', 'job-changed', {
    type: 'job-changed',
    jobId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    displayId: jobDisplayId,
    revision: 2,
    requestedBy: principal,
  });
}

/**
 * Confirm one device with an Asset tag and a Move, then settle it as the production
 * classifier does: the Asset tag holds REQUESTED-TAG while Google normalizes the Move, so
 * the whole operation is failed/value-differs after HTTP 200 with zero succeeded
 * operations. The row read then fails or omits the device (B4).
 */
async function settlePartialValueDiffers(
  page: Page,
  sim: SaveChangesSimulator,
  read: 'failed' | 'missing',
): Promise<void> {
  await openDevices(page, sim);
  await editText(page, 'C0A1-0001', 'assetTag', 'REQUESTED-TAG');
  await stageMove(page, 'C0A1-0001');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Review 1 device update' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Continue to confirmation' }).click();
  await page.getByRole('checkbox', { name: /I reviewed all 1 device/ }).check();
  await page.getByRole('button', { name: 'Create update job' }).click();
  await expect(
    page.getByRole('heading', { name: 'Update job created' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.waitForTimeout(300);

  // The worker applies the Asset tag and Google returns a different Move value.
  sim.settle();
  sim.change('d0', 'orgUnitPath', '/Chrome Devices/Google normalized unit');
  const failed = sim.jobDetail();
  failed.status = 'failed';
  failed.progress.succeeded = 0;
  failed.progress.failed = 1;
  failed.latestActivity.failed = {
    count: 1,
    operations: [
      {
        operationId: 'UPD-006-1-annotatedAssetId',
        deviceId: 'd0',
        serialNumber: 'C0A1-0001',
        outcomeReason: 'value-differs',
        googleStatus: 200,
        googleReason: null,
        updatedAt: '2026-10-21T18:03:02.000Z',
      },
    ],
  };
  await page.route(`**/api/jobs/${jobDisplayId}`, (route) =>
    route.fulfill({ json: failed }),
  );
  if (read === 'failed')
    await page.route('**/api/devices/by-ids', (route) =>
      route.fulfill({ status: 503, json: { code: 'network-failure' } }),
    );
  else
    await page.route('**/api/devices/by-ids', (route) =>
      route.fulfill({ json: { rows: [] } }),
    );
  const readDone = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/devices/by-ids',
  );
  await emitJobChanged(page);
  await readDone;
}

for (const read of ['failed', 'missing'] as const) {
  test(`a value-differs failed job keeps its written value when the row read is ${read} (B4)`, async ({
    page,
  }) => {
    const sim = new SaveChangesSimulator(seedDevices());
    await settlePartialValueDiffers(page, sim, read);
    const tag = cell(page, 'C0A1-0001', 'assetTag');

    // Zero succeeded operations do not prove that Google wrote nothing: the Asset tag
    // holds its request even though the operation failed on the normalized Move value.
    await expect(tag.locator('.device-cell-value')).toHaveText(
      'REQUESTED-TAG',
      {
        timeout: 2000,
      },
    );
    await expect(tag.locator('.cell-state.accepted')).toBeVisible();
    await screenshot(page, `save-changes-12-value-differs-${read}.png`);

    // The next authoritative read proves the partial write and settles the mark.
    await page.unroute('**/api/devices/by-ids');
    const recovered = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/devices/by-ids',
    );
    await emitJobChanged(page);
    await recovered;
    await expect(tag.locator('.cell-state.accepted')).toHaveCount(0, {
      timeout: 2000,
    });
    await expect(tag.locator('.device-cell-value')).toHaveText('REQUESTED-TAG');
    await screenshot(
      page,
      `save-changes-12-value-differs-${read}-recovered.png`,
    );
  });
}

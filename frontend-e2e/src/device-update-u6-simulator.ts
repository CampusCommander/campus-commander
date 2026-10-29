import type {
  DevicePredicate,
  DeviceRow,
  DeviceUpdateChange,
  DeviceUpdateJobReceipt,
  DeviceUpdatePreview,
  DeviceUpdateTarget,
  JobDetail,
} from '@campus/application-contracts';
import {
  devicePageSchema,
  deviceUpdateChangesInOrder,
  deviceUpdateJobReceiptSchema,
  deviceUpdatePreviewSchema,
  deviceUpdateTargetSchema,
  jobDetailSchema,
} from '@campus/application-contracts';
// The Chromium completion checks must count eligibility with the production U6 calculation,
// not a copy that can drift from it. The simulator is test-only and never ships.
// eslint-disable-next-line @nx/enforce-module-boundaries
import {
  manifestDigest,
  previewTargets,
  type PreviewTarget,
} from '../../api/src/app/devices/device-updates';

/**
 * A simulated U6 answer source for the Chromium completion checks. The preview eligibility,
 * the per-field rows, the counts, and the manifest digest come from the production U6
 * functions in `api/src/app/devices/device-updates.ts`, so a fixture cannot assume that
 * every device changes every field. Google and PostgreSQL stay simulated: the provider
 * applies an eligible write when the test settles the job.
 */
export interface SimulatedDevice {
  serialNumber: string;
  annotatedLocation: string | null;
  annotatedUser: string | null;
  notes: string | null;
  /**
   * The organization unit of the device. A Move changes it, and the grid reads it back.
   * Defaults to the observed unit of the F2 fixture.
   */
  orgUnitPath?: string;
  /** The device left the inventory after the selection; U6 freezes it as an exclusion. */
  removed?: boolean;
}

const observedAt = '2026-10-21T12:00:00.000Z';
const orgUnitPath = '/Chrome Devices/Lowell Academy/One to One';

/** The scope that the organization unit read mints (design section 6). */
export const ORG_UNIT_SCOPE =
  'https://www.googleapis.com/auth/admin.directory.orgunit.readonly';

/** The tree of `GET /api/devices/updates/org-units` while Google grants the read. */
export const orgUnitTree = {
  state: 'granted' as const,
  scope: ORG_UNIT_SCOPE,
  failure: null,
  orgUnits: [
    {
      orgUnitId: 'ou-root',
      name: 'example.org',
      orgUnitPath: '/',
      parentOrgUnitId: null,
    },
    {
      orgUnitId: 'ou-chrome',
      name: 'Chrome Devices',
      orgUnitPath: '/Chrome Devices',
      parentOrgUnitId: 'ou-root',
    },
    {
      orgUnitId: 'ou-lowell',
      name: 'Lowell Academy',
      orgUnitPath: '/Chrome Devices/Lowell Academy',
      parentOrgUnitId: 'ou-chrome',
    },
    {
      orgUnitId: 'ou-lowell-one',
      name: 'One to One',
      orgUnitPath: '/Chrome Devices/Lowell Academy/One to One',
      parentOrgUnitId: 'ou-lowell',
    },
    {
      orgUnitId: 'ou-cart',
      name: 'Cart Devices',
      orgUnitPath: '/Chrome Devices/Cart Devices',
      parentOrgUnitId: 'ou-chrome',
    },
  ],
  observedAt,
};

/** The answer without the read scope (PNG 05): no tree, one failure, one scope to add. */
export const deniedOrgUnitTree = {
  state: 'denied' as const,
  scope: ORG_UNIT_SCOPE,
  failure: 'scope-mismatch' as const,
  orgUnits: null,
  observedAt,
};

export class U6Simulator {
  readonly previewId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  readonly previewDisplayId = 'PV-009';
  readonly jobId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  readonly jobDisplayId = 'UPD-007';
  private readonly devices: SimulatedDevice[];
  private changes: DeviceUpdateChange[] = [];
  private frozen: PreviewTarget[] = [];
  private preview: DeviceUpdatePreview | null = null;
  private jobStatus: 'accepted' | 'completed' = 'accepted';

  constructor(devices: SimulatedDevice[]) {
    this.devices = devices.map((device) => ({ ...device }));
  }

  /** Freeze a preview with the production U6 target calculation. */
  prepare(changes: DeviceUpdateChange[]): DeviceUpdatePreview {
    this.changes = deviceUpdateChangesInOrder(changes);
    this.jobStatus = 'accepted';
    this.frozen = previewTargets(
      this.devices.map((device, index) => ({
        device_id: this.deviceId(index),
        serial_number: device.serialNumber,
        org_unit_path: device.orgUnitPath ?? orgUnitPath,
        annotated_location: device.annotatedLocation,
        annotated_user: device.annotatedUser,
        notes: device.notes,
        removed_at: device.removed ? observedAt : null,
        last_entity_sync: observedAt,
      })),
      this.changes,
    );
    const eligible = this.count('eligible');
    const unchanged = this.count('unchanged');
    const excluded = this.count('excluded');
    const fieldChanges = this.frozen.reduce(
      (total, target) =>
        total +
        target.fields.filter((field) => field.disposition === 'eligible')
          .length,
      0,
    );
    this.preview = deviceUpdatePreviewSchema.parse({
      previewId: this.previewId,
      displayId: this.previewDisplayId,
      changes: this.changes,
      fieldChanges,
      selected: this.frozen.length,
      eligible,
      unchanged,
      excluded,
      // No conflict arises until the fresh read of the edit route compares baselines.
      conflicts: 0,
      oldestObservedAt: observedAt,
      stale: false,
      preparedAt: '2026-10-21T18:02:00.000Z',
      // The checks run well inside the 15-minute window.
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      manifestDigest: manifestDigest(this.frozen),
    });
    return this.preview;
  }

  current(): DeviceUpdatePreview {
    if (!this.preview) throw new Error('No preview is prepared.');
    return this.preview;
  }

  /** One frozen row per device and change, in contract order. */
  targets(): DeviceUpdateTarget[] {
    return deviceUpdateTargetSchema.array().parse(
      this.frozen.flatMap((target) =>
        target.fields.map((field) => ({
          deviceId: target.deviceId,
          serialNumber: target.serialNumber,
          field: field.field,
          observedValue: field.observedValue,
          baselineValue: field.observedValue,
          approvedValue:
            target.disposition === 'excluded'
              ? null
              : this.value(
                  this.changes.find((change) => change.field === field.field)!,
                ),
          duplicateSerialNumber: null,
          disposition: field.disposition,
          exclusionReason: target.exclusionReason,
        })),
      ),
    );
  }

  /** The receipt of the confirmation. One operation per eligible device. */
  confirm(): DeviceUpdateJobReceipt {
    const devices = this.count('eligible');
    return deviceUpdateJobReceiptSchema.parse({
      jobId: this.jobId,
      displayId: this.jobDisplayId,
      status: 'accepted',
      deviceCount: devices,
      updateCount: devices,
    });
  }

  /**
   * Apply every eligible field row, as the worker's read-back does after Google accepts the
   * PATCH. Returns the device IDs that the server would publish in `entity-batch`.
   */
  settle(): string[] {
    const changed: string[] = [];
    for (const target of this.frozen) {
      if (target.disposition !== 'eligible') continue;
      changed.push(target.deviceId);
      for (const field of target.fields) {
        if (field.disposition !== 'eligible') continue;
        const change = this.changes.find(
          (candidate) => candidate.field === field.field,
        )!;
        const value = this.value(change);
        const device = this.devices[this.indexOf(target.deviceId)]!;
        // A Move rewrites the organization unit; the grid reads the new path back.
        if (field.field === 'orgUnitPath') {
          if (value !== null) device.orgUnitPath = value;
          continue;
        }
        device[field.field] = value;
      }
    }
    this.jobStatus = 'completed';
    return changed;
  }

  /** The durable job answer of `/api/jobs/UPD-007`. */
  jobDetail(): JobDetail {
    const devices = this.count('eligible');
    const done = this.jobStatus === 'completed';
    const total = devices;
    return jobDetailSchema.parse({
      jobId: this.jobId,
      displayId: this.jobDisplayId,
      revision: done ? 2 : 1,
      action: 'update-device-annotations',
      status: this.jobStatus,
      scope: { kind: 'devices', deviceCount: total },
      requestedBy: {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        displayName: 'District operator',
      },
      createdAt: '2026-10-21T18:03:00.000Z',
      startedAt: '2026-10-21T18:03:01.000Z',
      finishedAt: done ? '2026-10-21T18:03:02.000Z' : null,
      progress: {
        total,
        succeeded: done ? total : 0,
        failed: 0,
        unknown: 0,
        skipped: 0,
        expired: 0,
        cancelled: 0,
        pending: done ? 0 : total,
      },
      cancelRequest: null,
      failure: null,
      confirmedBy: {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        displayName: 'District operator',
      },
      previewDisplayId: this.previewDisplayId,
      changes: this.changes.length ? this.changes : null,
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
    });
  }

  /** The grid page of the current inventory, after any settlement. */
  page(predicates: readonly DevicePredicate[] = []) {
    const rows = this.rows().filter((row) => this.matches(row, predicates));
    return devicePageSchema.parse({
      rows,
      matching: rows.length,
      total: this.devices.length,
      observedAt,
      refreshJobId: null,
    });
  }

  rows(): DeviceRow[] {
    return this.devices.map((device, index) => ({
      deviceId: this.deviceId(index),
      serialNumber: device.serialNumber,
      model: 'Dell Chromebook 3100',
      assetTag: `CB66246${index}`,
      orgUnitPath: device.orgUnitPath ?? orgUnitPath,
      lastContact: '2026-10-21T11:58:00Z',
      annotatedLocation: device.annotatedLocation,
      annotatedUser: device.annotatedUser,
      notes: device.notes,
      status: 'ACTIVE',
      battery: {
        status: 'reported',
        health: 'normal',
        capacityPercent: 91,
        reportedAt: '2026-10-21T11:00:00Z',
      },
      lastEntitySync: observedAt,
      stale: false,
    }));
  }

  /** The organization unit filter matches the chosen subtrees (section 2). */
  private matches(row: DeviceRow, predicates: readonly DevicePredicate[]) {
    return predicates.every((predicate) => {
      if (predicate.field !== 'orgUnitPath') return true;
      const values = 'values' in predicate ? predicate.values : [];
      const path = row.orgUnitPath.toLowerCase();
      return values.some((value) => {
        const unit = value.toLowerCase().replace(/\/+$/, '');
        return path === unit || path.startsWith(`${unit}/`);
      });
    });
  }

  byIds(ids: readonly string[]): DeviceRow[] {
    const wanted = new Set(ids);
    return this.rows().filter((row) => wanted.has(row.deviceId));
  }

  private count(disposition: PreviewTarget['disposition']): number {
    return this.frozen.filter((target) => target.disposition === disposition)
      .length;
  }

  private value(change: DeviceUpdateChange): string | null {
    return change.mode === 'clear' ? null : (change.value ?? null);
  }

  private deviceId(index: number): string {
    return `synthetic-device-${index + 1}`;
  }

  private indexOf(deviceId: string): number {
    return Number(deviceId.replace('synthetic-device-', '')) - 1;
  }
}

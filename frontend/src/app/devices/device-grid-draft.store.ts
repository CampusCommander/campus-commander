import {
  Injectable,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { z } from 'zod';
import {
  DEVICE_BY_IDS_LIMIT,
  DEVICE_UPDATE_FIELD_LABELS,
  DEVICE_UPDATE_FIELD_LIMITS,
  DEVICE_UPDATE_FIELD_ORDER,
  deviceRowsSchema,
  deviceUpdateFieldSchema,
  deviceUpdateModeSchema,
  jobDetailSchema,
  type DeviceRow,
  type DeviceUpdateEdit,
  type DeviceUpdateField,
  type DeviceUpdateMode,
  type DeviceUpdateTarget,
  type JobDetail,
  type JobStatus,
} from '@campus/application-contracts';
import { AuthStore } from '../auth.store';
import type { OrgUnitTreeRow } from './device-org-unit-tree.store';
import { readDraftPart, writeDraftPart } from './device-draft-storage';
import {
  deviceCountText,
  deviceUpdateValueError,
} from './device-update-messages';

/** The grid draft holds at most one entry per device and field (addendum section 5). */
export type DeviceGridDraftState =
  | 'pending'
  | 'invalid'
  | 'conflict'
  | 'excluded';

export interface DeviceGridDraftEntry {
  deviceId: string;
  /** The readable device name that the panel and the cell actions use. */
  serialNumber: string;
  field: DeviceUpdateField;
  mode: DeviceUpdateMode;
  /** The requested text. A Clear carries an empty string. */
  value: string;
  /** The value that the person saw when the edit began. */
  baseline: string | null;
  /** The destination unit of a Move. */
  orgUnitId: string | null;
  state: DeviceGridDraftState;
  /** The current Google value of a conflict entry. */
  currentValue?: string | null;
  /** Why Google cannot write an excluded entry, such as `removed`. */
  exclusionReason?: string;
}

/**
 * The value of one accepted cell (mockup state 09, design gap 2). The job holds the row, so
 * the cell shows the accepted value with a clock until the job's own record arrives. An
 * accepted cell is not a draft entry: rollback never reverses a provider effect (DRAFT-02).
 */
export interface DeviceGridAcceptedEntry {
  deviceId: string;
  field: DeviceUpdateField;
  mode: DeviceUpdateMode;
  /** The approved value that the job will write. A Clear carries an empty string. */
  value: string;
  /** The job that accepted the row. */
  displayId: string;
}

/** One open editor. Its changed input counts as a pending change (mockup choice 5). */
export interface DeviceGridLiveEdit {
  deviceId: string;
  serialNumber: string;
  field: DeviceUpdateField;
  baseline: string | null;
  value: string;
}

export interface DeviceGridDraftCounts {
  changes: number;
  devices: number;
}

export type DeviceGridStageResult =
  | { ok: true; removed: boolean }
  | { ok: false; reason: 'device-limit' };

/**
 * One stored entry. The text values carry no length cap: an invalid edit still has to
 * round-trip through storage so the person can correct it (B2). `gridDraftReason` applies
 * the field limit when the value restores.
 */
const entrySchema = z.strictObject({
  deviceId: z.string().min(1).max(128),
  serialNumber: z.string().max(256),
  field: deviceUpdateFieldSchema,
  mode: deviceUpdateModeSchema,
  value: z.string(),
  baseline: z.string().nullable(),
  orgUnitId: z.string().min(1).max(128).nullable(),
  state: z.enum(['pending', 'invalid', 'conflict', 'excluded']),
  currentValue: z.string().nullable().optional(),
  exclusionReason: z.string().max(64).optional(),
});

/** The outer shape only. Each entry validates alone, so one bad entry keeps the rest. */
const gridPartSchema = z.object({ entries: z.array(z.unknown()) });

export const DEVICE_GRID_DRAFT_STORAGE_ERROR =
  'This tab cannot restore the grid draft. Check each changed cell before you save.';

/** The restore line for entries that failed validation. Zero answers an empty string. */
export function gridDraftRestoreError(skipped: number): string {
  if (skipped < 1) return '';
  return `${skipped} ${skipped === 1 ? 'change' : 'changes'} did not restore from this tab. Check each changed cell before you save.`;
}
export const DEVICE_GRID_DRAFT_WRITE_ERROR =
  'Tab storage is unavailable. Keep this page open until you save the grid draft.';
export const DEVICE_GRID_DRAFT_DEVICE_LIMIT_MESSAGE = `The draft holds at most ${DEVICE_BY_IDS_LIMIT} devices. Revert a change before you edit another device.`;

function keyOf(entry: { deviceId: string; field: DeviceUpdateField }): string {
  return `${entry.deviceId}\u0000${entry.field}`;
}

function requestOf(mode: DeviceUpdateMode, value: string): string | null {
  return mode === 'clear' ? null : value;
}

/** A Clear on an empty field changes nothing, and paths compare without case. */
function sameRequest(
  field: DeviceUpdateField,
  request: string | null,
  baseline: string | null,
): boolean {
  const seen = baseline === '' ? null : baseline;
  if (field === 'orgUnitPath')
    return (request ?? '').toLowerCase() === (seen ?? '').toLowerCase();
  return request === seen;
}

/** The job statuses that no longer change a device row. */
const TERMINAL_JOB_STATUSES: ReadonlySet<JobStatus> = new Set<JobStatus>([
  'completed',
  'completed-with-errors',
  'failed',
  'needs-review',
]);

/**
 * True when the authoritative row holds the accepted request. A matching row is success
 * evidence: the worker publishes inventory IDs only after a value reaches Google (B4). A
 * row without the field proves nothing and never settles the cell.
 */
export function rowHoldsRequest(
  entry: Pick<DeviceGridAcceptedEntry, 'field' | 'mode' | 'value'>,
  row: Partial<DeviceValueRow>,
): boolean {
  if (!(entry.field in row)) return false;
  return sameRequest(
    entry.field,
    requestOf(entry.mode, entry.value),
    rowValueFor(row as DeviceValueRow, entry.field),
  );
}

/** A refresh row that the grid applies. A partial row settles nothing it does not carry. */
export type DeviceSettledRow = Pick<DeviceRow, 'deviceId'> &
  Partial<DeviceValueRow>;

/** The key that identifies one accepted operation, so a late answer removes only its row. */
function acceptedKey(entry: DeviceGridAcceptedEntry): string {
  return `${keyOf(entry)}\u0000${entry.displayId}\u0000${entry.mode}\u0000${entry.value}`;
}

/** The mode that an emptied in-cell editor stages (addendum section 5). */
export function modeForText(
  field: DeviceUpdateField,
  value: string,
): DeviceUpdateMode {
  // Asset tag offers Replace only, so an empty tag stays an invalid Replace.
  return field !== 'annotatedAssetId' && value === '' ? 'clear' : 'replace';
}

/** The row fields that an editable cell shows. */
export type DeviceValueRow = Pick<
  DeviceRow,
  'assetTag' | 'orgUnitPath' | 'annotatedLocation' | 'annotatedUser' | 'notes'
>;

/** The value of this field in the row, as the person saw it. */
export function rowValueFor(
  row: DeviceValueRow,
  field: DeviceUpdateField,
): string | null {
  switch (field) {
    case 'annotatedAssetId':
      return row.assetTag;
    case 'orgUnitPath':
      return row.orgUnitPath;
    case 'annotatedLocation':
      return row.annotatedLocation;
    case 'annotatedUser':
      return row.annotatedUser;
    case 'notes':
      return row.notes;
  }
}

/**
 * The baseline of an edit. A missing entry takes the row value. An entry keeps its stored
 * baseline, including a valid null (B1).
 */
export function baselineFor(
  entry: Pick<DeviceGridDraftEntry, 'baseline'> | null,
  row: DeviceValueRow,
  field: DeviceUpdateField,
): string | null {
  return entry ? entry.baseline : rowValueFor(row, field);
}

/** Why an entry cannot be saved, or null when it can. */
export function gridDraftReason(
  entry: Pick<DeviceGridDraftEntry, 'field' | 'mode' | 'value' | 'orgUnitId'>,
): string | null {
  if (entry.field === 'orgUnitPath') {
    const limit = DEVICE_UPDATE_FIELD_LIMITS.orgUnitPath;
    if (!entry.orgUnitId) return 'Organization unit needs a chosen unit.';
    if (
      entry.value.length < 1 ||
      entry.value.length > limit ||
      !entry.value.startsWith('/')
    )
      return `Organization unit needs a path that starts with / and holds at most ${limit} characters.`;
    return null;
  }
  // Clear value is a valid change: the field ends empty by design.
  if (entry.mode === 'clear') return null;
  return deviceUpdateValueError(entry.field, entry.value);
}

function restoredEntry(
  entry: z.infer<typeof entrySchema>,
): DeviceGridDraftEntry {
  const reason = gridDraftReason(entry);
  // A stored current value is unresolved conflict evidence. Keep it through invalid input
  // so a correction returns the entry to conflict (B3).
  const state: DeviceGridDraftState = reason
    ? 'invalid'
    : entry.currentValue !== undefined
      ? 'conflict'
      : entry.exclusionReason !== undefined
        ? 'excluded'
        : 'pending';
  return {
    deviceId: entry.deviceId,
    serialNumber: entry.serialNumber,
    field: entry.field,
    mode: entry.mode,
    value: entry.value,
    baseline: entry.baseline,
    orgUnitId: entry.orgUnitId,
    state,
    ...(entry.currentValue !== undefined
      ? { currentValue: entry.currentValue }
      : {}),
    ...(entry.exclusionReason !== undefined
      ? { exclusionReason: entry.exclusionReason }
      : {}),
  };
}

/**
 * The unsubmitted grid draft (addendum section 5, DRAFT-01, DRAFT-02).
 *
 * Entries live outside the grid row cache, so refresh, paging, sorting, and SSE updates
 * never touch them. The store writes only the `grid` part of the tab document; the sheet
 * and single-device drafts keep their own parts.
 */
@Injectable({ providedIn: 'root' })
export class DeviceGridDraftStore {
  private readonly auth = inject(AuthStore);
  private readonly entriesSignal = signal<DeviceGridDraftEntry[]>([]);
  private readonly acceptedSignal = signal<DeviceGridAcceptedEntry[]>([]);
  private readonly liveSignal = signal<DeviceGridLiveEdit | null>(null);
  private readonly refusalSignal = signal('');
  private readonly restoreErrorSignal = signal('');
  private readonly writeErrorSignal = signal('');
  /** A restore warning stays until the next restore, so one write never hides lost entries. */
  readonly storageError = computed(
    () => this.restoreErrorSignal() || this.writeErrorSignal(),
  );
  private principal = this.auth.session()?.identity.id ?? null;
  /** One reconcile runs at a time; a row event during it asks for one more pass. */
  private reconciling = false;
  private reconciled = false;
  /** A restore or principal change invalidates an answer that is still in flight. */
  private acceptedEpoch = 0;

  readonly entries = computed(() => this.entriesSignal());
  readonly accepted = computed(() => this.acceptedSignal());
  readonly live = computed(() => this.liveSignal());
  readonly refusal = computed(() => this.refusalSignal());

  constructor() {
    this.restore();
    effect(() => {
      const id = this.auth.session()?.identity.id ?? null;
      if (id === this.principal) return;
      untracked(() => this.restore());
    });
  }

  entryFor(
    deviceId: string,
    field: DeviceUpdateField,
  ): DeviceGridDraftEntry | null {
    return (
      this.entriesSignal().find(
        (entry) => entry.deviceId === deviceId && entry.field === field,
      ) ?? null
    );
  }

  /**
   * The cell value: the pending value over the row value. An accepted value covers the row
   * until the job's own record arrives.
   */
  valueFor(
    deviceId: string,
    field: DeviceUpdateField,
    rowValue: string,
  ): string {
    const entry = this.entryFor(deviceId, field);
    if (entry) return entry.mode === 'clear' ? '' : entry.value;
    const accepted = this.acceptedFor(deviceId, field);
    if (accepted) return accepted.mode === 'clear' ? '' : accepted.value;
    return rowValue;
  }

  /** The accepted value of one cell, or null. */
  acceptedFor(
    deviceId: string,
    field: DeviceUpdateField,
  ): DeviceGridAcceptedEntry | null {
    return (
      this.acceptedSignal().find(
        (entry) => entry.deviceId === deviceId && entry.field === field,
      ) ?? null
    );
  }

  /** Drop the accepted values that authoritative rows prove settled (B4). */
  settleAccepted(rows: readonly DeviceSettledRow[]): void {
    if (!this.acceptedSignal().length || !rows.length) return;
    const held = new Map(rows.map((row) => [row.deviceId, row]));
    const remaining = this.acceptedSignal().filter((entry) => {
      const row = held.get(entry.deviceId);
      return !row || !rowHoldsRequest(entry, row);
    });
    if (remaining.length !== this.acceptedSignal().length)
      this.acceptedSignal.set(remaining);
    // A row can arrive before the owning job finishes. The job read decides the rest.
    if (remaining.length) void this.reconcileAccepted();
  }

  /**
   * Reconcile accepted cells with the owning job and the authoritative device rows (B4).
   *
   * A row that holds the request settles the cell. A job that reached a terminal status
   * without the value settles the cell too, because the worker publishes only successful
   * writes. A job that still runs keeps the mark, so an unrelated refresh never erases it.
   * Reads every accepted device, so a cell outside the refreshed page settles as well.
   */
  async reconcileAccepted(job?: JobDetail): Promise<void> {
    if (!this.acceptedSignal().length) return;
    if (this.reconciling) {
      this.reconciled = true;
      return;
    }
    this.reconciling = true;
    const principal = this.auth.session()?.identity.id ?? null;
    const epoch = this.acceptedEpoch;
    const current = () =>
      epoch === this.acceptedEpoch &&
      (this.auth.session()?.identity.id ?? null) === principal;
    try {
      const ids = [
        ...new Set(this.acceptedSignal().map((entry) => entry.displayId)),
      ];
      const jobs = new Map<string, JobDetail | null>();
      if (job && ids.includes(job.displayId)) jobs.set(job.displayId, job);
      for (const displayId of ids) {
        if (jobs.has(displayId)) continue;
        jobs.set(displayId, await this.readJob(displayId));
        if (!current()) return;
      }
      const deviceIds = [
        ...new Set(this.acceptedSignal().map((entry) => entry.deviceId)),
      ].slice(0, DEVICE_BY_IDS_LIMIT);
      const rows = await this.readRows(deviceIds);
      if (!current()) return;
      const byId = new Map((rows ?? []).map((row) => [row.deviceId, row]));
      const settled = new Set<string>();
      for (const entry of this.acceptedSignal()) {
        const row = byId.get(entry.deviceId);
        if (row && rowHoldsRequest(entry, row)) {
          settled.add(acceptedKey(entry));
          continue;
        }
        const detail = jobs.get(entry.displayId);
        // A failed read of the job keeps the mark: it proves nothing about the write.
        if (detail && TERMINAL_JOB_STATUSES.has(detail.status))
          settled.add(acceptedKey(entry));
      }
      if (settled.size)
        this.acceptedSignal.set(
          this.acceptedSignal().filter(
            (entry) => !settled.has(acceptedKey(entry)),
          ),
        );
    } finally {
      this.reconciling = false;
      if (this.reconciled) {
        this.reconciled = false;
        void this.reconcileAccepted();
      }
    }
  }

  private async readJob(displayId: string): Promise<JobDetail | null> {
    try {
      const response = await this.auth.request(
        `/api/jobs/${encodeURIComponent(displayId)}`,
      );
      if (!response.ok) return null;
      const parsed = jobDetailSchema.safeParse(
        await response.json().catch(() => null),
      );
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private async readRows(ids: readonly string[]): Promise<DeviceRow[] | null> {
    if (!ids.length) return [];
    try {
      const response = await this.auth.request('/api/devices/by-ids', {
        deviceIds: [...ids],
      });
      if (!response.ok) return null;
      const body: unknown = await response.json().catch(() => null);
      if (!body || typeof body !== 'object' || !('rows' in body)) return null;
      const parsed = deviceRowsSchema.safeParse(
        (body as { rows: unknown }).rows,
      );
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /**
   * The baseline of an edit of a row. A draft entry keeps its stored baseline. An accepted
   * value is what the person sees, so a later edit stages against it and never loses input
   * (B7).
   */
  baselineForRow(row: DeviceRow, field: DeviceUpdateField): string | null {
    const entry = this.entryFor(row.deviceId, field);
    if (entry) return entry.baseline;
    const accepted = this.acceptedFor(row.deviceId, field);
    if (accepted) return accepted.mode === 'clear' ? '' : accepted.value;
    return rowValueFor(row, field);
  }

  /** The reason that the entry cannot be saved, or an empty string. */
  reasonFor(entry: DeviceGridDraftEntry): string {
    return gridDraftReason(entry) ?? '';
  }

  /**
   * Count entries and their devices. An open editor counts when its input differs from the
   * baseline, and removes its entry's count when the input returns to the baseline
   * (mockup choice 5).
   */
  readonly counts = computed<DeviceGridDraftCounts>(() => {
    const effective = new Map<string, string>();
    for (const entry of this.entriesSignal())
      effective.set(keyOf(entry), entry.deviceId);
    const live = this.liveSignal();
    if (live) {
      const mode = modeForText(live.field, live.value);
      const changed = !sameRequest(
        live.field,
        requestOf(mode, live.value),
        live.baseline,
      );
      if (changed) effective.set(keyOf(live), live.deviceId);
      else effective.delete(keyOf(live));
    }
    return {
      changes: effective.size,
      devices: new Set(effective.values()).size,
    };
  });

  readonly countLine = computed(() => {
    const { changes, devices } = this.counts();
    return `${changes} pending ${changes === 1 ? 'change' : 'changes'} · ${deviceCountText(devices)}`;
  });

  /** At least one entry blocks Save changes (DRAFT-02). */
  readonly blocked = computed(() =>
    this.entriesSignal().some((entry) => entry.state !== 'pending'),
  );

  readonly visible = computed(() => this.counts().changes > 0);

  /** The panel shows its count or a restore error, so zero restored entries still report. */
  readonly panelVisible = computed(
    () => this.counts().changes > 0 || this.storageError() !== '',
  );

  /** The panel's second line: the reason or the active editing hint. */
  readonly line = computed<{ text: string; tone: 'error' | 'warning' | '' }>(
    () => {
      if (this.refusalSignal())
        return { text: this.refusalSignal(), tone: 'error' };
      if (this.storageError())
        return { text: this.storageError(), tone: 'error' };
      const entries = this.entriesSignal();
      const invalid = entries.filter((entry) => entry.state === 'invalid');
      if (invalid.length) {
        const first = invalid[0];
        return {
          text: `${invalid.length} ${invalid.length === 1 ? 'change' : 'changes'} cannot be saved. ${first.serialNumber} · ${this.reasonFor(first)}`,
          tone: 'error',
        };
      }
      const conflicts = entries.filter((entry) => entry.state === 'conflict');
      if (conflicts.length) {
        const first = conflicts[0];
        return {
          text: `${conflicts.length} ${conflicts.length === 1 ? 'conflict' : 'conflicts'}. ${DEVICE_UPDATE_FIELD_LABELS[first.field]} of ${first.serialNumber} changed in Google after your edit. Resolve ${conflicts.length === 1 ? 'it' : 'them'} to save.`,
          tone: 'warning',
        };
      }
      const live = this.liveSignal();
      if (live)
        return {
          text: `Editing ${DEVICE_UPDATE_FIELD_LABELS[live.field].toLowerCase()} · Enter or Tab stages this value · Escape cancels`,
          tone: '',
        };
      return { text: '', tone: '' };
    },
  );

  /** Start an editor. Its changed input counts before the value is staged. */
  beginLive(edit: DeviceGridLiveEdit): void {
    this.refusalSignal.set('');
    this.liveSignal.set(edit);
  }

  updateLive(value: string): void {
    const live = this.liveSignal();
    if (!live) return;
    this.liveSignal.set({ ...live, value });
  }

  endLive(): void {
    this.liveSignal.set(null);
  }

  /** Stage one edited text cell. An emptied text field stages Clear value. */
  stageText(
    row: DeviceRow,
    field: DeviceUpdateField,
    value: string,
  ): DeviceGridStageResult {
    return this.stage({
      deviceId: row.deviceId,
      serialNumber: row.serialNumber,
      field,
      mode: modeForText(field, value),
      value,
      baseline: this.baselineForRow(row, field),
      orgUnitId: null,
    });
  }

  /** Stage the destination that the picker returned (Move only). */
  stageMove(
    row: DeviceRow,
    unit: Pick<OrgUnitTreeRow, 'id' | 'path'>,
  ): DeviceGridStageResult {
    return this.stage({
      deviceId: row.deviceId,
      serialNumber: row.serialNumber,
      field: 'orgUnitPath',
      mode: 'move',
      value: unit.path,
      baseline: this.baselineForRow(row, 'orgUnitPath'),
      orgUnitId: unit.id,
    });
  }

  /**
   * Stage one value. A value equal to its baseline removes the entry. A new device beyond
   * the 500-device limit is refused and the panel names the limit.
   */
  stage(input: {
    deviceId: string;
    serialNumber: string;
    field: DeviceUpdateField;
    mode: DeviceUpdateMode;
    value: string;
    baseline: string | null;
    orgUnitId: string | null;
  }): DeviceGridStageResult {
    this.refusalSignal.set('');
    const baseline = input.baseline === '' ? null : input.baseline;
    const value = input.mode === 'clear' ? '' : input.value;
    const existing = this.entryFor(input.deviceId, input.field);
    if (sameRequest(input.field, requestOf(input.mode, value), baseline)) {
      if (existing) this.removeEntry(existing);
      return { ok: true, removed: true };
    }
    const devices = new Set(
      this.entriesSignal().map((entry) => entry.deviceId),
    );
    if (!devices.has(input.deviceId) && devices.size >= DEVICE_BY_IDS_LIMIT) {
      this.refusalSignal.set(DEVICE_GRID_DRAFT_DEVICE_LIMIT_MESSAGE);
      return { ok: false, reason: 'device-limit' };
    }
    const entry: DeviceGridDraftEntry = {
      deviceId: input.deviceId,
      serialNumber: input.serialNumber,
      field: input.field,
      mode: input.mode,
      value,
      baseline,
      orgUnitId: input.mode === 'move' ? input.orgUnitId : null,
      // A new value never clears a conflict without the person's answer. The stored
      // current value keeps that evidence through invalid input (B3).
      state: existing?.currentValue !== undefined ? 'conflict' : 'pending',
      ...(existing?.currentValue !== undefined
        ? { currentValue: existing.currentValue }
        : {}),
    };
    if (gridDraftReason(entry)) entry.state = 'invalid';
    this.upsert(entry);
    return { ok: true, removed: false };
  }

  revert(deviceId: string, field: DeviceUpdateField): void {
    const entry = this.entryFor(deviceId, field);
    if (!entry) return;
    this.refusalSignal.set('');
    this.removeEntry(entry);
  }

  /** Revert all changes. The panel asks once before it calls this. */
  revertAll(): void {
    this.refusalSignal.set('');
    // The part is about to be removed, so an earlier restore warning no longer applies.
    this.restoreErrorSignal.set('');
    this.liveSignal.set(null);
    this.entriesSignal.set([]);
    this.persist();
  }

  /** Mark an entry as a conflict (the preview in IF3 supplies the current value). */
  markConflict(
    deviceId: string,
    field: DeviceUpdateField,
    currentValue: string | null,
  ): void {
    const entry = this.entryFor(deviceId, field);
    if (!entry) return;
    this.upsert({ ...entry, state: 'conflict', currentValue });
  }

  /** Mark an entry whose device Google cannot write (addendum section 5). */
  markExcluded(
    deviceId: string,
    field: DeviceUpdateField,
    reason: string | null,
  ): void {
    const entry = this.entryFor(deviceId, field);
    if (!entry) return;
    const next: DeviceGridDraftEntry = {
      ...entry,
      state: 'excluded',
      ...(reason ? { exclusionReason: reason } : {}),
    };
    delete next.currentValue;
    this.upsert(next);
  }

  /**
   * Mark the cells of a frozen preview: a conflict row carries the current value, an
   * excluded row names why Google cannot write it. An unchanged row leaves the draft,
   * because Google already holds the value (addendum section 3), unless a later edit
   * replaced the submitted request.
   */
  applyPreview(
    targets: readonly DeviceUpdateTarget[],
    submitted: readonly DeviceUpdateEdit[] = [],
  ): void {
    const edits = new Map(
      submitted.map((edit) => [keyOf(edit), edit] as const),
    );
    const unchanged: DeviceUpdateTarget[] = [];
    for (const target of targets) {
      if (target.disposition === 'conflict')
        this.markConflict(target.deviceId, target.field, target.observedValue);
      else if (target.disposition === 'excluded')
        this.markExcluded(
          target.deviceId,
          target.field,
          target.exclusionReason,
        );
      else if (target.disposition === 'unchanged') unchanged.push(target);
    }
    if (unchanged.length) this.dropUnchanged(unchanged, edits);
  }

  /**
   * Remove the submitted entries that an unchanged answer settles. Only an entry that still
   * holds the submitted request leaves, so a later edit stays (B2).
   */
  dropSubmitted(edits: readonly DeviceUpdateEdit[]): void {
    const submitted = new Map(
      edits.map((edit) => [keyOf(edit), edit] as const),
    );
    this.removeSubmitted(
      submitted,
      edits.map((edit) => keyOf(edit)),
    );
  }

  private dropUnchanged(
    targets: readonly DeviceUpdateTarget[],
    edits: ReadonlyMap<string, DeviceUpdateEdit>,
  ): void {
    this.removeSubmitted(
      edits,
      targets.map((target) => keyOf(target)),
    );
  }

  private removeSubmitted(
    edits: ReadonlyMap<string, DeviceUpdateEdit>,
    keys: readonly string[],
  ): void {
    const settled = new Set(keys);
    const remaining = this.entriesSignal().filter((entry) => {
      const key = keyOf(entry);
      if (!settled.has(key)) return true;
      const edit = edits.get(key);
      if (!edit) return false;
      return !(entry.mode === edit.mode && entry.value === (edit.value ?? ''));
    });
    if (remaining.length !== this.entriesSignal().length) {
      this.entriesSignal.set(remaining);
      this.persist();
    }
  }

  /** The edit list of one save: every pending entry, one edit per device and field. */
  edits(): DeviceUpdateEdit[] {
    return this.entriesSignal()
      .filter((entry) => entry.state === 'pending')
      .slice()
      .sort((left, right) => {
        if (left.deviceId !== right.deviceId)
          return left.deviceId < right.deviceId ? -1 : 1;
        return (
          DEVICE_UPDATE_FIELD_ORDER.indexOf(left.field) -
          DEVICE_UPDATE_FIELD_ORDER.indexOf(right.field)
        );
      })
      .map((entry) => ({
        deviceId: entry.deviceId,
        field: entry.field,
        mode: entry.mode,
        ...(entry.mode === 'clear' ? {} : { value: entry.value }),
        baselineValue: entry.baseline,
      }));
  }

  /**
   * Stage the input of the open editor, so Save changes keeps the value the person typed
   * without pressing Enter (addendum section 5). Returns true when the value joined the draft.
   */
  commitLive(): boolean {
    const live = this.liveSignal();
    if (!live) return false;
    const mode = modeForText(live.field, live.value);
    const changed = !sameRequest(
      live.field,
      requestOf(mode, live.value),
      live.baseline,
    );
    if (!changed) {
      this.endLive();
      return false;
    }
    const result = this.stage({
      deviceId: live.deviceId,
      serialNumber: live.serialNumber,
      field: live.field,
      mode,
      value: live.value,
      baseline: live.baseline,
      orgUnitId: null,
    });
    this.endLive();
    return result.ok && !result.removed;
  }

  /**
   * Settle a confirmed save (DRAFT-02): an eligible row becomes an accepted cell, an
   * unchanged row leaves the draft, and an excluded or conflict row keeps its mark. Only
   * the entries that still hold the submitted request leave; a later edit stays.
   */
  accept(
    submitted: readonly DeviceUpdateEdit[],
    targets: readonly DeviceUpdateTarget[],
    displayId: string,
  ): void {
    const edits = new Map(
      submitted.map((edit) => [keyOf(edit), edit] as const),
    );
    const settled = new Set<string>();
    const accepted: DeviceGridAcceptedEntry[] = [];
    for (const target of targets) {
      const key = keyOf(target);
      if (target.disposition === 'conflict') {
        this.markConflict(target.deviceId, target.field, target.observedValue);
        continue;
      }
      if (target.disposition === 'excluded') {
        this.markExcluded(
          target.deviceId,
          target.field,
          target.exclusionReason,
        );
        continue;
      }
      settled.add(key);
      if (target.disposition !== 'eligible') continue;
      accepted.push(this.acceptedEntry(edits.get(key), target, displayId));
    }
    // A receipt that this tab recovered by replay has no frozen preview. Every submitted
    // edit settled, because the confirmation covered exactly those rows.
    if (!targets.length) {
      for (const edit of submitted) {
        settled.add(keyOf(edit));
        accepted.push(this.acceptedEntry(edit, null, displayId));
      }
    }
    if (accepted.length) {
      const next = this.acceptedSignal().filter(
        (entry) => !accepted.some((row) => keyOf(row) === keyOf(entry)),
      );
      this.acceptedSignal.set([...next, ...accepted]);
    }
    // Remove settled entries whose value still equals the submitted value (patterns 160-161).
    const remaining = this.entriesSignal().filter((entry) => {
      const key = keyOf(entry);
      if (!settled.has(key)) return true;
      const edit = edits.get(key);
      if (!edit) return false;
      return !(entry.mode === edit.mode && entry.value === (edit.value ?? ''));
    });
    if (remaining.length !== this.entriesSignal().length) {
      this.entriesSignal.set(remaining);
      this.persist();
    }
    // A row may already hold the approved value, and a job may already be terminal. The
    // reconcile settles those cells without waiting for an event that already passed (B4).
    if (accepted.length) void this.reconcileAccepted();
  }

  private acceptedEntry(
    edit: DeviceUpdateEdit | undefined,
    target: DeviceUpdateTarget | null,
    displayId: string,
  ): DeviceGridAcceptedEntry {
    const mode = edit?.mode ?? 'replace';
    const value =
      mode === 'clear' ? '' : (edit?.value ?? target?.approvedValue ?? '');
    return {
      deviceId: target?.deviceId ?? edit!.deviceId,
      field: target?.field ?? edit!.field,
      mode,
      value,
      displayId,
    };
  }

  /** Keep current value removes the pending change. */
  keepCurrent(deviceId: string, field: DeviceUpdateField): void {
    this.revert(deviceId, field);
  }

  /** Keep my draft sets the baseline to the current value and stages it again. */
  keepDraft(deviceId: string, field: DeviceUpdateField): void {
    const entry = this.entryFor(deviceId, field);
    if (!entry) return;
    const baseline = entry.currentValue ?? null;
    const next: DeviceGridDraftEntry = {
      ...entry,
      baseline,
      state: 'pending',
    };
    delete next.currentValue;
    if (gridDraftReason(next)) next.state = 'invalid';
    this.upsert(next);
  }

  /** Restore this person's grid draft from the tab document. */
  restore(): void {
    const id = this.auth.session()?.identity.id ?? null;
    this.principal = id;
    this.entriesSignal.set([]);
    // Accepted values belong to the person who confirmed them. Another principal must
    // never see them over their own rows (B5).
    this.acceptedEpoch++;
    this.acceptedSignal.set([]);
    this.reconciling = false;
    this.reconciled = false;
    this.liveSignal.set(null);
    this.refusalSignal.set('');
    this.restoreErrorSignal.set('');
    this.writeErrorSignal.set('');
    if (!id) return;
    try {
      const raw = readDraftPart(id, 'grid');
      if (raw === null) return;
      const part = gridPartSchema.safeParse(raw);
      if (!part.success) {
        this.restoreErrorSignal.set(DEVICE_GRID_DRAFT_STORAGE_ERROR);
        return;
      }
      const { entries, skipped } = this.readEntries(part.data.entries);
      this.entriesSignal.set(entries);
      // One unreadable entry never hides the entries that do restore (B2).
      if (skipped) this.restoreErrorSignal.set(gridDraftRestoreError(skipped));
    } catch {
      this.restoreErrorSignal.set(DEVICE_GRID_DRAFT_STORAGE_ERROR);
    }
  }

  /** Validate one entry at a time and keep the first entry of each device and field. */
  private readEntries(items: readonly unknown[]): {
    entries: DeviceGridDraftEntry[];
    skipped: number;
  } {
    const entries: DeviceGridDraftEntry[] = [];
    const pairs = new Set<string>();
    const devices = new Set<string>();
    let skipped = 0;
    for (const item of items) {
      const parsed = entrySchema.safeParse(item);
      if (!parsed.success) {
        skipped += 1;
        continue;
      }
      const entry = restoredEntry(parsed.data);
      const key = keyOf(entry);
      if (pairs.has(key)) {
        skipped += 1;
        continue;
      }
      if (!devices.has(entry.deviceId) && devices.size >= DEVICE_BY_IDS_LIMIT) {
        skipped += 1;
        continue;
      }
      pairs.add(key);
      devices.add(entry.deviceId);
      entries.push(entry);
    }
    return { entries, skipped };
  }

  private upsert(entry: DeviceGridDraftEntry): void {
    const entries = this.entriesSignal();
    const key = keyOf(entry);
    const index = entries.findIndex((candidate) => keyOf(candidate) === key);
    this.entriesSignal.set(
      index === -1
        ? [...entries, entry]
        : entries.map((candidate, at) => (at === index ? entry : candidate)),
    );
    this.persist();
  }

  private removeEntry(entry: DeviceGridDraftEntry): void {
    const key = keyOf(entry);
    this.entriesSignal.set(
      this.entriesSignal().filter((candidate) => keyOf(candidate) !== key),
    );
    this.persist();
  }

  private persist(): void {
    const id = this.principal ?? this.auth.session()?.identity.id ?? null;
    if (!id) return;
    try {
      const entries = this.entriesSignal();
      writeDraftPart(id, 'grid', entries.length ? { entries } : null);
      this.writeErrorSignal.set('');
    } catch {
      this.writeErrorSignal.set(DEVICE_GRID_DRAFT_WRITE_ERROR);
    }
  }
}

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
  DEVICE_UPDATE_EDITS_LIMIT,
  DEVICE_UPDATE_FIELD_LABELS,
  DEVICE_UPDATE_FIELD_LIMITS,
  deviceUpdateFieldSchema,
  deviceUpdateModeSchema,
  type DeviceRow,
  type DeviceUpdateField,
  type DeviceUpdateMode,
} from '@campus/application-contracts';
import { AuthStore } from '../auth.store';
import type { OrgUnitTreeRow } from './device-org-unit-tree.store';
import { readDraftPart, writeDraftPart } from './device-draft-storage';
import {
  deviceCountText,
  deviceUpdateValueError,
} from './device-update-messages';

/** The grid draft holds at most one entry per device and field (addendum section 5). */
export type DeviceGridDraftState = 'pending' | 'invalid' | 'conflict';

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
}

/** One open editor. Its changed input counts as a pending change (mockup choice 5). */
export interface DeviceGridLiveEdit {
  deviceId: string;
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

const entrySchema = z.strictObject({
  deviceId: z.string().min(1).max(128),
  serialNumber: z.string().max(256),
  field: deviceUpdateFieldSchema,
  mode: deviceUpdateModeSchema,
  value: z.string().max(4096),
  baseline: z.string().max(4096).nullable(),
  orgUnitId: z.string().min(1).max(128).nullable(),
  state: z.enum(['pending', 'invalid', 'conflict']),
  currentValue: z.string().max(4096).nullable().optional(),
});

const gridPartSchema = z
  .strictObject({
    entries: z.array(entrySchema).max(DEVICE_UPDATE_EDITS_LIMIT),
  })
  .superRefine((part, context) => {
    const devices = new Set(part.entries.map((entry) => entry.deviceId));
    if (devices.size > DEVICE_BY_IDS_LIMIT)
      context.addIssue({
        code: 'custom',
        message: `A grid draft holds at most ${DEVICE_BY_IDS_LIMIT} devices.`,
      });
    const pairs = new Set(
      part.entries.map((entry) => `${entry.deviceId}\u0000${entry.field}`),
    );
    if (pairs.size !== part.entries.length)
      context.addIssue({
        code: 'custom',
        message: 'A device and field occur once.',
      });
  });

export const DEVICE_GRID_DRAFT_STORAGE_ERROR =
  'This tab cannot restore the grid draft. Check each changed cell before you save.';
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

/** The mode that an emptied in-cell editor stages (addendum section 5). */
export function modeForText(
  field: DeviceUpdateField,
  value: string,
): DeviceUpdateMode {
  // Asset tag offers Replace only, so an empty tag stays an invalid Replace.
  return field !== 'annotatedAssetId' && value === '' ? 'clear' : 'replace';
}

/** The value of this field in the row, as the person saw it. */
export function rowValueFor(
  row: Pick<
    DeviceRow,
    'assetTag' | 'orgUnitPath' | 'annotatedLocation' | 'annotatedUser' | 'notes'
  >,
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
  const state: DeviceGridDraftState = reason
    ? 'invalid'
    : entry.state === 'conflict' && entry.currentValue !== undefined
      ? 'conflict'
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
    ...(state === 'conflict'
      ? { currentValue: entry.currentValue ?? null }
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
  private readonly liveSignal = signal<DeviceGridLiveEdit | null>(null);
  private readonly refusalSignal = signal('');
  readonly storageError = signal('');
  private principal = this.auth.session()?.identity.id ?? null;

  readonly entries = computed(() => this.entriesSignal());
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

  /** The cell value: the pending value over the row value. */
  valueFor(
    deviceId: string,
    field: DeviceUpdateField,
    rowValue: string,
  ): string {
    const entry = this.entryFor(deviceId, field);
    if (!entry) return rowValue;
    return entry.mode === 'clear' ? '' : entry.value;
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
    const existing = this.entryFor(row.deviceId, field);
    return this.stage({
      deviceId: row.deviceId,
      serialNumber: row.serialNumber,
      field,
      mode: modeForText(field, value),
      value,
      baseline: existing?.baseline ?? rowValueFor(row, field),
      orgUnitId: null,
    });
  }

  /** Stage the destination that the picker returned (Move only). */
  stageMove(
    row: DeviceRow,
    unit: Pick<OrgUnitTreeRow, 'id' | 'path'>,
  ): DeviceGridStageResult {
    const existing = this.entryFor(row.deviceId, 'orgUnitPath');
    return this.stage({
      deviceId: row.deviceId,
      serialNumber: row.serialNumber,
      field: 'orgUnitPath',
      mode: 'move',
      value: unit.path,
      baseline: existing?.baseline ?? rowValueFor(row, 'orgUnitPath'),
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
      // A new value never clears a conflict without the person's answer.
      state: existing?.state === 'conflict' ? 'conflict' : 'pending',
      ...(existing?.state === 'conflict'
        ? { currentValue: existing.currentValue ?? null }
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
    this.liveSignal.set(null);
    this.refusalSignal.set('');
    if (!id) return;
    try {
      const raw = readDraftPart(id, 'grid');
      if (raw === null) {
        this.storageError.set('');
        return;
      }
      const parsed = gridPartSchema.parse(raw);
      this.entriesSignal.set(parsed.entries.map(restoredEntry));
      this.storageError.set('');
    } catch {
      this.storageError.set(DEVICE_GRID_DRAFT_STORAGE_ERROR);
    }
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
      this.storageError.set('');
    } catch {
      this.storageError.set(DEVICE_GRID_DRAFT_WRITE_ERROR);
    }
  }
}

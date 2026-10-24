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
  DEVICE_UPDATE_FIELD_LABELS,
  DEVICE_UPDATE_FIELD_LIMITS,
  DEVICE_UPDATE_FIELD_ORDER,
  DEVICE_UPDATE_SELECTION_FIELDS,
  deviceUpdateFieldSchema,
  deviceUpdateSelectionFieldSchema,
  type DeviceUpdateChange,
  type DeviceUpdateEdit,
  type DeviceUpdateField,
  type DeviceUpdateSelectionChange,
  type DeviceUpdateSelectionField,
} from '@campus/application-contracts';
import { AuthStore } from '../auth.store';
import { readDraftPart, writeDraftPart } from './device-draft-storage';
import {
  deviceUpdateRequest,
  sameUpdateRequest,
} from './device-update-messages';

/** A draft field starts at Leave unchanged. Organization unit offers Move (record line 25). */
export type DeviceUpdateDraftMode = 'unchanged' | 'replace' | 'clear' | 'move';

export interface DeviceUpdateDraftFieldState {
  mode: DeviceUpdateDraftMode;
  /** The value of a Replace, or the destination path of a Move. */
  value: string;
  /** The stable identity of a chosen organization unit (TREE-01). */
  orgUnitId: string | null;
}

/** One editable text field of the draft, in contract order (record line 22). */
export interface DeviceUpdateDraftFieldView {
  id: Exclude<DeviceUpdateField, 'orgUnitPath'>;
  label: string;
  /** The limit of this field, in code points. */
  limit: number;
  multiline: boolean;
}

/**
 * The three text fields of F2, in the record order. Organization unit follows Notes and has
 * its own block, because its modes and its control differ (F3).
 */
export const DEVICE_UPDATE_DRAFT_FIELDS: readonly DeviceUpdateDraftFieldView[] =
  [
    {
      id: 'annotatedLocation',
      label: DEVICE_UPDATE_FIELD_LABELS.annotatedLocation,
      limit: DEVICE_UPDATE_FIELD_LIMITS.annotatedLocation,
      multiline: false,
    },
    {
      id: 'annotatedUser',
      label: DEVICE_UPDATE_FIELD_LABELS.annotatedUser,
      limit: DEVICE_UPDATE_FIELD_LIMITS.annotatedUser,
      multiline: false,
    },
    {
      id: 'notes',
      label: DEVICE_UPDATE_FIELD_LABELS.notes,
      limit: DEVICE_UPDATE_FIELD_LIMITS.notes,
      multiline: true,
    },
  ];

/**
 * The four text fields of the single-device sheet, in contract order: Annotated location,
 * Asset tag, Annotated user, and Notes. Organization unit follows Notes with its own block
 * (addendum section 8).
 */
export const DEVICE_SINGLE_UPDATE_DRAFT_FIELDS: readonly DeviceUpdateDraftFieldView[] =
  [
    {
      id: 'annotatedLocation',
      label: DEVICE_UPDATE_FIELD_LABELS.annotatedLocation,
      limit: DEVICE_UPDATE_FIELD_LIMITS.annotatedLocation,
      multiline: false,
    },
    {
      id: 'annotatedAssetId',
      label: DEVICE_UPDATE_FIELD_LABELS.annotatedAssetId,
      limit: DEVICE_UPDATE_FIELD_LIMITS.annotatedAssetId,
      multiline: false,
    },
    {
      id: 'annotatedUser',
      label: DEVICE_UPDATE_FIELD_LABELS.annotatedUser,
      limit: DEVICE_UPDATE_FIELD_LIMITS.annotatedUser,
      multiline: false,
    },
    {
      id: 'notes',
      label: DEVICE_UPDATE_FIELD_LABELS.notes,
      limit: DEVICE_UPDATE_FIELD_LIMITS.notes,
      multiline: true,
    },
  ];

/** One saved field. A field that is left unchanged is not stored. */
const savedFieldSchema = z.strictObject({
  field: deviceUpdateSelectionFieldSchema,
  mode: z.enum(['replace', 'clear', 'move']),
  value: z.string().max(4096),
  /** Only a Move carries the identity of its destination unit. */
  orgUnitId: z.string().min(1).max(128).optional(),
});

const savedDraftSchema = z
  .strictObject({
    fields: z
      .array(savedFieldSchema)
      .max(DEVICE_UPDATE_SELECTION_FIELDS.length),
  })
  .refine(
    (draft) =>
      draft.fields.every(
        (saved) =>
          saved.field !== 'orgUnitPath' ||
          (saved.mode === 'move' && saved.value.startsWith('/')),
      ),
    { message: 'A Move stores a path that starts with /.' },
  );

type DraftFieldRecord = Record<
  DeviceUpdateSelectionField,
  DeviceUpdateDraftFieldState
>;

function emptyFields(): DraftFieldRecord {
  return {
    annotatedLocation: { mode: 'unchanged', value: '', orgUnitId: null },
    annotatedUser: { mode: 'unchanged', value: '', orgUnitId: null },
    notes: { mode: 'unchanged', value: '', orgUnitId: null },
    orgUnitPath: { mode: 'unchanged', value: '', orgUnitId: null },
  };
}

/**
 * The unsubmitted draft of the Update device sheet. It holds one change per field, so each
 * field keeps its own mode and value (DRAFT-01), and the Organization unit field keeps the
 * path and the identity of its destination. It lives outside the grid, so filtering,
 * scrolling, and row updates never touch it. Each browser tab restores the draft of the
 * signed-in person after a refresh. The tab document holds this sheet part beside the grid
 * and single-device parts; this store reads and writes only its own part.
 */
@Injectable({ providedIn: 'root' })
export class DeviceUpdateDraftStore {
  private readonly auth = inject(AuthStore);
  private readonly fields = signal<DraftFieldRecord>(emptyFields());
  /** The fields in contract order that hold a change. A Move needs a destination. */
  readonly changes = computed<DeviceUpdateSelectionChange[]>(() =>
    DEVICE_UPDATE_SELECTION_FIELDS.flatMap<DeviceUpdateSelectionChange>(
      (field) => {
        const state = this.fields()[field];
        if (state.mode === 'unchanged') return [];
        if (state.mode === 'move')
          return state.value
            ? [{ field, mode: 'move', value: state.value }]
            : [];
        return [
          state.mode === 'clear'
            ? { field, mode: state.mode }
            : { field, mode: state.mode, value: state.value },
        ];
      },
    ),
  );
  /** The number of changed fields, as the Edit summary counts it. */
  readonly changedCount = computed(() => this.changes().length);
  /** The draft holds at least one change. */
  readonly changed = computed(() => this.changedCount() > 0);
  readonly storageError = signal('');
  private principal = this.auth.session()?.identity.id ?? null;

  constructor() {
    this.restore();
    effect(() => {
      const id = this.auth.session()?.identity.id ?? null;
      if (id === this.principal) return;
      untracked(() => this.restore());
    });
  }

  modeOf(field: DeviceUpdateSelectionField): DeviceUpdateDraftMode {
    return this.fields()[field].mode;
  }

  valueOf(field: DeviceUpdateSelectionField): string {
    return this.fields()[field].value;
  }

  /** The identity of the chosen organization unit, or null. */
  orgUnitId(): string | null {
    return this.fields().orgUnitPath.orgUnitId;
  }

  setValue(field: DeviceUpdateSelectionField, value: string): void {
    this.fields.update((fields) => ({
      ...fields,
      [field]: { ...fields[field], value },
    }));
    this.persist();
  }

  /**
   * Another mode drops the value of the Organization unit field, because its value is a
   * chosen destination and not typed text (design note 10).
   */
  setMode(
    field: DeviceUpdateSelectionField,
    mode: DeviceUpdateDraftMode,
  ): void {
    const dropValue = field === 'orgUnitPath' && mode !== 'move';
    this.fields.update((fields) => ({
      ...fields,
      [field]: {
        ...fields[field],
        mode,
        ...(dropValue ? { value: '', orgUnitId: null } : {}),
      },
    }));
    this.persist();
  }

  /** Choose one organization unit as the destination of the move. */
  setOrgUnit(unit: { orgUnitId: string | null; path: string }): void {
    this.fields.update((fields) => ({
      ...fields,
      orgUnitPath: {
        mode: 'move',
        value: unit.path,
        orgUnitId: unit.orgUnitId,
      },
    }));
    this.persist();
  }

  /** Discards the draft. The selection and the grid stay as they are. */
  reset(): void {
    this.fields.set(emptyFields());
    this.persist();
  }

  /** Restore the draft of the signed-in person. Another person starts clean. */
  restore(): void {
    const id = this.auth.session()?.identity.id ?? null;
    this.principal = id;
    this.fields.set(emptyFields());
    if (!id) return;
    try {
      const raw = readDraftPart(id, 'sheet');
      if (raw === null) {
        this.storageError.set('');
        return;
      }
      const saved = savedDraftSchema.parse(raw);
      const restored = emptyFields();
      for (const field of saved.fields)
        restored[field.field] = {
          mode: field.mode,
          value: field.value,
          orgUnitId: field.orgUnitId ?? null,
        };
      this.fields.set(restored);
      this.storageError.set('');
    } catch {
      this.storageError.set(
        'This tab cannot restore the device update draft. Check each field before saving.',
      );
    }
  }

  private persist(): void {
    const id = this.principal ?? this.auth.session()?.identity.id ?? null;
    if (!id) return;
    const changed = this.changes();
    try {
      if (changed.length === 0) {
        writeDraftPart(id, 'sheet', null);
      } else {
        const fields = changed.map((change) => ({
          field: change.field,
          mode: change.mode,
          value: change.value ?? '',
          ...(change.field === 'orgUnitPath' && this.orgUnitId()
            ? { orgUnitId: this.orgUnitId() }
            : {}),
        }));
        writeDraftPart(id, 'sheet', savedDraftSchema.parse({ fields }));
      }
      this.storageError.set('');
    } catch {
      this.storageError.set(
        'Tab storage is unavailable. Keep this page open until you prepare the preview.',
      );
    }
  }
}

/** The device that the single-device sheet edits. Device details supplies these values. */
export interface DeviceSingleUpdateTarget {
  deviceId: string;
  serialNumber: string;
  assetTag: string | null;
  orgUnitPath: string;
  annotatedLocation: string | null;
  annotatedUser: string | null;
  notes: string | null;
}

/** The value that device details showed for each field when the sheet opened. */
type SingleBaselineRecord = Record<DeviceUpdateField, string | null>;

const singleFieldSchema = z.strictObject({
  field: deviceUpdateFieldSchema,
  mode: z.enum(['replace', 'clear', 'move']),
  value: z.string().max(4096),
  /** Only a Move carries the identity of its destination unit. */
  orgUnitId: z.string().min(1).max(128).optional(),
});

/** One device and its saved fields. A sheet for another device replaces the part. */
const singleDraftSchema = z
  .strictObject({
    deviceId: z.string().min(1).max(128),
    serialNumber: z.string().max(256),
    fields: z.array(singleFieldSchema).max(DEVICE_UPDATE_FIELD_ORDER.length),
  })
  .refine(
    (draft) => {
      const fields = draft.fields.map((saved) => saved.field);
      if (new Set(fields).size !== fields.length) return false;
      return draft.fields.every((saved) => {
        // Asset tag offers Replace only. The record order keeps one mode per field.
        if (saved.field === 'annotatedAssetId') return saved.mode === 'replace';
        if (saved.field === 'orgUnitPath')
          return saved.mode === 'move' && saved.value.startsWith('/');
        return saved.mode === 'replace' || saved.mode === 'clear';
      });
    },
    { message: 'A saved single-device field keeps its offered mode.' },
  );

type SingleFieldRecord = Record<DeviceUpdateField, DeviceUpdateDraftFieldState>;

function emptySingleField(): DeviceUpdateDraftFieldState {
  return { mode: 'unchanged', value: '', orgUnitId: null };
}

function emptySingleFields(): SingleFieldRecord {
  return {
    annotatedLocation: emptySingleField(),
    annotatedAssetId: emptySingleField(),
    annotatedUser: emptySingleField(),
    notes: emptySingleField(),
    orgUnitPath: emptySingleField(),
  };
}

/**
 * The unsubmitted draft of the single-device Update device sheet (addendum section 8). It
 * holds one device and five fields in record order. Each field starts at Leave unchanged,
 * and Asset tag offers Replace only. The baselines are the values that device details showed
 * when the sheet opened, so the edit list compares against what the person saw. The draft
 * lives in the tab document under its own `single` part; it never reads the sheet draft or
 * the grid draft. A sheet for another device starts empty and replaces it.
 */
@Injectable({ providedIn: 'root' })
export class DeviceSingleUpdateDraftStore {
  private readonly auth = inject(AuthStore);
  private readonly target = signal<{
    deviceId: string;
    serialNumber: string;
  } | null>(null);
  private readonly baselines = signal<SingleBaselineRecord | null>(null);
  private readonly fields = signal<SingleFieldRecord>(emptySingleFields());
  /** The fields in contract order that hold a change. A Move needs a destination. */
  readonly changes = computed<DeviceUpdateChange[]>(() =>
    DEVICE_UPDATE_FIELD_ORDER.flatMap<DeviceUpdateChange>((field) => {
      const state = this.fields()[field];
      if (state.mode === 'unchanged') return [];
      if (state.mode === 'move')
        return state.value ? [{ field, mode: 'move', value: state.value }] : [];
      // A Clear of a value that device details did not show changes nothing, and the edit
      // list refuses a request equal to its baseline. The sheet names the omission beside
      // the field, so a valid sibling change stays usable.
      if (state.mode === 'clear' && this.clearsNothing(field)) return [];
      return [
        state.mode === 'clear'
          ? { field, mode: 'clear' }
          : { field, mode: 'replace', value: state.value },
      ];
    }),
  );
  readonly changedCount = computed(() => this.changes().length);
  readonly changed = computed(() => this.changedCount() > 0);
  readonly storageError = signal('');
  private principal = this.auth.session()?.identity.id ?? null;

  constructor() {
    this.restore();
    effect(() => {
      const id = this.auth.session()?.identity.id ?? null;
      if (id === this.principal) return;
      untracked(() => this.restore());
    });
  }

  deviceId(): string | null {
    return this.target()?.deviceId ?? null;
  }

  modeOf(field: DeviceUpdateField): DeviceUpdateDraftMode {
    return this.fields()[field].mode;
  }

  valueOf(field: DeviceUpdateField): string {
    return this.fields()[field].value;
  }

  /** The value that device details showed for this field, or null before a device opens. */
  baselineOf(field: DeviceUpdateField): string | null {
    return this.baselines()?.[field] ?? null;
  }

  /**
   * A chosen Clear whose request equals the value that device details showed changes
   * nothing. The edit list refuses such a request, so the draft omits it (B4).
   */
  clearsNothing(field: DeviceUpdateField): boolean {
    const baselines = this.baselines();
    return (
      baselines !== null &&
      this.fields()[field].mode === 'clear' &&
      sameUpdateRequest(field, null, baselines[field])
    );
  }

  /** The identity of the chosen organization unit, or null. */
  orgUnitId(): string | null {
    return this.fields().orgUnitPath.orgUnitId;
  }

  /**
   * Start the sheet for one device. A different device replaces the draft with empty fields.
   * A restored change whose request now equals the current value leaves the draft, because
   * the edit list refuses an edit that changes nothing.
   */
  open(target: DeviceSingleUpdateTarget): void {
    const matching = this.target()?.deviceId === target.deviceId;
    const baselines: SingleBaselineRecord = {
      annotatedLocation: target.annotatedLocation,
      annotatedAssetId: target.assetTag,
      annotatedUser: target.annotatedUser,
      notes: target.notes,
      orgUnitPath: target.orgUnitPath,
    };
    const fields = matching ? { ...this.fields() } : emptySingleFields();
    for (const field of DEVICE_UPDATE_FIELD_ORDER) {
      const state = fields[field];
      if (state.mode === 'unchanged') continue;
      if (
        sameUpdateRequest(
          field,
          deviceUpdateRequest(state.mode, state.value),
          baselines[field],
        )
      )
        fields[field] = emptySingleField();
    }
    this.target.set({
      deviceId: target.deviceId,
      serialNumber: target.serialNumber || target.deviceId,
    });
    this.baselines.set(baselines);
    this.fields.set(fields);
    this.persist();
  }

  /** The offered modes of one field. Asset tag offers Replace only. */
  private offers(
    field: DeviceUpdateField,
    mode: DeviceUpdateDraftMode,
  ): boolean {
    if (mode === 'unchanged') return true;
    if (field === 'annotatedAssetId') return mode === 'replace';
    if (field === 'orgUnitPath') return mode === 'move';
    return mode === 'replace' || mode === 'clear';
  }

  setValue(field: DeviceUpdateField, value: string): void {
    if (field === 'orgUnitPath') return;
    this.fields.update((fields) => ({
      ...fields,
      [field]: { ...fields[field], value },
    }));
    this.persist();
  }

  setMode(field: DeviceUpdateField, mode: DeviceUpdateDraftMode): void {
    if (!this.offers(field, mode)) return;
    const dropValue = field === 'orgUnitPath' && mode !== 'move';
    this.fields.update((fields) => ({
      ...fields,
      [field]: {
        ...fields[field],
        mode,
        ...(dropValue ? { value: '', orgUnitId: null } : {}),
      },
    }));
    this.persist();
  }

  /** Choose one organization unit as the destination of the move. */
  setOrgUnit(unit: { orgUnitId: string | null; path: string }): void {
    this.fields.update((fields) => ({
      ...fields,
      orgUnitPath: {
        mode: 'move',
        value: unit.path,
        orgUnitId: unit.orgUnitId,
      },
    }));
    this.persist();
  }

  /** Discard the field changes of this device. The sheet stays open for the same device. */
  reset(): void {
    this.fields.set(emptySingleFields());
    this.persist();
  }

  /** One edit per changed field of the open device, in record order. */
  edits(): DeviceUpdateEdit[] {
    const target = this.target();
    const baselines = this.baselines();
    if (!target || !baselines) return [];
    return this.changes().map((change) => ({
      deviceId: target.deviceId,
      field: change.field,
      mode: change.mode,
      ...(change.mode === 'clear' ? {} : { value: change.value }),
      baselineValue: baselines[change.field],
    }));
  }

  /**
   * Settle the fields that one accepted confirmation submitted for this device. A field
   * leaves the draft only when its current request still equals the submitted request, so a
   * later value and another device's draft stay (B3). A receipt of another source never
   * calls this method, so it cannot clear this draft (B2).
   */
  settle(submitted: readonly DeviceUpdateEdit[]): void {
    const target = this.target();
    if (!target || !submitted.length) return;
    const fields = { ...this.fields() };
    let cleared = false;
    for (const edit of submitted) {
      if (edit.deviceId !== target.deviceId) continue;
      const state = fields[edit.field];
      if (state.mode === 'unchanged') continue;
      const request = deviceUpdateRequest(edit.mode, edit.value ?? '');
      if (state.mode !== edit.mode) continue;
      if (
        !sameUpdateRequest(
          edit.field,
          request,
          deviceUpdateRequest(state.mode, state.value),
        )
      )
        continue;
      fields[edit.field] = emptySingleField();
      cleared = true;
    }
    if (!cleared) return;
    this.fields.set(fields);
    this.persist();
  }

  /** Restore the draft of the signed-in person. Another person starts clean. */
  restore(): void {
    const id = this.auth.session()?.identity.id ?? null;
    this.principal = id;
    this.target.set(null);
    this.baselines.set(null);
    this.fields.set(emptySingleFields());
    if (!id) return;
    try {
      const raw = readDraftPart(id, 'single');
      if (raw === null) {
        this.storageError.set('');
        return;
      }
      const saved = singleDraftSchema.parse(raw);
      const restored = emptySingleFields();
      for (const field of saved.fields)
        restored[field.field] = {
          mode: field.mode,
          value: field.value,
          orgUnitId: field.orgUnitId ?? null,
        };
      this.target.set({
        deviceId: saved.deviceId,
        serialNumber: saved.serialNumber,
      });
      this.fields.set(restored);
      this.storageError.set('');
    } catch {
      this.storageError.set(
        'This tab cannot restore the single-device draft. Check each field before saving.',
      );
    }
  }

  private persist(): void {
    const id = this.principal ?? this.auth.session()?.identity.id ?? null;
    const target = this.target();
    if (!id || !target) return;
    try {
      const fields = this.changes().map((change) => ({
        field: change.field,
        mode: change.mode,
        value: change.value ?? '',
        ...(change.field === 'orgUnitPath' && this.orgUnitId()
          ? { orgUnitId: this.orgUnitId() }
          : {}),
      }));
      writeDraftPart(
        id,
        'single',
        singleDraftSchema.parse({
          deviceId: target.deviceId,
          serialNumber: target.serialNumber,
          fields,
        }),
      );
      this.storageError.set('');
    } catch {
      this.storageError.set(
        'Tab storage is unavailable. Keep this page open until you prepare the preview.',
      );
    }
  }
}

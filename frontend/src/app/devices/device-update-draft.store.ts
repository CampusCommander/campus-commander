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
  DEVICE_UPDATE_SELECTION_FIELDS,
  deviceUpdateSelectionFieldSchema,
  type DeviceUpdateSelectionChange,
  type DeviceUpdateSelectionField,
  type DeviceUpdateTextField,
} from '@campus/application-contracts';
import { AuthStore } from '../auth.store';

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
  id: DeviceUpdateTextField;
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
 * signed-in person after a refresh.
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

  /** The value length in code points, as the field counter shows it. */
  lengthOf(field: DeviceUpdateTextField): number {
    return [...this.valueOf(field)].length;
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
      const raw = sessionStorage.getItem(this.storageKey(id));
      if (!raw) {
        this.storageError.set('');
        return;
      }
      const saved = savedDraftSchema.parse(JSON.parse(raw));
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

  private storageKey(principal: string): string {
    return `cc.device-update-draft.${principal}`;
  }

  private persist(): void {
    const id = this.principal ?? this.auth.session()?.identity.id ?? null;
    if (!id) return;
    const changed = this.changes();
    try {
      if (changed.length === 0) {
        sessionStorage.removeItem(this.storageKey(id));
      } else {
        const fields = changed.map((change) => ({
          field: change.field,
          mode: change.mode,
          value: change.value ?? '',
          ...(change.field === 'orgUnitPath' && this.orgUnitId()
            ? { orgUnitId: this.orgUnitId() }
            : {}),
        }));
        sessionStorage.setItem(
          this.storageKey(id),
          JSON.stringify(savedDraftSchema.parse({ fields })),
        );
      }
      this.storageError.set('');
    } catch {
      this.storageError.set(
        'Tab storage is unavailable. Keep this page open until you prepare the preview.',
      );
    }
  }
}

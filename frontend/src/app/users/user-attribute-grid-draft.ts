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
  USER_ATTRIBUTE_EDITS_LIMIT,
  USER_BY_IDS_LIMIT,
  userAttributeFieldTypeSchema,
  userAttributeKeySchema,
  userAttributeRowValueSchema,
  type UserAttributeEdit,
  type UserAttributeField,
  type UserAttributeFieldType,
  type UserAttributeRange,
  type UserAttributeRowValue,
  type UserAttributeTarget,
  type UserRow,
} from '@campus/application-contracts';
import { AuthStore } from '../auth.store';
import {
  readUserDraftPart,
  writeUserDraftPart,
} from './user-attribute-draft-storage';
import {
  ATTRIBUTE_DRAFT_STORAGE_ERROR,
  ATTRIBUTE_DRAFT_USER_LIMIT_TEXT,
  ATTRIBUTE_DRAFT_WRITE_ERROR,
  attributeDraftConflictText,
  attributeDraftCountLine,
  attributeDraftEditingText,
  attributeDraftInvalidText,
  attributeDraftRestoreError,
  attributeDraftValueText,
} from './user-attribute-grid-messages';
import {
  attributeBaseline,
  attributeDraftResult,
  attributeEditorValue,
  attributeValueError,
  attributeWireValue,
  sameAttributeValue,
  type AttributeDraft,
} from './user-attribute-value-rules';
import type { AttributeSaveOutcome } from './user-attribute-edit-flow';
import type { UserAttributeColumn } from './user-fields';

/** The state of one cell of the grid draft (DRAFT-02). */
export type UserAttributeDraftState = 'pending' | 'invalid' | 'conflict';

/** The editor state of one cell, in the shape of the K25 card form. */
export type UserAttributeEditorValue = string | boolean | null | string[];

/** One pending cell: one user and one C1 attribute (DRAFT-01, design C1). */
export interface UserAttributeDraftEntry {
  userId: string;
  /** The readable user name that the bar and the cell actions use. */
  userName: string;
  /** The C1 attribute ID, `attr:<schemaName>.<fieldName>` (design C1). */
  attribute: string;
  label: string;
  fieldType: UserAttributeFieldType;
  multiValued: boolean;
  minValue: number | null;
  maxValue: number | null;
  /** The editor value. A Clear carries the empty text or an empty list. */
  value: UserAttributeEditorValue;
  /** The value that the person saw when the edit began, in wire form. */
  baseline: UserAttributeRowValue | null;
  state: UserAttributeDraftState;
  /** The current Google value of a conflict entry (B section 8.4). */
  currentValue?: UserAttributeRowValue | null;
}

/** One open editor. Its changed input counts as a pending change (DRAFT-02). */
export interface UserAttributeLiveEdit {
  userId: string;
  userName: string;
  attribute: string;
  label: string;
  fieldType: UserAttributeFieldType;
  multiValued: boolean;
  minValue: number | null;
  maxValue: number | null;
  baseline: UserAttributeRowValue | null;
  value: UserAttributeEditorValue;
}

export interface UserAttributeDraftCounts {
  changes: number;
  users: number;
}

/**
 * One saved value that the grid keeps on screen until its row holds it (design K26).
 *
 * A save leaves the draft at acceptance, so the cell would draw the row value again. The
 * row value is old until the users feed carries the written value (document B section 9),
 * so the cell draws the submitted value with no clock and no rollback. The mark clears when
 * a row holds the value. When the owning job answers, the mark becomes settled: the next
 * authoritative row replaces it, because the job will write nothing more.
 */
export interface UserAttributeSettledCell {
  /** The cell metadata: user ID, C1 attribute, label, field type, and baseline. */
  cell: DraftCell;
  /** The text of the submitted value, in the form that the row value reads. */
  text: string;
  /** The job that owns the submitted value. */
  displayId: string;
  /** The owning job answered, so a divergent row is final. */
  settled: boolean;
}

export type UserAttributeStageResult =
  | { ok: true; removed: boolean }
  | { ok: false; reason: 'user-limit' | 'change-limit' };

/** The metadata that validates one cell, without the identity or the state. */
type DraftCell = Omit<UserAttributeDraftEntry, 'state' | 'currentValue'>;

/**
 * One stored entry. The editor value carries no length cap: an invalid edit still has to
 * round-trip through storage so the person can correct it (DRAFT-01).
 */
const entrySchema = z.strictObject({
  userId: z.string().min(1).max(128),
  userName: z.string().max(4096),
  attribute: userAttributeKeySchema,
  label: z.string().min(1).max(200),
  fieldType: userAttributeFieldTypeSchema,
  multiValued: z.boolean(),
  minValue: z.number().nullable(),
  maxValue: z.number().nullable(),
  value: z.union([
    z.string(),
    z.boolean(),
    z.null(),
    z.array(z.string().max(4096)).max(150),
  ]),
  baseline: userAttributeRowValueSchema.nullable(),
  state: z.enum(['pending', 'invalid', 'conflict']),
  currentValue: userAttributeRowValueSchema.nullable().optional(),
});

/** The outer shape only. Each entry validates alone, so one bad entry keeps the rest. */
const draftPartSchema = z.object({ entries: z.array(z.unknown()) });

/** The two parts of a C1 attribute ID (design C1). */
const ATTRIBUTE_KEY = /^attr:([A-Za-z0-9_-]{1,200})\.([A-Za-z0-9_-]{1,200})$/;

export function attributeKeyParts(attribute: string): {
  schemaName: string;
  fieldName: string;
} {
  const match = ATTRIBUTE_KEY.exec(attribute);
  return match
    ? { schemaName: match[1]!, fieldName: match[2]! }
    : { schemaName: '', fieldName: '' };
}

/** The draft key of one cell: the user ID and the C1 attribute ID (B section 12). */
export function draftKey(entry: { userId: string; attribute: string }): string {
  return `${entry.userId}\u0000${entry.attribute}`;
}

/**
 * The field metadata that the K25 value rules read. The draft stores the facts that its
 * validation needs, so a restored entry validates without the category read.
 */
export function entryField(entry: DraftCell): UserAttributeField {
  const { schemaName, fieldName } = attributeKeyParts(entry.attribute);
  const range: UserAttributeRange | null =
    entry.minValue === null && entry.maxValue === null
      ? null
      : { minValue: entry.minValue, maxValue: entry.maxValue };
  return {
    fieldId: `${schemaName}.${fieldName}`,
    fieldName,
    displayName: entry.label,
    fieldType: entry.fieldType,
    multiValued: entry.multiValued,
    indexed: false,
    readAccessType: 'ADMINS_AND_SELF',
    numericIndexingSpec: range,
    holders: 0,
  };
}

/** One cell in the shape of the K25 card form, so its value rules run unchanged. */
export function entryDraft(entry: DraftCell): AttributeDraft {
  const { schemaName, fieldName } = attributeKeyParts(entry.attribute);
  return {
    key: entry.attribute,
    schemaName,
    fieldName,
    label: entry.label,
    field: entryField(entry),
    baseline: entry.baseline,
    value: entry.value,
  };
}

/** The message of one cell, or null while its value passes (B section 8.1). */
export function entryReason(entry: DraftCell): string | null {
  return attributeDraftResult(entryDraft(entry), '').error;
}

/** The wire value of one editor value. */
export function entryWire(entry: DraftCell): UserAttributeRowValue | null {
  return attributeWireValue(entryDraft(entry));
}

/**
 * The cell text of one pending value, in the form that the row value reads. An invalid
 * editor value shows exactly what the person typed, so a correction starts from that text
 * (R1-F). The wire conversion runs for a value that passes its rules only.
 */
export function entryText(entry: DraftCell): string {
  if (typeof entry.value === 'string' && entryReason(entry) !== null)
    return entry.value;
  return attributeDraftValueText(entryWire(entry), entry.fieldType);
}

/**
 * The text that one saved cell draws once its draft entry left: the submitted value until
 * the row holds it (design K26).
 */
export function rowCellText(row: UserRow, cell: DraftCell): string {
  const { schemaName, fieldName } = attributeKeyParts(cell.attribute);
  const schemas = row.customSchemas;
  const category = Object.hasOwn(schemas, schemaName)
    ? schemas[schemaName]
    : undefined;
  const raw =
    category &&
    typeof category === 'object' &&
    Object.hasOwn(category, fieldName)
      ? (category as Record<string, unknown>)[fieldName]
      : undefined;
  return attributeDraftValueText(
    attributeBaseline(raw, entryField(cell)),
    cell.fieldType,
  );
}

/** Whether one entry still holds the request of one submitted edit. */
export function entryHoldsEdit(
  entry: DraftCell,
  edit: UserAttributeEdit,
): boolean {
  const result = attributeDraftResult(entryDraft(entry), entry.userId);
  return (
    !!result.edit &&
    result.edit.mode === edit.mode &&
    sameAttributeValue(entryField(entry), result.edit.values, edit.values)
  );
}

/** The baseline of one attribute cell, from the row that the person saw. */
export function rowBaseline(
  row: UserRow,
  column: UserAttributeColumn,
): UserAttributeRowValue | null {
  const schemas = row.customSchemas;
  const category = Object.hasOwn(schemas, column.schemaName)
    ? schemas[column.schemaName]
    : undefined;
  const raw =
    category &&
    typeof category === 'object' &&
    Object.hasOwn(category, column.fieldName)
      ? (category as Record<string, unknown>)[column.fieldName]
      : undefined;
  return attributeBaseline(raw, column.field);
}

function rangeOf(field: UserAttributeField): {
  minValue: number | null;
  maxValue: number | null;
} {
  return {
    minValue: field.numericIndexingSpec?.minValue ?? null,
    maxValue: field.numericIndexingSpec?.maxValue ?? null,
  };
}

/** The cell metadata of one attribute column and one row. */
export function cellFor(row: UserRow, column: UserAttributeColumn): DraftCell {
  return {
    userId: row.userId,
    userName: row.fullName || row.primaryEmail,
    attribute: column.id,
    label: column.label,
    fieldType: column.field.fieldType,
    multiValued: column.field.multiValued,
    ...rangeOf(column.field),
    value: attributeEditorValue(rowBaseline(row, column), column.field),
    baseline: rowBaseline(row, column),
  };
}

/**
 * The user attribute grid draft (DRAFT-01, DRAFT-02, design K26).
 *
 * Entries live outside the grid row cache, so refresh, paging, sorting, and feed updates
 * never touch them. The draft holds at most 500 users, and the value rules of B section
 * 8.1 run in the cell through the K25 rules.
 */
@Injectable({ providedIn: 'root' })
export class UserAttributeGridDraft {
  private readonly auth = inject(AuthStore);
  private readonly entriesSignal = signal<UserAttributeDraftEntry[]>([]);
  private readonly settledSignal = signal<UserAttributeSettledCell[]>([]);
  private readonly liveSignal = signal<UserAttributeLiveEdit | null>(null);
  private readonly refusalSignal = signal('');
  private readonly restoreErrorSignal = signal('');
  private readonly writeErrorSignal = signal('');
  private principal = this.auth.session()?.identity.id ?? null;

  readonly entries = computed(() => this.entriesSignal());
  readonly live = computed(() => this.liveSignal());
  /** The sentence of a refused save. It stays until the next stage or save. */
  readonly refusal = computed(() => this.refusalSignal());

  /** A restore warning stays until the next restore, so one write never hides lost entries. */
  readonly storageError = computed(
    () => this.restoreErrorSignal() || this.writeErrorSignal(),
  );

  constructor() {
    this.restore();
    effect(() => {
      const id = this.auth.session()?.identity.id ?? null;
      if (id === this.principal) return;
      untracked(() => this.restore());
    });
  }

  entryFor(userId: string, attribute: string): UserAttributeDraftEntry | null {
    return (
      this.entriesSignal().find(
        (entry) => entry.userId === userId && entry.attribute === attribute,
      ) ?? null
    );
  }

  /** The cell value: the pending value over the saved value over the row value (DRAFT-02). */
  valueFor(row: UserRow, column: UserAttributeColumn): string {
    const cell = cellFor(row, column);
    const entry = this.entryFor(row.userId, column.id);
    if (entry) return entryText(entry);
    const settled = this.settledFor(row.userId, column.id);
    if (settled) {
      // The saved value covers the row until an authoritative row proves it (design K26,
      // R1-C). A job answer alone does not prove the value: the read may still be old.
      const current = rowCellText(row, settled.cell);
      return current === settled.text ? current : settled.text;
    }
    return attributeDraftValueText(cell.baseline, cell.fieldType);
  }

  /** The saved value of one cell that waits for its row, or null. */
  settledFor(
    userId: string,
    attribute: string,
  ): UserAttributeSettledCell | null {
    return (
      this.settledSignal().find(
        ({ cell }) => cell.userId === userId && cell.attribute === attribute,
      ) ?? null
    );
  }

  /** The users of the saved cells that wait for their rows. */
  readonly settledUserIds = computed<readonly string[]>(() => [
    ...new Set(this.settledSignal().map(({ cell }) => cell.userId)),
  ]);

  /**
   * Drop every mark that an authoritative row proves. A row that holds the submitted value
   * answers the mark. A row that still holds the value at edit start has not observed the
   * write yet, so the saved value stays. Any other value is the actual value, because the
   * owning job wrote nothing more (R1-C).
   */
  settleWithRows(rows: readonly UserRow[]): void {
    if (!this.settledSignal().length || !rows.length) return;
    const byId = new Map(rows.map((row) => [row.userId, row] as const));
    const remaining = this.settledSignal().filter(({ cell, text }) => {
      const row = byId.get(cell.userId);
      if (!row) return true;
      const current = rowCellText(row, cell);
      if (current === text) return false;
      return current === attributeDraftValueText(cell.baseline, cell.fieldType);
    });
    if (remaining.length !== this.settledSignal().length)
      this.settledSignal.set(remaining);
  }

  /**
   * The owning job answered. A completed job keeps its marks until an authoritative row
   * lands. A failed or unknown job wrote no confirmed value, so its marks leave at once
   * and the cells draw the row (R1-C).
   */
  settleJob(displayId: string, outcome: AttributeSaveOutcome): void {
    if (!this.settledSignal().length) return;
    if (outcome === 'failed' || outcome === 'unknown') {
      this.dropSettled(displayId);
      return;
    }
    this.settledSignal.set(
      this.settledSignal().map((mark) =>
        mark.displayId === displayId ? { ...mark, settled: true } : mark,
      ),
    );
  }

  /**
   * The marks of one job, or every mark, leave. The cell draws the row value that Google
   * holds instead of the submitted value (design K26).
   */
  dropSettled(displayId?: string): void {
    if (!this.settledSignal().length) return;
    if (!displayId) {
      this.settledSignal.set([]);
      return;
    }
    this.settledSignal.set(
      this.settledSignal().filter((mark) => mark.displayId !== displayId),
    );
  }

  /** The baseline of one edit of a row. A stored entry keeps the value it began with. */
  baselineFor(
    row: UserRow,
    column: UserAttributeColumn,
  ): UserAttributeRowValue | null {
    return (
      this.entryFor(row.userId, column.id)?.baseline ?? rowBaseline(row, column)
    );
  }

  /** The reason that one entry cannot be saved, or an empty string. */
  reasonFor(entry: UserAttributeDraftEntry): string {
    return entryReason(entry) ?? '';
  }

  /**
   * Count entries and their users. An open editor counts when its input differs from the
   * baseline, and removes its entry's count when the input returns to the baseline.
   */
  readonly counts = computed<UserAttributeDraftCounts>(() => {
    const effective = new Map<string, string>();
    for (const entry of this.entriesSignal())
      effective.set(draftKey(entry), entry.userId);
    const live = this.liveSignal();
    if (live) {
      const changed = attributeDraftResult(
        entryDraft(live),
        live.userId,
      ).changed;
      if (changed) effective.set(draftKey(live), live.userId);
      else effective.delete(draftKey(live));
    }
    return {
      changes: effective.size,
      users: new Set(effective.values()).size,
    };
  });

  /** The ruling 14 count line: "2 pending changes · 2 users". */
  readonly countLine = computed(() => {
    const { changes, users } = this.counts();
    return attributeDraftCountLine(changes, users);
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

  /** The panel's second line: the refusal, the reason, or the editing hint. */
  readonly line = computed<{ text: string; tone: 'error' | 'warning' | '' }>(
    () => {
      if (this.refusalSignal())
        return { text: this.refusalSignal(), tone: 'error' };
      if (this.storageError())
        return { text: this.storageError(), tone: 'error' };
      const entries = this.entriesSignal();
      const invalid = entries.filter((entry) => entry.state === 'invalid');
      if (invalid.length) {
        const first = invalid[0]!;
        return {
          text: attributeDraftInvalidText(
            invalid.length,
            first.userName,
            this.reasonFor(first),
          ),
          tone: 'error',
        };
      }
      const conflicts = entries.filter((entry) => entry.state === 'conflict');
      if (conflicts.length) {
        const first = conflicts[0]!;
        return {
          text: attributeDraftConflictText(
            conflicts.length,
            first.label,
            first.userName,
          ),
          tone: 'warning',
        };
      }
      const live = this.liveSignal();
      if (live)
        return { text: attributeDraftEditingText(live.label), tone: '' };
      return { text: '', tone: '' };
    },
  );

  /** The distinct users of the draft, for Show pending changes (DRAFT-02). */
  readonly pendingUserIds = computed<readonly string[]>(() => [
    ...new Set(this.entriesSignal().map((entry) => entry.userId)),
  ]);

  /** Start an editor. Its changed input counts before the value is staged. */
  beginLive(edit: UserAttributeLiveEdit): void {
    this.refusalSignal.set('');
    this.liveSignal.set(edit);
  }

  updateLive(value: UserAttributeEditorValue): void {
    const live = this.liveSignal();
    if (!live) return;
    // Only the open editor changes here. Returning to the baseline hides the older entry
    // from the count, and Escape cancels the input without touching the staged entry.
    this.liveSignal.set({ ...live, value });
  }

  endLive(): void {
    this.liveSignal.set(null);
  }

  /** Stage the input of the open editor, so Save changes keeps a typed value. */
  commitLive(): boolean {
    const live = this.liveSignal();
    if (!live) return false;
    const staged = this.stage(live, live.value);
    this.endLive();
    return staged.ok && !staged.removed;
  }

  /** Stage one cell of a row. A value equal to its baseline removes the entry. */
  stage(
    cell: DraftCell,
    value: UserAttributeEditorValue,
  ): UserAttributeStageResult {
    this.refusalSignal.set('');
    const existing = this.entryFor(cell.userId, cell.attribute);
    // An ordinary re-edit keeps the baseline that the edit began with, including null
    // (R1-D). A valid answer to a conflict compares against the preview's current value,
    // because that is the value that the person saw (B section 8.4).
    const reason = attributeValueError(entryDraft({ ...cell, value }));
    const resolvesConflict =
      !!existing && existing.currentValue !== undefined && !reason;
    const baseline = resolvesConflict
      ? (existing.currentValue ?? null)
      : existing
        ? existing.baseline
        : cell.baseline;
    const candidate: DraftCell = { ...cell, baseline, value };
    const result = attributeDraftResult(entryDraft(candidate), cell.userId);
    if (!result.changed) {
      if (existing) this.removeEntry(existing);
      return { ok: true, removed: true };
    }
    const users = new Set(this.entriesSignal().map((entry) => entry.userId));
    if (!users.has(cell.userId) && users.size >= USER_BY_IDS_LIMIT) {
      this.refusalSignal.set(ATTRIBUTE_DRAFT_USER_LIMIT_TEXT);
      return { ok: false, reason: 'user-limit' };
    }
    if (
      !existing &&
      this.entriesSignal().length >= USER_ATTRIBUTE_EDITS_LIMIT
    ) {
      this.refusalSignal.set(attributeDraftChangeLimitText());
      return { ok: false, reason: 'change-limit' };
    }
    const error = entryReason(candidate);
    // Invalid input keeps the conflict evidence, so a later correction returns the cell to
    // the conflict state (B section 8.4).
    const keepConflict = existing?.currentValue !== undefined && !!error;
    const entry: UserAttributeDraftEntry = {
      ...candidate,
      state: error ? (keepConflict ? 'conflict' : 'invalid') : 'pending',
      ...(keepConflict ? { currentValue: existing?.currentValue } : {}),
    };
    this.upsert(entry);
    return { ok: true, removed: false };
  }

  /** Stage one textual editor value, such as a text box or a number box. */
  stageText(
    row: UserRow,
    column: UserAttributeColumn,
    value: string,
  ): UserAttributeStageResult {
    return this.stage(cellFor(row, column), value);
  }

  /**
   * Stage a Yes or No answer, or an explicit Clear. No is a value, never an empty cell
   * (B section 12). A null answer is the Clear operation, so it never becomes No (R1-G).
   */
  stageBool(
    row: UserRow,
    column: UserAttributeColumn,
    value: boolean | null,
  ): UserAttributeStageResult {
    return this.stage(cellFor(row, column), value);
  }

  /** Stage an explicit Clear of one field (B section 12). */
  stageClear(
    row: UserRow,
    column: UserAttributeColumn,
  ): UserAttributeStageResult {
    return this.stage(cellFor(row, column), null);
  }

  /** Stage the list of the list editor dialog. An empty list stages Clear values. */
  stageList(
    row: UserRow,
    column: UserAttributeColumn,
    values: readonly string[],
  ): UserAttributeStageResult {
    return this.stage(cellFor(row, column), [...values]);
  }

  revert(userId: string, attribute: string): void {
    const entry = this.entryFor(userId, attribute);
    if (!entry) return;
    this.refusalSignal.set('');
    this.removeEntry(entry);
  }

  /** Revert all changes. The bar calls this once for the whole draft. */
  revertAll(): void {
    this.refusalSignal.set('');
    // The part is about to be removed, so an earlier restore warning no longer applies.
    this.restoreErrorSignal.set('');
    this.liveSignal.set(null);
    this.entriesSignal.set([]);
    this.persist();
  }

  /** Show the sentence of a refused save. The draft stays. */
  refuse(message: string): void {
    this.refusalSignal.set(message);
  }

  clearRefusal(): void {
    this.refusalSignal.set('');
  }

  /** Mark an entry as a conflict (B section 8.4). */
  markConflict(
    userId: string,
    attribute: string,
    currentValue: UserAttributeRowValue | null,
  ): void {
    const entry = this.entryFor(userId, attribute);
    if (!entry) return;
    this.upsert({ ...entry, state: 'conflict', currentValue });
  }

  /**
   * Mark the cells of a frozen preview. A conflict row carries the current value, and an
   * unchanged row leaves the draft because Google already holds the value (B section 8.4).
   * Returns the users of the unchanged rows, whose authoritative value the caller reads.
   */
  applyPreview(
    targets: readonly UserAttributeTarget[],
    submitted: readonly UserAttributeEdit[],
  ): string[] {
    const edits = new Map(
      submitted.map((edit) => [draftKey(edit), edit] as const),
    );
    const settled: string[] = [];
    const unchanged: string[] = [];
    for (const target of targets) {
      if (target.disposition === 'conflict')
        this.markConflict(target.userId, target.attribute, target.currentValue);
      else if (target.disposition === 'unchanged') {
        settled.push(draftKey(target));
        unchanged.push(target.userId);
      }
    }
    this.dropSubmitted(edits, settled);
    return [...new Set(unchanged)];
  }

  /**
   * Settle a confirmed save: every submitted entry whose value still equals the submitted
   * value leaves the draft, and a later edit stays (DRAFT-02). The submitted value stays on
   * screen until its row holds it or its owning job answers (design K26).
   */
  accept(submitted: readonly UserAttributeEdit[], displayId: string): void {
    const edits = new Map(
      submitted.map((edit) => [draftKey(edit), edit] as const),
    );
    const dropped = this.entriesSignal().filter((entry) => {
      const edit = edits.get(draftKey(entry));
      return edit ? entryHoldsEdit(entry, edit) : false;
    });
    this.dropSubmitted(
      edits,
      submitted.map((edit) => draftKey(edit)),
    );
    this.markSettled(dropped, displayId);
  }

  /** Keep the value of each saved cell on screen until its row answers the owning job. */
  private markSettled(
    entries: readonly UserAttributeDraftEntry[],
    displayId: string,
  ): void {
    if (!entries.length) return;
    const marks = entries.map((entry) => ({
      cell: {
        userId: entry.userId,
        userName: entry.userName,
        attribute: entry.attribute,
        label: entry.label,
        fieldType: entry.fieldType,
        multiValued: entry.multiValued,
        minValue: entry.minValue,
        maxValue: entry.maxValue,
        value: entry.value,
        baseline: entry.baseline,
      },
      text: entryText(entry),
      displayId,
      settled: false as const,
    }));
    const keys = new Set(marks.map(({ cell }) => draftKey(cell)));
    this.settledSignal.set([
      ...this.settledSignal().filter(({ cell }) => !keys.has(draftKey(cell))),
      ...marks,
    ]);
  }

  private dropSubmitted(
    edits: ReadonlyMap<string, UserAttributeEdit>,
    keys: readonly string[],
  ): void {
    const settled = new Set(keys);
    const remaining = this.entriesSignal().filter((entry) => {
      const key = draftKey(entry);
      if (!settled.has(key)) return true;
      const edit = edits.get(key);
      return edit ? !entryHoldsEdit(entry, edit) : false;
    });
    if (remaining.length !== this.entriesSignal().length) {
      this.entriesSignal.set(remaining);
      this.persist();
    }
  }

  /** The edit list of one save: every pending entry, one edit per user and attribute. */
  edits(): UserAttributeEdit[] {
    return this.entriesSignal()
      .filter((entry) => entry.state === 'pending')
      .slice()
      .sort((left, right) => {
        if (left.userId !== right.userId)
          return left.userId < right.userId ? -1 : 1;
        return left.attribute < right.attribute ? -1 : 1;
      })
      .flatMap((entry) => {
        const result = attributeDraftResult(entryDraft(entry), entry.userId);
        return result.edit ? [result.edit] : [];
      });
  }

  /** Restore this person's grid draft from the tab document. */
  restore(): void {
    const id = this.auth.session()?.identity.id ?? null;
    this.principal = id;
    this.entriesSignal.set([]);
    this.settledSignal.set([]);
    this.liveSignal.set(null);
    this.refusalSignal.set('');
    this.restoreErrorSignal.set('');
    this.writeErrorSignal.set('');
    if (!id) return;
    try {
      const raw = readUserDraftPart(id, 'grid');
      if (raw === null) return;
      const part = draftPartSchema.safeParse(raw);
      if (!part.success) {
        this.restoreErrorSignal.set(ATTRIBUTE_DRAFT_STORAGE_ERROR);
        return;
      }
      const { entries, skipped } = this.readEntries(part.data.entries);
      this.entriesSignal.set(entries);
      // One unreadable entry never hides the entries that do restore (DRAFT-01).
      if (skipped)
        this.restoreErrorSignal.set(attributeDraftRestoreError(skipped));
    } catch {
      this.restoreErrorSignal.set(ATTRIBUTE_DRAFT_STORAGE_ERROR);
    }
  }

  /** Validate one entry at a time and keep the first entry of each user and attribute. */
  private readEntries(items: readonly unknown[]): {
    entries: UserAttributeDraftEntry[];
    skipped: number;
  } {
    const entries: UserAttributeDraftEntry[] = [];
    const cells = new Set<string>();
    const users = new Set<string>();
    let skipped = 0;
    for (const item of items) {
      const parsed = entrySchema.safeParse(item);
      if (!parsed.success) {
        skipped += 1;
        continue;
      }
      const entry = restoredEntry(parsed.data);
      const key = draftKey(entry);
      if (cells.has(key)) {
        skipped += 1;
        continue;
      }
      if (!users.has(entry.userId) && users.size >= USER_BY_IDS_LIMIT) {
        skipped += 1;
        continue;
      }
      cells.add(key);
      users.add(entry.userId);
      entries.push(entry);
    }
    return { entries, skipped };
  }

  private upsert(entry: UserAttributeDraftEntry): void {
    const entries = this.entriesSignal();
    const key = draftKey(entry);
    const index = entries.findIndex((candidate) => draftKey(candidate) === key);
    this.entriesSignal.set(
      index === -1
        ? [...entries, entry]
        : entries.map((candidate, at) => (at === index ? entry : candidate)),
    );
    this.persist();
  }

  private removeEntry(entry: UserAttributeDraftEntry): void {
    const key = draftKey(entry);
    this.entriesSignal.set(
      this.entriesSignal().filter((candidate) => draftKey(candidate) !== key),
    );
    this.persist();
  }

  private persist(): void {
    const id = this.principal ?? this.auth.session()?.identity.id ?? null;
    if (!id) return;
    try {
      const entries = this.entriesSignal();
      writeUserDraftPart(id, 'grid', entries.length ? { entries } : null);
      this.writeErrorSignal.set('');
    } catch {
      this.writeErrorSignal.set(ATTRIBUTE_DRAFT_WRITE_ERROR);
    }
  }
}

/** The draft limit message of one save above 2,500 edits. */
export function attributeDraftChangeLimitText(): string {
  return `The draft holds at most ${USER_ATTRIBUTE_EDITS_LIMIT} changes. Revert a change before you stage another.`;
}

/** One restored entry, with its state read again from its value rules. */
function restoredEntry(
  entry: z.infer<typeof entrySchema>,
): UserAttributeDraftEntry {
  const reason = entryReason(entry);
  // A stored current value is unresolved conflict evidence. Keep it through invalid input
  // so a correction returns the entry to conflict (B section 8.4).
  const state: UserAttributeDraftState = reason
    ? 'invalid'
    : entry.currentValue !== undefined
      ? 'conflict'
      : 'pending';
  return {
    userId: entry.userId,
    userName: entry.userName,
    attribute: entry.attribute,
    label: entry.label,
    fieldType: entry.fieldType,
    multiValued: entry.multiValued,
    minValue: entry.minValue,
    maxValue: entry.maxValue,
    value: entry.value,
    baseline: entry.baseline,
    state,
    ...(entry.currentValue !== undefined
      ? { currentValue: entry.currentValue }
      : {}),
  };
}

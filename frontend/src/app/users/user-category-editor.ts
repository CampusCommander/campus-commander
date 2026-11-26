import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  Injector,
  OnInit,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
  type ElementRef,
} from '@angular/core';
import { CdkTrapFocus } from '@angular/cdk/a11y';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { MatTabsModule } from '@angular/material/tabs';
import { RouterLink } from '@angular/router';
import type {
  UserAttributeCategory,
  UserAttributeCategoryJobReceipt,
  UserAttributeCategoryPlan,
  UserAttributeCategoryPlanChange,
  UserAttributeCategoryPlanRequest,
  UserAttributeField,
  UserAttributeFieldType,
  UserAttributeLimits,
  UserAttributeRange,
  UserAttributeVisibility,
} from '@campus/application-contracts';
import { UserAttributeHelp } from './user-attribute-help';
import {
  ADD_ATTRIBUTE_LABEL,
  ATTRIBUTE_HELP_LABEL,
  ATTRIBUTES_LABEL,
  CLOSE_LABEL,
  COLUMN_ATTRIBUTE_NAME,
  COLUMN_DISPLAY_NAME,
  COLUMN_INFO_TYPE,
  COLUMN_MULTIPLE_VALUES,
  COLUMN_SEARCHABLE,
  COLUMN_VISIBILITY,
  FIELD_CATEGORY_NAME,
  FIELD_DISPLAY_NAME,
  RANGE_MAXIMUM_LABEL,
  RANGE_MINIMUM_LABEL,
} from './user-attribute-messages';
import {
  ALL_CHANGES_LABEL,
  ATTRIBUTE_DISPLAY_NAME_IN_USE,
  ATTRIBUTE_NAME_IN_USE,
  ATTRIBUTE_NAME_RULE,
  BACK_TO_EDITING_LABEL,
  CANCEL_LABEL,
  CATEGORY_CHANGED_TEXT,
  CATEGORY_NAME_HINT,
  CATEGORY_NAME_IN_USE,
  CHANGE_SET_RANGE_LABEL,
  changeChip,
  CHANGES_TABLE_LABEL,
  CLOSING_KEEPS_RUNNING_TEXT,
  COLUMN_ATTRIBUTE,
  COLUMN_CHANGE,
  COLUMN_EFFECT,
  COLUMN_OUTCOME,
  CONNECTION_REQUIRED_TEXT,
  CREATE_CATEGORY_TITLE,
  DELETING_LABEL,
  DELETE_CATEGORY_LABEL,
  DELETE_CATEGORY_TITLE,
  DISPLAY_NAME_REQUIRED,
  DOMAIN_CHANGE_TEXT,
  DOMAIN_CHANGES_TEXT,
  EDIT_AGAIN_LABEL,
  EDIT_CATEGORY_TITLE,
  FAILED_COUNT_LABEL,
  FAILED_LABEL,
  FIELD_TYPE_OPTIONS,
  JOB_LABEL,
  JOB_RUNNING_LABEL,
  JOB_UNREADABLE_TEXT,
  LAST_ATTRIBUTE_TEXT,
  MULTI_LOCK_REASON,
  NAME_LOCK_REASON,
  NO_FAILED_CHANGES,
  NO_USER_VALUES_CHANGE,
  NOT_FOUND_TEXT,
  NOT_RUN_COUNT_LABEL,
  PHRASE_MISMATCH_TEXT,
  PLAN_CHANGED_TEXT,
  PLAN_EXPIRED_TEXT,
  PLAN_NOT_PREPARED_TEXT,
  PROGRESS_LABEL,
  RESULT_COUNTS_LABEL,
  RESULTS_VIEW_LABEL,
  REVIEW_CHANGES_LABEL,
  SAVE_IN_GOOGLE_LABEL,
  SAVE_NOT_STARTED_TEXT,
  SAVE_UNCERTAIN_TEXT,
  SAVING_LABEL,
  SESSION_ENDED_TEXT,
  SUCCEEDED_COUNT_LABEL,
  UNKNOWN_COUNT_LABEL,
  UPDATE_CACHED_USERS_LABEL,
  VISIBILITY_OPTIONS,
  VISIBILITY_DELAY_TEXT,
  typeLabel,
  categoryFailureText,
  changeCountLabel,
  changesToText,
  confirmPhraseLabel,
  deletesAttributeValuesText,
  deletesValuesText,
  deriveAttributeName,
  errorCountText,
  finishedText,
  folded,
  jobStatusLabel,
  limitReachedText,
  outcomeLabel,
  phraseMismatchText,
  propertiesText,
  removesValuesText,
  removingValuesText,
  saveChangesLabel,
  usedAfterText,
  rangeText,
  visibilityLabel,
} from './user-category-messages';
import {
  boundChanged,
  draftRange,
  isRangeType,
  rangeDraftChanged,
  rangeFieldErrors,
  type RangeErrors,
} from './user-category-range';
import {
  UserCategoryFlow,
  type CategoryJob,
  type FlowFailure,
} from './user-category-flow';

/** One step of the flow: the editor, the review, the save, the result, or the delete question. */
type EditorStep = 'editor' | 'review' | 'saving' | 'result' | 'delete';

/** One attribute row of the editor. A removed cached row stays for its struck line (state 04). */
interface EditorRow {
  key: number;
  fieldId: string | null;
  fieldName: string;
  displayName: string;
  fieldType: UserAttributeFieldType;
  multiValued: boolean;
  indexed: boolean;
  readAccessType: UserAttributeVisibility;
  /** The raw text of the range line. An empty field means no bound (R2). */
  rangeMin: string;
  rangeMax: string;
  /** The cached range, for the pending surface and the clear rule (C3). */
  cachedRange: UserAttributeRange | null;
  holders: number;
  nameTouched: boolean;
  removed: boolean;
  /** The cached display name, for the C2 changed-name rule. */
  cachedDisplayName: string;
  /** The saved multi-value flag. Only a saved multi-value attribute is locked. */
  cachedMultiValued: boolean;
}

/** One field of the request that the review and the result describe. */
interface SubmittedField {
  fieldId: string | null;
  fieldName: string;
  displayName: string;
  fieldType: UserAttributeFieldType;
  /** The frozen range of a number attribute (K19). */
  numericIndexingSpec: UserAttributeRange | null;
}

/** The frozen request behind a review, so a pending edit cannot change its meaning. */
interface SubmittedSnapshot {
  kind: 'create-category' | 'edit-category';
  displayName: string;
  fields: readonly SubmittedField[];
}

/** One row of the review table and of the result table. */
interface ChangeRow {
  key: string;
  kind: 'rename' | 'added' | 'removed' | 'changed';
  label: string;
  tone: 'info' | 'success' | 'error';
  attribute: string;
  effect: string;
}

const NAME_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;
const DISPLAY_NAME_MAX = 200;
const FINAL_STATUSES = new Set<CategoryJob['status']>([
  'completed',
  'completed-with-errors',
  'failed',
  'needs-review',
  'cancelled',
]);
const JOB_POLL_MS = 1500;
const JOB_POLL_FIRST_MS = 250;

/**
 * The category editor of CA states 02 to 08, 10, and 12. One dialog holds the editor,
 * the review with its typed phrase, the saving phases, the result, and the delete
 * question. The flow ends here; the job link is the only path to the job page.
 */
@Component({
  selector: 'app-user-category-editor',
  imports: [
    CdkTrapFocus,
    MatButtonModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatInputModule,
    MatProgressBarModule,
    MatSelectModule,
    MatTabsModule,
    RouterLink,
    UserAttributeHelp,
  ],
  templateUrl: './user-category-editor.html',
  styleUrls: [
    '../devices/device-dialog.css',
    './user-category-editor.css',
    './user-category-editor-report.css',
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UserCategoryEditor implements OnInit {
  private readonly flow = inject(UserCategoryFlow);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);

  /** The create editor, or the editor of one cached category. */
  readonly mode = input.required<'create' | 'edit'>();
  readonly category = input<UserAttributeCategory | null>(null);
  readonly limits = input.required<UserAttributeLimits>();
  /** The cached categories, for the repeated category name of CA state 03. */
  readonly categories = input<readonly UserAttributeCategory[]>([]);
  readonly closed = output<void>();

  private readonly stepTitle = viewChild<ElementRef<HTMLElement>>('stepTitle');
  private readonly reviewPhrase =
    viewChild<ElementRef<HTMLInputElement>>('reviewPhrase');
  private readonly deletePhrase =
    viewChild<ElementRef<HTMLInputElement>>('deletePhrase');

  protected readonly step = signal<EditorStep>('editor');
  protected readonly busy = signal(false);
  protected readonly categoryDisplay = signal('');
  protected readonly categoryName = signal('');
  protected readonly categoryNameTouched = signal(false);
  protected readonly rows = signal<readonly EditorRow[]>([]);
  /** The first Review attempt shows the rules; every later edit recomputes them. */
  private readonly errorCheck = signal(false);
  private readonly serverCategoryDisplayError = signal('');
  private readonly serverCategoryNameError = signal('');
  private readonly serverDisplayError = signal<{
    key: number;
    text: string;
  } | null>(null);
  protected readonly formError = signal('');
  /** The delete phrase. The review gate owns one phrase for each removed attribute. */
  protected readonly phrase = signal('');
  protected readonly phraseError = signal('');
  protected readonly removalPhrases = signal<ReadonlyMap<string, string>>(
    new Map(),
  );
  private readonly serverPhraseError = signal('');
  protected readonly plan = signal<UserAttributeCategoryPlan | null>(null);
  /** The request that the review and the result describe, frozen at Review. */
  private readonly submitted = signal<SubmittedSnapshot | null>(null);
  protected readonly receipt = signal<UserAttributeCategoryJobReceipt | null>(
    null,
  );
  protected readonly job = signal<CategoryJob | null>(null);
  protected readonly jobUnreadable = signal(false);
  protected readonly planDead = signal(false);
  protected readonly resultTab = signal<'all' | 'failed'>('all');
  protected readonly helpOpen = signal(false);
  protected readonly baseDisplayName = signal('');

  private nextKey = 1;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private alive = true;

  protected readonly ADD_ATTRIBUTE_LABEL = ADD_ATTRIBUTE_LABEL;
  protected readonly ATTRIBUTE_HELP_LABEL = ATTRIBUTE_HELP_LABEL;
  protected readonly ATTRIBUTES_LABEL = ATTRIBUTES_LABEL;
  protected readonly CLOSE_LABEL = CLOSE_LABEL;
  protected readonly COLUMN_ATTRIBUTE_NAME = COLUMN_ATTRIBUTE_NAME;
  protected readonly COLUMN_DISPLAY_NAME = COLUMN_DISPLAY_NAME;
  protected readonly COLUMN_INFO_TYPE = COLUMN_INFO_TYPE;
  protected readonly COLUMN_MULTIPLE_VALUES = COLUMN_MULTIPLE_VALUES;
  protected readonly COLUMN_SEARCHABLE = COLUMN_SEARCHABLE;
  protected readonly COLUMN_VISIBILITY = COLUMN_VISIBILITY;
  protected readonly FIELD_CATEGORY_NAME = FIELD_CATEGORY_NAME;
  protected readonly FIELD_DISPLAY_NAME = FIELD_DISPLAY_NAME;
  protected readonly CATEGORY_NAME_HINT = CATEGORY_NAME_HINT;
  protected readonly NAME_LOCK_REASON = NAME_LOCK_REASON;
  protected readonly MULTI_LOCK_REASON = MULTI_LOCK_REASON;
  protected readonly CANCEL_LABEL = CANCEL_LABEL;
  protected readonly REVIEW_CHANGES_LABEL = REVIEW_CHANGES_LABEL;
  protected readonly BACK_TO_EDITING_LABEL = BACK_TO_EDITING_LABEL;
  protected readonly DELETE_CATEGORY_LABEL = DELETE_CATEGORY_LABEL;
  protected readonly DELETE_CATEGORY_TITLE = DELETE_CATEGORY_TITLE;
  protected readonly DOMAIN_CHANGE_TEXT = DOMAIN_CHANGE_TEXT;
  protected readonly EDIT_AGAIN_LABEL = EDIT_AGAIN_LABEL;
  protected readonly DELETING_LABEL = DELETING_LABEL;
  protected readonly SAVING_LABEL = SAVING_LABEL;
  protected readonly CLOSING_KEEPS_RUNNING_TEXT = CLOSING_KEEPS_RUNNING_TEXT;
  protected readonly PROGRESS_LABEL = PROGRESS_LABEL;
  protected readonly SAVE_IN_GOOGLE_LABEL = SAVE_IN_GOOGLE_LABEL;
  protected readonly UPDATE_CACHED_USERS_LABEL = UPDATE_CACHED_USERS_LABEL;
  protected readonly VISIBILITY_DELAY_TEXT = VISIBILITY_DELAY_TEXT;
  protected readonly COLUMN_CHANGE = COLUMN_CHANGE;
  protected readonly COLUMN_ATTRIBUTE = COLUMN_ATTRIBUTE;
  protected readonly COLUMN_EFFECT = COLUMN_EFFECT;
  protected readonly COLUMN_OUTCOME = COLUMN_OUTCOME;
  protected readonly CHANGES_TABLE_LABEL = CHANGES_TABLE_LABEL;
  protected readonly RESULTS_VIEW_LABEL = RESULTS_VIEW_LABEL;
  protected readonly RESULT_COUNTS_LABEL = RESULT_COUNTS_LABEL;
  protected readonly ALL_CHANGES_LABEL = ALL_CHANGES_LABEL;
  protected readonly FAILED_LABEL = FAILED_LABEL;
  protected readonly NO_FAILED_CHANGES = NO_FAILED_CHANGES;
  protected readonly SUCCEEDED_COUNT_LABEL = SUCCEEDED_COUNT_LABEL;
  protected readonly FAILED_COUNT_LABEL = FAILED_COUNT_LABEL;
  protected readonly UNKNOWN_COUNT_LABEL = UNKNOWN_COUNT_LABEL;
  protected readonly NOT_RUN_COUNT_LABEL = NOT_RUN_COUNT_LABEL;
  protected readonly FIELD_TYPE_OPTIONS = FIELD_TYPE_OPTIONS;
  protected readonly VISIBILITY_OPTIONS = VISIBILITY_OPTIONS;
  protected readonly RANGE_MINIMUM_LABEL = RANGE_MINIMUM_LABEL;
  protected readonly RANGE_MAXIMUM_LABEL = RANGE_MAXIMUM_LABEL;
  protected readonly JOB_LABEL = JOB_LABEL;
  protected readonly DISPLAY_NAME_MAX = DISPLAY_NAME_MAX;

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.alive = false;
      this.stopPolling();
    });
  }

  ngOnInit(): void {
    const category = this.category();
    if (this.mode() === 'create') {
      this.categoryDisplay.set('');
      this.categoryName.set('');
      this.categoryNameTouched.set(false);
      this.rows.set([this.newRow()]);
      this.baseDisplayName.set('');
      return;
    }
    if (!category) return;
    this.categoryDisplay.set(category.displayName);
    this.categoryName.set(category.schemaName);
    this.categoryNameTouched.set(true);
    this.baseDisplayName.set(category.displayName);
    this.rows.set(category.fields.map((field) => this.cachedRow(field)));
  }

  /** The title of the open step. A confirmed delete names its saving step and result. */
  protected readonly title = computed(() => {
    if (this.step() === 'delete') return DELETE_CATEGORY_TITLE;
    if (
      (this.step() === 'saving' || this.step() === 'result') &&
      this.receipt()?.action === 'delete-category'
    )
      return DELETE_CATEGORY_TITLE;
    return this.mode() === 'create'
      ? CREATE_CATEGORY_TITLE
      : EDIT_CATEGORY_TITLE;
  });

  /** The job that the save started, or an empty string before one. */
  protected readonly jobDisplayId = computed(
    () => this.receipt()?.displayId ?? '',
  );

  /** The words after the job link in the sub line (states 06 and 07). */
  protected readonly jobSublineTail = computed(() => {
    const job = this.job();
    const status = job ? jobStatusLabel(job.status) : JOB_RUNNING_LABEL;
    if (this.step() === 'saving') return status;
    const plan = this.plan();
    const category = plan?.displayName ?? this.categoryDisplay();
    return `${status} · ${category}`;
  });

  protected readonly subline = computed(() => {
    if (this.step() === 'review')
      return this.plan()?.displayName ?? this.baseDisplayName();
    if (this.step() === 'delete') return this.deleteIdentity();
    if (this.step() === 'editor') return this.baseDisplayName();
    return '';
  });

  protected readonly wide = computed(
    () => this.step() !== 'saving' && this.step() !== 'delete',
  );

  protected readonly visibleRows = computed(() =>
    this.rows().filter((row) => !row.removed),
  );

  protected readonly removedRows = computed(() =>
    this.rows().filter((row) => row.removed),
  );

  protected readonly addedCount = computed(
    () => this.visibleRows().filter((row) => row.fieldId === null).length,
  );

  protected readonly usedAfter = computed(() => {
    const added = this.addedCount();
    if (this.mode() === 'create') return this.limits().attributes + added;
    const removed = this.removedRows().filter(
      (row) => row.fieldId !== null,
    ).length;
    return this.limits().attributes - removed + added;
  });

  protected readonly atLimit = computed(
    () => this.usedAfter() >= this.limits().attributeLimit,
  );

  protected readonly limitLine = computed(() =>
    this.atLimit()
      ? limitReachedText(this.limits().attributeLimit)
      : usedAfterText(this.usedAfter(), this.limits().attributeLimit),
  );

  /** The category display name is required (B section 5, the field pattern of state 03). */
  protected readonly categoryDisplayError = computed(() => {
    if (this.serverCategoryDisplayError())
      return this.serverCategoryDisplayError();
    return this.errorCheck() && !this.categoryDisplay().trim()
      ? DISPLAY_NAME_REQUIRED
      : '';
  });

  /** A category name follows E1 and differs from every cached category name. */
  protected readonly categoryNameError = computed(() => {
    if (this.serverCategoryNameError()) return this.serverCategoryNameError();
    if (!this.errorCheck() || this.mode() !== 'create') return '';
    const name = this.categoryName().trim();
    if (!NAME_PATTERN.test(name)) return ATTRIBUTE_NAME_RULE;
    return this.categories().some(
      (category) => folded(category.schemaName) === folded(name),
    )
      ? CATEGORY_NAME_IN_USE
      : '';
  });

  /**
   * C2: a new or changed display name differs from every other display name of its
   * category. The first unchanged row keeps its name. Every other changed row in a
   * collision names the rule, so a changed first row is reported like a changed later
   * row. In a create every row is new, so the later row is named (CA state 03).
   */
  protected readonly displayErrors = computed<ReadonlyMap<number, string>>(
    () => {
      const errors = new Map<number, string>();
      if (!this.errorCheck()) return errors;
      const visible = this.visibleRows();
      for (const row of visible) {
        if (!row.displayName.trim()) errors.set(row.key, DISPLAY_NAME_REQUIRED);
      }
      const groups = new Map<string, EditorRow[]>();
      for (const row of visible) {
        const name = folded(row.displayName);
        if (!name) continue;
        groups.set(name, [...(groups.get(name) ?? []), row]);
      }
      for (const group of groups.values()) {
        if (group.length < 2) continue;
        const keeper =
          group.find((row) => !this.rowNameChanged(row)) ?? group[0];
        for (const row of group) {
          if (row.key !== keeper.key && this.rowNameChanged(row))
            errors.set(row.key, ATTRIBUTE_DISPLAY_NAME_IN_USE);
        }
      }
      const server = this.serverDisplayError();
      if (server && visible.some((row) => row.key === server.key))
        errors.set(server.key, server.text);
      return errors;
    },
  );

  /** E1 for a new attribute, and the unique attribute name of B section 5. */
  protected readonly nameErrors = computed<ReadonlyMap<number, string>>(() => {
    const errors = new Map<number, string>();
    if (!this.errorCheck()) return errors;
    const visible = this.visibleRows();
    const display = this.displayErrors();
    const kept = new Set(
      visible
        .filter((row) => row.fieldId !== null)
        .map((row) => row.fieldName.toLowerCase()),
    );
    const added = new Set<string>();
    for (const row of visible) {
      if (row.fieldId !== null) continue;
      // An empty display name already marks the row, and its derived name is empty too.
      if (display.get(row.key) === DISPLAY_NAME_REQUIRED) continue;
      const name = row.fieldName.trim();
      if (!NAME_PATTERN.test(name)) {
        errors.set(row.key, ATTRIBUTE_NAME_RULE);
        continue;
      }
      const lower = name.toLowerCase();
      if (kept.has(lower) || added.has(lower)) {
        errors.set(row.key, ATTRIBUTE_NAME_IN_USE);
        continue;
      }
      added.add(lower);
    }
    return errors;
  });

  /**
   * K19: each range field checks its own rule. The maximum also carries the order
   * rule, and it names the minimum (state 14). An empty field means no bound.
   */
  protected readonly rangeErrorMap = computed<ReadonlyMap<number, RangeErrors>>(
    () => {
      const errors = new Map<number, RangeErrors>();
      if (!this.errorCheck()) return errors;
      for (const row of this.visibleRows()) {
        if (!isRangeType(row.fieldType)) continue;
        const result = rangeFieldErrors(row.fieldType, {
          min: row.rangeMin,
          max: row.rangeMax,
        });
        if (result.min || result.max) errors.set(row.key, result);
      }
      return errors;
    },
  );

  protected readonly errorCount = computed(() => {
    let count = this.displayErrors().size + this.nameErrors().size;
    for (const errors of this.rangeErrorMap().values()) {
      if (errors.min) count += 1;
      if (errors.max) count += 1;
    }
    if (this.categoryDisplayError()) count += 1;
    if (this.categoryNameError()) count += 1;
    return count;
  });

  protected readonly errorCountText = computed(() =>
    this.errorCount() ? errorCountText(this.errorCount()) : '',
  );

  /**
   * An edit whose draft changes nothing cannot prepare a plan (B section 5). An
   * invalid range bound counts as a change, so its diagnostic is reachable (R1).
   */
  protected readonly changed = computed(() => {
    if (this.mode() === 'create') return this.visibleRows().length > 0;
    const category = this.category();
    if (!category) return false;
    if (this.categoryDisplay().trim() !== category.displayName) return true;
    const visible = this.visibleRows();
    if (visible.length !== category.fields.length) return true;
    return visible.some((row) => {
      const cached = category.fields.find(
        (field) => field.fieldId === row.fieldId,
      );
      return (
        !cached ||
        row.displayName.trim() !== cached.displayName ||
        row.multiValued !== cached.multiValued ||
        row.indexed !== cached.indexed ||
        row.readAccessType !== cached.readAccessType ||
        (isRangeType(row.fieldType) &&
          rangeDraftChanged(
            row.fieldType,
            { min: row.rangeMin, max: row.rangeMax },
            row.cachedRange,
          ))
      );
    });
  });

  protected readonly reviewDisabled = computed(
    () =>
      this.busy() ||
      (this.errorCheck() && this.errorCount() > 0) ||
      !this.changed() ||
      this.usedAfter() > this.limits().attributeLimit,
  );

  protected readonly addDisabled = computed(
    () => this.usedAfter() >= this.limits().attributeLimit,
  );

  /** E18: a category needs one attribute, so the last row cannot go. */
  protected readonly canRemove = computed(() => this.visibleRows().length > 1);

  protected readonly lastAttributeNote = computed(() =>
    this.mode() === 'edit' && !this.canRemove() ? LAST_ATTRIBUTE_TEXT : '',
  );

  protected readonly visibilityChanged = computed(() => {
    const category = this.category();
    if (!category) return false;
    return this.visibleRows().some((row) => {
      const cached = category.fields.find(
        (field) => field.fieldId === row.fieldId,
      );
      return !!cached && row.readAccessType !== cached.readAccessType;
    });
  });

  /** Every removed attribute names its own phrase (B section 5). */
  protected readonly phraseMatches = computed(() => {
    const plan = this.plan();
    if (!plan) return false;
    const removals = this.removals();
    if (!removals.length) return true;
    const typed = this.removalPhrases();
    return removals.every(
      (removal) => (typed.get(removal.key) ?? '').trim() === removal.name,
    );
  });

  /** The stable name of the delete question: the cached label or the frozen phrase. */
  protected readonly deleteIdentity = computed(() => {
    const plan = this.plan();
    if (plan?.kind === 'delete-category' && plan.phrase) return plan.phrase;
    return this.baseDisplayName() || this.category()?.displayName || '';
  });

  /** The delete question compares the cached category display name (default 1). */
  protected readonly deletePhraseInvalid = computed(() => {
    const typed = this.phrase().trim();
    return typed.length > 0 && !this.deletePhraseMatches();
  });

  protected readonly deletePhraseErrorText = computed(() => {
    if (this.phraseError()) return this.phraseError();
    return this.deletePhraseInvalid()
      ? phraseMismatchText(this.deleteIdentity())
      : '';
  });

  protected readonly changesLine = computed(() =>
    changesToText(this.changeCount(), this.plan()?.displayName ?? ''),
  );

  protected readonly saveLabel = computed(() =>
    saveChangesLabel(this.changeCount()),
  );

  /** The noun of the change count: one change is a Change (CA state 07). */
  protected readonly changeCountText = computed(() =>
    changeCountLabel(this.changeCount()),
  );

  protected readonly changeCount = computed(() => {
    const plan = this.plan();
    if (!plan) return 0;
    const renamed =
      plan.kind === 'edit-category' &&
      plan.displayName !== this.baseDisplayName();
    return plan.changes.length + (renamed ? 1 : 0);
  });

  protected readonly domainText = computed(() =>
    this.changeCount() === 1 ? DOMAIN_CHANGE_TEXT : DOMAIN_CHANGES_TEXT,
  );

  protected readonly reviewRows = computed<readonly ChangeRow[]>(() => {
    const plan = this.plan();
    if (!plan) return [];
    return this.changeRows(plan);
  });

  // The job answers one status for the whole plan, not one for each change. A
  // failed save lists every change, because Google reports no per-change result.
  protected readonly failedRows = computed(() =>
    this.outcome() === 'failed' ? this.reviewRows() : [],
  );

  protected readonly shownRows = computed(() =>
    this.resultTab() === 'failed' ? this.failedRows() : this.reviewRows(),
  );

  protected readonly outcome = computed<
    'succeeded' | 'failed' | 'unknown' | 'cancelled' | null
  >(() => {
    const status = this.job()?.status;
    if (status === 'completed') return 'succeeded';
    if (status === 'failed' || status === 'completed-with-errors')
      return 'failed';
    if (status === 'needs-review') return 'unknown';
    if (status === 'cancelled') return 'cancelled';
    return null;
  });

  protected readonly succeededCount = computed(() =>
    this.outcome() === 'succeeded' ? this.changeCount() : 0,
  );

  protected readonly failedCount = computed(() =>
    this.outcome() === 'failed' ? this.changeCount() : 0,
  );

  protected readonly unknownCount = computed(() =>
    this.outcome() === 'unknown' ? this.changeCount() : 0,
  );

  protected readonly notRunCount = computed(() =>
    this.outcome() === 'cancelled' ? this.changeCount() : 0,
  );

  protected readonly resultFailure = computed(() => {
    const job = this.job();
    if (!job) return '';
    if (
      job.status === 'failed' ||
      job.status === 'completed-with-errors' ||
      job.status === 'needs-review'
    )
      return categoryFailureText(job.failure, job.status);
    return '';
  });

  protected readonly canEditAgain = computed(() => {
    const job = this.job();
    return (
      !!job &&
      job.failure === 'name-in-use' &&
      this.plan()?.kind !== 'delete-category'
    );
  });

  protected readonly finishedLine = computed(() => {
    const finishedAt = this.job()?.finishedAt;
    return finishedAt ? finishedText(finishedAt) : '';
  });

  protected readonly savingState = computed(() =>
    this.jobUnreadable() ? JOB_UNREADABLE_TEXT : CLOSING_KEEPS_RUNNING_TEXT,
  );

  protected label(row: EditorRow): string {
    return row.displayName.trim() || row.fieldName || 'new attribute';
  }

  protected errorFor(row: EditorRow): string {
    return (
      this.displayErrors().get(row.key) ?? this.nameErrors().get(row.key) ?? ''
    );
  }

  protected displayErrorFor(row: EditorRow): string {
    return this.displayErrors().get(row.key) ?? '';
  }

  protected nameErrorFor(row: EditorRow): string {
    return this.nameErrors().get(row.key) ?? '';
  }

  protected rowId(row: EditorRow, part: string): string {
    return `category-${part}-${row.key}`;
  }

  protected removalErrorId(key: string): string {
    return `category-removal-error-${key}`;
  }

  protected setCategoryDisplay(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.categoryDisplay.set(value);
    this.serverCategoryDisplayError.set('');
    if (!this.categoryNameTouched() && this.mode() === 'create') {
      const derived = deriveAttributeName(value);
      // The refusal names the old derived name. A changed derived name is a new
      // candidate, and the local rule of `categoryNameError` checks it again.
      if (derived !== this.categoryName()) this.serverCategoryNameError.set('');
      this.categoryName.set(derived);
    }
  }

  protected setCategoryName(event: Event): void {
    this.categoryNameTouched.set(true);
    this.serverCategoryNameError.set('');
    this.categoryName.set((event.target as HTMLInputElement).value);
  }

  protected setDisplayName(row: EditorRow, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    if (this.serverDisplayError()?.key === row.key)
      this.serverDisplayError.set(null);
    this.updateRow(row, {
      displayName: value,
      ...(row.nameTouched || row.fieldId !== null
        ? {}
        : { fieldName: deriveAttributeName(value) }),
    });
  }

  protected setFieldName(row: EditorRow, event: Event): void {
    this.updateRow(row, {
      fieldName: (event.target as HTMLInputElement).value,
      nameTouched: true,
    });
  }

  protected setType(row: EditorRow, value: UserAttributeFieldType): void {
    this.updateRow(row, {
      fieldType: value,
      rangeMin: '',
      rangeMax: '',
    });
  }

  /** Only an attribute that Google already holds as multi-value is locked (B section 5). */
  protected multiLocked(row: EditorRow): boolean {
    return row.fieldId !== null && row.cachedMultiValued;
  }

  protected setMulti(row: EditorRow, checked: boolean): void {
    if (this.multiLocked(row) && !checked) return;
    this.updateRow(row, { multiValued: checked });
  }

  protected setIndexed(row: EditorRow, checked: boolean): void {
    this.updateRow(row, { indexed: checked });
  }

  protected setVisibility(
    row: EditorRow,
    value: UserAttributeVisibility,
  ): void {
    this.updateRow(row, { readAccessType: value });
  }

  protected addAttribute(): void {
    if (this.addDisabled()) return;
    this.rows.set([...this.rows(), this.newRow()]);
  }

  /** A cached attribute is marked for removal; a new row is dropped (CA state 04). */
  protected removeAttribute(row: EditorRow): void {
    // E18: the last attribute stays, and its category is the thing to delete.
    if (!this.canRemove()) return;
    if (this.serverDisplayError()?.key === row.key)
      this.serverDisplayError.set(null);
    if (row.fieldId === null) {
      this.rows.set(this.rows().filter((item) => item.key !== row.key));
      return;
    }
    this.updateRow(row, { removed: true });
  }

  protected keepAttribute(row: EditorRow): void {
    this.updateRow(row, { removed: false });
  }

  protected typeLabel(row: EditorRow): string {
    return typeLabel(row.fieldType);
  }

  protected visibilityLabel(row: EditorRow): string {
    return visibilityLabel(row.readAccessType);
  }

  /** The cached visibility of a kept row, for the changed-field surface (state 12). */
  protected visibilityOf(row: EditorRow): UserAttributeVisibility {
    return (
      this.category()?.fields.find((field) => field.fieldId === row.fieldId)
        ?.readAccessType ?? row.readAccessType
    );
  }

  /** The number of one visible row, for a stable accessible name of its fields. */
  protected rowNumber(row: EditorRow): number {
    return this.visibleRows().findIndex((item) => item.key === row.key) + 1;
  }

  /** Whether the row draws the range line (composition choice 1). */
  protected isRangeRow(row: EditorRow): boolean {
    return isRangeType(row.fieldType);
  }

  /** The accessible name of one bound: the attribute, then the label. */
  protected rangeLabel(row: EditorRow, bound: string): string {
    const name =
      row.displayName.trim() ||
      row.fieldName.trim() ||
      `Attribute ${this.rowNumber(row)}`;
    return `${name} ${bound.toLowerCase()}`;
  }

  protected rangeInputMode(row: EditorRow): 'numeric' | 'decimal' {
    return row.fieldType === 'INT64' ? 'numeric' : 'decimal';
  }

  protected rangeMinErrorFor(row: EditorRow): string {
    return this.rangeErrorMap().get(row.key)?.min ?? '';
  }

  protected rangeMaxErrorFor(row: EditorRow): string {
    return this.rangeErrorMap().get(row.key)?.max ?? '';
  }

  /** A cached bound that moves takes the pending surface of state 12. */
  protected rangeBoundChanged(row: EditorRow, bound: 'min' | 'max'): boolean {
    if (row.fieldId === null) return false;
    const cached =
      bound === 'min'
        ? (row.cachedRange?.minValue ?? null)
        : (row.cachedRange?.maxValue ?? null);
    return boundChanged(
      row.fieldType,
      bound === 'min' ? row.rangeMin : row.rangeMax,
      cached,
    );
  }

  protected setRangeMin(row: EditorRow, event: Event): void {
    this.updateRow(row, {
      rangeMin: (event.target as HTMLInputElement).value,
    });
  }

  protected setRangeMax(row: EditorRow, event: Event): void {
    this.updateRow(row, {
      rangeMax: (event.target as HTMLInputElement).value,
    });
  }

  protected removesText(row: EditorRow): string {
    return removesValuesText(row.holders);
  }

  protected setPhrase(event: Event): void {
    this.phrase.set((event.target as HTMLInputElement).value);
    if (this.phraseError()) this.phraseError.set('');
  }

  /** One typed phrase for each removed attribute (B section 5). */
  protected setRemovalPhrase(key: string, event: Event): void {
    this.removalPhrases.set(
      new Map(this.removalPhrases()).set(
        key,
        (event.target as HTMLInputElement).value,
      ),
    );
    if (this.serverPhraseError()) this.serverPhraseError.set('');
  }

  protected removalPhrase(key: string): string {
    return this.removalPhrases().get(key) ?? '';
  }

  protected removalLabel(removal: { name: string }): string {
    return confirmPhraseLabel(removal.name);
  }

  /** A differing phrase names the rule under its own field. */
  protected removalError(key: string): string {
    const removal = this.removals().find((item) => item.key === key);
    if (!removal) return '';
    const typed = this.removalPhrase(key).trim();
    if (typed.length > 0 && typed !== removal.name)
      return phraseMismatchText(removal.name);
    if (key === this.removals()[0]?.key) return this.serverPhraseError();
    return '';
  }

  protected setResultTab(tab: 'all' | 'failed'): void {
    this.resultTab.set(tab);
  }

  protected changeKindLabel(row: ChangeRow): string {
    return row.label;
  }

  protected outcomeText(): string {
    return outcomeLabel(this.outcome() ?? 'cancelled');
  }

  /**
   * Review changes: check the draft, then freeze the plan (CA state 05). A rule that
   * the API refuses moves back into the editor with its field or its form error.
   */
  protected async review(): Promise<void> {
    if (this.reviewDisabled()) return;
    // The first attempt shows the rules; a later edit clears them without another attempt.
    this.errorCheck.set(true);
    if (this.errorCount() > 0) return;
    const request = this.planRequest();
    this.submitted.set({
      kind: request.kind,
      displayName: request.draft.displayName,
      fields: request.draft.fields.map((field) => ({
        fieldId: field.fieldId,
        fieldName: field.fieldName,
        displayName: field.displayName,
        fieldType: field.fieldType,
        numericIndexingSpec: field.numericIndexingSpec,
      })),
    });
    this.busy.set(true);
    this.formError.set('');
    const result = await this.flow.prepare(request);
    if (!this.alive) return;
    this.busy.set(false);
    if (!result.ok) {
      this.planFailure(result.status, result.reason);
      return;
    }
    this.plan.set(result.plan);
    this.removalPhrases.set(new Map());
    this.serverPhraseError.set('');
    this.planDead.set(false);
    this.resultTab.set('all');
    this.step.set('review');
    this.focusStep(!!result.plan.phrase);
  }

  protected backToEditing(): void {
    this.step.set('editor');
    this.formError.set('');
    this.planDead.set(false);
    this.removalPhrases.set(new Map());
    this.serverPhraseError.set('');
    this.focusStep();
  }

  /** Save the frozen plan with a typed phrase for each removed attribute. */
  protected async save(): Promise<void> {
    const plan = this.plan();
    if (!plan || this.busy() || this.planDead()) return;
    if (!this.phraseMatches()) {
      this.serverPhraseError.set(PHRASE_MISMATCH_TEXT);
      return;
    }
    const removals = this.removals();
    const typedPhrase =
      plan.phrase === null
        ? null
        : (this.removalPhrases().get(removals[0]?.key ?? '') ?? '').trim();
    this.busy.set(true);
    this.formError.set('');
    const result = await this.flow.confirm(
      plan.planId,
      plan.digest,
      typedPhrase,
    );
    if (!this.alive) return;
    this.busy.set(false);
    if (!result.ok) {
      this.confirmFailure(result);
      return;
    }
    this.startSave(result.receipt);
  }

  /** The delete question of CA state 08. */
  protected askDelete(): void {
    this.phrase.set('');
    this.phraseError.set('');
    this.formError.set('');
    this.step.set('delete');
    this.focusStep(true);
  }

  protected cancelDelete(): void {
    this.phrase.set('');
    this.phraseError.set('');
    this.formError.set('');
    this.step.set('editor');
    this.focusStep();
  }

  /** The delete phrase compares the cached category label, not the draft rename. */
  protected deletePhraseMatches(): boolean {
    return this.phrase().trim() === this.deleteIdentity().trim();
  }

  /**
   * Delete: freeze the delete plan, then confirm it with the typed category name. A
   * plan whose answer was lost stays unresolved, and a retry replays that same plan so
   * the server keeps its one-job protection.
   */
  protected async deleteCategory(): Promise<void> {
    const category = this.category();
    if (!category || this.busy()) return;
    if (!this.deletePhraseMatches()) {
      this.phraseError.set(phraseMismatchText(this.deleteIdentity()));
      return;
    }
    this.busy.set(true);
    this.formError.set('');
    const retained = this.plan();
    const reusable =
      retained?.kind === 'delete-category' && !this.planDead()
        ? retained
        : null;
    let plan = reusable;
    if (!plan) {
      const prepared = await this.flow.prepare({
        kind: 'delete-category',
        schemaId: category.schemaId,
        baseEtag: category.etag,
      });
      if (!this.alive) return;
      if (!prepared.ok) {
        this.busy.set(false);
        this.formError.set(
          this.planFailureText(prepared.status, prepared.reason),
        );
        return;
      }
      plan = prepared.plan;
      this.plan.set(plan);
      // Validity belongs to the plan, not to the dialog: a new plan can be replayed
      // after an uncertain answer, even when an earlier plan expired.
      this.planDead.set(false);
    }
    const result = await this.flow.confirm(
      plan.planId,
      plan.digest,
      this.phrase().trim(),
    );
    if (!this.alive) return;
    this.busy.set(false);
    if (!result.ok) {
      this.confirmFailure(result);
      return;
    }
    this.startSave(result.receipt);
  }

  /** A failed save offers Edit again for the taken name (B section 13). */
  protected editAgain(): void {
    this.plan.set(null);
    this.receipt.set(null);
    this.job.set(null);
    this.jobUnreadable.set(false);
    this.phrase.set('');
    this.phraseError.set('');
    this.formError.set('');
    this.planDead.set(false);
    this.resultTab.set('all');
    this.serverCategoryNameError.set(
      this.mode() === 'create' ? CATEGORY_NAME_IN_USE : '',
    );
    this.step.set('editor');
    this.focusStep();
  }

  protected close(): void {
    this.stopPolling();
    this.closed.emit();
  }

  /** Escape and the scrim close the dialog, except while a phrase or plan request runs. */
  protected dismiss(): void {
    this.close();
  }

  protected keydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    this.close();
  }

  /**
   * The plan request of the draft. The review and the shared plan contract cannot see
   * the delete question, which prepares its own request.
   */
  private planRequest():
    | Extract<UserAttributeCategoryPlanRequest, { kind: 'create-category' }>
    | Extract<UserAttributeCategoryPlanRequest, { kind: 'edit-category' }> {
    const fields = this.visibleRows().map((row) => ({
      fieldId: row.fieldId,
      fieldName: row.fieldName.trim(),
      displayName: row.displayName.trim(),
      fieldType: row.fieldType,
      multiValued: row.multiValued,
      indexed: row.indexed,
      readAccessType: row.readAccessType,
      numericIndexingSpec: this.rangeValue(row),
    }));
    if (this.mode() === 'create') {
      return {
        kind: 'create-category',
        draft: {
          schemaName: this.categoryName().trim(),
          displayName: this.categoryDisplay().trim(),
          fields,
        },
      };
    }
    const category = this.category();
    if (!category) throw new Error('The edit names no category.');
    return {
      kind: 'edit-category',
      schemaId: category.schemaId,
      baseEtag: category.etag,
      draft: { displayName: this.categoryDisplay().trim(), fields },
    };
  }

  /** Whether a new or changed display name collides with another visible row. */
  private rowNameChanged(row: EditorRow): boolean {
    return (
      row.fieldId === null || row.displayName.trim() !== row.cachedDisplayName
    );
  }

  /** The changed or new row that the server refused for C2, or null. */
  private conflictingRow(): EditorRow | null {
    const visible = this.visibleRows();
    const counts = new Map<string, number>();
    for (const row of visible) {
      const name = folded(row.displayName);
      if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return (
      visible.find((row) => {
        const name = folded(row.displayName);
        return (
          this.rowNameChanged(row) && !!name && (counts.get(name) ?? 0) > 1
        );
      }) ?? null
    );
  }

  private planFailure(status: number, reason: string | null): void {
    this.errorCheck.set(true);
    if (reason === 'name-in-use' && this.mode() === 'create') {
      this.serverCategoryNameError.set(CATEGORY_NAME_IN_USE);
      return;
    }
    if (reason === 'display-name-in-use') {
      const row = this.conflictingRow();
      if (row) {
        this.serverDisplayError.set({
          key: row.key,
          text: ATTRIBUTE_DISPLAY_NAME_IN_USE,
        });
        return;
      }
      this.formError.set(ATTRIBUTE_DISPLAY_NAME_IN_USE);
      return;
    }
    if (reason === 'invalid-display-name') {
      if (!this.categoryDisplay().trim()) {
        this.serverCategoryDisplayError.set(DISPLAY_NAME_REQUIRED);
        return;
      }
      const row = this.visibleRows().find((item) => !item.displayName.trim());
      if (row) {
        this.serverDisplayError.set({
          key: row.key,
          text: DISPLAY_NAME_REQUIRED,
        });
        return;
      }
      this.formError.set(DISPLAY_NAME_REQUIRED);
      return;
    }
    this.formError.set(this.planFailureText(status, reason));
  }

  private planFailureText(status: number, reason: string | null): string {
    if (status === 0) return PLAN_NOT_PREPARED_TEXT;
    if (status === 401) return SESSION_ENDED_TEXT;
    if (reason === 'category-changed') return CATEGORY_CHANGED_TEXT;
    if (reason === 'connection-required') return CONNECTION_REQUIRED_TEXT;
    if (reason === 'category-limit')
      return 'The account holds 100 categories. Remove a category before you add one.';
    if (reason === 'attribute-limit')
      return 'The account holds 100 attributes. Remove an attribute before you add one.';
    if (reason === 'nothing-to-update')
      return 'The category holds no change. Edit a value before you review.';
    return PLAN_NOT_PREPARED_TEXT;
  }

  private confirmFailure(result: FlowFailure): void {
    if (result.uncertain) {
      // A lost or unreadable answer does not prove that no job started. The plan stays,
      // so a retry replays the same plan identity.
      this.formError.set(SAVE_UNCERTAIN_TEXT);
      return;
    }
    const status = result.status;
    const reason = result.reason;
    if (reason === 'phrase-mismatch') {
      if (this.step() === 'review')
        this.serverPhraseError.set(PHRASE_MISMATCH_TEXT);
      else this.phraseError.set(PHRASE_MISMATCH_TEXT);
      return;
    }
    if (status === 410 || reason === 'plan-expired') {
      this.planDead.set(true);
      this.formError.set(PLAN_EXPIRED_TEXT);
      return;
    }
    if (reason === 'plan-changed') {
      this.planDead.set(true);
      this.formError.set(PLAN_CHANGED_TEXT);
      return;
    }
    if (reason === 'category-changed') {
      this.planDead.set(true);
      this.formError.set(CATEGORY_CHANGED_TEXT);
      return;
    }
    this.formError.set(this.confirmFailureText(status, reason));
  }

  private confirmFailureText(status: number, reason: string | null): string {
    if (status === 401) return SESSION_ENDED_TEXT;
    if (reason === 'connection-required' || reason === 'connection-changed')
      return CONNECTION_REQUIRED_TEXT;
    if (reason === 'not-found') return NOT_FOUND_TEXT;
    return SAVE_NOT_STARTED_TEXT;
  }

  /** The receipt opens the saving step; polls follow the job to its result. */
  private startSave(receipt: UserAttributeCategoryJobReceipt): void {
    this.receipt.set(receipt);
    // The receipt carries the confirmed status. Seeding the job from it keeps the line on
    // a true status before the first read answers. A receipt holds no revision, so the
    // seeding entry holds 0 and every read wins.
    this.job.set({
      displayId: receipt.displayId,
      revision: 0,
      status: receipt.status,
      failure: null,
      finishedAt: null,
    });
    this.jobUnreadable.set(false);
    this.step.set('saving');
    this.focusStep();
    this.startPolling(receipt.displayId);
  }

  private startPolling(displayId: string): void {
    this.stopPolling();
    const tick = async (): Promise<void> => {
      const result = await this.flow.readJob(displayId);
      if (!this.alive) return;
      if (result.ok) {
        // A delayed read can answer after a newer one. Apply only a read that is at least
        // the shown revision, so a true status never steps back (S2 item 3).
        const shown = this.job();
        const stale = shown !== null && result.job.revision < shown.revision;
        if (!stale) {
          this.job.set(result.job);
          if (FINAL_STATUSES.has(result.job.status)) {
            this.jobUnreadable.set(false);
            this.step.set('result');
            this.stopPolling();
            this.focusStep();
            return;
          }
        }
        this.jobUnreadable.set(false);
      } else {
        // A refused, failed, or unparseable read cannot report progress. Keep the
        // receipt, and point the person at the job page (B section 13).
        this.jobUnreadable.set(true);
      }
      if (this.step() === 'saving')
        this.pollTimer = setTimeout(
          () => void tick(),
          result.ok ? JOB_POLL_MS : JOB_POLL_MS * 2,
        );
    };
    this.pollTimer = setTimeout(() => void tick(), JOB_POLL_FIRST_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer !== undefined) clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
  }

  private focusStep(phrase = false): void {
    afterNextRender(
      () => {
        const input = phrase
          ? (this.deletePhrase() ?? this.reviewPhrase())
          : null;
        (input?.nativeElement ?? this.stepTitle()?.nativeElement)?.focus();
      },
      { injector: this.injector },
    );
  }

  private updateRow(
    row: EditorRow,
    change: Partial<Omit<EditorRow, 'key'>>,
  ): void {
    this.rows.set(
      this.rows().map((item) =>
        item.key === row.key ? { ...item, ...change } : item,
      ),
    );
  }

  /** The range that the plan request sends for one row (K19, R2). */
  private rangeValue(row: EditorRow): UserAttributeRange | null {
    return draftRange(
      row.fieldType,
      { min: row.rangeMin, max: row.rangeMax },
      row.cachedRange,
    );
  }

  /** The frozen range of one range change, for its review row. */
  private rangeOfChange(
    change: UserAttributeCategoryPlanChange,
  ): UserAttributeRange | null {
    const frozen = this.submitted()?.fields;
    const field =
      frozen?.find(
        (item) =>
          item.fieldId === change.fieldId &&
          item.fieldName === change.fieldName,
      ) ?? frozen?.find((item) => item.fieldName === change.fieldName);
    return field?.numericIndexingSpec ?? null;
  }

  private cachedRow(field: UserAttributeField): EditorRow {
    return {
      key: this.nextKey++,
      fieldId: field.fieldId,
      fieldName: field.fieldName,
      displayName: field.displayName,
      fieldType: field.fieldType,
      multiValued: field.multiValued,
      indexed: field.indexed,
      readAccessType: field.readAccessType,
      rangeMin:
        field.numericIndexingSpec?.minValue === null ||
        field.numericIndexingSpec?.minValue === undefined
          ? ''
          : String(field.numericIndexingSpec.minValue),
      rangeMax:
        field.numericIndexingSpec?.maxValue === null ||
        field.numericIndexingSpec?.maxValue === undefined
          ? ''
          : String(field.numericIndexingSpec.maxValue),
      cachedRange: field.numericIndexingSpec,
      holders: field.holders,
      nameTouched: true,
      removed: false,
      cachedDisplayName: field.displayName,
      cachedMultiValued: field.multiValued,
    };
  }

  private newRow(): EditorRow {
    return {
      key: this.nextKey++,
      fieldId: null,
      fieldName: '',
      displayName: '',
      fieldType: 'STRING',
      multiValued: false,
      indexed: true,
      readAccessType: 'ADMINS_AND_SELF',
      rangeMin: '',
      rangeMax: '',
      cachedRange: null,
      holders: 0,
      nameTouched: false,
      removed: false,
      cachedDisplayName: '',
      cachedMultiValued: false,
    };
  }

  private changeRows(plan: UserAttributeCategoryPlan): readonly ChangeRow[] {
    const rows: ChangeRow[] = [];
    if (
      plan.displayName !== this.baseDisplayName() &&
      plan.kind === 'edit-category'
    )
      rows.push({
        key: 'rename',
        kind: 'rename',
        ...changeChip('rename'),
        attribute: `${this.baseDisplayName()} → ${plan.displayName}`,
        effect: NO_USER_VALUES_CHANGE,
      });
    for (const [index, change] of plan.changes.entries()) {
      rows.push(this.changeRow(change, index));
    }
    return rows;
  }

  private changeRow(
    change: UserAttributeCategoryPlanChange,
    index: number,
  ): ChangeRow {
    const attribute = `${change.displayName} (${typeLabel(
      this.fieldTypeOf(change),
    )})`;
    if (change.change === 'added')
      return {
        key: `change-${index}`,
        kind: 'added',
        ...changeChip('added'),
        attribute,
        effect: NO_USER_VALUES_CHANGE,
      };
    if (change.change === 'removed')
      return {
        key: `change-${index}`,
        kind: 'removed',
        ...changeChip('removed'),
        attribute,
        effect: deletesAttributeValuesText(change.holders ?? 0),
      };
    // Composition choice 8: a range change has its own row and no typed phrase.
    if (
      change.properties.length === 1 &&
      change.properties[0] === 'numericIndexingSpec'
    )
      return {
        key: `change-${index}`,
        kind: 'changed',
        label: CHANGE_SET_RANGE_LABEL,
        tone: 'info',
        attribute: rangeText(change.displayName, this.rangeOfChange(change)),
        effect: NO_USER_VALUES_CHANGE,
      };
    return {
      key: `change-${index}`,
      kind: 'changed',
      ...changeChip('changed'),
      attribute,
      effect: propertiesText(change.properties),
    };
  }

  /**
   * The info type that the review and the result show: the cached type of a kept field,
   * or the type of the frozen request. A pending draft edit cannot change it.
   */
  private fieldTypeOf(
    change: UserAttributeCategoryPlanChange,
  ): UserAttributeFieldType {
    const cached = this.category()?.fields.find(
      (field) => field.fieldId === change.fieldId,
    );
    if (cached) return cached.fieldType;
    const frozen = this.submitted()?.fields;
    const field =
      frozen?.find(
        (item) =>
          item.fieldId === change.fieldId &&
          item.fieldName === change.fieldName,
      ) ?? frozen?.find((item) => item.fieldName === change.fieldName);
    return field?.fieldType ?? 'STRING';
  }

  /** One one-way block for each removal, in the order of the plan. */
  protected readonly removals = computed(() => {
    const plan = this.plan();
    if (!plan) return [];
    return plan.changes
      .filter((change) => change.change === 'removed')
      .map((change) => ({
        key: change.fieldName,
        // The phrase is the attribute name (B section 5, E3); the block names the label.
        name: change.fieldName,
        displayName: change.displayName,
        text: removingValuesText(change.displayName, change.holders ?? 0),
      }));
  });

  protected readonly deleteNotices = computed(() => {
    const category = this.category();
    if (!category) return [];
    return category.fields.map((field) => ({
      key: field.fieldId,
      name: field.displayName,
      text: deletesValuesText(field.displayName, field.holders),
    }));
  });

  /** The primary action label of the delete question. */
  protected readonly deleting = computed(
    () => this.busy() && this.step() === 'delete',
  );

  protected readonly saving = computed(
    () => this.busy() && this.step() === 'review',
  );
}

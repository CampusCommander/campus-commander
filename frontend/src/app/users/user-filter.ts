import {
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import {
  userPredicateSchema,
  type UserOrgUnit,
  type UserPredicate,
} from '@campus/application-contracts';
import {
  DATE_OPERATORS,
  STATUS_LABELS,
  TEXT_OPERATORS,
  TWO_STEP_LABELS,
  dateInputToIso,
  dateInputValue,
  fieldFor,
  orgUnitOptions,
  shortcutLabel,
  suggestions,
  unitCheck,
  withUnit,
  type UserAttributeColumn,
  type UserField,
  type UserStatusValue,
  type UserTwoStepValue,
} from './user-fields';

type FilterField = UserField | UserAttributeColumn;

interface Suggestion {
  id: string;
  label: string;
  field: FilterField;
  predicate: UserPredicate | null;
}

let nextId = 0;

/** GRID-04 filter entry: field autocomplete, shortcut matches, and typed editors with explicit Apply. */
@Component({
  selector: 'app-user-filter',
  imports: [MatButtonModule],
  templateUrl: './user-filter.html',
  styleUrl: './user-filter.css',
})
export class UserFilter {
  readonly attributes = input<readonly UserAttributeColumn[]>([]);
  readonly orgUnits = input<readonly UserOrgUnit[]>([]);
  readonly editing = input<UserPredicate | null>(null);
  readonly applied = output<UserPredicate>();
  readonly closed = output<void>();

  private readonly injector = inject(Injector);
  private readonly trigger =
    viewChild<ElementRef<HTMLButtonElement>>('trigger');
  private readonly entry = viewChild<ElementRef<HTMLInputElement>>('entry');
  private readonly editor = viewChild<ElementRef<HTMLElement>>('editor');
  /** True while the editor changes an existing chip. */
  private editingChip = false;
  protected readonly id = `user-filter-${++nextId}`;
  protected readonly entering = signal(false);
  protected readonly text = signal('');
  protected readonly active = signal(0);
  protected readonly field = signal<FilterField | null>(null);
  protected readonly operator = signal('contains');
  protected readonly value = signal('');
  protected readonly from = signal('');
  protected readonly to = signal('');
  protected readonly booleanValue = signal(true);
  protected readonly status = signal<readonly UserStatusValue[]>([]);
  protected readonly twoStep = signal<readonly UserTwoStepValue[]>([]);
  protected readonly unitValues = signal<readonly string[]>([]);
  protected readonly unitSearch = signal('');
  protected readonly textOperators = TEXT_OPERATORS;
  protected readonly dateOperators = DATE_OPERATORS;
  protected readonly statusOptions = Object.entries(STATUS_LABELS) as [
    UserStatusValue,
    string,
  ][];
  protected readonly twoStepOptions = Object.entries(TWO_STEP_LABELS) as [
    UserTwoStepValue,
    string,
  ][];

  /** The field kind that picks the editor: an attribute editor follows its info type. */
  protected readonly kind = computed(() => {
    const field = this.field();
    if (!field) return '';
    if ('kind' in field) return field.kind;
    switch (field.field.fieldType) {
      case 'INT64':
      case 'DOUBLE':
        return 'numberRange';
      case 'DATE':
        return 'dateRange';
      case 'BOOL':
        return 'attributeBoolean';
      default:
        return 'attributeText';
    }
  });

  protected readonly suggestions = computed<Suggestion[]>(() => {
    const { fields, shortcuts } = suggestions(this.text(), this.attributes());
    return [
      ...fields.map((field) => ({
        id: `${this.id}-field-${field.label}`,
        label: field.label,
        field,
        predicate: null,
      })),
      ...shortcuts.map((predicate, index) => ({
        id: `${this.id}-shortcut-${index}`,
        label: shortcutLabel(predicate),
        field: fieldFor(predicate.field),
        predicate,
      })),
    ];
  });
  /** Empty sections are suppressed (GRID-04). */
  protected readonly groups = computed(() =>
    [
      {
        name: 'Matched fields',
        items: this.suggestions().filter((item) => !item.predicate),
      },
      {
        name: 'Shortcut matches',
        items: this.suggestions().filter((item) => item.predicate),
      },
    ].filter((group) => group.items.length > 0),
  );
  protected readonly activeId = computed(
    () => this.suggestions()[this.active()]?.id ?? null,
  );
  protected readonly units = computed(() =>
    orgUnitOptions(this.orgUnits(), this.unitSearch()),
  );
  protected readonly draft = computed<UserPredicate | null>(() => {
    const field = this.field();
    if (!field) return null;
    const candidate = this.candidate(field);
    const parsed = userPredicateSchema.safeParse(candidate);
    if (!parsed.success) return null;
    // Only grid set filters may be empty. A chip needs at least one value.
    return 'values' in parsed.data && parsed.data.values.length === 0
      ? null
      : parsed.data;
  });

  private candidate(field: FilterField): unknown {
    if ('kind' in field) {
      if (field.kind === 'status')
        return { field: field.id, operator: 'is', values: this.status() };
      if (field.kind === 'boolean')
        return { field: field.id, operator: 'is', values: this.twoStep() };
      if (field.kind === 'orgUnit')
        return { field: field.id, operator: 'in', values: this.unitValues() };
      if (field.kind === 'dateTime')
        return {
          field: field.id,
          operator: this.operator(),
          value: dateInputToIso(this.value()),
        };
      return this.operator() === 'isEmpty'
        ? { field: field.id, operator: 'isEmpty' }
        : { field: field.id, operator: this.operator(), value: this.value() };
    }
    const names = { schemaName: field.schemaName, fieldName: field.fieldName };
    switch (field.field.fieldType) {
      case 'INT64':
      case 'DOUBLE': {
        const from = Number(this.from());
        const to = this.to().trim() === '' ? from : Number(this.to());
        return this.from().trim() === ''
          ? null
          : { field: 'attribute', ...names, operator: 'numberRange', from, to };
      }
      case 'DATE':
        return {
          field: 'attribute',
          ...names,
          operator: 'dateRange',
          from: this.from() || this.to(),
          to: this.to() || this.from(),
        };
      case 'BOOL':
        return {
          field: 'attribute',
          ...names,
          operator: 'is',
          value: this.booleanValue(),
        };
      default:
        return this.value().trim() === ''
          ? { field: 'attribute', ...names, operator: 'hasValue' }
          : {
              field: 'attribute',
              ...names,
              operator: 'contains',
              value: this.value(),
            };
    }
  }

  constructor() {
    effect(() => {
      const predicate = this.editing();
      untracked(() => {
        if (predicate) {
          this.editingChip = true;
          this.open(predicate);
        } else if (this.editingChip) {
          // The page cleared or removed the chip under edit. Close without applying.
          this.editingChip = false;
          this.entering.set(false);
          this.field.set(null);
        }
      });
    });
  }

  protected start(): void {
    this.entering.set(true);
    this.text.set('');
    this.active.set(0);
    afterNextRender(() => this.entry()?.nativeElement.focus(), {
      injector: this.injector,
    });
  }

  protected typed(value: string): void {
    this.text.set(value);
    this.active.set(0);
  }

  protected keydown(event: KeyboardEvent): void {
    const count = this.suggestions().length;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (count === 0) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      this.active.set((this.active() + step + count) % count);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const choice = this.suggestions()[this.active()];
      if (choice) this.choose(choice);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.close();
    }
  }

  protected choose(choice: Suggestion): void {
    this.entering.set(false);
    if (choice.predicate) this.open(choice.predicate);
    else this.openField(choice.field);
  }

  private openField(field: FilterField): void {
    this.field.set(field);
    this.operator.set(
      'kind' in field
        ? field.kind === 'orgUnit'
          ? 'in'
          : field.kind === 'dateTime'
            ? 'before'
            : 'contains'
        : 'contains',
    );
    this.value.set('');
    this.from.set('');
    this.to.set('');
    this.booleanValue.set(true);
    this.status.set([]);
    this.twoStep.set([]);
    this.unitValues.set([]);
    this.unitSearch.set('');
    afterNextRender(
      () =>
        this.editor()
          ?.nativeElement.querySelector<HTMLElement>('select, input')
          ?.focus(),
      { injector: this.injector },
    );
  }

  private open(predicate: UserPredicate): void {
    this.entering.set(false);
    if (predicate.field === 'attribute') {
      const attribute = this.attributes().find(
        (candidate) =>
          candidate.schemaName === predicate.schemaName &&
          candidate.fieldName === predicate.fieldName,
      );
      if (!attribute) return;
      this.openField(attribute);
      if (predicate.operator === 'numberRange') {
        this.from.set(String(predicate.from));
        this.to.set(String(predicate.to));
      } else if (predicate.operator === 'dateRange') {
        this.from.set(predicate.from);
        this.to.set(predicate.to);
      } else if (predicate.operator === 'is')
        this.booleanValue.set(predicate.value);
      else if (predicate.operator === 'contains')
        this.value.set(predicate.value);
      return;
    }
    this.openField(fieldFor(predicate.field));
    // Reopening a chip keeps its operator. Only the operator control shows it (R5).
    this.operator.set(predicate.operator);
    if (predicate.field === 'status') this.status.set(predicate.values);
    else if (predicate.field === 'twoStep') this.twoStep.set(predicate.values);
    else if (predicate.field === 'orgUnitPath')
      this.unitValues.set(predicate.values);
    else if (
      predicate.field === 'lastLoginTime' ||
      predicate.field === 'creationTime'
    )
      this.value.set(dateInputValue(predicate.value));
    else if ('value' in predicate) this.value.set(predicate.value);
  }

  protected toggleStatus(value: UserStatusValue, checked: boolean): void {
    this.status.update((values) =>
      checked
        ? [...values.filter((item) => item !== value), value]
        : values.filter((item) => item !== value),
    );
  }

  protected toggleTwoStep(value: UserTwoStepValue, checked: boolean): void {
    this.twoStep.update((values) =>
      checked
        ? [...values.filter((item) => item !== value), value]
        : values.filter((item) => item !== value),
    );
  }

  protected unitState(path: string) {
    return unitCheck(this.unitValues(), this.orgUnits(), path);
  }

  protected chooseUnit(path: string, checked: boolean): void {
    this.unitValues.set(
      withUnit(this.unitValues(), this.orgUnits(), path, checked),
    );
  }

  protected apply(): void {
    const draft = this.draft();
    if (!draft) return;
    this.applied.emit(draft);
    this.close();
  }

  protected close(): void {
    const editedChip = this.editingChip;
    this.editingChip = false;
    this.entering.set(false);
    this.field.set(null);
    this.closed.emit();
    // UI-09: after a chip edit the page returns focus to that chip.
    if (!editedChip)
      afterNextRender(() => this.trigger()?.nativeElement.focus(), {
        injector: this.injector,
      });
  }
}

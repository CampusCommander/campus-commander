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
  devicePredicateSchema,
  type DeviceOrgUnit,
  type DevicePredicate,
} from '@campus/application-contracts';
import {
  BATTERY_LABELS,
  DATE_OPERATORS,
  ORG_UNIT_OPERATORS,
  TEXT_OPERATORS,
  dateInputToIso,
  dateInputValue,
  fieldFor,
  orgUnitOptions,
  shortcutLabel,
  suggestions,
  type BatteryFilterValue,
  type DeviceField,
} from './device-fields';

interface Suggestion {
  id: string;
  label: string;
  field: DeviceField;
  predicate: DevicePredicate | null;
}

let nextId = 0;

/** GRID-04 filter entry: field autocomplete, shortcut matches, and typed editors with explicit Apply. */
@Component({
  selector: 'app-device-filter',
  imports: [MatButtonModule],
  templateUrl: './device-filter.html',
  styleUrl: './device-filter.css',
})
export class DeviceFilter {
  readonly orgUnits = input<readonly DeviceOrgUnit[]>([]);
  readonly editing = input<DevicePredicate | null>(null);
  readonly applied = output<DevicePredicate>();
  readonly closed = output<void>();

  private readonly injector = inject(Injector);
  private readonly trigger =
    viewChild<ElementRef<HTMLButtonElement>>('trigger');
  private readonly entry = viewChild<ElementRef<HTMLInputElement>>('entry');
  private readonly editor = viewChild<ElementRef<HTMLElement>>('editor');
  /** True while the editor changes an existing chip. */
  private editingChip = false;
  protected readonly id = `device-filter-${++nextId}`;
  protected readonly entering = signal(false);
  protected readonly text = signal('');
  protected readonly active = signal(0);
  protected readonly field = signal<DeviceField | null>(null);
  protected readonly operator = signal('contains');
  protected readonly value = signal('');
  protected readonly battery = signal<readonly BatteryFilterValue[]>([]);
  protected readonly unitSearch = signal('');
  protected readonly textOperators = TEXT_OPERATORS;
  protected readonly dateOperators = DATE_OPERATORS;
  protected readonly orgUnitOperators = ORG_UNIT_OPERATORS;
  protected readonly batteryOptions = Object.entries(BATTERY_LABELS) as [
    BatteryFilterValue,
    string,
  ][];

  protected readonly suggestions = computed<Suggestion[]>(() => {
    const { fields, shortcuts } = suggestions(this.text());
    return [
      ...fields.map((field) => ({
        id: `${this.id}-field-${field.id}`,
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
  protected readonly draft = computed<DevicePredicate | null>(() => {
    const field = this.field();
    if (!field) return null;
    const candidate =
      field.kind === 'battery'
        ? { field: field.id, operator: 'is', values: this.battery() }
        : field.kind === 'date'
          ? {
              field: field.id,
              operator: this.operator(),
              value: dateInputToIso(this.value()),
            }
          : this.operator() === 'isEmpty'
            ? { field: field.id, operator: 'isEmpty' }
            : {
                field: field.id,
                operator: this.operator(),
                value: this.value(),
              };
    const parsed = devicePredicateSchema.safeParse(candidate);
    return parsed.success ? parsed.data : null;
  });

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

  private openField(field: DeviceField): void {
    this.field.set(field);
    this.operator.set(
      field.kind === 'orgUnit'
        ? 'within'
        : field.kind === 'date'
          ? 'before'
          : 'contains',
    );
    this.value.set('');
    this.battery.set([]);
    this.unitSearch.set('');
    afterNextRender(
      () =>
        this.editor()
          ?.nativeElement.querySelector<HTMLElement>('select, input')
          ?.focus(),
      { injector: this.injector },
    );
  }

  private open(predicate: DevicePredicate): void {
    this.entering.set(false);
    this.openField(fieldFor(predicate.field));
    this.operator.set(predicate.operator);
    if (predicate.field === 'battery') this.battery.set(predicate.values);
    else if (predicate.field === 'lastContact')
      this.value.set(dateInputValue(predicate.value));
    else if ('value' in predicate) this.value.set(predicate.value);
  }

  protected toggleBattery(value: BatteryFilterValue, checked: boolean): void {
    this.battery.update((values) =>
      checked
        ? [...values.filter((item) => item !== value), value]
        : values.filter((item) => item !== value),
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
    // After a chip edit the page returns focus to that chip (GRID-04).
    if (!editedChip)
      afterNextRender(() => this.trigger()?.nativeElement.focus(), {
        injector: this.injector,
      });
  }
}

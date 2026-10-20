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
import type {
  JobAction,
  JobPerson,
  JobStatus,
} from '@campus/application-contracts';
import {
  JOB_ACTIONS,
  JOB_FILTER_FIELDS,
  JOB_STATUSES,
  JOB_STATUS_LABELS,
  actionLabel,
  dateTimeInputToIso,
  dateTimeInputValue,
  lastSevenDays,
  validJobId,
  type JobFilter,
  type JobFilterField,
  type JobFilterFieldId,
} from './job-fields';

/** Reads the `requestedBy` autocomplete. A failed read returns null. */
export type RequesterLoader = (query: string) => Promise<JobPerson[] | null>;

interface Suggestion {
  id: string;
  label: string;
  field: JobFilterField;
  /** The Created shortcut fills its bounds. */
  preset?: 'last-7-days';
}

type PeopleState = 'idle' | 'loading' | 'ready' | 'unavailable';

let nextId = 0;

/** GRID-04 filter entry for the seven server filters of the Jobs grid. */
@Component({
  selector: 'app-job-filter',
  imports: [MatButtonModule],
  templateUrl: './job-filter.html',
  styleUrl: './job-filter.css',
})
export class JobFilterEditor {
  readonly editing = input<JobFilter | null>(null);
  readonly requesters = input<RequesterLoader>(async () => []);
  readonly applied = output<JobFilter>();
  readonly closed = output<void>();

  private readonly injector = inject(Injector);
  private readonly trigger =
    viewChild<ElementRef<HTMLButtonElement>>('trigger');
  private readonly entry = viewChild<ElementRef<HTMLInputElement>>('entry');
  private readonly editor = viewChild<ElementRef<HTMLElement>>('editor');
  private readonly personSearch =
    viewChild<ElementRef<HTMLInputElement>>('personSearch');
  private editingChip = false;
  private peopleToken = 0;
  protected readonly id = `job-filter-${++nextId}`;
  protected readonly entering = signal(false);
  protected readonly text = signal('');
  protected readonly active = signal(0);
  protected readonly field = signal<JobFilterField | null>(null);
  protected readonly jobId = signal('');
  protected readonly statuses = signal<readonly JobStatus[]>([]);
  protected readonly actions = signal<readonly JobAction[]>([]);
  protected readonly entities = signal<readonly 'device'[]>([]);
  protected readonly person = signal<JobPerson | null>(null);
  protected readonly personQuery = signal('');
  protected readonly people = signal<readonly JobPerson[]>([]);
  protected readonly peopleState = signal<PeopleState>('idle');
  protected readonly from = signal('');
  protected readonly to = signal('');
  protected readonly preset = signal<'last-7-days' | null>(null);
  protected readonly fields = JOB_FILTER_FIELDS;
  protected readonly statusOptions = JOB_STATUSES;
  protected readonly actionOptions = JOB_ACTIONS;
  protected readonly statusLabels = JOB_STATUS_LABELS;
  protected readonly actionLabel = actionLabel;

  protected readonly suggestions = computed<Suggestion[]>(() => {
    const query = this.text().trim().toLowerCase();
    const fields = this.fields.filter((field) =>
      field.label.toLowerCase().includes(query),
    );
    const shortcut =
      query && /^(last|7|week)/.test(query)
        ? [
            {
              id: `${this.id}-shortcut-last-7-days`,
              label: 'Created: Last 7 days',
              field: this.fieldFor('createdAt'),
              preset: 'last-7-days' as const,
            },
          ]
        : [];
    return [...fields.map((field) => this.suggestion(field)), ...shortcut];
  });
  /** Empty sections are suppressed (GRID-04). */
  protected readonly groups = computed(() => {
    const shortcut = this.suggestions().filter((item) => item.preset);
    return [
      {
        name: 'Matched fields',
        items: this.suggestions().filter((item) => !item.preset),
      },
      { name: 'Shortcut matches', items: shortcut },
    ].filter((group) => group.items.length > 0);
  });
  protected readonly activeId = computed(
    () => this.suggestions()[this.active()]?.id ?? null,
  );
  protected readonly invalidRange = computed(() => {
    const from = this.from();
    const to = this.to();
    if (!from || !to) return false;
    const start = dateTimeInputToIso(from);
    const end = dateTimeInputToIso(to);
    return !!start && !!end && Date.parse(start) > Date.parse(end);
  });
  protected readonly draft = computed<JobFilter | null>(() => {
    const field = this.field();
    if (!field) return null;
    switch (field.id) {
      case 'jobId': {
        const value = this.jobId().trim();
        return validJobId(value) ? { field: 'jobId', value } : null;
      }
      case 'status':
        return this.statuses().length
          ? { field: 'status', values: [...this.statuses()] }
          : null;
      case 'action':
        return this.actions().length
          ? { field: 'action', values: [...this.actions()] }
          : null;
      case 'entityType':
        return this.entities().length
          ? { field: 'entityType', values: ['device'] }
          : null;
      case 'requestedBy': {
        const person = this.person();
        return person
          ? {
              field: 'requestedBy',
              id: person.id,
              displayName: person.displayName,
            }
          : null;
      }
      case 'createdAt':
      case 'finishedAt': {
        if (this.invalidRange()) return null;
        const from = dateTimeInputToIso(this.from());
        const to = dateTimeInputToIso(this.to());
        if (!from && !to) return null;
        return {
          field: field.id,
          from,
          to,
          ...(this.preset() ? { preset: this.preset()! } : {}),
        };
      }
      default:
        return null;
    }
  });

  constructor() {
    effect(() => {
      const filter = this.editing();
      untracked(() => {
        if (filter) {
          this.editingChip = true;
          this.openFilter(filter);
        } else if (this.editingChip) {
          // The page cleared or removed the chip under edit. Close without applying.
          this.editingChip = false;
          this.entering.set(false);
          this.field.set(null);
        }
      });
    });
  }

  private fieldFor(id: JobFilterFieldId): JobFilterField {
    const field = this.fields.find((candidate) => candidate.id === id);
    if (!field) throw new Error(`Unknown job filter field ${id}`);
    return field;
  }

  private suggestion(field: JobFilterField): Suggestion {
    return { id: `${this.id}-field-${field.id}`, label: field.label, field };
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
    this.openField(choice.field);
    if (choice.preset) {
      const bounds = lastSevenDays();
      this.preset.set(choice.preset);
      this.from.set(dateTimeInputValue(bounds.from));
      this.to.set(dateTimeInputValue(bounds.to));
    }
  }

  private openField(field: JobFilterField): void {
    this.field.set(field);
    this.jobId.set('');
    this.statuses.set([]);
    this.actions.set([]);
    this.entities.set([]);
    this.person.set(null);
    this.personQuery.set('');
    this.people.set([]);
    this.peopleState.set('idle');
    this.from.set('');
    this.to.set('');
    this.preset.set(null);
    if (field.kind === 'person') void this.search('');
    afterNextRender(
      () => {
        if (field.kind === 'person') this.personSearch()?.nativeElement.focus();
        else
          this.editor()
            ?.nativeElement.querySelector<HTMLElement>('input, select')
            ?.focus();
      },
      { injector: this.injector },
    );
  }

  private openFilter(filter: JobFilter): void {
    this.openField(this.fieldFor(filter.field));
    switch (filter.field) {
      case 'jobId':
        this.jobId.set(filter.value);
        break;
      case 'status':
        this.statuses.set([...filter.values]);
        break;
      case 'action':
        this.actions.set([...filter.values]);
        break;
      case 'entityType':
        this.entities.set(['device']);
        break;
      case 'requestedBy':
        this.person.set({ id: filter.id, displayName: filter.displayName });
        break;
      case 'createdAt':
      case 'finishedAt':
        if (filter.from) this.from.set(dateTimeInputValue(filter.from));
        if (filter.to) this.to.set(dateTimeInputValue(filter.to));
        this.preset.set(filter.preset ?? null);
        break;
    }
  }

  protected toggleStatus(status: JobStatus, checked: boolean): void {
    this.statuses.update((values) =>
      checked
        ? [...values.filter((item) => item !== status), status]
        : values.filter((item) => item !== status),
    );
  }

  protected toggleAction(action: JobAction, checked: boolean): void {
    this.actions.update((values) =>
      checked
        ? [...values.filter((item) => item !== action), action]
        : values.filter((item) => item !== action),
    );
  }

  protected toggleEntity(checked: boolean): void {
    this.entities.set(checked ? ['device'] : []);
  }

  protected async search(query: string): Promise<void> {
    this.personQuery.set(query);
    const token = ++this.peopleToken;
    this.peopleState.set('loading');
    let result: JobPerson[] | null;
    try {
      result = await this.requesters()(query);
    } catch {
      result = null;
    }
    if (token !== this.peopleToken) return;
    if (result === null) {
      this.people.set([]);
      this.peopleState.set('unavailable');
      return;
    }
    this.people.set(result);
    this.peopleState.set('ready');
  }

  protected choosePerson(person: JobPerson): void {
    this.person.set(person);
  }

  protected setFrom(value: string): void {
    this.from.set(value);
    this.preset.set(null);
  }

  protected setTo(value: string): void {
    this.to.set(value);
    this.preset.set(null);
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

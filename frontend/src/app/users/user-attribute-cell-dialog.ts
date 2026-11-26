import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { CdkTrapFocus } from '@angular/cdk/a11y';
import { MatButtonModule } from '@angular/material/button';
import { MatChipInputEvent, MatChipsModule } from '@angular/material/chips';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import type { UserAttributeField } from '@campus/application-contracts';
import {
  ATTRIBUTE_CELL_CANCEL_LABEL,
  ATTRIBUTE_CELL_CLEAR_LABEL,
  ATTRIBUTE_CELL_CLEAR_VALUE_LABEL,
  ATTRIBUTE_CELL_DATE_HINT,
  ATTRIBUTE_CELL_LIST_HINT,
  ATTRIBUTE_CELL_STAGE_LABEL,
} from './user-attribute-grid-messages';
import {
  attributeValueError,
  type AttributeDraft,
} from './user-attribute-value-rules';

/**
 * The specialized cell editors of B section 12: the date picker dialog and the list editor
 * dialog. DRAFT-02 keeps text and number editing in the cell and opens a dialog only for a
 * specialized editor.
 */
@Component({
  selector: 'app-user-attribute-cell-dialog',
  imports: [
    CdkTrapFocus,
    MatButtonModule,
    MatChipsModule,
    MatFormFieldModule,
    MatInputModule,
  ],
  templateUrl: './user-attribute-cell-dialog.html',
  styleUrls: [
    '../devices/device-dialog.css',
    './user-attribute-cell-dialog.css',
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UserAttributeCellDialog {
  /** The attribute whose cell opened the dialog. */
  readonly field = input.required<UserAttributeField>();
  /** The C1 attribute ID (design C1). */
  readonly attribute = input.required<string>();
  readonly label = input.required<string>();
  /** The value that the cell shows now. A Clear carries the empty text or list. */
  readonly value = input.required<string | string[]>();
  readonly userName = input('');
  readonly cancelled = output<void>();
  /** Clear is its own field operation, so it never stages an empty value (R1-G). */
  readonly cleared = output<void>();
  readonly staged = output<string | string[]>();

  private readonly title = viewChild<ElementRef<HTMLElement>>('dialogTitle');
  private readonly dateInput =
    viewChild<ElementRef<HTMLInputElement>>('dateInput');

  protected readonly STAGE_LABEL = ATTRIBUTE_CELL_STAGE_LABEL;
  protected readonly CANCEL_LABEL = ATTRIBUTE_CELL_CANCEL_LABEL;
  protected readonly DATE_HINT = ATTRIBUTE_CELL_DATE_HINT;
  protected readonly LIST_HINT = ATTRIBUTE_CELL_LIST_HINT;

  protected readonly multiValued = computed(() => this.field().multiValued);
  protected readonly isDate = computed(() => this.field().fieldType === 'DATE');
  protected readonly clearLabel = computed(() =>
    this.multiValued()
      ? ATTRIBUTE_CELL_CLEAR_LABEL
      : ATTRIBUTE_CELL_CLEAR_VALUE_LABEL,
  );
  protected readonly dateValue = signal('');
  protected readonly chips = signal<string[]>([]);

  /** The message of the entered value, or null while it passes (B section 8.1). */
  protected readonly error = computed(() => {
    const draft = this.draft();
    return draft ? attributeValueError(draft) : null;
  });

  private readonly draft = computed<AttributeDraft | null>(() => {
    const field = this.field();
    return {
      key: this.attribute(),
      schemaName: this.attribute().slice('attr:'.length).split('.')[0] ?? '',
      fieldName: this.attribute().slice('attr:'.length).split('.')[1] ?? '',
      label: this.label(),
      field,
      baseline: null,
      value: field.multiValued ? this.chips() : this.dateValue(),
    };
  });

  constructor() {
    // Each opening starts from the value that the cell shows.
    effect(() => {
      const value = this.value();
      if (this.field().multiValued) {
        this.chips.set(Array.isArray(value) ? [...value] : [value]);
      } else {
        this.dateValue.set(Array.isArray(value) ? '' : value);
      }
      const target = this.dateInput()?.nativeElement;
      if (target) target.focus();
      else this.title()?.nativeElement.focus();
    });
  }

  protected setDate(event: Event): void {
    const target = event.target;
    if (target instanceof HTMLInputElement) this.dateValue.set(target.value);
  }

  protected addChip(event: MatChipInputEvent): void {
    // The entered text keeps its code points. A leading or trailing space is part of a
    // distinct value (R1-H). A value of spaces alone is refused.
    const text = event.value;
    event.chipInput.clear();
    if (text.trim().length === 0) return;
    this.chips.update((values) => [...values, text]);
  }

  protected removeChip(index: number): void {
    this.chips.update((values) => values.filter((_, at) => at !== index));
  }

  /** Clear is its own field operation (B section 12). */
  protected clearValues(): void {
    this.cleared.emit();
  }

  protected stage(): void {
    if (this.error()) return;
    this.staged.emit(this.multiValued() ? this.chips() : this.dateValue());
  }

  protected cancel(): void {
    this.cancelled.emit();
  }

  protected keydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    this.cancelled.emit();
  }
}

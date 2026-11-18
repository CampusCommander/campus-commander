import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
  signal,
} from '@angular/core';
import { CdkTrapFocus } from '@angular/cdk/a11y';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import type { UserAttributeField } from '@campus/application-contracts';
import { UserAttributeHelp } from './user-attribute-help';
import {
  ADD_ATTRIBUTE_LABEL,
  ADD_ATTRIBUTE_NOTE,
  ATTRIBUTE_HELP_LABEL,
  ATTRIBUTE_TYPE_LABELS,
  ATTRIBUTE_VISIBILITY_LABELS,
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
} from './user-attribute-messages';

/**
 * The read-only category dialog (CA state 09, U4). Every value is plain text, the
 * yes-or-no columns show disabled checkboxes, and the category actions are absent
 * (composition choice 12). The page restores focus to the opening category link (UI-09).
 */
@Component({
  selector: 'app-user-category-dialog',
  imports: [
    CdkTrapFocus,
    MatButtonModule,
    MatCheckboxModule,
    UserAttributeHelp,
  ],
  templateUrl: './user-category-dialog.html',
  styleUrls: ['../devices/device-dialog.css', './user-category-dialog.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UserCategoryDialog {
  /** The category that the open link names. */
  readonly category = input.required<{
    displayName: string;
    schemaName: string;
    fields: readonly UserAttributeField[];
  }>();
  readonly closed = output<void>();

  /** The contextual help disclosure of the dialog title row (composition choice 15). */
  protected readonly helpOpen = signal(false);

  protected readonly ADD_ATTRIBUTE_LABEL = ADD_ATTRIBUTE_LABEL;
  protected readonly ADD_ATTRIBUTE_NOTE = ADD_ATTRIBUTE_NOTE;
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

  protected typeLabel(attribute: UserAttributeField): string {
    return ATTRIBUTE_TYPE_LABELS[attribute.fieldType];
  }

  protected visibilityLabel(attribute: UserAttributeField): string {
    return ATTRIBUTE_VISIBILITY_LABELS[attribute.readAccessType];
  }

  protected keydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    this.closed.emit();
  }
}

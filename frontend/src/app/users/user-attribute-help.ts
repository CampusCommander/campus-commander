import { ChangeDetectionStrategy, Component } from '@angular/core';
import {
  ATTRIBUTE_HELP_INTRO,
  ATTRIBUTE_HELP_RULES,
  ATTRIBUTE_HELP_TITLE,
} from './user-attribute-messages';

/**
 * The contextual help of the Custom attributes tab and of its read-only dialog
 * (composition choice 15). The page and the dialog each own a disclosure control; this
 * pane draws the sourced text only. Document B section 3 backs each claim.
 */
@Component({
  selector: 'app-user-attribute-help',
  templateUrl: './user-attribute-help.html',
  styleUrl: './user-attribute-help.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UserAttributeHelp {
  private static nextId = 0;

  /** The heading id of this pane. Two disclosures may hold one pane each. */
  protected readonly titleId = `attribute-help-title-${UserAttributeHelp.nextId++}`;
  protected readonly ATTRIBUTE_HELP_INTRO = ATTRIBUTE_HELP_INTRO;
  protected readonly ATTRIBUTE_HELP_RULES = ATTRIBUTE_HELP_RULES;
  protected readonly ATTRIBUTE_HELP_TITLE = ATTRIBUTE_HELP_TITLE;
}

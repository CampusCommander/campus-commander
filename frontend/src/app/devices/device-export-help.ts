import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import {
  EXPORT_HELP_COLUMNS,
  EXPORT_HELP_COLUMNS_HEAD,
  EXPORT_HELP_INTRO,
  EXPORT_HELP_LIMITS,
  EXPORT_HELP_LIMITS_HEAD,
  EXPORT_HELP_RULES,
  EXPORT_HELP_RULES_HEAD,
  EXPORT_HELP_TOPIC_LABELS,
  EXPORT_HELP_TOPICS,
  HELP_TITLE,
  REPORT_HELP_INTRO,
  REPORT_HELP_LIMITS,
  type ExportHelpTopic,
} from './device-export-messages';
import {
  IMPORT_HELP_CODES_LINE,
  IMPORT_HELP_MODES,
  IMPORT_HELP_MODES_HEAD,
  IMPORT_HELP_REASON_CODES,
  IMPORT_HELP_REASON_HEAD,
  IMPORT_HELP_RULES,
  IMPORT_HELP_RULES_HEAD,
  IMPORT_HELP_STATUS_CODES,
  IMPORT_HELP_STATUS_HEAD,
  REVIEW_HELP_EXECUTE,
  REVIEW_HELP_EXECUTE_HEAD,
  REVIEW_HELP_INTRO,
  REVIEW_HELP_PLAN,
  REVIEW_HELP_PLAN_HEAD,
  REVIEW_HELP_REJECTED,
  REVIEW_HELP_REJECTED_HEAD,
} from './device-import-messages';

/**
 * The docked help pane of states 06, 07, 11, and 13 to 15. The dialog owns the topic; this pane
 * only shows it.
 */
@Component({
  selector: 'app-device-export-help',
  imports: [MatButtonToggleModule],
  templateUrl: './device-export-help.html',
  styleUrl: './device-export-help.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DeviceExportHelp {
  readonly topic = input.required<ExportHelpTopic>();
  readonly topicChange = output<ExportHelpTopic>();

  protected readonly HELP_TITLE = HELP_TITLE;
  protected readonly EXPORT_HELP_TOPICS = EXPORT_HELP_TOPICS;
  protected readonly EXPORT_HELP_TOPIC_LABELS = EXPORT_HELP_TOPIC_LABELS;
  protected readonly EXPORT_HELP_INTRO = EXPORT_HELP_INTRO;
  protected readonly EXPORT_HELP_COLUMNS_HEAD = EXPORT_HELP_COLUMNS_HEAD;
  protected readonly EXPORT_HELP_COLUMNS = EXPORT_HELP_COLUMNS;
  protected readonly EXPORT_HELP_RULES_HEAD = EXPORT_HELP_RULES_HEAD;
  protected readonly EXPORT_HELP_RULES = EXPORT_HELP_RULES;
  protected readonly EXPORT_HELP_LIMITS_HEAD = EXPORT_HELP_LIMITS_HEAD;
  protected readonly EXPORT_HELP_LIMITS = EXPORT_HELP_LIMITS;
  protected readonly REPORT_HELP_INTRO = REPORT_HELP_INTRO;
  protected readonly REPORT_HELP_LIMITS = REPORT_HELP_LIMITS;

  protected readonly IMPORT_HELP_MODES_HEAD = IMPORT_HELP_MODES_HEAD;
  protected readonly IMPORT_HELP_MODES = IMPORT_HELP_MODES;
  protected readonly IMPORT_HELP_RULES_HEAD = IMPORT_HELP_RULES_HEAD;
  protected readonly IMPORT_HELP_RULES = IMPORT_HELP_RULES;
  protected readonly IMPORT_HELP_STATUS_HEAD = IMPORT_HELP_STATUS_HEAD;
  protected readonly IMPORT_HELP_STATUS_CODES = IMPORT_HELP_STATUS_CODES;
  protected readonly IMPORT_HELP_REASON_HEAD = IMPORT_HELP_REASON_HEAD;
  protected readonly IMPORT_HELP_REASON_CODES = IMPORT_HELP_REASON_CODES;
  protected readonly IMPORT_HELP_CODES_LINE = IMPORT_HELP_CODES_LINE;

  protected readonly REVIEW_HELP_INTRO = REVIEW_HELP_INTRO;
  protected readonly REVIEW_HELP_PLAN_HEAD = REVIEW_HELP_PLAN_HEAD;
  protected readonly REVIEW_HELP_PLAN = REVIEW_HELP_PLAN;
  protected readonly REVIEW_HELP_EXECUTE_HEAD = REVIEW_HELP_EXECUTE_HEAD;
  protected readonly REVIEW_HELP_EXECUTE = REVIEW_HELP_EXECUTE;
  protected readonly REVIEW_HELP_REJECTED_HEAD = REVIEW_HELP_REJECTED_HEAD;
  protected readonly REVIEW_HELP_REJECTED = REVIEW_HELP_REJECTED;

  protected setTopic(value: unknown): void {
    if (
      value === 'export' ||
      value === 'report' ||
      value === 'import' ||
      value === 'review'
    ) {
      this.topicChange.emit(value);
    }
  }
}

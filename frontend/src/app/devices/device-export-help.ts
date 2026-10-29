import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
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
} from './device-export-messages';

/** The docked help pane of state 06. The dialog owns the topic; this pane only shows it. */
@Component({
  selector: 'app-device-export-help',
  imports: [MatButtonToggleModule],
  templateUrl: './device-export-help.html',
  styleUrl: './device-export-help.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DeviceExportHelp {
  readonly topic = input.required<'export' | 'report'>();
  readonly topicChange = output<'export' | 'report'>();

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

  protected setTopic(value: unknown): void {
    if (value === 'export' || value === 'report') this.topicChange.emit(value);
  }
}
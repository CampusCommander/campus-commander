import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import { CdkTrapFocus } from '@angular/cdk/a11y';
import { MatButtonModule } from '@angular/material/button';
import type { CancelQuestion } from './job-detail-fields';

/** The ids of the question paragraphs, in order (state 25 adds the third). */
const PARAGRAPH_IDS = [
  'cancel-question-one',
  'cancel-question-two',
  'cancel-question-three',
] as const;

/**
 * Asks once before a job stops its pending work (mockup choices 3 to 7).
 * The question reuses the Revert all changes shell: 480 px, two paragraphs,
 * both named by aria-describedby.
 */
@Component({
  selector: 'app-job-cancel-dialog',
  imports: [CdkTrapFocus, MatButtonModule],
  templateUrl: './job-cancel-dialog.html',
  styleUrls: ['../devices/device-dialog.css', './job-cancel-dialog.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class JobCancelDialog {
  readonly open = input.required<boolean>();
  readonly question = input.required<CancelQuestion>();
  readonly busy = input(false);
  readonly confirmed = output<void>();
  readonly cancelled = output<void>();

  /** Every paragraph names itself, so the question reads in full (state 25 adds a third). */
  protected get describedBy(): string {
    return this.question()
      .paragraphs.map((_, index) => this.paragraphId(index))
      .join(' ');
  }

  /** The id of one paragraph: the built ids first, then a numbered fallback. */
  protected paragraphId(index: number): string {
    return PARAGRAPH_IDS[index] ?? `cancel-question-${index + 1}`;
  }

  protected keydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    this.cancelled.emit();
  }

  /**
   * The confirm control keeps focus while the question is open, so the disabled
   * state must not emit a second request (UI-07, UI-09).
   */
  protected confirm(): void {
    if (this.busy()) return;
    this.confirmed.emit();
  }
}

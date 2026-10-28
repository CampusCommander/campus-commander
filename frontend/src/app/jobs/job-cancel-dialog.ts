import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import { CdkTrapFocus } from '@angular/cdk/a11y';
import { MatButtonModule } from '@angular/material/button';
import type { CancelQuestion } from './job-detail-fields';

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

  protected keydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    this.cancelled.emit();
  }
}

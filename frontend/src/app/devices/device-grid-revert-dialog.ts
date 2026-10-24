import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import { CdkTrapFocus } from '@angular/cdk/a11y';
import { MatButtonModule } from '@angular/material/button';
import { deviceCountText } from './device-update-messages';

/** Asks once before "Revert all changes" clears the grid draft (mockup state 08). */
@Component({
  selector: 'app-device-grid-revert-dialog',
  imports: [CdkTrapFocus, MatButtonModule],
  templateUrl: './device-grid-revert-dialog.html',
  styleUrls: ['./device-dialog.css', './device-grid-revert-dialog.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DeviceGridRevertDialog {
  readonly open = input.required<boolean>();
  readonly changes = input.required<number>();
  readonly devices = input.required<number>();
  readonly confirmed = output<void>();
  readonly cancelled = output<void>();

  protected readonly countLine = computed(
    () =>
      `${this.changes()} pending ${this.changes() === 1 ? 'change' : 'changes'} · ${deviceCountText(this.devices())}`,
  );

  protected keydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    this.cancelled.emit();
  }
}

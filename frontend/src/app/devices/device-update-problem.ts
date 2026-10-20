import { Component, input, output } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import type {
  FlowAction,
  FlowActionId,
  FlowProblem,
} from './device-update-flow';

/**
 * One stalled write-flow state in the frame style: a card with a heading, the
 * consequence, and the recovery actions. The page owns the main title and the work.
 */
@Component({
  selector: 'app-device-update-problem',
  imports: [MatButtonModule],
  templateUrl: './device-update-problem.html',
  styleUrl: './device-update-problem.css',
})
export class DeviceUpdateProblem {
  readonly problem = input.required<FlowProblem>();
  /** A request from a recovery action is in flight. */
  readonly busy = input(false);
  /** The label of the busy primary action. */
  readonly busyLabel = input('');
  /** An answer to a recovery action that needs its own line. */
  readonly detail = input('');
  readonly action = output<FlowActionId>();

  protected label(action: FlowAction): string {
    return this.busy() && action.primary && this.busyLabel()
      ? this.busyLabel()
      : action.label;
  }

  protected disabled(): boolean {
    return this.busy();
  }

  protected emit(id: FlowActionId): void {
    if (this.busy()) return;
    this.action.emit(id);
  }
}

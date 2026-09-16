import { Component, input, output } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';

let nextUniqueId = 0;

@Component({
  selector: 'app-error-state',
  imports: [MatButtonModule],
  templateUrl: './error-state.html',
  styleUrl: './error-state.css',
})
export class ErrorState {
  readonly title = input.required<string>();
  readonly cause = input.required<string>();
  readonly scope = input<string>();
  readonly retryLabel = input('Retry');
  readonly retrying = input(false);
  readonly retry = output<void>();
  protected readonly titleId = `app-error-state-title-${++nextUniqueId}`;
}

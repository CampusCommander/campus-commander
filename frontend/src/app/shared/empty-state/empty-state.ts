import { Component, computed, input } from '@angular/core';

let nextUniqueId = 0;

@Component({
  selector: 'app-empty-state',
  templateUrl: './empty-state.html',
  styleUrl: './empty-state.css',
})
export class EmptyState {
  readonly title = input.required<string>();
  readonly reason = input<'no-data' | 'no-matches'>('no-data');
  readonly message = input<string>();
  protected readonly titleId = `app-empty-state-title-${++nextUniqueId}`;
  protected readonly text = computed(
    () =>
      this.message() ??
      (this.reason() === 'no-matches'
        ? 'No records match the active filters.'
        : 'There are no records to show yet.'),
  );
  protected readonly icon = computed(() =>
    this.reason() === 'no-matches' ? 'filter_alt_off' : 'inbox',
  );
}

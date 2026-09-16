import { Component, computed, input, output } from '@angular/core';

@Component({
  selector: 'app-filter-chip',
  templateUrl: './filter-chip.html',
  styleUrl: './filter-chip.css',
})
export class FilterChip {
  readonly field = input.required<string>();
  readonly operator = input.required<string>();
  readonly value = input.required<string>();
  readonly edit = output<void>();
  readonly remove = output<void>();
  protected readonly description = computed(
    () => `${this.field()} ${this.operator()} ${this.value()}`,
  );
}

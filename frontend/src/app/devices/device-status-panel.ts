import { Component, computed, inject } from '@angular/core';
import { DatePipe } from '@angular/common';
import { DevicesStore } from './devices.store';
import { selectionScope } from './device-selection';

/** Counts, freshness, and selection scope in the grid status bar (GRID-01, SELECT-01). */
@Component({
  selector: 'app-device-status-panel',
  imports: [DatePipe],
  template: `
    <div class="status" aria-live="polite">
      @if (store.page(); as page) {
        <p>
          {{ count(page.matching) }} matching devices ·
          {{ count(page.total) }} in district
        </p>
        <p>
          @if (store.offline()) {
            Cached inventory: {{ page.observedAt | date: 'MMM d, h:mm a' }} ·
            Connection unavailable
          } @else if (store.sync()?.stale) {
            Stale inventory · Last complete observation
            {{ page.observedAt | date: 'MMM d, h:mm a' }} · Refresh required
          } @else {
            Inventory observed {{ page.observedAt | date: 'MMM d, h:mm a' }}
          }
        </p>
      } @else {
        <p>Loading devices…</p>
      }
      @if (scope(); as text) {
        <p>{{ text }}</p>
      }
    </div>
  `,
  styles: `
    .status {
      display: flex;
      flex-wrap: wrap;
      gap: var(--cc-space-md);
      color: var(--cc-text-secondary);
    }
    p {
      margin: 0;
    }
  `,
})
export class DeviceStatusPanel {
  protected readonly store = inject(DevicesStore);
  protected readonly scope = computed(() =>
    selectionScope(this.store.selection.spec()),
  );

  protected count(value: number): string {
    return value.toLocaleString('en-US');
  }
}

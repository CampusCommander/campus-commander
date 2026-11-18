import { Component, computed, inject } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { UsersStore } from './users.store';
import { selectionScope } from './user-selection';

/** Counts, freshness, and selection scope in the grid status bar (GRID-01, SELECT-01). */
@Component({
  selector: 'app-user-status-panel',
  imports: [DatePipe, RouterLink],
  template: `
    <div class="status" aria-live="polite">
      @if (store.page(); as page) {
        <p>
          {{ count(page.matching) }} matching users · {{ count(page.total) }} in
          district
        </p>
        <p>
          @if (store.offline()) {
            Cached directory: {{ page.observedAt | date: 'MMM d, h:mm a' }} ·
            Connection unavailable
          } @else if (store.sync()?.stale) {
            Stale directory · Last complete observation
            {{ page.observedAt | date: 'MMM d, h:mm a' }} · Refresh required
          } @else {
            Directory observed {{ page.observedAt | date: 'MMM d, h:mm a' }}
          }
        </p>
      } @else {
        <p>Loading users…</p>
      }
      @if (scope(); as text) {
        <p>{{ text }}</p>
      }
      @if (store.refreshStatus(); as text) {
        <p class="refresh-status">{{ text }}</p>
      }
      @if (store.categoriesError(); as text) {
        <p>
          {{ text }}
          @if (store.categoriesRecovery()) {
            <a routerLink="/google-connection">Open Google connection</a>
          }
        </p>
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
    .refresh-status {
      color: var(--cc-text-primary);
    }
  `,
})
export class UserStatusPanel {
  protected readonly store = inject(UsersStore);
  protected readonly scope = computed(() =>
    selectionScope(this.store.selection.spec(), this.store.attributes()),
  );

  protected count(value: number): string {
    return value.toLocaleString('en-US');
  }
}

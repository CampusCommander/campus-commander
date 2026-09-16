import { Component, computed, inject } from '@angular/core';
import { AuthStore } from '../auth.store';
import {
  DataRegion,
  type DataRegionState,
} from '../shared/data-region/data-region';

@Component({
  selector: 'app-account',
  imports: [DataRegion],
  templateUrl: './account.html',
  styleUrl: './account.css',
})
export class Account {
  protected readonly auth = inject(AuthStore);
  protected readonly identityState = computed<DataRegionState>(() => {
    if (this.auth.session()) return { status: 'ready' };
    if (this.auth.loading()) return { status: 'loading' };
    const error = this.auth.error();
    if (error)
      return {
        status: 'error',
        title: 'Your account is unavailable',
        cause: error,
        retryLabel: 'Restore session',
      };
    return { status: 'loading' };
  });
  protected restore() {
    void this.auth.restore();
  }
}

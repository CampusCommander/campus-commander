import { Component, computed, input, output } from '@angular/core';
import { Skeleton } from '../skeleton/skeleton';
import { EmptyState } from '../empty-state/empty-state';
import { ErrorState } from '../error-state/error-state';
import { JobStatus } from '../job-status/job-status';
import { StaleBadge } from '../stale-badge/stale-badge';
import { OfflineBanner } from '../offline-banner/offline-banner';

export type DataRegionState =
  | { status: 'ready' }
  | { status: 'loading' }
  | {
      status: 'empty';
      reason: 'no-data' | 'no-matches';
      title: string;
      message?: string;
    }
  | {
      status: 'error';
      title: string;
      cause: string;
      scope?: string;
      retryLabel?: string;
      retrying?: boolean;
    }
  | { status: 'partial'; succeeded: number; failed: number; total?: number }
  | {
      status: 'stale';
      observedAt: string;
      staleAfterSeconds?: number;
      forceStale?: boolean;
      refreshing?: boolean;
    }
  | { status: 'offline'; cachedAt: string | null; reconnecting?: boolean };

@Component({
  selector: 'app-data-region',
  exportAs: 'appDataRegion',
  imports: [Skeleton, EmptyState, ErrorState, JobStatus, StaleBadge, OfflineBanner],
  templateUrl: './data-region.html',
})
export class DataRegion {
  readonly state = input.required<DataRegionState>();
  readonly skeletonRows = input(3);
  readonly skeletonVariant = input<'rows' | 'lines'>('rows');
  readonly loadingLabel = input('Loading records.');
  readonly retry = output<void>();
  readonly refresh = output<void>();
  readonly reconnect = output<void>();
  readonly writesDisabled = computed(() => this.state().status === 'offline');
  protected readonly empty = computed(() => {
    const state = this.state();
    return state.status === 'empty' ? state : null;
  });
  protected readonly error = computed(() => {
    const state = this.state();
    return state.status === 'error' ? state : null;
  });
  protected readonly partial = computed(() => {
    const state = this.state();
    return state.status === 'partial' ? state : null;
  });
  protected readonly stale = computed(() => {
    const state = this.state();
    return state.status === 'stale' ? state : null;
  });
  protected readonly offline = computed(() => {
    const state = this.state();
    return state.status === 'offline' ? state : null;
  });
}

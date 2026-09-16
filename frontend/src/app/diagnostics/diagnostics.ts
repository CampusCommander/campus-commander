import { Component, computed, inject } from '@angular/core';
import { DatePipe } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { AuthStore } from '../auth.store';
import {
  DataRegion,
  type DataRegionState,
} from '../shared/data-region/data-region';
import { DiagnosticsStore } from './diagnostics.store';

@Component({
  selector: 'app-diagnostics',
  imports: [MatButtonModule, DatePipe, DataRegion],
  templateUrl: './diagnostics.html',
  styleUrl: './diagnostics.css',
})
export class Diagnostics {
  protected readonly auth = inject(AuthStore);
  protected readonly diagnostics = inject(DiagnosticsStore);
  protected readonly connectionState = computed<DataRegionState>(() => {
    const health = this.diagnostics.health();
    if (health) {
      if (this.diagnostics.stale())
        return {
          status: 'stale',
          observedAt: health.observedAt,
          staleAfterSeconds: 60,
          forceStale: true,
          refreshing: this.diagnostics.refreshing(),
        };
      return { status: 'ready' };
    }
    if (this.diagnostics.refreshing()) return { status: 'loading' };
    const error = this.diagnostics.error();
    if (this.diagnostics.errorContext() === 'connections' && error)
      return {
        status: 'error',
        title: 'Connection status unavailable',
        cause: error,
        scope: 'Service connections',
        retryLabel: 'Retry connection check',
      };
    return {
      status: 'empty',
      reason: 'no-data',
      title: 'No connection results',
      message: 'Connection checks have not returned a result.',
    };
  });
  protected readonly operations = [
    {
      id: 'postgresql',
      label: 'PostgreSQL',
      description: 'Verify a synthetic database transaction and its rollback.',
    },
    {
      id: 'redis',
      label: 'Redis',
      description: 'Write, read, and remove a temporary cache value.',
    },
    {
      id: 'kestra',
      label: 'Kestra',
      description: 'Run a fixed task and verify the worker result.',
    },
    {
      id: 'artifacts',
      label: 'Artifact storage',
      description: 'Publish, read, verify, and remove a synthetic artifact.',
    },
  ] as const;
}

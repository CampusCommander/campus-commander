import { computed, inject, Injectable, OnDestroy, signal } from '@angular/core';
import {
  dependencyHealthSchema,
  diagnosticResultSchema,
  type DependencyHealth,
  type DiagnosticOperation,
  type DiagnosticResult,
} from '@campus/application-contracts';
import { AuthStore } from '../auth.store';

@Injectable({ providedIn: 'root' })
export class DiagnosticsStore implements OnDestroy {
  private readonly auth = inject(AuthStore);
  readonly health = signal<DependencyHealth | null>(null);
  readonly error = signal<string | null>(null);
  readonly refreshing = signal(false);
  readonly running = signal<DiagnosticOperation | null>(null);
  readonly results = signal<
    Partial<Record<DiagnosticOperation, DiagnosticResult>>
  >({});
  private readonly failedRefresh = signal(false);
  private readonly clock = signal(Date.now());
  private readonly clockTimer = setInterval(
    () => this.clock.set(Date.now()),
    1000,
  );
  readonly ageSeconds = computed(() => {
    const health = this.health();
    return health
      ? Math.max(
          0,
          Math.floor((this.clock() - Date.parse(health.observedAt)) / 1000),
        )
      : 0;
  });
  readonly stale = computed(
    () => this.failedRefresh() || this.ageSeconds() >= 60,
  );
  ngOnDestroy() {
    clearInterval(this.clockTimer);
  }

  async refresh() {
    this.refreshing.set(true);
    try {
      const response = await this.auth.request('/api/diagnostics');
      if (!response.ok) throw new Error();
      this.health.set(dependencyHealthSchema.parse(await response.json()));
      this.error.set(null);
      this.failedRefresh.set(false);
    } catch {
      this.failedRefresh.set(true);
      this.error.set(
        'Connection status is unavailable. Previous results are stale. Retry the connection check.',
      );
    } finally {
      this.refreshing.set(false);
    }
  }

  async run(operation: DiagnosticOperation) {
    if (this.running()) return;
    this.running.set(operation);
    this.error.set(null);
    try {
      const response = await this.auth.request(
        `/api/diagnostics/${operation}`,
        {},
      );
      if (response.status === 429) {
        this.error.set(
          'Another check is running. Wait for its result before another check.',
        );
        return;
      }
      if (!response.ok) throw new Error();
      const result = diagnosticResultSchema.parse(await response.json());
      this.results.update((previous) => ({ ...previous, [operation]: result }));
      await this.refresh();
    } catch {
      this.error.set(
        'The check result is unavailable. Refresh connection status before another check.',
      );
    } finally {
      this.running.set(null);
    }
  }
}

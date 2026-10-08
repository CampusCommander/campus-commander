import { Component, OnDestroy, OnInit, computed, signal } from '@angular/core';

interface StartupState {
  status: 'loading' | 'ready' | 'not-ready' | 'unavailable';
  checks: readonly StartupCheck[];
  observedAt: number | null;
}

interface StartupCheck {
  name: string;
  status: 'ready' | 'not-ready';
}

@Component({
  selector: 'app-startup',
  templateUrl: './startup.html',
  styleUrl: './startup.css',
})
export class Startup implements OnInit, OnDestroy {
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private readonly lifetime = new AbortController();
  protected readonly startup = signal<StartupState>({
    status: 'loading',
    checks: [],
    observedAt: null,
  });
  private readonly observedClock = signal(Date.now());
  protected readonly observationAgeSeconds = computed(() =>
    Math.max(
      0,
      Math.floor(
        (this.observedClock() -
          (this.startup().observedAt ?? this.observedClock())) /
          1000,
      ),
    ),
  );
  protected readonly observationTimestamp = computed(() => {
    const timestamp = this.startup().observedAt;
    return timestamp === null ? null : new Date(timestamp).toISOString();
  });

  ngOnInit() {
    void this.loadStartupStatus();
  }

  ngOnDestroy() {
    clearTimeout(this.refreshTimer);
    this.lifetime.abort();
  }

  private async loadStartupStatus() {
    this.observedClock.set(Date.now());
    try {
      const response = await fetch('/api/startup', {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
        signal: AbortSignal.any([
          AbortSignal.timeout(5000),
          this.lifetime.signal,
        ]),
      });
      const body: unknown = await response.json();
      if (!isStartupResponse(body)) throw new Error('Invalid startup status');
      if (!response.ok && body.status !== 'not-ready') {
        throw new Error('Startup status request failed');
      }
      this.observedClock.set(Date.now());
      this.startup.set({
        status: body.status,
        checks: body.checks,
        observedAt: Date.now(),
      });
    } catch {
      this.observedClock.set(Date.now());
      this.startup.update((previous) => ({
        ...previous,
        status: 'unavailable',
      }));
    } finally {
      if (!this.lifetime.signal.aborted) {
        this.refreshTimer = setTimeout(
          () => void this.loadStartupStatus(),
          10000,
        );
      }
    }
  }
}

function isStartupResponse(value: unknown): value is {
  phase: 1;
  status: 'ready' | 'not-ready';
  checks: StartupCheck[];
} {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate['phase'] === 1 &&
    (candidate['status'] === 'ready' || candidate['status'] === 'not-ready') &&
    Array.isArray(candidate['checks']) &&
    candidate['checks'].length > 0 &&
    candidate['checks'].every(
      (check) =>
        check &&
        typeof check === 'object' &&
        typeof (check as Record<string, unknown>)['name'] === 'string' &&
        ['ready', 'not-ready'].includes(
          String((check as Record<string, unknown>)['status']),
        ),
    ) &&
    (candidate['status'] === 'ready') ===
      candidate['checks'].every((check) => check.status === 'ready')
  );
}

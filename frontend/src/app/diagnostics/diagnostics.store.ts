import { DOCUMENT } from '@angular/common';
import {
  computed,
  effect,
  inject,
  Injectable,
  OnDestroy,
  signal,
  untracked,
} from '@angular/core';
import {
  dependencyHealthSchema,
  diagnosticResultSchema,
  type DependencyHealth,
  type DiagnosticOperation,
  type DiagnosticResult,
} from '@campus/application-contracts';
import { AuthStore } from '../auth.store';

/** Milliseconds between connection status reads while the tab is visible. */
export const DIAGNOSTICS_POLL_MS = 30_000;

/** The footer and the Diagnostics page need diagnostics:read (design 2.1). */
export function diagnosticsReadable(
  auth: InstanceType<typeof AuthStore>,
): boolean {
  return (
    auth.session()?.identity.permissions?.includes('diagnostics:read') ?? false
  );
}

@Injectable({ providedIn: 'root' })
export class DiagnosticsStore implements OnDestroy {
  private readonly auth = inject(AuthStore);
  private readonly document = inject(DOCUMENT);
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

  /** The shell shows the connection status. It asks for timed reads. */
  private wanted = false;
  /** The person whose reads and answers belong to this state. */
  private identity: string | null = null;
  /** Increments on another person. A late answer for the old person changes nothing. */
  private epoch = 0;
  /** The one read in flight. */
  private reading: Promise<void> | null = null;
  /** The timed read of a visible tab. */
  private pollTimer: ReturnType<typeof setInterval> | undefined;

  constructor() {
    // The reads and the timer belong to one person (the JobsStore fence).
    effect(() => {
      const person = diagnosticsReadable(this.auth)
        ? (this.auth.session()?.identity.id ?? null)
        : null;
      untracked(() => {
        if (person !== this.identity) {
          if (this.identity !== null) this.reset();
          this.identity = person;
        }
        if (person === null) this.stopPolling();
        else if (this.wanted && this.visible()) this.startPolling();
      });
    });
  }
  ngOnDestroy() {
    clearInterval(this.clockTimer);
    this.unwatch();
  }

  /** The shell shows the footer status. Read now and every 30 s while visible. */
  watch(): void {
    if (this.wanted) return;
    this.wanted = true;
    this.identity = diagnosticsReadable(this.auth)
      ? (this.auth.session()?.identity.id ?? null)
      : null;
    this.document.addEventListener('visibilitychange', this.onVisibility);
    if (this.identity !== null && this.visible()) this.startPolling();
  }

  /** The shell is gone. Stop the timer. The state stays for the same person. */
  unwatch(): void {
    if (!this.wanted) return;
    this.wanted = false;
    this.document.removeEventListener('visibilitychange', this.onVisibility);
    this.stopPolling();
  }

  /** Read the connection status now. The Diagnostics page and the shell share it. */
  async refresh(): Promise<void> {
    // Keep the fence of the person who asked. The wait for a timed read must not
    // carry this read across a sign-out or another person.
    const epoch = this.epoch;
    const identity = this.identity;
    // A timed read may be in flight. Wait for it so this read starts from current state.
    if (this.reading) await this.reading.catch(() => undefined);
    // Drop the queued read when that person signed out or another person arrived.
    if (!this.authorizedRead(epoch, identity)) return;
    await this.read(false);
  }

  /** The person who asked for a read still holds the read fence and the permission. */
  private authorizedRead(epoch: number, identity: string | null): boolean {
    return (
      identity !== null &&
      identity === this.identity &&
      epoch === this.epoch &&
      diagnosticsReadable(this.auth)
    );
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

  private readonly onVisibility = (): void => {
    if (this.identity === null) return;
    if (this.visible()) this.startPolling();
    else this.stopPolling();
  };

  private visible(): boolean {
    return this.document.visibilityState !== 'hidden';
  }

  /** Start the 30 s read of a visible tab and read at once. */
  private startPolling(): void {
    if (this.pollTimer !== undefined) return;
    this.pollTimer = setInterval(() => {
      if (this.visible()) void this.read(true);
    }, DIAGNOSTICS_POLL_MS);
    void this.read(true);
  }

  private stopPolling(): void {
    if (this.pollTimer !== undefined) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  /** Another person signed in. Drop the previous person's state and answers. */
  private reset(): void {
    this.epoch++;
    this.reading = null;
    this.stopPolling();
    this.health.set(null);
    this.error.set(null);
    this.failedRefresh.set(false);
    this.refreshing.set(false);
    this.running.set(null);
    this.results.set({});
  }

  /** One read of the connection status. At most one read is in flight. */
  private read(timed: boolean): Promise<void> {
    if (this.reading) return this.reading;
    const epoch = this.epoch;
    const identity = this.identity;
    // A late answer for another person changes nothing.
    const current = () => epoch === this.epoch && identity === this.identity;
    if (!timed) this.refreshing.set(true);
    const reading = this.fetchHealth(current).finally(() => {
      if (this.reading === reading) this.reading = null;
      if (!timed && current()) this.refreshing.set(false);
    });
    this.reading = reading;
    return reading;
  }

  private async fetchHealth(current: () => boolean): Promise<void> {
    try {
      const response = await this.auth.request('/api/diagnostics');
      if (!current()) return;
      if (!response.ok) throw new Error();
      const health = dependencyHealthSchema.parse(await response.json());
      if (!current()) return;
      this.health.set(health);
      this.error.set(null);
      this.failedRefresh.set(false);
    } catch {
      if (!current()) return;
      this.failedRefresh.set(true);
      this.error.set(
        'Connection status is unavailable. Previous results are stale. Retry the connection check.',
      );
    }
  }
}

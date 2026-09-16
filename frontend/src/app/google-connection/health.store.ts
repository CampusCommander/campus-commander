import {
  Injectable,
  OnDestroy,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import {
  GOOGLE_CAPABILITIES,
  GOOGLE_HEALTH_RECOVERY,
  GOOGLE_HEALTH_FRESH_SECONDS,
  googleHealthResponseSchema,
  type GoogleHealth,
  type GoogleHealthCapability,
} from '@campus/application-contracts';
import { AuthStore } from '../auth.store';
import { ConnectionStore } from './connection.store';

@Injectable({ providedIn: 'root' })
export class GoogleHealthStore implements OnDestroy {
  private readonly auth = inject(AuthStore);
  private readonly connection = inject(ConnectionStore);
  readonly readable = this.connection.readable;
  readonly health = signal<GoogleHealth | null>(null);
  readonly loading = signal(false);
  readonly running = signal(false);
  readonly loaded = signal(false);
  readonly unavailable = signal(true);
  readonly error = signal('');
  readonly message = signal('');
  readonly recovery = GOOGLE_HEALTH_RECOVERY;
  readonly capabilities = GOOGLE_CAPABILITIES.filter(
    (item) => item.enabled && item.qualified,
  );
  private readonly elapsed = signal(performance.now());
  private receivedAt = performance.now();
  private readonly timer = setInterval(
    () => this.elapsed.set(performance.now()),
    1000,
  );
  private request = 0;
  private identity = '';
  private destroyed = false;
  readonly now = computed(() => {
    const health = this.health();
    return health
      ? Date.parse(health.observedAt) +
          Math.max(0, this.elapsed() - this.receivedAt)
      : 0;
  });
  readonly pending = computed(() => {
    const check = this.health()?.check;
    return (
      !!check && !check.finishedAt && Date.parse(check.expiresAt) > this.now()
    );
  });
  readonly expired = computed(() => {
    const check = this.health()?.check;
    return !!check && !check.finishedAt && !this.pending();
  });
  readonly retrySeconds = computed(
    () =>
      Math.max(
        0,
        Math.ceil(
          (Date.parse(this.health()?.check?.retryAt ?? '') - this.now()) / 1000,
        ),
      ) || 0,
  );
  readonly canCheck = computed(() => {
    const health = this.health();
    return (
      !!health &&
      this.auth.can('connection:diagnose', {
        kind: 'district',
        customerId: health.customerId,
      })
    );
  });
  readonly disabled = computed(
    () =>
      !this.canCheck() ||
      this.unavailable() ||
      this.loading() ||
      this.running() ||
      this.pending() ||
      this.retrySeconds() > 0 ||
      this.auth.interrupted(),
  );
  readonly summary = computed(() => {
    const health = this.health();
    if (this.unavailable()) return 'Google status unavailable';
    if (!health) return 'Google customer not connected';
    if (this.pending() || this.running()) return 'Google check running';
    if (health.backgroundFailure)
      return 'Google background access needs attention';
    if (this.expired()) return 'Google check expired';
    const failed = health.capabilities.filter(
      (item) => item.failure !== null,
    ).length;
    if (failed)
      return `Google: ${failed} of ${health.capabilities.length} capabilities need attention`;
    if (health.capabilities.some((item) => this.stale(item.checkedAt)))
      return 'Google observations are stale';
    return `Google: ${health.capabilities.length} last checks passed`;
  });

  constructor() {
    effect(() => {
      const identity = this.sessionKey();
      const binding = this.connection.connection();
      const key = `${identity}:${binding?.customerId ?? ''}:${binding?.generation ?? ''}`;
      if (key === this.identity) return;
      this.identity = key;
      this.request += 1;
      this.health.set(null);
      this.loaded.set(false);
      this.loading.set(false);
      this.running.set(false);
      this.unavailable.set(true);
      this.error.set('');
      this.message.set('');
      if (identity) untracked(() => void this.refresh());
    });
  }
  ngOnDestroy() {
    this.destroyed = true;
    this.request += 1;
    clearInterval(this.timer);
  }
  private sessionKey() {
    const session = this.auth.session();
    return this.readable() && session && !this.auth.interrupted()
      ? `${session.identity.id}:${session.identity.permissionVersion}:${session.csrfToken}`
      : '';
  }
  private current(request: number, session: string) {
    return (
      !this.destroyed &&
      request === this.request &&
      session === this.sessionKey()
    );
  }
  age(timestamp: string) {
    return Math.max(0, Math.floor((this.now() - Date.parse(timestamp)) / 1000));
  }
  stale(timestamp: string) {
    return (
      this.unavailable() || this.age(timestamp) >= GOOGLE_HEALTH_FRESH_SECONDS
    );
  }
  result(id: GoogleHealthCapability) {
    return this.health()?.capabilities.find((item) => item.capability === id);
  }
  private accept(health: GoogleHealth | null) {
    this.receivedAt = performance.now();
    this.elapsed.set(this.receivedAt);
    this.health.set(health);
    this.loaded.set(true);
    this.unavailable.set(false);
  }
  async refresh() {
    const session = this.sessionKey();
    if (!session || this.running()) return;
    const request = ++this.request;
    this.loading.set(true);
    this.error.set('');
    try {
      const response = await this.auth.request('/api/google-connection/health');
      if (!this.current(request, session)) return;
      if (response.status === 403) this.health.set(null);
      if (!response.ok) throw new Error();
      const result = googleHealthResponseSchema.parse(await response.json());
      if (!this.current(request, session)) return;
      this.accept(result.health);
    } catch {
      if (!this.current(request, session)) return;
      this.unavailable.set(true);
      this.error.set(
        'Google status is unavailable. Previous observations are stale. Check application access and connectivity, then refresh Google status.',
      );
    } finally {
      if (this.current(request, session)) this.loading.set(false);
    }
  }
  async check(
    capabilities: GoogleHealthCapability[] = this.capabilities.map(
      (item) => item.id,
    ),
  ) {
    const health = this.health();
    if (!health || this.disabled()) return;
    const session = this.sessionKey();
    const request = ++this.request;
    this.running.set(true);
    this.error.set('');
    this.message.set('Checking selected Google capabilities.');
    try {
      const response = await this.auth.request(
        '/api/google-connection/health/check',
        {
          customerId: health.customerId,
          generation: health.generation,
          capabilities,
        },
      );
      if (!this.current(request, session)) return;
      if (response.status === 403) this.health.set(null);
      if (!response.ok) {
        this.unavailable.set(true);
        this.message.set('');
        this.error.set(
          response.status === 429
            ? 'Another Google check is running or the retry interval has not ended. Refresh Google status before retrying.'
            : 'The Google check result is unknown or your access changed. Refresh Google status before retrying.',
        );
        return true;
      }
      const result = googleHealthResponseSchema.parse(await response.json());
      if (!this.current(request, session)) return;
      this.accept(result.health);
      this.message.set('Google check finished. Review each capability result.');
      return true;
    } catch {
      if (!this.current(request, session)) return;
      this.unavailable.set(true);
      this.message.set('');
      this.error.set(
        'The Google check result is unknown. Refresh Google status after connectivity returns. Previous observations remain historical.',
      );
      return true;
    } finally {
      if (this.current(request, session)) this.running.set(false);
    }
  }
}

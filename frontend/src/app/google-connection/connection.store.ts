import {
  Injectable,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import {
  googleConnectionStateSchema,
  type GoogleConnection,
} from '@campus/application-contracts';
import { AuthStore } from '../auth.store';

@Injectable({ providedIn: 'root' })
export class ConnectionStore {
  private readonly auth = inject(AuthStore);
  readonly connection = signal<GoogleConnection | null>(null);
  readonly loading = signal(false);
  readonly loaded = signal(false);
  readonly stale = signal(true);
  readonly error = signal('');
  readonly readable = computed(
    () =>
      this.auth.metadata()?.phase === 3 &&
      !!this.auth
        .session()
        ?.identity.grants.some(
          (grant) =>
            grant.action === 'connection:read' &&
            ['platform', 'district'].includes(grant.scope.kind),
        ),
  );
  private identity = '';
  private request = 0;

  constructor() {
    effect(() => {
      const session = this.auth.session();
      const identity =
        this.readable() && session
          ? `${session.identity.id}:${session.identity.permissionVersion}:${session.csrfToken}`
          : '';
      if (identity === this.identity) return;
      this.identity = identity;
      this.request += 1;
      this.connection.set(null);
      this.loaded.set(false);
      this.loading.set(false);
      this.stale.set(true);
      this.error.set('');
      if (identity) untracked(() => void this.refresh());
    });
  }

  async refresh() {
    if (!this.readable()) return;
    const request = ++this.request;
    const session = this.auth.session()?.csrfToken;
    this.loading.set(true);
    this.error.set('');
    try {
      const response = await this.auth.request('/api/google-connection');
      if (!response.ok) throw new Error();
      const result = googleConnectionStateSchema.parse(await response.json());
      if (
        request !== this.request ||
        session !== this.auth.session()?.csrfToken ||
        this.auth.interrupted()
      )
        return;
      this.connection.set(result.connection);
      this.loaded.set(true);
      this.stale.set(false);
    } catch {
      if (request !== this.request) return;
      this.stale.set(true);
      this.error.set(
        'Saved connection status is unavailable. Check your connection and access, then refresh.',
      );
    } finally {
      if (request === this.request) this.loading.set(false);
    }
  }
}

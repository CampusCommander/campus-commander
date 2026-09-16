import { Component, inject, OnInit, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import {
  actionSchema,
  grantsForPreset,
  platformAccessResultSchema,
  platformAccessReviewSchema,
  platformPrincipalPageSchema,
  platformPrincipalSchema,
  type Action,
  type Grant,
  type PlatformAccessReview,
  type PlatformPrincipal,
} from '@campus/application-contracts';
import { AuthStore } from '../auth.store';
import { actionLabels } from '../action-labels';

@Component({
  selector: 'app-platform-access',
  imports: [DatePipe, FormsModule, MatButtonModule, MatCheckboxModule],
  templateUrl: './platform-access.html',
  styleUrl: './platform-access.css',
})
export class PlatformAccess implements OnInit {
  protected readonly auth = inject(AuthStore);
  protected readonly labels = actionLabels;
  protected readonly actions = actionSchema.options;
  protected readonly principals = signal<PlatformPrincipal[]>([]);
  protected readonly total = signal(0);
  protected readonly offset = signal(0);
  protected readonly observedAt = signal<Date | null>(null);
  protected readonly selected = signal<PlatformPrincipal | null>(null);
  protected readonly preview = signal<PlatformAccessReview | null>(null);
  protected readonly error = signal('');
  protected readonly message = signal('');
  protected readonly loading = signal(false);
  protected readonly busy = signal(false);
  protected readonly stale = signal(false);
  protected enabled = true;
  protected chosen: Partial<Record<Action, boolean>> = {};
  protected confirmed = false;
  ngOnInit() {
    void this.refresh();
  }
  protected canManage() {
    return this.auth.can('platform-users:manage', { kind: 'platform' });
  }
  protected async refresh(offset = this.offset()) {
    if (this.loading() || this.busy()) return;
    this.loading.set(true);
    this.error.set('');
    try {
      const response = await this.auth.request(
        `/api/platform-users?offset=${offset}&limit=50`,
      );
      if (!response.ok) throw new Error();
      const page = platformPrincipalPageSchema.parse(await response.json());
      this.principals.set(page.items);
      this.total.set(page.total);
      this.offset.set(page.offset);
      this.observedAt.set(new Date());
      this.stale.set(false);
      const current = page.items.find(
        (item) => item.id === this.selected()?.id,
      );
      if (
        current &&
        current.permissionVersion !== this.selected()?.permissionVersion
      ) {
        this.invalidate();
        this.message.set(
          'This principal changed. Reload its access before another review.',
        );
      }
    } catch {
      this.stale.set(true);
      this.invalidate();
      this.error.set(
        'Platform users are unavailable. Check your connection and access, then refresh. Your edits remain in place.',
      );
    } finally {
      this.loading.set(false);
    }
  }
  protected invalidate() {
    this.preview.set(null);
    this.confirmed = false;
  }
  protected async inspect(id: string) {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      const response = await this.auth.request(`/api/platform-users/${id}`);
      if (!response.ok) throw new Error();
      const principal = platformPrincipalSchema.parse(await response.json());
      this.selected.set(principal);
      this.enabled = principal.enabled;
      this.chosen = Object.fromEntries(
        principal.grants
          .filter((grant) => grant.scope.kind === 'platform')
          .map((grant) => [grant.action, true]),
      );
      this.invalidate();
      this.message.set(
        'Current access loaded. Review changes before confirmation.',
      );
    } catch {
      this.error.set(
        'Access details are unavailable. Retry when the connection and your access return.',
      );
    } finally {
      this.busy.set(false);
    }
  }
  protected preset(full: boolean) {
    this.chosen = Object.fromEntries(
      (full
        ? grantsForPreset('platform-administrator', { kind: 'platform' })
        : []
      ).map((grant) => [grant.action, true]),
    );
    this.invalidate();
  }
  protected fullPresetAllowed() {
    return this.actions.every((action) =>
      this.auth.can(action, { kind: 'platform' }),
    );
  }
  protected close() {
    this.selected.set(null);
    this.invalidate();
  }
  protected scope(grant: Grant) {
    return grant.scope.kind === 'platform'
      ? 'Installation'
      : grant.scope.kind === 'district'
        ? `District ${grant.scope.customerId}`
        : `School ${grant.scope.schoolId} in ${grant.scope.customerId}`;
  }
  protected async review() {
    const principal = this.selected();
    if (!principal || this.busy() || this.stale() || !this.canManage()) return;
    this.busy.set(true);
    this.error.set('');
    this.invalidate();
    try {
      const grants = [
        ...principal.grants.filter((grant) => grant.scope.kind !== 'platform'),
        ...this.actions
          .filter((action) => this.chosen[action])
          .map((action) => ({ action, scope: { kind: 'platform' as const } })),
      ];
      const response = await this.auth.request(
        `/api/platform-users/${principal.id}/review`,
        {
          expectedVersion: principal.permissionVersion,
          enabled: this.enabled,
          grants,
        },
      );
      if (!response.ok) throw new Error();
      this.preview.set(platformAccessReviewSchema.parse(await response.json()));
      this.message.set(
        'Review this identity, enabled state, and exact grants before confirmation.',
      );
    } catch {
      this.error.set(
        'Access review failed. Reload current access and check your delegation authority. Keep one enabled platform administrator.',
      );
    } finally {
      this.busy.set(false);
    }
  }
  protected async apply() {
    const preview = this.preview();
    if (!preview || !this.confirmed || this.busy() || this.stale()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      const response = await this.auth.request(
        `/api/platform-users/${preview.current.id}/access`,
        {
          expectedVersion: preview.targetVersion,
          actorVersion: preview.actorVersion,
          ...preview.proposed,
          confirmation: 'change-platform-access',
        },
      );
      if (!response.ok) throw new Error();
      const result = platformAccessResultSchema.parse(await response.json());
      this.selected.set(result.principal);
      this.principals.update((items) =>
        items.map((item) =>
          item.id === result.principal.id ? result.principal : item,
        ),
      );
      this.invalidate();
      this.message.set(
        `Access changed. Previous sessions require sign-in. Receipt: ${result.receiptId}.`,
      );
      if (result.principal.id === this.auth.session()?.identity.id) {
        await this.auth.request('/api/auth/session');
      }
    } catch {
      this.invalidate();
      this.stale.set(true);
      this.error.set(
        'Confirmation did not complete. Refresh and reload current access before retrying. Your edits remain in place.',
      );
    } finally {
      this.busy.set(false);
    }
  }
}

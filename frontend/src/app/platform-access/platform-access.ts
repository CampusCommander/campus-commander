import {
  Component,
  effect,
  inject,
  OnDestroy,
  OnInit,
  signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import {
  actionSchema,
  grantsForPreset,
  grantsSchema,
  platformAccessResultSchema,
  platformAccessRejectionSchema,
  platformAccessReceiptPageSchema,
  type PlatformAccessReceiptPage,
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
import { ScopedGrants } from './scoped-grants';

@Component({
  selector: 'app-platform-access',
  imports: [
    DatePipe,
    FormsModule,
    MatButtonModule,
    MatCheckboxModule,
    ScopedGrants,
  ],
  templateUrl: './platform-access.html',
  styleUrl: './platform-access.css',
})
export class PlatformAccess implements OnInit, OnDestroy {
  protected readonly auth = inject(AuthStore);
  protected readonly labels = actionLabels;
  protected readonly permissionLabels = {
    'identity:read': 'View own account',
    'diagnostics:read': 'View installation diagnostics',
    'diagnostics:run': 'Run installation diagnostics',
  };
  protected readonly actions = actionSchema.options;
  protected readonly principals = signal<PlatformPrincipal[]>([]);
  protected readonly total = signal(0);
  protected readonly offset = signal(0);
  protected readonly observedAt = signal<Date | null>(null);
  protected readonly selected = signal<PlatformPrincipal | null>(null);
  protected readonly preview = signal<PlatformAccessReview | null>(null);
  protected readonly receipts = signal<PlatformAccessReceiptPage | null>(null);
  protected readonly receiptError = signal('');
  protected readonly receiptLoading = signal(false);
  protected readonly error = signal('');
  protected readonly message = signal('');
  protected readonly loading = signal(false);
  protected readonly busy = signal(false);
  protected readonly stale = signal(false);
  protected readonly scopedGrants = signal<Grant[]>([]);
  private destroyed = false;
  private identity = this.sessionKey();
  protected enabled = true;
  protected chosen: Partial<Record<Action, boolean>> = {};
  protected confirmed = false;
  constructor() {
    effect(() => {
      const identity = this.sessionKey();
      if (this.auth.interrupted() || identity !== this.identity) {
        this.identity = identity;
        this.invalidate();
        this.stale.set(true);
      }
    });
  }
  ngOnInit() {
    void this.refresh();
  }
  ngOnDestroy() {
    this.destroyed = true;
  }
  private sessionKey() {
    const session = this.auth.session();
    return session
      ? `${session.identity.id}:${session.identity.permissionVersion}:${session.csrfToken}`
      : undefined;
  }
  protected scopedCapacity() {
    return 256 - this.actions.filter((action) => this.chosen[action]).length;
  }
  protected changeScopedGrants(grants: Grant[]) {
    this.scopedGrants.set(grants);
    this.invalidate();
  }
  protected canManage() {
    return this.auth.can('platform-users:manage', { kind: 'platform' });
  }
  protected async refresh(offset = this.offset()) {
    if (this.loading() || this.busy()) return;
    const sessionToken = this.sessionKey();
    this.loading.set(true);
    this.error.set('');
    try {
      const response = await this.auth.request(
        `/api/platform-users?offset=${offset}&limit=50`,
      );
      if (!response.ok) throw new Error();
      const page = platformPrincipalPageSchema.parse(await response.json());
      if (!this.currentSession(sessionToken)) return;
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
          'This person’s access changed. Reload it before reviewing your changes.',
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
  private currentSession(token: string | undefined) {
    return (
      !this.destroyed && token === this.sessionKey() && !this.auth.interrupted()
    );
  }
  protected invalidate() {
    this.preview.set(null);
    this.confirmed = false;
  }
  protected async inspect(id: string) {
    if (this.busy()) return;
    const sessionToken = this.sessionKey();
    this.invalidate();
    this.busy.set(true);
    this.error.set('');
    try {
      const response = await this.auth.request(`/api/platform-users/${id}`);
      if (!response.ok) throw new Error();
      const principal = platformPrincipalSchema.parse(await response.json());
      if (!this.currentSession(sessionToken)) return;
      this.selected.set(principal);
      this.stale.set(false);
      this.receipts.set(null);
      void this.loadReceipts();
      this.enabled = principal.enabled;
      this.scopedGrants.set(
        principal.grants.filter((grant) => grant.scope.kind !== 'platform'),
      );
      this.chosen = Object.fromEntries(
        principal.grants
          .filter((grant) => grant.scope.kind === 'platform')
          .map((grant) => [grant.action, true]),
      );
      this.invalidate();
      this.message.set(
        'Permissions loaded. Review your changes before saving.',
      );
    } catch {
      this.stale.set(true);
      this.invalidate();
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
    this.scopedGrants.set([]);
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
    const sessionToken = this.sessionKey();
    this.busy.set(true);
    this.error.set('');
    this.invalidate();
    try {
      const grants = [
        ...this.scopedGrants(),
        ...this.actions
          .filter((action) => this.chosen[action])
          .map((action) => ({ action, scope: { kind: 'platform' as const } })),
      ];
      if (!grantsSchema.safeParse(grants).success) {
        this.error.set(
          'Check your permissions. Select no more than 256 and choose a valid district or school for each.',
        );
        return;
      }
      const response = await this.auth.request(
        `/api/platform-users/${principal.id}/review`,
        {
          expectedVersion: principal.permissionVersion,
          enabled: this.enabled,
          grants,
        },
      );
      if (!response.ok) {
        if (response.status >= 500) throw new Error();
        this.error.set(await this.rejectionMessage(response));
        return;
      }
      const review = platformAccessReviewSchema.parse(await response.json());
      if (!this.currentSession(sessionToken)) return;
      this.preview.set(review);
      this.message.set(
        'Check the person, sign-in access, and permissions before saving.',
      );
    } catch {
      this.stale.set(true);
      this.error.set(
        'Access review is unavailable. Check your connection, then reload current access. Your edits remain in place.',
      );
    } finally {
      this.busy.set(false);
    }
  }
  protected async loadReceipts(offset = 0) {
    const id = this.selected()?.id;
    if (!id) return;
    const sessionToken = this.sessionKey();
    this.receiptLoading.set(true);
    this.receiptError.set('');
    try {
      const response = await this.auth.request(
        `/api/platform-users/${id}/receipts?offset=${offset}`,
      );
      if (!response.ok) throw new Error();
      const receipts = platformAccessReceiptPageSchema.parse(
        await response.json(),
      );
      if (this.selected()?.id === id && this.currentSession(sessionToken))
        this.receipts.set(receipts);
    } catch {
      if (this.selected()?.id === id)
        this.receiptError.set(
          'Access change history is unavailable. Check your connection and account access, then refresh the history.',
        );
    } finally {
      this.receiptLoading.set(false);
    }
  }
  private async rejectionMessage(response: Response) {
    const parsed = platformAccessRejectionSchema.safeParse(
      await response.json().catch(() => null),
    );
    const reason = parsed.success
      ? parsed.data.reason
      : response.status === 403
        ? 'forbidden'
        : 'conflict';
    if (reason === 'conflict' || reason === 'forbidden') this.stale.set(true);
    return {
      'invitations-changed':
        'Pending invitations changed. Review access again before confirmation.',
      'school-changed':
        'The school definition changed. Review access again before confirmation.',
      'school-unavailable':
        'Refresh and verify the school scope before granting access.',
      unchanged:
        'There are no changes to review. Edit sign-in access or select different permissions first.',
      conflict:
        'Current access changed. Reload access and review your changes again.',
      delegation:
        'You can only assign permissions that you hold. Check your selections.',
      'last-administrator':
        'At least one platform administrator must keep full access. Assign another administrator before removing these permissions.',
      forbidden:
        'Your current access does not permit this change. Reload your session or contact a platform administrator.',
    }[reason];
  }
  protected async apply() {
    const preview = this.preview();
    if (!preview || !this.confirmed || this.busy() || this.stale()) return;
    const sessionToken = this.sessionKey();
    this.busy.set(true);
    this.error.set('');
    try {
      const response = await this.auth.request(
        `/api/platform-users/${preview.current.id}/access`,
        {
          expectedVersion: preview.targetVersion,
          actorVersion: preview.actorVersion,
          schoolRevisions: preview.schoolRevisions,
          invitationIds: preview.invitationsToRevoke.map(
            (invitation) => invitation.id,
          ),
          ...preview.proposed,
          confirmation: 'change-platform-access',
        },
      );
      if (!response.ok) {
        if (response.status >= 500) throw new Error();
        this.invalidate();
        this.error.set(await this.rejectionMessage(response));
        return;
      }
      const result = platformAccessResultSchema.parse(await response.json());
      if (!this.currentSession(sessionToken)) return;
      this.selected.set(result.principal);
      this.scopedGrants.set(
        result.principal.grants.filter(
          (grant) => grant.scope.kind !== 'platform',
        ),
      );
      this.principals.update((items) =>
        items.map((item) =>
          item.id === result.principal.id ? result.principal : item,
        ),
      );
      this.invalidate();
      this.message.set(
        `Access saved. This person must sign in again. Change reference: ${result.receiptId}.`,
      );
      if (result.principal.id === this.auth.session()?.identity.id) {
        void this.auth.request('/api/auth/session').catch(() => {
          this.error.set(
            'Access changed. Session verification is unavailable. Sign in again to check your current access.',
          );
        });
      } else {
        void this.loadReceipts();
      }
    } catch {
      this.invalidate();
      this.stale.set(true);
      this.error.set(
        'We have not received a save confirmation. Reload access and check the change history before trying again. Your edits are still here.',
      );
    } finally {
      this.busy.set(false);
    }
  }
}

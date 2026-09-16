import {
  Component,
  OnDestroy,
  OnInit,
  effect,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import {
  actionSchema,
  createInvitationSchema,
  invitationSchema,
  type Action,
  type Invitation,
} from '@campus/application-contracts';
import { AuthStore } from '../auth.store';

import { actionLabels } from '../action-labels';

@Component({
  selector: 'app-invitations',
  imports: [
    FormsModule,
    DatePipe,
    MatButtonModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatInputModule,
  ],
  templateUrl: './invitations.html',
  styleUrl: './invitations.css',
})
export class Invitations implements OnInit, OnDestroy {
  protected readonly auth = inject(AuthStore);
  protected readonly items = signal<Invitation[]>([]);
  protected readonly loading = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly message = signal('');
  protected readonly observedAt = signal<Date | null>(null);
  protected readonly stale = signal(false);
  protected readonly link = signal('');
  protected readonly review = signal<Invitation | null>(null);
  protected readonly labels = actionLabels;
  protected readonly actions = actionSchema.options;
  protected label = '';
  protected expectedSubject = '';
  protected expiresInHours = 24;
  protected selected: Partial<Record<Action, boolean>> = {};
  protected verified = false;
  private readonly clearLink = () => this.link.set('');

  constructor() {
    effect(() => {
      if (this.auth.interrupted()) {
        this.clearLink();
        this.review.set(null);
        this.verified = false;
        this.stale.set(true);
      }
    });
  }
  ngOnInit() {
    window.addEventListener('pagehide', this.clearLink);
    void this.refresh();
  }
  ngOnDestroy() {
    this.clearLink();
    window.removeEventListener('pagehide', this.clearLink);
  }
  protected canInvite() {
    return this.auth.can('platform-users:invite', { kind: 'platform' });
  }
  protected async refresh() {
    if (this.loading()) return;
    this.loading.set(true);
    this.error.set('');
    try {
      const response = await this.auth.request('/api/auth/invitations');
      if (!response.ok) throw new Error();
      this.items.set(invitationSchema.array().parse(await response.json()));
      this.observedAt.set(new Date());
      this.stale.set(false);
      if (this.review()) {
        const updated = this.items().find(
          (item) => item.id === this.review()?.id,
        );
        if (!updated || updated.version !== this.review()?.version) {
          this.review.set(null);
          this.verified = false;
        }
      }
    } catch {
      this.stale.set(true);
      this.error.set(
        'Invitations are unavailable. Check your connection and access, then refresh. Your form values remain in place.',
      );
    } finally {
      this.loading.set(false);
    }
  }
  protected async create() {
    if (this.busy() || this.stale() || !this.canInvite()) return;
    const parsed = createInvitationSchema.safeParse({
      label: this.label,
      expiresInHours: Number(this.expiresInHours),
      ...(this.expectedSubject.trim()
        ? { expectedSubject: this.expectedSubject.trim() }
        : {}),
      grants: this.actions
        .filter((action) => this.selected[action])
        .map((action) => ({ action, scope: { kind: 'platform' } })),
    });
    if (!parsed.success) {
      this.error.set(
        'Enter a recipient label and an expiry between 1 and 168 hours.',
      );
      return;
    }
    this.busy.set(true);
    this.error.set('');
    this.message.set('');
    this.clearLink();
    try {
      const response = await this.auth.request(
        '/api/auth/invitations',
        parsed.data,
      );
      if (!response.ok) throw new Error();
      const result: { url: string } = await response.json();
      this.link.set(result.url);
      this.message.set(
        'Invitation created. Copy the link before leaving this page.',
      );
      this.label = '';
      this.expectedSubject = '';
      this.selected = {};
      await this.refresh();
    } catch {
      this.error.set(
        'The request did not complete. Refresh invitations before retrying. Revoke an invitation if its link was lost.',
      );
    } finally {
      this.busy.set(false);
    }
  }
  protected async copy() {
    try {
      await navigator.clipboard.writeText(this.link());
      this.message.set(
        'Invitation link copied. Share it with the intended recipient.',
      );
    } catch {
      this.error.set(
        'Clipboard access failed. Select and copy the invitation link.',
      );
    }
  }
  protected inspect(item: Invitation) {
    this.review.set(item);
    this.verified = false;
    this.message.set(
      'Review the verified identity and every grant before confirmation.',
    );
  }
  protected active(item: Invitation) {
    return ['issued', 'redeeming', 'pending'].includes(item.status);
  }
  protected async mutate(item: Invitation, operation: 'revoke' | 'confirm') {
    if (
      this.busy() ||
      !this.canInvite() ||
      (operation === 'confirm' && !this.verified)
    )
      return;
    this.busy.set(true);
    this.error.set('');
    this.message.set('');
    try {
      const response = await this.auth.request(
        `/api/auth/invitations/${item.id}/${operation}`,
        {
          version: item.version,
          ...(operation === 'confirm'
            ? { subject: item.candidateSubject }
            : {}),
        },
      );
      if (!response.ok) throw new Error();
      this.review.set(null);
      this.verified = false;
      this.message.set(
        operation === 'confirm'
          ? 'Access granted. The recipient can now sign in.'
          : 'Invitation revoked. Create another invitation to replace it.',
      );
      await this.refresh();
    } catch {
      this.stale.set(true);
      this.error.set(
        'The invitation or your access changed. Refresh and review the current state before retrying.',
      );
    } finally {
      this.busy.set(false);
    }
  }
}

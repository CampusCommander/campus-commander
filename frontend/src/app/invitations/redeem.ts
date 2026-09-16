import { Component, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import {
  invitationStatusSchema,
  invitationTokenSchema,
} from '@campus/application-contracts';

@Component({
  selector: 'app-redeem-invitation',
  imports: [FormsModule, MatButtonModule, MatFormFieldModule, MatInputModule],
  templateUrl: './redeem.html',
  styleUrls: ['../login/login.css', './invitations.css'],
})
export class RedeemInvitation implements OnInit {
  protected token = '';
  protected readonly status = signal('start');
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  ngOnInit() {
    const fragment = window.location.hash.slice(1);
    const failed = new URLSearchParams(window.location.search).has('error');
    window.history.replaceState(null, '', '/invitation');
    if (invitationTokenSchema.safeParse(fragment).success)
      this.token = fragment;
    else if (failed)
      this.error.set(
        'Sign-in failed. Ask the inviter to revoke this invitation and create another.',
      );
    else void this.check();
  }
  protected async redeem() {
    if (this.busy()) return;
    if (!invitationTokenSchema.safeParse(this.token.trim()).success) {
      this.error.set('Enter a valid invitation code.');
      return;
    }
    this.busy.set(true);
    this.error.set('');
    try {
      const response = await fetch('/api/auth/invitations/redeem', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: this.token.trim() }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error();
      const result: { url: string } = await response.json();
      this.token = '';
      window.location.assign(result.url);
    } catch {
      this.error.set(
        'The invitation did not start. Check your connection and retry. Ask the inviter to replace an expired or used invitation.',
      );
      this.busy.set(false);
    }
  }
  protected async check() {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      const response = await fetch('/api/auth/invitations/status', {
        credentials: 'same-origin',
        signal: AbortSignal.timeout(5000),
      });
      if (response.status === 401) {
        this.status.set('start');
        return;
      }
      if (!response.ok) throw new Error();
      const result: { status: unknown } = await response.json();
      this.status.set(invitationStatusSchema.parse(result.status));
    } catch {
      this.error.set(
        'Invitation status is unavailable. Check your connection, then retry.',
      );
    } finally {
      this.busy.set(false);
    }
  }
}

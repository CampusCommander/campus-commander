import {
  Component,
  OnDestroy,
  OnInit,
  effect,
  inject,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { DatePipe, NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { z } from 'zod';
import {
  GOOGLE_CUSTOMER_SCOPES,
  GOOGLE_HEALTH_RECOVERY,
  googleCandidateSchema,
  googleCredentialImportSchema,
  type GoogleCandidate,
} from '@campus/application-contracts';
import { AuthStore } from '../auth.store';
import { ConnectionStore } from './connection.store';

@Component({
  selector: 'app-google-connection',
  imports: [
    DatePipe,
    RouterLink,
    NgTemplateOutlet,
    FormsModule,
    MatButtonModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatInputModule,
  ],
  templateUrl: './google-connection.html',
  styleUrl: './google-connection.css',
})
export class GoogleConnectionPage implements OnInit, OnDestroy {
  protected readonly auth = inject(AuthStore);
  protected readonly store = inject(ConnectionStore);
  protected readonly candidate = signal<GoogleCandidate | null>(null);
  protected readonly candidateId = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly message = signal('');
  protected readonly uncertain = signal(false);
  protected readonly fileName = signal('');
  protected readonly clientId = signal('');
  protected readonly now = signal(Date.now());
  protected readonly scopes = GOOGLE_CUSTOMER_SCOPES;
  protected subject = '';
  protected confirmed = false;
  private file: File | null = null;
  private fileInput?: HTMLInputElement;
  private timer?: ReturnType<typeof setInterval>;
  private destroyed = false;
  private fileVersion = 0;
  private readonly clearPrivateInput = () => {
    this.fileVersion += 1;
    this.file = null;
    if (this.fileInput) this.fileInput.value = '';
    this.fileName.set('');
  };

  constructor() {
    effect(() => {
      if (this.auth.interrupted()) {
        this.clearPrivateInput();
        this.confirmed = false;
        this.uncertain.set(true);
      }
      if (this.store.connection()) {
        this.clearPrivateInput();
        this.candidate.set(null);
        this.candidateId.set('');
        this.remember('');
      }
    });
  }
  ngOnInit() {
    try {
      const id = sessionStorage.getItem(this.storageKey());
      if (id && z.uuid().safeParse(id).success) {
        this.candidateId.set(id);
        this.uncertain.set(true);
        void this.refreshCandidate();
      }
    } catch {
      /* Metadata recovery remains available within this page. */
    }
    this.timer = setInterval(() => this.now.set(Date.now()), 1000);
    window.addEventListener('pagehide', this.clearPrivateInput);
  }
  ngOnDestroy() {
    this.destroyed = true;
    clearInterval(this.timer);
    this.clearPrivateInput();
    window.removeEventListener('pagehide', this.clearPrivateInput);
  }
  protected canManage() {
    return this.auth.can('connection:manage', { kind: 'platform' });
  }
  protected expired() {
    return (
      !!this.candidate() &&
      Date.parse(this.candidate()!.expiresAt) <= this.now()
    );
  }
  protected failure(candidate: GoogleCandidate) {
    return candidate.failure
      ? GOOGLE_HEALTH_RECOVERY[candidate.failure].recovery
      : '';
  }
  private storageKey() {
    return `cc:google-candidate:${this.auth.session()?.identity.id ?? this.auth.interruptedPrincipalId() ?? 'unavailable'}`;
  }
  private remember(id: string) {
    try {
      if (id) sessionStorage.setItem(this.storageKey(), id);
      else sessionStorage.removeItem(this.storageKey());
    } catch {
      /* No credentials enter browser storage. */
    }
  }
  private current(session: string | undefined) {
    return (
      !this.destroyed &&
      !this.auth.interrupted() &&
      session === this.auth.session()?.csrfToken
    );
  }

  protected async selectFile(event: Event) {
    const input = event.target as HTMLInputElement;
    this.fileInput = input;
    const file = input.files?.[0];
    this.clearPrivateInput();
    this.clientId.set('');
    this.error.set('');
    if (!file) return;
    const version = this.fileVersion;
    try {
      if (file.size > 16384) throw new Error();
      const metadata = z
        .object({
          type: z.literal('service_account'),
          client_id: z.string().regex(/^[0-9]{1,32}$/),
        })
        .parse(JSON.parse(await file.text()));
      if (this.destroyed || version !== this.fileVersion || !this.canManage())
        return;
      this.file = file;
      this.fileName.set(file.name);
      this.clientId.set(metadata.client_id);
    } catch {
      this.error.set(
        'Select a service-account JSON key file of at most 16 KiB. An application sign-in client file is not valid here.',
      );
    }
  }
  protected async copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      this.message.set('Setup value copied.');
    } catch {
      this.error.set(
        'Clipboard access failed. Select and copy the displayed setup value.',
      );
    }
  }
  protected async stage() {
    if (
      this.busy() ||
      this.store.stale() ||
      this.store.loading() ||
      this.store.connection() ||
      !this.canManage() ||
      !this.file ||
      this.candidateId()
    )
      return;
    const session = this.auth.session()?.csrfToken;
    this.busy.set(true);
    this.error.set('');
    this.message.set('Checking the service account and Google customer.');
    this.confirmed = false;
    let submitted = false;
    try {
      const input = googleCredentialImportSchema.parse({
        id: crypto.randomUUID(),
        clientId: this.clientId(),
        subject: this.subject.trim(),
        serviceAccount: JSON.parse(await this.file.text()),
      });
      if (!this.current(session)) return;
      this.candidateId.set(input.id);
      this.remember(input.id);
      submitted = true;
      this.clearPrivateInput();
      const response = await this.auth.request(
        '/api/google-connection/candidates',
        input,
      );
      if (!this.current(session)) return;
      if (!response.ok) {
        const failure = await response.json().catch(() => null);
        if (!this.current(session)) return;
        if (response.status === 429) {
          this.candidateId.set('');
          this.remember('');
          submitted = false;
          this.error.set(
            'The credential check limit was reached. Wait before selecting the key file and retrying.',
          );
          return;
        }
        if (
          response.status === 400 ||
          (response.status === 503 &&
            [
              'connection-not-configured',
              'connection-key-unavailable',
            ].includes(failure?.reason))
        ) {
          this.candidateId.set('');
          this.remember('');
          submitted = false;
          this.error.set(
            response.status === 400
              ? 'The service-account file is invalid. Select a valid key file and retry.'
              : 'Google credentials are not configured on this installation. Ask the installation operator to configure the encryption key.',
          );
          return;
        }
        throw new Error();
      }
      const candidate = googleCandidateSchema.parse(await response.json());
      if (!this.current(session) || candidate.id !== this.candidateId()) return;
      this.candidate.set(candidate);
      this.uncertain.set(false);
      this.message.set(
        'Credential check finished. Review the customer before confirmation.',
      );
    } catch {
      if (!this.current(session)) return;
      this.uncertain.set(submitted);
      if (submitted) this.store.stale.set(true);
      this.error.set(
        submitted
          ? 'The credential result is unknown. Refresh this review before another import. The selected key file was cleared.'
          : 'Enter a valid delegated administrator email and select a service-account key file.',
      );
    } finally {
      this.busy.set(false);
    }
  }
  protected async refreshCandidate() {
    const id = this.candidateId();
    if (!id || this.busy() || !this.canManage()) return;
    const session = this.auth.session()?.csrfToken;
    this.busy.set(true);
    this.error.set('');
    this.confirmed = false;
    try {
      const response = await this.auth.request(
        `/api/google-connection/candidates/${id}`,
      );
      if (!response.ok) throw new Error();
      const candidate = googleCandidateSchema.parse(await response.json());
      if (!this.current(session) || id !== this.candidateId()) return;
      this.candidate.set(candidate);
      this.clientId.set(candidate.clientId);
      this.subject = candidate.subject;
      this.uncertain.set(false);
      if (candidate.status === 'consumed') await this.store.refresh();
    } catch {
      if (!this.current(session)) return;
      this.uncertain.set(true);
      this.error.set(
        'The review is unavailable or your access changed. Refresh saved status and this review after access returns.',
      );
    } finally {
      this.busy.set(false);
    }
  }
  protected newImport() {
    if (
      this.busy() ||
      this.store.stale() ||
      this.store.loading() ||
      this.store.connection() ||
      !this.canManage()
    )
      return;
    this.clearPrivateInput();
    this.candidate.set(null);
    this.candidateId.set('');
    this.remember('');
    this.confirmed = false;
    this.uncertain.set(false);
    this.error.set('');
    this.message.set(
      'Select a key file for another check. Previous unconfirmed credentials expire automatically.',
    );
  }
  protected async confirm() {
    const candidate = this.candidate();
    if (
      this.busy() ||
      this.store.stale() ||
      this.store.loading() ||
      this.uncertain() ||
      !this.canManage() ||
      !this.confirmed ||
      this.expired() ||
      candidate?.status !== 'ready' ||
      !candidate.observation
    )
      return;
    const session = this.auth.session()?.csrfToken;
    this.busy.set(true);
    this.error.set('');
    try {
      const response = await this.auth.request(
        `/api/google-connection/candidates/${candidate.id}/confirm`,
        { customerId: candidate.observation.customerId, confirmed: true },
      );
      if (!response.ok) throw new Error();
      if (!this.current(session)) return;
      this.message.set('Customer confirmed. Loading saved connection status.');
      await this.store.refresh();
      if (this.store.stale()) this.uncertain.set(true);
    } catch {
      if (!this.current(session)) return;
      this.uncertain.set(true);
      this.store.stale.set(true);
      this.error.set(
        'Confirmation did not return a result. Refresh saved status and this review before another confirmation.',
      );
    } finally {
      this.confirmed = false;
      this.busy.set(false);
    }
  }
}

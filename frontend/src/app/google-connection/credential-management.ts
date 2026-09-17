import {
  Component,
  ElementRef,
  Injector,
  OnDestroy,
  OnInit,
  ViewChild,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { z } from 'zod';
import {
  GOOGLE_HEALTH_RECOVERY,
  googleCandidateSchema,
  googleCredentialManagementSchema,
  googleCredentialReplacementSchema,
  googleReplacementActivationSchema,
  googleKeyRotationSchema,
  googleCredentialActivationSchema,
  type GoogleCandidate,
} from '@campus/application-contracts';
import { AuthStore } from '../auth.store';
import { ConnectionStore } from './connection.store';
import { GoogleHealthStore } from './health.store';

const managementSchema = z.strictObject({
  credential: googleCredentialManagementSchema.nullable(),
  configuredKeyIds: z.array(z.string()).max(4),
});
type Management = z.infer<typeof managementSchema>;
type Mode = 'overview' | 'replace' | 'review' | 'rotate' | 'disconnect';

@Component({
  selector: 'app-credential-management',
  imports: [
    DatePipe,
    FormsModule,
    MatButtonModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
  ],
  templateUrl: './credential-management.html',
  styleUrl: './google-connection.css',
})
export class CredentialManagement implements OnInit, OnDestroy {
  private readonly auth = inject(AuthStore);
  private readonly connection = inject(ConnectionStore);
  private readonly health = inject(GoogleHealthStore);
  private readonly injector = inject(Injector);
  @ViewChild('result') private result?: ElementRef<HTMLElement>;
  @ViewChild('reviewHeading') private reviewHeading?: ElementRef<HTMLElement>;
  readonly mode = signal<Mode>('overview');
  readonly management = signal<Management | null>(null);
  readonly loading = signal(false);
  readonly busy = signal(false);
  readonly stale = signal(true);
  readonly error = signal('');
  readonly message = signal('');
  readonly candidate = signal<GoogleCandidate | null>(null);
  readonly candidateId = signal('');
  readonly uncertain = signal(false);
  readonly fileName = signal('');
  readonly clientId = signal('');
  readonly now = signal(Date.now());
  readonly canManage = computed(
    () =>
      !this.auth.interrupted() &&
      this.auth.can('connection:manage', { kind: 'platform' }),
  );
  readonly current = computed(() => this.management()?.credential ?? null);
  readonly fresh = computed(
    () =>
      !this.stale() &&
      !this.connection.stale() &&
      this.current()?.customerId === this.connection.connection()?.customerId &&
      this.current()?.generation === this.connection.connection()?.generation,
  );
  readonly disabled = computed(
    () =>
      !this.canManage() ||
      !this.fresh() ||
      this.busy() ||
      this.loading() ||
      this.uncertain(),
  );
  readonly expired = computed(
    () =>
      !!this.candidate() &&
      Date.parse(this.candidate()!.expiresAt) <= this.now(),
  );
  readonly replacementReady = computed(() => {
    const candidate = this.candidate(),
      current = this.current();
    return (
      candidate?.status === 'ready' &&
      !this.expired() &&
      !!current &&
      candidate.expectedCustomerId === current.customerId &&
      candidate.expectedGeneration === current.generation &&
      candidate.observation?.customerId === current.customerId
    );
  });
  readonly recovery = GOOGLE_HEALTH_RECOVERY;
  subject = '';
  keyId = '';
  confirmed = false;
  private file: File | null = null;
  private fileInput?: HTMLInputElement;
  private fileVersion = 0;
  private sequence = 0;
  private identity = '';
  private destroyed = false;
  private timer?: ReturnType<typeof setInterval>;
  private readonly clearFile = () => {
    this.fileVersion++;
    this.file = null;
    if (this.fileInput) this.fileInput.value = '';
    this.fileName.set('');
  };
  constructor() {
    effect(() => {
      const identity = this.authority();
      if (identity === this.identity) return;
      this.identity = identity;
      this.sequence++;
      this.clearFile();
      this.confirmed = false;
      this.management.set(null);
      this.candidate.set(null);
      this.candidateId.set('');
      this.mode.set('overview');
      this.loading.set(false);
      this.busy.set(false);
      this.stale.set(true);
      this.uncertain.set(false);
      this.message.set('');
      this.error.set('');
      if (identity)
        untracked(() => {
          try {
            const id = sessionStorage.getItem(this.storageKey());
            if (id && z.uuid().safeParse(id).success) {
              this.candidateId.set(id);
              this.mode.set('review');
            }
          } catch {
            /* Recovery metadata remains optional. */
          }
          void this.refresh();
        });
    });
  }
  ngOnInit() {
    this.timer = setInterval(() => this.now.set(Date.now()), 1000);
    window.addEventListener('pagehide', this.clearFile);
  }
  ngOnDestroy() {
    this.destroyed = true;
    this.sequence++;
    this.clearFile();
    clearInterval(this.timer);
    window.removeEventListener('pagehide', this.clearFile);
  }
  private authority() {
    const session = this.auth.session(),
      customer = this.connection.connection()?.customerId;
    return this.canManage() && session && customer
      ? `${session.identity.id}:${session.identity.permissionVersion}:${session.csrfToken}:${customer}`
      : '';
  }
  private accepts(sequence: number, authority: string) {
    return (
      !this.destroyed &&
      sequence === this.sequence &&
      !!authority &&
      authority === this.authority()
    );
  }
  private storageKey() {
    return `cc:google-replacement:${this.auth.session()?.identity.id}:${this.connection.connection()?.customerId}`;
  }
  private remember(id: string) {
    try {
      if (id) sessionStorage.setItem(this.storageKey(), id);
      else sessionStorage.removeItem(this.storageKey());
    } catch {
      /* Store only the transaction identifier, never credentials. */
    }
  }
  private focus(sequence: number, authority: string, review = false) {
    afterNextRender(
      () => {
        if (this.accepts(sequence, authority))
          (review ? this.reviewHeading : this.result)?.nativeElement.focus();
      },
      { injector: this.injector },
    );
  }
  async refresh() {
    if (!this.canManage() || this.busy() || this.loading()) return;
    const sequence = ++this.sequence,
      authority = this.authority();
    this.loading.set(true);
    this.confirmed = false;
    this.error.set('');
    try {
      const [response] = await Promise.all([
        this.auth.request('/api/google-connection/credentials'),
        this.connection.refresh(),
      ]);
      if (!response.ok) throw new Error();
      const result = managementSchema.parse(await response.json());
      if (!this.accepts(sequence, authority)) return;
      const previous = this.current();
      this.management.set(result);
      this.stale.set(false);
      this.keyId = result.configuredKeyIds.includes(this.keyId)
        ? this.keyId
        : '';
      if (previous && previous.generation !== result.credential?.generation) {
        this.clearFile();
        this.confirmed = false;
        this.message.set(
          'Credential status changed. Review the current state before another action.',
        );
      }
      if (
        !result.credential?.active &&
        ['rotate', 'disconnect'].includes(this.mode())
      ) {
        this.mode.set('overview');
        this.message.set(
          'Background access is disconnected locally. Start a verified replacement to reconnect.',
        );
      }
      const id = this.candidateId();
      if (id) {
        const response = await this.auth.request(
          `/api/google-connection/candidates/${id}`,
        );
        if (!this.accepts(sequence, authority)) return;
        if (response.status === 403) {
          this.candidate.set(null);
          this.candidateId.set('');
          this.remember('');
          this.mode.set('overview');
          this.uncertain.set(false);
          this.message.set(
            'This replacement review is unavailable. Review current credential status before starting a new replacement.',
          );
          this.focus(sequence, authority);
          return;
        }
        if (!response.ok) throw new Error();
        const candidate = googleCandidateSchema.parse(await response.json());
        if (!this.accepts(sequence, authority) || id !== this.candidateId())
          return;
        this.candidate.set(candidate);
        if (candidate.status === 'consumed') {
          const [latest] = await Promise.all([
            this.auth.request('/api/google-connection/credentials'),
            this.connection.refresh(),
          ]);
          if (!latest.ok) throw new Error();
          const saved = managementSchema.parse(await latest.json());
          if (!this.accepts(sequence, authority)) return;
          this.management.set(saved);
          this.candidateId.set('');
          this.remember('');
          this.mode.set('overview');
          this.message.set(
            'The replacement was activated. Current credential status is shown below.',
          );
        }
      }
      this.uncertain.set(false);
    } catch {
      if (!this.accepts(sequence, authority)) return;
      this.stale.set(true);
      this.error.set(
        'Credential status is unavailable or your access changed. Refresh before another action.',
      );
    } finally {
      if (this.accepts(sequence, authority)) this.loading.set(false);
    }
  }
  begin(mode: Mode) {
    if (this.disabled() || !this.current()) return;
    this.clearFile();
    this.confirmed = false;
    this.error.set('');
    this.message.set('');
    this.candidate.set(null);
    this.candidateId.set('');
    this.remember('');
    this.keyId = this.management()!.configuredKeyIds.includes(
      this.current()!.keyId,
    )
      ? this.current()!.keyId
      : '';
    if (mode === 'rotate') this.keyId = '';
    this.mode.set(mode);
    this.focus(this.sequence, this.authority(), true);
  }
  cancel() {
    if (this.busy() || this.loading() || this.uncertain()) return;
    this.clearFile();
    this.confirmed = false;
    this.candidate.set(null);
    this.candidateId.set('');
    this.remember('');
    this.mode.set('overview');
    this.message.set(
      'Review closed. Unconfirmed replacement credentials expire automatically.',
    );
    this.focus(this.sequence, this.authority());
  }
  async selectFile(event: Event) {
    const input = event.target as HTMLInputElement;
    this.fileInput = input;
    const file = input.files?.[0];
    this.clearFile();
    this.clientId.set('');
    this.error.set('');
    if (!file || this.disabled()) return;
    const version = this.fileVersion,
      authority = this.authority();
    try {
      if (file.size > 16384) throw new Error();
      const value = z
        .object({
          type: z.literal('service_account'),
          client_id: z.string().regex(/^\d{1,32}$/),
        })
        .parse(JSON.parse(await file.text()));
      if (
        this.destroyed ||
        version !== this.fileVersion ||
        authority !== this.authority()
      )
        return;
      this.file = file;
      this.fileName.set(file.name);
      this.clientId.set(value.client_id);
    } catch {
      if (version === this.fileVersion && authority === this.authority())
        this.error.set(
          'Select a service-account JSON key file of at most 16 KiB.',
        );
    }
  }
  async stage() {
    const current = this.current();
    if (this.disabled() || !current || !this.file || this.candidateId()) return;
    const sequence = ++this.sequence,
      authority = this.authority();
    this.busy.set(true);
    this.confirmed = false;
    this.error.set('');
    this.message.set(
      'Checking replacement credentials. The current credential remains unchanged.',
    );
    let submitted = false;
    try {
      const input = googleCredentialReplacementSchema.parse({
        id: crypto.randomUUID(),
        customerId: current.customerId,
        generation: current.generation,
        clientId: this.clientId(),
        subject: this.subject.trim(),
        serviceAccount: JSON.parse(await this.file.text()),
      });
      if (!this.accepts(sequence, authority)) return;
      this.candidateId.set(input.id);
      this.remember(input.id);
      this.clearFile();
      submitted = true;
      this.mode.set('review');
      this.focus(sequence, authority, true);
      const response = await this.auth.request(
        '/api/google-connection/replacements',
        input,
      );
      if (!response.ok) {
        const failure = await response.json().catch(() => null);
        if (!this.accepts(sequence, authority)) return;
        if (
          [400, 409, 429].includes(response.status) ||
          (response.status === 503 &&
            [
              'connection-not-configured',
              'connection-key-unavailable',
            ].includes(failure?.reason))
        ) {
          this.candidateId.set('');
          this.remember('');
          this.mode.set('replace');
          submitted = false;
          this.error.set(
            response.status === 429
              ? 'The credential check limit was reached. Wait before selecting the file again.'
              : 'The replacement was not staged. Refresh status, verify the key configuration, and select a valid file.',
          );
          this.stale.set(true);
          this.focus(sequence, authority);
          return;
        }
        throw new Error();
      }
      const candidate = googleCandidateSchema.parse(await response.json());
      if (!this.accepts(sequence, authority)) return;
      this.candidate.set(candidate);
      this.uncertain.set(false);
      this.message.set(
        'Replacement check finished. Review its customer, identity, and encryption key before activation.',
      );
      this.focus(sequence, authority, true);
    } catch {
      if (!this.accepts(sequence, authority)) return;
      this.uncertain.set(submitted);
      if (submitted) this.stale.set(true);
      this.error.set(
        submitted
          ? 'The replacement result is unknown. Refresh credential status before another action.'
          : 'Enter a valid administrator email and select a service-account file.',
      );
      this.focus(sequence, authority);
    } finally {
      if (this.accepts(sequence, authority)) this.busy.set(false);
    }
  }
  async commit() {
    const current = this.current(),
      mode = this.mode(),
      candidate = this.candidate();
    if (
      this.disabled() ||
      !current ||
      !this.confirmed ||
      !['review', 'rotate', 'disconnect'].includes(mode)
    )
      return;
    if (mode === 'review' && (!this.replacementReady() || !candidate)) return;
    if ((mode === 'rotate' || mode === 'disconnect') && !current.active) return;
    if (
      mode !== 'disconnect' &&
      (!this.management()!.configuredKeyIds.includes(this.keyId) ||
        (mode === 'rotate' && this.keyId === current.keyId))
    )
      return;
    const sequence = ++this.sequence,
      authority = this.authority();
    const expected = {
      customerId: current.customerId,
      generation: current.generation,
      confirmed: true,
    };
    const path =
      mode === 'review'
        ? `replacements/${candidate!.id}/activate`
        : `credentials/${mode === 'rotate' ? 'rotate-key' : 'disconnect'}`;
    const input =
      mode === 'review'
        ? googleReplacementActivationSchema.parse({
            ...expected,
            keyId: this.keyId,
          })
        : mode === 'rotate'
          ? googleKeyRotationSchema.parse({ ...expected, keyId: this.keyId })
          : googleCredentialActivationSchema.parse(expected);
    this.busy.set(true);
    this.error.set('');
    this.message.set('Submitting the confirmed credential change.');
    try {
      const response = await this.auth.request(
        `/api/google-connection/${path}`,
        input,
      );
      if (!response.ok) {
        const failure = await response.json().catch(() => null);
        if (!this.accepts(sequence, authority)) return;
        if (
          response.status === 503 &&
          [
            'key-unavailable',
            'credential-unavailable',
            'connection-key-unavailable',
          ].includes(failure?.reason)
        ) {
          this.stale.set(true);
          this.error.set(
            'The selected encryption key is unavailable. The change was not submitted to storage. Restore the key or select an available key for a verified replacement. Refresh before retrying.',
          );
          return;
        }
        throw new Error();
      }
      const result = googleCredentialManagementSchema.parse(
        await response.json(),
      );
      if (!this.accepts(sequence, authority)) return;
      this.management.set({
        credential: result,
        configuredKeyIds: this.management()!.configuredKeyIds,
      });
      this.candidate.set(null);
      this.candidateId.set('');
      this.remember('');
      this.mode.set('overview');
      this.message.set(
        mode === 'disconnect'
          ? 'Background Google access disconnected locally. Customer settings and application sign-in remain available.'
          : mode === 'rotate'
            ? 'Encryption key rotated. Check Google capability health and verify worker access.'
            : 'Replacement activated for the confirmed customer. Check Google capability health.',
      );
      await this.connection.refresh();
      if (!this.accepts(sequence, authority)) return;
      await this.health.refresh();
      if (!this.accepts(sequence, authority)) return;
      this.stale.set(this.connection.stale());
    } catch {
      if (!this.accepts(sequence, authority)) return;
      this.uncertain.set(true);
      this.stale.set(true);
      this.error.set(
        'The credential change result is unknown. Refresh credential status before another action.',
      );
    } finally {
      if (this.accepts(sequence, authority)) {
        this.confirmed = false;
        this.busy.set(false);
        this.focus(sequence, authority);
      }
    }
  }
}

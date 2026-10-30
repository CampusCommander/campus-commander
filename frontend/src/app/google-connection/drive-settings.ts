import {
  Component,
  ElementRef,
  Injector,
  OnDestroy,
  ViewChild,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import {
  GOOGLE_CAPABILITIES,
  GOOGLE_HEALTH_RECOVERY,
  googleDrivePickerApiKeySchema,
  googleDriveProjectNumberSchema,
  googleDriveSettingsAnswerSchema,
  type GoogleDriveSettings,
} from '@campus/application-contracts';
import { AuthStore } from '../auth.store';
import { ConnectionStore } from './connection.store';
import { GoogleHealthStore } from './health.store';

/** The Drive check row reads one capability (design sections 2 and 8, states 14 and 15). */
const DRIVE_CAPABILITY = GOOGLE_CAPABILITIES.find(
  (capability) => capability.id === 'drive-files',
)!;

/**
 * The Google Drive card of the Google connection page (design section 3, choice 13).
 * It lists the Drive scope and the `drive-files` check, and it saves the Picker API key
 * and the project number. The key is not a secret: every browser that opens the Picker
 * receives it, so the page shows it in full (ruling 5).
 */
@Component({
  selector: 'app-drive-settings',
  imports: [
    RouterLink,
    FormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
  ],
  templateUrl: './drive-settings.html',
  styleUrl: './google-connection.css',
})
export class DriveSettings implements OnDestroy {
  private readonly auth = inject(AuthStore);
  private readonly connection = inject(ConnectionStore);
  private readonly injector = inject(Injector);
  protected readonly health = inject(GoogleHealthStore);
  /** The pre-filled Admin console link of the connected client (choice 13, state 14). */
  protected readonly delegationHref = this.health.delegationHref;
  @ViewChild('status') private status?: ElementRef<HTMLElement>;
  readonly scope = DRIVE_CAPABILITY.scope;
  readonly recovery = GOOGLE_HEALTH_RECOVERY;
  readonly saved = signal<GoogleDriveSettings | null>(null);
  readonly loading = signal(false);
  readonly loaded = signal(false);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly message = signal('');
  readonly pickerApiKey = signal('');
  readonly projectNumber = signal('');
  /** A lost save answer blocks another save until this page reads the saved settings. */
  readonly uncertain = signal(false);
  readonly canManage = computed(
    () =>
      !this.auth.interrupted() &&
      this.auth.can('connection:manage', { kind: 'platform' }),
  );
  readonly result = computed(() => this.health.result(DRIVE_CAPABILITY.id));
  readonly failure = computed(() => this.result()?.failure ?? null);
  /** The key must hold exactly 39 letters, digits, hyphens, or underscores (design section 3). */
  readonly keyValid = computed(
    () =>
      googleDrivePickerApiKeySchema.safeParse(this.pickerApiKey().trim())
        .success,
  );
  /** The project number holds 1 to 20 digits and no leading zero (design section 3). */
  readonly numberValid = computed(
    () =>
      googleDriveProjectNumberSchema.safeParse(this.projectNumber().trim())
        .success,
  );
  readonly valid = computed(() => this.keyValid() && this.numberValid());
  readonly dirty = computed(() => {
    const saved = this.saved();
    const key = this.pickerApiKey().trim();
    const number = this.projectNumber().trim();
    return saved
      ? key !== saved.pickerApiKey || number !== saved.projectNumber
      : key !== '' || number !== '';
  });
  /** The saved settings and a current passed Drive check make Drive ready (state 15). */
  readonly ready = computed(() => {
    const saved = this.saved();
    const result = this.result();
    return (
      !!saved &&
      !!result &&
      !result.failure &&
      !this.health.stale(result.checkedAt)
    );
  });
  readonly canSave = computed(
    () =>
      this.canManage() &&
      this.loaded() &&
      this.valid() &&
      this.dirty() &&
      !this.busy() &&
      !this.loading() &&
      !this.uncertain(),
  );
  private sequence = 0;
  private identity = '';
  private destroyed = false;

  constructor() {
    // The read and the form belong to one person on one connection (the store fence).
    effect(() => {
      const authority = this.authority();
      if (authority === this.identity) return;
      this.identity = authority;
      this.sequence++;
      this.saved.set(null);
      this.loaded.set(false);
      this.loading.set(false);
      this.busy.set(false);
      this.uncertain.set(false);
      this.error.set('');
      this.message.set('');
      this.pickerApiKey.set('');
      this.projectNumber.set('');
      if (authority) untracked(() => void this.refresh());
    });
  }
  ngOnDestroy() {
    this.destroyed = true;
    this.sequence++;
  }

  private authority() {
    const session = this.auth.session();
    const customer = this.connection.connection()?.customerId;
    return session && customer
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
  private focus(sequence: number, authority: string) {
    afterNextRender(
      () => {
        if (this.accepts(sequence, authority))
          this.status?.nativeElement.focus();
      },
      { injector: this.injector },
    );
  }
  /** The Drive check row (states 14 and 15). */
  protected label() {
    const result = this.result();
    if (!result) return 'No check result';
    return result.failure
      ? this.recovery[result.failure].label
      : 'Last check passed';
  }

  /** Read the saved settings. A failure keeps the form closed and offers this read again. */
  async refresh() {
    if (this.busy() || this.loading()) return;
    const sequence = ++this.sequence;
    const authority = this.authority();
    this.loading.set(true);
    this.error.set('');
    try {
      const response = await this.auth.request('/api/google-connection/drive');
      if (!this.accepts(sequence, authority)) return;
      if (!response.ok) throw new Error();
      const answer = googleDriveSettingsAnswerSchema.parse(
        await response.json(),
      );
      if (!this.accepts(sequence, authority)) return;
      this.saved.set(answer.drive);
      this.pickerApiKey.set(answer.drive?.pickerApiKey ?? '');
      this.projectNumber.set(answer.drive?.projectNumber ?? '');
      this.uncertain.set(false);
      this.loaded.set(true);
    } catch {
      if (!this.accepts(sequence, authority)) return;
      this.loaded.set(false);
      this.error.set(
        'Campus Commander did not read the Drive settings. Try again.',
      );
    } finally {
      if (this.accepts(sequence, authority)) this.loading.set(false);
    }
  }

  /** Save the settings, then run the `drive-files` check of the design state table. */
  async save() {
    if (!this.canSave()) return;
    const sequence = ++this.sequence;
    const authority = this.authority();
    this.busy.set(true);
    this.error.set('');
    this.message.set('');
    try {
      const response = await this.auth.request('/api/google-connection/drive', {
        pickerApiKey: this.pickerApiKey().trim(),
        projectNumber: this.projectNumber().trim(),
      });
      if (!this.accepts(sequence, authority)) return;
      if (response.status === 403) {
        this.error.set(
          'A platform administrator with Manage Google credentials access must save the Drive settings.',
        );
        this.focus(sequence, authority);
        return;
      }
      if (!response.ok) throw new Error();
      const answer = googleDriveSettingsAnswerSchema.parse(
        await response.json(),
      );
      if (!this.accepts(sequence, authority)) return;
      if (!answer.drive) throw new Error();
      this.saved.set(answer.drive);
      this.pickerApiKey.set(answer.drive.pickerApiKey);
      this.projectNumber.set(answer.drive.projectNumber);
      this.uncertain.set(false);
      this.message.set('Drive settings saved.');
      this.focus(sequence, authority);
    } catch {
      if (!this.accepts(sequence, authority)) return;
      this.uncertain.set(true);
      this.error.set(
        'Campus Commander did not save the Drive settings. Try again.',
      );
      this.focus(sequence, authority);
      return;
    } finally {
      if (this.accepts(sequence, authority)) this.busy.set(false);
    }
    // The person asked for the Drive settings to work, so confirm the check they enable.
    await this.health.check([DRIVE_CAPABILITY.id]);
  }
}

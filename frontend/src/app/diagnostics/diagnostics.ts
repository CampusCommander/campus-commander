import {
  Component,
  DestroyRef,
  ElementRef,
  ViewChild,
  afterNextRender,
  Injector,
  inject,
  effect,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { GoogleHealthStore } from '../google-connection/health.store';
import { ConnectionStore } from '../google-connection/connection.store';
import {
  GOOGLE_CUSTOMER_SCOPES,
  GoogleHealthCapability,
} from '@campus/application-contracts';
import { DatePipe } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { AuthStore } from '../auth.store';
import { DiagnosticsStore } from './diagnostics.store';

@Component({
  selector: 'app-diagnostics',
  imports: [MatButtonModule, DatePipe, RouterLink],
  templateUrl: './diagnostics.html',
  styleUrl: './diagnostics.css',
})
export class Diagnostics {
  protected readonly google = inject(GoogleHealthStore);
  protected readonly connection = inject(ConnectionStore);
  protected readonly googleScopes = GOOGLE_CUSTOMER_SCOPES;
  private readonly destroy = inject(DestroyRef);
  protected async copyGoogle(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      this.google.message.set('Google setup value copied.');
    } catch {
      this.google.error.set(
        'Clipboard access failed. Select and copy the displayed setup value.',
      );
    }
  }
  private readonly injector = inject(Injector);
  @ViewChild('googleResult') private googleResult?: ElementRef<HTMLElement>;
  private checkSequence = 0;
  private readonly fragment = toSignal(inject(ActivatedRoute).fragment);
  @ViewChild('googleHeading') private googleHeading?: ElementRef<HTMLElement>;
  constructor() {
    effect(() => {
      if (this.fragment() !== 'google-health' || !this.google.readable())
        return;
      afterNextRender(() => this.googleHeading?.nativeElement.focus(), {
        injector: this.injector,
      });
    });
  }
  protected async checkGoogle(capability?: GoogleHealthCapability) {
    const sequence = ++this.checkSequence;
    const session = this.auth.session();
    const current = () =>
      !this.destroy.destroyed &&
      sequence === this.checkSequence &&
      !this.auth.interrupted() &&
      session?.csrfToken === this.auth.session()?.csrfToken &&
      session?.identity.permissionVersion ===
        this.auth.session()?.identity.permissionVersion;
    const accepted = await this.google.check(
      capability ? [capability] : undefined,
    );
    if (!accepted || !current()) return;
    afterNextRender(
      () => {
        if (current()) this.googleResult?.nativeElement.focus();
      },
      { injector: this.injector },
    );
  }
  protected readonly auth = inject(AuthStore);
  protected readonly diagnostics = inject(DiagnosticsStore);
  protected readonly operations = [
    {
      id: 'postgresql',
      label: 'PostgreSQL',
      description: 'Verify a synthetic database transaction and its rollback.',
    },
    {
      id: 'redis',
      label: 'Redis',
      description: 'Write, read, and remove a temporary cache value.',
    },
    {
      id: 'kestra',
      label: 'Kestra',
      description: 'Run a fixed task and verify the worker result.',
    },
    {
      id: 'artifacts',
      label: 'Artifact storage',
      description: 'Publish, read, verify, and remove a synthetic artifact.',
    },
  ] as const;
}

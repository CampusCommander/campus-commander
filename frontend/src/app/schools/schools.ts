import {
  Component,
  ElementRef,
  Injector,
  OnInit,
  afterNextRender,
  inject,
  signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import {
  GOOGLE_CAPABILITIES,
  GOOGLE_HEALTH_RECOVERY,
} from '@campus/application-contracts';
import { SchoolsStore } from './schools.store';
import { SchoolEditor } from './school-editor';

@Component({
  selector: 'app-schools',
  imports: [DatePipe, RouterLink, MatButtonModule, SchoolEditor],
  providers: [SchoolsStore],
  templateUrl: './schools.html',
  styleUrl: './schools.css',
})
export class SchoolsPage implements OnInit {
  readonly store = inject(SchoolsStore);
  readonly optionalScope = GOOGLE_CAPABILITIES.find(
    (capability) => capability.id === 'school-ou-references',
  )!.scope;
  readonly copied = signal('');
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  ngOnInit() {
    void this.store.refresh();
    void this.store.readReferences();
  }

  async inspect(id: string) {
    await this.store.inspect(id);
    afterNextRender(
      () =>
        this.element.nativeElement
          .querySelector<HTMLElement>('#school-detail-title')
          ?.focus(),
      { injector: this.injector },
    );
  }

  saved(id: string) {
    void this.store.refresh();
    void this.store.inspect(id);
  }
  referenceRetryTime() {
    return Date.parse(this.store.references()?.retryAt ?? '');
  }
  focusList() {
    const key = this.store.sessionKey();
    afterNextRender(
      () => {
        if (key === this.store.sessionKey())
          this.element.nativeElement
            .querySelector<HTMLElement>('#school-list-title')
            ?.focus();
      },
      { injector: this.injector },
    );
  }

  failureCopy() {
    const failure = this.store.references()?.failure;
    if (!failure) return '';
    if (failure === 'key-unavailable')
      return 'The application cannot decrypt the credential. Ask the installation operator to restore the configured key.';
    const recovery = GOOGLE_HEALTH_RECOVERY[failure];
    return recovery
      ? `${recovery.label}. ${recovery.recovery}`
      : 'Reference verification failed. Check Google connection diagnostics, then refresh references.';
  }

  async copyScope() {
    try {
      await navigator.clipboard.writeText(this.optionalScope);
      this.copied.set('Copied the optional OU read-only scope.');
    } catch {
      this.copied.set(
        'Clipboard access is unavailable. Select and copy the scope text.',
      );
    }
  }

  auditAllowed() {
    const school = this.store.detail();
    return (
      !!school &&
      this.store.auth.can('security-events:read', {
        kind: 'school',
        customerId: school.customerId,
        schoolId: school.id,
      })
    );
  }
}

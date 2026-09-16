import { Component, computed, effect, inject, OnInit, signal } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { toSignal } from '@angular/core/rxjs-interop';
import {
  ActivatedRoute,
  NavigationEnd,
  Router,
  RouterLink,
  RouterLinkActive,
  RouterOutlet,
} from '@angular/router';
import { filter, map, startWith } from 'rxjs';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import type { ApplicationMetadata } from '@campus/application-contracts';
import { AuthStore } from '../auth.store';
import { DiagnosticsStore } from '../diagnostics/diagnostics.store';

@Component({
  selector: 'app-shell',
  imports: [
    RouterLink,
    RouterLinkActive,
    RouterOutlet,
    MatButtonModule,
    MatIconModule,
    MatMenuModule,
  ],
  templateUrl: './shell.html',
  styleUrl: './shell.css',
})
export class Shell implements OnInit {
  protected readonly auth = inject(AuthStore);
  protected readonly router = inject(Router);
  protected readonly diagnostics = inject(DiagnosticsStore);
  protected readonly preferenceError = signal<string | null>(null);
  private readonly route = inject(ActivatedRoute);
  private readonly document = inject(DOCUMENT);
  protected readonly title = toSignal(
    this.router.events.pipe(
      filter((event): event is NavigationEnd => event instanceof NavigationEnd),
      startWith(null),
      map(() => {
        let current = this.route.firstChild;
        let title = '';
        while (current) {
          const declared = current.snapshot.data['title'] as
            | string
            | undefined;
          if (declared) title = declared;
          current = current.firstChild;
        }
        return title;
      }),
    ),
    { initialValue: '' },
  );
  // Phase 3 extension point (UI-02): the connected customer identity.
  // The Phase 3 application-metadata contract adds the customer field.
  // The header renders nothing while the metadata is absent.
  protected readonly customer = computed(
    () =>
      (
        this.auth.metadata() as
          | (ApplicationMetadata & { customer?: string })
          | null
      )?.customer ?? null,
  );
  constructor() {
    effect(() => {
      const theme = this.auth.session()?.identity.preferences.theme ?? 'system';
      this.document.documentElement.dataset['theme'] = theme;
    });
  }
  ngOnInit() {
    if (this.auth.session()?.identity.permissions.includes('diagnostics:read'))
      void this.diagnostics.refresh();
  }
  protected async toggleNavigation() {
    const preferences = this.auth.session()?.identity.preferences;
    if (!preferences) return;
    try {
      await this.auth.savePreferences({
        ...preferences,
        navigationCollapsed: !preferences.navigationCollapsed,
      });
      this.preferenceError.set(null);
    } catch {
      this.preferenceError.set(
        'Your navigation preference was not saved. Retry.',
      );
    }
  }
  protected async theme(theme: 'system' | 'light' | 'dark') {
    const preferences = this.auth.session()?.identity.preferences;
    if (!preferences) return;
    try {
      await this.auth.savePreferences({ ...preferences, theme });
      this.preferenceError.set(null);
    } catch {
      this.preferenceError.set('Your theme preference was not saved. Retry.');
    }
  }
}

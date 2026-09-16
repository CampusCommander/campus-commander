import { Component, effect, inject, OnInit, signal } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import {
  Router,
  RouterLink,
  RouterLinkActive,
  RouterOutlet,
} from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
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
  private readonly document = inject(DOCUMENT);
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

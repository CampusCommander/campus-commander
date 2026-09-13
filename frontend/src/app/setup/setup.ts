import { Component, OnDestroy, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';

@Component({
  selector: 'app-setup',
  imports: [FormsModule, MatButtonModule, MatFormFieldModule, MatInputModule],
  templateUrl: './setup.html',
  styleUrls: ['../login/login.css', './setup.css'],
})
export class Setup implements OnInit, OnDestroy {
  protected code = '';
  protected readonly busy = signal(false);
  protected readonly state = signal('pair');
  protected readonly error = signal('');
  private timer?: ReturnType<typeof setTimeout>;
  private destroyed = false;
  ngOnInit() {
    const params = new URLSearchParams(window.location.search);
    if (params.has('error'))
      this.error.set(
        'Sign-in failed. Resume the installer to create a new pairing code.',
      );
    else if (params.has('verified')) {
      this.state.set('pending');
      void this.check();
    }
  }
  ngOnDestroy() {
    this.destroyed = true;
    clearTimeout(this.timer);
  }
  protected async pair() {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      const response = await fetch('/api/auth/enrollment/start', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: this.code.trim() }),
        signal: AbortSignal.timeout(15000),
      });
      this.code = '';
      if (!response.ok) throw new Error();
      const result: { url: string } = await response.json();
      window.location.assign(result.url);
    } catch {
      this.error.set(
        'Enrollment failed to start. Check the pairing code or resume the installer for a new code.',
      );
      this.busy.set(false);
    }
  }
  protected async check() {
    clearTimeout(this.timer);
    this.error.set('');
    try {
      const response = await fetch('/api/auth/enrollment/status', {
        credentials: 'same-origin',
        signal: AbortSignal.timeout(5000),
      });
      if (response.status === 401) {
        this.error.set(
          'Enrollment expired. Check the installer terminal or sign in if enrollment already completed.',
        );
        return;
      }
      if (!response.ok) throw new Error();
      const result: { status: string } = await response.json();
      if (result.status === 'complete') {
        this.state.set('complete');
        return;
      }
      if (!this.destroyed)
        this.timer = setTimeout(() => {
          void this.check();
        }, 2000);
    } catch {
      this.error.set(
        'The installation is unavailable. Restore the connection, then retry.',
      );
    }
  }
}

import { Component, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  template: `
    @if (!ready()) {
      <main class="initial-loading" aria-busy="true">
        <h1>Campus Commander</h1>
        <p role="status">Loading the application.</p>
      </main>
    }
    <router-outlet (activate)="ready.set(true)" />
  `,
  styles: '.initial-loading { padding: var(--cc-page-padding); }',
})
export class App {
  protected readonly ready = signal(false);
}

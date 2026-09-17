import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';
import { AuthStore } from '../auth.store';
import { ConnectionStore } from '../google-connection/connection.store';
import { GoogleHealthStore } from '../google-connection/health.store';
import { DiagnosticsStore } from './diagnostics.store';
import { Diagnostics } from './diagnostics';

it('does not move focus after a check from an earlier permission version', async () => {
  let finish!: (accepted: boolean) => void;
  const pending = new Promise<boolean>((resolve) => {
    finish = resolve;
  });
  const session = signal({
    csrfToken: 'first',
    identity: { permissionVersion: 1 },
  });
  TestBed.configureTestingModule({
    providers: [
      { provide: AuthStore, useValue: { session, interrupted: () => false } },
      { provide: ConnectionStore, useValue: {} },
      {
        provide: GoogleHealthStore,
        useValue: { readable: () => false, check: () => pending },
      },
      { provide: DiagnosticsStore, useValue: {} },
      { provide: ActivatedRoute, useValue: { fragment: of(null) } },
    ],
  });
  TestBed.overrideComponent(Diagnostics, {
    set: {
      imports: [],
      template:
        '<button (click)="checkGoogle()">Check</button><input aria-label="Current work"><div #googleResult tabindex="-1">Result</div>',
    },
  });
  const fixture = TestBed.createComponent(Diagnostics);
  fixture.detectChanges();
  fixture.nativeElement.querySelector('button').click();
  session.set({ csrfToken: 'second', identity: { permissionVersion: 2 } });
  const input = fixture.nativeElement.querySelector('input');
  input.focus();
  finish(true);
  await fixture.whenStable();
  fixture.detectChanges();
  expect(document.activeElement).toBe(input);
});

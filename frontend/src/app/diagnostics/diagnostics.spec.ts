import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { vi } from 'vitest';
import {
  GOOGLE_CAPABILITIES,
  GOOGLE_HEALTH_RECOVERY,
  GOOGLE_SETUP_SCOPES,
  buildDelegationLink,
  delegationLinkScopes,
  type GoogleHealth,
} from '@campus/application-contracts';
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

function diagnosticsPage(verified: readonly string[]) {
  const health: GoogleHealth = {
    customerId: 'C0123456',
    generation: 1,
    observedAt: new Date().toISOString(),
    backgroundFailure: null,
    check: null,
    capabilities: GOOGLE_CAPABILITIES.map((capability) => {
      const passed = verified.includes(capability.id);
      return {
        capability: capability.id,
        scopeVerified: passed,
        failure: passed ? null : ('scope-mismatch' as const),
        checkedAt: new Date().toISOString(),
        lastSucceededAt: null,
        correlationId: null,
      };
    }),
  };
  const verifiedScopes = GOOGLE_CAPABILITIES.filter((capability) =>
    verified.includes(capability.id),
  ).map((capability) => capability.scope);
  const scopes = delegationLinkScopes(GOOGLE_SETUP_SCOPES, verifiedScopes);
  const href = buildDelegationLink({
    clientId: '123456789',
    requested: GOOGLE_SETUP_SCOPES,
    verified: verifiedScopes,
    domain: 'example.org',
  })!;
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      {
        provide: AuthStore,
        useValue: {
          session: signal({
            identity: {
              id: 'actor',
              permissionVersion: 1,
              permissions: ['diagnostics:read', 'diagnostics:run'],
            },
          }),
          interrupted: () => false,
          can: () => true,
        },
      },
      {
        provide: ConnectionStore,
        useValue: { connection: () => ({ clientId: '123456789' }) },
      },
      {
        provide: GoogleHealthStore,
        useValue: {
          readable: () => true,
          health: signal(health),
          loading: signal(false),
          running: signal(false),
          loaded: signal(true),
          unavailable: signal(false),
          error: signal(''),
          message: signal(''),
          recovery: GOOGLE_HEALTH_RECOVERY,
          capabilities: GOOGLE_CAPABILITIES,
          pending: () => false,
          expired: () => false,
          retrySeconds: () => 0,
          canCheck: () => true,
          disabled: () => false,
          delegationHref: signal(href),
          verifiedScopes: () => verifiedScopes,
          result: (id: string) =>
            health.capabilities.find((item) => item.capability === id),
          age: () => 0,
          stale: () => false,
        },
      },
      {
        provide: DiagnosticsStore,
        useValue: {
          health: signal(null),
          error: signal(null),
          refreshing: signal(false),
          running: signal(null),
          results: signal({}),
          ageSeconds: () => 0,
          stale: () => false,
          run: vi.fn(),
          refresh: vi.fn(),
        },
      },
      { provide: ActivatedRoute, useValue: { fragment: of(null) } },
    ],
  });
  const fixture = TestBed.createComponent(Diagnostics);
  fixture.detectChanges();
  const element: HTMLElement = fixture.nativeElement;
  return { element, fixture, href, scopes };
}

it('shows seven capability checks and one pre-filled delegation link', () => {
  const { element, href, scopes } = diagnosticsPage(
    GOOGLE_CAPABILITIES.map((capability) => capability.id),
  );
  const articles = [...element.querySelectorAll('article.capability')];
  expect(articles.length).toBe(7);
  expect(
    articles.map((article) => article.querySelector('h3')?.textContent?.trim()),
  ).toEqual(GOOGLE_CAPABILITIES.map((capability) => capability.label));
  const text = element.textContent!.replace(/\s+/g, ' ');
  expect(text).toContain('7 Google checks available.');
  expect(text).not.toContain('read-only Google checks available');
  expect(text).toContain(
    'Add these 7 scopes to allow the checks on this page.',
  );
  expect(text).toContain(
    'These checks read at most one record of each kind. They never change Google data.',
  );
  expect(text).not.toContain(
    'To check organizational unit access, open Schools.',
  );
  const link = [...element.querySelectorAll('a')].find(
    (anchor) =>
      anchor.textContent?.trim() ===
      'Open domain-wide delegation in the Google Admin console',
  )!;
  expect(link.getAttribute('href')).toBe(href);
  expect(link.getAttribute('target')).toBe('_blank');
  expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  expect(
    new URL(link.getAttribute('href')!).searchParams.get('clientScopeToAdd'),
  ).toBe(scopes.join(','));
  const pre = element.querySelector(
    'pre[aria-label="Required Google capability scopes"]',
  );
  expect(pre?.textContent?.trim()).toBe(scopes.join(',\n'));
});

it('lists the school OU scope before Google verifies it', () => {
  const verified = GOOGLE_CAPABILITIES.filter(
    (capability) => capability.id !== 'school-ou-references',
  ).map((capability) => capability.id);
  const { element, href, scopes } = diagnosticsPage(verified);
  expect(scopes).toContain(
    'https://www.googleapis.com/auth/admin.directory.orgunit.readonly',
  );
  expect(href).toContain('orgunit');
  expect(element.textContent).toContain('Add these 7 scopes');
  expect(
    element.querySelector('pre[aria-label="Required Google capability scopes"]')
      ?.textContent,
  ).toContain('orgunit');
});

it('names the four Google APIs and lists the seven setup scopes including drive.file', () => {
  const { element } = diagnosticsPage(
    GOOGLE_CAPABILITIES.map((capability) => capability.id),
  );
  const text = element.textContent!.replace(/\s+/g, ' ');
  expect(text).toContain(
    'Enable the Admin SDK API, the Google Drive API, the Google Sheets API, and the Google Picker API in the service-account project.',
  );
  const scopes = (
    element.querySelector('pre[aria-label="Required Google capability scopes"]')
      ?.textContent ?? ''
  )
    .trim()
    .split(',\n');
  expect(scopes).toHaveLength(7);
  expect(scopes).toContain('https://www.googleapis.com/auth/drive.file');
  expect(scopes).toEqual([...scopes].sort());
});

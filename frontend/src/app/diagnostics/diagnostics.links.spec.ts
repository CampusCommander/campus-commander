import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { vi } from 'vitest';
import {
  GOOGLE_CAPABILITIES,
  GOOGLE_CUSTOMER_SCOPES,
  GOOGLE_HEALTH_RECOVERY,
  type GoogleHealth,
} from '@campus/application-contracts';
import { AuthStore } from '../auth.store';
import { ConnectionStore } from '../google-connection/connection.store';
import { GoogleHealthStore } from '../google-connection/health.store';
import { DiagnosticsStore } from './diagnostics.store';
import { Diagnostics } from './diagnostics';

const CONSOLE = 'https://admin.google.com/ac/owl/domainwidedelegation';
const CLIENT_ID = '123456789';
const DOMAIN = 'example.org';
const REPLACE_NOTE =
  'Authorize replaces the scope list of that client with the listed scopes.';
const scopeOf = (id: string) =>
  GOOGLE_CAPABILITIES.find((capability) => capability.id === id)!.scope;
const observedAt = new Date().toISOString();
const connection = {
  customerId: 'C0123456',
  generation: 1,
  clientId: CLIENT_ID,
  subject: 'admin@example.org',
  confirmedAt: observedAt,
  observedAt,
  observation: {
    customerId: 'C0123456',
    primaryDomain: DOMAIN,
    domains: [{ name: DOMAIN, primary: true, verified: true, aliases: [] }],
  },
};

function healthOf(
  entries: {
    capability: string;
    scopeVerified: boolean;
    failure: string | null;
  }[],
): GoogleHealth {
  return {
    customerId: 'C0123456',
    generation: 1,
    observedAt,
    backgroundFailure: null,
    check: null,
    capabilities: entries.map((entry) => ({
      ...entry,
      checkedAt: observedAt,
      lastSucceededAt: null,
      correlationId: null,
    })),
  } as unknown as GoogleHealth;
}

const allVerified = () =>
  GOOGLE_CAPABILITIES.map((capability) => ({
    capability: capability.id,
    scopeVerified: true,
    failure: null,
  }));

async function render(health: GoogleHealth | null) {
  const healthSignal = signal<GoogleHealth | null>(health);
  const connectionSignal = signal(connection);
  const google = {
    readable: () => true,
    health: healthSignal,
    loading: () => false,
    loaded: () => health !== null,
    unavailable: signal(health === null),
    error: () => '',
    message: () => '',
    running: () => false,
    pending: () => false,
    expired: () => false,
    retrySeconds: () => 0,
    canCheck: () => true,
    disabled: () => false,
    capabilities: GOOGLE_CAPABILITIES,
    recovery: GOOGLE_HEALTH_RECOVERY,
    result: (id: string) =>
      healthSignal()?.capabilities.find((item) => item.capability === id),
    stale: () => false,
    age: () => 0,
    refresh: vi.fn(),
    check: vi.fn(),
  };
  await TestBed.configureTestingModule({
    imports: [Diagnostics],
    providers: [
      provideRouter([]),
      {
        provide: AuthStore,
        useValue: {
          session: () => ({
            csrfToken: 'session',
            identity: {
              id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              permissionVersion: 1,
              permissions: ['diagnostics:read', 'diagnostics:run'],
            },
          }),
          interrupted: () => false,
        },
      },
      { provide: ConnectionStore, useValue: { connection: connectionSignal } },
      { provide: GoogleHealthStore, useValue: google },
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
          refresh: vi.fn(),
          run: vi.fn(),
        },
      },
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(Diagnostics);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, element: fixture.nativeElement as HTMLElement };
}

function linkScopes(link: HTMLAnchorElement): string[] {
  const url = new URL(link.href);
  expect(url.origin + url.pathname).toBe(CONSOLE);
  expect(url.searchParams.get('overwriteClientId')).toBe('true');
  expect(url.searchParams.get('clientIdToAdd')).toBe(CLIENT_ID);
  expect(link.href).not.toContain('authuser');
  return url.searchParams.get('clientScopeToAdd')!.split(',');
}

const sorted = (scopes: string[]) => [...new Set(scopes)].sort();

it('lists every capability scope in the required-scope link when all checks verified', async () => {
  const { fixture, element } = await render(healthOf(allVerified()));
  const link = element.querySelector<HTMLAnchorElement>(
    'details.authorization a[href*="clientScopeToAdd"]',
  );
  expect(link).not.toBeNull();
  expect(linkScopes(link!)).toEqual(
    sorted([
      ...GOOGLE_CUSTOMER_SCOPES,
      ...allVerified().map((entry) => scopeOf(entry.capability)),
    ]),
  );
  expect(new URL(link!.href).searchParams.get('dn')).toBe(DOMAIN);
  fixture.destroy();
});

it('keeps every verified scope in a capability link and adds no unverified scope', async () => {
  const entries = GOOGLE_CAPABILITIES.map((capability) => ({
    capability: capability.id,
    scopeVerified: !['device-inventory', 'device-telemetry'].includes(
      capability.id,
    ),
    failure:
      capability.id === 'device-inventory'
        ? 'scope-mismatch'
        : capability.id === 'device-telemetry'
          ? 'delegation-not-authorized'
          : null,
  }));
  const { fixture, element } = await render(healthOf(entries));
  const article = element.querySelector<HTMLElement>(
    'article[aria-labelledby="device-telemetry-title"]',
  );
  expect(article).not.toBeNull();
  const links = [...article!.querySelectorAll('a[href*="clientScopeToAdd"]')];
  expect(links.length).toBeGreaterThan(0);
  for (const link of links) {
    const scopes = linkScopes(link as HTMLAnchorElement);
    expect(scopes).toContain(scopeOf('device-telemetry'));
    expect(scopes).toContain(scopeOf('customer-identity'));
    expect(scopes).toContain(scopeOf('domain-observations'));
    expect(scopes).not.toContain(scopeOf('device-inventory'));
  }
  expect(article!.textContent).toContain(REPLACE_NOTE);
  fixture.destroy();
});

it('keeps a verified School OU scope in every link and shows no School OU prompt link', async () => {
  const { fixture, element } = await render(healthOf(allVerified()));
  const school = element.querySelector<HTMLElement>(
    'article[aria-labelledby="school-ou-references-title"]',
  );
  expect(school).not.toBeNull();
  expect(school!.querySelector('a[href*="clientScopeToAdd"]')).toBeNull();
  const required = element.querySelector<HTMLAnchorElement>(
    'details.authorization a[href*="clientScopeToAdd"]',
  );
  expect(linkScopes(required!)).toContain(scopeOf('school-ou-references'));
  const capabilityLink = element.querySelector<HTMLAnchorElement>(
    'article[aria-labelledby="device-inventory-title"] a[href*="clientScopeToAdd"]',
  );
  expect(linkScopes(capabilityLink!)).toContain(
    scopeOf('school-ou-references'),
  );
  fixture.destroy();
});

it('shows no link and keeps the copy controls when the latest checks are unreadable', async () => {
  const { fixture, element } = await render(null);
  const details = element.querySelector<HTMLElement>('details.authorization');
  expect(details).not.toBeNull();
  expect(details!.querySelector('a[href*="domainwidedelegation"]')).toBeNull();
  const copy = [...details!.querySelectorAll('button')].map((button) =>
    button.textContent?.trim(),
  );
  expect(copy).toContain('Copy required Google scopes');
  expect(
    details!.querySelector('[aria-label="Required Google capability scopes"]'),
  ).not.toBeNull();
  fixture.destroy();
});

it('states beside the required-scope link that Authorize replaces the scope list', async () => {
  const { fixture, element } = await render(healthOf(allVerified()));
  const details = element.querySelector<HTMLElement>('details.authorization');
  expect(details!.querySelectorAll('a[href*="clientScopeToAdd"]')).toHaveLength(
    1,
  );
  expect(details!.textContent).toContain(REPLACE_NOTE);
  expect(details!.textContent).toContain(
    'This link opens Google Admin with the client ID and these scopes filled in.',
  );
  fixture.destroy();
});

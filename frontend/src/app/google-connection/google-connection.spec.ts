import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { vi } from 'vitest';
import {
  GOOGLE_HEALTH_RECOVERY,
  GOOGLE_SETUP_SCOPES,
} from '@campus/application-contracts';
import { AuthStore } from '../auth.store';
import { ConnectionStore } from './connection.store';
import { GoogleConnectionPage } from './google-connection';

const identity = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  permissionVersion: 1,
  grants: [{ action: 'connection:read', scope: { kind: 'platform' } }],
};
const observation = {
  customerId: 'C0123456',
  primaryDomain: 'example.invalid',
  domains: [
    { name: 'example.invalid', primary: true, verified: true, aliases: [] },
  ],
};
const connection = {
  customerId: observation.customerId,
  generation: 1,
  observation,
  observedAt: new Date().toISOString(),
  confirmedAt: new Date().toISOString(),
  clientId: '123456789',
  subject: 'admin@example.invalid',
};

it('keeps the newer saved-state read when an earlier read finishes last', async () => {
  let release: (response: Response) => void = () => {
    throw new Error('Read not started');
  };
  const request = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    )
    .mockResolvedValueOnce(Response.json({ connection }));
  TestBed.configureTestingModule({
    providers: [
      {
        provide: AuthStore,
        useValue: {
          request,
          metadata: () => ({ phase: 3 }),
          session: () => ({ identity, csrfToken: 'session' }),
          interrupted: () => false,
        },
      },
    ],
  });
  const store = TestBed.inject(ConnectionStore);
  TestBed.tick();
  expect(store.loading()).toBe(true);
  await store.refresh();
  expect(store.connection()).toEqual(connection);
  release(Response.json({ connection: null }));
  await vi.waitFor(() => expect(store.loading()).toBe(false));
  await Promise.resolve();
  expect(store.connection()).toEqual(connection);
});

it.each([201, 400])(
  'discards a staging body from the previous session (%i)',
  async (status) => {
    const interrupted = signal(false);
    const session = signal({ identity, csrfToken: 'original' });
    let finishBody: () => void = () => {
      throw new Error('Body not requested');
    };
    const request = vi.fn(
      async (_path: string, input: { id: string }) =>
        new Response(
          new ReadableStream({
            start(controller) {
              finishBody = () => {
                controller.enqueue(
                  new TextEncoder().encode(
                    JSON.stringify(
                      status === 201
                        ? {
                            id: input.id,
                            status: 'ready',
                            expiresAt: new Date(
                              Date.now() + 600000,
                            ).toISOString(),
                            clientId: connection.clientId,
                            subject: connection.subject,
                            observation,
                            observedAt: connection.observedAt,
                            failure: null,
                          }
                        : { reason: 'invalid-input' },
                    ),
                  ),
                );
                controller.close();
              };
            },
          }),
          { status },
        ),
    );
    await TestBed.configureTestingModule({
      imports: [GoogleConnectionPage],
      providers: [
        {
          provide: AuthStore,
          useValue: {
            request,
            interrupted,
            session,
            can: () => !interrupted(),
          },
        },
        {
          provide: ConnectionStore,
          useValue: {
            connection: signal(null),
            loaded: signal(true),
            loading: signal(false),
            stale: signal(false),
            error: signal(''),
          },
        },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(GoogleConnectionPage);
    fixture.detectChanges();
    const element: HTMLElement = fixture.nativeElement;
    const file = new File(['fixture'], 'fixture.json');
    Object.defineProperty(file, 'text', {
      value: async () =>
        JSON.stringify({
          type: 'service_account',
          client_id: connection.clientId,
        }),
    });
    const input =
      element.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, 'files', { value: [file] });
    input.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    fixture.detectChanges();
    const subject = element.querySelector<HTMLInputElement>(
      'input[name="subject"]',
    )!;
    subject.value = connection.subject;
    subject.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    element
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(request).toHaveBeenCalled());
    interrupted.set(true);
    fixture.detectChanges();
    session.set({ identity, csrfToken: 'renewed' });
    interrupted.set(false);
    fixture.detectChanges();
    finishBody();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(element.textContent).toContain('We have not received a result');
    expect(element.textContent).not.toContain(
      'The service-account file is invalid',
    );
    expect(element.textContent).not.toContain('Credential check finished');
    expect(element.querySelector('mat-checkbox')).toBeNull();
    fixture.destroy();
    sessionStorage.clear();
  },
);

const setupScopes = [
  'https://www.googleapis.com/auth/admin.directory.customer.readonly',
  'https://www.googleapis.com/auth/admin.directory.domain.readonly',
  'https://www.googleapis.com/auth/admin.directory.device.chromeos.readonly',
  'https://www.googleapis.com/auth/chrome.management.telemetry.readonly',
  'https://www.googleapis.com/auth/admin.directory.device.chromeos',
  'https://www.googleapis.com/auth/admin.directory.orgunit.readonly',
];

async function setupImportPage() {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
  await TestBed.configureTestingModule({
    imports: [GoogleConnectionPage],
    providers: [
      {
        provide: AuthStore,
        useValue: {
          request: vi.fn(),
          metadata: () => ({ phase: 3 }),
          session: () => ({ identity, csrfToken: 'session' }),
          interrupted: () => false,
          can: () => true,
        },
      },
      {
        provide: ConnectionStore,
        useValue: {
          connection: signal(null),
          loaded: signal(true),
          loading: signal(false),
          stale: signal(false),
          error: signal(''),
        },
      },
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(GoogleConnectionPage);
  fixture.detectChanges();
  return {
    fixture,
    element: fixture.nativeElement as HTMLElement,
    writeText,
  };
}

it('lists the seven setup scopes in order under the Google scopes name', async () => {
  const { fixture, element } = await setupImportPage();
  const block = element.querySelector<HTMLElement>(
    '[aria-label="Google scopes"]',
  );
  expect(block?.getAttribute('role')).toBe('group');
  // One scope per line, comma separated for the Admin Console paste.
  expect(block?.textContent?.trim()).toBe(setupScopes.join(',\n'));
  fixture.destroy();
});

it('names the seven scopes in step 3 and copies them for the Admin Console', async () => {
  const { fixture, element, writeText } = await setupImportPage();
  const text = element.textContent!.replace(/\s+/g, ' ');
  expect(text).toContain(
    'Add the service account client ID and the 7 scopes below.',
  );
  expect(text).toContain(
    'Campus Commander connects with the customer and domain scopes. Devices also needs the device, telemetry, device change, and organization unit scopes.',
  );
  const copy = [...element.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === 'Copy scopes',
  );
  expect(copy).toBeDefined();
  copy!.click();
  await vi.waitFor(() =>
    expect(writeText).toHaveBeenCalledWith(setupScopes.join(',')),
  );
  fixture.destroy();
});

const CONSOLE = 'https://admin.google.com/ac/owl/domainwidedelegation';
const REPLACE_NOTE =
  'Authorize replaces the scope list of that client with the listed scopes.';
const sortedSetupScopes = [...new Set(GOOGLE_SETUP_SCOPES)].sort();

async function selectKeyFile(element: HTMLElement, clientId: string) {
  const input = element.querySelector<HTMLInputElement>('input[type="file"]')!;
  const file = new File(['fixture'], 'fixture.json');
  Object.defineProperty(file, 'text', {
    value: async () =>
      JSON.stringify({ type: 'service_account', client_id: clientId }),
  });
  Object.defineProperty(input, 'files', { value: [file] });
  input.dispatchEvent(new Event('change'));
}

async function importPageWithKey(clientId: string) {
  const page = await setupImportPage();
  await selectKeyFile(page.element, clientId);
  await page.fixture.whenStable();
  page.fixture.detectChanges();
  return page;
}

it('lists exactly the setup scopes in the pre-filled link without a domain', async () => {
  const { fixture, element } = await setupImportPage();
  expect(element.querySelector('a[href*="clientScopeToAdd"]')).toBeNull();
  await selectKeyFile(element, '123456789');
  await fixture.whenStable();
  fixture.detectChanges();
  const link = element.querySelector<HTMLAnchorElement>(
    'a[href*="clientScopeToAdd"]',
  );
  expect(link).not.toBeNull();
  const url = new URL(link!.href);
  expect(url.origin + url.pathname).toBe(CONSOLE);
  expect(url.searchParams.get('clientScopeToAdd')).toBe(
    sortedSetupScopes.join(','),
  );
  expect(url.searchParams.get('clientIdToAdd')).toBe('123456789');
  expect(url.searchParams.get('overwriteClientId')).toBe('true');
  expect(url.searchParams.get('dn')).toBeNull();
  expect(link!.href).not.toContain('authuser');
  expect(element.textContent).toContain(REPLACE_NOTE);
  expect(element.textContent).toContain(
    'This link opens Google Admin with the client ID and these scopes filled in.',
  );
  fixture.destroy();
});

it('keeps Copy scopes beside the pre-filled link', async () => {
  const { fixture, element, writeText } = await importPageWithKey('123456789');
  expect(element.querySelector('a[href*="clientScopeToAdd"]')).not.toBeNull();
  const copy = [...element.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === 'Copy scopes',
  );
  expect(copy).toBeDefined();
  copy!.click();
  await vi.waitFor(() =>
    expect(writeText).toHaveBeenCalledWith(GOOGLE_SETUP_SCOPES.join(',')),
  );
  fixture.destroy();
});

it.each(['delegation-not-authorized', 'scope-mismatch'] as const)(
  'offers the setup scopes beside the %s failure before confirmation',
  async (failure) => {
    const id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    sessionStorage.setItem(`cc:google-candidate:${identity.id}`, id);
    const request = vi.fn(async (path: string) =>
      path.includes('/candidates/')
        ? Response.json({
            id,
            status: 'failed',
            expiresAt: new Date(Date.now() + 600000).toISOString(),
            clientId: '123456789',
            subject: 'admin@example.org',
            observation: null,
            observedAt: null,
            failure,
          })
        : Response.json({ connection: null }),
    );
    await TestBed.configureTestingModule({
      imports: [GoogleConnectionPage],
      providers: [
        provideRouter([]),
        {
          provide: AuthStore,
          useValue: {
            request,
            metadata: () => ({ phase: 3 }),
            session: () => ({ identity, csrfToken: 'session' }),
            interrupted: () => false,
            can: () => true,
          },
        },
        {
          provide: ConnectionStore,
          useValue: {
            connection: signal(null),
            loaded: signal(true),
            loading: signal(false),
            stale: signal(false),
            error: signal(''),
          },
        },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(GoogleConnectionPage);
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    await vi.waitFor(() =>
      expect(element.textContent).toContain(
        GOOGLE_HEALTH_RECOVERY[failure].recovery,
      ),
    );
    fixture.detectChanges();
    const link = element.querySelector<HTMLAnchorElement>(
      'a[href*="clientScopeToAdd"]',
    );
    expect(link).not.toBeNull();
    const url = new URL(link!.href);
    expect(url.searchParams.get('clientScopeToAdd')).toBe(
      sortedSetupScopes.join(','),
    );
    expect(url.searchParams.get('clientIdToAdd')).toBe('123456789');
    expect(url.searchParams.get('overwriteClientId')).toBe('true');
    expect(url.searchParams.get('dn')).toBeNull();
    expect(link!.href).not.toContain('authuser');
    expect(element.textContent).toContain(REPLACE_NOTE);
    fixture.destroy();
    sessionStorage.clear();
  },
);

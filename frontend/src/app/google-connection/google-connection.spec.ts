import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
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

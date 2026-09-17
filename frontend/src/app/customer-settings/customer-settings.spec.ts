import { provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { AuthStore } from '../auth.store';
import { CustomerStore } from './customer.store';
import { CustomerSettingsPage } from './customer-settings';

const identity = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  permissionVersion: 1,
  grants: [{ action: 'customer:read', scope: { kind: 'platform' } }],
};
const customer = {
  customerId: 'C0123456',
  primaryDomain: 'fixture.invalid',
  settings: { displayName: 'Fixture' },
  revision: 0,
  lastRequestId: null,
  onboarding: {
    customerConfirmedAt: '2026-09-16T10:00:00Z',
    settingsConfirmedAt: null,
    lastGoogleObservationAt: '2026-09-16T10:00:00Z',
  },
};

it('keeps a newer customer read when an older response finishes last', async () => {
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
    .mockResolvedValueOnce(Response.json({ customer }));
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
  const store = TestBed.inject(CustomerStore);
  TestBed.tick();
  await store.refresh();
  expect(store.customer()).toEqual(customer);
  release(Response.json({ customer: null }));
  await Promise.resolve();
  await Promise.resolve();
  expect(store.customer()).toEqual(customer);
});

it.each([201, 400])(
  'ignores a delayed save body after access recovery (%i)',
  async (status) => {
    const interrupted = signal(false);
    const session = signal({ identity, csrfToken: 'original' });
    let finish: () => void = () => {
      throw new Error('Save not started');
    };
    const request = vi.fn(
      async (
        _path: string,
        input: { requestId: string; settings: { displayName: string } },
      ) =>
        new Response(
          new ReadableStream({
            start(controller) {
              finish = () => {
                controller.enqueue(
                  new TextEncoder().encode(
                    JSON.stringify(
                      status === 201
                        ? {
                            requestId: input.requestId,
                            customerId: customer.customerId,
                            revision: 1,
                            settings: input.settings,
                            savedAt: '2026-09-16T12:00:00Z',
                          }
                        : { reason: 'invalid-settings' },
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
      imports: [CustomerSettingsPage],
      providers: [
        provideRouter([]),
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
          provide: CustomerStore,
          useValue: {
            customer: signal(customer),
            loaded: signal(true),
            loading: signal(false),
            stale: signal(false),
            error: signal(''),
            readable: () => !interrupted(),
            refresh: vi.fn(),
          },
        },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(CustomerSettingsPage);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const element: HTMLElement = fixture.nativeElement;
    const name = element.querySelector<HTMLInputElement>(
      'input[name="displayName"]',
    )!;
    name.value = 'Preserved draft';
    name.dispatchEvent(new Event('input'));
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
    finish();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(element.textContent).toContain(
      'We have not received a save confirmation',
    );
    expect(element.textContent).not.toContain('The settings are invalid');
    expect(element.querySelector('#receipt-title')).toBeNull();
    expect(name.value).toBe('Preserved draft');
    expect(
      JSON.parse(
        sessionStorage.getItem(`cc.customer-settings.pending.${identity.id}`)!,
      ).settings.displayName,
    ).toBe('Preserved draft');
    fixture.destroy();
    sessionStorage.clear();
  },
);

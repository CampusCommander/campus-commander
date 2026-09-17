import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { AuthStore } from '../auth.store';
import { ConnectionStore } from './connection.store';
import { GoogleHealthStore } from './health.store';
import { CredentialManagement } from './credential-management';

const credential = {
  customerId: 'C0123456',
  generation: 1,
  credentialId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  active: true,
  keyId: 'key-1',
};

it.each(['permission', 'session', 'interruption', 'destroy'])(
  'discards a delayed credential-change body after %s changes and prevents duplicate submission',
  async (change) => {
    const interrupted = signal(false);
    const session = signal({
      identity: { id: 'operator', permissionVersion: 1 },
      csrfToken: 'original',
    });
    let finishBody: () => void = () => {
      throw new Error('The body has not started.');
    };
    const request = vi.fn(async (path: string) => {
      if (path.endsWith('/disconnect'))
        return new Response(
          new ReadableStream({
            start(controller) {
              finishBody = () => {
                controller.enqueue(
                  new TextEncoder().encode(
                    JSON.stringify({
                      ...credential,
                      generation: 2,
                      active: false,
                    }),
                  ),
                );
                controller.close();
              };
            },
          }),
        );
      return Response.json({ credential, configuredKeyIds: ['key-1'] });
    });
    const refresh = vi.fn(async () => undefined);
    const healthRefresh = vi.fn(async () => undefined);
    await TestBed.configureTestingModule({
      imports: [CredentialManagement],
      providers: [
        {
          provide: AuthStore,
          useValue: {
            request,
            session,
            interrupted,
            can: () => !interrupted(),
          },
        },
        {
          provide: ConnectionStore,
          useValue: {
            connection: signal(credential),
            stale: signal(false),
            refresh,
          },
        },
        { provide: GoogleHealthStore, useValue: { refresh: healthRefresh } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(CredentialManagement);
    const component = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    await vi.waitFor(() => expect(component.disabled()).toBe(false));
    component.begin('disconnect');
    component.confirmed = true;
    const pending = component.commit();
    await component.commit();
    expect(
      request.mock.calls.filter(([path]) => path.endsWith('/disconnect')),
    ).toHaveLength(1);
    if (change === 'destroy') fixture.destroy();
    else {
      if (change === 'permission')
        session.update((value) => ({
          ...value,
          identity: { ...value.identity, permissionVersion: 2 },
        }));
      if (change === 'session')
        session.update((value) => ({ ...value, csrfToken: 'renewed' }));
      if (change === 'interruption') interrupted.set(true);
      fixture.detectChanges();
    }
    finishBody();
    await pending;
    expect(component.current()?.generation).not.toBe(2);
    expect(component.message()).not.toContain(
      'Background Google access disconnected locally',
    );
    expect(healthRefresh).not.toHaveBeenCalled();
    if (change !== 'destroy') fixture.destroy();
    sessionStorage.clear();
  },
);

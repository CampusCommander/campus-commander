import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { PlatformAccess } from './platform-access';
import { AuthStore } from '../auth.store';

it('preserves confirmed access when the following session check fails', async () => {
  const principal = {
    id: '11111111-1111-4111-8111-111111111111',
    issuer: 'https://identity.example.invalid',
    subject: 'administrator',
    displayName: 'Administrator',
    enabled: true,
    permissionVersion: 1,
    permissions: ['identity:read'],
    grants: [],
  };
  const receiptId = '22222222-2222-4222-8222-222222222222';
  const request = vi.fn(async (path: string) => {
    if (path === '/api/auth/session') throw new Error('Connection lost');
    const body = path.endsWith('/access')
      ? {
          receiptId,
          correlationId: receiptId,
          principal: { ...principal, enabled: false, permissionVersion: 2 },
        }
      : path.endsWith('/review')
        ? {
            current: principal,
            proposed: { enabled: false, grants: [] },
            actorVersion: 1,
            targetVersion: 1,
            invitationsToRevoke: [],
          }
        : path.includes('/receipts')
          ? { items: [], offset: 0, total: 0 }
          : path.includes('?offset=')
            ? { items: [principal], total: 1, offset: 0, limit: 50 }
            : principal;
    return new Response(JSON.stringify(body), { status: 200 });
  });
  await TestBed.configureTestingModule({
    imports: [PlatformAccess],
    providers: [
      {
        provide: AuthStore,
        useValue: {
          request,
          can: () => true,
          interrupted: () => false,
          session: () => ({ identity: principal }),
        },
      },
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(PlatformAccess);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  const element: HTMLElement = fixture.nativeElement;
  const click = async (label: string) => {
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(
        [...element.querySelectorAll('button')].some(
          (item) => item.textContent?.trim() === label && !item.disabled,
        ),
        element.textContent ?? '',
      ).toBe(true);
    });
    const button = [...element.querySelectorAll('button')].find(
      (item) => item.textContent?.trim() === label && !item.disabled,
    );
    expect(button).toBeDefined();
    button?.click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  await click('Review access');
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(element.querySelector('fieldset')).not.toBeNull();
  });
  element.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click();
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  await click('Review access changes');
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(element.querySelector('#access-confirmation-title')).not.toBeNull();
  });
  const checkboxes = element.querySelectorAll<HTMLInputElement>(
    'input[type="checkbox"]',
  );
  checkboxes[checkboxes.length - 1].click();
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  await click('Confirm access changes');
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(request).toHaveBeenCalledWith('/api/auth/session');
  });
  expect(element.querySelector('[role="status"]')?.textContent).toContain(
    `Receipt: ${receiptId}`,
  );
  expect(element.querySelector('[role="alert"]')?.textContent).toContain(
    'Access changed. Session verification is unavailable.',
  );
  expect(element.textContent).not.toContain('outcome is unknown');
});

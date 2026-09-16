import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { vi } from 'vitest';
import { AuthStore } from '../auth.store';
import { Skeleton } from '../shared/skeleton/skeleton';
import { ErrorState } from '../shared/error-state/error-state';
import { Account } from './account';

function fakeAuthStore() {
  return {
    session: signal<{
      identity: { displayName: string; permissions: string[] };
    } | null>(null),
    loading: signal(false),
    error: signal<string | null>(null),
    restore: vi.fn(),
  };
}

describe('Account', () => {
  let auth: ReturnType<typeof fakeAuthStore>;

  beforeEach(async () => {
    auth = fakeAuthStore();
    await TestBed.configureTestingModule({
      imports: [Account],
    })
      .overrideProvider(AuthStore, { useValue: auth })
      .compileComponents();
  });

  function create() {
    const fixture = TestBed.createComponent(Account);
    fixture.detectChanges();
    return fixture;
  }

  it('renders a skeleton while the session restores', () => {
    auth.loading.set(true);
    const fixture = create();
    expect(fixture.debugElement.query(By.directive(Skeleton))).toBeTruthy();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain(
      'Loading your account.',
    );
  });

  it('renders the error state and restores the session on retry', () => {
    auth.error.set(
      'Your session is unavailable. Retry or contact the installation operator.',
    );
    const fixture = create();
    expect(fixture.debugElement.query(By.directive(ErrorState))).toBeTruthy();
    (
      (fixture.nativeElement as HTMLElement).querySelector(
        'app-error-state button',
      ) as HTMLButtonElement
    ).click();
    expect(auth.restore).toHaveBeenCalledTimes(1);
  });

  it('renders the signed-in identity and keeps the help card static', () => {
    auth.session.set({
      identity: { displayName: 'Test operator', permissions: [] },
    });
    const fixture = create();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('#identity-title')?.textContent).toContain(
      'Test operator',
    );
    expect(element.querySelector('#help-title')?.textContent).toContain(
      'Application help',
    );
  });
});

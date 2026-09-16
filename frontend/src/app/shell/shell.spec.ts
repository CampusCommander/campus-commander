import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { vi } from 'vitest';
import { AuthStore } from '../auth.store';
import { DiagnosticsStore } from '../diagnostics/diagnostics.store';
import { Shell } from './shell';

@Component({ template: '' })
class StubPage {
}

const fakeAuth = {
  session: signal(null),
  metadata: signal<{ version: string; build: string; customer?: string }>({
    version: '1.0.0',
    build: 'test-build',
  }),
  error: signal<string | null>(null),
  savePreferences: vi.fn(),
  logout: vi.fn(),
};

const fakeDiagnostics = {
  health: signal(null),
  stale: signal(false),
  refresh: vi.fn(),
};

describe('Shell', () => {
  beforeEach(async () => {
    fakeAuth.metadata.set({ version: '1.0.0', build: 'test-build' });
    await TestBed.configureTestingModule({
      imports: [Shell],
      providers: [
        provideRouter([
          {
            path: 'account',
            data: { title: 'Your account' },
            component: StubPage,
          },
          {
            path: 'diagnostics',
            data: { title: 'Diagnostics' },
            component: StubPage,
          },
        ]),
      ],
    })
      .overrideProvider(AuthStore, { useValue: fakeAuth })
      .overrideProvider(DiagnosticsStore, { useValue: fakeDiagnostics })
      .compileComponents();
  });

  function create() {
    const fixture = TestBed.createComponent(Shell);
    fixture.detectChanges();
    return fixture;
  }

  async function navigate(fixture: ReturnType<typeof create>, url: string) {
    await TestBed.inject(Router).navigateByUrl(url);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  it('resolves the header title from the account route data', async () => {
    const fixture = create();
    await navigate(fixture, '/account');
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('.header-title')
        ?.textContent,
    ).toBe('Your account');
  });

  it('resolves the header title from the diagnostics route data', async () => {
    const fixture = create();
    await navigate(fixture, '/diagnostics');
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('.header-title')
        ?.textContent,
    ).toBe('Diagnostics');
  });

  it('renders no customer identity while metadata omits it', async () => {
    const fixture = create();
    await navigate(fixture, '/account');
    expect(
      (fixture.nativeElement as HTMLElement).querySelector(
        '.customer-identity',
      ),
    ).toBeNull();
  });

  it('renders the connected customer identity when metadata provides it', async () => {
    const fixture = create();
    await navigate(fixture, '/account');
    fakeAuth.metadata.set({
      version: '1.0.0',
      build: 'test-build',
      customer: 'Unified School District',
    });
    fixture.detectChanges();
    expect(
      (fixture.nativeElement as HTMLElement).querySelector(
        '.customer-identity',
      )?.textContent,
    ).toContain('Unified School District');
  });
});

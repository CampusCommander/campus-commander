import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { vi } from 'vitest';
import type {
  DependencyHealth,
  DiagnosticOperation,
  DiagnosticResult,
} from '@campus/application-contracts';
import { AuthStore } from '../auth.store';
import { Skeleton } from '../shared/skeleton/skeleton';
import { StaleBadge } from '../shared/stale-badge/stale-badge';
import { ErrorState } from '../shared/error-state/error-state';
import { Diagnostics } from './diagnostics';
import { DiagnosticsStore } from './diagnostics.store';

function fakeDiagnosticsStore() {
  return {
    health: signal<DependencyHealth | null>(null),
    error: signal<string | null>(null),
    errorContext: signal<'connections' | 'checks' | null>(null),
    refreshing: signal(false),
    running: signal<DiagnosticOperation | null>(null),
    results: signal<Partial<Record<DiagnosticOperation, DiagnosticResult>>>({}),
    stale: signal(false),
    ageSeconds: signal(0),
    refresh: vi.fn(),
    run: vi.fn(),
  };
}

const healthy: DependencyHealth = {
  status: 'ready',
  observedAt: new Date(Date.now() - 600_000).toISOString(),
  checks: [{ name: 'database', status: 'ready' }],
};

const fakeAuth = {
  session: signal({
    identity: {
      displayName: 'Test operator',
      permissions: ['diagnostics:read', 'diagnostics:run'],
    },
  }),
};

describe('Diagnostics', () => {
  let store: ReturnType<typeof fakeDiagnosticsStore>;

  beforeEach(async () => {
    store = fakeDiagnosticsStore();
    await TestBed.configureTestingModule({
      imports: [Diagnostics],
    })
      .overrideProvider(DiagnosticsStore, { useValue: store })
      .overrideProvider(AuthStore, { useValue: fakeAuth })
      .compileComponents();
  });

  function create() {
    const fixture = TestBed.createComponent(Diagnostics);
    fixture.detectChanges();
    return fixture;
  }

  it('renders a skeleton while the first connection check loads', () => {
    store.refreshing.set(true);
    const fixture = create();
    expect(fixture.debugElement.query(By.directive(Skeleton))).toBeTruthy();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain(
      'Checking service connections.',
    );
  });

  it('renders the stale badge past the staleness threshold and keeps results', () => {
    store.health.set(healthy);
    store.stale.set(true);
    const fixture = create();
    expect(fixture.debugElement.query(By.directive(StaleBadge))).toBeTruthy();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.textContent).toContain('Stale observation');
    expect(element.textContent).toContain('database');
  });

  it('renders the error state and re-emits refresh on retry', () => {
    store.error.set(
      'Connection status is unavailable. Previous results are stale. Retry the connection check.',
    );
    store.errorContext.set('connections');
    const fixture = create();
    const errorState = fixture.debugElement.query(By.directive(ErrorState));
    expect(errorState).toBeTruthy();
    (
      (fixture.nativeElement as HTMLElement).querySelector(
        'app-error-state button',
      ) as HTMLButtonElement
    ).click();
    expect(store.refresh).toHaveBeenCalledTimes(1);
  });

  it('preserves results and alerts when a refresh fails with cached data', () => {
    store.health.set(healthy);
    store.stale.set(true);
    store.error.set(
      'Connection status is unavailable. Previous results are stale. Retry the connection check.',
    );
    store.errorContext.set('connections');
    const fixture = create();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('[role="alert"]')?.textContent).toContain(
      'Connection status is unavailable.',
    );
    expect(element.textContent).toContain('database');
    expect(fixture.debugElement.query(By.directive(ErrorState))).toBeNull();
  });

  it('announces the empty state when checks never returned a result', () => {
    const fixture = create();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain(
      'Connection checks have not returned a result.',
    );
  });
});

import { Component, signal, type WritableSignal } from '@angular/core';
import type { ComponentFixture } from '@angular/core/testing';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { afterEach, vi } from 'vitest';
import { AuthStore } from '../auth.store';
import { CustomerStore } from '../customer-settings/customer.store';
import { DevicesStore } from '../devices/devices.store';
import { DiagnosticsStore } from '../diagnostics/diagnostics.store';
import { ConnectionStore } from '../google-connection/connection.store';
import { GoogleHealthStore } from '../google-connection/health.store';
import { JobActivityStore } from '../jobs/job-activity.store';
import { Shell } from './shell';

@Component({ selector: 'app-test-route', template: '' })
class TestRoute {}

function configure(
  options: {
    grants?: { action: string }[];
    devices?: boolean;
    phase?: number;
  } = {},
) {
  const grants = options.grants ?? [];
  TestBed.configureTestingModule({
    providers: [
      provideRouter([{ path: '**', component: TestRoute }]),
      {
        provide: AuthStore,
        useValue: {
          session: signal(
            grants.length
              ? {
                  identity: {
                    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                    displayName: 'District operator',
                    permissionVersion: 1,
                    permissions: [],
                    grants,
                    preferences: {
                      theme: 'light',
                      navigationCollapsed: false,
                    },
                  },
                  csrfToken: 'a'.repeat(64),
                  expiresAt: '2026-10-20T12:00:00.000Z',
                }
              : null,
          ),
          metadata: signal({ phase: options.phase ?? 3 }),
          error: signal(null),
          interrupted: signal(false),
          loading: signal(false),
          logout: vi.fn(),
          resume: vi.fn(),
          savePreferences: vi.fn(),
          can: () => false,
        },
      },
      {
        provide: CustomerStore,
        useValue: { customer: signal(null), readable: () => false },
      },
      {
        provide: ConnectionStore,
        useValue: { connection: signal(null), readable: () => false },
      },
      {
        provide: DevicesStore,
        useValue: { readable: () => options.devices ?? false },
      },
      {
        provide: GoogleHealthStore,
        useValue: { readable: () => false, summary: () => '' },
      },
      {
        provide: DiagnosticsStore,
        useValue: {
          stale: () => false,
          health: signal(null),
          refresh: vi.fn(),
          watch: vi.fn(),
          unwatch: vi.fn(),
        },
      },
      {
        provide: JobActivityStore,
        useValue: {
          summary: signal(null),
          loading: signal(true),
          loaded: signal(false),
          error: signal(''),
          live: signal(false),
          runningCount: signal(0),
          attention: signal(false),
          seen: vi.fn().mockResolvedValue(undefined),
        },
      },
    ],
  });
}

async function renderAt(url: string) {
  await TestBed.inject(Router).navigateByUrl(url);
  const fixture = TestBed.createComponent(Shell);
  fixture.detectChanges();
  return fixture;
}

function headerTitle(fixture: ComponentFixture<Shell>) {
  const element = fixture.nativeElement as HTMLElement;
  return element.querySelector('.header-title')?.textContent?.trim() ?? '';
}

function nav(fixture: ComponentFixture<Shell>, name: string) {
  return (fixture.nativeElement as HTMLElement).querySelector(
    `nav a[aria-label="${name}"]`,
  );
}

describe('Shell header title', () => {
  beforeEach(() => configure());

  it('shows Devices on the device list', async () => {
    expect(headerTitle(await renderAt('/devices'))).toBe('Devices');
  });

  it('shows Devices on a device detail page', async () => {
    expect(
      headerTitle(
        await renderAt('/devices/4f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10'),
      ),
    ).toBe('Devices');
  });

  it('shows Jobs on the jobs page', async () => {
    expect(headerTitle(await renderAt('/jobs'))).toBe('Jobs');
  });

  it('shows Schools on the school list', async () => {
    expect(headerTitle(await renderAt('/schools'))).toBe('Schools');
  });

  it('shows Your account on the account page', async () => {
    expect(headerTitle(await renderAt('/account'))).toBe('Your account');
  });
});

describe('Shell activity button', () => {
  it('shows the Activity button to a jobs:read holder before Help', async () => {
    configure({ grants: [{ action: 'jobs:read' }] });
    const fixture = await renderAt('/account');
    const actions = (fixture.nativeElement as HTMLElement).querySelector(
      '.header-actions',
    );
    expect(actions?.firstElementChild?.tagName.toLowerCase()).toBe(
      'app-job-activity',
    );
    expect(
      (fixture.nativeElement as HTMLElement).querySelector(
        'button[aria-label^="Activity:"]',
      ),
    ).not.toBeNull();
  });

  it('hides the Activity button without jobs:read or devices:read', async () => {
    configure({ grants: [{ action: 'schools:read' }] });
    const fixture = await renderAt('/account');
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('app-job-activity'),
    ).toBeNull();
  });
});

describe('Shell navigation', () => {
  it('shows Jobs to a jobs:read holder without devices:read', async () => {
    configure({ grants: [{ action: 'jobs:read' }] });
    const fixture = await renderAt('/account');
    expect(nav(fixture, 'Jobs')).not.toBeNull();
    expect(nav(fixture, 'Devices')).toBeNull();
  });

  it('shows Devices and Jobs to a devices:read holder', async () => {
    configure({ grants: [{ action: 'devices:read' }], devices: true });
    const fixture = await renderAt('/account');
    expect(nav(fixture, 'Devices')).not.toBeNull();
    expect(nav(fixture, 'Jobs')).not.toBeNull();
  });

  it('hides Jobs without jobs:read or devices:read', async () => {
    configure({ grants: [{ action: 'schools:read' }] });
    const fixture = await renderAt('/account');
    expect(nav(fixture, 'Jobs')).toBeNull();
  });
});

function operator(
  permissions: string[],
  id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
) {
  return {
    identity: {
      id,
      displayName: 'District operator',
      permissionVersion: 1,
      permissions,
      grants: [] as { action: string; scope: object }[],
      preferences: { theme: 'light' as const, navigationCollapsed: false },
    },
    csrfToken: 'a'.repeat(64),
    expiresAt: '2026-10-20T12:00:00.000Z',
  };
}

type LiveSession = ReturnType<typeof operator>;

/** The Shell with the real DiagnosticsStore and a request the test controls. */
function configureLive(
  session: WritableSignal<LiveSession | null>,
  request: (path: string) => Promise<Response>,
) {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([{ path: '**', component: TestRoute }]),
      {
        provide: AuthStore,
        useValue: {
          session,
          metadata: signal({ phase: 3 }),
          error: signal(null),
          interrupted: signal(false),
          loading: signal(false),
          logout: vi.fn(),
          resume: vi.fn(),
          savePreferences: vi.fn(),
          can: () => false,
          request,
        },
      },
      {
        provide: CustomerStore,
        useValue: { customer: signal(null), readable: () => false },
      },
      {
        provide: ConnectionStore,
        useValue: { connection: signal(null), readable: () => false },
      },
      {
        provide: DevicesStore,
        useValue: { readable: () => false },
      },
      {
        provide: GoogleHealthStore,
        useValue: { readable: () => false, summary: () => '' },
      },
      {
        provide: JobActivityStore,
        useValue: {
          summary: signal(null),
          loading: signal(true),
          loaded: signal(false),
          error: signal(''),
          live: signal(false),
          runningCount: signal(0),
          attention: signal(false),
          seen: vi.fn().mockResolvedValue(undefined),
        },
      },
    ],
  });
}

const serviceHealth = (status: 'ready' | 'not-ready') => ({
  status,
  observedAt: new Date().toISOString(),
  checks: [{ name: 'PostgreSQL', status }],
});

const flushPromises = async () => {
  for (let index = 0; index < 10; index++) await Promise.resolve();
};

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
}

function footerStatus(fixture: ComponentFixture<Shell>): string {
  const links = (fixture.nativeElement as HTMLElement).querySelectorAll(
    'footer a',
  );
  return links[0]?.textContent?.trim() ?? '';
}

describe('Shell connection status', () => {
  afterEach(() => {
    vi.useRealTimers();
    setVisibility('visible');
  });

  it('keeps Services ready past 60 seconds with a timed read', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-20T12:00:00.000Z'));
    const request = vi.fn(async () => Response.json(serviceHealth('ready')));
    const session = signal<LiveSession | null>(operator(['diagnostics:read']));
    configureLive(session, request);
    const fixture = TestBed.createComponent(Shell);
    fixture.detectChanges();
    await flushPromises();
    fixture.detectChanges();
    expect(footerStatus(fixture)).toBe('Services ready');

    await vi.advanceTimersByTimeAsync(61_000);
    await flushPromises();
    fixture.detectChanges();

    expect(footerStatus(fixture)).toBe('Services ready');
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('shows a failed read and clears it on the next read', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-20T12:00:00.000Z'));
    let failing = true;
    const request = vi.fn(async () =>
      failing
        ? new Response(null, { status: 503 })
        : Response.json(serviceHealth('ready')),
    );
    const session = signal<LiveSession | null>(operator(['diagnostics:read']));
    configureLive(session, request);
    const fixture = TestBed.createComponent(Shell);
    fixture.detectChanges();
    await flushPromises();
    fixture.detectChanges();
    expect(footerStatus(fixture)).toBe('Connection status unavailable');

    failing = false;
    await vi.advanceTimersByTimeAsync(30_000);
    await flushPromises();
    fixture.detectChanges();

    expect(footerStatus(fixture)).toBe('Services ready');
  });

  it('does not read while the tab is hidden and reads at once when visible', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-20T12:00:00.000Z'));
    setVisibility('hidden');
    const request = vi.fn(async () => Response.json(serviceHealth('ready')));
    const session = signal<LiveSession | null>(operator(['diagnostics:read']));
    configureLive(session, request);
    const fixture = TestBed.createComponent(Shell);
    fixture.detectChanges();
    await flushPromises();
    expect(request).not.toHaveBeenCalled();

    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await flushPromises();
    fixture.detectChanges();

    expect(request).toHaveBeenCalledTimes(1);
    expect(footerStatus(fixture)).toBe('Services ready');
  });

  it('stops the timed read after a sign-out', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-20T12:00:00.000Z'));
    const request = vi.fn(async () => Response.json(serviceHealth('ready')));
    const session = signal<LiveSession | null>(operator(['diagnostics:read']));
    configureLive(session, request);
    const fixture = TestBed.createComponent(Shell);
    fixture.detectChanges();
    await flushPromises();
    expect(request).toHaveBeenCalledTimes(1);

    session.set(null);
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(61_000);
    await flushPromises();

    expect(request).toHaveBeenCalledTimes(1);
  });

  it('starts no read without diagnostics:read', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-20T12:00:00.000Z'));
    const request = vi.fn(async () => Response.json(serviceHealth('ready')));
    const session = signal<LiveSession | null>(operator(['schools:read']));
    configureLive(session, request);
    const fixture = TestBed.createComponent(Shell);
    fixture.detectChanges();
    await flushPromises();
    await vi.advanceTimersByTimeAsync(61_000);
    await flushPromises();

    expect(request).not.toHaveBeenCalled();
  });

  it('starts the timed reads when a mounted shell gains diagnostics:read', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-20T12:00:00.000Z'));
    const request = vi.fn(async () => Response.json(serviceHealth('ready')));
    const session = signal<LiveSession | null>(operator(['schools:read']));
    configureLive(session, request);
    const fixture = TestBed.createComponent(Shell);
    fixture.detectChanges();
    await flushPromises();
    await vi.advanceTimersByTimeAsync(61_000);
    await flushPromises();
    expect(request).not.toHaveBeenCalled();

    // The session ends, then the same person resumes with diagnostics:read.
    // The shell stays mounted, as it does when a session is restored.
    session.set(null);
    TestBed.tick();
    await flushPromises();
    expect(request).not.toHaveBeenCalled();

    session.set(operator(['diagnostics:read']));
    TestBed.tick();
    await flushPromises();
    fixture.detectChanges();
    expect(request).toHaveBeenCalledTimes(1);
    expect(footerStatus(fixture)).toBe('Services ready');

    await vi.advanceTimersByTimeAsync(61_000);
    await flushPromises();
    fixture.detectChanges();

    expect(request).toHaveBeenCalledTimes(3);
    expect(footerStatus(fixture)).toBe('Services ready');
  });
});

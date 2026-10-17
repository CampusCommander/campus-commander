import { Component, signal } from '@angular/core';
import type { ComponentFixture } from '@angular/core/testing';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { vi } from 'vitest';
import { AuthStore } from '../auth.store';
import { CustomerStore } from '../customer-settings/customer.store';
import { DevicesStore } from '../devices/devices.store';
import { DiagnosticsStore } from '../diagnostics/diagnostics.store';
import { ConnectionStore } from '../google-connection/connection.store';
import { GoogleHealthStore } from '../google-connection/health.store';
import { Shell } from './shell';

@Component({ selector: 'app-test-route', template: '' })
class TestRoute {}

function configure() {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([{ path: '**', component: TestRoute }]),
      {
        provide: AuthStore,
        useValue: {
          session: signal(null),
          metadata: signal(null),
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
      { provide: DevicesStore, useValue: { readable: () => false } },
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

describe('Shell header title', () => {
  beforeEach(configure);

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

  it('shows Schools on the school list', async () => {
    expect(headerTitle(await renderAt('/schools'))).toBe('Schools');
  });

  it('shows Your account on the account page', async () => {
    expect(headerTitle(await renderAt('/account'))).toBe('Your account');
  });
});

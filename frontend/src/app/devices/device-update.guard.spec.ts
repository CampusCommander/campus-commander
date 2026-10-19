import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { vi } from 'vitest';
import type { Grant } from '@campus/application-contracts';
import { AuthStore } from '../auth.store';
import { deviceUpdateWritable } from './device-update.guard';
import { DeviceWriteAccessStore } from './device-write-access.store';

const writeGrant: Grant = {
  action: 'devices:write',
  scope: { kind: 'district', customerId: 'C0123456' },
};

function configure(grants: Grant[], access: unknown) {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      {
        provide: AuthStore,
        useValue: {
          session: signal({
            identity: { id: '4f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10', grants },
            expiresAt: '2026-10-20T12:00:00.000Z',
            csrfToken: 'a'.repeat(64),
          }),
        },
      },
      { provide: DeviceWriteAccessStore, useValue: access },
    ],
  });
}

function guard() {
  return TestBed.runInInjectionContext(() =>
    deviceUpdateWritable({} as never, {} as never),
  );
}

it('opens the draft page while write access is granted', async () => {
  const load = vi.fn().mockResolvedValue({ state: 'granted' });
  configure([writeGrant], { load });
  expect(await guard()).toBe(true);
  expect(load).toHaveBeenCalled();
});

it('asks the store for a fresh answer on every draft entry', async () => {
  const load = vi
    .fn()
    .mockResolvedValueOnce({ state: 'granted' })
    .mockResolvedValueOnce({ state: 'denied' });
  configure([writeGrant], { load });
  expect(await guard()).toBe(true);
  const second = await guard();
  expect(second.toString()).toBe('/devices');
  expect(load).toHaveBeenCalledTimes(2);
});

it('returns to Devices when Google did not grant device changes', async () => {
  const load = vi.fn().mockResolvedValue({ state: 'denied' });
  configure([writeGrant], { load });
  const result = await guard();
  expect(result.toString()).toBe('/devices');
});

it('returns to Devices when the write state cannot be read', async () => {
  const load = vi.fn().mockResolvedValue(null);
  configure([writeGrant], { load });
  const result = await guard();
  expect(result.toString()).toBe('/devices');
});

it('returns to Devices without the devices:write permission', async () => {
  const load = vi.fn();
  configure([], { load });
  const result = await guard();
  expect(result.toString()).toBe('/devices');
  expect(load).not.toHaveBeenCalled();
});

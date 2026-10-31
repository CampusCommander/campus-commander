import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { vi } from 'vitest';
import { GOOGLE_HEALTH_RECOVERY } from '@campus/application-contracts';
import { AuthStore } from '../auth.store';
import { ConnectionStore } from './connection.store';
import { DriveSettings } from './drive-settings';
import { GoogleHealthStore } from './health.store';

/** 39 characters, the length of a Google browser key, without the form of one. */
const key = 'synthetic-picker-api-key-00000000000000';
const number = '123456789012';
const connection = {
  customerId: 'C0123456',
  generation: 1,
  observation: {
    customerId: 'C0123456',
    primaryDomain: 'example.org',
    domains: [],
  },
  observedAt: new Date().toISOString(),
  confirmedAt: new Date().toISOString(),
  clientId: '100000000000000000001',
  subject: 'admin@example.org',
};
const delegationHref =
  'https://admin.google.com/ac/owl/domainwidedelegation?clientScopeToAdd=drive.file&clientIdToAdd=100000000000000000001';

type Result = {
  capability: string;
  scopeVerified: boolean;
  failure: string | null;
  checkedAt: string | null;
  lastSucceededAt: string | null;
  correlationId: string | null;
};

async function mount(
  request: (path: string, body?: unknown) => Promise<Response>,
  options: { canManage?: boolean; result?: Result } = {},
) {
  const results = signal<Record<string, Result>>(
    options.result ? { 'drive-files': options.result } : {},
  );
  const check = vi.fn(async () => true);
  await TestBed.configureTestingModule({
    imports: [DriveSettings],
    providers: [
      provideRouter([]),
      {
        provide: AuthStore,
        useValue: {
          request,
          session: () => ({
            identity: { id: 'operator', permissionVersion: 1 },
            csrfToken: 'session',
          }),
          interrupted: () => false,
          can: () => options.canManage ?? true,
        },
      },
      {
        provide: ConnectionStore,
        useValue: { connection: signal(connection) },
      },
      {
        provide: GoogleHealthStore,
        useValue: {
          result: (id: string) => results()[id],
          stale: () => false,
          delegationHref: signal(delegationHref),
          error: signal(''),
          loading: signal(false),
          loaded: signal(true),
          check,
        },
      },
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(DriveSettings);
  fixture.detectChanges();
  return {
    fixture,
    component: fixture.componentInstance,
    element: fixture.nativeElement as HTMLElement,
    results,
    check,
  };
}

const passed: Result = {
  capability: 'drive-files',
  scopeVerified: true,
  failure: null,
  checkedAt: new Date().toISOString(),
  lastSucceededAt: new Date().toISOString(),
  correlationId: null,
};
const failed: Result = {
  ...passed,
  scopeVerified: false,
  failure: 'delegation-not-authorized',
  lastSucceededAt: null,
};

it('shows the saved key in full, keeps Save disabled, and claims Drive is ready only on a passed check', async () => {
  const request = vi.fn(async () =>
    Response.json({ drive: { pickerApiKey: key, projectNumber: number } }),
  );
  const { fixture, element } = await mount(request, { result: passed });
  await vi.waitFor(() =>
    expect(element.textContent).toContain('Google Drive is ready'),
  );
  const keyField = element.querySelector<HTMLInputElement>(
    'input[name="pickerApiKey"]',
  )!;
  expect(keyField.value).toBe(key);
  expect(
    element.querySelector<HTMLInputElement>('input[name="projectNumber"]')!
      .value,
  ).toBe(number);
  const save = [...element.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === 'Save Drive settings',
  )!;
  expect(save.disabled).toBe(true);
  expect(element.textContent).toContain(
    'https://www.googleapis.com/auth/drive.file',
  );
  expect(element.textContent).toContain('Last check passed');
  expect(element.textContent).not.toContain('No check result');
  fixture.destroy();
});

it('saves both fields and then runs the drive-files check', async () => {
  const request = vi.fn(async (path: string, body?: unknown) =>
    body === undefined
      ? Response.json({ drive: null })
      : Response.json({ drive: body }),
  );
  const { fixture, element, check, results } = await mount(request);
  const component = fixture.componentInstance;
  await vi.waitFor(() => expect(component.loaded()).toBe(true));
  fixture.detectChanges();
  component.pickerApiKey.set(key);
  component.projectNumber.set(number);
  fixture.detectChanges();
  const save = [...element.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === 'Save Drive settings',
  )!;
  expect(save.disabled).toBe(false);
  element
    .querySelector('form')!
    .dispatchEvent(new Event('submit', { cancelable: true }));
  await vi.waitFor(() => expect(check).toHaveBeenCalledWith(['drive-files']));
  expect(request).toHaveBeenCalledWith('/api/google-connection/drive', {
    pickerApiKey: key,
    projectNumber: number,
  });
  expect(component.saved()).toEqual({
    pickerApiKey: key,
    projectNumber: number,
  });
  expect(element.textContent).toContain('Drive settings saved.');
  expect(element.querySelector('details')!.open).toBe(false);
  results.set({ 'drive-files': passed });
  fixture.detectChanges();
  expect(element.textContent).toContain('Google Drive is ready');
  fixture.destroy();
});

it('refuses a short key and a project number that is not digits', async () => {
  const request = vi.fn(async () => Response.json({ drive: null }));
  const { fixture, component, element } = await mount(request);
  await vi.waitFor(() => expect(component.loaded()).toBe(true));
  fixture.detectChanges();
  const keyField = element.querySelector<HTMLInputElement>(
    'input[name="pickerApiKey"]',
  )!;
  keyField.value = 'a'.repeat(38);
  keyField.dispatchEvent(new Event('input'));
  keyField.dispatchEvent(new Event('blur'));
  const numberField = element.querySelector<HTMLInputElement>(
    'input[name="projectNumber"]',
  )!;
  numberField.value = '12ab';
  numberField.dispatchEvent(new Event('input'));
  numberField.dispatchEvent(new Event('blur'));
  fixture.detectChanges();
  const text = element.textContent!.replace(/\s+/g, ' ');
  expect(text).toContain('Enter the 39-character API key.');
  expect(text).toContain('Enter the project number. It holds digits only.');
  const save = [...element.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === 'Save Drive settings',
  )!;
  expect(save.disabled).toBe(true);
  element
    .querySelector('form')!
    .dispatchEvent(new Event('submit', { cancelable: true }));
  expect(request.mock.calls.filter((call) => call.length > 1)).toHaveLength(0);
  fixture.destroy();
});

it('reports a refused save and offers the save again with the values in place', async () => {
  let mode: 'empty' | 'refuse' | 'saved' = 'empty';
  const request = vi.fn(async (path: string, body?: unknown) => {
    if (body === undefined)
      return mode === 'saved'
        ? Response.json({ drive: { pickerApiKey: key, projectNumber: number } })
        : Response.json({ drive: null });
    if (mode === 'refuse')
      return Response.json({ reason: 'unavailable' }, { status: 503 });
    return Response.json({ drive: body });
  });
  const { fixture, component, element } = await mount(request);
  await vi.waitFor(() => expect(component.loaded()).toBe(true));
  component.pickerApiKey.set(key);
  component.projectNumber.set(number);
  fixture.detectChanges();
  mode = 'refuse';
  await component.save();
  fixture.detectChanges();
  expect(element.textContent).toContain(
    'Campus Commander did not save the Drive settings. Try again.',
  );
  // A definite refusal saved nothing, so Save itself offers the retry (UI-05, UI-08).
  expect(component.uncertain()).toBe(false);
  expect(component.saved()).toBeNull();
  expect(
    element.querySelector<HTMLInputElement>('input[name="pickerApiKey"]')!
      .value,
  ).toBe(key);
  expect(
    element.querySelector<HTMLInputElement>('input[name="projectNumber"]')!
      .value,
  ).toBe(number);
  expect(
    [...element.querySelectorAll('button')].some(
      (button) => button.textContent?.trim() === 'Refresh Drive settings',
    ),
  ).toBe(false);
  const save = [...element.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === 'Save Drive settings',
  )!;
  expect(save.disabled).toBe(false);
  mode = 'saved';
  element
    .querySelector('form')!
    .dispatchEvent(new Event('submit', { cancelable: true }));
  await vi.waitFor(() =>
    expect(component.saved()).toEqual({
      pickerApiKey: key,
      projectNumber: number,
    }),
  );
  expect(element.textContent).toContain('Drive settings saved.');
  fixture.destroy();
});

it('settles a lost save answer through the rendered refresh control', async () => {
  let stored = false;
  const request = vi.fn(async (path: string, body?: unknown) => {
    if (body !== undefined) throw new TypeError('Failed to fetch');
    return Response.json({
      drive: stored ? { pickerApiKey: key, projectNumber: number } : null,
    });
  });
  const { fixture, component, element } = await mount(request);
  await vi.waitFor(() => expect(component.loaded()).toBe(true));
  component.pickerApiKey.set(key);
  component.projectNumber.set(number);
  fixture.detectChanges();
  await component.save();
  fixture.detectChanges();
  expect(element.textContent).toContain(
    'The Drive settings save result is unknown. Refresh Drive settings to read the saved settings.',
  );
  expect(component.uncertain()).toBe(true);
  expect(component.saved()).toBeNull();
  const save = [...element.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === 'Save Drive settings',
  )!;
  expect(save.disabled).toBe(true);
  const refresh = [...element.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === 'Refresh Drive settings',
  )!;
  expect(refresh).toBeTruthy();
  refresh.click();
  await vi.waitFor(() => expect(component.uncertain()).toBe(false));
  fixture.detectChanges();
  // The save did not land: the draft stays and Save offers the retry.
  expect(component.saved()).toBeNull();
  expect(
    element.querySelector<HTMLInputElement>('input[name="pickerApiKey"]')!
      .value,
  ).toBe(key);
  expect(
    [...element.querySelectorAll('button')].some(
      (button) => button.textContent?.trim() === 'Refresh Drive settings',
    ),
  ).toBe(false);
  expect(save.disabled).toBe(false);
  fixture.destroy();
});

it('reads a lost save that landed through the refresh control', async () => {
  let stored = false;
  const request = vi.fn(async (path: string, body?: unknown) => {
    if (body !== undefined) {
      stored = true;
      throw new TypeError('Failed to fetch');
    }
    return Response.json({
      drive: stored ? { pickerApiKey: key, projectNumber: number } : null,
    });
  });
  const { fixture, component, element } = await mount(request);
  await vi.waitFor(() => expect(component.loaded()).toBe(true));
  component.pickerApiKey.set(key);
  component.projectNumber.set(number);
  fixture.detectChanges();
  await component.save();
  fixture.detectChanges();
  expect(component.uncertain()).toBe(true);
  const refresh = [...element.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === 'Refresh Drive settings',
  )!;
  refresh.click();
  await vi.waitFor(() => expect(component.uncertain()).toBe(false));
  fixture.detectChanges();
  expect(component.saved()).toEqual({
    pickerApiKey: key,
    projectNumber: number,
  });
  expect(element.textContent).toContain('Drive settings saved.');
  const save = [...element.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === 'Save Drive settings',
  )!;
  expect(save.disabled).toBe(true);
  fixture.destroy();
});

it('keeps the form closed and offers another read when the settings do not load', async () => {
  let calls = 0;
  const request = vi.fn(async () => {
    calls += 1;
    return calls === 1
      ? Response.json({ reason: 'unavailable' }, { status: 503 })
      : Response.json({ drive: null });
  });
  const { fixture, element } = await mount(request);
  await vi.waitFor(() =>
    expect(element.textContent).toContain(
      'Campus Commander did not read the Drive settings.',
    ),
  );
  expect(element.querySelector('input[name="pickerApiKey"]')).toBeNull();
  const retry = [...element.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === 'Refresh Drive settings',
  )!;
  retry.click();
  await vi.waitFor(() =>
    expect(element.querySelector('input[name="pickerApiKey"]')).not.toBeNull(),
  );
  fixture.destroy();
});

it('shows the Drive check failure with its recovery and the pre-filled delegation link', async () => {
  const request = vi.fn(async () => Response.json({ drive: null }));
  const { fixture, element } = await mount(request, { result: failed });
  const text = element.textContent!.replace(/\s+/g, ' ');
  expect(text).toContain(
    GOOGLE_HEALTH_RECOVERY['delegation-not-authorized'].label,
  );
  expect(text).toContain(
    GOOGLE_HEALTH_RECOVERY['delegation-not-authorized'].recovery,
  );
  const link = element.querySelector<HTMLAnchorElement>(
    'a[href*="clientScopeToAdd"]',
  )!;
  expect(link.href).toBe(delegationHref);
  expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  expect(element.querySelector('dd.error')?.textContent?.trim()).toBe(
    GOOGLE_HEALTH_RECOVERY['delegation-not-authorized'].label,
  );
  fixture.destroy();
});

it('does not show the Drive form to a person without connection:manage', async () => {
  const request = vi.fn(async () =>
    Response.json({ drive: { pickerApiKey: key, projectNumber: number } }),
  );
  const { fixture, component, element } = await mount(request, {
    canManage: false,
  });
  await vi.waitFor(() => expect(component.loaded()).toBe(true));
  fixture.detectChanges();
  expect(element.querySelector('input[name="pickerApiKey"]')).toBeNull();
  expect(element.textContent).toContain(
    'A platform administrator with Manage Google credentials access must change the Drive settings.',
  );
  fixture.destroy();
});

it('discards a save answer for the previous session and prevents duplicate submission', async () => {
  const session = signal({
    identity: { id: 'operator', permissionVersion: 1 },
    csrfToken: 'original',
  });
  let finishBody: () => void = () => {
    throw new Error('The body has not started.');
  };
  const request = vi.fn(async (path: string, body?: unknown) => {
    if (body === undefined) return Response.json({ drive: null });
    return new Response(
      new ReadableStream({
        start(controller) {
          finishBody = () => {
            controller.enqueue(
              new TextEncoder().encode(
                JSON.stringify({
                  drive: { pickerApiKey: key, projectNumber: number },
                }),
              ),
            );
            controller.close();
          };
        },
      }),
    );
  });
  const results = signal<Record<string, Result>>({});
  const check = vi.fn(async () => true);
  await TestBed.configureTestingModule({
    imports: [DriveSettings],
    providers: [
      provideRouter([]),
      {
        provide: AuthStore,
        useValue: {
          request,
          session,
          interrupted: () => false,
          can: () => true,
        },
      },
      {
        provide: ConnectionStore,
        useValue: { connection: signal(connection) },
      },
      {
        provide: GoogleHealthStore,
        useValue: {
          result: (id: string) => results()[id],
          stale: () => false,
          delegationHref: signal(delegationHref),
          error: signal(''),
          loading: signal(false),
          loaded: signal(true),
          check,
        },
      },
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(DriveSettings);
  const component = fixture.componentInstance;
  fixture.detectChanges();
  await vi.waitFor(() => expect(component.loaded()).toBe(true));
  component.pickerApiKey.set(key);
  component.projectNumber.set(number);
  fixture.detectChanges();
  const pending = component.save();
  await component.save();
  expect(
    request.mock.calls.filter(([, body]) => body !== undefined),
  ).toHaveLength(1);
  session.update((value) => ({ ...value, csrfToken: 'renewed' }));
  fixture.detectChanges();
  finishBody();
  await pending;
  expect(component.saved()).toBeNull();
  expect(component.message()).not.toContain('Drive settings saved.');
  expect(check).not.toHaveBeenCalled();
  fixture.destroy();
});

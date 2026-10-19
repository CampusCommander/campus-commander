import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AuthStore } from '../auth.store';
import { DeviceUpdateDraftStore } from './device-update-draft.store';

const principal = '4f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10';

function configure(id = principal) {
  TestBed.configureTestingModule({
    providers: [
      {
        provide: AuthStore,
        useValue: {
          session: signal({
            identity: { id },
            expiresAt: '2026-10-20T12:00:00.000Z',
            csrfToken: 'a'.repeat(64),
          }),
        },
      },
    ],
  });
  return TestBed.inject(DeviceUpdateDraftStore);
}

beforeEach(() => sessionStorage.clear());

it('starts with an empty replace draft', () => {
  const draft = configure();
  expect(draft.value()).toBe('');
  expect(draft.mode()).toBe('replace');
  expect(draft.changed()).toBe(false);
  expect(
    sessionStorage.getItem(`cc.device-update-draft.${principal}`),
  ).toBeNull();
});

it('keeps the value and mode in this tab', () => {
  const draft = configure();
  draft.setValue('North lab');
  draft.setMode('clear');
  expect(
    JSON.parse(
      sessionStorage.getItem(`cc.device-update-draft.${principal}`) ?? 'null',
    ),
  ).toEqual({ value: 'North lab', mode: 'clear' });
});

it('restores the draft after a refresh', () => {
  const first = configure();
  first.setValue('North lab');
  first.setMode('replace');
  TestBed.resetTestingModule();
  const second = configure();
  expect(second.value()).toBe('North lab');
  expect(second.mode()).toBe('replace');
  expect(second.changed()).toBe(true);
});

it('keeps a clear choice even when the value is empty', () => {
  const first = configure();
  first.setMode('clear');
  expect(first.changed()).toBe(true);
  TestBed.resetTestingModule();
  const second = configure();
  expect(second.mode()).toBe('clear');
  expect(second.changed()).toBe(true);
});

it('reset removes the stored draft', () => {
  const draft = configure();
  draft.setValue('North lab');
  draft.reset();
  expect(draft.value()).toBe('');
  expect(draft.mode()).toBe('replace');
  expect(
    sessionStorage.getItem(`cc.device-update-draft.${principal}`),
  ).toBeNull();
});

it('does not restore the draft of another person', () => {
  const first = configure('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  first.setValue('North lab');
  TestBed.resetTestingModule();
  const second = configure('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  expect(second.value()).toBe('');
});

it('keeps the draft in memory when tab storage fails', () => {
  const draft = configure();
  const setItem = vi
    .spyOn(Storage.prototype, 'setItem')
    .mockImplementation(() => {
      throw new Error('storage unavailable');
    });
  draft.setValue('North lab');
  expect(draft.value()).toBe('North lab');
  expect(draft.storageError()).toBe(
    'Tab storage is unavailable. Keep this page open until you prepare the preview.',
  );
  setItem.mockRestore();
});

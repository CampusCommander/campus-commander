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

it('starts every field at Leave unchanged', () => {
  const draft = configure();
  expect(draft.modeOf('annotatedLocation')).toBe('unchanged');
  expect(draft.modeOf('annotatedUser')).toBe('unchanged');
  expect(draft.modeOf('notes')).toBe('unchanged');
  expect(draft.valueOf('notes')).toBe('');
  expect(draft.changed()).toBe(false);
  expect(draft.changedCount()).toBe(0);
  expect(draft.changes()).toEqual([]);
  expect(
    sessionStorage.getItem(`cc.device-update-draft.${principal}`),
  ).toBeNull();
});

it('keeps a mode and a value at each field', () => {
  const draft = configure();
  draft.setMode('annotatedLocation', 'replace');
  draft.setValue('annotatedLocation', 'North lab');
  draft.setMode('notes', 'clear');
  expect(draft.modeOf('annotatedLocation')).toBe('replace');
  expect(draft.valueOf('annotatedLocation')).toBe('North lab');
  expect(draft.modeOf('notes')).toBe('clear');
  expect(draft.modeOf('annotatedUser')).toBe('unchanged');
  expect(draft.changedCount()).toBe(2);
});

it('sends the changes in contract order, and a Clear without a value', () => {
  const draft = configure();
  draft.setMode('notes', 'replace');
  draft.setValue('notes', 'Cart 7 loaner pool');
  draft.setMode('annotatedLocation', 'clear');
  draft.setMode('annotatedUser', 'replace');
  draft.setValue('annotatedUser', 'maya.chen@example.org');
  expect(draft.changes()).toEqual([
    { field: 'annotatedLocation', mode: 'clear' },
    { field: 'annotatedUser', mode: 'replace', value: 'maya.chen@example.org' },
    { field: 'notes', mode: 'replace', value: 'Cart 7 loaner pool' },
  ]);
});

it('keeps the draft in this tab', () => {
  const draft = configure();
  draft.setMode('annotatedUser', 'replace');
  draft.setValue('annotatedUser', 'maya.chen@example.org');
  expect(
    JSON.parse(
      sessionStorage.getItem(`cc.device-update-draft.${principal}`) ?? 'null',
    ),
  ).toEqual({
    sheet: {
      fields: [
        {
          field: 'annotatedUser',
          mode: 'replace',
          value: 'maya.chen@example.org',
        },
      ],
    },
  });
});

it('restores every field after a refresh', () => {
  const first = configure();
  first.setMode('annotatedLocation', 'replace');
  first.setValue('annotatedLocation', 'North lab');
  first.setMode('notes', 'clear');
  TestBed.resetTestingModule();
  const second = configure();
  expect(second.modeOf('annotatedLocation')).toBe('replace');
  expect(second.valueOf('annotatedLocation')).toBe('North lab');
  expect(second.modeOf('notes')).toBe('clear');
  expect(second.modeOf('annotatedUser')).toBe('unchanged');
  expect(second.changedCount()).toBe(2);
});

it('keeps a clear choice even when its value is empty', () => {
  const first = configure();
  first.setMode('notes', 'clear');
  expect(first.changes()).toEqual([{ field: 'notes', mode: 'clear' }]);
  TestBed.resetTestingModule();
  const second = configure();
  expect(second.modeOf('notes')).toBe('clear');
  expect(second.changed()).toBe(true);
});

it('reset removes every field and the stored draft', () => {
  const draft = configure();
  draft.setMode('annotatedLocation', 'replace');
  draft.setValue('annotatedLocation', 'North lab');
  draft.setMode('notes', 'replace');
  draft.setValue('notes', 'Cart 7 loaner pool');
  draft.reset();
  expect(draft.changed()).toBe(false);
  expect(draft.changes()).toEqual([]);
  expect(
    sessionStorage.getItem(`cc.device-update-draft.${principal}`),
  ).toBeNull();
});

it('keeps a move with its path and the unit identity', () => {
  const draft = configure();
  draft.setMode('orgUnitPath', 'move');
  // A Move without a destination is not yet a change (design choice 10).
  expect(draft.changed()).toBe(false);
  expect(draft.changes()).toEqual([]);
  draft.setOrgUnit({
    orgUnitId: 'ou-cart',
    path: '/Chrome Devices/Cart Devices',
  });
  expect(draft.modeOf('orgUnitPath')).toBe('move');
  expect(draft.valueOf('orgUnitPath')).toBe('/Chrome Devices/Cart Devices');
  // The stable identity of the destination survives the path (TREE-01).
  expect(draft.orgUnitId()).toBe('ou-cart');
  expect(draft.changes()).toEqual([
    {
      field: 'orgUnitPath',
      mode: 'move',
      value: '/Chrome Devices/Cart Devices',
    },
  ]);
});

it('restores a move with its path and identity after a refresh', () => {
  const first = configure();
  first.setOrgUnit({
    orgUnitId: 'ou-cart',
    path: '/Chrome Devices/Cart Devices',
  });
  TestBed.resetTestingModule();
  const second = configure();
  expect(second.modeOf('orgUnitPath')).toBe('move');
  expect(second.valueOf('orgUnitPath')).toBe('/Chrome Devices/Cart Devices');
  expect(second.orgUnitId()).toBe('ou-cart');
  expect(second.changes()).toEqual([
    {
      field: 'orgUnitPath',
      mode: 'move',
      value: '/Chrome Devices/Cart Devices',
    },
  ]);
});

it('drops the destination when the organization unit leaves Move', () => {
  const draft = configure();
  draft.setOrgUnit({
    orgUnitId: 'ou-cart',
    path: '/Chrome Devices/Cart Devices',
  });
  draft.setMode('orgUnitPath', 'unchanged');
  expect(draft.valueOf('orgUnitPath')).toBe('');
  expect(draft.orgUnitId()).toBeNull();
  expect(draft.changed()).toBe(false);
  expect(
    sessionStorage.getItem(`cc.device-update-draft.${principal}`),
  ).toBeNull();
});

it('refuses a stored move without a path', () => {
  sessionStorage.setItem(
    `cc.device-update-draft.${principal}`,
    JSON.stringify({
      sheet: {
        fields: [{ field: 'orgUnitPath', mode: 'move', value: 'Cart Devices' }],
      },
    }),
  );
  const draft = configure();
  expect(draft.changed()).toBe(false);
  expect(draft.storageError()).toBe(
    'This tab cannot restore the device update draft. Check each field before saving.',
  );
});

it('does not restore the draft of another person', () => {
  const first = configure('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  first.setMode('notes', 'replace');
  first.setValue('notes', 'Cart 7 loaner pool');
  TestBed.resetTestingModule();
  const second = configure('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  expect(second.valueOf('notes')).toBe('');
  expect(second.changed()).toBe(false);
});

it('keeps the draft in memory when tab storage fails', () => {
  const draft = configure();
  const setItem = vi
    .spyOn(Storage.prototype, 'setItem')
    .mockImplementation(() => {
      throw new Error('storage unavailable');
    });
  draft.setMode('notes', 'replace');
  draft.setValue('notes', 'Cart 7 loaner pool');
  expect(draft.valueOf('notes')).toBe('Cart 7 loaner pool');
  expect(draft.storageError()).toBe(
    'Tab storage is unavailable. Keep this page open until you prepare the preview.',
  );
  setItem.mockRestore();
});

it('reports a draft that this tab cannot read', () => {
  sessionStorage.setItem(
    `cc.device-update-draft.${principal}`,
    JSON.stringify({ sheet: { value: 'North lab', mode: 'replace' } }),
  );
  const draft = configure();
  expect(draft.changed()).toBe(false);
  expect(draft.storageError()).toBe(
    'This tab cannot restore the device update draft. Check each field before saving.',
  );
});

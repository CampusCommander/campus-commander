import {
  DEVICE_WRITE_ACCESS_DENIED_MESSAGE,
  DEVICE_ORG_UNIT_TREE_DENIED_MESSAGE,
  type DeviceOrgUnitTree,
  type DeviceWriteAccess,
} from '@campus/application-contracts';
import {
  DEVICE_ORG_UNIT_SCOPE,
  DEVICE_UPDATE_PERMISSION_MESSAGE,
  DEVICE_WRITE_ACCESS_BUSY_MESSAGE,
  changedFieldsText,
  deviceCountText,
  deviceUpdateValueCounter,
  deviceUpdateValueError,
  deviceUpdateValueHint,
  updateDeviceNote,
  updateDeviceOrgUnitNote,
  type UpdateDeviceAvailability,
} from './device-update-messages';

const allowed: UpdateDeviceAvailability = {
  offline: false,
  canRead: true,
  canWrite: true,
  canBulk: true,
  selectionCount: 6,
  access: null,
  accessLoading: false,
};

const access = (state: DeviceWriteAccess['state']): DeviceWriteAccess => ({
  state,
  scope: 'https://www.googleapis.com/auth/admin.directory.device.chromeos',
  failure: null,
  checkedAt: '2026-10-19T12:00:00.000Z',
});

describe('updateDeviceNote', () => {
  it('enables Update device when access is granted', () => {
    expect(
      updateDeviceNote({ ...allowed, access: access('granted') }),
    ).toBeNull();
  });

  it('names the offline state', () => {
    expect(
      updateDeviceNote({
        ...allowed,
        offline: true,
        access: access('granted'),
      }),
    ).toMatchObject({
      text: 'Update device is unavailable while you are offline.',
      actions: [],
    });
  });

  it('names the three required permissions', () => {
    for (const missing of ['canRead', 'canWrite', 'canBulk'] as const) {
      expect(
        updateDeviceNote({
          ...allowed,
          [missing]: false,
          access: access('granted'),
        }),
      ).toMatchObject({
        text: DEVICE_UPDATE_PERMISSION_MESSAGE,
        actions: [],
      });
    }
  });

  it('asks for a selection before anything else', () => {
    expect(updateDeviceNote({ ...allowed, selectionCount: 0 })).toMatchObject({
      text: 'Select one or more devices to update.',
      actions: [],
    });
  });

  it('reports a pending first check', () => {
    expect(updateDeviceNote({ ...allowed, accessLoading: true })).toMatchObject(
      {
        text: 'Checking Google write access…',
        actions: [],
      },
    );
  });

  it('offers Recheck when the state could not be read', () => {
    expect(updateDeviceNote(allowed)).toMatchObject({
      text: 'Campus Commander could not read Google write access.',
      actions: ['recheck'],
      error: true,
    });
  });

  it('shows the scope-named message with Copy scope and Recheck when denied', () => {
    expect(
      updateDeviceNote({ ...allowed, access: access('denied') }),
    ).toMatchObject({
      text: DEVICE_WRITE_ACCESS_DENIED_MESSAGE,
      actions: ['copy-scope', 'recheck'],
      error: true,
    });
  });

  it('offers Recheck after an unchecked state', () => {
    expect(
      updateDeviceNote({ ...allowed, access: access('unchecked') }),
    ).toMatchObject({
      text: 'Campus Commander has not checked Google write access.',
      actions: ['recheck'],
      error: false,
    });
  });

  it('shows the failure label and recovery of an unavailable state', () => {
    expect(
      updateDeviceNote({
        ...allowed,
        access: {
          ...access('unavailable'),
          failure: 'quota',
        },
      }),
    ).toMatchObject({
      text: 'Google request limit. Wait for the request limit to recover, then retry. Check the Google project quota if failures continue.',
      actions: ['recheck'],
      error: true,
    });
  });

  it('shows a generic message for an unavailable state without a failure', () => {
    expect(
      updateDeviceNote({ ...allowed, access: access('unavailable') }),
    ).toMatchObject({
      text: 'Google write access is unavailable.',
      actions: ['recheck'],
    });
  });
});

describe('draft copy', () => {
  it('formats counts with thousands separators and the right noun', () => {
    expect(deviceCountText(6)).toBe('6 devices');
    expect(deviceCountText(1)).toBe('1 device');
    expect(deviceCountText(128431)).toBe('128,431 devices');
    expect(changedFieldsText(1)).toBe('1 changed field');
    expect(changedFieldsText(0)).toBe('0 changed fields');
  });

  it('accepts a value of 1 to the limit of each field, in code points', () => {
    expect(deviceUpdateValueError('annotatedLocation', 'North lab')).toBeNull();
    expect(
      deviceUpdateValueError('annotatedLocation', '😀'.repeat(200)),
    ).toBeNull();
    expect(deviceUpdateValueError('annotatedUser', 'a'.repeat(100))).toBeNull();
    expect(deviceUpdateValueError('notes', 'a'.repeat(500))).toBeNull();
  });

  it('rejects an empty, whitespace-only, or over-long value and names the field', () => {
    expect(deviceUpdateValueError('annotatedLocation', '')).toBe(
      'Annotated location holds 1 to 200 characters.',
    );
    expect(deviceUpdateValueError('annotatedUser', '   ')).toBe(
      'Annotated user needs a visible character.',
    );
    expect(deviceUpdateValueError('notes', 'a'.repeat(501))).toBe(
      'Notes holds 1 to 500 characters.',
    );
    expect(deviceUpdateValueError('annotatedUser', 'a'.repeat(101))).toBe(
      'Annotated user holds 1 to 100 characters.',
    );
  });

  it('names the limit of each field in its hint and counter', () => {
    expect(deviceUpdateValueHint('annotatedLocation')).toBe(
      'Use 200 characters or fewer. Spaces alone do not count.',
    );
    expect(deviceUpdateValueHint('annotatedUser')).toBe(
      'Use 100 characters or fewer. Spaces alone do not count.',
    );
    expect(deviceUpdateValueHint('notes')).toBe(
      'Use 500 characters or fewer. Spaces alone do not count.',
    );
    expect(deviceUpdateValueCounter('notes', 'Cart 7 loaner pool')).toBe(
      '18 of 500 characters',
    );
    expect(deviceUpdateValueCounter('annotatedUser', '😀')).toBe(
      '1 of 100 characters',
    );
  });

  it('pins the busy answer of the write-access check', () => {
    expect(DEVICE_WRITE_ACCESS_BUSY_MESSAGE).toBe(
      'Another check started less than 30 seconds ago. Try again in 30 seconds.',
    );
  });

  it('explains a denied organization unit read with the scope and two actions', () => {
    const denied: DeviceOrgUnitTree = {
      state: 'denied',
      scope: DEVICE_ORG_UNIT_SCOPE,
      failure: 'scope-mismatch',
      orgUnits: null,
      observedAt: '2026-10-21T12:00:00.000Z',
    };
    expect(updateDeviceOrgUnitNote(denied, '')).toEqual({
      text: DEVICE_ORG_UNIT_TREE_DENIED_MESSAGE,
      actions: ['copy-scope', 'recheck'],
      error: true,
    });
    expect(DEVICE_ORG_UNIT_SCOPE).toBe(
      'https://www.googleapis.com/auth/admin.directory.orgunit.readonly',
    );
  });

  it('explains an unreachable organization unit read without a scope to copy', () => {
    expect(
      updateDeviceOrgUnitNote(
        {
          state: 'unavailable',
          scope: DEVICE_ORG_UNIT_SCOPE,
          failure: 'network-failure',
          orgUnits: null,
          observedAt: '2026-10-21T12:00:00.000Z',
        },
        '',
      ),
    ).toEqual({
      text: 'Google connection unavailable. Check outbound connectivity and DNS. Retry after the connection returns.',
      actions: ['recheck'],
      error: true,
    });
  });

  it('shows the read failure before the tree arrives and nothing once it is granted', () => {
    expect(updateDeviceOrgUnitNote(null, '')).toBeNull();
    expect(updateDeviceOrgUnitNote(null, 'The tree did not load.')).toEqual({
      text: 'The tree did not load.',
      actions: ['recheck'],
      error: true,
    });
    expect(
      updateDeviceOrgUnitNote(
        {
          state: 'granted',
          scope: DEVICE_ORG_UNIT_SCOPE,
          failure: null,
          orgUnits: [
            {
              orgUnitId: 'ou-root',
              name: 'example.org',
              orgUnitPath: '/',
              parentOrgUnitId: null,
            },
          ],
          observedAt: '2026-10-21T12:00:00.000Z',
        },
        '',
      ),
    ).toBeNull();
  });
});

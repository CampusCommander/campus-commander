import {
  DEVICE_WRITE_ACCESS_DENIED_MESSAGE,
  type DeviceWriteAccess,
} from '@campus/application-contracts';
import {
  DEVICE_UPDATE_PERMISSION_MESSAGE,
  DEVICE_UPDATE_VALUE_MESSAGES,
  DEVICE_WRITE_ACCESS_BUSY_MESSAGE,
  changedFieldsText,
  deviceCountText,
  deviceUpdateValueError,
  updateDeviceNote,
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

  it('accepts a value of 1 to 200 code points', () => {
    expect(deviceUpdateValueError('North lab')).toBeNull();
    expect(deviceUpdateValueError('😀'.repeat(200))).toBeNull();
    expect(deviceUpdateValueError('a'.repeat(200))).toBeNull();
  });

  it('rejects an empty, whitespace-only, or over-long value', () => {
    expect(deviceUpdateValueError('')).toBe(
      DEVICE_UPDATE_VALUE_MESSAGES.length,
    );
    expect(deviceUpdateValueError('   ')).toBe(
      DEVICE_UPDATE_VALUE_MESSAGES.visible,
    );
    expect(deviceUpdateValueError('😀'.repeat(201))).toBe(
      DEVICE_UPDATE_VALUE_MESSAGES.length,
    );
  });

  it('pins the busy answer of the write-access check', () => {
    expect(DEVICE_WRITE_ACCESS_BUSY_MESSAGE).toBe(
      'Another check started less than 30 seconds ago. Try again in 30 seconds.',
    );
  });
});

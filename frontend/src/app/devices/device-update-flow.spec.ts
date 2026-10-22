import type { DeviceUpdatePreview } from '@campus/application-contracts';
import { previewCountLine } from './device-update-flow';

const preview = (
  fields: Partial<DeviceUpdatePreview>,
): DeviceUpdatePreview => ({
  previewId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  displayId: 'PV-006',
  changes: [
    { field: 'annotatedLocation', mode: 'replace', value: 'North lab' },
  ],
  fieldChanges: 6,
  selected: 6,
  eligible: 6,
  unchanged: 0,
  excluded: 0,
  oldestObservedAt: null,
  stale: false,
  preparedAt: '2026-10-19T12:00:00.000Z',
  expiresAt: '2026-10-19T12:15:00.000Z',
  manifestDigest: 'a'.repeat(64),
  ...fields,
});

it('counts the eligible device-field rows, not the eligible devices', () => {
  expect(
    previewCountLine(
      preview({
        changes: [
          { field: 'annotatedUser', mode: 'replace', value: 'New user' },
          { field: 'notes', mode: 'replace', value: 'Room 12' },
        ],
        fieldChanges: 11,
        unchanged: 1,
        excluded: 2,
      }),
    ),
  ).toBe('6 devices · 11 field changes · 2 excluded');
});

it('keeps one field change singular', () => {
  expect(previewCountLine(preview({ fieldChanges: 1 }))).toBe(
    '6 devices · 1 field change · 0 excluded',
  );
});

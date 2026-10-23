import type {
  DeviceUpdatePreview,
  DeviceUpdateTarget,
} from '@campus/application-contracts';
import {
  changeSentence,
  changeSentences,
  confirmationHeading,
  confirmationMetaLine,
  previewCountLine,
  sentenceText,
  targetGroups,
  unchangedSentence,
} from './device-update-flow';

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
  conflicts: 0,
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

it('counts the changed fields and the eligible devices in the heading', () => {
  expect(
    confirmationHeading(
      preview({
        changes: [
          { field: 'annotatedLocation', mode: 'replace', value: 'North lab' },
          {
            field: 'annotatedUser',
            mode: 'replace',
            value: 'maya@example.org',
          },
          { field: 'notes', mode: 'clear' },
        ],
        eligible: 5,
      }),
    ),
  ).toBe('Update 3 fields on 5 devices');
  expect(
    confirmationHeading(
      preview({
        changes: [{ field: 'notes', mode: 'clear' }],
        eligible: 1,
      }),
    ),
  ).toBe('Update 1 field on 1 device');
});

it('reads an edit list without changes as no change', () => {
  // An edit list answers null changes, because each of its rows carries its own request.
  const editList = preview({ changes: null });
  expect(confirmationHeading(editList)).toBe('Update 0 fields on 6 devices');
  expect(changeSentences(editList, [])).toEqual([]);
  expect(unchangedSentence(editList)).toBe(
    'Annotated location, annotated user, notes, and organization unit remain unchanged.',
  );
});

/**
 * Frozen target rows for the confirmation tests. Each entry lists its rows per device in
 * contract order, one row per device and field.
 */
function targetRows(
  fields: readonly {
    field: DeviceUpdateTarget['field'];
    devices: number;
    disposition?: 'eligible' | 'unchanged' | 'excluded';
    exclusionReason?: string | null;
    approvedValue?: string | null;
  }[],
): DeviceUpdateTarget[] {
  return fields.flatMap(
    ({
      field,
      devices,
      disposition = 'eligible',
      exclusionReason = null,
      approvedValue = null,
    }) =>
      Array.from({ length: devices }, (_, index) => ({
        deviceId: `device-${field}-${index + 1}`,
        serialNumber: `S-${field}-${index + 1}`,
        field,
        observedValue: null,
        baselineValue: null,
        approvedValue: disposition === 'excluded' ? null : approvedValue,
        duplicateSerialNumber: null,
        disposition,
        exclusionReason,
      })),
  );
}

/** Five eligible rows per changed field, the control case. */
const allEligible = targetRows([
  { field: 'annotatedLocation', devices: 5, approvedValue: 'North lab' },
  {
    field: 'annotatedUser',
    devices: 5,
    approvedValue: 'maya.chen@example.org',
  },
  { field: 'notes', devices: 5 },
]);

it('writes one confirmation sentence per changed field', () => {
  expect(
    changeSentences(
      preview({
        changes: [
          { field: 'annotatedLocation', mode: 'replace', value: 'North lab' },
          {
            field: 'annotatedUser',
            mode: 'replace',
            value: 'maya.chen@example.org',
          },
          { field: 'notes', mode: 'clear' },
        ],
        eligible: 5,
      }),
      allEligible,
    ).map(sentenceText),
  ).toEqual([
    'Set the annotated location to North lab on 5 devices.',
    'Set the annotated user to maya.chen@example.org on 5 devices.',
    'Clear the notes on 5 devices.',
  ]);
});

it('counts each field from its own eligible frozen rows', () => {
  // Five eligible devices change the location. One of them already holds the requested
  // notes, so the notes sentence names four devices, not the five eligible devices.
  const mixed = targetRows([
    { field: 'annotatedLocation', devices: 5, approvedValue: 'North lab' },
    { field: 'notes', devices: 4, approvedValue: 'Cart 7 loaner pool' },
    {
      field: 'notes',
      devices: 1,
      disposition: 'unchanged',
      approvedValue: 'Cart 7 loaner pool',
    },
    {
      field: 'notes',
      devices: 1,
      disposition: 'excluded',
      exclusionReason: 'removed',
    },
  ]);
  expect(
    changeSentences(
      preview({
        changes: [
          { field: 'annotatedLocation', mode: 'replace', value: 'North lab' },
          { field: 'notes', mode: 'replace', value: 'Cart 7 loaner pool' },
        ],
        selected: 6,
        eligible: 5,
        unchanged: 0,
        excluded: 1,
        fieldChanges: 9,
      }),
      mixed,
    ).map(sentenceText),
  ).toEqual([
    'Set the annotated location to North lab on 5 devices.',
    'Set the notes to Cart 7 loaner pool on 4 devices.',
  ]);
});

it('counts a clear from its own eligible frozen rows and keeps singular counts', () => {
  const targets = targetRows([
    { field: 'annotatedLocation', devices: 1 },
    { field: 'notes', devices: 2 },
    { field: 'notes', devices: 3, disposition: 'unchanged' },
  ]);
  expect(
    changeSentences(
      preview({
        changes: [
          { field: 'annotatedLocation', mode: 'clear' },
          { field: 'notes', mode: 'clear' },
        ],
        selected: 6,
        eligible: 3,
        unchanged: 3,
        excluded: 0,
        fieldChanges: 3,
      }),
      targets,
    ).map(sentenceText),
  ).toEqual([
    'Clear the annotated location on 1 device.',
    'Clear the notes on 2 devices.',
  ]);
});

it('names the fields that keep their value', () => {
  expect(
    unchangedSentence(
      preview({ changes: [{ field: 'notes', mode: 'clear' }] }),
    ),
  ).toBe(
    'Annotated location, annotated user, and organization unit remain unchanged.',
  );
  expect(
    unchangedSentence(
      preview({
        changes: [
          { field: 'notes', mode: 'clear' },
          { field: 'annotatedUser', mode: 'clear' },
        ],
      }),
    ),
  ).toBe('Annotated location and organization unit remain unchanged.');
  expect(
    unchangedSentence(
      preview({
        changes: [
          { field: 'annotatedLocation', mode: 'clear' },
          { field: 'annotatedUser', mode: 'clear' },
          { field: 'notes', mode: 'clear' },
        ],
      }),
    ),
  ).toBe('Organization unit remains unchanged.');
  expect(
    unchangedSentence(
      preview({
        changes: [
          { field: 'annotatedLocation', mode: 'clear' },
          { field: 'annotatedUser', mode: 'clear' },
          { field: 'notes', mode: 'clear' },
          {
            field: 'orgUnitPath',
            mode: 'move',
            value: '/Chrome Devices/Cart Devices',
          },
        ],
      }),
    ),
  ).toBe('');
});

it('names the move destination and its policy note', () => {
  const sentence = changeSentence(
    {
      field: 'orgUnitPath',
      mode: 'move',
      value: '/Chrome Devices/Cart Devices',
    },
    5,
  );
  // The path is its own part, so the cell can break after each slash (design note 17).
  expect(sentence).toEqual({
    before: 'Move 5 devices into ',
    path: '/Chrome Devices/Cart Devices',
    after: '. Destination policies apply.',
  });
  expect(sentenceText(sentence)).toBe(
    'Move 5 devices into /Chrome Devices/Cart Devices. Destination policies apply.',
  );
  expect(
    sentenceText(
      changeSentence(
        { field: 'orgUnitPath', mode: 'move', value: '/School A' },
        1,
      ),
    ),
  ).toBe('Move 1 device into /School A. Destination policies apply.');
});

it('counts the field changes of the frozen preview in the confirmation meta line', () => {
  expect(
    confirmationMetaLine(
      preview({ selected: 6, eligible: 5, fieldChanges: 15 }),
    ),
  ).toBe('Preview PV-006 · 6 devices · 15 field changes');
});

it('groups the frozen targets by device, with the exclusion reason once', () => {
  const groups = targetGroups([
    {
      deviceId: 'device-1',
      serialNumber: '01P0T1V',
      field: 'annotatedLocation',
      observedValue: 'Science wing',
      baselineValue: 'Science wing',
      approvedValue: 'North lab',
      duplicateSerialNumber: null,
      disposition: 'eligible',
      exclusionReason: null,
    },
    {
      deviceId: 'device-1',
      serialNumber: '01P0T1V',
      field: 'notes',
      observedValue: null,
      baselineValue: null,
      approvedValue: 'Cart 7 loaner pool',
      duplicateSerialNumber: null,
      disposition: 'eligible',
      exclusionReason: null,
    },
    {
      deviceId: 'device-2',
      serialNumber: '02A1MB6',
      field: 'annotatedLocation',
      observedValue: null,
      baselineValue: null,
      approvedValue: null,
      duplicateSerialNumber: null,
      disposition: 'excluded',
      exclusionReason: 'removed',
    },
    {
      deviceId: 'device-2',
      serialNumber: '02A1MB6',
      field: 'notes',
      observedValue: null,
      baselineValue: null,
      approvedValue: null,
      duplicateSerialNumber: null,
      disposition: 'excluded',
      exclusionReason: 'removed',
    },
  ]);
  expect(groups.map((group) => group.serialNumber)).toEqual([
    '01P0T1V',
    '02A1MB6',
  ]);
  expect(groups[0].rows.map((row) => row.field)).toEqual([
    'annotatedLocation',
    'notes',
  ]);
  expect(groups[0].excluded).toBeNull();
  expect(groups[1].excluded).toBe('Excluded · Removed from inventory');
  expect(groups[1].rows).toHaveLength(2);
});

import type { DevicePredicate } from '@campus/application-contracts';
import {
  batteryText,
  chipLabel,
  dateInputToIso,
  dateInputValue,
  groupLabel,
  orgUnitOptions,
  relativeTime,
  shortcutLabel,
  suggestions,
  syncFailureText,
  telemetryFailureText,
  unitCheck,
  unitsWithin,
  withUnit,
} from './device-fields';

describe('device fields', () => {
  it('labels each filter type the way the chips read', () => {
    const day = new Date(2026, 9, 1).toISOString();
    const cases: [DevicePredicate, string][] = [
      [
        { field: 'assetTag', operator: 'startsWith', value: 'HS-04' },
        'Asset tag starts with: HS-04',
      ],
      [{ field: 'notes', operator: 'isEmpty' }, 'Notes is empty'],
      [
        { field: 'serialNumber', operator: 'equals', value: 'C0A1' },
        'Serial is: C0A1',
      ],
      [
        { field: 'orgUnitPath', operator: 'in', values: ['/School A'] },
        'Organization unit · /School A',
      ],
      [
        {
          field: 'orgUnitPath',
          operator: 'in',
          values: ['/A', '/B', '/C', '/D'],
        },
        'Organization unit · 4 units',
      ],
      [{ field: 'battery', operator: 'is', values: [] }, 'Battery · none'],
      [
        {
          field: 'battery',
          operator: 'is',
          values: ['replace-soon', 'no-report'],
        },
        'Battery · Replace soon, No battery report',
      ],
      [
        { field: 'lastContact', operator: 'before', value: day },
        'Device contact before: Oct 1, 2026',
      ],
    ];
    for (const [predicate, label] of cases)
      expect(chipLabel(predicate)).toBe(label);
  });

  it('lists matched fields and identifier shortcuts for typed text', () => {
    const result = suggestions(' asset ');
    expect(result.fields.map((field) => field.label)).toEqual(['Asset tag']);
    expect(result.shortcuts.map(shortcutLabel)).toEqual([
      'Asset tag contains "asset"',
      'Serial contains "asset"',
    ]);
    const empty = suggestions('');
    expect(empty.fields).toHaveLength(8);
    expect(empty.shortcuts).toEqual([]);
  });

  it('builds the organization unit tree with ancestors and search', () => {
    const units = [
      { path: '/School A/Library', devices: 3 },
      { path: '/School B', devices: 1 },
    ];
    expect(orgUnitOptions(units)).toEqual([
      { path: '/', label: 'All organization units', depth: 0 },
      { path: '/School A', label: 'School A', depth: 1 },
      { path: '/School A/Library', label: 'Library', depth: 2 },
      { path: '/School B', label: 'School B', depth: 1 },
    ]);
    expect(orgUnitOptions(units, 'library').map((unit) => unit.path)).toEqual([
      '/School A/Library',
    ]);
  });

  it('describes battery data and contact age', () => {
    expect(
      batteryText({
        status: 'reported',
        health: 'replace-now',
        capacityPercent: 70,
        reportedAt: '2026-10-05T12:00:00Z',
      }),
    ).toBe('Replace now');
    expect(batteryText({ status: 'no-report' })).toBe('No battery report');
    expect(batteryText({ status: 'unavailable' })).toBe('Unavailable');
    const now = Date.parse('2026-10-05T12:00:00Z');
    expect(relativeTime(null, now)).toBe('Never');
    expect(relativeTime('2026-10-05T11:59:30Z', now)).toBe('Just now');
    expect(relativeTime('2026-10-05T11:58:00Z', now)).toBe('2 min ago');
    expect(relativeTime('2026-10-05T09:00:00Z', now)).toBe('3 h ago');
    expect(relativeTime('2026-10-01T12:00:00Z', now)).toBe('4 d ago');
  });

  it('converts date inputs to local midnight and back', () => {
    const iso = dateInputToIso('2026-10-01');
    expect(iso).toBe(new Date(2026, 9, 1).toISOString());
    expect(dateInputValue(iso!)).toBe('2026-10-01');
    expect(dateInputToIso('')).toBeNull();
    expect(dateInputToIso('2026-13-45')).toBeNull();
  });

  it('explains Google access failures with the scope action', () => {
    expect(syncFailureText('delegation-not-authorized')).toContain(
      'Add the device scopes',
    );
    expect(syncFailureText('interrupted')).toBe(
      'The last refresh stopped before it finished.',
    );
    expect(syncFailureText(null)).toBe('');
    expect(telemetryFailureText('permission-denied')).toContain(
      'Add the telemetry scope',
    );
    expect(telemetryFailureText(null)).toBeNull();
  });
});

it('shows full paths while searching organization units', () => {
  const units = [
    { path: '/School A/Students', devices: 3 },
    { path: '/School B/Students', devices: 1 },
  ];
  expect(orgUnitOptions(units, 'students').map((unit) => unit.label)).toEqual([
    '/School A/Students',
    '/School B/Students',
  ]);
});

it('selects an organization unit together with the units inside it', () => {
  const units = [
    { path: '/', devices: 2 },
    { path: '/School A', devices: 5 },
    { path: '/School A/Library', devices: 3 },
    { path: '/School AB', devices: 1 },
  ];
  expect(unitsWithin(units, '/School A')).toEqual([
    '/School A',
    '/School A/Library',
  ]);
  expect(unitsWithin(units, '/')).toHaveLength(4);
  const chosen = withUnit([], units, '/School A', true);
  expect(chosen).toEqual(['/School A', '/School A/Library']);
  expect(unitCheck(chosen, units, '/School A')).toBe('checked');
  expect(unitCheck(chosen, units, '/')).toBe('mixed');
  expect(unitCheck(chosen, units, '/School AB')).toBe('unchecked');
  expect(withUnit(chosen, units, '/School A/Library', false)).toEqual([
    '/School A',
  ]);
});

it('labels group keys the way the filters read', () => {
  expect(groupLabel('orgUnitPath', '/School A/Library')).toBe(
    '/School A/Library',
  );
  expect(groupLabel('model', '')).toBe('No model');
  expect(groupLabel('model', 'Lenovo 100e')).toBe('Lenovo 100e');
  expect(groupLabel('battery', 'replace-soon')).toBe('Replace soon');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BATTERY_LABELS,
  DEVICE_REPORT_FIELD_IDS,
  DEVICE_REPORT_FIELD_LABELS,
  DEVICE_STATUS_LABELS,
  batteryText,
  deviceExportFileName,
  deviceExportReceiptSchema,
  deviceExportRequestSchema,
  deviceReportCellText,
  statusText,
} from './device-export.ts';
import { deviceRowSchema } from './devices.ts';

const row = deviceRowSchema.parse({
  deviceId: '04XTBHJ',
  serialNumber: 'C0A1-7F2D',
  model: 'Chromebook 3100',
  assetTag: 'CB970992',
  orgUnitPath: '/Chrome Devices/Lowell Academy/Grade 9',
  lastContact: '2026-10-28T10:31:00-04:00',
  annotatedLocation: 'Room 12',
  annotatedUser: 'jmorales14@example.org',
  notes: null,
  status: 'DISABLED',
  battery: {
    status: 'reported',
    health: 'replace-soon',
    capacityPercent: 71,
    reportedAt: '2026-10-28T10:00:00.000Z',
  },
  lastEntitySync: '2026-10-28T10:31:00.000Z',
  stale: false,
});

const request = {
  gridId: 'devices',
  tabId: '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0',
  purpose: 'edit',
  format: 'csv',
  sort: { field: 'serialNumber', direction: 'asc' },
  columns: [],
};

test('an edit export names no column and a report export names its grid columns', () => {
  assert.deepEqual(deviceExportRequestSchema.parse(request), request);
  const report = {
    ...request,
    purpose: 'report',
    columns: [
      'serialNumber',
      'model',
      'assetTag',
      'orgUnitPath',
      'battery',
      'lastContact',
    ],
    sort: { field: 'orgUnitPath', direction: 'desc' },
  };
  assert.deepEqual(deviceExportRequestSchema.parse(report), report);
  // An edit export writes the template, so it names no column (design section 1).
  assert.equal(
    deviceExportRequestSchema.safeParse({ ...request, columns: ['notes'] })
      .success,
    false,
  );
  // A report of no column writes no value, so it names one at least.
  assert.equal(
    deviceExportRequestSchema.safeParse({ ...report, columns: [] }).success,
    false,
  );
  assert.equal(
    deviceExportRequestSchema.safeParse({ ...report, columns: ['group'] })
      .success,
    false,
  );
  assert.equal(
    deviceExportRequestSchema.safeParse({ ...request, format: 'sheet' })
      .success,
    false,
    'The Drive slice adds sheet.',
  );
  assert.equal(
    deviceExportRequestSchema.safeParse({ ...request, extra: true }).success,
    false,
  );
  assert.equal(
    deviceExportRequestSchema.safeParse({
      ...request,
      sort: { field: 'serialNumber', direction: 'up' },
    }).success,
    false,
  );
});

test('the export receipt carries the job, its display ID, and the row count', () => {
  const receipt = {
    jobId: '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0',
    displayId: 'EXP-001',
    status: 'accepted',
    rows: 48,
  };
  assert.deepEqual(deviceExportReceiptSchema.parse(receipt), receipt);
  assert.equal(
    deviceExportReceiptSchema.safeParse({ ...receipt, displayId: 'EXP-01' })
      .success,
    false,
  );
  assert.equal(
    deviceExportReceiptSchema.safeParse({ ...receipt, rows: -1 }).success,
    false,
  );
  assert.equal(
    deviceExportReceiptSchema.safeParse({ ...receipt, status: 'running' })
      .success,
    false,
  );
});

test('the report field IDs are the ten grid fields with their grid labels', () => {
  assert.deepEqual(DEVICE_REPORT_FIELD_IDS, [
    'serialNumber',
    'model',
    'assetTag',
    'orgUnitPath',
    'status',
    'battery',
    'lastContact',
    'annotatedLocation',
    'annotatedUser',
    'notes',
  ]);
  assert.deepEqual(DEVICE_REPORT_FIELD_LABELS, {
    serialNumber: 'Serial',
    status: 'Status',
    model: 'Model',
    assetTag: 'Asset tag',
    annotatedUser: 'Annotated user',
    orgUnitPath: 'Organization unit',
    battery: 'Battery',
    lastContact: 'Device contact',
    annotatedLocation: 'Annotated location',
    notes: 'Notes',
  });
  for (const field of DEVICE_REPORT_FIELD_IDS)
    assert.equal(
      typeof DEVICE_REPORT_FIELD_LABELS[field],
      'string',
      `${field} has a label.`,
    );
});

test('a report cell holds the grid text and an ISO 8601 device contact', () => {
  assert.deepEqual(
    DEVICE_REPORT_FIELD_IDS.map((field) => deviceReportCellText(field, row)),
    [
      'C0A1-7F2D',
      'Chromebook 3100',
      'CB970992',
      '/Chrome Devices/Lowell Academy/Grade 9',
      'Disabled',
      'Replace soon',
      '2026-10-28T14:31:00.000Z',
      'Room 12',
      'jmorales14@example.org',
      '',
    ],
  );
  // An empty value is the empty cell, and a null status reads empty.
  const empty = {
    ...row,
    model: null,
    assetTag: null,
    annotatedUser: null,
    annotatedLocation: null,
    notes: null,
    status: null,
    lastContact: null,
  };
  assert.equal(deviceReportCellText('model', empty), '');
  assert.equal(deviceReportCellText('status', empty), '');
  assert.equal(deviceReportCellText('lastContact', empty), '');
  // Google's unknown status shows as Google sends it.
  assert.equal(
    deviceReportCellText('status', { ...row, status: 'PRE_PROVISIONED' }),
    'PRE_PROVISIONED',
  );
});

test('the battery and status labels serve the grid and the report', () => {
  assert.deepEqual(DEVICE_STATUS_LABELS, {
    ACTIVE: 'Active',
    DISABLED: 'Disabled',
    DEPROVISIONED: 'Deprovisioned',
  });
  assert.deepEqual(BATTERY_LABELS, {
    normal: 'Normal',
    'replace-soon': 'Replace soon',
    'replace-now': 'Replace now',
    'no-report': 'No battery report',
    unavailable: 'Unavailable',
  });
  assert.deepEqual(
    [
      {
        status: 'reported',
        health: 'normal',
        capacityPercent: 99,
        reportedAt: '2026-10-28T10:00:00.000Z',
      },
      {
        status: 'reported',
        health: 'replace-now',
        capacityPercent: 12,
        reportedAt: '2026-10-28T10:00:00.000Z',
      },
      { status: 'no-report' },
      { status: 'unavailable' },
    ].map(batteryText),
    ['Normal', 'Replace now', 'No battery report', 'Unavailable'],
  );
  assert.equal(statusText(null), '');
  assert.equal(statusText('ACTIVE'), 'Active');
  assert.equal(statusText('OTHER'), 'OTHER');
});

test('the export file name follows the scenario data of the notes', () => {
  assert.equal(
    deviceExportFileName('edit', 'EXP-001'),
    'devices-for-editing-EXP-001.csv',
  );
  assert.equal(
    deviceExportFileName('report', 'EXP-002'),
    'device-report-EXP-002.csv',
  );
});

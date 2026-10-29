import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEVICE_IMPORT_FAILED_OUTCOMES,
  DEVICE_IMPORT_NOT_RUN_REASONS,
  DEVICE_IMPORT_NOT_RUN_TEXTS,
  DEVICE_IMPORT_REASON_MAX_LENGTH,
  DEVICE_IMPORT_REFUSALS,
  DEVICE_IMPORT_REJECTIONS,
  DEVICE_IMPORT_REJECTION_TEXTS,
  DEVICE_IMPORT_REPORT_VIEWS,
  DEVICE_IMPORT_ROW_LIMIT,
  deviceImportChangeSchema,
  deviceImportCountsSchema,
  deviceImportExecuteAnswerSchema,
  deviceImportExecuteRequestSchema,
  deviceImportFieldLimitText,
  deviceImportNotRunSchema,
  deviceImportPermissionRejectionText,
  deviceImportPlanCancelAnswerSchema,
  deviceImportPlanCancelRequestSchema,
  deviceImportReceiptSchema,
  deviceImportRefusalSchema,
  deviceImportRefusalText,
  deviceImportRejectionSchema,
  deviceImportReportLineSchema,
  deviceImportReportQuerySchema,
  deviceImportReportSchema,
  deviceImportDuplicateTagWarning,
  deviceImportExportOnlyStatusWarning,
  deviceImportUnitRejectionText,
} from './device-import.ts';
import { jobOutcomeSchema } from './jobs.ts';
import {
  DEVICE_EDIT_TEMPLATE_COLUMNS,
  DEVICE_EDIT_UNKNOWN_HEADER_WARNING_MAX_LENGTH,
  matchDeviceEditHeaders,
} from './device-edit-template.ts';
import {
  CSV_ERROR_CODES,
  CSV_MAX_CELL_LENGTH,
  createCsvReader,
} from './csv.ts';

const at = '2026-10-28T14:31:00.000Z';
const jobId = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';

const plan = {
  planId: '1a2b3c4d-5e6f-7081-92a3-b4c5d6e7f809',
  revision: 4,
  state: 'open',
  expiresAt: at,
  changedBy: null,
  changedAt: null,
};

const fieldLine = {
  row: 3,
  deviceId: '04XTBHJ',
  serialNumber: 'C0A1-7F2D',
  change: {
    type: 'field',
    field: 'annotatedLocation',
    operation: 'replace',
    currentValue: 'Room 12',
    newValue: 'Room 14',
  },
  column: null,
  submittedValue: null,
  reason: null,
  notRun: null,
  jobDisplayId: null,
  operationNumber: null,
  outcome: null,
};

const statusLine = {
  ...fieldLine,
  row: 6,
  deviceId: '04QVJBY',
  change: {
    type: 'status',
    action: 'disable',
    reason: null,
    currentValue: 'ACTIVE',
    newValue: 'DISABLED',
  },
};

const rejectedLine = {
  ...fieldLine,
  row: 12,
  deviceId: null,
  serialNumber: null,
  change: null,
  column: 'Annotated user',
  submittedValue: 'x'.repeat(300),
  reason: 'Annotated user holds 1 to 100 characters.',
};

const warningLine = {
  ...fieldLine,
  row: null,
  deviceId: null,
  serialNumber: null,
  change: null,
  reason: 'The column "Room" is unknown. It stays out of every write.',
};

const failedLine = {
  ...fieldLine,
  row: 9,
  jobDisplayId: 'UPD-001',
  operationNumber: 4,
  outcome: 'failed',
};

const report = {
  jobId,
  displayId: 'IMP-001',
  view: 'proposed',
  page: 0,
  pageCount: 2,
  counts: {
    rows: 48,
    unchanged: 30,
    noChangeNeeded: 3,
    proposed: 11,
    rejected: 4,
  },
  refresh: { staleDevicesRead: 9, oldestObservedAt: at },
  changes: {
    fieldChanges: 8,
    fieldChangeDevices: 6,
    disable: 1,
    reenable: 1,
    deprovision: [{ reason: 'DEPROVISION_REASON_RETIRING_DEVICE', devices: 1 }],
  },
  lines: [fieldLine, statusLine],
  total: 11,
  plan,
};

test('the import receipt carries the job, the mode, and the file', () => {
  const receipt = {
    jobId,
    displayId: 'IMP-001',
    status: 'accepted',
    mode: 'sync-changes',
    name: 'devices-for-editing-EXP-001.csv',
    sizeBytes: 7987,
  };
  assert.deepEqual(deviceImportReceiptSchema.parse(receipt), receipt);
  assert.equal(
    deviceImportReceiptSchema.safeParse({ ...receipt, mode: 'sync' }).success,
    false,
  );
  assert.equal(
    deviceImportReceiptSchema.safeParse({ ...receipt, name: '' }).success,
    false,
  );
  assert.equal(
    deviceImportReceiptSchema.safeParse({ ...receipt, sizeBytes: -1 }).success,
    false,
  );
  assert.equal(
    deviceImportReceiptSchema.safeParse({ ...receipt, extra: true }).success,
    false,
  );
});

test('the report query takes one of the four views and a page', () => {
  assert.deepEqual(deviceImportReportQuerySchema.parse({}), {
    view: 'proposed',
    page: 0,
  });
  assert.deepEqual(
    deviceImportReportQuerySchema.parse({ view: 'failed', page: '2' }),
    {
      view: 'failed',
      page: 2,
    },
  );
  assert.deepEqual(DEVICE_IMPORT_REPORT_VIEWS, [
    'proposed',
    'rejected',
    'warnings',
    'failed',
  ]);
  assert.equal(
    deviceImportReportQuerySchema.safeParse({ view: 'unknown' }).success,
    false,
  );
  assert.equal(
    deviceImportReportQuerySchema.safeParse({ page: -1 }).success,
    false,
  );
});

test('the report answer holds the counts, the facts, ten lines at most, and the plan', () => {
  assert.deepEqual(deviceImportReportSchema.parse(report), report);
  // Every view answers its own lines, a warning on the header row included.
  const rejected = {
    ...report,
    view: 'rejected',
    lines: [rejectedLine],
    total: 4,
  };
  assert.equal(deviceImportReportSchema.safeParse(rejected).success, true);
  const warnings = {
    ...report,
    view: 'warnings',
    lines: [warningLine],
    total: 3,
  };
  assert.equal(deviceImportReportSchema.safeParse(warnings).success, true);
  const failed = { ...report, view: 'failed', lines: [failedLine], total: 1 };
  assert.equal(deviceImportReportSchema.safeParse(failed).success, true);
  // A page holds ten lines (ruling 2).
  assert.equal(
    deviceImportReportSchema.safeParse({
      ...report,
      lines: Array(11).fill(fieldLine),
    }).success,
    false,
  );
  assert.equal(
    deviceImportReportSchema.safeParse({
      ...report,
      lines: Array(10).fill(fieldLine),
    }).success,
    true,
  );
  assert.equal(
    deviceImportReportSchema.safeParse({ ...report, pageCount: 0 }).success,
    false,
  );
  // A report before the plan exists carries no plan.
  assert.equal(
    deviceImportReportSchema.safeParse({ ...report, plan: null }).success,
    true,
  );
});

test('the counts equal unchanged, no change needed, proposed, and rejected', () => {
  assert.equal(deviceImportCountsSchema.safeParse(report.counts).success, true);
  assert.equal(
    deviceImportCountsSchema.safeParse({ ...report.counts, rows: 49 }).success,
    false,
  );
  // Sync all rows counts no unchanged row.
  assert.equal(
    deviceImportCountsSchema.safeParse({
      rows: 30,
      unchanged: 0,
      noChangeNeeded: 15,
      proposed: 11,
      rejected: 4,
    }).success,
    true,
  );
});

test('a change is a field write or a status action with its reason', () => {
  assert.deepEqual(
    deviceImportChangeSchema.parse(fieldLine.change),
    fieldLine.change,
  );
  assert.deepEqual(
    deviceImportChangeSchema.parse(statusLine.change),
    statusLine.change,
  );
  const deprovision = {
    type: 'status',
    action: 'deprovision',
    reason: 'DEPROVISION_REASON_RETIRING_DEVICE',
    currentValue: 'ACTIVE',
    newValue: 'DEPROVISIONED',
  };
  assert.deepEqual(deviceImportChangeSchema.parse(deprovision), deprovision);
  // A Deprovision carries its reason, and another status change carries none.
  assert.equal(
    deviceImportChangeSchema.safeParse({ ...deprovision, reason: null })
      .success,
    false,
  );
  assert.equal(
    deviceImportChangeSchema.safeParse({
      ...statusLine.change,
      reason: 'DEPROVISION_REASON_RETIRING_DEVICE',
    }).success,
    false,
  );
  assert.equal(
    deviceImportChangeSchema.safeParse({
      ...fieldLine.change,
      operation: 'append',
    }).success,
    false,
  );
  assert.equal(
    deviceImportChangeSchema.safeParse({
      ...fieldLine.change,
      field: 'serialNumber',
    }).success,
    false,
    'Only the five writable fields change.',
  );
  // A clear carries no new value.
  assert.equal(
    deviceImportChangeSchema.safeParse({
      ...fieldLine.change,
      operation: 'clear',
      newValue: null,
    }).success,
    true,
  );
});

test('a report line names its row, its device, and its reason or change', () => {
  assert.deepEqual(
    deviceImportReportLineSchema.parse(rejectedLine),
    rejectedLine,
  );
  assert.deepEqual(
    deviceImportReportLineSchema.parse(warningLine),
    warningLine,
  );
  assert.deepEqual(deviceImportReportLineSchema.parse(failedLine), failedLine);
  assert.equal(
    deviceImportReportLineSchema.safeParse({
      ...failedLine,
      outcome: 'succeeded',
    }).success,
    true,
  );
  assert.equal(
    deviceImportReportLineSchema.safeParse({
      ...failedLine,
      outcome: 'dispatched',
    }).success,
    false,
  );
  assert.equal(
    deviceImportReportLineSchema.safeParse({ ...failedLine, row: null })
      .success,
    true,
    'The header row carries no row number.',
  );
  assert.equal(
    deviceImportReportLineSchema.safeParse({ ...failedLine, extra: true })
      .success,
    false,
  );
});

test('a not-run change names its reason and its text', () => {
  const notRun = {
    reason: 'changed-after-validation',
    text: DEVICE_IMPORT_NOT_RUN_TEXTS['changed-after-validation'],
  };
  assert.deepEqual(deviceImportNotRunSchema.parse(notRun), notRun);
  assert.deepEqual(DEVICE_IMPORT_NOT_RUN_REASONS, [
    'changed-after-validation',
    'no-change-needed',
    'removed',
    'status-unknown',
    'device-deprovisioned',
    'device-active',
    'device-disabled',
  ]);
  for (const reason of DEVICE_IMPORT_NOT_RUN_REASONS)
    assert.equal(
      deviceImportNotRunSchema.safeParse({
        reason,
        text: DEVICE_IMPORT_NOT_RUN_TEXTS[reason],
      }).success,
      true,
      `${reason} parses.`,
    );
  assert.equal(
    deviceImportNotRunSchema.safeParse({ ...notRun, reason: 'other' }).success,
    false,
  );
});

test('the plan cancel and the execute routes carry the plan and its revision', () => {
  const cancel = { planId: plan.planId, planRevision: 4 };
  assert.deepEqual(deviceImportPlanCancelRequestSchema.parse(cancel), cancel);
  assert.equal(
    deviceImportPlanCancelRequestSchema.safeParse({
      ...cancel,
      planRevision: 0,
    }).success,
    false,
  );
  assert.equal(
    deviceImportPlanCancelRequestSchema.safeParse({ planId: plan.planId })
      .success,
    false,
  );
  const cancelled = {
    plan: {
      ...plan,
      state: 'cancelled',
      changedBy: { id: jobId, displayName: 'Alex Rivera' },
      changedAt: at,
    },
  };
  assert.deepEqual(
    deviceImportPlanCancelAnswerSchema.parse(cancelled),
    cancelled,
  );

  const execute = {
    planId: plan.planId,
    planRevision: 4,
    typedPhrase: 'DEPROVISION',
  };
  assert.deepEqual(deviceImportExecuteRequestSchema.parse(execute), execute);
  // A plan without a Deprovision sends no phrase.
  assert.equal(
    deviceImportExecuteRequestSchema.safeParse({
      ...execute,
      typedPhrase: null,
    }).success,
    true,
  );
  assert.equal(
    deviceImportExecuteRequestSchema.safeParse({ ...execute, planRevision: 0 })
      .success,
    false,
  );
});

test('the execute answer holds the plan, its jobs, and the excluded changes', () => {
  const answer = {
    plan: {
      ...plan,
      state: 'executed',
      changedBy: { id: jobId, displayName: 'Alex Rivera' },
      changedAt: at,
    },
    receipts: [
      {
        jobId,
        displayId: 'UPD-001',
        action: 'update-device-annotations',
        status: 'accepted',
        deviceCount: 6,
      },
      {
        jobId: '2b3c4d5e-6f70-8192-a3b4-c5d6e7f80910',
        displayId: 'STS-001',
        action: 'disable-devices',
        status: 'accepted',
        deviceCount: 1,
      },
    ],
    conflicts: 1,
    excluded: 2,
  };
  assert.deepEqual(deviceImportExecuteAnswerSchema.parse(answer), answer);
  assert.equal(
    deviceImportExecuteAnswerSchema.safeParse({ ...answer, receipts: [] })
      .success,
    false,
    'Execute creates at least one job.',
  );
  assert.equal(
    deviceImportExecuteAnswerSchema.safeParse({
      ...answer,
      receipts: Array(8).fill(answer.receipts[0]),
    }).success,
    false,
    'One Execute creates seven jobs at most.',
  );
  assert.equal(
    deviceImportExecuteAnswerSchema.safeParse({
      ...answer,
      receipts: [{ ...answer.receipts[0], action: 'refresh-inventory' }],
    }).success,
    false,
  );
  assert.equal(
    deviceImportExecuteAnswerSchema.safeParse({ ...answer, conflictCount: 1 })
      .success,
    false,
  );
});

test('each refusal code answers the text of states 23 and 26', () => {
  assert.deepEqual(DEVICE_IMPORT_REFUSALS, [
    'unreadable-file',
    'ragged-record',
    'unterminated-quote',
    'malformed-quote',
    'cell-too-long',
    'too-many-rows',
    'header-refused',
  ]);
  for (const refusal of DEVICE_IMPORT_REFUSALS)
    assert.equal(deviceImportRefusalSchema.safeParse(refusal).success, true);
  assert.deepEqual(
    DEVICE_IMPORT_REFUSALS.map((refusal) =>
      deviceImportRefusalText(
        refusal,
        'The file is missing the Checksum column. Sync changes needs the Checksum column. Sync all rows ignores it.',
      ),
    ),
    [
      'The file is not UTF-8 text. Save it as UTF-8 CSV and import it again.',
      'A row holds a different number of columns. Correct the row and import the file again.',
      'The file ends inside a quoted cell. Correct the file and import it again.',
      'A cell holds a misplaced quote. Correct the file and import it again.',
      'A cell holds more than 16,384 characters.',
      'A file holds at most 50,000 rows.',
      'The file is missing the Checksum column. Sync changes needs the Checksum column. Sync all rows ignores it.',
    ],
  );
  // Every fault of the CSV reader answers an import refusal, so a worker never meets an
  // unmapped code.
  for (const code of CSV_ERROR_CODES) {
    assert.equal(
      DEVICE_IMPORT_REFUSALS.includes(code),
      true,
      `${code} has an import refusal.`,
    );
    assert.equal(typeof deviceImportRefusalText(code), 'string');
  }
  // A header refusal keeps the sentence of the template module, so the contract copies no text.
  const refused = matchDeviceEditHeaders(
    ['Device ID', 'Serial number', 'Model', 'Status', 'Asset tag'],
    'sync-changes',
  );
  assert.equal(refused.ok, false);
  if (refused.ok) throw new Error('The header must refuse.');
  assert.equal(
    deviceImportRefusalText('header-refused', refused.reason),
    refused.reason,
  );
  assert.match(refused.reason, /^The file is missing the /);
  assert.throws(
    () => deviceImportRefusalText('header-refused'),
    /matchDeviceEditHeaders/,
    'The contract invents no header sentence.',
  );
  assert.equal(DEVICE_IMPORT_ROW_LIMIT, 50000);
  assert.equal(deviceImportRefusalSchema.safeParse('disk-full').success, false);
});

test('each rejected row reason and each warning names the rule of the design', () => {
  for (const rejection of DEVICE_IMPORT_REJECTIONS) {
    assert.equal(
      deviceImportRejectionSchema.safeParse(rejection).success,
      true,
    );
    assert.equal(
      typeof DEVICE_IMPORT_REJECTION_TEXTS[rejection],
      'string',
      `${rejection} has a text.`,
    );
  }
  assert.equal(
    DEVICE_IMPORT_REJECTION_TEXTS['device-unknown'],
    'Campus Commander holds no device with this ID. Import never creates devices.',
  );
  assert.equal(
    DEVICE_IMPORT_REJECTION_TEXTS['current-values-unavailable'],
    'Current values unavailable.',
  );
  assert.equal(
    DEVICE_IMPORT_REJECTION_TEXTS['org-unit-unavailable'],
    'Organization unit check unavailable.',
  );
  assert.equal(
    deviceImportUnitRejectionText('/Libary'),
    'No organization unit has the path /Libary.',
  );
  assert.equal(
    deviceImportFieldLimitText('annotatedUser'),
    'Annotated user holds 1 to 100 characters.',
  );
  assert.equal(
    deviceImportFieldLimitText('notes'),
    'Notes holds 1 to 500 characters.',
  );
  assert.equal(
    deviceImportPermissionRejectionText('disable'),
    'You need the devices:status permission for this change. Ask your administrator for access.',
  );
  assert.equal(
    deviceImportPermissionRejectionText('deprovision'),
    'You need the devices:deprovision permission for this change. Ask your administrator for access.',
  );
  assert.equal(
    deviceImportDuplicateTagWarning('CB970992'),
    'Asset tag CB970992 is also on another device. The change still runs when you execute.',
  );
  assert.equal(
    deviceImportExportOnlyStatusWarning('PRE_PROVISIONED', 'ACTIVE'),
    'Status PRE_PROVISIONED is export-only and differs from the current status ACTIVE. It requests nothing.',
  );
});

test('the longest generated reason fits its report line', () => {
  // The unit rejection repeats an organization unit path at its accepted limit.
  const path = `/${'x'.repeat(4095)}`;
  const unitLine = {
    ...rejectedLine,
    column: 'Organization unit',
    submittedValue: path,
    reason: deviceImportUnitRejectionText(path),
  };
  assert.equal(unitLine.reason.length, 4131);
  assert.deepEqual(deviceImportReportLineSchema.parse(unitLine), unitLine);
  // The unknown-column warning repeats a header cell at the CSV cell limit.
  const header = 'x'.repeat(CSV_MAX_CELL_LENGTH);
  const reader = createCsvReader();
  const headers = [
    ...DEVICE_EDIT_TEMPLATE_COLUMNS.map((column) => column.header),
    header,
  ];
  const [headerRecord] = [
    ...reader.push(`${headers.join(',')}\r\n`),
    ...reader.end(),
  ];
  assert.equal(headerRecord.cells.at(-1).length, CSV_MAX_CELL_LENGTH);
  const matched = matchDeviceEditHeaders(headerRecord.cells);
  assert.equal(matched.ok, true);
  if (!matched.ok) throw new Error('The header must match.');
  const warning = matched.match.warnings[0];
  assert.equal(warning.length, DEVICE_EDIT_UNKNOWN_HEADER_WARNING_MAX_LENGTH);
  const warningAtLimit = { ...warningLine, row: 1, reason: warning };
  assert.deepEqual(
    deviceImportReportLineSchema.parse(warningAtLimit),
    warningAtLimit,
  );
  // The domain is the longest producer, and one character more is refused.
  assert.equal(DEVICE_IMPORT_REASON_MAX_LENGTH, warning.length);
  const atLimit = {
    ...rejectedLine,
    reason: 'x'.repeat(DEVICE_IMPORT_REASON_MAX_LENGTH),
  };
  assert.equal(deviceImportReportLineSchema.safeParse(atLimit).success, true);
  assert.equal(
    deviceImportReportLineSchema.safeParse({
      ...atLimit,
      reason: 'x'.repeat(DEVICE_IMPORT_REASON_MAX_LENGTH + 1),
    }).success,
    false,
  );
});

test('the Failed tab holds failed and unknown, never expired', () => {
  // The owner answered the proposal on Unknown with "Unknown yes" on 2026-10-28.
  assert.deepEqual(DEVICE_IMPORT_FAILED_OUTCOMES, ['failed', 'unknown']);
  for (const outcome of DEVICE_IMPORT_FAILED_OUTCOMES)
    assert.equal(
      jobOutcomeSchema.safeParse(outcome).success,
      true,
      `${outcome} is a job outcome.`,
    );
  // Expired stays out of the tab.
  assert.equal(DEVICE_IMPORT_FAILED_OUTCOMES.includes('expired'), false);
  assert.equal(DEVICE_IMPORT_FAILED_OUTCOMES.includes('cancelled'), false);
  assert.equal(DEVICE_IMPORT_FAILED_OUTCOMES.includes('succeeded'), false);
});

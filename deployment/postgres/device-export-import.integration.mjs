import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';

// The S1 checks of the export and import schema (design card XB2). Each check reports its own name and
// result. The module runs on the fresh database of `deployment/postgres/integration.mjs`, after the
// built job modules, and it creates every fixture it reads.
export async function qualifyDeviceExportImport({
  runtime,
  migrator,
  connect,
  close,
  issuer,
  password,
}) {
  const connection = (
    await migrator.query('SELECT * FROM cc.google_connection')
  ).rows[0];
  const customer = connection.customer_id;
  const generation = connection.generation;
  const results = [];
  const failures = [];
  const principals = [];
  const jobs = [];
  const statement = (text, values = []) =>
    runtime.query(text, values).then((r) => r.rows);
  const result = (text, values = []) =>
    runtime.query(text, values).then((r) => r.rows[0].result);
  const admin = (text, values = []) =>
    migrator.query(text, values).then((r) => r.rows);
  const rejects = async (promise, code, detail) => {
    try {
      await promise;
    } catch (error) {
      if (code && error.code !== code)
        throw new Error(
          `error ${error.code} instead of ${code}: ${error.message}`,
        );
      if (detail && error.detail !== detail)
        throw new Error(`detail ${error.detail} instead of ${detail}`);
      return error;
    }
    throw new Error(`expected a rejection ${code ?? ''} ${detail ?? ''}`);
  };
  const check = async (name, body) => {
    try {
      await body();
      results.push(`${name}: pass`);
    } catch (error) {
      failures.push(name);
      results.push(`${name}: FAIL ${error.message}`);
    }
    process.stderr.write(`check ${results.at(-1)}\n`);
  };
  const principal = async (grants = []) => {
    const id = randomUUID();
    principals.push(id);
    await migrator.query(
      'INSERT INTO cc.application_principals(id,issuer,subject,display_name) VALUES($1,$2,$3,$3)',
      [id, issuer, randomUUID()],
    );
    for (const [action, scope] of grants)
      await migrator.query(
        'INSERT INTO cc.application_grants(principal_id,action,scope) VALUES($1,$2,$3)',
        [id, action, JSON.stringify(scope)],
      );
    return id;
  };
  const district = (customerId = customer) => ({
    kind: 'district',
    customerId,
  });
  const exportGrants = () => [
    ['devices:read', district()],
    ['devices:bulk-actions', district()],
    ['devices:export', district()],
  ];
  const importGrants = () => [
    ['devices:read', district()],
    ['devices:write', district()],
    ['devices:bulk-actions', district()],
  ];
  /** The attempt that each claim of a job and lease answered (design section 6, step 1). */
  const importAttempts = new Map();
  const createExport = async ({
    actor,
    purpose = 'edit',
    format = 'csv',
    subject = null,
    columns = [],
    devices = ['D-1', 'D-2', 'D-3'],
    sort = { field: 'serialNumber', direction: 'asc' },
  }) =>
    result(
      'SELECT cc.create_device_export_job($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) AS result',
      [
        actor,
        1,
        customer,
        purpose,
        format,
        sort.field,
        sort.direction,
        columns,
        JSON.stringify(devices),
        randomUUID(),
        subject,
      ],
    );
  const createImport = async ({
    actor,
    mode = 'sync-changes',
    sourceType = 'csv',
    name = 'devices.csv',
    sizeBytes = 2048,
    permissions = ['disable'],
    artifactId = null,
    fileId = null,
    tabId = null,
    tabTitle = null,
    subject = null,
  }) =>
    result(
      'SELECT cc.create_device_import_job($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) AS result',
      [
        actor,
        1,
        customer,
        mode,
        sourceType,
        name,
        sizeBytes,
        permissions,
        randomUUID(),
        artifactId,
        fileId,
        tabId,
        tabTitle,
        subject,
      ],
    );
  const jobRow = (jobId) =>
    admin('SELECT * FROM cc.jobs WHERE job_id=$1', [jobId]).then((r) => r[0]);
  const cancelAs = (actor, displayId, version = 1, client = null) =>
    (client ?? runtime)
      .query('SELECT cc.request_job_cancel($1,$2,$3,$4,$5) AS result', [
        actor,
        version,
        customer,
        displayId,
        randomUUID(),
      ])
      .then((r) => r.rows[0].result);
  const claimExport = (jobId, lease, client = null) =>
    (client ?? runtime)
      .query('SELECT cc.claim_device_export_job($1,$2,$3) AS result', [
        customer,
        jobId,
        lease,
      ])
      .then((r) => r.rows[0].result);
  const claimImport = async (jobId, lease) => {
    const answer = await result(
      'SELECT cc.claim_device_import_job($1,$2,$3) AS result',
      [customer, jobId, lease],
    );
    // A claim starts an attempt. Every later call of that run carries it.
    if (answer.outcome === 'claimed')
      importAttempts.set(`${jobId}:${lease}`, answer.attempt);
    return answer;
  };
  /** The attempt that a claim answered, unless the caller names another one. */
  const importAttempt = (jobId, lease, attempt) =>
    attempt ?? importAttempts.get(`${jobId}:${lease}`) ?? 0;
  const renewExport = (jobId, lease, phase, done, total) =>
    result('SELECT cc.renew_device_export_job($1,$2,$3,$4,$5,$6) AS result', [
      customer,
      jobId,
      lease,
      phase,
      done,
      total,
    ]);
  const renewImport = (jobId, lease, phase, done, total, attempt = null) =>
    result(
      'SELECT cc.renew_device_import_job($1,$2,$3,$4,$5,$6,$7) AS result',
      [
        customer,
        jobId,
        lease,
        importAttempt(jobId, lease, attempt),
        phase,
        done,
        total,
      ],
    );
  const lineChange = (sourceRow, deviceId, extra = {}) => ({
    kind: 'change',
    sourceRow,
    deviceId,
    changeType: 'field',
    field: 'notes',
    mode: 'replace',
    currentValue: 'old',
    newValue: 'new',
    ...extra,
  });
  const storeLines = (jobId, lease, lines, attempt = null) =>
    result('SELECT cc.store_device_import_lines($1,$2,$3,$4,$5) AS result', [
      customer,
      jobId,
      lease,
      importAttempt(jobId, lease, attempt),
      JSON.stringify(lines),
    ]);
  const finishExport = (jobId, lease, file = null, failure = null) =>
    result('SELECT cc.finish_device_export_job($1,$2,$3,$4,$5) AS result', [
      customer,
      jobId,
      lease,
      file === null ? null : JSON.stringify(file),
      failure,
    ]);
  const finishImport = (
    jobId,
    lease,
    counts = null,
    failure = null,
    refusal = null,
    refusalText = null,
    attempt = null,
  ) =>
    result(
      'SELECT cc.finish_device_import_job($1,$2,$3,$4,$5,$6,$7,$8) AS result',
      [
        customer,
        jobId,
        lease,
        importAttempt(jobId, lease, attempt),
        counts === null ? null : JSON.stringify(counts),
        failure,
        refusal,
        refusalText,
      ],
    );
  const exportFile = (rows = 3, columns = 10) => ({
    artifactId: `artifact-${randomUUID()}`,
    name: 'devices-for-editing-EXP-001.csv',
    sizeBytes: 4096,
    rows,
    columns,
    expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
  });
  /** The file of a finished Sheet export (design section 6): an ID, a name, rows, and columns only. */
  const sheetFile = (rows = 3, columns = 10) => ({
    spreadsheetId: `example-sheet-${randomUUID()}`,
    name: 'devices-for-editing-EXP-001',
    rows,
    columns,
  });
  /** A 39-character Picker API key of the table rule. The value is a fixture, not a credential. */
  const pickerKey = (fill) =>
    `example-picker-key-${fill}`.padEnd(39, '0').slice(0, 39);
  const counts = (overrides = {}) => ({
    rows: 4,
    unchanged: 1,
    noChangeNeeded: 0,
    proposed: 1,
    rejected: 2,
    candidateRows: 3,
    staleDevicesRead: 2,
    oldestObservedAt: new Date(Date.now() - 3600 * 1000).toISOString(),
    ...overrides,
  });
  const leaseLive = (table, jobId) =>
    admin(
      `SELECT lease_expires_at>clock_timestamp()+interval '110 seconds' AND
        lease_expires_at<clock_timestamp()+interval '130 seconds' AS live
        FROM cc.${table} WHERE job_id=$1`,
      [jobId],
    ).then((r) => r[0].live);
  const expire = (table, jobId) =>
    migrator.query(
      `UPDATE cc.${table} SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE job_id=$1`,
      [jobId],
    );
  const attempt = async (jobId, text, values = []) => {
    jobs.push(jobId);
    return result(text, values);
  };
  /** The Sheet stamp of one export run (design section 6). */
  const startSheet = (jobId, lease, client = null) =>
    (client ?? runtime)
      .query('SELECT cc.start_device_export_sheet($1,$2,$3) AS result', [
        customer,
        jobId,
        lease,
      ])
      .then((r) => r.rows[0].result);
  /** The source link of one Drive read (design section 7). */
  const storeSource = (
    jobId,
    lease,
    attemptNumber,
    artifactId,
    sizeBytes,
    client = null,
  ) =>
    (client ?? runtime)
      .query(
        'SELECT cc.store_device_import_source($1,$2,$3,$4,$5,$6) AS result',
        [customer, jobId, lease, attemptNumber, artifactId, sizeBytes],
      )
      .then((r) => r.rows[0].result);
  /** The saved Drive settings, or null before the first save (design section 3). */
  const readSettings = (actor, client = null) =>
    (client ?? runtime)
      .query('SELECT cc.read_google_drive_settings($1,$2) AS result', [
        actor,
        1,
      ])
      .then((r) => r.rows[0].result);
  const saveSettings = (
    actor,
    key,
    project,
    client = null,
    correlation = randomUUID(),
  ) =>
    (client ?? runtime)
      .query('SELECT cc.save_google_drive_settings($1,$2,$3,$4,$5) AS result', [
        actor,
        1,
        key,
        project,
        correlation,
      ])
      .then((r) => r.rows[0].result);
  try {
    const exporter = await principal(exportGrants());
    const importer = await principal(importGrants());
    const outsider = await principal([['devices:read', district()]]);
    const reader = await principal([
      ['devices:read', district()],
      ['jobs:read', district()],
    ]);
    const foreignExporter = await principal([
      ['devices:read', district('C-other')],
      ['devices:bulk-actions', district('C-other')],
      ['devices:export', district('C-other')],
    ]);

    await check(
      'the export and import display IDs count from their own sequences',
      async () => {
        const first = await createExport({ actor: exporter, devices: ['D-1'] });
        const second = await createExport({
          actor: exporter,
          devices: ['D-1'],
        });
        jobs.push(first.receipt.jobId, second.receipt.jobId);
        assert.equal(first.outcome, 'created');
        assert.match(first.receipt.displayId, /^EXP-\d{3,}$/);
        assert.match(second.receipt.displayId, /^EXP-\d{3,}$/);
        assert.equal(
          Number(second.receipt.displayId.slice(4)),
          Number(first.receipt.displayId.slice(4)) + 1,
        );
        const imported = await createImport({ actor: importer });
        jobs.push(imported.receipt.jobId);
        assert.match(imported.receipt.displayId, /^IMP-\d{3,}$/);
        assert.equal(imported.receipt.status, 'accepted');
        assert.equal(imported.receipt.mode, 'sync-changes');
        assert.equal(imported.receipt.name, 'devices.csv');
        assert.equal(imported.receipt.sizeBytes, 2048);
        const rows = await admin(
          'SELECT kind,scope_kind,target_count,status FROM cc.jobs WHERE job_id=ANY($1::uuid[])',
          [[first.receipt.jobId, imported.receipt.jobId]],
        );
        assert.deepEqual(
          rows.map((row) => row.kind),
          ['device-export', 'device-import'],
        );
        assert.deepEqual(
          rows.map((row) => row.scope_kind),
          ['rows', 'rows'],
        );
        assert.deepEqual(
          rows.map((row) => row.status),
          ['running', 'running'],
        );
        assert.equal(rows[1].target_count, null);
      },
    );

    await check(
      'the kind, phase, and target checks refuse another value',
      async () => {
        const header = (overrides) => {
          const base = {
            displayId: `EXP-9${Math.floor(Math.random() * 90 + 10)}`,
            kind: 'device-export',
            scope: 'rows',
            status: 'running',
            targetCount: 1,
            phase: null,
            done: null,
            total: null,
            ...overrides,
          };
          return migrator.query(
            `INSERT INTO cc.jobs(job_id,display_id,customer_id,kind,scope_kind,status,requested_by,
              generation,target_count,phase,phase_done,phase_total,correlation_id)
            VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,gen_random_uuid())`,
            [
              base.displayId,
              customer,
              base.kind,
              base.scope,
              base.status,
              exporter,
              generation,
              base.targetCount,
              base.phase,
              base.done,
              base.total,
            ],
          );
        };
        await rejects(header({ kind: 'device-update' }), '23514');
        await rejects(header({ phase: 'compare', done: 1 }), '23514');
        await rejects(
          header({ kind: 'device-import', targetCount: 50001 }),
          '23514',
        );
        await rejects(header({ targetCount: 50001 }), '23514');
        await rejects(
          header({ kind: 'device-import', phase: 'write-rows', done: 1 }),
          '23514',
        );
        await rejects(header({ phase: 'write-rows', done: null }), '23514');
        await rejects(
          header({ phase: 'write-rows', done: 3, total: 2 }),
          '23514',
        );
        const counts = await admin(
          `SELECT count(*)::integer AS jobs FROM cc.jobs WHERE kind IN ('device-export','device-import')
            AND display_id LIKE 'EXP-9%'`,
        );
        assert.equal(counts[0].jobs, 0);
      },
    );

    await check(
      'the create functions refuse a caller without the three actions',
      async () => {
        assert.equal(
          (await createExport({ actor: outsider, devices: ['D-1'] })).outcome,
          'forbidden',
        );
        assert.equal(
          (await createExport({ actor: importer, devices: ['D-1'] })).outcome,
          'forbidden',
        );
        assert.equal(
          (await createExport({ actor: foreignExporter, devices: ['D-1'] }))
            .outcome,
          'forbidden',
        );
        assert.equal(
          (await createImport({ actor: exporter })).outcome,
          'forbidden',
        );
        assert.equal(
          (await createImport({ actor: outsider })).outcome,
          'forbidden',
        );
      },
    );

    await check(
      'an export job freezes its purpose, columns, sort, and target order',
      async () => {
        const created = await createExport({
          actor: exporter,
          purpose: 'report',
          columns: ['serialNumber', 'status', 'notes'],
          devices: ['D-3', 'D-1', 'D-2'],
          sort: { field: 'model', direction: 'desc' },
        });
        jobs.push(created.receipt.jobId);
        assert.equal(created.outcome, 'created');
        assert.deepEqual(created.receipt.rows, 3);
        const header = await jobRow(created.receipt.jobId);
        assert.equal(header.kind, 'device-export');
        assert.equal(header.status, 'running');
        assert.equal(header.target_count, 3);
        assert.equal(header.started_at, null);
        const detail = (
          await admin('SELECT * FROM cc.device_export_jobs WHERE job_id=$1', [
            created.receipt.jobId,
          ])
        )[0];
        assert.equal(detail.purpose, 'report');
        assert.equal(detail.format, 'csv');
        assert.deepEqual(detail.report_columns, [
          'serialNumber',
          'status',
          'notes',
        ]);
        assert.equal(detail.sort_field, 'model');
        assert.equal(detail.sort_direction, 'desc');
        assert.equal(detail.lease_id, null);
        assert.deepEqual(
          await admin(
            'SELECT ordinal,device_id FROM cc.device_export_targets WHERE job_id=$1 ORDER BY ordinal',
            [created.receipt.jobId],
          ),
          [
            { ordinal: 0, device_id: 'D-3' },
            { ordinal: 1, device_id: 'D-1' },
            { ordinal: 2, device_id: 'D-2' },
          ],
        );
        await rejects(
          createExport({ actor: exporter, purpose: 'report', columns: [] }),
          '22023',
        );
        await rejects(
          createExport({
            actor: exporter,
            devices: Array.from({ length: 50001 }, (_, i) => `D-${i}`),
          }),
          '22023',
        );
      },
    );

    await check(
      'a claim takes a two-minute lease and answers busy to a live second run',
      async () => {
        const created = await createExport({ actor: exporter });
        jobs.push(created.receipt.jobId);
        const leaseA = randomUUID();
        const leaseB = randomUUID();
        const first = await claimExport(created.receipt.jobId, leaseA);
        assert.equal(first.outcome, 'claimed');
        assert.equal(first.targetCount, 3);
        assert.equal(first.purpose, 'edit');
        assert.equal(first.format, 'csv');
        assert.deepEqual(first.sort, {
          field: 'serialNumber',
          direction: 'asc',
        });
        assert.equal(
          await leaseLive('device_export_jobs', created.receipt.jobId),
          true,
        );
        const second = await claimExport(created.receipt.jobId, leaseB);
        assert.equal(second.outcome, 'busy');
        const again = await claimExport(created.receipt.jobId, leaseA);
        assert.equal(again.outcome, 'claimed');
        const detail = (
          await admin('SELECT * FROM cc.device_export_jobs WHERE job_id=$1', [
            created.receipt.jobId,
          ])
        )[0];
        assert.equal(detail.lease_id, leaseA);
        assert.notEqual(detail.first_claimed_at, null);
        const header = await jobRow(created.receipt.jobId);
        assert.notEqual(header.started_at, null);
        const imported = await createImport({ actor: importer });
        jobs.push(imported.receipt.jobId);
        const claimed = await claimImport(imported.receipt.jobId, leaseA);
        assert.equal(claimed.outcome, 'claimed');
        assert.equal(claimed.mode, 'sync-changes');
        assert.equal(claimed.sourceName, 'devices.csv');
        assert.equal(claimed.sourceSizeBytes, 2048);
        assert.deepEqual(claimed.statusPermissions, ['disable']);
        assert.equal(
          (await claimImport(imported.receipt.jobId, randomUUID())).outcome,
          'busy',
        );
      },
    );

    await check(
      'a renewal writes the phase and its counts and refuses another phase',
      async () => {
        const created = await createExport({
          actor: exporter,
          devices: ['D-1', 'D-2', 'D-3', 'D-4', 'D-5'],
        });
        jobs.push(created.receipt.jobId);
        const lease = randomUUID();
        await claimExport(created.receipt.jobId, lease);
        const renewed = await renewExport(
          created.receipt.jobId,
          lease,
          'write-rows',
          3,
          5,
        );
        assert.equal(renewed.outcome, 'renewed');
        const header = await jobRow(created.receipt.jobId);
        assert.equal(header.phase, 'write-rows');
        assert.equal(header.phase_done, 3);
        assert.equal(header.phase_total, 5);
        assert.equal(
          await leaseLive('device_export_jobs', created.receipt.jobId),
          true,
        );
        await rejects(
          renewExport(created.receipt.jobId, lease, 'header-check', 1, null),
          '22023',
        );
        await rejects(
          renewExport(created.receipt.jobId, lease, 'write-rows', 6, 5),
          '22023',
        );
        const imported = await createImport({ actor: importer });
        jobs.push(imported.receipt.jobId);
        const importLease = randomUUID();
        await claimImport(imported.receipt.jobId, importLease);
        assert.equal(
          (
            await renewImport(
              imported.receipt.jobId,
              importLease,
              'header-check',
              7,
              null,
            )
          ).outcome,
          'renewed',
        );
        const importHeader = await jobRow(imported.receipt.jobId);
        assert.equal(importHeader.phase, 'header-check');
        assert.equal(importHeader.phase_done, 7);
        assert.equal(importHeader.phase_total, null);
        assert.equal(importHeader.target_count, 7);
        await rejects(
          renewImport(
            imported.receipt.jobId,
            importLease,
            'write-rows',
            1,
            null,
          ),
          '22023',
        );
      },
    );

    await check(
      'a report renewal takes line counts above the source-row cap',
      async () => {
        // One source row yields several report lines, so `report` counts lines, not rows (design
        // section 2). The reviewer reproduction: 10,000 source rows, 60,000 stored changes.
        const imported = await createImport({ actor: importer });
        jobs.push(imported.receipt.jobId);
        const lease = randomUUID();
        await claimImport(imported.receipt.jobId, lease);
        for (let batch = 0; batch < 60; batch += 1) {
          const lines = Array.from({ length: 1000 }, (_, index) => {
            const row = (batch * 1000 + index) % 10000;
            return lineChange(2 + row, `D-${row}`);
          });
          assert.equal(
            (await storeLines(imported.receipt.jobId, lease, lines)).changes,
            1000,
          );
        }
        assert.equal(
          (
            await admin(
              'SELECT count(*)::integer AS rows FROM cc.device_import_changes WHERE job_id=$1',
              [imported.receipt.jobId],
            )
          )[0].rows,
          60000,
        );
        assert.equal(
          (await renewImport(imported.receipt.jobId, lease, 'report', 0, 60000))
            .outcome,
          'renewed',
        );
        assert.equal(
          (
            await renewImport(
              imported.receipt.jobId,
              lease,
              'report',
              60000,
              60000,
            )
          ).outcome,
          'renewed',
        );
        const header = await jobRow(imported.receipt.jobId);
        assert.equal(header.phase, 'report');
        assert.equal(header.phase_done, 60000);
        assert.equal(header.phase_total, 60000);
        // The row phases keep the 50,000 source-row cap, and the report domain stays non-negative
        // with a total at or above the done count.
        await rejects(
          renewImport(imported.receipt.jobId, lease, 'compare', 0, 60000),
          '22023',
        );
        await rejects(
          renewImport(imported.receipt.jobId, lease, 'compare', 50001, 50001),
          '22023',
        );
        await rejects(
          renewImport(imported.receipt.jobId, lease, 'report', -1, 60000),
          '22023',
        );
        await rejects(
          renewImport(imported.receipt.jobId, lease, 'report', 2, 1),
          '22023',
        );
      },
    );

    await check(
      'a replacement import lease clears the partial report of the expired run',
      async () => {
        const imported = await createImport({ actor: importer });
        jobs.push(imported.receipt.jobId);
        const leaseA = randomUUID();
        const leaseB = randomUUID();
        const lines = () => [
          lineChange(2, 'D-1'),
          {
            kind: 'rejection',
            sourceRow: 3,
            deviceId: 'D-2',
            column: 'Status',
            submittedValue: 'nope',
            reason: 'The Status cell is invalid.',
          },
          {
            kind: 'warning',
            sourceRow: 4,
            deviceId: 'D-3',
            warning: 'Unknown column.',
          },
        ];
        const lineCounts = async () => {
          const counts = [];
          for (const table of [
            'device_import_changes',
            'device_import_rejections',
            'device_import_warnings',
          ])
            counts.push(
              (
                await admin(
                  `SELECT count(*)::integer AS rows FROM cc.${table} WHERE job_id=$1`,
                  [imported.receipt.jobId],
                )
              )[0].rows,
            );
          return counts;
        };
        await claimImport(imported.receipt.jobId, leaseA);
        assert.deepEqual(
          await storeLines(imported.receipt.jobId, leaseA, lines()),
          { outcome: 'stored', changes: 1, rejections: 1, warnings: 1 },
        );
        // A live lease refuses the second owner and keeps the report of the first.
        assert.equal(
          (await claimImport(imported.receipt.jobId, leaseB)).outcome,
          'busy',
        );
        assert.deepEqual(await lineCounts(), [1, 1, 1]);
        // A claim by the same owner starts a new attempt of the whole validation. The partial report of
        // the attempt before it goes, and that attempt can store nothing more, so a retried request
        // cannot duplicate the report (design section 6, step 1).
        await expire('device_import_jobs', imported.receipt.jobId);
        const replay = await claimImport(imported.receipt.jobId, leaseA);
        assert.equal(replay.outcome, 'claimed');
        assert.equal(replay.attempt, 2);
        assert.deepEqual(await lineCounts(), [0, 0, 0]);
        assert.equal(
          (
            await storeLines(
              imported.receipt.jobId,
              leaseA,
              lines(),
              replay.attempt - 1,
            )
          ).outcome,
          'fenced',
        );
        assert.deepEqual(await lineCounts(), [0, 0, 0]);
        // A new owner restarts the whole validation, so the replaced output cannot double the report.
        await expire('device_import_jobs', imported.receipt.jobId);
        assert.equal(
          (await claimImport(imported.receipt.jobId, leaseB)).outcome,
          'claimed',
        );
        assert.deepEqual(await lineCounts(), [0, 0, 0]);
        // The replaced owner is fenced and stores nothing.
        assert.equal(
          (await storeLines(imported.receipt.jobId, leaseA, lines())).outcome,
          'fenced',
        );
        assert.deepEqual(await lineCounts(), [0, 0, 0]);
        // The new owner stores its report once, and the finish publishes those counts.
        assert.equal(
          (await storeLines(imported.receipt.jobId, leaseB, lines())).changes,
          1,
        );
        const finished = await finishImport(
          imported.receipt.jobId,
          leaseB,
          counts({
            rows: 2,
            unchanged: 0,
            noChangeNeeded: 0,
            proposed: 1,
            rejected: 1,
          }),
        );
        assert.equal(finished.outcome, 'finished');
        assert.equal(finished.status, 'completed');
        assert.equal(finished.plan.state, 'open');
        assert.deepEqual(await lineCounts(), [1, 1, 1]);
        assert.deepEqual(
          await admin(
            'SELECT ordinal FROM cc.device_import_changes WHERE job_id=$1 ORDER BY ordinal',
            [imported.receipt.jobId],
          ),
          [{ ordinal: 0 }],
        );
      },
    );

    await check(
      'a renewal fences a replaced lease and a lapsed lease',
      async () => {
        const created = await createExport({ actor: exporter });
        jobs.push(created.receipt.jobId);
        const leaseA = randomUUID();
        const leaseB = randomUUID();
        await claimExport(created.receipt.jobId, leaseA);
        await expire('device_export_jobs', created.receipt.jobId);
        assert.equal(
          (await claimExport(created.receipt.jobId, leaseB)).outcome,
          'claimed',
        );
        assert.equal(
          (await renewExport(created.receipt.jobId, leaseA, 'write-rows', 1, 3))
            .outcome,
          'fenced',
        );
        assert.equal(
          (await renewExport(created.receipt.jobId, leaseB, 'write-rows', 1, 3))
            .outcome,
          'renewed',
        );
        await expire('device_export_jobs', created.receipt.jobId);
        assert.equal(
          (await renewExport(created.receipt.jobId, leaseB, 'write-rows', 2, 3))
            .outcome,
          'fenced',
        );
        const header = await jobRow(created.receipt.jobId);
        assert.equal(header.phase_done, 1);
      },
    );

    await check('a lapsed lease stores no line', async () => {
      const imported = await createImport({ actor: importer });
      jobs.push(imported.receipt.jobId);
      const lease = randomUUID();
      await claimImport(imported.receipt.jobId, lease);
      await expire('device_import_jobs', imported.receipt.jobId);
      const fenced = await storeLines(imported.receipt.jobId, lease, [
        lineChange(2, 'D-1'),
        {
          kind: 'rejection',
          sourceRow: 3,
          deviceId: 'D-2',
          column: 'Status',
          submittedValue: 'nope',
          reason: 'The Status cell is invalid.',
        },
        {
          kind: 'warning',
          sourceRow: 4,
          deviceId: 'D-3',
          warning: 'Unknown column.',
        },
      ]);
      assert.equal(fenced.outcome, 'fenced');
      assert.equal(fenced.changes, 0);
      for (const table of [
        'device_import_changes',
        'device_import_rejections',
        'device_import_warnings',
      ])
        assert.equal(
          (
            await admin(
              `SELECT count(*)::integer AS rows FROM cc.${table} WHERE job_id=$1`,
              [imported.receipt.jobId],
            )
          )[0].rows,
          0,
          `${table} must stay empty`,
        );
      // The same call under the live lease stores every line, in order.
      assert.equal(
        (await claimImport(imported.receipt.jobId, lease)).outcome,
        'claimed',
      );
      const stored = await storeLines(imported.receipt.jobId, lease, [
        lineChange(2, 'D-1'),
        lineChange(2, 'D-1', {
          changeType: 'status',
          action: 'disable',
          field: null,
          mode: null,
        }),
        {
          kind: 'rejection',
          sourceRow: 3,
          deviceId: 'D-2',
          column: 'Status',
          submittedValue: 'nope',
          reason: 'The Status cell is invalid.',
          templateCells: Array.from({ length: 10 }, (_, i) => `cell-${i}`),
        },
        {
          kind: 'warning',
          sourceRow: 4,
          deviceId: 'D-3',
          warning: 'Unknown column.',
        },
      ]);
      assert.deepEqual(stored, {
        outcome: 'stored',
        changes: 2,
        rejections: 1,
        warnings: 1,
      });
      const second = await storeLines(imported.receipt.jobId, lease, [
        lineChange(5, 'D-4'),
      ]);
      assert.equal(second.changes, 1);
      assert.deepEqual(
        await admin(
          `SELECT ordinal,source_row,device_id,change_type,field,mode,status_action,current_value,new_value
              FROM cc.device_import_changes WHERE job_id=$1 ORDER BY ordinal`,
          [imported.receipt.jobId],
        ),
        [
          {
            ordinal: 0,
            source_row: 2,
            device_id: 'D-1',
            change_type: 'field',
            field: 'notes',
            mode: 'replace',
            status_action: null,
            current_value: 'old',
            new_value: 'new',
          },
          {
            ordinal: 1,
            source_row: 2,
            device_id: 'D-1',
            change_type: 'status',
            field: null,
            mode: null,
            status_action: 'disable',
            current_value: 'old',
            new_value: 'new',
          },
          {
            ordinal: 2,
            source_row: 5,
            device_id: 'D-4',
            change_type: 'field',
            field: 'notes',
            mode: 'replace',
            status_action: null,
            current_value: 'old',
            new_value: 'new',
          },
        ],
      );
      const rejection = (
        await admin(
          'SELECT * FROM cc.device_import_rejections WHERE job_id=$1',
          [imported.receipt.jobId],
        )
      )[0];
      assert.equal(rejection.source_row, 3);
      assert.equal(rejection.ordinal, 0);
      assert.deepEqual(rejection.template_cells.slice(0, 2), [
        'cell-0',
        'cell-1',
      ]);
      assert.equal(rejection.template_cells.length, 10);
      await rejects(
        storeLines(
          imported.receipt.jobId,
          lease,
          Array.from({ length: 1001 }, (_, i) => ({
            kind: 'warning',
            sourceRow: 2,
            deviceId: 'D-1',
            warning: `w${i}`,
          })),
        ),
        '22023',
      );
      await rejects(
        storeLines(imported.receipt.jobId, lease, [{ kind: 'change' }]),
        '22023',
      );
    });

    await check('a store call refuses more than 32 MiB of JSON', async () => {
      const imported = await createImport({ actor: importer });
      jobs.push(imported.receipt.jobId);
      const lease = randomUUID();
      await claimImport(imported.receipt.jobId, lease);
      const cell = 'x'.repeat(16384);
      const lines = Array.from({ length: 250 }, (_, i) => ({
        kind: 'rejection',
        sourceRow: i + 2,
        deviceId: `D-${i}`,
        column: 'Notes',
        submittedValue: 'value',
        reason: 'The Notes cell is invalid.',
        templateCells: Array.from({ length: 10 }, () => cell),
      }));
      assert.ok(JSON.stringify(lines).length > 33554432);
      await rejects(storeLines(imported.receipt.jobId, lease, lines), '22023');
      assert.equal(
        (
          await admin(
            'SELECT count(*)::integer AS rows FROM cc.device_import_rejections WHERE job_id=$1',
            [imported.receipt.jobId],
          )
        )[0].rows,
        0,
      );
    });

    await check(
      'the client batch limit covers the stored size of maximum cells',
      async () => {
        const imported = await createImport({ actor: importer });
        jobs.push(imported.receipt.jobId);
        const lease = randomUUID();
        await claimImport(imported.receipt.jobId, lease);
        // The rule of the handler: a line counts its JSON bytes plus 256 bytes of jsonb overhead,
        // and a call keeps 4 KiB for the array framing. The largest legal row holds ten cells of
        // 16,384 supplementary characters, and it still fits one call (design section 6, step 19).
        const cell = '\u{1f600}'.repeat(16384);
        const line = {
          kind: 'rejection',
          sourceRow: 2,
          deviceId: 'D-1',
          column: 'Notes',
          submittedValue: 'value',
          reason: 'The Notes cell is invalid.',
          templateCells: Array.from({ length: 10 }, () => cell),
        };
        const storedLineBytes = (entry) =>
          Buffer.byteLength(JSON.stringify(entry), 'utf8') + 256;
        const limit = 33554432;
        const batch = [];
        let estimate = 4096;
        while (
          batch.length < 1000 &&
          estimate + storedLineBytes(line) <= limit
        ) {
          batch.push({ ...line, sourceRow: batch.length + 2 });
          estimate += storedLineBytes(line);
        }
        assert.ok(batch.length > 1);
        // The client estimate is never smaller than the size that SQL stores, so the handler never
        // builds a call that the guard refuses.
        const actual = (
          await admin('SELECT pg_column_size($1::jsonb) AS size', [
            JSON.stringify(batch),
          ])
        )[0].size;
        assert.ok(actual <= limit, `The stored size is ${actual} bytes.`);
        assert.ok(
          actual <= estimate,
          `The stored size ${actual} is above the estimate ${estimate}.`,
        );
        const stored = await storeLines(imported.receipt.jobId, lease, batch);
        assert.equal(stored.outcome, 'stored');
        assert.equal(stored.rejections, batch.length);
      },
    );

    await check(
      'a claim attempt owns the report, and a replay replaces it',
      async () => {
        const imported = await createImport({ actor: importer });
        jobs.push(imported.receipt.jobId);
        const lease = randomUUID();
        const first = await claimImport(imported.receipt.jobId, lease);
        assert.equal(first.outcome, 'claimed');
        const lines = [
          lineChange(2, 'D-1'),
          {
            kind: 'rejection',
            sourceRow: 3,
            deviceId: 'D-2',
            column: 'Notes',
            submittedValue: 'value',
            reason: 'The Notes cell is invalid.',
            templateCells: Array.from({ length: 10 }, () => 'cell'),
          },
          {
            kind: 'warning',
            sourceRow: 2,
            deviceId: 'D-1',
            warning: 'The Notes cell is malformed.',
          },
          {
            kind: 'warning',
            sourceRow: 3,
            deviceId: 'D-2',
            warning: 'The Notes cell is malformed.',
          },
        ];
        assert.equal(
          (
            await storeLines(
              imported.receipt.jobId,
              lease,
              lines,
              first.attempt,
            )
          ).outcome,
          'stored',
        );
        // The worker dies before either finish call reaches SQL, and the flow retries the same
        // request with the same lease (design section 6, step 1).
        const replay = await claimImport(imported.receipt.jobId, lease);
        assert.equal(replay.outcome, 'claimed');
        assert.equal(replay.attempt, first.attempt + 1);
        // The attempt that the replay replaced appends nothing and finishes nothing.
        assert.equal(
          (
            await storeLines(
              imported.receipt.jobId,
              lease,
              [lineChange(9, 'D-9')],
              first.attempt,
            )
          ).outcome,
          'fenced',
        );
        assert.equal(
          (
            await finishImport(
              imported.receipt.jobId,
              lease,
              counts(),
              null,
              null,
              null,
              first.attempt,
            )
          ).outcome,
          'fenced',
        );
        // The replay stores one report and opens one plan.
        assert.equal(
          (
            await storeLines(
              imported.receipt.jobId,
              lease,
              lines,
              replay.attempt,
            )
          ).outcome,
          'stored',
        );
        const finished = await finishImport(
          imported.receipt.jobId,
          lease,
          counts(),
          null,
          null,
          null,
          replay.attempt,
        );
        assert.equal(finished.outcome, 'finished');
        assert.equal(finished.status, 'completed');
        assert.equal(finished.plan.state, 'open');
        const stored = (
          await admin(
            `SELECT (SELECT count(*) FROM cc.device_import_changes WHERE job_id=$1)::integer AS changes,
              (SELECT count(*) FROM cc.device_import_rejections WHERE job_id=$1)::integer AS rejections,
              (SELECT count(*) FROM cc.device_import_warnings WHERE job_id=$1)::integer AS warnings`,
            [imported.receipt.jobId],
          )
        )[0];
        assert.deepEqual(stored, { changes: 1, rejections: 1, warnings: 2 });
        assert.equal(
          (
            await admin(
              'SELECT count(*)::integer AS rows FROM cc.device_import_jobs WHERE job_id=$1 AND plan_id IS NOT NULL',
              [imported.receipt.jobId],
            )
          )[0].rows,
          1,
        );
      },
    );

    await check(
      'a second claim of one live lease takes the attempt, not the report',
      async () => {
        const imported = await createImport({ actor: importer });
        jobs.push(imported.receipt.jobId);
        const lease = randomUUID();
        const first = await claimImport(imported.receipt.jobId, lease);
        assert.equal(first.outcome, 'claimed');
        await storeLines(
          imported.receipt.jobId,
          lease,
          [lineChange(2, 'D-1')],
          first.attempt,
        );
        const rowsOf = async () =>
          (
            await admin(
              'SELECT count(*)::integer AS rows FROM cc.device_import_changes WHERE job_id=$1',
              [imported.receipt.jobId],
            )
          )[0].rows;
        assert.equal(await rowsOf(), 1);
        // A second claim of the same live lease answers claimed, and the claim that replaces the
        // attempt owns the report.
        const second = await claimImport(imported.receipt.jobId, lease);
        assert.equal(second.outcome, 'claimed');
        assert.equal(second.attempt, first.attempt + 1);
        assert.equal(await rowsOf(), 0);
        assert.equal(
          (
            await renewImport(
              imported.receipt.jobId,
              lease,
              'compare',
              1,
              1,
              first.attempt,
            )
          ).outcome,
          'fenced',
        );
        assert.equal(
          (
            await storeLines(
              imported.receipt.jobId,
              lease,
              [lineChange(2, 'D-1')],
              first.attempt,
            )
          ).outcome,
          'fenced',
        );
        assert.equal(
          (
            await storeLines(
              imported.receipt.jobId,
              lease,
              [lineChange(2, 'D-1')],
              second.attempt,
            )
          ).outcome,
          'stored',
        );
        assert.equal(await rowsOf(), 1);
      },
    );

    await check(
      'an export finish publishes the file and ends completed once',
      async () => {
        const created = await createExport({ actor: exporter });
        jobs.push(created.receipt.jobId);
        const lease = randomUUID();
        await claimExport(created.receipt.jobId, lease);
        await renewExport(created.receipt.jobId, lease, 'write-rows', 3, 3);
        const finished = await finishExport(
          created.receipt.jobId,
          lease,
          exportFile(3, 10),
        );
        assert.equal(finished.outcome, 'finished');
        assert.equal(finished.status, 'completed');
        assert.equal(finished.file.rows, 3);
        const header = await jobRow(created.receipt.jobId);
        assert.equal(header.status, 'completed');
        assert.equal(header.succeeded, 3);
        assert.equal(header.phase, 'prepare-download');
        assert.notEqual(header.finished_at, null);
        const detail = (
          await admin('SELECT * FROM cc.device_export_jobs WHERE job_id=$1', [
            created.receipt.jobId,
          ])
        )[0];
        assert.equal(detail.file_row_count, 3);
        assert.equal(detail.file_column_count, 10);
        assert.equal(Number(detail.file_size_bytes), 4096);
        assert.notEqual(detail.file_expires_at, null);
        // A repeat answers the stored status and writes nothing.
        const revision = header.revision;
        const repeat = await finishExport(
          created.receipt.jobId,
          lease,
          exportFile(3, 10),
        );
        assert.deepEqual(repeat, { outcome: 'finished', status: 'completed' });
        assert.equal((await jobRow(created.receipt.jobId)).revision, revision);
        // A fenced finish writes nothing, and an unknown failure code rejects.
        const other = await createExport({ actor: exporter });
        jobs.push(other.receipt.jobId);
        await claimExport(other.receipt.jobId, randomUUID());
        assert.equal(
          (await finishExport(other.receipt.jobId, randomUUID(), exportFile()))
            .outcome,
          'fenced',
        );
        await rejects(
          finishExport(other.receipt.jobId, randomUUID(), null, 'made-up'),
          '22023',
        );
      },
    );

    await check(
      'an export finish records a known failure as failed',
      async () => {
        const created = await createExport({ actor: exporter });
        jobs.push(created.receipt.jobId);
        const lease = randomUUID();
        await claimExport(created.receipt.jobId, lease);
        const finished = await finishExport(
          created.receipt.jobId,
          lease,
          null,
          'export-too-large',
        );
        assert.deepEqual(finished, { outcome: 'finished', status: 'failed' });
        const header = await jobRow(created.receipt.jobId);
        assert.equal(header.status, 'failed');
        assert.equal(header.failure, 'export-too-large');
        assert.notEqual(header.finished_at, null);
      },
    );

    await check(
      'an import finish stores the counts and creates a one-hour plan',
      async () => {
        const imported = await createImport({
          actor: importer,
          permissions: ['disable', 'reenable'],
        });
        jobs.push(imported.receipt.jobId);
        const lease = randomUUID();
        await claimImport(imported.receipt.jobId, lease);
        await renewImport(imported.receipt.jobId, lease, 'report', 4, 4);
        const finished = await finishImport(
          imported.receipt.jobId,
          lease,
          counts({
            rows: 4,
            unchanged: 1,
            noChangeNeeded: 0,
            proposed: 1,
            rejected: 2,
          }),
        );
        assert.equal(finished.outcome, 'finished');
        assert.equal(finished.status, 'completed');
        assert.equal(finished.plan.state, 'open');
        assert.equal(finished.plan.revision, 1);
        assert.match(finished.plan.planId, /^[0-9a-f-]{36}$/);
        const expires = await admin(
          `SELECT plan_expires_at>clock_timestamp()+interval '59 minutes' AND
            plan_expires_at<clock_timestamp()+interval '61 minutes' AS live
            FROM cc.device_import_jobs WHERE job_id=$1`,
          [imported.receipt.jobId],
        );
        assert.equal(expires[0].live, true);
        const detail = (
          await admin('SELECT * FROM cc.device_import_jobs WHERE job_id=$1', [
            imported.receipt.jobId,
          ])
        )[0];
        assert.equal(detail.rows_read, 4);
        assert.equal(detail.candidate_rows, 3);
        assert.equal(detail.proposed, 1);
        assert.equal(detail.rejected, 2);
        assert.equal(detail.stale_devices_read, 2);
        assert.notEqual(detail.oldest_observed_at, null);
        const header = await jobRow(imported.receipt.jobId);
        assert.equal(header.status, 'completed');
        assert.equal(header.target_count, 4);
        assert.equal(header.finished_at === null, false);
        // A plan with no proposed change leaves the plan columns null, and rejected rows make the job
        // Completed with errors.
        const rejectedOnly = await createImport({ actor: importer });
        jobs.push(rejectedOnly.receipt.jobId);
        const otherLease = randomUUID();
        await claimImport(rejectedOnly.receipt.jobId, otherLease);
        const ended = await finishImport(
          rejectedOnly.receipt.jobId,
          otherLease,
          counts({
            rows: 2,
            unchanged: 0,
            noChangeNeeded: 0,
            proposed: 0,
            rejected: 2,
          }),
        );
        assert.equal(ended.status, 'completed-with-errors');
        assert.equal(ended.plan, null);
        const plan = await admin(
          'SELECT plan_id,plan_state,plan_expires_at FROM cc.device_import_jobs WHERE job_id=$1',
          [rejectedOnly.receipt.jobId],
        );
        assert.deepEqual(plan[0], {
          plan_id: null,
          plan_state: null,
          plan_expires_at: null,
        });
        // A counts document whose parts do not sum to its rows rejects.
        const broken = await createImport({ actor: importer });
        jobs.push(broken.receipt.jobId);
        const brokenLease = randomUUID();
        await claimImport(broken.receipt.jobId, brokenLease);
        await rejects(
          finishImport(broken.receipt.jobId, brokenLease, counts({ rows: 5 })),
          '22023',
        );
        // The counts land only through a finish under a live lease.
        assert.equal(
          (await finishImport(broken.receipt.jobId, randomUUID(), counts()))
            .outcome,
          'fenced',
        );
      },
    );

    await check(
      'an import finish records a refusal and keeps no report or plan',
      async () => {
        const imported = await createImport({ actor: importer });
        jobs.push(imported.receipt.jobId);
        const lease = randomUUID();
        await claimImport(imported.receipt.jobId, lease);
        await renewImport(
          imported.receipt.jobId,
          lease,
          'header-check',
          3,
          null,
        );
        await storeLines(imported.receipt.jobId, lease, [
          lineChange(2, 'D-1'),
          {
            kind: 'warning',
            sourceRow: null,
            deviceId: null,
            warning: 'Unknown column.',
          },
        ]);
        const finished = await finishImport(
          imported.receipt.jobId,
          lease,
          null,
          'storage-unavailable',
          'header-refused',
          'The file holds no Device ID column.',
        );
        assert.deepEqual(finished, { outcome: 'finished', status: 'failed' });
        const detail = (
          await admin('SELECT * FROM cc.device_import_jobs WHERE job_id=$1', [
            imported.receipt.jobId,
          ])
        )[0];
        assert.equal(detail.refusal, 'header-refused');
        assert.equal(
          detail.refusal_text,
          'The file holds no Device ID column.',
        );
        assert.equal(detail.plan_id, null);
        const header = await jobRow(imported.receipt.jobId);
        assert.equal(header.status, 'failed');
        assert.equal(header.failure, 'storage-unavailable');
        for (const table of [
          'device_import_changes',
          'device_import_rejections',
          'device_import_warnings',
        ])
          assert.equal(
            (
              await admin(
                `SELECT count(*)::integer AS rows FROM cc.${table} WHERE job_id=$1`,
                [imported.receipt.jobId],
              )
            )[0].rows,
            0,
            `${table} must stay empty`,
          );
      },
    );

    await check(
      'a cancel before the first claim ends an export job at once',
      async () => {
        const created = await createExport({ actor: exporter });
        jobs.push(created.receipt.jobId);
        const revision = (await jobRow(created.receipt.jobId)).revision;
        const cancelled = await cancelAs(exporter, created.receipt.displayId);
        assert.equal(cancelled.outcome, 'requested');
        const header = await jobRow(created.receipt.jobId);
        assert.equal(header.status, 'cancelled');
        assert.notEqual(header.finished_at, null);
        assert.notEqual(header.cancel_requested_at, null);
        assert.equal(header.cancel_requested_by, exporter);
        assert.equal(header.cancelled, 3);
        assert.ok(header.revision > revision);
        assert.equal(
          (
            await admin(
              `SELECT count(*)::integer AS rows FROM cc.security_events
                WHERE event='job-cancel-requested' AND detail=$1`,
              [created.receipt.displayId],
            )
          )[0].rows,
          1,
        );
        // The request repeats, the claim answers done, and the finish answers the stored status.
        assert.deepEqual(await cancelAs(exporter, created.receipt.displayId), {
          outcome: 'repeated',
        });
        assert.deepEqual(
          await claimExport(created.receipt.jobId, randomUUID()),
          { outcome: 'done' },
        );
        assert.deepEqual(
          await finishExport(created.receipt.jobId, randomUUID(), exportFile()),
          { outcome: 'finished', status: 'cancelled' },
        );
      },
    );

    await check(
      'a cancel before the first claim ends an import job at once',
      async () => {
        const imported = await createImport({ actor: importer });
        jobs.push(imported.receipt.jobId);
        const cancelled = await cancelAs(importer, imported.receipt.displayId);
        assert.equal(cancelled.outcome, 'requested');
        const header = await jobRow(imported.receipt.jobId);
        assert.equal(header.status, 'cancelled');
        assert.notEqual(header.finished_at, null);
        assert.equal(header.cancelled, 1);
        assert.equal(
          (await claimImport(imported.receipt.jobId, randomUUID())).outcome,
          'done',
        );
        const again = await cancelAs(importer, imported.receipt.displayId);
        assert.deepEqual(again, { outcome: 'repeated' });
        const finished = await finishImport(
          imported.receipt.jobId,
          randomUUID(),
          counts(),
        );
        assert.deepEqual(finished, {
          outcome: 'finished',
          status: 'cancelled',
        });
        // A header that holds a request answers `repeated`. One that finished without a request refuses.
        assert.deepEqual(await cancelAs(importer, imported.receipt.displayId), {
          outcome: 'repeated',
        });
        const completed = await createImport({ actor: importer });
        jobs.push(completed.receipt.jobId);
        const completedLease = randomUUID();
        await claimImport(completed.receipt.jobId, completedLease);
        await finishImport(
          completed.receipt.jobId,
          completedLease,
          counts({
            rows: 1,
            unchanged: 1,
            noChangeNeeded: 0,
            proposed: 0,
            rejected: 0,
            candidateRows: 1,
            staleDevicesRead: 0,
          }),
        );
        await rejects(
          cancelAs(importer, completed.receipt.displayId),
          null,
          'job-finished',
        );
      },
    );

    await check(
      'a cancel after the first claim keeps the run until its finish ends it cancelled',
      async () => {
        const imported = await createImport({ actor: importer });
        jobs.push(imported.receipt.jobId);
        const lease = randomUUID();
        await claimImport(imported.receipt.jobId, lease);
        await storeLines(imported.receipt.jobId, lease, [lineChange(2, 'D-1')]);
        const cancelled = await cancelAs(importer, imported.receipt.displayId);
        assert.equal(cancelled.outcome, 'requested');
        let header = await jobRow(imported.receipt.jobId);
        assert.equal(header.status, 'running');
        assert.notEqual(header.cancel_requested_at, null);
        assert.equal(
          (
            await admin(
              'SELECT count(*)::integer AS rows FROM cc.device_import_changes WHERE job_id=$1',
              [imported.receipt.jobId],
            )
          )[0].rows,
          1,
        );
        assert.equal(
          (await claimImport(imported.receipt.jobId, lease)).outcome,
          'done',
        );
        assert.equal(
          (
            await storeLines(imported.receipt.jobId, lease, [
              lineChange(3, 'D-2'),
            ])
          ).outcome,
          'done',
        );
        const finished = await finishImport(
          imported.receipt.jobId,
          lease,
          counts(),
        );
        assert.deepEqual(finished, {
          outcome: 'finished',
          status: 'cancelled',
        });
        header = await jobRow(imported.receipt.jobId);
        assert.equal(header.status, 'cancelled');
        assert.ok(header.cancelled >= 1);
        assert.notEqual(header.finished_at, null);
        const detail = (
          await admin('SELECT * FROM cc.device_import_jobs WHERE job_id=$1', [
            imported.receipt.jobId,
          ])
        )[0];
        assert.equal(detail.rows_read, 0);
        assert.equal(detail.proposed, 0);
        assert.equal(detail.plan_id, null);
        assert.equal(
          (
            await admin(
              'SELECT count(*)::integer AS rows FROM cc.device_import_changes WHERE job_id=$1',
              [imported.receipt.jobId],
            )
          )[0].rows,
          0,
        );
      },
    );

    await check(
      'a cancel by another person is refused or ends a finished job as finished',
      async () => {
        const created = await createExport({ actor: exporter });
        jobs.push(created.receipt.jobId);
        await rejects(
          cancelAs(reader, created.receipt.displayId),
          null,
          'cancel-not-permitted',
        );
        const lease = randomUUID();
        await claimExport(created.receipt.jobId, lease);
        await finishExport(created.receipt.jobId, lease, exportFile());
        await rejects(
          cancelAs(exporter, created.receipt.displayId),
          null,
          'job-finished',
        );
      },
    );

    await check(
      'recovery fails a run that no worker claimed within sixty minutes',
      async () => {
        const created = await createExport({ actor: exporter });
        jobs.push(created.receipt.jobId);
        const fresh = await createImport({ actor: importer });
        jobs.push(fresh.receipt.jobId);
        await migrator.query(
          "UPDATE cc.jobs SET created_at=clock_timestamp()-interval '61 minutes' WHERE job_id=$1",
          [created.receipt.jobId],
        );
        await migrator.query(
          "UPDATE cc.jobs SET created_at=clock_timestamp()-interval '10 minutes' WHERE job_id=$1",
          [fresh.receipt.jobId],
        );
        const recovered = await result(
          'SELECT cc.recover_device_file_jobs($1) AS result',
          [customer],
        );
        assert.deepEqual(
          recovered.failed.map((entry) => entry.jobId),
          [created.receipt.jobId],
        );
        assert.equal(recovered.failed[0].status, 'failed');
        const header = await jobRow(created.receipt.jobId);
        assert.equal(header.status, 'failed');
        assert.equal(header.failure, 'interrupted');
        assert.notEqual(header.finished_at, null);
        assert.equal((await jobRow(fresh.receipt.jobId)).status, 'running');
      },
    );

    await check(
      'recovery fails a lapsed lease and leaves a live lease alone',
      async () => {
        const live = await createImport({ actor: importer });
        const lapsed = await createImport({ actor: importer });
        jobs.push(live.receipt.jobId, lapsed.receipt.jobId);
        const liveLease = randomUUID();
        const lapsedLease = randomUUID();
        await claimImport(live.receipt.jobId, liveLease);
        await claimImport(lapsed.receipt.jobId, lapsedLease);
        await storeLines(lapsed.receipt.jobId, lapsedLease, [
          lineChange(2, 'D-1'),
        ]);
        await migrator.query(
          "UPDATE cc.device_import_jobs SET lease_expires_at=clock_timestamp()-interval '16 minutes' WHERE job_id=$1",
          [lapsed.receipt.jobId],
        );
        const recovered = await result(
          'SELECT cc.recover_device_file_jobs($1) AS result',
          [customer],
        );
        assert.deepEqual(
          recovered.failed.map((entry) => entry.jobId),
          [lapsed.receipt.jobId],
        );
        assert.equal((await jobRow(live.receipt.jobId)).status, 'running');
        const header = await jobRow(lapsed.receipt.jobId);
        assert.equal(header.status, 'failed');
        assert.equal(header.failure, 'interrupted');
        // A lost run deletes its partial report, so no page reads one.
        assert.equal(
          (
            await admin(
              'SELECT count(*)::integer AS rows FROM cc.device_import_changes WHERE job_id=$1',
              [lapsed.receipt.jobId],
            )
          )[0].rows,
          0,
        );
        assert.equal(
          (await renewImport(live.receipt.jobId, liveLease, 'refresh', 1, 1))
            .outcome,
          'renewed',
        );
      },
    );

    await check(
      'recovery ends a lost run that holds a cancel request as cancelled',
      async () => {
        const imported = await createImport({ actor: importer });
        jobs.push(imported.receipt.jobId);
        const lease = randomUUID();
        await claimImport(imported.receipt.jobId, lease);
        await storeLines(imported.receipt.jobId, lease, [lineChange(2, 'D-1')]);
        await cancelAs(importer, imported.receipt.displayId);
        await migrator.query(
          "UPDATE cc.device_import_jobs SET lease_expires_at=clock_timestamp()-interval '16 minutes' WHERE job_id=$1",
          [imported.receipt.jobId],
        );
        const recovered = await result(
          'SELECT cc.recover_device_file_jobs($1) AS result',
          [customer],
        );
        assert.deepEqual(
          recovered.failed.map((entry) => entry.jobId),
          [imported.receipt.jobId],
        );
        assert.equal(recovered.failed[0].status, 'cancelled');
        const header = await jobRow(imported.receipt.jobId);
        assert.equal(header.status, 'cancelled');
        assert.equal(header.cancelled, 1);
        assert.notEqual(header.cancel_requested_at, null);
        assert.equal(
          (
            await admin(
              'SELECT count(*)::integer AS rows FROM cc.device_import_changes WHERE job_id=$1',
              [imported.receipt.jobId],
            )
          )[0].rows,
          0,
        );
      },
    );

    await check(
      'the two file kinds take no write slot and skip admission',
      async () => {
        const first = await createExport({ actor: exporter });
        const second = await createImport({ actor: importer });
        jobs.push(first.receipt.jobId, second.receipt.jobId);
        const running = await admin(
          `SELECT count(*)::integer AS rows FROM cc.jobs
            WHERE customer_id=$1 AND kind IN ('device-export','device-import') AND status='running'`,
          [customer],
        );
        assert.ok(running[0].rows >= 2);
        const indexes = await admin(
          `SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='cc'
            AND indexname IN ('jobs_one_running','jobs_admission') ORDER BY indexname`,
        );
        assert.equal(indexes.length, 2);
        for (const index of indexes) {
          assert.ok(!index.indexdef.includes('device-export'));
          assert.ok(!index.indexdef.includes('device-import'));
          assert.ok(index.indexdef.includes('device-update'));
        }
        // A running write job also leaves both file jobs running: the unique index never covers them.
        const admitted = await result(
          'SELECT cc.admit_device_update_job($1,$2) AS result',
          [customer, false],
        );
        assert.equal(admitted, null);
      },
    );

    await check(
      'the runtime role selects the new tables but writes only through the functions',
      async () => {
        assert.ok(
          (
            await statement(
              `SELECT (SELECT count(*) FROM cc.device_export_jobs) AS exports,
                (SELECT count(*) FROM cc.device_import_jobs) AS imports`,
            )
          )[0].exports > 0,
        );
        await rejects(
          runtime.query(
            `INSERT INTO cc.device_export_jobs(job_id,purpose,format,sort_field,sort_direction)
              VALUES(gen_random_uuid(),'edit','csv','serialNumber','asc')`,
          ),
          '42501',
        );
        await rejects(
          runtime.query(
            `INSERT INTO cc.device_import_changes(job_id,ordinal,source_row,device_id,change_type,field,mode)
              VALUES(gen_random_uuid(),0,1,'D-1','field','notes','replace')`,
          ),
          '42501',
        );
      },
    );

    await check(
      'every new function refuses a role without EXECUTE',
      async () => {
        const signatures = [
          [
            'cc.create_device_export_job(uuid,integer,text,text,text,text,text,text[],jsonb,uuid,text)',
            'SELECT cc.create_device_export_job($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
            [
              exporter,
              1,
              customer,
              'edit',
              'csv',
              'serialNumber',
              'asc',
              [],
              JSON.stringify(['D-1']),
              randomUUID(),
              null,
            ],
          ],
          [
            'cc.create_device_import_job(uuid,integer,text,text,text,text,bigint,text[],uuid,text,text,integer,text,text)',
            'SELECT cc.create_device_import_job($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
            [
              importer,
              1,
              customer,
              'sync-changes',
              'csv',
              'devices.csv',
              10,
              [],
              randomUUID(),
              null,
              null,
              null,
              null,
              null,
            ],
          ],
          [
            'cc.claim_device_export_job(text,uuid,uuid)',
            'SELECT cc.claim_device_export_job($1,$2,$3)',
            [customer, randomUUID(), randomUUID()],
          ],
          [
            'cc.claim_device_import_job(text,uuid,uuid)',
            'SELECT cc.claim_device_import_job($1,$2,$3)',
            [customer, randomUUID(), randomUUID()],
          ],
          [
            'cc.renew_device_export_job(text,uuid,uuid,text,integer,integer)',
            'SELECT cc.renew_device_export_job($1,$2,$3,$4,$5,$6)',
            [customer, randomUUID(), randomUUID(), 'write-rows', 1, 1],
          ],
          [
            'cc.renew_device_import_job(text,uuid,uuid,integer,text,integer,integer)',
            'SELECT cc.renew_device_import_job($1,$2,$3,$4,$5,$6,$7)',
            [customer, randomUUID(), randomUUID(), 0, 'refresh', 1, 1],
          ],
          [
            'cc.store_device_import_lines(text,uuid,uuid,integer,jsonb)',
            'SELECT cc.store_device_import_lines($1,$2,$3,$4,$5)',
            [customer, randomUUID(), randomUUID(), 0, '[]'],
          ],
          [
            'cc.store_device_import_source(text,uuid,uuid,integer,text,bigint)',
            'SELECT cc.store_device_import_source($1,$2,$3,$4,$5,$6)',
            [
              customer,
              randomUUID(),
              randomUUID(),
              0,
              'example-artifact-1',
              1024,
            ],
          ],
          [
            'cc.start_device_export_sheet(text,uuid,uuid)',
            'SELECT cc.start_device_export_sheet($1,$2,$3)',
            [customer, randomUUID(), randomUUID()],
          ],
          [
            'cc.read_google_drive_settings(uuid,integer)',
            'SELECT cc.read_google_drive_settings($1,$2)',
            [exporter, 1],
          ],
          [
            'cc.save_google_drive_settings(uuid,integer,text,text,uuid)',
            'SELECT cc.save_google_drive_settings($1,$2,$3,$4,$5)',
            [exporter, 1, pickerKey('privilege'), '123456789012', randomUUID()],
          ],
          [
            'cc.finish_device_export_job(text,uuid,uuid,jsonb,text)',
            'SELECT cc.finish_device_export_job($1,$2,$3,$4,$5)',
            [customer, randomUUID(), randomUUID(), null, null],
          ],
          [
            'cc.finish_device_import_job(text,uuid,uuid,integer,jsonb,text,text,text)',
            'SELECT cc.finish_device_import_job($1,$2,$3,$4,$5,$6,$7,$8)',
            [customer, randomUUID(), randomUUID(), 0, null, null, null, null],
          ],
          [
            'cc.recover_device_file_jobs(text)',
            'SELECT cc.recover_device_file_jobs($1)',
            [customer],
          ],
          [
            'cc.create_device_update_preview(uuid,integer,text,integer,text,jsonb,text,jsonb,integer,text)',
            'SELECT cc.create_device_update_preview($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
            [
              importer,
              1,
              customer,
              1,
              'annotated-location',
              '[]',
              'x',
              '[]',
              30,
              null,
            ],
          ],
          [
            'cc.open_device_update_preview(uuid,integer,text,integer,text,jsonb,integer,text)',
            'SELECT cc.open_device_update_preview($1,$2,$3,$4,$5,$6,$7,$8)',
            [importer, 1, customer, 1, 'annotated-location', '[]', 30, null],
          ],
          [
            'cc.add_device_update_preview_targets(uuid,integer,text,uuid,jsonb)',
            'SELECT cc.add_device_update_preview_targets($1,$2,$3,$4,$5)',
            [importer, 1, customer, randomUUID(), '[]'],
          ],
          [
            'cc.seal_device_update_preview(uuid,integer,text,uuid,text)',
            'SELECT cc.seal_device_update_preview($1,$2,$3,$4,$5)',
            [importer, 1, customer, randomUUID(), 'x'],
          ],
          [
            'cc.read_device_update_preview_manifest_page(uuid,integer,text,uuid,integer)',
            'SELECT cc.read_device_update_preview_manifest_page($1,$2,$3,$4,$5)',
            [importer, 1, customer, randomUUID(), 250],
          ],
          [
            'cc.read_device_update_preview_manifest(uuid,integer,text,uuid)',
            'SELECT cc.read_device_update_preview_manifest($1,$2,$3,$4)',
            [importer, 1, customer, randomUUID()],
          ],
          [
            'cc.cancel_device_import_plan(uuid,integer,text,uuid,uuid,integer)',
            'SELECT cc.cancel_device_import_plan($1,$2,$3,$4,$5,$6)',
            [importer, 1, customer, randomUUID(), randomUUID(), 1],
          ],
          [
            'cc.lock_device_import_plan(uuid,integer,text,uuid,uuid,integer)',
            'SELECT cc.lock_device_import_plan($1,$2,$3,$4,$5,$6)',
            [importer, 1, customer, randomUUID(), randomUUID(), 1],
          ],
          [
            'cc.mark_device_import_changes(uuid,integer,text,uuid,uuid,jsonb,jsonb)',
            'SELECT cc.mark_device_import_changes($1,$2,$3,$4,$5,$6,$7)',
            [importer, 1, customer, randomUUID(), randomUUID(), '[]', '[]'],
          ],
          [
            'cc.link_device_import_jobs(uuid,integer,text,uuid,uuid,jsonb,jsonb,uuid)',
            'SELECT cc.link_device_import_jobs($1,$2,$3,$4,$5,$6,$7,$8)',
            [
              importer,
              1,
              customer,
              randomUUID(),
              randomUUID(),
              '[]',
              '[]',
              randomUUID(),
            ],
          ],
        ];
        for (const [signature] of signatures) {
          const granted = await migrator.query(
            `SELECT has_function_privilege('cc-app',$1,'EXECUTE') AS granted`,
            [signature],
          );
          assert.equal(
            granted.rows[0].granted,
            true,
            `${signature} must grant cc-app`,
          );
        }
        const outsiderName = `cc-outsider-${randomUUID().slice(0, 8)}`;
        const adminSession = await connect('postgres', 'cc-app');
        let outsiderSession;
        try {
          await adminSession.query(
            `CREATE ROLE "${outsiderName}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`,
          );
          await adminSession.query(
            `GRANT CONNECT ON DATABASE "cc-app" TO "${outsiderName}"`,
          );
          await adminSession.query(
            `GRANT USAGE ON SCHEMA cc TO "${outsiderName}"`,
          );
          outsiderSession = await connect(outsiderName, 'cc-app');
          for (const [signature, text, values] of signatures) {
            await assert.rejects(
              outsiderSession.query(text, values),
              (error) => error.code === '42501',
              `${signature} must refuse a role without EXECUTE.`,
            );
            const granted = await outsiderSession.query(
              `SELECT has_function_privilege(current_user,$1,'EXECUTE') AS granted`,
              [signature],
            );
            assert.equal(granted.rows[0].granted, false);
          }
        } finally {
          if (outsiderSession !== undefined) await close(outsiderSession);
          await adminSession
            .query(`DROP ROLE IF EXISTS "${outsiderName}"`)
            .catch(() => undefined);
          await close(adminSession);
        }
      },
    );

    await check(
      'the five export failure codes are known to the finish check',
      async () => {
        for (const code of [
          'storage-unavailable',
          'inventory-unavailable',
          'export-too-large',
          'drive-unavailable',
          'sheet-write-failed',
        ])
          assert.equal(
            (
              await migrator.query('SELECT cc.job_failure_known($1) AS known', [
                code,
              ])
            ).rows[0].known,
            true,
          );
        assert.equal(
          (
            await migrator.query('SELECT cc.job_failure_known($1) AS known', [
              'made-up',
            ])
          ).rows[0].known,
          false,
        );
      },
    );

    await check(
      'a job delete removes its detail rows, targets, and lines',
      async () => {
        const exported = await createExport({ actor: exporter });
        jobs.push(exported.receipt.jobId);
        const exportedLease = randomUUID();
        await claimExport(exported.receipt.jobId, exportedLease);
        await finishExport(exported.receipt.jobId, exportedLease, exportFile());
        const imported = await createImport({ actor: importer });
        jobs.push(imported.receipt.jobId);
        const importedLease = randomUUID();
        await claimImport(imported.receipt.jobId, importedLease);
        await storeLines(imported.receipt.jobId, importedLease, [
          lineChange(2, 'D-1'),
          {
            kind: 'warning',
            sourceRow: null,
            deviceId: null,
            warning: 'Unknown column.',
          },
        ]);
        await finishImport(
          imported.receipt.jobId,
          importedLease,
          counts({
            rows: 1,
            unchanged: 0,
            noChangeNeeded: 0,
            proposed: 1,
            rejected: 0,
          }),
        );
        await migrator.query(
          'DELETE FROM cc.jobs WHERE job_id=ANY($1::uuid[])',
          [[exported.receipt.jobId, imported.receipt.jobId]],
        );
        for (const [table, jobId] of [
          ['device_export_jobs', exported.receipt.jobId],
          ['device_export_targets', exported.receipt.jobId],
          ['device_import_jobs', imported.receipt.jobId],
          ['device_import_changes', imported.receipt.jobId],
          ['device_import_warnings', imported.receipt.jobId],
        ])
          assert.equal(
            (
              await admin(
                `SELECT count(*)::integer AS rows FROM cc.${table} WHERE job_id=$1`,
                [jobId],
              )
            )[0].rows,
            0,
            `${table} must cascade`,
          );
      },
    );
    // ===== S2 to S5: the plan, the paged previews, the wait, the cascade, and the purge (XB3) =====
    const planActor = await principal([
      ...importGrants(),
      ['devices:status', district()],
    ]);
    const planWatcher = await principal([
      ['jobs:read', district()],
      ['jobs:manage', district()],
    ]);
    // An earlier module leaves the connection inactive, and every preview of this section confirms
    // against a connected customer. The previous value returns in the cleanup.
    const wasActive = (
      await admin('SELECT active FROM cc.google_connection')
    )[0].active;
    if (!wasActive)
      await migrator.query('UPDATE cc.google_connection SET active=true');
    const managedDevices = [];
    const artifacts = [];
    const deviceFixture = async (deviceId, { removed = false } = {}) => {
      managedDevices.push(deviceId);
      await migrator.query(
        `INSERT INTO cc.devices(customer_id,device_id,serial_number,org_unit_path,last_entity_sync,removed_at)
         VALUES($1,$2,$3,'/XB3 School',clock_timestamp(),$4)
         ON CONFLICT(customer_id,device_id) DO UPDATE SET removed_at=EXCLUDED.removed_at,
           last_entity_sync=clock_timestamp()`,
        [customer, deviceId, `SN-${deviceId}`, removed ? new Date() : null],
      );
    };
    const publishArtifact = async () => {
      const id = randomUUID();
      const attempt = randomUUID();
      await migrator.query(
        `INSERT INTO cc.artifacts(id,backend,locator,schema_version,attempt_id,sha256,size_bytes,
           publication_state,active,reference_count)
         VALUES($1,'local',$2,1,$3,$4,1,'ready',false,0)`,
        [id, `${id}.${attempt}`, attempt, 'a'.repeat(64)],
      );
      artifacts.push(id);
      return id;
    };
    const planDetail = (jobId) =>
      admin('SELECT * FROM cc.device_import_jobs WHERE job_id=$1', [
        jobId,
      ]).then((rows) => rows[0]);
    const planLock = (
      actor,
      version,
      jobId,
      planId,
      revision,
      client = runtime,
    ) =>
      client
        .query(
          'SELECT cc.lock_device_import_plan($1,$2,$3,$4,$5,$6) AS result',
          [actor, version, customer, jobId, planId, revision],
        )
        .then((r) => r.rows[0].result);
    const planCancel = (
      actor,
      version,
      jobId,
      planId,
      revision,
      client = runtime,
    ) =>
      client
        .query(
          'SELECT cc.cancel_device_import_plan($1,$2,$3,$4,$5,$6) AS result',
          [actor, version, customer, jobId, planId, revision],
        )
        .then((r) => r.rows[0].result);
    const markChanges = (
      actor,
      version,
      jobId,
      planId,
      devices,
      dispositions = [],
      client = runtime,
    ) =>
      client
        .query(
          'SELECT cc.mark_device_import_changes($1,$2,$3,$4,$5,$6,$7) AS result',
          [
            actor,
            version,
            customer,
            jobId,
            planId,
            JSON.stringify(devices),
            JSON.stringify(dispositions),
          ],
        )
        .then((r) => r.rows[0].result);
    const linkJobs = (
      actor,
      version,
      jobId,
      planId,
      previews,
      notRun = [],
      client = runtime,
    ) =>
      client
        .query(
          'SELECT cc.link_device_import_jobs($1,$2,$3,$4,$5,$6,$7,$8) AS result',
          [
            actor,
            version,
            customer,
            jobId,
            planId,
            JSON.stringify(previews),
            JSON.stringify(notRun),
            randomUUID(),
          ],
        )
        .then((r) => r.rows[0].result);
    const openPreview = (
      actor,
      version,
      action,
      changes = null,
      client = runtime,
    ) =>
      client
        .query(
          'SELECT cc.open_device_update_preview($1,$2,$3,$4,$5,$6,$7,$8) AS result',
          [
            actor,
            version,
            customer,
            generation,
            action,
            changes === null ? null : JSON.stringify(changes),
            15,
            action === 'deprovision'
              ? 'DEPROVISION_REASON_RETIRING_DEVICE'
              : null,
          ],
        )
        .then((r) => r.rows[0].result);
    const addTargets = (actor, version, previewId, targets, client = runtime) =>
      client
        .query(
          'SELECT cc.add_device_update_preview_targets($1,$2,$3,$4,$5) AS result',
          [actor, version, customer, previewId, JSON.stringify(targets)],
        )
        .then((r) => r.rows[0].result);
    const sealPreview = (actor, version, previewId, digest, client = runtime) =>
      client
        .query(
          'SELECT cc.seal_device_update_preview($1,$2,$3,$4,$5) AS result',
          [actor, version, customer, previewId, digest],
        )
        .then((r) => r.rows[0].result);
    const readPage = (actor, version, previewId, after = null) =>
      result(
        'SELECT cc.read_device_update_preview_manifest_page($1,$2,$3,$4,$5) AS result',
        [actor, version, customer, previewId, after],
      );
    const readManifest = (actor, version, previewId) =>
      result(
        'SELECT cc.read_device_update_preview_manifest($1,$2,$3,$4) AS result',
        [actor, version, customer, previewId],
      );
    const confirmPreview = (
      actor,
      version,
      previewId,
      digest,
      artifact,
      client = runtime,
    ) =>
      client
        .query(
          'SELECT cc.confirm_device_update_preview($1,$2,$3,$4,$5,$6,$7,$8) AS result',
          [
            actor,
            version,
            customer,
            previewId,
            digest,
            artifact,
            randomUUID(),
            null,
          ],
        )
        .then((r) => r.rows[0].result);
    const target = (ordinal, deviceId, extra = {}) => ({
      ordinal,
      device_id: deviceId,
      serial_number: `SN-${deviceId}`,
      org_unit_path: '/XB3 School',
      observed_value: null,
      observed_at: null,
      disposition: 'eligible',
      exclusion_reason: null,
      ...extra,
    });
    const fieldTarget = (ordinal, deviceId, field, requested, baseline) =>
      target(ordinal, deviceId, {
        fields: [
          {
            field,
            requested_value: requested,
            baseline_value: baseline,
            observed_value: baseline,
            disposition: 'eligible',
          },
        ],
      });
    const statusTarget = (ordinal, deviceId) =>
      target(ordinal, deviceId, {
        observed_value: 'ACTIVE',
        observed_at: new Date().toISOString(),
      });
    const digestFor = (seed) =>
      createHash('sha256').update(seed.join('\n')).digest('hex');
    const fieldChange = (sourceRow, deviceId, extra = {}) => ({
      kind: 'change',
      sourceRow,
      deviceId,
      changeType: 'field',
      field: 'notes',
      mode: 'replace',
      currentValue: 'old',
      newValue: `new-${deviceId}`,
      ...extra,
    });
    const statusChange = (sourceRow, deviceId, action = 'disable') => ({
      kind: 'change',
      sourceRow,
      deviceId,
      changeType: 'status',
      action,
      currentValue: 'ACTIVE',
      newValue: action === 'disable' ? 'DISABLED' : 'ACTIVE',
    });
    // One import plan from its stored lines. The fixture claims the validation job, stores the lines in
    // calls of 1,000, and finishes the job, which opens the plan.
    const importPlan = async ({ actor = planActor, lines }) => {
      const imported = await createImport({ actor });
      jobs.push(imported.receipt.jobId);
      const lease = randomUUID();
      assert.equal(
        (await claimImport(imported.receipt.jobId, lease)).outcome,
        'claimed',
      );
      for (let start = 0; start < lines.length; start += 1000) {
        const stored = await storeLines(
          imported.receipt.jobId,
          lease,
          lines.slice(start, start + 1000),
        );
        assert.equal(stored.outcome, 'stored');
      }
      // The counts of the finish count source rows, not change lines: one row may hold several changes.
      const sourceRows = (kind) =>
        new Set(
          lines
            .filter((line) => line.kind === kind)
            .map((line) => line.sourceRow),
        ).size;
      const proposed = sourceRows('change');
      const rejected = sourceRows('rejection');
      const finished = await finishImport(
        imported.receipt.jobId,
        lease,
        counts({
          rows: proposed + rejected,
          unchanged: 0,
          noChangeNeeded: 0,
          proposed,
          rejected,
          candidateRows: proposed + rejected,
          staleDevicesRead: 0,
          oldestObservedAt: null,
        }),
      );
      assert.equal(finished.outcome, 'finished');
      const detail = await planDetail(imported.receipt.jobId);
      assert.equal(detail.plan_state, 'open');
      return {
        jobId: imported.receipt.jobId,
        displayId: imported.receipt.displayId,
        planId: detail.plan_id,
        revision: detail.plan_revision,
      };
    };
    // One Execute in the caller's transaction: the plan lock, one edit preview and one preview per status
    // action (each filled in pages of 250), the seals, the confirmations, and the links.
    const executePlan = async (
      client,
      {
        jobId,
        planId,
        revision,
        fieldDevices = [],
        field = 'notes',
        requestFor = (deviceId) => `new-${deviceId}`,
        baselineFor = () => 'old',
        statusDevices = {},
      },
    ) => {
      const locked = await planLock(
        planActor,
        1,
        jobId,
        planId,
        revision,
        client,
      );
      if (locked.outcome !== 'locked') return { locked };
      const previews = [];
      let fieldJob = null;
      const confirmed = async (previewId, digest) =>
        confirmPreview(
          planActor,
          1,
          previewId,
          digest,
          await publishArtifact(),
          client,
        );
      if (fieldDevices.length) {
        const opened = await openPreview(
          planActor,
          1,
          'annotated-location',
          null,
          client,
        );
        assert.equal(opened.outcome, 'opened');
        const previewId = opened.preview.preview_id;
        for (let start = 0; start < fieldDevices.length; start += 250) {
          const page = fieldDevices
            .slice(start, start + 250)
            .map((deviceId, index) =>
              fieldTarget(
                start + index,
                deviceId,
                field,
                requestFor(deviceId, start + index),
                baselineFor(start + index),
              ),
            );
          const added = await addTargets(planActor, 1, previewId, page, client);
          assert.equal(added.outcome, 'added');
          assert.ok(added.added <= 250, 'one add call carries one page');
        }
        const digest = digestFor(fieldDevices);
        assert.equal(
          (await sealPreview(planActor, 1, previewId, digest, client)).outcome,
          'sealed',
        );
        const answer = await confirmed(previewId, digest);
        assert.equal(answer.outcome, 'created', JSON.stringify(answer));
        previews.push(previewId);
        fieldJob = answer.receipt;
      }
      const statusJobs = [];
      for (const [action, devices] of Object.entries(statusDevices)) {
        const opened = await openPreview(planActor, 1, action, null, client);
        assert.equal(opened.outcome, 'opened');
        const previewId = opened.preview.preview_id;
        for (let start = 0; start < devices.length; start += 250) {
          const page = devices
            .slice(start, start + 250)
            .map((deviceId, index) => statusTarget(start + index, deviceId));
          const added = await addTargets(planActor, 1, previewId, page, client);
          assert.equal(added.outcome, 'added');
          assert.ok(added.added <= 250, 'one add call carries one page');
        }
        const digest = digestFor(
          devices.map((device) => `${action}:${device}`),
        );
        assert.equal(
          (await sealPreview(planActor, 1, previewId, digest, client)).outcome,
          'sealed',
        );
        const answer = await confirmed(previewId, digest);
        assert.equal(answer.outcome, 'created');
        previews.push(previewId);
        statusJobs.push(answer.receipt);
      }
      const plan = await linkJobs(
        planActor,
        1,
        jobId,
        planId,
        previews,
        [],
        client,
      );
      return { locked, plan, previews, fieldJob, statusJobs };
    };
    // A write job that this module leaves behind ends through the one cancel route.
    const retire = async (displayId) => {
      const answer = await cancelAs(planActor, displayId);
      assert.equal(answer.outcome, 'requested');
    };
    const backendPid = async (client) =>
      (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const waitBlocked = async (pid, holderPid, label = 'the call') => {
      let last = null;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const row = (
          await migrator.query(
            'SELECT wait_event_type,wait_event,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid=$1',
            [pid],
          )
        ).rows[0];
        last = row ?? null;
        if (
          row &&
          (row.wait_event_type === 'Lock' ||
            (holderPid !== null && row.blockers.includes(holderPid)))
        )
          return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`${label} never blocked: ${JSON.stringify(last)}`);
    };
    try {
      await check(
        'S2 the paged preview answers one page by key and refuses an unsealed confirm',
        async () => {
          const devices = Array.from(
            { length: 260 },
            (_, index) => `S2-${index}`,
          );
          const plan = await importPlan({
            lines: devices.map((deviceId, index) =>
              fieldChange(index + 2, deviceId),
            ),
          });
          const locked = await planLock(
            planActor,
            1,
            plan.jobId,
            plan.planId,
            plan.revision,
          );
          assert.equal(locked.outcome, 'locked');
          assert.equal(locked.plan.planId, plan.planId);
          assert.equal(locked.plan.revision, plan.revision);
          assert.equal(locked.plan.state, 'open');
          const opened = await openPreview(planActor, 1, 'annotated-location');
          assert.equal(opened.outcome, 'opened');
          const previewId = opened.preview.preview_id;
          assert.match(opened.preview.display_id, /^PV-\d{3,}$/);
          assert.equal(opened.preview.selected, 0);
          assert.equal(opened.preview.manifest_digest, null);
          const artifact = await publishArtifact();
          // An unsealed preview answers no manifest page, no manifest, and no job.
          assert.equal(
            (await readPage(planActor, 1, previewId)).outcome,
            'preview-unsealed',
          );
          assert.equal(
            (await readManifest(planActor, 1, previewId)).outcome,
            'preview-unsealed',
          );
          assert.equal(
            (
              await confirmPreview(
                planActor,
                1,
                previewId,
                'a'.repeat(64),
                artifact,
              )
            ).outcome,
            'preview-unsealed',
          );
          const firstPage = devices
            .slice(0, 250)
            .map((deviceId, index) =>
              fieldTarget(index, deviceId, 'notes', `new-${deviceId}`, 'old'),
            );
          const secondPage = devices
            .slice(250)
            .map((deviceId, index) =>
              fieldTarget(
                250 + index,
                deviceId,
                'notes',
                `new-${deviceId}`,
                'old',
              ),
            );
          // One call carries one page, and a repeat inside or across pages rejects.
          assert.equal(
            (
              await rejects(
                addTargets(planActor, 1, previewId, [
                  ...firstPage,
                  ...secondPage,
                ]),
                '22023',
              )
            ).message,
            'The preview targets are invalid.',
          );
          const addedFirst = await addTargets(
            planActor,
            1,
            previewId,
            firstPage,
          );
          assert.equal(addedFirst.outcome, 'added');
          assert.equal(addedFirst.added, 250);
          assert.equal(addedFirst.targets, 250);
          assert.equal(
            (
              await rejects(
                addTargets(planActor, 1, previewId, [
                  fieldTarget(0, 'S2-repeat', 'notes', 'new', 'old'),
                ]),
                '22023',
              )
            ).message,
            'The preview targets repeat an ordinal or a device.',
          );
          assert.equal(
            (await addTargets(planActor, 1, previewId, secondPage)).outcome,
            'added',
          );
          const digest = digestFor(devices);
          const sealed = await sealPreview(planActor, 1, previewId, digest);
          assert.equal(sealed.outcome, 'sealed');
          assert.equal(sealed.preview.selected, 260);
          assert.equal(sealed.preview.eligible, 260);
          assert.equal(sealed.preview.conflicts, 0);
          assert.equal(sealed.preview.field_changes, 260);
          assert.equal(sealed.preview.manifest_digest, digest);
          // A second digest never seals, and the first digest seals again.
          assert.equal(
            (await sealPreview(planActor, 1, previewId, 'b'.repeat(64)))
              .outcome,
            'preview-changed',
          );
          assert.equal(
            (await sealPreview(planActor, 1, previewId, digest)).outcome,
            'sealed',
          );
          assert.equal(
            (await addTargets(planActor, 1, previewId, secondPage)).outcome,
            'preview-sealed',
          );
          const pageOne = await readPage(planActor, 1, previewId);
          assert.equal(pageOne.outcome, 'page');
          assert.equal(pageOne.targets.length, 250);
          assert.equal(pageOne.total, 260);
          assert.equal(pageOne.nextOrdinal, 249);
          assert.equal(pageOne.manifestDigest, digest);
          assert.equal(pageOne.targets[0].device_id, 'S2-0');
          assert.deepEqual(pageOne.targets[0].fields, [
            {
              field: 'notes',
              requestedValue: 'new-S2-0',
              observedValue: 'old',
              baselineValue: 'old',
              disposition: 'eligible',
            },
          ]);
          const pageTwo = await readPage(
            planActor,
            1,
            previewId,
            pageOne.nextOrdinal,
          );
          assert.equal(pageTwo.outcome, 'page');
          assert.equal(pageTwo.targets.length, 10);
          assert.equal(pageTwo.nextOrdinal, null);
          const manifest = await readManifest(planActor, 1, previewId);
          assert.equal(manifest.outcome, 'manifest');
          assert.equal(manifest.manifest.preview.selected, 260);
          assert.equal(manifest.manifest.preview.manifestDigest, digest);
          assert.equal(manifest.manifest.targets.length, 260);
          assert.equal(manifest.manifest.confirmer, planActor);
          // The confirmation takes the sealed digest once and answers the same job after that.
          assert.equal(
            (
              await confirmPreview(
                planActor,
                1,
                previewId,
                'c'.repeat(64),
                artifact,
              )
            ).outcome,
            'preview-changed',
          );
          const created = await confirmPreview(
            planActor,
            1,
            previewId,
            digest,
            artifact,
          );
          assert.equal(created.outcome, 'created', JSON.stringify(created));
          assert.match(created.receipt.displayId, /^UPD-/);
          assert.equal(created.receipt.updateCount, 260);
          jobs.push(created.receipt.jobId);
          const again = await confirmPreview(
            planActor,
            1,
            previewId,
            digest,
            artifact,
          );
          assert.equal(again.outcome, 'existing');
          assert.deepEqual(again.receipt, created.receipt);
          // The one-call preview takes the same page bound and the same seal.
          const built = await result(
            'SELECT cc.create_device_update_preview($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS result',
            [
              planActor,
              1,
              customer,
              generation,
              'annotated-location',
              null,
              digestFor(['S2-built']),
              JSON.stringify([
                fieldTarget(0, 'S2-built', 'notes', 'built', 'old'),
              ]),
              15,
              null,
            ],
          );
          assert.equal(built.outcome, 'created');
          assert.equal(built.preview.selected, 1);
          assert.equal(built.preview.manifest_digest, digestFor(['S2-built']));
          await retire(created.receipt.displayId);
        },
      );

      await check(
        'S2 the plan cancel answers the same plan and keeps the stored report',
        async () => {
          const plan = await importPlan({
            lines: [fieldChange(2, 'S2C-1'), fieldChange(3, 'S2C-2')],
          });
          const cancelled = await planCancel(
            planActor,
            1,
            plan.jobId,
            plan.planId,
            plan.revision,
          );
          assert.equal(cancelled.outcome, 'cancelled');
          assert.equal(cancelled.plan.state, 'cancelled');
          assert.equal(cancelled.plan.revision, plan.revision + 1);
          assert.equal(cancelled.plan.changedBy, planActor);
          assert.equal(
            (
              await admin(
                'SELECT count(*)::integer AS rows FROM cc.device_import_changes WHERE job_id=$1',
                [plan.jobId],
              )
            )[0].rows,
            2,
            'the report stays',
          );
          assert.deepEqual(
            await planCancel(
              planActor,
              1,
              plan.jobId,
              plan.planId,
              plan.revision,
            ),
            cancelled,
          );
          const detail = await planDetail(plan.jobId);
          assert.equal(detail.plan_state, 'cancelled');
          assert.equal(detail.plan_revision, plan.revision + 1);
          const other = await importPlan({ lines: [fieldChange(2, 'S2C-3')] });
          const stale = await planCancel(
            planActor,
            1,
            other.jobId,
            other.planId,
            other.revision + 1,
          );
          assert.equal(stale.outcome, 'conflict');
          assert.equal(stale.plan.state, 'open');
          assert.equal(
            (
              await planCancel(
                planActor,
                1,
                other.jobId,
                randomUUID(),
                other.revision,
              )
            ).outcome,
            'conflict',
          );
          assert.equal(
            (
              await planCancel(
                planWatcher,
                1,
                other.jobId,
                other.planId,
                other.revision,
              )
            ).outcome,
            'not-found',
          );
          assert.equal((await planDetail(other.jobId)).plan_state, 'open');
        },
      );

      await check(
        'S2 the plan cancel reads the clock after the header wait',
        async () => {
          for (const [interval, expected] of [
            ['300 milliseconds', 'expired'],
            ['1 hour', 'cancelled'],
          ]) {
            const plan = await importPlan({
              lines: [fieldChange(2, `S2E-${interval.length}`)],
            });
            await migrator.query(
              `UPDATE cc.device_import_jobs
               SET plan_expires_at=clock_timestamp()+$2::interval WHERE job_id=$1`,
              [plan.jobId, interval],
            );
            const holder = await connect('postgres', 'cc-app');
            const waiter = await connect('cc-app', 'cc-app');
            try {
              await holder.query('BEGIN');
              await holder.query(
                'SELECT 1 FROM cc.jobs WHERE job_id=$1 FOR UPDATE',
                [plan.jobId],
              );
              const holderPid = await backendPid(holder);
              const waiterPid = await backendPid(waiter);
              const pending = planCancel(
                planActor,
                1,
                plan.jobId,
                plan.planId,
                plan.revision,
                waiter,
              );
              await waitBlocked(waiterPid, holderPid);
              await holder.query('SELECT pg_sleep(0.45)');
              await holder.query('COMMIT');
              const answer = await pending;
              assert.equal(answer.outcome, expected);
              assert.equal(
                (await planDetail(plan.jobId)).plan_state,
                expected === 'cancelled' ? 'cancelled' : 'open',
              );
            } finally {
              await holder.query('ROLLBACK').catch(() => undefined);
              await close(holder);
              await close(waiter);
            }
          }
        },
      );

      await check(
        'S2 Execute creates one job per preview, links every change, and repeats',
        async () => {
          const plan = await importPlan({
            lines: [fieldChange(2, 'S2X-1'), fieldChange(3, 'S2X-2')],
          });
          await deviceFixture('S2X-1');
          await deviceFixture('S2X-2');
          const session = await connect('cc-app', 'cc-app');
          let executed;
          try {
            await session.query('BEGIN');
            executed = await executePlan(session, {
              jobId: plan.jobId,
              planId: plan.planId,
              revision: plan.revision,
              fieldDevices: ['S2X-1', 'S2X-2'],
            });
            await session.query('COMMIT');
          } catch (error) {
            await session.query('ROLLBACK').catch(() => undefined);
            throw error;
          } finally {
            await close(session);
          }
          assert.equal(executed.locked.outcome, 'locked');
          assert.equal(executed.plan.outcome, 'executed');
          assert.equal(executed.plan.plan.state, 'executed');
          assert.equal(executed.plan.linked, 2);
          assert.equal(executed.plan.receipts.length, 1);
          const job = executed.plan.receipts[0];
          assert.match(job.displayId, /^UPD-/);
          jobs.push(job.jobId);
          assert.equal(job.updateCount, 2);
          const detail = await planDetail(plan.jobId);
          assert.equal(detail.plan_state, 'executed');
          assert.equal(detail.plan_changed_by, planActor);
          assert.deepEqual(detail.execute_receipts, executed.plan.receipts);
          const links = await admin(
            `SELECT c.ordinal,c.linked_job_id,c.operation_number,c.not_run_reason,
               u.import_job_id,u.wait_for_job_id
             FROM cc.device_import_changes c
             JOIN cc.device_update_jobs u ON u.job_id=c.linked_job_id
             WHERE c.job_id=$1 ORDER BY c.ordinal`,
            [plan.jobId],
          );
          assert.deepEqual(
            links.map((row) => row.operation_number),
            [1, 2],
          );
          assert.ok(links.every((row) => row.linked_job_id === job.jobId));
          assert.ok(links.every((row) => row.import_job_id === plan.jobId));
          assert.ok(links.every((row) => row.wait_for_job_id === null));
          assert.ok(links.every((row) => row.not_run_reason === null));
          assert.equal(
            (
              await admin(
                'SELECT count(*)::integer AS rows FROM cc.security_events WHERE event=$1 AND detail=$2',
                ['device-import-executed', plan.displayId],
              )
            )[0].rows,
            1,
          );
          // A repeat answers the stored receipts and creates no second job or audit row.
          const repeat = await planLock(
            planActor,
            1,
            plan.jobId,
            plan.planId,
            plan.revision,
          );
          assert.equal(repeat.outcome, 'executed');
          assert.deepEqual(repeat.receipts, executed.plan.receipts);
          assert.equal(
            (
              await admin(
                'SELECT count(*)::integer AS rows FROM cc.device_update_jobs WHERE import_job_id=$1',
                [plan.jobId],
              )
            )[0].rows,
            1,
          );
          assert.equal(
            (
              await admin(
                'SELECT count(*)::integer AS rows FROM cc.security_events WHERE event=$1 AND detail=$2',
                ['device-import-executed', plan.displayId],
              )
            )[0].rows,
            1,
          );
          await retire(job.displayId);
        },
      );

      await check(
        'S2 a conflict device never runs, and Execute and the plan cancel order alike',
        async () => {
          const plan = await importPlan({
            lines: [fieldChange(2, 'S2R-1'), fieldChange(3, 'S2R-2')],
          });
          await deviceFixture('S2R-1');
          await deviceFixture('S2R-2');
          const marked = await markChanges(
            planActor,
            1,
            plan.jobId,
            plan.planId,
            ['S2R-2'],
          );
          assert.equal(marked.outcome, 'marked');
          assert.equal(marked.marked, 1);
          const executor = await connect('cc-app', 'cc-app');
          const canceller = await connect('cc-app', 'cc-app');
          let firstDisplayId = null;
          try {
            await executor.query('BEGIN');
            const executed = await executePlan(executor, {
              jobId: plan.jobId,
              planId: plan.planId,
              revision: plan.revision,
              fieldDevices: ['S2R-1'],
            });
            assert.equal(executed.plan.outcome, 'executed');
            assert.equal(executed.plan.linked, 1);
            jobs.push(executed.fieldJob.jobId);
            firstDisplayId = executed.fieldJob.displayId;
            // The cancel waits for the Execute transaction, then answers the executed plan.
            const executorPid = await backendPid(executor);
            const cancellerPid = await backendPid(canceller);
            const cancelled = planCancel(
              planActor,
              1,
              plan.jobId,
              plan.planId,
              plan.revision + 1,
              canceller,
            );
            await waitBlocked(cancellerPid, executorPid);
            await executor.query('COMMIT');
            const raced = await cancelled;
            assert.equal(raced.outcome, 'conflict');
            assert.equal(raced.plan.state, 'executed');
            // The links and the reasons read after the commit of the Execute transaction.
            const reasons = await admin(
              `SELECT ordinal,linked_job_id,not_run_reason FROM cc.device_import_changes
               WHERE job_id=$1 ORDER BY ordinal`,
              [plan.jobId],
            );
            assert.equal(reasons[0].linked_job_id, executed.fieldJob.jobId);
            assert.equal(reasons[0].not_run_reason, null);
            assert.equal(reasons[1].linked_job_id, null);
            assert.equal(reasons[1].not_run_reason, 'changed-after-validation');
            // The other order: the cancel holds the header, then Execute answers the cancel.
            const second = await importPlan({
              lines: [fieldChange(2, 'S2Q-1')],
            });
            await canceller.query('BEGIN');
            const cancelFirst = await planCancel(
              planActor,
              1,
              second.jobId,
              second.planId,
              second.revision,
              canceller,
            );
            assert.equal(cancelFirst.outcome, 'cancelled');
            const blockedLock = planLock(
              planActor,
              1,
              second.jobId,
              second.planId,
              second.revision,
              executor,
            );
            await waitBlocked(executorPid, cancellerPid);
            await canceller.query('COMMIT');
            const lockedAfterCancel = await blockedLock;
            assert.equal(lockedAfterCancel.outcome, 'conflict');
            assert.equal(lockedAfterCancel.plan.state, 'cancelled');
          } catch (error) {
            await executor.query('ROLLBACK').catch(() => undefined);
            await canceller.query('ROLLBACK').catch(() => undefined);
            throw error;
          } finally {
            await close(executor);
            await close(canceller);
          }
          if (firstDisplayId !== null) await retire(firstDisplayId);
        },
      );

      await check(
        'S2 a valid multi-field plan links above 50,000 Not run changes in bounded pages',
        async () => {
          // 25,002 source rows of two field changes each: 50,004 change lines, and 50,003 of them never
          // run. The disposition call stores them in pages of 250, so no call carries the whole plan.
          const rows = 25002;
          const devices = Array.from(
            { length: rows },
            (_, index) => `S2M-${index}`,
          );
          const lines = [];
          devices.forEach((deviceId, index) => {
            lines.push(
              fieldChange(index * 2 + 2, deviceId, {
                field: 'notes',
                newValue: `new-${deviceId}`,
              }),
              fieldChange(index * 2 + 2, deviceId, {
                field: 'annotatedAssetId',
                newValue: `asset-${deviceId}`,
              }),
            );
          });
          assert.equal(lines.length, 50004);
          const plan = await importPlan({ lines });
          const eligible = devices.at(-1);
          await deviceFixture(eligible);
          // Every change holds `no-change-needed` except the last device's notes change.
          const dispositions = lines
            .map((_, index) => ({ ordinal: index }))
            .filter(({ ordinal }) => ordinal !== lines.length - 2)
            .map(({ ordinal }) => ({ ordinal, reason: 'no-change-needed' }));
          assert.equal(dispositions.length, 50003);
          let pages = 0;
          for (let start = 0; start < dispositions.length; start += 250) {
            const page = dispositions.slice(start, start + 250);
            assert.ok(
              page.length <= 250,
              'one disposition call carries one page',
            );
            const marked = await markChanges(
              planActor,
              1,
              plan.jobId,
              plan.planId,
              [],
              page,
            );
            assert.equal(marked.outcome, 'marked');
            assert.equal(marked.marked, 0);
            assert.equal(marked.disposed, page.length);
            pages += 1;
          }
          assert.equal(pages, 201);
          // A second page for one ordinal keeps the first reason.
          const repeated = await markChanges(
            planActor,
            1,
            plan.jobId,
            plan.planId,
            [],
            [{ ordinal: 0, reason: 'removed' }],
          );
          assert.equal(repeated.disposed, 0);
          assert.deepEqual(
            (
              await admin(
                'SELECT not_run_reason FROM cc.device_import_changes WHERE job_id=$1 AND ordinal=0',
                [plan.jobId],
              )
            ).map((row) => row.not_run_reason),
            ['no-change-needed'],
          );
          // The remaining eligible device executes, and every reason stays.
          const session = await connect('cc-app', 'cc-app');
          let executed;
          try {
            await session.query("SET statement_timeout='300s'");
            await session.query('BEGIN');
            executed = await executePlan(session, {
              jobId: plan.jobId,
              planId: plan.planId,
              revision: plan.revision,
              fieldDevices: [eligible],
            });
            await session.query('COMMIT');
          } catch (error) {
            await session.query('ROLLBACK').catch(() => undefined);
            throw error;
          } finally {
            await close(session);
          }
          assert.equal(
            executed.plan.outcome,
            'executed',
            JSON.stringify(executed.plan),
          );
          assert.equal(executed.plan.linked, 1);
          jobs.push(executed.fieldJob.jobId);
          const counted = (
            await admin(
              `SELECT count(*) FILTER (WHERE linked_job_id IS NOT NULL)::integer AS linked,
                 count(*) FILTER (WHERE not_run_reason='no-change-needed')::integer AS not_run,
                 count(*) FILTER (WHERE linked_job_id IS NULL AND not_run_reason IS NULL)::integer AS open
               FROM cc.device_import_changes WHERE job_id=$1`,
              [plan.jobId],
            )
          )[0];
          assert.deepEqual(counted, { linked: 1, not_run: 50003, open: 0 });
          assert.equal(
            (
              await admin(
                `SELECT c.device_id,c.field,c.linked_job_id FROM cc.device_import_changes c
                 WHERE c.job_id=$1 AND c.linked_job_id IS NOT NULL`,
                [plan.jobId],
              )
            )[0].device_id,
            eligible,
          );
          await retire(executed.fieldJob.displayId);
        },
      );

      await check(
        'S3 the wait keeps a status job queued and admission takes the update job',
        async () => {
          const plan = await importPlan({
            lines: [
              fieldChange(2, 'S3-1'),
              fieldChange(3, 'S3-2'),
              statusChange(4, 'S3-1'),
            ],
          });
          await deviceFixture('S3-1');
          await deviceFixture('S3-2');
          const session = await connect('cc-app', 'cc-app');
          let executed;
          try {
            await session.query('BEGIN');
            executed = await executePlan(session, {
              jobId: plan.jobId,
              planId: plan.planId,
              revision: plan.revision,
              fieldDevices: ['S3-1', 'S3-2'],
              statusDevices: { disable: ['S3-1'] },
            });
            await session.query('COMMIT');
          } catch (error) {
            await session.query('ROLLBACK').catch(() => undefined);
            throw error;
          } finally {
            await close(session);
          }
          assert.equal(executed.plan.outcome, 'executed');
          jobs.push(
            executed.fieldJob.jobId,
            ...executed.statusJobs.map((entry) => entry.jobId),
          );
          const links = await admin(
            `SELECT u.job_id,u.import_job_id,u.wait_for_job_id,j.display_id,j.kind,j.target_count
             FROM cc.device_update_jobs u JOIN cc.jobs j ON j.job_id=u.job_id
             WHERE u.import_job_id=$1 ORDER BY j.kind`,
            [plan.jobId],
          );
          assert.equal(links.length, 2);
          const update = links.find((row) => row.kind === 'device-update');
          const status = links.find((row) => row.kind === 'device-status');
          assert.equal(update.wait_for_job_id, null);
          assert.equal(status.wait_for_job_id, update.job_id);
          assert.equal(update.target_count, 2);
          assert.equal(status.target_count, 1);
          // Admission is customer wide, and an earlier module leaves its write jobs open. The check
          // closes them so its own two candidates hold the only choice.
          await migrator.query(
            `UPDATE cc.jobs SET status='failed',failure=COALESCE(failure,'interrupted'),
               finished_at=clock_timestamp()
             WHERE customer_id=$1 AND kind IN ('device-update','device-command','device-status')
               AND finished_at IS NULL AND job_id<>ALL($2::uuid[])`,
            [customer, [update.job_id, status.job_id]],
          );
          // A quota hold never overrides the required queued state of a waiting job. The status job keeps
          // the queue, and the update job takes the held label alone.
          const held = await result(
            'SELECT cc.admit_device_update_job($1,$2) AS result',
            [customer, true],
          );
          assert.equal(held, null, 'a held admission admits no job');
          assert.equal((await jobRow(status.job_id)).status, 'queued');
          assert.equal((await jobRow(update.job_id)).status, 'held');
          // The status job orders first and still waits, so the update job takes the write slot.
          const admitted = await result(
            'SELECT cc.admit_device_update_job($1,$2) AS result',
            [customer, false],
          );
          assert.equal(admitted.jobId, update.job_id);
          assert.equal(admitted.displayId, update.display_id);
          assert.equal((await jobRow(status.job_id)).status, 'queued');
          const updateRow = await jobRow(update.job_id);
          assert.equal(updateRow.status, 'running');
          assert.notEqual(updateRow.admitted_at, null);
          assert.equal(updateRow.finished_at, null);
          // The awaited job becomes final. The cancel route ends its waiting jobs in the same call, so
          // the fixture finishes this one directly to observe the release.
          await migrator.query(
            "UPDATE cc.jobs SET status='completed',finished_at=clock_timestamp() WHERE job_id=$1",
            [update.job_id],
          );
          const released = await result(
            'SELECT cc.admit_device_update_job($1,$2) AS result',
            [customer, false],
          );
          assert.equal(
            released.jobId,
            status.job_id,
            'the status job runs after its wait ends',
          );
          assert.equal((await jobRow(status.job_id)).status, 'running');
          await retire(status.display_id);
          assert.equal((await jobRow(status.job_id)).status, 'cancelled');
        },
      );

      await check(
        'S3 the cancel of the update job ends each waiting status job with one audit row',
        async () => {
          const plan = await importPlan({
            lines: [fieldChange(2, 'S3C-1'), statusChange(3, 'S3C-1')],
          });
          await deviceFixture('S3C-1');
          const session = await connect('cc-app', 'cc-app');
          let executed;
          try {
            await session.query('BEGIN');
            executed = await executePlan(session, {
              jobId: plan.jobId,
              planId: plan.planId,
              revision: plan.revision,
              fieldDevices: ['S3C-1'],
              statusDevices: { disable: ['S3C-1'] },
            });
            await session.query('COMMIT');
          } catch (error) {
            await session.query('ROLLBACK').catch(() => undefined);
            throw error;
          } finally {
            await close(session);
          }
          assert.equal(executed.plan.outcome, 'executed');
          const update = executed.fieldJob;
          const status = executed.statusJobs[0];
          jobs.push(update.jobId, status.jobId);
          assert.equal((await jobRow(status.jobId)).status, 'accepted');
          const cancelled = await cancelAs(planActor, update.displayId);
          assert.equal(cancelled.outcome, 'requested');
          const updateRow = await jobRow(update.jobId);
          const statusRow = await jobRow(status.jobId);
          assert.equal(updateRow.status, 'cancelled');
          assert.equal(statusRow.status, 'cancelled');
          assert.notEqual(updateRow.finished_at, null);
          assert.equal(
            statusRow.finished_at.toISOString(),
            updateRow.finished_at.toISOString(),
          );
          assert.equal(statusRow.cancel_requested_by, planActor);
          assert.equal(
            statusRow.cancel_requested_at.toISOString(),
            updateRow.cancel_requested_at.toISOString(),
          );
          for (const jobId of [update.jobId, status.jobId])
            assert.deepEqual(
              (
                await admin(
                  'SELECT status FROM cc.device_update_operations WHERE job_id=$1',
                  [jobId],
                )
              ).map((row) => row.status),
              ['cancelled'],
            );
          // One audit row per affected job, with the same actor and correlation ID, and no duplicate
          // when the same request repeats.
          const audits = () =>
            admin(
              `SELECT detail,actor_id,correlation_id FROM cc.security_events
               WHERE event=$1 AND detail=ANY($2::text[])`,
              ['job-cancel-requested', [update.displayId, status.displayId]],
            );
          const first = await audits();
          assert.equal(first.length, 2, 'one audit row per affected job');
          const byDetail = new Map(first.map((row) => [row.detail, row]));
          assert.equal(byDetail.get(update.displayId).actor_id, planActor);
          assert.equal(byDetail.get(status.displayId).actor_id, planActor);
          assert.equal(
            byDetail.get(update.displayId).correlation_id,
            byDetail.get(status.displayId).correlation_id,
          );
          const repeated = await cancelAs(planActor, update.displayId);
          assert.equal(repeated.outcome, 'repeated');
          assert.equal(
            (await audits()).length,
            2,
            'a repeat writes no audit row',
          );
        },
      );

      await check(
        'S3 the cancel locks each waiting status header in display ID order across the rollover',
        async () => {
          const taken = (
            await admin(
              "SELECT count(*)::integer AS rows FROM cc.jobs WHERE display_id IN ('STS-999','STS-1000')",
            )
          )[0].rows;
          assert.equal(taken, 0, 'the rollover display IDs are free');
          const plan = await importPlan({
            lines: [
              fieldChange(2, 'S3D-1'),
              statusChange(3, 'S3D-1', 'disable'),
              statusChange(4, 'S3D-1', 'reenable'),
            ],
          });
          await deviceFixture('S3D-1');
          await migrator.query("SELECT setval('cc.job_number_sts',998,true)");
          const session = await connect('cc-app', 'cc-app');
          let executed;
          try {
            await session.query('BEGIN');
            executed = await executePlan(session, {
              jobId: plan.jobId,
              planId: plan.planId,
              revision: plan.revision,
              fieldDevices: ['S3D-1'],
              statusDevices: { disable: ['S3D-1'], reenable: ['S3D-1'] },
            });
            await session.query('COMMIT');
          } catch (error) {
            await session.query('ROLLBACK').catch(() => undefined);
            throw error;
          } finally {
            await close(session);
          }
          assert.equal(executed.plan.outcome, 'executed');
          const update = executed.fieldJob;
          const statuses = executed.statusJobs;
          assert.deepEqual(
            statuses.map((entry) => entry.displayId),
            ['STS-999', 'STS-1000'],
            'the rollover display IDs',
          );
          jobs.push(update.jobId, ...statuses.map((entry) => entry.jobId));
          const holder = await connect('postgres', 'cc-app');
          const waiter = await connect('cc-app', 'cc-app');
          // The probe takes a row lock of its own, and cc-app holds only SELECT on cc.jobs.
          const probe = await connect('postgres', 'cc-app');
          let pending = null;
          try {
            await holder.query('BEGIN');
            await holder.query(
              "SELECT 1 FROM cc.jobs WHERE display_id='STS-999' FOR UPDATE",
            );
            const holderPid = await backendPid(holder);
            const waiterPid = await backendPid(waiter);
            pending = waiter
              .query('SELECT cc.request_job_cancel($1,$2,$3,$4,$5) AS result', [
                planActor,
                1,
                customer,
                update.displayId,
                randomUUID(),
              ])
              .then((r) => r.rows[0].result);
            await waitBlocked(waiterPid, holderPid, 'the cascade cancel');
            // Display ID order locks STS-1000 before STS-999, so the canceller holds STS-1000 while it
            // waits for the holder of STS-999. Creation order would leave STS-1000 unlocked.
            await rejects(
              probe.query(
                "SELECT 1 FROM cc.jobs WHERE display_id='STS-1000' FOR UPDATE NOWAIT",
              ),
              '55P03',
            );
            await holder.query('COMMIT');
            assert.equal((await pending).outcome, 'requested');
          } finally {
            await holder.query('ROLLBACK').catch(() => undefined);
            await pending?.catch(() => undefined);
            await close(holder);
            await close(waiter);
            await close(probe);
          }
          for (const entry of statuses)
            assert.equal((await jobRow(entry.jobId)).status, 'cancelled');
        },
      );

      await check(
        'S3 a job cancel races Execute and admission without a deadlock',
        async () => {
          const plan = await importPlan({ lines: [fieldChange(2, 'S3R-1')] });
          await deviceFixture('S3R-1');
          const executor = await connect('cc-app', 'cc-app');
          const canceller = await connect('cc-app', 'cc-app');
          try {
            await executor.query("SET statement_timeout='20s'");
            await canceller.query("SET statement_timeout='20s'");
            await executor.query('BEGIN');
            const locked = await planLock(
              planActor,
              1,
              plan.jobId,
              plan.planId,
              plan.revision,
              executor,
            );
            assert.equal(locked.outcome, 'locked');
            const executorPid = await backendPid(executor);
            const cancellerPid = await backendPid(canceller);
            const pending = canceller
              .query('SELECT cc.request_job_cancel($1,$2,$3,$4,$5) AS result', [
                planActor,
                1,
                customer,
                plan.displayId,
                randomUUID(),
              ])
              .then((r) => r.rows[0].result)
              .catch((error) => error);
            await waitBlocked(cancellerPid, executorPid);
            await executor.query('COMMIT');
            const answer = await pending;
            assert.equal(
              answer.detail,
              'job-finished',
              'the finished validation job refuses a cancel',
            );
            // Admission and the cancel of one write job take the admission lock in one order.
            const statusPlan = await importPlan({
              lines: [fieldChange(2, 'S3R-2'), statusChange(3, 'S3R-2')],
            });
            await deviceFixture('S3R-2');
            await executor.query('BEGIN');
            const statusExecuted = await executePlan(executor, {
              jobId: statusPlan.jobId,
              planId: statusPlan.planId,
              revision: statusPlan.revision,
              fieldDevices: ['S3R-2'],
              statusDevices: { disable: ['S3R-2'] },
            });
            await executor.query('COMMIT');
            assert.equal(statusExecuted.plan.outcome, 'executed');
            jobs.push(
              statusExecuted.fieldJob.jobId,
              ...statusExecuted.statusJobs.map((entry) => entry.jobId),
            );
            const [admission, cancellation] = await Promise.all([
              executor
                .query('SELECT cc.admit_device_update_job($1,$2) AS result', [
                  customer,
                  false,
                ])
                .then((r) => r.rows[0].result)
                .catch((error) => error),
              canceller
                .query(
                  'SELECT cc.request_job_cancel($1,$2,$3,$4,$5) AS result',
                  [
                    planActor,
                    1,
                    customer,
                    statusExecuted.fieldJob.displayId,
                    randomUUID(),
                  ],
                )
                .then((r) => r.rows[0].result)
                .catch((error) => error),
            ]);
            assert.equal(
              admission?.code,
              undefined,
              'admission holds no deadlock',
            );
            assert.equal(
              cancellation?.code,
              undefined,
              'the cancel holds no deadlock',
            );
            assert.equal(
              (await jobRow(statusExecuted.fieldJob.jobId)).status,
              'cancelled',
            );
          } finally {
            await executor.query('ROLLBACK').catch(() => undefined);
            await canceller.query('ROLLBACK').catch(() => undefined);
            await close(executor);
            await close(canceller);
          }
        },
      );

      await check(
        'S3 the plan cancel repeats the enabled, version, grant, and visibility checks',
        async () => {
          const platformAdmin = (
            await admin(
              `SELECT p.id,p.permission_version FROM cc.application_principals p
               WHERE cc.full_platform_administrator(p.id) ORDER BY p.created_at,p.id LIMIT 1`,
            )
          )[0];
          assert.ok(platformAdmin, 'a platform administrator exists');
          const grants = [
            { action: 'devices:read', scope: district() },
            { action: 'devices:write', scope: district() },
            { action: 'devices:bulk-actions', scope: district() },
          ];
          const changeAccess = async (target, version, enabled, next) => {
            await migrator.query(
              'SELECT cc.change_platform_access($1,$2,$3,$4,$5,$6,$7,$8) AS result',
              [
                platformAdmin.id,
                platformAdmin.permission_version,
                target,
                version,
                enabled,
                JSON.stringify(next),
                randomUUID(),
                '[]',
              ],
            );
          };
          const target = await principal(
            grants.map(({ action, scope }) => [action, scope]),
          );
          const plan = await importPlan({
            actor: target,
            lines: [fieldChange(2, 'S3A-1')],
          });
          const holder = await connect('postgres', 'cc-app');
          const waiter = await connect('cc-app', 'cc-app');
          const duringWait = async (version) => {
            await holder.query('BEGIN');
            await holder.query(
              'SELECT 1 FROM cc.jobs WHERE job_id=$1 FOR UPDATE',
              [plan.jobId],
            );
            const holderPid = await backendPid(holder);
            const waiterPid = await backendPid(waiter);
            const pending = planCancel(
              target,
              version,
              plan.jobId,
              plan.planId,
              plan.revision,
              waiter,
            );
            await waitBlocked(
              waiterPid,
              holderPid,
              `plan cancel at version ${version}`,
            );
            // A returned thenable would adopt the blocked query in the async helper.
            return { pending };
          };
          try {
            // The enabled state changes during the wait.
            const first = await duringWait(1);
            await changeAccess(target, 1, false, grants);
            await holder.query('COMMIT');
            assert.equal((await first.pending).outcome, 'not-found');
            assert.equal((await planDetail(plan.jobId)).plan_state, 'open');
            // Enable the person again, so the next call reaches the header wait.
            await changeAccess(target, 2, true, [
              ...grants,
              { action: 'devices:status', scope: district() },
            ]);
            // The permission version changes during the wait.
            const second = await duringWait(3);
            await changeAccess(target, 3, true, [
              ...grants,
              { action: 'devices:status', scope: district() },
              { action: 'devices:commands', scope: district() },
            ]);
            await holder.query('COMMIT');
            assert.equal((await second.pending).outcome, 'not-found');
            assert.equal((await planDetail(plan.jobId)).plan_state, 'open');
            // A grant leaves and the caller holds the current version. Any grant change bumps the
            // version as well, so a grant change during a wait refuses through the version check.
            // The grant check answers a caller whose version is current.
            await changeAccess(target, 4, true, [
              { action: 'devices:read', scope: district() },
              { action: 'devices:write', scope: district() },
            ]);
            const withoutGrant = await planCancel(
              target,
              5,
              plan.jobId,
              plan.planId,
              plan.revision,
            );
            assert.equal(withoutGrant.outcome, 'forbidden');
            assert.equal((await planDetail(plan.jobId)).plan_state, 'open');
            // The visibility check refuses a person who does not request the plan.
            assert.equal(
              (
                await planCancel(
                  planWatcher,
                  1,
                  plan.jobId,
                  plan.planId,
                  plan.revision,
                )
              ).outcome,
              'not-found',
            );
            // Control: the authority stays valid, and the plan cancels.
            await changeAccess(target, 5, true, grants);
            const control = await planCancel(
              target,
              6,
              plan.jobId,
              plan.planId,
              plan.revision,
            );
            assert.equal(control.outcome, 'cancelled');
            assert.deepEqual(
              (
                await admin(
                  'SELECT array_agg(action ORDER BY action) AS actions FROM cc.application_grants WHERE principal_id=$1',
                  [target],
                )
              )[0].actions,
              grants.map(({ action }) => action).sort(),
            );
          } finally {
            await holder.query('ROLLBACK').catch(() => undefined);
            await close(holder);
            await close(waiter);
          }
        },
      );

      await check(
        'S2 the plan cancel repeats its authority after the requester and connection waits',
        async () => {
          const platformAdmin = (
            await admin(
              `SELECT p.id,p.permission_version FROM cc.application_principals p
               WHERE cc.full_platform_administrator(p.id) ORDER BY p.created_at,p.id LIMIT 1`,
            )
          )[0];
          assert.ok(platformAdmin, 'a platform administrator exists');
          const grants = [
            { action: 'devices:read', scope: district() },
            { action: 'devices:write', scope: district() },
            { action: 'devices:bulk-actions', scope: district() },
          ];
          const changeAccess = (
            client,
            target,
            version,
            enabled,
            next = grants,
          ) =>
            client.query(
              'SELECT cc.change_platform_access($1,$2,$3,$4,$5,$6,$7,$8) AS result',
              [
                platformAdmin.id,
                platformAdmin.permission_version,
                target,
                version,
                enabled,
                JSON.stringify(next),
                randomUUID(),
                '[]',
              ],
            );
          const makeTarget = () =>
            principal(grants.map(({ action, scope }) => [action, scope]));
          // The plan state, the header revision, the publications, and the audit rows of one plan.
          const snapshot = async (plan) => {
            const detail = await planDetail(plan.jobId);
            const header = (
              await admin('SELECT revision FROM cc.jobs WHERE job_id=$1', [
                plan.jobId,
              ])
            )[0];
            const publications = (
              await admin(
                'SELECT count(*)::integer AS rows FROM cc.job_publications WHERE job_id=$1',
                [plan.jobId],
              )
            )[0].rows;
            const audits = (
              await admin(
                "SELECT count(*)::integer AS rows FROM cc.security_events WHERE event='job-cancel-requested' AND detail=$1",
                [plan.displayId],
              )
            )[0].rows;
            return {
              state: detail.plan_state,
              planRevision: detail.plan_revision,
              revision: header.revision,
              publications,
              audits,
            };
          };
          const lockRequester = (client, target) =>
            client.query(
              'SELECT 1 FROM cc.application_principals WHERE id=$1 FOR UPDATE',
              [target],
            );
          const lockConnection = (client) =>
            client.query(
              'SELECT 1 FROM cc.google_connection WHERE customer_id=$1 FOR UPDATE',
              [customer],
            );
          // One case: the holder locks one row, the cancel waits on it, the case changes access or
          // waits for the plan to expire, and the holder commits. Each case takes a fresh person at
          // permission version 1, so a later case is not refused by an earlier case's version move.
          const caseRun = async ({
            label,
            lock,
            during,
            expected,
            interval = '1 hour',
          }) => {
            const target = await makeTarget();
            const plan = await importPlan({
              actor: target,
              lines: [fieldChange(2, `S2W-${label.length}`)],
            });
            await migrator.query(
              `UPDATE cc.device_import_jobs
               SET plan_expires_at=clock_timestamp()+$2::interval WHERE job_id=$1`,
              [plan.jobId, interval],
            );
            const before = await snapshot(plan);
            assert.equal(before.state, 'open', label);
            const holder = await connect('postgres', 'cc-app');
            const waiter = await connect('cc-app', 'cc-app');
            let answer;
            let pending = null;
            try {
              await holder.query('BEGIN');
              await lock(holder, target);
              const holderPid = await backendPid(holder);
              const waiterPid = await backendPid(waiter);
              pending = planCancel(
                target,
                1,
                plan.jobId,
                plan.planId,
                plan.revision,
                waiter,
              );
              await waitBlocked(
                waiterPid,
                holderPid,
                `the plan cancel at ${label}`,
              );
              if (during) await during({ holder, waiter, plan, target });
              await holder.query('COMMIT');
              answer = await pending;
            } finally {
              await holder.query('ROLLBACK').catch(() => undefined);
              await pending?.catch(() => undefined);
              await close(holder);
              await close(waiter);
            }
            assert.equal(
              answer.outcome,
              expected,
              `${label}: ${JSON.stringify(answer)}`,
            );
            const after = await snapshot(plan);
            if (expected === 'cancelled') {
              assert.equal(after.state, 'cancelled', label);
              assert.equal(after.planRevision, before.planRevision + 1, label);
              assert.equal(after.publications, before.publications + 1, label);
              assert.equal(after.audits, before.audits, label);
            } else {
              assert.deepEqual(after, before, `${label} writes nothing`);
            }
          };
          // A disable that commits during the requester wait refuses the call and writes nothing.
          await caseRun({
            label: 'the requester wait',
            lock: lockRequester,
            during: ({ holder, target }) =>
              changeAccess(holder, target, 1, false),
            expected: 'not-found',
          });
          // A permission version that changes during the connection wait refuses the call.
          await caseRun({
            label: 'the connection wait',
            lock: lockConnection,
            during: ({ target }) =>
              changeAccess(migrator, target, 1, true, [
                ...grants,
                { action: 'devices:status', scope: district() },
              ]),
            expected: 'not-found',
          });
          // A grant that a later change removes during the connection wait refuses the call. The
          // production change also moves the permission version, so the test restores the version to
          // hold it fixed and leave the grant check as the only difference.
          await caseRun({
            label: 'the connection wait grant',
            lock: lockConnection,
            during: async ({ target }) => {
              await changeAccess(migrator, target, 1, true, grants.slice(0, 2));
              await migrator.query(
                'UPDATE cc.application_principals SET permission_version=1 WHERE id=$1',
                [target],
              );
            },
            expected: 'forbidden',
          });
          // A plan that expires during the connection wait answers expired and stays open.
          await caseRun({
            label: 'the connection wait expiry',
            lock: lockConnection,
            during: ({ holder }) => holder.query('SELECT pg_sleep(2.5)'),
            expected: 'expired',
            interval: '2 seconds',
          });
          // Controls: unchanged access through both waits cancels the plan.
          await caseRun({
            label: 'the requester wait control',
            lock: lockRequester,
            expected: 'cancelled',
          });
          await caseRun({
            label: 'the connection wait control',
            lock: lockConnection,
            expected: 'cancelled',
          });
        },
      );

      await check(
        'S4 50,000 short rows and 50,000 4,096-unit paths each execute in one transaction',
        async () => {
          const run = async (label, count, valueFor, deviceFor) => {
            const devices = Array.from({ length: count }, (_, index) =>
              deviceFor(index),
            );
            const lines = devices.map((deviceId, index) =>
              fieldChange(index + 2, deviceId, {
                field: 'orgUnitPath',
                mode: 'move',
                currentValue: `/Old/${index}`,
                newValue: valueFor(index),
              }),
            );
            const plan = await importPlan({ lines });
            const session = await connect('cc-app', 'cc-app');
            const started = process.hrtime.bigint();
            let executed;
            try {
              await session.query("SET statement_timeout='900s'");
              await session.query('BEGIN');
              executed = await executePlan(session, {
                jobId: plan.jobId,
                planId: plan.planId,
                revision: plan.revision,
                fieldDevices: devices,
                field: 'orgUnitPath',
                requestFor: (deviceId, index) => valueFor(index),
                baselineFor: (index) => `/Old/${index}`,
              });
              await session.query('COMMIT');
            } catch (error) {
              await session.query('ROLLBACK').catch(() => undefined);
              throw error;
            } finally {
              await close(session);
            }
            const elapsed = Number(process.hrtime.bigint() - started) / 1e9;
            assert.equal(executed.plan.outcome, 'executed');
            assert.equal(executed.plan.linked, count);
            const job = executed.plan.receipts[0];
            jobs.push(job.jobId);
            assert.equal(job.updateCount, count);
            for (const table of [
              'device_update_operations',
              'device_update_operation_fields',
            ])
              assert.equal(
                (
                  await admin(
                    `SELECT count(*)::integer AS rows FROM cc.${table} WHERE job_id=$1`,
                    [job.jobId],
                  )
                )[0].rows,
                count,
                table,
              );
            const sealed = (
              await admin(
                'SELECT selected,field_changes FROM cc.device_update_previews WHERE job_id=$1',
                [job.jobId],
              )
            )[0];
            assert.equal(sealed.selected, count);
            assert.equal(sealed.field_changes, count);
            process.stderr.write(
              `check S4 ${label}: ${count} changes executed in one transaction in ${elapsed.toFixed(2)} s\n`,
            );
            results.push(
              `S4 ${label}: ${count} changes in one transaction in ${elapsed.toFixed(2)} s: pass`,
            );
            await retire(job.displayId);
          };
          await run(
            'short rows',
            50000,
            (index) => `/Site/${index % 97}/Room ${index}`,
            (index) => `S4S-${index}`,
          );
          const longPath = (index) => {
            const head = `/Site ${index}/`;
            const tail = `Room ${index}`;
            return head + 'x'.repeat(4096 - head.length - tail.length) + tail;
          };
          assert.equal(longPath(0).length, 4096);
          assert.equal(longPath(49999).length, 4096);
          await run(
            '4,096-unit paths',
            50000,
            longPath,
            (index) => `S4L-${index}`,
          );
        },
      );

      await check(
        'S5 the purge keeps write jobs and removes the lines and targets after 30 days',
        async () => {
          await deviceFixture('S5-1');
          const exported = await createExport({
            actor: exporter,
            devices: ['S5-1', 'S5-2'],
          });
          jobs.push(exported.receipt.jobId);
          const exportLease = randomUUID();
          assert.equal(
            (await claimExport(exported.receipt.jobId, exportLease)).outcome,
            'claimed',
          );
          await finishExport(exported.receipt.jobId, exportLease, exportFile());
          const imported = await importPlan({
            lines: [
              fieldChange(2, 'S5-1'),
              {
                kind: 'rejection',
                sourceRow: 3,
                deviceId: 'S5-2',
                column: 'Status',
                submittedValue: 'nope',
                reason: 'The Status cell is invalid.',
              },
              {
                kind: 'warning',
                sourceRow: 4,
                deviceId: 'S5-3',
                warning: 'Unknown column.',
              },
            ],
          });
          const recent = await importPlan({ lines: [fieldChange(2, 'S5-4')] });
          const opened = await openPreview(planActor, 1, 'annotated-location');
          assert.equal(opened.outcome, 'opened');
          const previewId = opened.preview.preview_id;
          assert.equal(
            (
              await addTargets(planActor, 1, previewId, [
                fieldTarget(0, 'S5-1', 'notes', 'kept', 'old'),
              ])
            ).outcome,
            'added',
          );
          const digest = digestFor(['S5-1']);
          assert.equal(
            (await sealPreview(planActor, 1, previewId, digest)).outcome,
            'sealed',
          );
          const writeJob = await confirmPreview(
            planActor,
            1,
            previewId,
            digest,
            await publishArtifact(),
          );
          assert.equal(writeJob.outcome, 'created');
          jobs.push(writeJob.receipt.jobId);
          await migrator.query(
            `UPDATE cc.jobs SET finished_at=clock_timestamp()-interval '31 days'
             WHERE job_id=ANY($1::uuid[])`,
            [[exported.receipt.jobId, imported.jobId, writeJob.receipt.jobId]],
          );
          await migrator.query(
            `UPDATE cc.jobs SET finished_at=clock_timestamp()-interval '29 days'
             WHERE job_id=$1`,
            [recent.jobId],
          );
          const purged = await result('SELECT cc.purge_jobs($1,$2) AS result', [
            customer,
            10000,
          ]);
          assert.ok(purged >= 2, `the purge removed ${purged} jobs`);
          const lineRows = async (table, jobId) =>
            (
              await admin(
                `SELECT count(*)::integer AS rows FROM cc.${table} WHERE job_id=$1`,
                [jobId],
              )
            )[0].rows;
          assert.equal(
            await lineRows('device_export_targets', exported.receipt.jobId),
            0,
          );
          for (const table of [
            'device_import_changes',
            'device_import_rejections',
            'device_import_warnings',
          ])
            assert.equal(await lineRows(table, imported.jobId), 0, table);
          // The header and the plan state stay, and a 29-day report stays whole.
          assert.equal(
            (
              await admin(
                'SELECT count(*)::integer AS rows FROM cc.device_export_jobs WHERE job_id=$1',
                [exported.receipt.jobId],
              )
            )[0].rows,
            1,
          );
          assert.equal((await planDetail(imported.jobId)).plan_state, 'open');
          assert.equal(
            await lineRows('device_import_changes', recent.jobId),
            1,
          );
          // The write job, its operations, and its field rows never leave.
          assert.equal(
            (
              await admin(
                'SELECT count(*)::integer AS rows FROM cc.jobs WHERE job_id=$1',
                [writeJob.receipt.jobId],
              )
            )[0].rows,
            1,
          );
          assert.equal(
            await lineRows('device_update_operations', writeJob.receipt.jobId),
            1,
          );
          assert.equal(
            await lineRows(
              'device_update_operation_fields',
              writeJob.receipt.jobId,
            ),
            1,
          );
        },
      );
    } finally {
      // The module leaves no fixture behind, and the preview rows that name a job leave first.
      const swallow = (promise) => promise.catch(() => undefined);
      await swallow(
        migrator.query(
          'DELETE FROM cc.application_access_changes WHERE principal_id=ANY($1::uuid[])',
          [principals],
        ),
      );
      await swallow(
        migrator.query(
          'DELETE FROM cc.security_events WHERE actor_id=ANY($1::uuid[])',
          [principals],
        ),
      );
      await swallow(
        migrator.query(
          'UPDATE cc.device_update_previews SET job_id=NULL WHERE created_by=ANY($1::uuid[])',
          [principals],
        ),
      );
      if (jobs.length)
        await swallow(
          migrator.query(
            'DELETE FROM cc.device_update_jobs WHERE job_id=ANY($1::uuid[])',
            [jobs],
          ),
        );
      await swallow(
        migrator.query(
          'DELETE FROM cc.device_update_previews WHERE customer_id=$1 AND created_by=ANY($2::uuid[])',
          [customer, principals],
        ),
      );
      if (artifacts.length)
        await swallow(
          migrator.query('DELETE FROM cc.artifacts WHERE id=ANY($1::text[])', [
            artifacts,
          ]),
        );
      if (managedDevices.length)
        await swallow(
          migrator.query(
            'DELETE FROM cc.devices WHERE customer_id=$1 AND device_id=ANY($2::text[])',
            [customer, managedDevices],
          ),
        );
      if (!wasActive)
        await swallow(
          migrator.query('UPDATE cc.google_connection SET active=false'),
        );
    }

    // ===== XB9: the uploaded file, its link to the job, and the claim of an upload or revalidation =====
    // `cc.claim_device_import_job` answers the newest ready artifact of the job, and the worker reads
    // the file from that answer (design section 6). The upload links the staged file in the same
    // transaction that creates the job; a revalidation moves the link to its new job.
    const linkedArtifacts = [];
    try {
      const seedArtifact = async ({
        sizeBytes = 2048,
        state = 'ready',
        retention = '30 days',
        jobId = null,
      } = {}) => {
        const id = randomUUID();
        const attempt = randomUUID();
        await migrator.query(
          `INSERT INTO cc.artifacts(id,backend,locator,schema_version,attempt_id,sha256,size_bytes,
             publication_state,active,reference_count,retention_until,job_id)
           VALUES($1,'local',$2,1,$3,$4,$5,$6,false,0,clock_timestamp()+$7::interval,$8)`,
          [
            id,
            `${id}.${attempt}`,
            attempt,
            'b'.repeat(64),
            sizeBytes,
            state,
            retention,
            jobId,
          ],
        );
        linkedArtifacts.push(id);
        return id;
      };
      const artifactRow = (id) =>
        admin(
          'SELECT job_id,reference_count,publication_state FROM cc.artifacts WHERE id=$1',
          [id],
        ).then((rows) => rows[0]);
      const jobCount = () =>
        admin('SELECT count(*)::integer AS rows FROM cc.jobs').then(
          (rows) => rows[0].rows,
        );

      await check(
        'an upload links its file, and the claim of the job answers it',
        async () => {
          const importer = await principal(importGrants());
          const artifact = await seedArtifact();
          const created = await createImport({
            actor: importer,
            artifactId: artifact,
          });
          assert.equal(created.outcome, 'created');
          jobs.push(created.receipt.jobId);
          const claimed = await claimImport(
            created.receipt.jobId,
            randomUUID(),
          );
          assert.equal(claimed.outcome, 'claimed');
          assert.equal(claimed.sourceArtifactId, artifact);
          const row = await artifactRow(artifact);
          assert.equal(row.job_id, created.receipt.jobId);
          assert.equal(
            row.reference_count,
            0,
            'the link holds no reference, so the purge may remove the file',
          );
          assert.equal(row.publication_state, 'ready');
        },
      );

      await check(
        'a revalidation moves the link, and both claims answer the file',
        async () => {
          const importer = await principal(importGrants());
          const artifact = await seedArtifact();
          const first = await createImport({
            actor: importer,
            artifactId: artifact,
          });
          jobs.push(first.receipt.jobId);
          const firstLease = randomUUID();
          const before = await claimImport(first.receipt.jobId, firstLease);
          assert.equal(before.sourceArtifactId, artifact);
          const second = await createImport({
            actor: importer,
            artifactId: artifact,
          });
          jobs.push(second.receipt.jobId);
          assert.notEqual(second.receipt.jobId, first.receipt.jobId);
          assert.match(second.receipt.displayId, /^IMP-\d{3,}$/);
          assert.equal(
            (await claimImport(second.receipt.jobId, randomUUID()))
              .sourceArtifactId,
            artifact,
          );
          assert.equal(
            (await artifactRow(artifact)).job_id,
            second.receipt.jobId,
          );
          const stale = await claimImport(first.receipt.jobId, firstLease);
          assert.equal(
            stale.sourceArtifactId,
            null,
            'the named job no longer links the file',
          );
        },
      );

      await check(
        'a file that is unfinished, stale, missing, or another size answers no link',
        async () => {
          const importer = await principal(importGrants());
          const before = await jobCount();
          const cases = [
            [
              'an unfinished upload',
              await seedArtifact({ state: 'staging' }),
              2048,
            ],
            [
              'a file past its retention',
              await seedArtifact({ retention: '-1 day' }),
              2048,
            ],
            ['a missing file', randomUUID(), 2048],
            ['another size', await seedArtifact(), 4096],
          ];
          for (const [name, artifact, sizeBytes] of cases) {
            const answer = await createImport({
              actor: importer,
              artifactId: artifact,
              sizeBytes,
            });
            assert.equal(answer.outcome, 'artifact-unavailable', name);
            const row = await artifactRow(artifact);
            if (row) assert.equal(row.job_id, null, `${name} links nothing`);
          }
          assert.equal(
            await jobCount(),
            before,
            'a refused link creates no job',
          );
        },
      );

      await check('a file id of another length refuses the call', async () => {
        const importer = await principal(importGrants());
        // A Drive file ID holds 1 to 128 letters, digits, hyphens, or underscores (design section 1).
        await rejects(
          createImport({
            actor: importer,
            sourceType: 'drive-csv',
            fileId: 'x'.repeat(129),
            subject: 'reader@example.org',
          }),
          '22023',
        );
        await rejects(
          createImport({
            actor: importer,
            sourceType: 'drive-csv',
            fileId: 'example/file',
            subject: 'reader@example.org',
          }),
          '22023',
        );
      });
    } finally {
      // The module leaves no fixture behind for the modules that follow it.
      if (linkedArtifacts.length)
        await migrator
          .query('DELETE FROM cc.artifacts WHERE id=ANY($1::text[])', [
            linkedArtifacts,
          ])
          .catch(() => undefined);
    }

    // ===== DB3: the Drive settings and the Sheet and Drive job functions (design sections 3, 6, 7) =====
    // The settings row and its audit rows name this module's principals, so this block removes them
    // before the outer cleanup removes those principals.
    const driveArtifacts = [];
    const seedDriveArtifact = async (
      sizeBytes = 2048,
      { state = 'ready', retention = '30 days', jobId = null } = {},
    ) => {
      const id = randomUUID();
      const attempt = randomUUID();
      await migrator.query(
        `INSERT INTO cc.artifacts(id,backend,locator,schema_version,attempt_id,sha256,size_bytes,
           publication_state,active,reference_count,retention_until,job_id)
         VALUES($1,'local',$2,1,$3,$4,$5,$6,false,0,clock_timestamp()+$7::interval,$8)`,
        [
          id,
          `${id}.${attempt}`,
          attempt,
          'b'.repeat(64),
          sizeBytes,
          state,
          retention,
          jobId,
        ],
      );
      driveArtifacts.push(id);
      return id;
    };
    const settingsEvents = () =>
      admin(
        `SELECT * FROM cc.security_events WHERE event='drive-settings-changed'
          ORDER BY occurred_at,id`,
      );
    /** One Drive import of a Sheet tab, with the example values of the design. */
    const driveSheetImport = (overrides = {}) =>
      createImport({
        actor: importer,
        sourceType: 'drive-sheet',
        name: 'Devices',
        sizeBytes: 2048,
        fileId: 'example-sheet-file-1',
        tabId: 0,
        tabTitle: 'Devices',
        subject: 'reader@example.org',
        ...overrides,
      });
    /** A pending call of a race check, so no promise is left floating when a client closes. */
    const settle = (promise) =>
      promise.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
    /** A race client reports a closed connection as a settled result, never as a process error. */
    const raceClient = async (user) => {
      const client = await connect(user, 'cc-app');
      client.on('error', () => undefined);
      return client;
    };
    /**
     * Wait until the call on that client waits on a lock. `pg_locks` reports the ungranted request
     * for every role, while `pg_stat_activity` masks the wait columns of another role's session.
     */
    const waitWaiting = async (pid, label) => {
      let last = null;
      for (let attempt = 0; attempt < 250; attempt += 1) {
        const row = (
          await migrator.query(
            `SELECT (SELECT count(*)::integer FROM pg_locks WHERE pid=$1 AND NOT granted) AS waits,
              cardinality(pg_blocking_pids($1)) AS blockers`,
            [pid],
          )
        ).rows[0];
        last = row ?? null;
        if (row && (row.waits > 0 || row.blockers > 0)) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`${label} never waited: ${JSON.stringify(last)}`);
    };
    try {
      await check(
        'S2 a Sheet export and both Drive sources pass their checks',
        async () => {
          const exported = await createExport({
            actor: exporter,
            format: 'sheet',
            subject: 'editor@example.org',
          });
          jobs.push(exported.receipt.jobId);
          assert.equal(exported.outcome, 'created');
          assert.equal(exported.receipt.rows, 3);
          const sheet = (
            await admin('SELECT * FROM cc.device_export_jobs WHERE job_id=$1', [
              exported.receipt.jobId,
            ])
          )[0];
          assert.equal(sheet.format, 'sheet');
          assert.equal(sheet.purpose, 'edit');
          assert.equal(sheet.drive_subject, 'editor@example.org');
          assert.equal(sheet.sheet_started_at, null);
          assert.equal(sheet.spreadsheet_id, null);
          assert.equal(sheet.file_name, null);
          // A Sheet writes the edit template and names its subject. A CSV names none.
          await rejects(
            createExport({
              actor: exporter,
              purpose: 'report',
              columns: ['status'],
              format: 'sheet',
              subject: 'editor@example.org',
            }),
            '22023',
          );
          await rejects(
            createExport({ actor: exporter, format: 'sheet' }),
            '22023',
          );
          await rejects(
            createExport({
              actor: exporter,
              format: 'csv',
              subject: 'editor@example.org',
            }),
            '22023',
          );
          await rejects(
            createExport({ actor: exporter, format: 'sheet', subject: 'xx' }),
            '22023',
          );
          await rejects(
            createExport({
              actor: exporter,
              format: 'sheet',
              subject: 'x'.repeat(255),
            }),
            '22023',
          );
          // The table checks hold the same rules.
          await rejects(
            migrator.query(
              "UPDATE cc.device_export_jobs SET format='pdf' WHERE job_id=$1",
              [exported.receipt.jobId],
            ),
            '23514',
          );
          await rejects(
            migrator.query(
              "UPDATE cc.device_export_jobs SET purpose='report' WHERE job_id=$1",
              [exported.receipt.jobId],
            ),
            '23514',
          );
          await rejects(
            migrator.query(
              'UPDATE cc.device_export_jobs SET drive_subject=NULL WHERE job_id=$1',
              [exported.receipt.jobId],
            ),
            '23514',
          );
          await rejects(
            migrator.query(
              "UPDATE cc.device_export_jobs SET file_name='devices-for-editing-EXP-001' WHERE job_id=$1",
              [exported.receipt.jobId],
            ),
            '23514',
          );
          await rejects(
            migrator.query(
              "UPDATE cc.device_export_jobs SET spreadsheet_id='example-sheet-1' WHERE job_id=$1",
              [exported.receipt.jobId],
            ),
            '23514',
          );
          await rejects(
            migrator.query(
              `UPDATE cc.device_export_jobs SET file_name='devices',file_artifact_id='a',
                 spreadsheet_id='example-sheet-1' WHERE job_id=$1`,
              [exported.receipt.jobId],
            ),
            '23514',
          );
          const csv = await createExport({ actor: exporter });
          jobs.push(csv.receipt.jobId);
          await rejects(
            migrator.query(
              'UPDATE cc.device_export_jobs SET drive_subject=$2 WHERE job_id=$1',
              [csv.receipt.jobId, 'editor@example.org'],
            ),
            '23514',
          );
          await rejects(
            migrator.query(
              'UPDATE cc.device_export_jobs SET sheet_started_at=clock_timestamp() WHERE job_id=$1',
              [csv.receipt.jobId],
            ),
            '23514',
          );
          await rejects(
            migrator.query(
              `UPDATE cc.device_export_jobs SET file_name='devices.csv',file_row_count=3,
                 file_column_count=10,spreadsheet_id='example-sheet-1' WHERE job_id=$1`,
              [csv.receipt.jobId],
            ),
            '23514',
          );
          // The two Drive source types pass, and each names its own fields.
          const sheetSource = await driveSheetImport();
          jobs.push(sheetSource.receipt.jobId);
          assert.equal(sheetSource.outcome, 'created');
          const driveSheet = (
            await admin('SELECT * FROM cc.device_import_jobs WHERE job_id=$1', [
              sheetSource.receipt.jobId,
            ])
          )[0];
          assert.equal(driveSheet.source_type, 'drive-sheet');
          assert.equal(driveSheet.source_file_id, 'example-sheet-file-1');
          assert.equal(driveSheet.source_tab_id, 0);
          assert.equal(driveSheet.source_tab_title, 'Devices');
          assert.equal(driveSheet.drive_subject, 'reader@example.org');
          assert.equal(Number(driveSheet.source_size_bytes), 2048);
          const csvSource = await createImport({
            actor: importer,
            sourceType: 'drive-csv',
            name: 'devices.csv',
            sizeBytes: 1024,
            fileId: 'example-csv-file-1',
            subject: 'reader@example.org',
          });
          jobs.push(csvSource.receipt.jobId);
          assert.equal(csvSource.outcome, 'created');
          const driveCsv = (
            await admin('SELECT * FROM cc.device_import_jobs WHERE job_id=$1', [
              csvSource.receipt.jobId,
            ])
          )[0];
          assert.equal(driveCsv.source_type, 'drive-csv');
          assert.equal(driveCsv.source_file_id, 'example-csv-file-1');
          assert.equal(driveCsv.source_tab_id, null);
          assert.equal(driveCsv.source_tab_title, null);
          assert.equal(driveCsv.drive_subject, 'reader@example.org');
          // A Drive source names its file and its subject, a Sheet adds its tab, and a CSV upload names
          // none of them.
          await rejects(
            driveSheetImport({ tabId: null, tabTitle: null }),
            '22023',
          );
          await rejects(driveSheetImport({ tabId: null }), '22023');
          await rejects(driveSheetImport({ tabTitle: null }), '22023');
          await rejects(driveSheetImport({ fileId: null }), '22023');
          await rejects(driveSheetImport({ subject: null }), '22023');
          await rejects(driveSheetImport({ fileId: 'example/file' }), '22023');
          await rejects(driveSheetImport({ fileId: 'x'.repeat(129) }), '22023');
          await rejects(driveSheetImport({ tabId: -1 }), '22023');
          await rejects(driveSheetImport({ tabTitle: '' }), '22023');
          await rejects(
            driveSheetImport({ tabTitle: 'x'.repeat(256) }),
            '22023',
          );
          await rejects(driveSheetImport({ subject: 'xx' }), '22023');
          await rejects(
            driveSheetImport({ artifactId: 'example-artifact-1' }),
            '22023',
          );
          await rejects(
            createImport({ actor: importer, fileId: 'example-csv-file-1' }),
            '22023',
          );
          await rejects(
            createImport({ actor: importer, subject: 'reader@example.org' }),
            '22023',
          );
          await rejects(
            createImport({
              actor: importer,
              sourceType: 'drive-csv',
              fileId: 'example-csv-file-1',
              tabId: 0,
              tabTitle: 'Devices',
              subject: 'reader@example.org',
            }),
            '22023',
          );
          // The table checks hold the same rules.
          await rejects(
            migrator.query(
              'UPDATE cc.device_import_jobs SET source_tab_id=NULL,source_tab_title=NULL WHERE job_id=$1',
              [sheetSource.receipt.jobId],
            ),
            '23514',
          );
          await rejects(
            migrator.query(
              'UPDATE cc.device_import_jobs SET source_file_id=NULL WHERE job_id=$1',
              [sheetSource.receipt.jobId],
            ),
            '23514',
          );
          await rejects(
            migrator.query(
              'UPDATE cc.device_import_jobs SET drive_subject=NULL WHERE job_id=$1',
              [sheetSource.receipt.jobId],
            ),
            '23514',
          );
          await rejects(
            migrator.query(
              "UPDATE cc.device_import_jobs SET source_type='drive-csv' WHERE job_id=$1",
              [sheetSource.receipt.jobId],
            ),
            '23514',
          );
          await rejects(
            migrator.query(
              "UPDATE cc.device_import_jobs SET source_type='drive-x' WHERE job_id=$1",
              [csvSource.receipt.jobId],
            ),
            '23514',
          );
          const upload = await createImport({ actor: importer });
          jobs.push(upload.receipt.jobId);
          await rejects(
            migrator.query(
              "UPDATE cc.device_import_jobs SET source_file_id='example-csv-file-1' WHERE job_id=$1",
              [upload.receipt.jobId],
            ),
            '23514',
          );
          await rejects(
            migrator.query(
              "UPDATE cc.device_import_jobs SET drive_subject='reader@example.org' WHERE job_id=$1",
              [upload.receipt.jobId],
            ),
            '23514',
          );
        },
      );

      await check(
        'S2 a cancel after the Sheet stamp answers nothing-to-stop',
        async () => {
          const created = await createExport({
            actor: exporter,
            format: 'sheet',
            subject: 'editor@example.org',
          });
          jobs.push(created.receipt.jobId);
          const lease = randomUUID();
          assert.equal(
            (await claimExport(created.receipt.jobId, lease)).outcome,
            'claimed',
          );
          const started = await startSheet(created.receipt.jobId, lease);
          assert.equal(started.outcome, 'started');
          const stamp = (
            await admin(
              'SELECT sheet_started_at FROM cc.device_export_jobs WHERE job_id=$1',
              [created.receipt.jobId],
            )
          )[0].sheet_started_at;
          assert.notEqual(stamp, null);
          const header = await jobRow(created.receipt.jobId);
          assert.equal(header.phase, 'create-sheet');
          assert.equal(header.phase_done, 0);
          assert.equal(header.phase_total, null);
          // The cancel refuses, and it changes nothing.
          await rejects(
            cancelAs(exporter, created.receipt.displayId),
            null,
            'nothing-to-stop',
          );
          const refused = await jobRow(created.receipt.jobId);
          assert.equal(refused.cancel_requested_at, null);
          assert.equal(refused.cancel_requested_by, null);
          assert.equal(refused.status, 'running');
          assert.equal(
            (
              await admin(
                'SELECT sheet_started_at FROM cc.device_export_jobs WHERE job_id=$1',
                [created.receipt.jobId],
              )
            )[0].sheet_started_at.getTime(),
            stamp.getTime(),
          );
          // A repeat of the stamp keeps the first time and grants no second create.
          const again = await startSheet(created.receipt.jobId, lease);
          assert.equal(again.outcome, 'repeated');
          assert.equal(new Date(again.startedAt).getTime(), stamp.getTime());
          // A replaced lease is fenced, and a CSV export has no Sheet to stamp.
          assert.equal(
            (await startSheet(created.receipt.jobId, randomUUID())).outcome,
            'fenced',
          );
          const csv = await createExport({ actor: exporter });
          jobs.push(csv.receipt.jobId);
          const csvLease = randomUUID();
          await claimExport(csv.receipt.jobId, csvLease);
          await rejects(startSheet(csv.receipt.jobId, csvLease), '22023');
          // A request that lands before the stamp ends the run Cancelled, and no Sheet is stamped.
          const early = await createExport({
            actor: exporter,
            format: 'sheet',
            subject: 'editor@example.org',
          });
          jobs.push(early.receipt.jobId);
          const earlyLease = randomUUID();
          await claimExport(early.receipt.jobId, earlyLease);
          assert.equal(
            (await cancelAs(exporter, early.receipt.displayId)).outcome,
            'requested',
          );
          assert.equal(
            (await startSheet(early.receipt.jobId, earlyLease)).outcome,
            'cancelled',
          );
          const cancelled = await jobRow(early.receipt.jobId);
          assert.equal(cancelled.status, 'cancelled');
          assert.notEqual(cancelled.finished_at, null);
          assert.equal(
            (
              await admin(
                'SELECT sheet_started_at FROM cc.device_export_jobs WHERE job_id=$1',
                [early.receipt.jobId],
              )
            )[0].sheet_started_at,
            null,
          );
        },
      );

      await check(
        'S2 two claims of one lease authorize one Sheet create',
        async () => {
          const first = await raceClient('cc-app');
          const second = await raceClient('cc-app');
          try {
            const created = await createExport({
              actor: exporter,
              format: 'sheet',
              subject: 'editor@example.org',
            });
            jobs.push(created.receipt.jobId);
            const lease = randomUUID();
            // Two runs of one dispatch lease claim before either stamps the Sheet. The second claim
            // admits the same lease, because only another lease is busy (design section 6 step 1).
            assert.equal(
              (await claimExport(created.receipt.jobId, lease, first)).outcome,
              'claimed',
            );
            assert.equal(
              (await claimExport(created.receipt.jobId, lease, second)).outcome,
              'claimed',
            );
            const started = await startSheet(
              created.receipt.jobId,
              lease,
              first,
            );
            assert.equal(started.outcome, 'started');
            const stamp = (
              await admin(
                'SELECT sheet_started_at FROM cc.device_export_jobs WHERE job_id=$1',
                [created.receipt.jobId],
              )
            )[0].sheet_started_at;
            assert.notEqual(stamp, null);
            assert.equal(
              new Date(started.startedAt).getTime(),
              stamp.getTime(),
            );
            const before = await jobRow(created.receipt.jobId);
            // The second run of the same lease receives no second create permission, and it writes
            // nothing: one stamp, one phase, one revision.
            const repeated = await startSheet(
              created.receipt.jobId,
              lease,
              second,
            );
            assert.equal(repeated.outcome, 'repeated');
            assert.equal(
              new Date(repeated.startedAt).getTime(),
              stamp.getTime(),
            );
            const after = await jobRow(created.receipt.jobId);
            assert.equal(after.status, 'running');
            assert.equal(after.phase, 'create-sheet');
            assert.equal(after.revision, before.revision);
            assert.equal(
              (
                await admin(
                  'SELECT sheet_started_at FROM cc.device_export_jobs WHERE job_id=$1',
                  [created.receipt.jobId],
                )
              )[0].sheet_started_at.getTime(),
              stamp.getTime(),
            );
          } finally {
            await close(first);
            await close(second);
          }
        },
      );

      await check(
        'S3 the Sheet stamp races a cancel, and one wins',
        async () => {
          const holder = await raceClient('postgres');
          const starter = await raceClient('cc-app');
          const canceller = await raceClient('cc-app');
          let started = null;
          let lateCancel = null;
          let cancelledFirst = null;
          let lateStamp = null;
          try {
            const starterPid = await backendPid(starter);
            const cancellerPid = await backendPid(canceller);
            // The stamp arrives first: it holds the header queue, and the cancel then refuses.
            const first = await createExport({
              actor: exporter,
              format: 'sheet',
              subject: 'editor@example.org',
            });
            jobs.push(first.receipt.jobId);
            const firstLease = randomUUID();
            assert.equal(
              (await claimExport(first.receipt.jobId, firstLease)).outcome,
              'claimed',
            );
            await holder.query('BEGIN');
            await holder.query(
              'SELECT 1 FROM cc.jobs WHERE job_id=$1 FOR UPDATE',
              [first.receipt.jobId],
            );
            started = settle(
              startSheet(first.receipt.jobId, firstLease, starter),
            );
            await waitWaiting(starterPid, 'the stamp');
            lateCancel = settle(
              cancelAs(exporter, first.receipt.displayId, 1, canceller),
            );
            await waitWaiting(cancellerPid, 'the cancel');
            await holder.query('COMMIT');
            assert.equal((await started).value?.outcome, 'started');
            assert.equal((await lateCancel).error?.detail, 'nothing-to-stop');
            assert.equal(
              (await jobRow(first.receipt.jobId)).cancel_requested_at,
              null,
            );
            // The cancel arrives first: it stores its request, and the stamp then ends the run
            // Cancelled before any Sheet exists.
            const second = await createExport({
              actor: exporter,
              format: 'sheet',
              subject: 'editor@example.org',
            });
            jobs.push(second.receipt.jobId);
            const secondLease = randomUUID();
            assert.equal(
              (await claimExport(second.receipt.jobId, secondLease)).outcome,
              'claimed',
            );
            await holder.query('BEGIN');
            await holder.query(
              'SELECT 1 FROM cc.jobs WHERE job_id=$1 FOR UPDATE',
              [second.receipt.jobId],
            );
            cancelledFirst = settle(
              cancelAs(exporter, second.receipt.displayId, 1, canceller),
            );
            await waitWaiting(cancellerPid, 'the cancel');
            lateStamp = settle(
              startSheet(second.receipt.jobId, secondLease, starter),
            );
            await waitWaiting(starterPid, 'the stamp');
            await holder.query('COMMIT');
            assert.equal((await cancelledFirst).value?.outcome, 'requested');
            assert.equal((await lateStamp).value?.outcome, 'cancelled');
            const ended = await jobRow(second.receipt.jobId);
            assert.equal(ended.status, 'cancelled');
            assert.notEqual(ended.cancel_requested_at, null);
            assert.equal(
              (
                await admin(
                  'SELECT sheet_started_at FROM cc.device_export_jobs WHERE job_id=$1',
                  [second.receipt.jobId],
                )
              )[0].sheet_started_at,
              null,
            );
          } catch (error) {
            await holder.query('ROLLBACK').catch(() => undefined);
            // The settled results name the cause, because a race check that throws hides them.
            const seen = {
              started: await started,
              lateCancel: await lateCancel,
              cancelledFirst: await cancelledFirst,
              lateStamp: await lateStamp,
            };
            throw new Error(
              `${error.message} ${JSON.stringify(seen, (key, value) =>
                value instanceof Error
                  ? {
                      message: value.message,
                      code: value.code,
                      detail: value.detail,
                    }
                  : value,
              )}`,
            );
          } finally {
            await close(holder);
            await close(starter);
            await close(canceller);
          }
        },
      );

      await check(
        'S3 a settings change writes one event, and a repeat writes none',
        async () => {
          const settingsActor = await principal([
            ['connection:manage', { kind: 'platform' }],
            ['connection:read', { kind: 'platform' }],
          ]);
          const settingsReader = await principal([
            ['connection:read', { kind: 'platform' }],
          ]);
          const settingsDenied = await principal([
            ['devices:read', district()],
          ]);
          assert.equal(await readSettings(settingsActor), null);
          // The field rules of design section 3.
          const key = pickerKey('a');
          await rejects(
            saveSettings(settingsActor, 'k'.repeat(38), '123456789012'),
            '22023',
          );
          await rejects(
            saveSettings(settingsActor, 'k'.repeat(40), '123456789012'),
            '22023',
          );
          await rejects(
            saveSettings(settingsActor, `${'k'.repeat(38)}.`, '123456789012'),
            '22023',
          );
          await rejects(saveSettings(settingsActor, key, '0123456'), '22023');
          await rejects(saveSettings(settingsActor, key, '0'), '22023');
          await rejects(
            saveSettings(settingsActor, key, '1'.repeat(21)),
            '22023',
          );
          await rejects(saveSettings(settingsActor, key, '12345x'), '22023');
          await rejects(saveSettings(settingsActor, key, ''), '22023');
          // The table checks hold the same rules, before the first row lands.
          for (const [badKey, badProject] of [
            ['k'.repeat(38), '123456789012'],
            [`${'k'.repeat(38)}.`, '123456789012'],
            [key, '0123456'],
            [key, '1'.repeat(21)],
          ])
            await rejects(
              migrator.query(
                `INSERT INTO cc.google_drive_settings(singleton,picker_api_key,project_number,saved_by)
                 VALUES(true,$1,$2,$3)`,
                [badKey, badProject, settingsActor],
              ),
              '23514',
            );
          // A person without connection:manage saves nothing, and the table stays empty.
          await rejects(
            saveSettings(settingsDenied, key, '123456789012'),
            '42501',
          );
          assert.equal(
            (
              await admin(
                'SELECT count(*)::integer AS rows FROM cc.google_drive_settings',
              )
            )[0].rows,
            0,
          );
          // The first save writes the row and one event.
          const firstCorrelation = randomUUID();
          assert.deepEqual(
            await saveSettings(
              settingsActor,
              key,
              '123456789012',
              null,
              firstCorrelation,
            ),
            { pickerApiKey: key, projectNumber: '123456789012' },
          );
          assert.deepEqual(await readSettings(settingsActor), {
            pickerApiKey: key,
            projectNumber: '123456789012',
          });
          const saved = (
            await admin(
              'SELECT saved_at,saved_by FROM cc.google_drive_settings',
            )
          )[0];
          assert.equal(saved.saved_by, settingsActor);
          let events = await settingsEvents();
          assert.equal(events.length, 1);
          assert.equal(events[0].actor_id, settingsActor);
          assert.equal(events[0].correlation_id, firstCorrelation);
          assert.equal(
            events[0].detail,
            'projectNumber:123456789012,keyChanged:true',
          );
          assert.deepEqual(events[0].resource_scope, { kind: 'platform' });
          // A repeat writes no event and changes no row.
          assert.deepEqual(
            await saveSettings(settingsActor, key, '123456789012'),
            { pickerApiKey: key, projectNumber: '123456789012' },
          );
          events = await settingsEvents();
          assert.equal(events.length, 1);
          const repeated = (
            await admin(
              'SELECT saved_at,saved_by FROM cc.google_drive_settings',
            )
          )[0];
          assert.equal(repeated.saved_at.getTime(), saved.saved_at.getTime());
          assert.equal(repeated.saved_by, settingsActor);
          // A new project number writes one event that reports the key as unchanged.
          await saveSettings(settingsActor, key, '210987654321');
          events = await settingsEvents();
          assert.deepEqual(events.map((row) => row.detail).sort(), [
            'projectNumber:123456789012,keyChanged:true',
            'projectNumber:210987654321,keyChanged:false',
          ]);
          // A new key writes one event that reports the change.
          const nextKey = pickerKey('b');
          await saveSettings(settingsActor, nextKey, '210987654321');
          events = await settingsEvents();
          assert.deepEqual(events.map((row) => row.detail).sort(), [
            'projectNumber:123456789012,keyChanged:true',
            'projectNumber:210987654321,keyChanged:false',
            'projectNumber:210987654321,keyChanged:true',
          ]);
          assert.deepEqual(await readSettings(settingsReader), {
            pickerApiKey: nextKey,
            projectNumber: '210987654321',
          });
          // The table holds the rules too.
          await rejects(
            migrator.query(
              "UPDATE cc.google_drive_settings SET picker_api_key='k' WHERE singleton",
            ),
            '23514',
          );
          await rejects(
            migrator.query(
              "UPDATE cc.google_drive_settings SET project_number='0123' WHERE singleton",
            ),
            '23514',
          );
        },
      );

      await check(
        'S4 a renewal takes create-sheet and drive-read',
        async () => {
          const exported = await createExport({
            actor: exporter,
            format: 'sheet',
            subject: 'editor@example.org',
          });
          jobs.push(exported.receipt.jobId);
          const lease = randomUUID();
          await claimExport(exported.receipt.jobId, lease);
          await startSheet(exported.receipt.jobId, lease);
          assert.equal(
            (
              await renewExport(
                exported.receipt.jobId,
                lease,
                'create-sheet',
                0,
                null,
              )
            ).outcome,
            'renewed',
          );
          const header = await jobRow(exported.receipt.jobId);
          assert.equal(header.phase, 'create-sheet');
          assert.equal(header.phase_done, 0);
          assert.equal(header.phase_total, null);
          // The stamp phase counts nothing and draws no bar.
          await rejects(
            renewExport(exported.receipt.jobId, lease, 'create-sheet', 1, null),
            '22023',
          );
          await rejects(
            renewExport(exported.receipt.jobId, lease, 'create-sheet', 0, 3),
            '22023',
          );
          // The Drive read counts source rows under the 50,000 bound.
          const imported = await driveSheetImport();
          jobs.push(imported.receipt.jobId);
          const importLease = randomUUID();
          await claimImport(imported.receipt.jobId, importLease);
          assert.equal(
            (
              await renewImport(
                imported.receipt.jobId,
                importLease,
                'drive-read',
                1500,
                2000,
              )
            ).outcome,
            'renewed',
          );
          const importHeader = await jobRow(imported.receipt.jobId);
          assert.equal(importHeader.phase, 'drive-read');
          assert.equal(importHeader.phase_done, 1500);
          assert.equal(importHeader.phase_total, 2000);
          await rejects(
            renewImport(
              imported.receipt.jobId,
              importLease,
              'drive-read',
              50001,
              50001,
            ),
            '22023',
          );
          await rejects(
            renewImport(
              imported.receipt.jobId,
              importLease,
              'create-sheet',
              1,
              1,
            ),
            '22023',
          );
        },
      );

      await check(
        'S4 a Sheet finish and both new failures settle',
        async () => {
          const finished = await createExport({
            actor: exporter,
            format: 'sheet',
            subject: 'editor@example.org',
          });
          jobs.push(finished.receipt.jobId);
          const lease = randomUUID();
          await claimExport(finished.receipt.jobId, lease);
          await startSheet(finished.receipt.jobId, lease);
          const file = sheetFile(3, 10);
          const answer = await finishExport(
            finished.receipt.jobId,
            lease,
            file,
          );
          assert.equal(answer.outcome, 'finished');
          assert.equal(answer.status, 'completed');
          assert.equal(answer.file.format, 'sheet');
          assert.equal(answer.file.spreadsheetId, file.spreadsheetId);
          assert.equal(answer.file.sizeBytes, null);
          assert.equal(answer.file.expiresAt, null);
          const row = (
            await admin('SELECT * FROM cc.device_export_jobs WHERE job_id=$1', [
              finished.receipt.jobId,
            ])
          )[0];
          assert.equal(row.spreadsheet_id, file.spreadsheetId);
          assert.equal(row.file_name, file.name);
          assert.equal(row.file_row_count, 3);
          assert.equal(row.file_column_count, 10);
          assert.equal(row.file_artifact_id, null);
          assert.equal(row.file_size_bytes, null);
          assert.equal(row.file_expires_at, null);
          const header = await jobRow(finished.receipt.jobId);
          assert.equal(header.status, 'completed');
          assert.equal(header.phase, 'create-sheet');
          assert.equal(header.phase_done, 0);
          assert.equal(header.phase_total, null);
          assert.equal(header.succeeded, 3);
          // A repeat answers the stored status.
          assert.equal(
            (await finishExport(finished.receipt.jobId, lease, file)).status,
            'completed',
          );
          // The split refuses the file facts of the other format.
          const wrong = await createExport({
            actor: exporter,
            format: 'sheet',
            subject: 'editor@example.org',
          });
          jobs.push(wrong.receipt.jobId);
          const wrongLease = randomUUID();
          await claimExport(wrong.receipt.jobId, wrongLease);
          await startSheet(wrong.receipt.jobId, wrongLease);
          for (const refused of [
            { ...sheetFile(), artifactId: 'example-artifact-1' },
            { ...sheetFile(), sizeBytes: 100 },
            {
              ...sheetFile(),
              expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
            },
            { name: 'devices-for-editing-EXP-001', rows: 3, columns: 10 },
          ])
            await rejects(
              finishExport(wrong.receipt.jobId, wrongLease, refused),
              '22023',
            );
          // A CSV finish keeps its facts, and it refuses a spreadsheet ID.
          const csv = await createExport({ actor: exporter });
          jobs.push(csv.receipt.jobId);
          const csvLease = randomUUID();
          await claimExport(csv.receipt.jobId, csvLease);
          const csvFile = exportFile(3, 10);
          const csvAnswer = await finishExport(
            csv.receipt.jobId,
            csvLease,
            csvFile,
          );
          assert.equal(csvAnswer.outcome, 'finished');
          assert.equal(csvAnswer.status, 'completed');
          assert.equal(csvAnswer.file.format, 'csv');
          assert.equal(csvAnswer.file.spreadsheetId, null);
          const csvRow = (
            await admin('SELECT * FROM cc.device_export_jobs WHERE job_id=$1', [
              csv.receipt.jobId,
            ])
          )[0];
          assert.equal(csvRow.file_artifact_id, csvFile.artifactId);
          assert.equal(csvRow.file_name, csvFile.name);
          assert.equal(Number(csvRow.file_size_bytes), csvFile.sizeBytes);
          assert.equal(csvRow.file_row_count, csvFile.rows);
          assert.equal(csvRow.file_column_count, csvFile.columns);
          assert.equal(
            csvRow.file_expires_at.getTime(),
            new Date(csvFile.expiresAt).getTime(),
          );
          assert.equal(csvRow.spreadsheet_id, null);
          assert.equal(
            (await jobRow(csv.receipt.jobId)).phase,
            'prepare-download',
          );
          const csvMissing = await createExport({ actor: exporter });
          jobs.push(csvMissing.receipt.jobId);
          const csvMissingLease = randomUUID();
          await claimExport(csvMissing.receipt.jobId, csvMissingLease);
          await rejects(
            finishExport(csvMissing.receipt.jobId, csvMissingLease, {
              ...exportFile(),
              spreadsheetId: 'example-sheet-1',
            }),
            '22023',
          );
          await rejects(
            finishExport(csvMissing.receipt.jobId, csvMissingLease, {
              artifactId: `artifact-${randomUUID()}`,
              name: 'devices-for-editing-EXP-001.csv',
              rows: 3,
              columns: 10,
            }),
            '22023',
          );
          // Both new failure codes settle a Sheet export.
          for (const code of ['drive-unavailable', 'sheet-write-failed']) {
            const failed = await createExport({
              actor: exporter,
              format: 'sheet',
              subject: 'editor@example.org',
            });
            jobs.push(failed.receipt.jobId);
            const failedLease = randomUUID();
            await claimExport(failed.receipt.jobId, failedLease);
            await startSheet(failed.receipt.jobId, failedLease);
            const failedAnswer = await finishExport(
              failed.receipt.jobId,
              failedLease,
              null,
              code,
            );
            assert.equal(failedAnswer.outcome, 'finished');
            assert.equal(failedAnswer.status, 'failed');
            const failedHeader = await jobRow(failed.receipt.jobId);
            assert.equal(failedHeader.status, 'failed');
            assert.equal(failedHeader.failure, code);
            assert.notEqual(failedHeader.finished_at, null);
          }
        },
      );

      await check(
        'S4 a claim after the Sheet stamp ends interrupted',
        async () => {
          const created = await createExport({
            actor: exporter,
            format: 'sheet',
            subject: 'editor@example.org',
          });
          jobs.push(created.receipt.jobId);
          const firstLease = randomUUID();
          await claimExport(created.receipt.jobId, firstLease);
          await startSheet(created.receipt.jobId, firstLease);
          // A live lease answers busy, not interrupted.
          assert.equal(
            (await claimExport(created.receipt.jobId, randomUUID())).outcome,
            'busy',
          );
          // The lost run's lease lapses, and the retried dispatch ends the job without a second Sheet.
          await expire('device_export_jobs', created.receipt.jobId);
          assert.equal(
            (await claimExport(created.receipt.jobId, randomUUID())).outcome,
            'done',
          );
          const header = await jobRow(created.receipt.jobId);
          assert.equal(header.status, 'failed');
          assert.equal(header.failure, 'interrupted');
          assert.notEqual(header.finished_at, null);
          const detail = (
            await admin(
              'SELECT sheet_started_at,spreadsheet_id FROM cc.device_export_jobs WHERE job_id=$1',
              [created.receipt.jobId],
            )
          )[0];
          assert.notEqual(detail.sheet_started_at, null);
          assert.equal(detail.spreadsheet_id, null);
          assert.equal(
            (await claimExport(created.receipt.jobId, randomUUID())).outcome,
            'done',
          );
          // A CSV export of a lapsed lease is claimed again, because it has no Sheet to lose.
          const csv = await createExport({ actor: exporter });
          jobs.push(csv.receipt.jobId);
          await claimExport(csv.receipt.jobId, randomUUID());
          await expire('device_export_jobs', csv.receipt.jobId);
          assert.equal(
            (await claimExport(csv.receipt.jobId, randomUUID())).outcome,
            'claimed',
          );
        },
      );

      await check(
        'S4 the Drive read stores its source under the lease',
        async () => {
          const imported = await driveSheetImport();
          jobs.push(imported.receipt.jobId);
          const lease = randomUUID();
          const claimed = await claimImport(imported.receipt.jobId, lease);
          assert.equal(claimed.outcome, 'claimed');
          // The claim answers the Drive fields, and no artifact holds the source yet.
          assert.equal(claimed.sourceArtifactId, null);
          assert.equal(claimed.sourceFileId, 'example-sheet-file-1');
          assert.equal(claimed.sourceTabId, 0);
          assert.equal(claimed.sourceTabTitle, 'Devices');
          assert.equal(claimed.driveSubject, 'reader@example.org');
          const artifact = await seedDriveArtifact(2048);
          // A stale attempt and a lapsed lease write nothing.
          assert.equal(
            (
              await storeSource(
                imported.receipt.jobId,
                lease,
                0,
                artifact,
                2048,
              )
            ).outcome,
            'fenced',
          );
          await expire('device_import_jobs', imported.receipt.jobId);
          assert.equal(
            (
              await storeSource(
                imported.receipt.jobId,
                lease,
                claimed.attempt,
                artifact,
                2048,
              )
            ).outcome,
            'fenced',
          );
          // The live lease links the file and records its size.
          await migrator.query(
            `UPDATE cc.device_import_jobs SET lease_expires_at=clock_timestamp()+interval '2 minutes'
             WHERE job_id=$1`,
            [imported.receipt.jobId],
          );
          const stored = await storeSource(
            imported.receipt.jobId,
            lease,
            claimed.attempt,
            artifact,
            2048,
          );
          assert.equal(stored.outcome, 'stored');
          assert.equal(stored.artifactId, artifact);
          assert.equal(Number(stored.sizeBytes), 2048);
          assert.equal(
            (
              await admin('SELECT job_id FROM cc.artifacts WHERE id=$1', [
                artifact,
              ])
            )[0].job_id,
            imported.receipt.jobId,
          );
          assert.equal(
            Number(
              (
                await admin(
                  'SELECT source_size_bytes FROM cc.device_import_jobs WHERE job_id=$1',
                  [imported.receipt.jobId],
                )
              )[0].source_size_bytes,
            ),
            2048,
          );
          // A later claim answers the stored file, so the built passes read it as an upload.
          await expire('device_import_jobs', imported.receipt.jobId);
          const again = await claimImport(imported.receipt.jobId, randomUUID());
          assert.equal(again.outcome, 'claimed');
          assert.equal(again.sourceArtifactId, artifact);
          const againLease = randomUUID();
          assert.equal(
            (
              await storeSource(
                imported.receipt.jobId,
                againLease,
                again.attempt,
                artifact,
                2048,
              )
            ).outcome,
            'fenced',
          );
          // A file of another size, an unfinished file, and a CSV job refuse the call.
          await expire('device_import_jobs', imported.receipt.jobId);
          const currentLease = randomUUID();
          const current = await claimImport(
            imported.receipt.jobId,
            currentLease,
          );
          const unfinished = await seedDriveArtifact(2048, {
            state: 'staging',
          });
          await rejects(
            storeSource(
              imported.receipt.jobId,
              currentLease,
              current.attempt,
              unfinished,
              2048,
            ),
            '22023',
          );
          await rejects(
            storeSource(
              imported.receipt.jobId,
              currentLease,
              current.attempt,
              artifact,
              1024,
            ),
            '22023',
          );
          const upload = await createImport({ actor: importer });
          jobs.push(upload.receipt.jobId);
          const uploadLease = randomUUID();
          const uploadClaim = await claimImport(
            upload.receipt.jobId,
            uploadLease,
          );
          await rejects(
            storeSource(
              upload.receipt.jobId,
              uploadLease,
              uploadClaim.attempt,
              artifact,
              2048,
            ),
            '22023',
          );
        },
      );

      await check(
        'S4 a source store that waits past its lease or its retention writes nothing',
        async () => {
          const holder = await raceClient('postgres');
          const writer = await raceClient('cc-app');
          const writerPid = await backendPid(writer);
          const pause = (ms) =>
            new Promise((resolve) => setTimeout(resolve, ms));
          const publications = (jobId) =>
            admin(
              'SELECT count(*)::integer AS rows FROM cc.job_publications WHERE job_id=$1',
              [jobId],
            ).then((r) => r[0].rows);
          /** A refused call changes none of the four writes: the link, the size, the revision, the row. */
          const refusesWrite = async (
            jobId,
            artifactId,
            revision,
            publicationCount,
            label,
          ) => {
            assert.equal(
              (
                await admin('SELECT job_id FROM cc.artifacts WHERE id=$1', [
                  artifactId,
                ])
              )[0].job_id,
              null,
              `${label} links nothing`,
            );
            assert.equal(
              Number(
                (
                  await admin(
                    'SELECT source_size_bytes FROM cc.device_import_jobs WHERE job_id=$1',
                    [jobId],
                  )
                )[0].source_size_bytes,
              ),
              2048,
              `${label} keeps the size`,
            );
            assert.equal(
              (await jobRow(jobId)).revision,
              revision,
              `${label} keeps the revision`,
            );
            assert.equal(
              await publications(jobId),
              publicationCount,
              `${label} publishes nothing`,
            );
          };
          /**
           * Hold the artifact row, start the store, confirm that it waits on that lock, let the
           * deadline pass, then release the lock.
           */
          const storeWhileWaiting = async (
            jobId,
            lease,
            attemptNumber,
            artifactId,
            label,
          ) => {
            await holder.query('BEGIN');
            await holder.query(
              'SELECT 1 FROM cc.artifacts WHERE id=$1 FOR UPDATE',
              [artifactId],
            );
            const call = settle(
              storeSource(
                jobId,
                lease,
                attemptNumber,
                artifactId,
                1024,
                writer,
              ),
            );
            await waitWaiting(writerPid, label);
            await pause(1700);
            await holder.query('COMMIT');
            return call;
          };
          const sources = [
            ['drive-sheet', () => driveSheetImport()],
            [
              'drive-csv',
              () =>
                createImport({
                  actor: importer,
                  sourceType: 'drive-csv',
                  name: 'devices.csv',
                  sizeBytes: 2048,
                  fileId: 'example-csv-file-1',
                  subject: 'reader@example.org',
                }),
            ],
          ];
          try {
            for (const [sourceType, create] of sources) {
              // The ordinary control: a live lease and a retained artifact store the source.
              const control = await create();
              jobs.push(control.receipt.jobId);
              const controlLease = randomUUID();
              const controlClaim = await claimImport(
                control.receipt.jobId,
                controlLease,
              );
              assert.equal(controlClaim.outcome, 'claimed');
              const controlArtifact = await seedDriveArtifact(1024);
              const controlStored = await storeSource(
                control.receipt.jobId,
                controlLease,
                controlClaim.attempt,
                controlArtifact,
                1024,
              );
              assert.equal(controlStored.outcome, 'stored', sourceType);
              assert.equal(
                (
                  await admin('SELECT job_id FROM cc.artifacts WHERE id=$1', [
                    controlArtifact,
                  ])
                )[0].job_id,
                control.receipt.jobId,
              );
              assert.equal(
                Number(
                  (
                    await admin(
                      'SELECT source_size_bytes FROM cc.device_import_jobs WHERE job_id=$1',
                      [control.receipt.jobId],
                    )
                  )[0].source_size_bytes,
                ),
                1024,
              );
              // The lease lapses while the call waits on the artifact lock.
              const lapsed = await create();
              jobs.push(lapsed.receipt.jobId);
              const lapsedLease = randomUUID();
              const lapsedClaim = await claimImport(
                lapsed.receipt.jobId,
                lapsedLease,
              );
              assert.equal(lapsedClaim.outcome, 'claimed');
              const lapsedArtifact = await seedDriveArtifact(1024);
              await migrator.query(
                "UPDATE cc.device_import_jobs SET lease_expires_at=clock_timestamp()+interval '1500 milliseconds' WHERE job_id=$1",
                [lapsed.receipt.jobId],
              );
              const lapsedBefore = await jobRow(lapsed.receipt.jobId);
              const lapsedPublications = await publications(
                lapsed.receipt.jobId,
              );
              const lapsedCall = await storeWhileWaiting(
                lapsed.receipt.jobId,
                lapsedLease,
                lapsedClaim.attempt,
                lapsedArtifact,
                `the ${sourceType} store past its lease`,
              );
              assert.equal(
                (await lapsedCall).value?.outcome,
                'fenced',
                sourceType,
              );
              await refusesWrite(
                lapsed.receipt.jobId,
                lapsedArtifact,
                lapsedBefore.revision,
                lapsedPublications,
                `${sourceType} past its lease`,
              );
              // The retention ends while the call waits on the artifact lock.
              const expired = await create();
              jobs.push(expired.receipt.jobId);
              const expiredLease = randomUUID();
              const expiredClaim = await claimImport(
                expired.receipt.jobId,
                expiredLease,
              );
              assert.equal(expiredClaim.outcome, 'claimed');
              const expiredArtifact = await seedDriveArtifact(1024);
              await migrator.query(
                "UPDATE cc.artifacts SET retention_until=clock_timestamp()+interval '1500 milliseconds' WHERE id=$1",
                [expiredArtifact],
              );
              const expiredBefore = await jobRow(expired.receipt.jobId);
              const expiredPublications = await publications(
                expired.receipt.jobId,
              );
              const expiredCall = await storeWhileWaiting(
                expired.receipt.jobId,
                expiredLease,
                expiredClaim.attempt,
                expiredArtifact,
                `the ${sourceType} store past its retention`,
              );
              assert.equal(
                (await expiredCall).error?.code,
                '22023',
                sourceType,
              );
              await refusesWrite(
                expired.receipt.jobId,
                expiredArtifact,
                expiredBefore.revision,
                expiredPublications,
                `${sourceType} past its retention`,
              );
            }
          } catch (error) {
            await holder.query('ROLLBACK').catch(() => undefined);
            throw error;
          } finally {
            await close(holder);
            await close(writer);
          }
        },
      );
    } finally {
      if (driveArtifacts.length)
        await migrator
          .query('DELETE FROM cc.artifacts WHERE id=ANY($1::text[])', [
            driveArtifacts,
          ])
          .catch(() => undefined);
      await migrator
        .query(
          "DELETE FROM cc.security_events WHERE event='drive-settings-changed'",
        )
        .catch(() => undefined);
      await migrator
        .query('DELETE FROM cc.google_drive_settings')
        .catch(() => undefined);
    }
  } finally {
    // The module leaves no fixture behind for the modules that follow it.
    try {
      if (jobs.length)
        await migrator.query(
          'DELETE FROM cc.jobs WHERE job_id=ANY($1::uuid[])',
          [jobs],
        );
      if (principals.length)
        await migrator.query(
          'DELETE FROM cc.application_principals WHERE id=ANY($1::uuid[])',
          [principals],
        );
    } catch {
      // A failing check already recorded its own result.
    }
  }
  for (const name of failures) process.stderr.write(`failed check ${name}\n`);
  return results;
}

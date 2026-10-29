import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

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
  const createExport = async ({
    actor,
    purpose = 'edit',
    columns = [],
    devices = ['D-1', 'D-2', 'D-3'],
    sort = { field: 'serialNumber', direction: 'asc' },
  }) =>
    result(
      'SELECT cc.create_device_export_job($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS result',
      [
        actor,
        1,
        customer,
        purpose,
        'csv',
        sort.field,
        sort.direction,
        columns,
        JSON.stringify(devices),
        randomUUID(),
      ],
    );
  const createImport = async ({
    actor,
    mode = 'sync-changes',
    name = 'devices.csv',
    sizeBytes = 2048,
    permissions = ['disable'],
  }) =>
    result(
      'SELECT cc.create_device_import_job($1,$2,$3,$4,$5,$6,$7,$8,$9) AS result',
      [
        actor,
        1,
        customer,
        mode,
        'csv',
        name,
        sizeBytes,
        permissions,
        randomUUID(),
      ],
    );
  const jobRow = (jobId) =>
    admin('SELECT * FROM cc.jobs WHERE job_id=$1', [jobId]).then((r) => r[0]);
  const cancelAs = (actor, displayId, version = 1) =>
    result('SELECT cc.request_job_cancel($1,$2,$3,$4,$5) AS result', [
      actor,
      version,
      customer,
      displayId,
      randomUUID(),
    ]);
  const claimExport = (jobId, lease) =>
    result('SELECT cc.claim_device_export_job($1,$2,$3) AS result', [
      customer,
      jobId,
      lease,
    ]);
  const claimImport = (jobId, lease) =>
    result('SELECT cc.claim_device_import_job($1,$2,$3) AS result', [
      customer,
      jobId,
      lease,
    ]);
  const renewExport = (jobId, lease, phase, done, total) =>
    result('SELECT cc.renew_device_export_job($1,$2,$3,$4,$5,$6) AS result', [
      customer,
      jobId,
      lease,
      phase,
      done,
      total,
    ]);
  const renewImport = (jobId, lease, phase, done, total) =>
    result('SELECT cc.renew_device_import_job($1,$2,$3,$4,$5,$6) AS result', [
      customer,
      jobId,
      lease,
      phase,
      done,
      total,
    ]);
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
  const storeLines = (jobId, lease, lines) =>
    result('SELECT cc.store_device_import_lines($1,$2,$3,$4) AS result', [
      customer,
      jobId,
      lease,
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
  ) =>
    result(
      'SELECT cc.finish_device_import_job($1,$2,$3,$4,$5,$6,$7) AS result',
      [
        customer,
        jobId,
        lease,
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
            'cc.create_device_export_job(uuid,integer,text,text,text,text,text,text[],jsonb,uuid)',
            'SELECT cc.create_device_export_job($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
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
            ],
          ],
          [
            'cc.create_device_import_job(uuid,integer,text,text,text,text,bigint,text[],uuid)',
            'SELECT cc.create_device_import_job($1,$2,$3,$4,$5,$6,$7,$8,$9)',
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
            'cc.renew_device_import_job(text,uuid,uuid,text,integer,integer)',
            'SELECT cc.renew_device_import_job($1,$2,$3,$4,$5,$6)',
            [customer, randomUUID(), randomUUID(), 'refresh', 1, 1],
          ],
          [
            'cc.store_device_import_lines(text,uuid,uuid,jsonb)',
            'SELECT cc.store_device_import_lines($1,$2,$3,$4)',
            [customer, randomUUID(), randomUUID(), '[]'],
          ],
          [
            'cc.finish_device_export_job(text,uuid,uuid,jsonb,text)',
            'SELECT cc.finish_device_export_job($1,$2,$3,$4,$5)',
            [customer, randomUUID(), randomUUID(), null, null],
          ],
          [
            'cc.finish_device_import_job(text,uuid,uuid,jsonb,text,text,text)',
            'SELECT cc.finish_device_import_job($1,$2,$3,$4,$5,$6,$7)',
            [customer, randomUUID(), randomUUID(), null, null, null, null],
          ],
          [
            'cc.recover_device_file_jobs(text)',
            'SELECT cc.recover_device_file_jobs($1)',
            [customer],
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
      'the three export failure codes are known to the finish check',
      async () => {
        for (const code of [
          'storage-unavailable',
          'inventory-unavailable',
          'export-too-large',
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

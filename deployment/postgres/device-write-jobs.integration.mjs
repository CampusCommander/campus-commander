import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// The device write job checks of section 8.3. Every check reports its own name and result.
export async function qualifyDeviceWriteJobs({
  runtime,
  migrator,
  connect,
  issuer,
}) {
  const connection = (
    await migrator.query('SELECT * FROM cc.google_connection')
  ).rows[0];
  const customer = connection.customer_id;
  const generation = connection.generation;
  const wasActive = connection.active;
  const results = [];
  const failures = [];
  const principals = [];
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const statement = (text, values = []) =>
    runtime.query(text, values).then((r) => r.rows);
  const result = (text, values = []) =>
    runtime.query(text, values).then((r) => r.rows[0].result);
  const admin = (text, values = []) =>
    migrator.query(text, values).then((r) => r.rows);
  const adminRow = (text, values = []) =>
    migrator.query(text, values).then((r) => r.rows[0]);
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
  // A failed check can leave a job running. Release it, so the next check measures its own behavior
  // instead of the leftover. Failures here stay silent: the next check reports the state.
  const releaseLeftovers = async () => {
    try {
      await migrator.query(
        `UPDATE cc.device_update_batches SET lease_expires_at=clock_timestamp()-interval '60 seconds'
          WHERE lease_expires_at>clock_timestamp()`,
      );
      const rows = await admin(
        "SELECT job_id FROM cc.jobs WHERE kind IN ('device-update','device-command','device-status') AND status IN ('accepted','queued','held','running') ORDER BY created_at",
      );
      for (const row of rows)
        await migrator.query('SELECT cc.finalize_device_update_job($1,$2,$3)', [
          customer,
          row.job_id,
          null,
        ]);
      await migrator.query(
        `UPDATE cc.device_sync_state SET sync_id=NULL,sync_actor=NULL,sync_generation=NULL,sync_attempt=NULL,
          sync_expires_at=NULL,failure=NULL,failure_requested_by=NULL,telemetry_failure=NULL,
          telemetry_failure_requested_by=NULL WHERE customer_id=$1`,
        [customer],
      );
    } catch {
      // The failing check already recorded its own result.
    }
  };
  const check = async (name, body) => {
    try {
      await body();
      results.push(`${name}: pass`);
    } catch (error) {
      failures.push(name);
      results.push(`${name}: FAIL ${error.message}`);
      await releaseLeftovers();
    }
    process.stderr.write(`check ${results.at(-1)}\n`);
  };
  await migrator.query('UPDATE cc.google_connection SET active=true');
  const principal = async (subject, grants = []) => {
    const id = randomUUID();
    principals.push(id);
    await migrator.query(
      'INSERT INTO cc.application_principals(id,issuer,subject,display_name) VALUES($1,$2,$3,$3)',
      [id, issuer, subject],
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
  try {
    // The three actions of section 2.1 come from the 017 producer. This check runs before the
    // principal and grant fixtures, so it measures the schema alone (review F10).
    await check(
      'the three action contracts register with their producer',
      async () => {
        assert.deepEqual(
          await admin(
            "SELECT action,scope_kinds FROM cc.application_actions WHERE action IN ('devices:write','devices:bulk-actions','jobs:read') ORDER BY action",
          ),
          [
            {
              action: 'devices:bulk-actions',
              scope_kinds: ['platform', 'district'],
            },
            { action: 'devices:write', scope_kinds: ['platform', 'district'] },
            { action: 'jobs:read', scope_kinds: ['platform', 'district'] },
          ],
        );
      },
    );
    const reader = await principal(`${randomUUID()}`, [
      ['devices:read', district()],
    ]);
    const other = await principal(`${randomUUID()}`, [
      ['devices:read', district()],
    ]);
    const auditor = await principal(`${randomUUID()}`, [
      ['devices:read', district()],
      ['jobs:read', district()],
    ]);
    const foreign = await principal(`${randomUUID()}`, [
      ['devices:read', district()],
      ['jobs:read', district('C-other')],
    ]);
    const platformReader = await principal(`${randomUUID()}`, [
      ['devices:read', district()],
      ['jobs:read', { kind: 'platform' }],
    ]);
    const confirmer = await principal(`${randomUUID()}`, [
      ['devices:read', district()],
      ['devices:write', district()],
      ['devices:bulk-actions', district()],
    ]);
    const confirmerB = await principal(`${randomUUID()}`, [
      ['devices:read', district()],
      ['devices:write', district()],
      ['devices:bulk-actions', district()],
    ]);
    const confirmers = [confirmer, confirmerB];

    const device = (deviceId, extra = {}) => ({
      deviceId,
      serialNumber: `SN-${deviceId}`,
      model: 'Lenovo 100e Gen 4',
      assetTag: `HS-${deviceId}`,
      orgUnitPath: '/School A',
      lastContact: '2026-10-05T12:00:00.000Z',
      annotatedLocation: null,
      notes: null,
      status: 'ACTIVE',
      ...extra,
    });
    const upsert = (devices, at, observation = 'list') =>
      result('SELECT cc.upsert_devices($1,$2,$3,$4) AS result', [
        customer,
        JSON.stringify(devices),
        at,
        observation,
      ]);
    const resetSync = () =>
      migrator.query(
        `UPDATE cc.device_sync_state SET sync_id=NULL,sync_actor=NULL,sync_generation=NULL,sync_attempt=NULL,
          sync_expires_at=NULL,failure=NULL,failure_requested_by=NULL,telemetry_failure=NULL,
          telemetry_failure_requested_by=NULL WHERE customer_id=$1`,
        [customer],
      );
    const readAs = (actor, version = 1) =>
      result('SELECT cc.read_device_sync($1,$2) AS result', [actor, version]);
    const requestAs = async (actor, version = 1) => {
      const id = randomUUID();
      const state = await result(
        'SELECT cc.request_device_sync($1,$2,$3,$4,$5,$6) AS result',
        [actor, version, customer, generation, id, randomUUID()],
      );
      return { id, state };
    };
    const claimSync = (id, attempt) =>
      result('SELECT cc.claim_device_sync($1,$2,$3) AS result', [
        customer,
        id,
        attempt,
      ]);
    const stage = (id, attempt, devices) =>
      result('SELECT cc.stage_devices($1,$2,$3,$4) AS result', [
        customer,
        id,
        attempt,
        JSON.stringify(devices),
      ]);
    const finishSync = (id, attempt, failure = null, telemetry = null) =>
      result('SELECT cc.finish_device_sync($1,$2,$3,$4,$5) AS result', [
        customer,
        id,
        attempt,
        failure,
        telemetry,
      ]);
    const syncState = () =>
      adminRow(
        `SELECT failure,failure_requested_by,telemetry_failure,telemetry_failure_requested_by,sync_id,sync_actor
          FROM cc.device_sync_state WHERE customer_id=$1`,
        [customer],
      );

    // A write job fixture: one preview, one header, one detail row, and one operation per device.
    const makeJob = async ({
      devices,
      batchSize = 250,
      mode = 'replace',
      value = 'Room 12',
      createdBy = confirmer,
      createdAt = null,
      /**
       * The field rows of every operation, in contract order. The default is one annotatedLocation
       * row from the header. A multi-field job names its own rows (addendum section 2).
       */
      fields = null,
    }) => {
      const jobId = randomUUID();
      const previewId = randomUUID();
      const version = (
        await adminRow(
          'SELECT permission_version FROM cc.application_principals WHERE id=$1',
          [createdBy],
        )
      ).permission_version;
      const fieldRows = fields ?? [
        {
          field: 'annotatedLocation',
          baselineValue: null,
          requestedValue: mode === 'clear' ? null : value,
        },
      ];
      const changeMode = (row) =>
        row.mode ??
        (row.field === 'orgUnitPath'
          ? 'move'
          : (row.requestedValue ?? null) === null
            ? 'clear'
            : 'replace');
      await admin(
        `INSERT INTO cc.device_update_previews(preview_id,display_id,customer_id,created_by,permission_version,
          generation,action,action_version,selected,eligible,unchanged,excluded,field_changes,
          manifest_digest,expires_at)
        VALUES($1,cc.job_display_id('PV',nextval('cc.preview_number_pv')),$2,$3,$4,$5,'annotated-location',2,
          $6,$6,0,0,$7,'manifest-digest',clock_timestamp()+interval '1 hour')`,
        [
          previewId,
          customer,
          createdBy,
          version,
          generation,
          devices.length,
          devices.length * fieldRows.length,
        ],
      );
      // The frozen changes of the preview. A job that names its own field rows writes each of them.
      for (const row of fieldRows)
        await admin(
          'INSERT INTO cc.device_update_changes(preview_id,field,mode,value) VALUES($1,$2,$3,$4)',
          [previewId, row.field, changeMode(row), row.requestedValue ?? null],
        );
      await admin(
        `INSERT INTO cc.jobs(job_id,display_id,customer_id,kind,scope_kind,status,requested_by,generation,
          target_count,correlation_id,created_at)
        VALUES($1,cc.job_display_id('UPD',nextval('cc.job_number_upd')),$2,'device-update','devices','accepted',$3,$4,
          $5,$6,COALESCE($7,clock_timestamp()))`,
        [
          jobId,
          customer,
          createdBy,
          generation,
          devices.length,
          randomUUID(),
          createdAt,
        ],
      );
      await admin(
        `INSERT INTO cc.device_update_jobs(job_id,preview_id,action,confirmed_by,
          confirmer_permission_version,delegated_subject,batch_size,batch_count)
        VALUES($1,$2,'annotated-location',$3,$4,'admin@example.org',$5,$6)`,
        [
          jobId,
          previewId,
          createdBy,
          version,
          batchSize,
          Math.ceil(devices.length / batchSize),
        ],
      );
      for (const [index, deviceId] of devices.entries()) {
        // An update keeps its values in the operation's field rows, so the value columns stay null.
        await admin(
          `INSERT INTO cc.device_update_operations(job_id,operation_number,device_id,serial_number,org_unit_path,
            baseline_value,requested_value,batch,status)
          VALUES($1,$2,$3,$4,'/School A',NULL,NULL,$5,'pending')`,
          [jobId, index + 1, deviceId, `SN-${deviceId}`, Math.floor(index / batchSize)],
        );
        // One row per field holds the requested and observed values (addendum section 2).
        for (const row of fieldRows)
          await admin(
            `INSERT INTO cc.device_update_operation_fields(job_id,operation_number,field,
              baseline_value,requested_value)
            VALUES($1,$2,$3,$4,$5)`,
            [
              jobId,
              index + 1,
              row.field,
              row.baselineValue ?? null,
              row.requestedValue ?? null,
            ],
          );
      }
      return { jobId, previewId };
    };
    const admit = (held = false) =>
      result('SELECT cc.admit_device_update_job($1,$2) AS result', [
        customer,
        held,
      ]);
    const claim = (
      jobId,
      token,
      batch,
      attempt,
      execution = 'kestra-execution',
    ) =>
      result(
        'SELECT cc.claim_device_update_batch($1,$2,$3,$4,$5,$6) AS result',
        [customer, jobId, token, batch, attempt, execution],
      );
    const stop = (jobId, token, batch, attempt) =>
      result(
        'SELECT cc.release_device_update_batch($1,$2,$3,$4,$5) AS result',
        [customer, jobId, token, batch, attempt],
      );
    const settle = async (
      jobId,
      token,
      attempt,
      kind,
      outcomes,
      observedAt,
    ) => {
      const settled = await result(
        'SELECT cc.settle_device_update_operations($1,$2,$3,$4,$5,$6,$7) AS result',
        [
          customer,
          jobId,
          token,
          attempt,
          kind,
          JSON.stringify(outcomes),
          observedAt,
        ],
      );
      // The runner stops its batch after it records a page, so the lease clears.
      if (
        (kind === 'write' || kind === 'issue') &&
        settled.settled &&
        settled.settled.length > 0
      )
        await stop(jobId, token, settled.settled[0].batch, attempt);
      return settled;
    };
    const recover = () =>
      result('SELECT cc.recover_device_update_jobs($1) AS result', [customer]);
    const prepareFinish = (jobId, token, failure = null) =>
      result('SELECT cc.prepare_device_update_finish($1,$2,$3,$4) AS result', [
        customer,
        jobId,
        token,
        failure,
      ]);
    // The final finish carries the current token on the revision that fences it (review F14). The
    // arity probe keeps one module working against the fenced revision and the parent revision.
    const finishFence = await result(
      `SELECT count(*)::int AS result FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='cc' AND p.proname='finish_device_update_job' AND p.pronargs=4`,
    );
    const finishWithToken = (jobId, token, failure = null) =>
      finishFence > 0
        ? result('SELECT cc.finish_device_update_job($1,$2,$3,$4) AS result', [
            customer,
            jobId,
            token,
            failure,
          ])
        : result('SELECT cc.finish_device_update_job($1,$2,$3) AS result', [
            customer,
            jobId,
            failure,
          ]);
    const finishJob = async (jobId, failure = null) => {
      const token = (
        await adminRow(
          'SELECT dispatch_token FROM cc.device_update_jobs WHERE job_id=$1',
          [jobId],
        )
      )?.dispatch_token;
      return finishWithToken(jobId, token ?? null, failure);
    };
    const finalize = (jobId, failure = null) =>
      result('SELECT cc.finalize_device_update_job($1,$2,$3) AS result', [
        customer,
        jobId,
        failure,
      ]);
    const claimVerification = (jobId, operations, attempt) =>
      result(
        'SELECT cc.claim_device_update_verification($1,$2,$3,$4) AS result',
        [
          customer,
          jobId,
          operations === null ? null : JSON.stringify(operations),
          attempt,
        ],
      );
    const expireBatches = (jobId) =>
      migrator.query(
        `UPDATE cc.device_update_batches SET lease_expires_at=clock_timestamp()-interval '60 seconds'
          WHERE job_id=$1`,
        [jobId],
      );
    // The reaper never acts while a batch lease lives (section 5.10). Cleanup lapses the lease first.
    const endJob = async (jobId) => {
      await expireBatches(jobId);
      return finalize(jobId);
    };
    const operations = (jobId) =>
      admin(
        `SELECT o.operation_number,o.device_id,o.status,o.attempt_id,o.observed_value,o.observed_at,
          o.verified_by,o.outcome_reason,o.verify_attempt,f.observed_value AS field_observed_value
          FROM cc.device_update_operations o
          LEFT JOIN cc.device_update_operation_fields f
            ON f.job_id=o.job_id AND f.operation_number=o.operation_number AND f.field='annotatedLocation'
          WHERE o.job_id=$1 ORDER BY o.operation_number`,
        [jobId],
      );
    const fieldRow = (jobId, operationNumber, field) =>
      adminRow(
        `SELECT field,baseline_value,requested_value,observed_value
          FROM cc.device_update_operation_fields
          WHERE job_id=$1 AND operation_number=$2 AND field=$3`,
        [jobId, operationNumber, field],
      );
    const jobRow = (jobId) =>
      adminRow('SELECT * FROM cc.jobs WHERE job_id=$1', [jobId]);
    const deviceRow = (deviceId) =>
      adminRow(
        `SELECT annotated_location,annotated_location_observed_at,status,status_observed_at,removed_at
          FROM cc.devices WHERE customer_id=$1 AND device_id=$2`,
        [customer, deviceId],
      );
    // The three fields of section 2 keep their own current-value stamp beside the location stamp.
    const lagRow = (deviceId) =>
      adminRow(
        `SELECT annotated_user,annotated_user_observed_at,notes,notes_observed_at,org_unit_path,
          org_unit_path_observed_at FROM cc.devices WHERE customer_id=$1 AND device_id=$2`,
        [customer, deviceId],
      );
    const overlayOf = async (deviceId, field) =>
      (
        await admin(
          'SELECT * FROM cc.device_write_overlays WHERE customer_id=$1 AND device_id=$2 AND field=$3',
          [customer, deviceId, field],
        )
      )[0];
    const overlay = (deviceId) => overlayOf(deviceId, 'annotatedLocation');
    const publications = (jobId) =>
      result(
        'SELECT count(*)::int AS result FROM cc.job_publications WHERE job_id=$1',
        [jobId],
      );
    // A waiting statement reports its blocker. The poll reads the wait through pg_blocking_pids,
    // because the runtime and migration roles cannot read the wait event of another session.
    const waitsFor = async (blockedPid, holderPid) => {
      for (let round = 0; round < 200; round += 1) {
        const state = await adminRow(
          'SELECT $2::int = ANY(pg_blocking_pids($1::int)) AS held',
          [blockedPid, holderPid],
        );
        if (state?.held === true) return true;
        await sleep(25);
      }
      return false;
    };

    // A bounded version of waitsFor, for a probe whose wait must not outlast a short lease.
    const waitsBriefly = async (blockedPid, holderPid) => {
      for (let round = 0; round < 80; round += 1) {
        const state = await adminRow(
          'SELECT $2::int = ANY(pg_blocking_pids($1::int)) AS held',
          [blockedPid, holderPid],
        );
        if (state?.held === true) return true;
        await sleep(25);
      }
      return false;
    };

    // A waiting lease fence is only meaningful once its lease really lapsed.
    const until = async (text, values) => {
      for (let round = 0; round < 400; round += 1) {
        if ((await adminRow(text, values))?.lapsed === true) return true;
        await sleep(25);
      }
      return false;
    };

    // The display format, the one-running index, and the admission order.
    await check(
      'the display ID format, the one-running write job index, and the admission order',
      async () => {
        assert.deepEqual(
          await admin(
            `SELECT cc.job_display_id('UPD',7) AS a,cc.job_display_id('UPD',999) AS b,
              cc.job_display_id('UPD',1000) AS c,cc.job_display_id('REF',100000) AS d`,
          ),
          [{ a: 'UPD-007', b: 'UPD-999', c: 'UPD-1000', d: 'REF-100000' }],
        );
        const older = new Date(Date.now() - 10 * 60 * 1000);
        const newer = new Date(Date.now() - 5 * 60 * 1000);
        const tied = await makeJob({
          devices: ['a1', 'a2', 'a3'],
          createdAt: older,
        });
        const tiedLater = await makeJob({
          devices: ['a4', 'a5', 'a6'],
          createdAt: older,
        });
        const newest = await makeJob({
          devices: ['a7', 'a8', 'a9'],
          createdAt: newer,
        });
        const largest = await makeJob({
          devices: ['a1', 'a2', 'a3', 'a4', 'a5'],
          createdAt: new Date(Date.now() - 20 * 60 * 1000),
        });
        const order = [];
        for (let round = 0; round < 4; round += 1) {
          const admitted = await admit(false);
          order.push(admitted.jobId);
          await finalize(admitted.jobId);
        }
        assert.deepEqual(order, [
          tied.jobId,
          tiedLater.jobId,
          newest.jobId,
          largest.jobId,
        ]);
        const first = await makeJob({ devices: ['a1'] });
        const second = await makeJob({ devices: ['a1'] });
        const admitted = await admit(false);
        assert.equal(admitted.jobId, first.jobId);
        await rejects(
          migrator.query(
            "UPDATE cc.jobs SET status='running' WHERE job_id=$1",
            [second.jobId],
          ),
          '23505',
        );
        await finalize(first.jobId);
        await finalize(second.jobId);
      },
    );

    // Retention. A write job stays; a refresh job leaves a week after it finishes.
    await check(
      'write jobs stay, refresh jobs and their targets leave after seven days, previews and overlays when they lapse',
      async () => {
        const write = await makeJob({ devices: ['a1'] });
        await finalize(write.jobId);
        await migrator.query(
          "UPDATE cc.jobs SET finished_at=finished_at-interval '8 days' WHERE job_id=$1",
          [write.jobId],
        );
        const refresh = randomUUID();
        await result(
          'SELECT cc.create_entity_sync_job($1,1,$2,$3,$4,$5,$6,$7) AS result',
          [
            reader,
            customer,
            'device',
            '["a1","a2"]',
            100,
            refresh,
            randomUUID(),
          ],
        );
        await result(
          'SELECT cc.finish_entity_sync_batch($1,$2,$3,$4) AS result',
          [customer, refresh, 0, null],
        );
        await migrator.query(
          "UPDATE cc.jobs SET finished_at=finished_at-interval '8 days' WHERE job_id=$1",
          [refresh],
        );
        assert.equal(
          await result(
            'SELECT count(*)::int AS result FROM cc.job_targets WHERE job_id=$1',
            [refresh],
          ),
          2,
        );
        await resetSync();
        const lapsed = await requestAs(reader);
        await migrator.query(
          "UPDATE cc.device_sync_state SET sync_expires_at=clock_timestamp()-interval '1 minute' WHERE customer_id=$1",
          [customer],
        );
        const previewId = randomUUID();
        await admin(
          `INSERT INTO cc.device_update_previews(preview_id, display_id, customer_id, created_by, permission_version, generation, action, action_version, selected, eligible, unchanged, excluded, manifest_digest, expires_at)
          VALUES($1, cc.job_display_id('PV',nextval('cc.preview_number_pv')), $2, $3, 1, $4, 'annotated-location', 2, 1, 1, 0, 0, 'manifest-digest', clock_timestamp()-interval '25 hours')`,
          [previewId, customer, confirmer, generation],
        );
        await admin(
          `INSERT INTO cc.device_update_preview_targets(preview_id,ordinal,device_id,serial_number,org_unit_path,
            disposition) VALUES($1,0,'a1','SN-a1','/School A','eligible')`,
          [previewId],
        );
        await upsert([device('a1', { annotatedLocation: 'old' })], new Date());
        await admin(
          `INSERT INTO cc.device_write_overlays(customer_id,device_id,field,value,observed_at,source,job_id,expires_at)
          VALUES($1,'a1','annotatedLocation','Room 12',clock_timestamp()-interval '40 hours','write-response',$2,
            clock_timestamp()-interval '1 hour')`,
          [customer, write.jobId],
        );
        assert.ok(
          (await result('SELECT cc.purge_jobs($1,$2) AS result', [
            customer,
            100,
          ])) >= 1,
        );
        assert.equal(
          await result(
            'SELECT count(*)::int AS result FROM cc.jobs WHERE job_id=$1',
            [write.jobId],
          ),
          1,
        );
        assert.equal(
          await result(
            'SELECT count(*)::int AS result FROM cc.jobs WHERE job_id=$1',
            [refresh],
          ),
          0,
        );
        assert.equal(
          await result(
            'SELECT count(*)::int AS result FROM cc.job_targets WHERE job_id=$1',
            [refresh],
          ),
          0,
        );
        assert.equal(
          await result(
            'SELECT count(*)::int AS result FROM cc.entity_sync_jobs WHERE job_id=$1',
            [refresh],
          ),
          0,
        );
        const closed = await jobRow(lapsed.id);
        assert.equal(closed.status, 'failed');
        assert.equal(closed.failure, 'interrupted');
        assert.equal(
          await result(
            'SELECT count(*)::int AS result FROM cc.device_update_previews WHERE preview_id=$1',
            [previewId],
          ),
          0,
        );
        assert.equal(await overlay('a1'), undefined);
      },
    );

    // An empty inventory finishes a full sync.
    await check(
      'a full sync without pages finishes completed with no targets',
      async () => {
        await resetSync();
        const empty = await requestAs(reader);
        const attempt = randomUUID();
        await claimSync(empty.id, attempt);
        await finishSync(empty.id, attempt);
        const header = await jobRow(empty.id);
        assert.equal(header.status, 'completed');
        assert.equal(header.target_count, 0);
        assert.equal(header.succeeded, 0);
        assert.deepEqual(header.target_org_unit_paths, []);
        const expected = await adminRow(
          'SELECT count(*)::int AS count FROM cc.devices WHERE customer_id=$1 AND removed_at IS NULL',
          [customer],
        );
        assert.equal((await readAs(reader)).deviceCount, expected.count);
      },
    );

    // A full sync far above the ID list cap finishes with its count and its target paths.
    await check(
      'a full sync of 100,001 devices finishes with that count and records each target path',
      async () => {
        await resetSync();
        const large = await requestAs(reader);
        const attempt = randomUUID();
        await claimSync(large.id, attempt);
        for (let page = 0; page < 101; page += 1) {
          const devices = [];
          const size = page === 100 ? 1 : 1000;
          for (let index = 0; index < size; index += 1) {
            const number = page * 1000 + index;
            devices.push(
              device(`big${String(number).padStart(6, '0')}`, {
                orgUnitPath: number % 2 === 0 ? '/School A' : '/School B',
              }),
            );
          }
          await stage(large.id, attempt, devices);
        }
        await finishSync(large.id, attempt);
        const header = await jobRow(large.id);
        assert.equal(header.status, 'completed');
        assert.equal(header.target_count, 100001);
        assert.equal(header.succeeded, 100001);
        assert.deepEqual(header.target_org_unit_paths, [
          '/School A',
          '/School B',
        ]);
        const targets = await admin(
          'SELECT device_id,org_unit_path FROM cc.job_targets WHERE job_id=$1 AND device_id IN ($2,$3) ORDER BY device_id',
          [large.id, 'big000000', 'big000001'],
        );
        assert.deepEqual(targets, [
          { device_id: 'big000000', org_unit_path: '/School A' },
          { device_id: 'big000001', org_unit_path: '/School B' },
        ]);
        const listed = randomUUID();
        await result(
          'SELECT cc.create_entity_sync_job($1,1,$2,$3,$4,$5,$6,$7) AS result',
          [
            reader,
            customer,
            'device',
            '["big000000","big000001"]',
            100,
            listed,
            randomUUID(),
          ],
        );
        assert.deepEqual(
          await admin(
            'SELECT device_id,org_unit_path FROM cc.job_targets WHERE job_id=$1 ORDER BY device_id',
            [listed],
          ),
          [
            { device_id: 'big000000', org_unit_path: '/School A' },
            { device_id: 'big000001', org_unit_path: '/School B' },
          ],
        );
        assert.deepEqual((await jobRow(listed)).target_org_unit_paths, [
          '/School A',
          '/School B',
        ]);
        const tooMany = Array.from(
          { length: 100001 },
          (_, index) => `cap${index}`,
        );
        await rejects(
          result(
            'SELECT cc.create_entity_sync_job($1,1,$2,$3,$4,$5,$6,$7) AS result',
            [
              reader,
              customer,
              'device',
              JSON.stringify(tooMany),
              1000,
              randomUUID(),
              randomUUID(),
            ],
          ),
          '23514',
        );
        await result(
          'SELECT cc.abandon_entity_sync_job($1,1,$2,$3) AS result',
          [reader, customer, listed],
        );
      },
    );

    // A start that no worker claims rotates its token twice and then fails.
    await check(
      'the tick rotates the token up to three executions and then fails orchestration-unavailable',
      async () => {
        const job = await makeJob({ devices: ['a1', 'a2'] });
        const admitted = await admit(false);
        assert.equal(admitted.jobId, job.jobId);
        const tokens = [admitted.dispatchToken];
        await result('SELECT cc.record_device_update_start($1,$2,$3,$4)', [
          customer,
          job.jobId,
          admitted.dispatchToken,
          'kestra-execution-1',
        ]);
        for (let round = 0; round < 3; round += 1) {
          await migrator.query(
            "UPDATE cc.device_update_jobs SET start_deadline_at=clock_timestamp()-interval '1 second' WHERE job_id=$1",
            [job.jobId],
          );
          const recovered = await recover();
          const start = recovered.starts[0];
          if (round < 2) {
            assert.equal(start.jobId, job.jobId);
            assert.notEqual(start.dispatchToken, tokens.at(-1));
            tokens.push(start.dispatchToken);
          }
        }
        const detail = await adminRow(
          'SELECT dispatch_count FROM cc.device_update_jobs WHERE job_id=$1',
          [job.jobId],
        );
        assert.equal(detail.dispatch_count, 3);
        const finished = await jobRow(job.jobId);
        assert.equal(finished.status, 'failed');
        assert.equal(finished.failure, 'orchestration-unavailable');
        assert.deepEqual(
          (await operations(job.jobId)).map((row) => row.status),
          ['skipped', 'skipped'],
        );
      },
    );

    // A stale token touches nothing, and a live lease answers busy.
    await check(
      'an old token claims nothing, renews nothing, records nothing, and finishes nothing',
      async () => {
        const job = await makeJob({ devices: ['a1', 'a2'] });
        const admitted = await admit(false);
        const token = admitted.dispatchToken;
        const attempt = randomUUID();
        assert.equal(
          (await claim(job.jobId, randomUUID(), 0, attempt)).outcome,
          'superseded',
        );
        await rejects(
          result(
            'SELECT cc.renew_device_update_batch($1,$2,$3,$4,$5) AS result',
            [customer, job.jobId, randomUUID(), 0, attempt],
          ),
          null,
          'attempt-fenced',
        );
        const claimed = await claim(job.jobId, token, 0, attempt);
        assert.equal(claimed.outcome, 'claimed');
        assert.equal(claimed.operations.length, 2);
        const revision = (await jobRow(job.jobId)).revision;
        // The success carries its provenance, so the call reaches the token fence (round 3, R2-F1).
        const fenced = await settle(
          job.jobId,
          randomUUID(),
          attempt,
          'write',
          [
            {
              operationNumber: 1,
              outcome: 'succeeded',
              values: { annotatedLocation: 'Room 12' },
              verifiedBy: 'write-response',
            },
          ],
          new Date(),
        );
        assert.equal(fenced.outcome, 'fenced');
        assert.equal((await jobRow(job.jobId)).revision, revision);
        assert.deepEqual(
          (await operations(job.jobId)).map((row) => row.status),
          ['dispatched', 'dispatched'],
        );
        assert.equal(
          (await prepareFinish(job.jobId, randomUUID())).outcome,
          'superseded',
        );
        await endJob(job.jobId);
      },
    );

    // The fenced attempt and the delayed result of one job.
    const fleet = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'];
    await check(
      'a second attempt receives busy while the first lease lives',
      async () => {
        const job = await makeJob({ devices: fleet, batchSize: 2 });
        const admitted = await admit(false);
        const attempt = randomUUID();
        const claimed = await claim(
          job.jobId,
          admitted.dispatchToken,
          0,
          attempt,
        );
        assert.equal(claimed.outcome, 'claimed');
        const again = await claim(
          job.jobId,
          admitted.dispatchToken,
          0,
          randomUUID(),
        );
        assert.equal(again.outcome, 'busy');
        await endJob(job.jobId);
      },
    );

    await check(
      'a new claim after the grace period fences the lost attempt',
      async () => {
        const job = await makeJob({ devices: fleet, batchSize: 2 });
        const admitted = await admit(false);
        const stale = randomUUID();
        await claim(job.jobId, admitted.dispatchToken, 0, stale);
        await expireBatches(job.jobId);
        const fresh = randomUUID();
        const claimed = await claim(
          job.jobId,
          admitted.dispatchToken,
          0,
          fresh,
        );
        assert.equal(claimed.outcome, 'claimed');
        assert.deepEqual(
          claimed.readBack.map((row) => row.deviceId),
          ['b1', 'b2'],
        );
        const rows = await operations(job.jobId);
        assert.deepEqual(
          rows
            .slice(0, 2)
            .map((row) => [row.status, row.outcome_reason, row.verify_attempt]),
          [
            ['unknown', 'interrupted', fresh],
            ['unknown', 'interrupted', fresh],
          ],
        );
        await endJob(job.jobId);
      },
    );

    await check(
      'a delayed result from a fenced attempt changes no outcome, counter, device row, or overlay',
      async () => {
        const job = await makeJob({ devices: fleet, batchSize: 2 });
        const admitted = await admit(false);
        const stale = randomUUID();
        const first = await claim(job.jobId, admitted.dispatchToken, 0, stale);
        assert.equal(first.outcome, 'claimed');
        await expireBatches(job.jobId);
        const fresh = randomUUID();
        await claim(job.jobId, admitted.dispatchToken, 0, fresh);
        const before = await jobRow(job.jobId);
        await upsert(
          [device('b1', { annotatedLocation: 'listed' })],
          new Date(),
        );
        const late = await settle(
          job.jobId,
          admitted.dispatchToken,
          stale,
          'write',
          [
            {
              operationNumber: 1,
              outcome: 'succeeded',
              values: { annotatedLocation: 'Stale' },
              verifiedBy: 'write-response',
            },
            {
              operationNumber: 2,
              outcome: 'failed',
              googleStatus: 500,
              verifiedBy: 'write-response',
            },
          ],
          new Date(),
        );
        assert.deepEqual(late.settled, []);
        assert.equal(late.publication, null);
        const after = await jobRow(job.jobId);
        assert.deepEqual(
          [
            after.succeeded,
            after.failed,
            after.unknown,
            after.skipped,
            after.revision,
          ],
          [
            before.succeeded,
            before.failed,
            before.unknown,
            before.skipped,
            before.revision,
          ],
        );
        assert.deepEqual(
          (await operations(job.jobId)).map((row) => row.status),
          ['unknown', 'unknown', 'pending', 'pending', 'pending', 'pending'],
        );
        assert.equal((await deviceRow('b1')).annotated_location, 'listed');
        assert.equal(await overlay('b1'), undefined);
        await endJob(job.jobId);
      },
    );

    await check(
      'a live lease answers busy and the finish fences dispatched and skips pending',
      async () => {
        const job = await makeJob({ devices: fleet, batchSize: 2 });
        const admitted = await admit(false);
        const token = admitted.dispatchToken;
        const attempt = randomUUID();
        await claim(job.jobId, token, 0, attempt);
        assert.equal((await prepareFinish(job.jobId, token)).outcome, 'busy');
        await claim(job.jobId, token, 1, attempt);
        await expireBatches(job.jobId);
        const ready = await prepareFinish(job.jobId, token);
        assert.equal(ready.outcome, 'ready');
        assert.deepEqual(
          (await operations(job.jobId)).map((row) => [
            row.status,
            row.outcome_reason,
          ]),
          [
            ['unknown', 'interrupted'],
            ['unknown', 'interrupted'],
            ['unknown', 'interrupted'],
            ['unknown', 'interrupted'],
            ['skipped', 'interrupted'],
            ['skipped', 'interrupted'],
          ],
        );
        const finished = await finishJob(job.jobId);
        assert.equal(finished.status, 'needs-review');
        assert.equal(
          await result(
            "SELECT count(*)::int AS result FROM cc.device_update_operations WHERE job_id=$1 AND status IN ('dispatched','pending')",
            [job.jobId],
          ),
          0,
        );
      },
    );

    await check(
      'no live lease and an old heartbeat rotate the token; three executions end the job',
      async () => {
        const job = await makeJob({ devices: ['b1', 'b2'] });
        const admitted = await admit(false);
        const token = admitted.dispatchToken;
        await claim(job.jobId, token, 0, randomUUID());
        const rotate = async () => {
          await migrator.query(
            `UPDATE cc.device_update_batches SET lease_expires_at=clock_timestamp()-interval '1 minute' WHERE job_id=$1`,
            [job.jobId],
          );
          await migrator.query(
            "UPDATE cc.device_update_jobs SET heartbeat_at=clock_timestamp()-interval '20 minutes' WHERE job_id=$1",
            [job.jobId],
          );
          return recover();
        };
        const first = await rotate();
        assert.equal(first.starts[0].jobId, job.jobId);
        assert.ok(first.starts[0].dispatchToken);
        assert.notEqual(first.starts[0].dispatchToken, token);
        const heartbeat = await adminRow(
          'SELECT heartbeat_at FROM cc.device_update_jobs WHERE job_id=$1',
          [job.jobId],
        );
        assert.ok(Date.now() - heartbeat.heartbeat_at.getTime() < 60 * 1000);
        await rotate();
        const last = await rotate();
        assert.deepEqual(last.starts, []);
        const finished = await jobRow(job.jobId);
        assert.notEqual(finished.status, 'running');
        assert.ok(last.reconciles.includes(job.jobId));
        assert.deepEqual(
          (await operations(job.jobId)).map((row) => row.status),
          ['unknown', 'unknown'],
        );
      },
    );

    // The terminal status rule and the read-back that revises it.
    await check(
      'the status rule derives failed, needs-review, and a later read-back status',
      async () => {
        const failedJob = await makeJob({ devices: ['c1', 'c2'] });
        const failedAdmit = await admit(false);
        const failedAttempt = randomUUID();
        await claim(
          failedJob.jobId,
          failedAdmit.dispatchToken,
          0,
          failedAttempt,
        );
        await settle(
          failedJob.jobId,
          failedAdmit.dispatchToken,
          failedAttempt,
          'write',
          [
            {
              operationNumber: 1,
              outcome: 'failed',
              googleStatus: 403,
              googleReason: 'forbidden',
              verifiedBy: 'write-response',
            },
            {
              operationNumber: 2,
              outcome: 'failed',
              googleStatus: 403,
              googleReason: 'forbidden',
              verifiedBy: 'write-response',
            },
          ],
          new Date(),
        );
        const failed = await prepareFinish(
          failedJob.jobId,
          failedAdmit.dispatchToken,
        );
        assert.equal(failed.outcome, 'ready');
        const failedStatus = await finishJob(failedJob.jobId);
        assert.equal(failedStatus.status, 'failed');
        assert.deepEqual(
          [failedStatus.succeeded, failedStatus.failed, failedStatus.unknown],
          [0, 2, 0],
        );
        const review = await makeJob({ devices: ['c1', 'c2'] });
        const reviewAdmit = await admit(false);
        const reviewAttempt = randomUUID();
        await claim(review.jobId, reviewAdmit.dispatchToken, 0, reviewAttempt);
        await settle(
          review.jobId,
          reviewAdmit.dispatchToken,
          reviewAttempt,
          'write',
          [
            {
              operationNumber: 1,
              outcome: 'succeeded',
              values: { annotatedLocation: 'Room 12' },
              verifiedBy: 'write-response',
            },
          ],
          new Date(),
        );
        await prepareFinish(
          review.jobId,
          reviewAdmit.dispatchToken,
          'network-failure',
        );
        const reviewStatus = await finishJob(review.jobId);
        assert.equal(reviewStatus.status, 'needs-review');
        assert.deepEqual(
          [reviewStatus.succeeded, reviewStatus.failed, reviewStatus.unknown],
          [1, 0, 1],
        );
        const readBack = randomUUID();
        const claimedVerification = await claimVerification(
          review.jobId,
          [2],
          readBack,
        );
        assert.equal(claimedVerification.length, 1);
        const settled = await settle(
          review.jobId,
          reviewAdmit.dispatchToken,
          readBack,
          'read-back',
          [
            {
              operationNumber: 2,
              outcome: 'succeeded',
              values: { annotatedLocation: 'Room 12' },
              verifiedBy: 'read-back',
            },
          ],
          new Date(),
        );
        assert.equal(settled.settled.length, 1);
        assert.equal(settled.publication.statusChanged, true);
        const revised = await jobRow(review.jobId);
        assert.equal(revised.status, 'completed');
        assert.ok(revised.finished_at instanceof Date);
      },
    );

    // Revalidation of the confirmer and the connection before dispatch.
    await check(
      'a permission version change, a revoked grant, and a connection change stop a run',
      async () => {
        const versioned = await makeJob({
          devices: ['d1', 'd2', 'd3', 'd4'],
          batchSize: 2,
        });
        const versionedAdmit = await admit(false);
        const first = await claim(
          versioned.jobId,
          versionedAdmit.dispatchToken,
          0,
          randomUUID(),
        );
        assert.equal(first.outcome, 'claimed');
        await migrator.query(
          'UPDATE cc.application_principals SET permission_version=permission_version+1 WHERE id=$1',
          [confirmer],
        );
        const stopped = await claim(
          versioned.jobId,
          versionedAdmit.dispatchToken,
          1,
          randomUUID(),
        );
        assert.equal(stopped.outcome, 'stopped');
        assert.equal(stopped.failure, 'permission-changed');
        assert.equal(
          (await jobRow(versioned.jobId)).failure,
          'permission-changed',
        );
        assert.deepEqual(
          (await operations(versioned.jobId)).map((row) => [
            row.status,
            row.outcome_reason,
          ]),
          [
            ['dispatched', null],
            ['dispatched', null],
            ['skipped', 'permission-changed'],
            ['skipped', 'permission-changed'],
          ],
        );
        await endJob(versioned.jobId);
        await migrator.query(
          'UPDATE cc.application_principals SET permission_version=1 WHERE id=$1',
          [confirmer],
        );

        const revoked = await makeJob({
          devices: ['d1', 'd2'],
          createdBy: confirmerB,
        });
        const revokedAdmit = await admit(false);
        await migrator.query(
          "DELETE FROM cc.application_grants WHERE principal_id=$1 AND action='devices:bulk-actions'",
          [confirmerB],
        );
        const stoppedByGrant = await claim(
          revoked.jobId,
          revokedAdmit.dispatchToken,
          0,
          randomUUID(),
        );
        assert.equal(stoppedByGrant.outcome, 'stopped');
        assert.equal(stoppedByGrant.failure, 'permission-changed');
        await migrator.query(
          "INSERT INTO cc.application_grants(principal_id,action,scope) VALUES($1,'devices:bulk-actions',$2)",
          [confirmerB, JSON.stringify(district())],
        );
        await finalize(revoked.jobId);

        const changed = await makeJob({ devices: ['d1', 'd2'] });
        const changedAdmit = await admit(false);
        const replaced = await adminRow(
          `INSERT INTO cc.google_credentials(id,generation,customer_id,envelope,client_id,delegated_subject)
          SELECT gen_random_uuid(),(SELECT max(generation)+1 FROM cc.google_credentials),customer_id,envelope,
            client_id,delegated_subject FROM cc.google_credentials WHERE id=$1
          RETURNING id,generation`,
          [connection.credential_id],
        );
        await migrator.query(
          'UPDATE cc.google_connection SET credential_id=$2,generation=$3 WHERE customer_id=$1',
          [customer, replaced.id, replaced.generation],
        );
        try {
          const stoppedByConnection = await claim(
            changed.jobId,
            changedAdmit.dispatchToken,
            0,
            randomUUID(),
          );
          assert.equal(stoppedByConnection.outcome, 'stopped');
          assert.equal(stoppedByConnection.failure, 'connection-changed');
        } finally {
          await migrator.query(
            'UPDATE cc.google_connection SET credential_id=$2,generation=$3 WHERE customer_id=$1',
            [customer, connection.credential_id, generation],
          );
          await migrator.query(
            'DELETE FROM cc.google_credentials WHERE id=$1',
            [replaced.id],
          );
        }
        await finalize(changed.jobId);

        const inactive = await makeJob({ devices: ['d1', 'd2'] });
        const inactiveAdmit = await admit(false);
        await migrator.query(
          'UPDATE cc.google_connection SET active=false WHERE customer_id=$1',
          [customer],
        );
        try {
          assert.equal(
            (
              await claim(
                inactive.jobId,
                inactiveAdmit.dispatchToken,
                0,
                randomUUID(),
              )
            ).failure,
            'connection-changed',
          );
        } finally {
          await migrator.query(
            'UPDATE cc.google_connection SET active=true WHERE customer_id=$1',
            [customer],
          );
        }
        await finalize(inactive.jobId);
      },
    );

    // The overlay rules of section 5.8.
    await check(
      'a Replace then a Clear leaves the row and the overlay null',
      async () => {
        await upsert(
          [
            device('x1', { annotatedLocation: 'old' }),
            device('x2', { annotatedLocation: 'old' }),
          ],
          new Date(Date.now() - 60 * 60 * 1000),
        );
        const replace = await makeJob({ devices: ['x1', 'x2'] });
        const replaceAdmit = await admit(false);
        const replaceAttempt = randomUUID();
        await claim(
          replace.jobId,
          replaceAdmit.dispatchToken,
          0,
          replaceAttempt,
        );
        const replacedAt = new Date();
        await settle(
          replace.jobId,
          replaceAdmit.dispatchToken,
          replaceAttempt,
          'write',
          [
            {
              operationNumber: 1,
              outcome: 'succeeded',
              values: { annotatedLocation: 'Room 12' },
              verifiedBy: 'write-response',
            },
            {
              operationNumber: 2,
              outcome: 'succeeded',
              values: { annotatedLocation: 'Room 12' },
              verifiedBy: 'write-response',
            },
          ],
          replacedAt,
        );
        for (const id of ['x1', 'x2']) {
          const row = await deviceRow(id);
          assert.equal(row.annotated_location, 'Room 12');
          assert.equal(
            row.annotated_location_observed_at.getTime(),
            replacedAt.getTime(),
          );
          const written = await overlay(id);
          assert.equal(written.value, 'Room 12');
          assert.equal(written.source, 'write-response');
          assert.equal(written.observed_at.getTime(), replacedAt.getTime());
        }
        await prepareFinish(replace.jobId, replaceAdmit.dispatchToken);
        await finishJob(replace.jobId);
        const clear = await makeJob({ devices: ['x1', 'x2'], mode: 'clear' });
        const clearAdmit = await admit(false);
        const clearAttempt = randomUUID();
        await claim(clear.jobId, clearAdmit.dispatchToken, 0, clearAttempt);
        const clearedAt = new Date();
        await settle(
          clear.jobId,
          clearAdmit.dispatchToken,
          clearAttempt,
          'write',
          [
            {
              operationNumber: 1,
              outcome: 'succeeded',
              values: { annotatedLocation: null },
              verifiedBy: 'write-response',
            },
            {
              operationNumber: 2,
              outcome: 'succeeded',
              values: { annotatedLocation: null },
              verifiedBy: 'write-response',
            },
          ],
          clearedAt,
        );
        for (const id of ['x1', 'x2']) {
          const row = await deviceRow(id);
          assert.equal(row.annotated_location, null);
          assert.equal(
            row.annotated_location_observed_at.getTime(),
            clearedAt.getTime(),
          );
          const written = await overlay(id);
          assert.equal(written.value, null);
          assert.equal(written.source, 'write-response');
          assert.equal(
            written.expires_at.getTime() - clearedAt.getTime(),
            36 * 60 * 60 * 1000,
          );
        }
        await prepareFinish(clear.jobId, clearAdmit.dispatchToken);
        await finishJob(clear.jobId);
      },
    );

    await check(
      'a list with the old value keeps the accepted write and a converging list deletes the overlay',
      async () => {
        const listed = new Date(Date.now() - 60 * 60 * 1000);
        await upsert([device('y1', { annotatedLocation: 'old' })], listed);
        const job = await makeJob({ devices: ['y1'] });
        const admitted = await admit(false);
        const attempt = randomUUID();
        await claim(job.jobId, admitted.dispatchToken, 0, attempt);
        const writtenAt = new Date();
        await settle(
          job.jobId,
          admitted.dispatchToken,
          attempt,
          'write',
          [
            {
              operationNumber: 1,
              outcome: 'succeeded',
              values: { annotatedLocation: 'Room 12' },
              verifiedBy: 'write-response',
            },
          ],
          writtenAt,
        );
        await prepareFinish(job.jobId, admitted.dispatchToken);
        await finishJob(job.jobId);
        const readAt = new Date();
        await upsert(
          [device('y1', { annotatedLocation: 'Room 12' })],
          readAt,
          'read',
        );
        const afterRead = await overlay('y1');
        assert.equal(afterRead.value, 'Room 12');
        assert.equal(afterRead.source, 'refresh-read');
        assert.equal(afterRead.observed_at.getTime(), readAt.getTime());
        const laggedAt = new Date(Date.now() + 1000);
        await upsert([device('y1', { annotatedLocation: 'old' })], laggedAt);
        assert.equal((await deviceRow('y1')).annotated_location, 'Room 12');
        assert.equal((await overlay('y1')).value, 'Room 12');
        await upsert(
          [device('y1', { annotatedLocation: 'Room 12' })],
          new Date(Date.now() + 2000),
        );
        assert.equal((await deviceRow('y1')).annotated_location, 'Room 12');
        assert.equal(await overlay('y1'), undefined);
        assert.equal(
          (await deviceRow('y1')).annotated_location_observed_at.getTime(),
          readAt.getTime(),
        );
      },
    );

    // Section 5 of the addendum: the status field follows the same overlay and observation rules.
    await check(
      'a status list converges its overlay and leaves a different annotated-location overlay',
      async () => {
        const listed = new Date(Date.now() - 60 * 60 * 1000);
        await upsert(
          [device('st1', { annotatedLocation: 'Room 12', status: 'DISABLED' })],
          listed,
        );
        const job = await makeJob({ devices: ['st1'] });
        const writtenAt = new Date(Date.now() - 30 * 60 * 1000);
        await admin(
          `INSERT INTO cc.device_write_overlays(customer_id,device_id,field,value,observed_at,source,job_id,expires_at)
          VALUES($1,'st1','annotatedLocation','Room 12',$2::timestamptz,'write-response',$3,$2::timestamptz+interval '36 hours'),
            ($1,'st1','status','DISABLED',$2::timestamptz,'write-response',$3,$2::timestamptz+interval '36 hours')`,
          [customer, writtenAt, job.jobId],
        );
        const laggedAt = new Date();
        await upsert(
          [device('st1', { annotatedLocation: 'old', status: 'DISABLED' })],
          laggedAt,
        );
        assert.equal(
          await overlayOf('st1', 'status'),
          undefined,
          'The matching status list converges the status overlay.',
        );
        assert.ok(
          await overlayOf('st1', 'annotatedLocation'),
          'The different annotated-location list keeps that overlay.',
        );
        assert.equal((await deviceRow('st1')).status, 'DISABLED');
        await upsert(
          [device('st1', { annotatedLocation: 'old', status: 'ACTIVE' })],
          new Date(laggedAt.getTime() + 1000),
        );
        assert.equal(
          (await deviceRow('st1')).status,
          'ACTIVE',
          'The next ACTIVE list reads ACTIVE again.',
        );
        assert.equal((await deviceRow('st1')).annotated_location, 'Room 12');
        await finalize(job.jobId);
      },
    );

    await check(
      'a refresh read moves the live status overlay and its stamp',
      async () => {
        const listed = new Date(Date.now() - 60 * 60 * 1000);
        await upsert([device('st2', { status: 'ACTIVE' })], listed);
        const job = await makeJob({ devices: ['st2'] });
        const writtenAt = new Date(Date.now() - 45 * 60 * 1000);
        await admin(
          `INSERT INTO cc.device_write_overlays(customer_id,device_id,field,value,observed_at,source,job_id,expires_at)
          VALUES($1,'st2','status','DISABLED',$2::timestamptz,'write-response',$3,$2::timestamptz+interval '36 hours')`,
          [customer, writtenAt, job.jobId],
        );
        const readAt = new Date();
        await upsert([device('st2', { status: 'DISABLED' })], readAt, 'read');
        const first = await overlayOf('st2', 'status');
        assert.equal(first.value, 'DISABLED');
        assert.equal(first.source, 'refresh-read');
        assert.equal(first.observed_at.getTime(), readAt.getTime());
        assert.equal((await deviceRow('st2')).status, 'DISABLED');
        assert.equal(
          (await deviceRow('st2')).status_observed_at.getTime(),
          readAt.getTime(),
        );
        const nextRead = new Date(readAt.getTime() + 1000);
        await upsert([device('st2', { status: 'ACTIVE' })], nextRead, 'read');
        const second = await overlayOf('st2', 'status');
        assert.equal(second.value, 'ACTIVE');
        assert.equal(second.source, 'refresh-read');
        assert.equal(second.observed_at.getTime(), nextRead.getTime());
        assert.equal((await deviceRow('st2')).status, 'ACTIVE');
        await finalize(job.jobId);
      },
    );

    // Section 8, List lag row: each of the three fields keeps its value through a lagged list, an
    // equal list deletes the overlay, and a path converges without case. The write path that
    // publishes the value and creates the overlay arrives in U5, so the fixtures set the row and
    // insert the overlay directly.
    await check(
      'a lagged list keeps the annotated-user, notes, and organization-unit overlays',
      async () => {
        const old = {
          annotatedUser: 'old@example.org',
          notes: 'Old note',
          orgUnitPath: '/School A',
        };
        const written = {
          annotatedUser: 'new@example.org',
          notes: 'New note',
          orgUnitPath: '/School B',
        };
        await upsert(
          [device('lu1', written)],
          new Date(Date.now() - 60 * 60 * 1000),
        );
        const job = await makeJob({ devices: ['lu1'] });
        const writtenAt = new Date();
        for (const [field, value] of Object.entries(written))
          await admin(
            `INSERT INTO cc.device_write_overlays(customer_id,device_id,field,value,observed_at,source,job_id,expires_at)
              VALUES($1,'lu1',$2,$3,$4::timestamptz,'write-response',$5,$4::timestamptz+interval '36 hours')`,
            [customer, field, value, writtenAt, job.jobId],
          );
        await upsert([device('lu1', old)], new Date());
        const row = await lagRow('lu1');
        assert.equal(
          row.annotated_user,
          'new@example.org',
          'The lagged list keeps the annotated-user value.',
        );
        assert.equal(
          row.notes,
          'New note',
          'The lagged list keeps the notes value.',
        );
        assert.equal(
          row.org_unit_path,
          '/School B',
          'The lagged list keeps the destination organization unit.',
        );
        assert.equal(
          row.annotated_user_observed_at,
          null,
          'A list never sets the annotated-user stamp.',
        );
        assert.equal(
          row.notes_observed_at,
          null,
          'A list never sets the notes stamp.',
        );
        assert.equal(
          row.org_unit_path_observed_at,
          null,
          'A list never sets the organization-unit stamp.',
        );
        assert.ok(await overlayOf('lu1', 'annotatedUser'));
        assert.ok(await overlayOf('lu1', 'notes'));
        assert.ok(await overlayOf('lu1', 'orgUnitPath'));
        await finalize(job.jobId);
      },
    );

    await check(
      'an equal list deletes each annotation overlay and keeps its value',
      async () => {
        const written = {
          annotatedUser: 'new@example.org',
          notes: 'New note',
          orgUnitPath: '/School B',
        };
        await upsert(
          [device('lu2', written)],
          new Date(Date.now() - 60 * 60 * 1000),
        );
        const job = await makeJob({ devices: ['lu2'] });
        const writtenAt = new Date();
        for (const [field, value] of Object.entries(written))
          await admin(
            `INSERT INTO cc.device_write_overlays(customer_id,device_id,field,value,observed_at,source,job_id,expires_at)
              VALUES($1,'lu2',$2,$3,$4::timestamptz,'write-response',$5,$4::timestamptz+interval '36 hours')`,
            [customer, field, value, writtenAt, job.jobId],
          );
        await upsert([device('lu2', written)], new Date());
        const row = await lagRow('lu2');
        assert.equal(row.annotated_user, 'new@example.org');
        assert.equal(row.notes, 'New note');
        assert.equal(row.org_unit_path, '/School B');
        assert.equal(await overlayOf('lu2', 'annotatedUser'), undefined);
        assert.equal(await overlayOf('lu2', 'notes'), undefined);
        assert.equal(await overlayOf('lu2', 'orgUnitPath'), undefined);
        assert.equal(
          row.annotated_user_observed_at,
          null,
          'The converging list sets no stamp.',
        );
        assert.equal(row.notes_observed_at, null);
        assert.equal(row.org_unit_path_observed_at, null);
        await upsert(
          [
            device('lu2', {
              annotatedUser: 'later@example.org',
              notes: 'Later note',
              orgUnitPath: '/School C',
            }),
          ],
          new Date(Date.now() + 1000),
        );
        const later = await lagRow('lu2');
        assert.equal(
          later.annotated_user,
          'later@example.org',
          'Without an overlay the next list sets the annotated user.',
        );
        assert.equal(later.notes, 'Later note');
        assert.equal(later.org_unit_path, '/School C');
        await finalize(job.jobId);
      },
    );

    await check(
      'a list of the destination path in other case converges the organization-unit overlay',
      async () => {
        await upsert(
          [device('lu3', { orgUnitPath: '/School A' })],
          new Date(Date.now() - 60 * 60 * 1000),
        );
        const job = await makeJob({ devices: ['lu3'] });
        const writtenAt = new Date();
        await admin(
          `INSERT INTO cc.device_write_overlays(customer_id,device_id,field,value,observed_at,source,job_id,expires_at)
            VALUES($1,'lu3','orgUnitPath','/School A',$2::timestamptz,'write-response',$3,$2::timestamptz+interval '36 hours')`,
          [customer, writtenAt, job.jobId],
        );
        await upsert([device('lu3', { orgUnitPath: '/school a' })], new Date());
        const row = await lagRow('lu3');
        assert.equal(
          row.org_unit_path,
          '/School A',
          'The converging list keeps Google casing of the written path.',
        );
        assert.equal(
          await overlayOf('lu3', 'orgUnitPath'),
          undefined,
          'A path converges without case.',
        );
        await finalize(job.jobId);
      },
    );

    await check(
      'a current read sets each new stamp and an older read leaves the value and the stamp',
      async () => {
        await upsert([device('lu4')], new Date(Date.now() - 60 * 60 * 1000));
        const readAt = new Date();
        assert.equal(
          await upsert(
            [
              device('lu4', {
                annotatedUser: 'read@example.org',
                notes: 'Read note',
                orgUnitPath: '/School B',
              }),
            ],
            readAt,
            'read',
          ),
          1,
        );
        const row = await lagRow('lu4');
        assert.equal(row.annotated_user, 'read@example.org');
        assert.equal(row.notes, 'Read note');
        assert.equal(row.org_unit_path, '/School B');
        assert.equal(
          row.annotated_user_observed_at.getTime(),
          readAt.getTime(),
        );
        assert.equal(row.notes_observed_at.getTime(), readAt.getTime());
        assert.equal(row.org_unit_path_observed_at.getTime(), readAt.getTime());
        assert.equal(
          await upsert(
            [
              device('lu4', {
                annotatedUser: 'older@example.org',
                notes: 'Older note',
                orgUnitPath: '/School C',
              }),
            ],
            new Date(readAt.getTime() - 60 * 1000),
            'read',
          ),
          0,
          'Every new stamp admits its own order.',
        );
        const kept = await lagRow('lu4');
        assert.equal(kept.annotated_user, 'read@example.org');
        assert.equal(kept.notes, 'Read note');
        assert.equal(kept.org_unit_path, '/School B');
        assert.equal(
          kept.annotated_user_observed_at.getTime(),
          readAt.getTime(),
        );
        assert.equal(kept.notes_observed_at.getTime(), readAt.getTime());
        assert.equal(
          kept.org_unit_path_observed_at.getTime(),
          readAt.getTime(),
        );
      },
    );

    await check(
      'the overlay field check accepts the three fields and refuses an unknown one',
      async () => {
        const job = await makeJob({ devices: ['lu5'] });
        for (const field of ['annotatedUser', 'notes', 'orgUnitPath'])
          await admin(
            `INSERT INTO cc.device_write_overlays(customer_id,device_id,field,value,observed_at,source,job_id,expires_at)
              VALUES($1,'lu5',$2,'value',clock_timestamp(),'write-response',$3,clock_timestamp()+interval '36 hours')`,
            [customer, field, job.jobId],
          );
        await rejects(
          admin(
            `INSERT INTO cc.device_write_overlays(customer_id,device_id,field,value,observed_at,source,job_id,expires_at)
              VALUES($1,'lu5','serialNumber','value',clock_timestamp(),'write-response',$2,clock_timestamp()+interval '36 hours')`,
            [customer, job.jobId],
          ),
          '23514',
        );
        await finalize(job.jobId);
      },
    );

    await check(
      'a current status read between divergent field stamps writes the observed status',
      async () => {
        const listed = new Date(Date.now() - 60 * 60 * 1000);
        await upsert(
          [device('st3', { annotatedLocation: 'old', status: 'ACTIVE' })],
          listed,
        );
        const newer = new Date();
        const older = new Date(newer.getTime() - 30 * 60 * 1000);
        await admin(
          `UPDATE cc.devices SET annotated_location='Room 12',annotated_location_observed_at=$2,
            status='ACTIVE',status_observed_at=$3,last_entity_sync=$2
          WHERE customer_id=$1 AND device_id='st3'`,
          [customer, newer, older],
        );
        const readAt = new Date(newer.getTime() - 60 * 1000);
        assert.equal(
          await upsert(
            [
              device('st3', {
                annotatedLocation: 'ignored',
                status: 'DISABLED',
              }),
            ],
            readAt,
            'read',
          ),
          1,
          'The status stamp admits the current read.',
        );
        const row = await deviceRow('st3');
        assert.equal(row.status, 'DISABLED');
        assert.equal(row.status_observed_at.getTime(), readAt.getTime());
        assert.equal(
          row.annotated_location,
          'Room 12',
          'The newer annotated-location observation wins.',
        );
        assert.equal(
          row.annotated_location_observed_at.getTime(),
          newer.getTime(),
        );
      },
    );

    await check(
      'a refresh read stamped before the write leaves the accepted value',
      async () => {
        await upsert([device('z1')], new Date(Date.now() - 60 * 60 * 1000));
        const job = await makeJob({ devices: ['z1'] });
        const admitted = await admit(false);
        const attempt = randomUUID();
        await claim(job.jobId, admitted.dispatchToken, 0, attempt);
        const writtenAt = new Date();
        await settle(
          job.jobId,
          admitted.dispatchToken,
          attempt,
          'write',
          [
            {
              operationNumber: 1,
              outcome: 'succeeded',
              values: { annotatedLocation: 'Room 12' },
              verifiedBy: 'write-response',
            },
          ],
          writtenAt,
        );
        await prepareFinish(job.jobId, admitted.dispatchToken);
        await finishJob(job.jobId);
        const stamp = (
          await deviceRow('z1')
        ).annotated_location_observed_at.getTime();
        await upsert(
          [device('z1', { annotatedLocation: 'in-flight' })],
          new Date(stamp - 60 * 60 * 1000),
          'read',
        );
        const row = await deviceRow('z1');
        assert.equal(row.annotated_location, 'Room 12');
        assert.equal(row.annotated_location_observed_at.getTime(), stamp);
        assert.equal((await overlay('z1')).source, 'write-response');
      },
    );

    await check(
      'a read-back settlement updates the row and the overlay in the settling transaction',
      async () => {
        await upsert([device('r1')], new Date(Date.now() - 60 * 60 * 1000));
        const job = await makeJob({ devices: ['r1'] });
        const admitted = await admit(false);
        const attempt = randomUUID();
        await claim(job.jobId, admitted.dispatchToken, 0, attempt);
        await stop(job.jobId, admitted.dispatchToken, 0, attempt);
        await prepareFinish(job.jobId, admitted.dispatchToken);
        const readBack = randomUUID();
        await claimVerification(job.jobId, null, readBack);
        const observedAt = new Date();
        const settled = await settle(
          job.jobId,
          null,
          readBack,
          'read-back',
          [
            {
              operationNumber: 1,
              outcome: 'succeeded',
              values: { annotatedLocation: 'Room 9' },
              verifiedBy: 'read-back',
            },
          ],
          observedAt,
        );
        assert.deepEqual(settled.published, ['r1']);
        const row = await deviceRow('r1');
        assert.equal(row.annotated_location, 'Room 9');
        assert.equal(
          row.annotated_location_observed_at.getTime(),
          observedAt.getTime(),
        );
        const written = await overlay('r1');
        assert.equal(written.value, 'Room 9');
        assert.equal(written.source, 'read-back');
        assert.equal(written.observed_at.getTime(), observedAt.getTime());
        assert.equal((await jobRow(job.jobId)).status, 'running');
        await migrator.query(
          "UPDATE cc.device_write_overlays SET expires_at=clock_timestamp()-interval '1 minute' WHERE customer_id=$1 AND device_id='r1'",
          [customer],
        );
        await upsert(
          [device('r1', { annotatedLocation: 'listed-later' })],
          new Date(observedAt.getTime() + 1000),
        );
        assert.equal(
          (await deviceRow('r1')).annotated_location,
          'listed-later',
        );
        await finalize(job.jobId);
      },
    );

    await check(
      'an older read-back records its evidence and publishes nothing',
      async () => {
        const listed = new Date(Date.now() - 3 * 60 * 60 * 1000);
        await upsert([device('s1')], listed);
        const older = await makeJob({ devices: ['s1'] });
        const olderAdmit = await admit(false);
        const olderAttempt = randomUUID();
        await claim(older.jobId, olderAdmit.dispatchToken, 0, olderAttempt);
        await stop(older.jobId, olderAdmit.dispatchToken, 0, olderAttempt);
        await prepareFinish(older.jobId, olderAdmit.dispatchToken);
        await finalize(older.jobId);
        const readBack = randomUUID();
        await claimVerification(older.jobId, null, readBack);
        const newer = await makeJob({ devices: ['s1'] });
        const newerAdmit = await admit(false);
        const newerAttempt = randomUUID();
        await claim(newer.jobId, newerAdmit.dispatchToken, 0, newerAttempt);
        const writtenAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
        await settle(
          newer.jobId,
          newerAdmit.dispatchToken,
          newerAttempt,
          'write',
          [
            {
              operationNumber: 1,
              outcome: 'succeeded',
              values: { annotatedLocation: 'quiet-room' },
              verifiedBy: 'write-response',
            },
          ],
          writtenAt,
        );
        await prepareFinish(newer.jobId, newerAdmit.dispatchToken);
        await finishJob(newer.jobId);
        await upsert(
          [device('s1', { annotatedLocation: 'quiet-room' })],
          new Date(Date.now() - 60 * 60 * 1000),
        );
        assert.equal(await overlay('s1'), undefined);
        const settled = await settle(
          older.jobId,
          null,
          readBack,
          'read-back',
          [
            {
              operationNumber: 1,
              outcome: 'succeeded',
              values: { annotatedLocation: 'stale-room' },
              verifiedBy: 'read-back',
            },
          ],
          new Date(listed.getTime() + 60 * 60 * 1000),
        );
        assert.equal(settled.settled.length, 1);
        const recorded = (await operations(older.jobId))[0];
        assert.equal(recorded.status, 'succeeded');
        assert.equal(recorded.field_observed_value, 'stale-room');
        const row = await deviceRow('s1');
        assert.equal(row.annotated_location, 'quiet-room');
        assert.equal(
          row.annotated_location_observed_at.getTime(),
          writtenAt.getTime(),
        );
        assert.equal(await overlay('s1'), undefined);
      },
    );

    await check(
      'a read-back settled after a newer refresh read publishes nothing',
      async () => {
        await upsert([device('t1')], new Date(Date.now() - 3 * 60 * 60 * 1000));
        const job = await makeJob({ devices: ['t1'] });
        const admitted = await admit(false);
        const attempt = randomUUID();
        await claim(job.jobId, admitted.dispatchToken, 0, attempt);
        await stop(job.jobId, admitted.dispatchToken, 0, attempt);
        await prepareFinish(job.jobId, admitted.dispatchToken);
        await finalize(job.jobId);
        const readBack = randomUUID();
        await claimVerification(job.jobId, null, readBack);
        const readAt = new Date(Date.now() - 60 * 60 * 1000);
        await upsert(
          [device('t1', { annotatedLocation: 'read-room' })],
          readAt,
          'read',
        );
        const settled = await settle(
          job.jobId,
          null,
          readBack,
          'read-back',
          [
            {
              operationNumber: 1,
              outcome: 'succeeded',
              values: { annotatedLocation: 'late-room' },
              verifiedBy: 'read-back',
            },
          ],
          new Date(Date.now() - 2 * 60 * 60 * 1000),
        );
        assert.equal(settled.settled.length, 1);
        const row = await deviceRow('t1');
        assert.equal(row.annotated_location, 'read-room');
        assert.equal(
          row.annotated_location_observed_at.getTime(),
          readAt.getTime(),
        );
        assert.equal(await overlay('t1'), undefined);
      },
    );

    await check(
      'a list never moves the stamp and a lost row takes the read value with its stamp',
      async () => {
        const listAt = new Date();
        await upsert(
          [device('u1', { annotatedLocation: 'listed-room' })],
          listAt,
        );
        assert.equal(
          (await deviceRow('u1')).annotated_location_observed_at,
          null,
        );
        const readAt = new Date(listAt.getTime() - 60 * 60 * 1000);
        await upsert(
          [device('u1', { annotatedLocation: 'read-room' })],
          readAt,
          'read',
        );
        const row = await deviceRow('u1');
        assert.equal(row.annotated_location, 'read-room');
        assert.equal(
          row.annotated_location_observed_at.getTime(),
          readAt.getTime(),
        );
        const job = await makeJob({ devices: ['u1'] });
        const admitted = await admit(false);
        const attempt = randomUUID();
        await claim(job.jobId, admitted.dispatchToken, 0, attempt);
        await stop(job.jobId, admitted.dispatchToken, 0, attempt);
        await prepareFinish(job.jobId, admitted.dispatchToken);
        await finalize(job.jobId);
        const readBack = randomUUID();
        await claimVerification(job.jobId, null, readBack);
        await settle(
          job.jobId,
          null,
          readBack,
          'read-back',
          [
            {
              operationNumber: 1,
              outcome: 'succeeded',
              values: { annotatedLocation: 'stale-room' },
              verifiedBy: 'read-back',
            },
          ],
          new Date(listAt.getTime() - 2 * 60 * 60 * 1000),
        );
        const afterReadBack = await deviceRow('u1');
        assert.equal(afterReadBack.annotated_location, 'read-room');
        assert.equal(
          afterReadBack.annotated_location_observed_at.getTime(),
          readAt.getTime(),
        );
        assert.equal(await overlay('u1'), undefined);
      },
    );

    // Locks stay in device_id order, so a battery page cannot deadlock a device write.
    await check(
      'a battery update for B and A waits without a lock on B',
      async () => {
        await upsert([device('l1'), device('l2'), device('l3')], new Date());
        const holder = await connect('cc-migrator', 'cc-app');
        const writer = await connect('cc-migrator', 'cc-app');
        const readerSession = await connect('cc-migrator', 'cc-app');
        try {
          await holder.query('BEGIN');
          await holder.query(
            'SELECT 1 FROM cc.devices WHERE customer_id=$1 AND device_id=$2 FOR UPDATE',
            [customer, 'l1'],
          );
          const batteries = writer.query(
            'SELECT cc.upsert_device_batteries($1,$2) AS result',
            [
              customer,
              JSON.stringify([
                {
                  deviceId: 'l3',
                  battery: { status: 'no-report' },
                  reports: [],
                },
                {
                  deviceId: 'l2',
                  battery: { status: 'no-report' },
                  reports: [],
                },
                {
                  deviceId: 'l1',
                  battery: { status: 'no-report' },
                  reports: [],
                },
              ]),
            ],
          );
          const blocked = await Promise.race([
            batteries.then(
              () => 'completed',
              () => 'failed',
            ),
            sleep(750).then(() => 'waiting'),
          ]);
          assert.equal(blocked, 'waiting', 'The page waits for l1.');
          const second = readerSession.query(
            'SELECT 1 FROM cc.devices WHERE customer_id=$1 AND device_id=$2 FOR UPDATE',
            [customer, 'l2'],
          );
          const secondState = Promise.race([
            second.then(
              () => 'taken',
              () => 'failed',
            ),
            sleep(750).then(() => 'waiting'),
          ]);
          assert.equal(
            await secondState,
            'taken',
            'The waiting page holds no lock on l2 while it waits for l1.',
          );
          await holder.query('ROLLBACK');
          assert.equal((await batteries).rowCount, 1);
          assert.equal((await second).rowCount, 1);
          await readerSession.query('ROLLBACK');
        } finally {
          await Promise.allSettled([
            holder.end(),
            writer.end(),
            readerSession.end(),
          ]);
        }
      },
    );

    // Section 1.8: the full-sync removal locks its candidates in device_id order before the update.
    await check(
      'a full sync that removes devices waits without a lock on the later device',
      async () => {
        await resetSync();
        // The later devices land first, so an unordered removal reaches them before it waits.
        await upsert([device('rf-c')], new Date(Date.now() - 60 * 60 * 1000));
        await upsert([device('rf-b')], new Date(Date.now() - 60 * 60 * 1000));
        await upsert([device('rf-a')], new Date(Date.now() - 60 * 60 * 1000));
        const sync = await requestAs(reader);
        const attempt = randomUUID();
        await claimSync(sync.id, attempt);
        await stage(sync.id, attempt, [device('rf-kept')]);
        const holder = await connect('cc-migrator', 'cc-app');
        const finisher = await connect('cc-app', 'cc-app');
        const prober = await connect('cc-migrator', 'cc-app');
        let finish = null;
        try {
          const finisherPid = (
            await finisher.query('SELECT pg_backend_pid() AS pid')
          ).rows[0].pid;
          await holder.query('BEGIN');
          await holder.query(
            'SELECT 1 FROM cc.devices WHERE customer_id=$1 AND device_id=$2 FOR UPDATE',
            [customer, 'rf-a'],
          );
          finish = finisher.query(
            'SELECT cc.finish_device_sync($1,$2,$3,$4,$5) AS result',
            [customer, sync.id, attempt, null, null],
          );
          finish.catch(() => undefined);
          let waiting = false;
          for (let round = 0; round < 200 && !waiting; round += 1) {
            const state = await adminRow(
              'SELECT cardinality(pg_blocking_pids($1))>0 AS blocked',
              [finisherPid],
            );
            waiting = state?.blocked === true;
            if (!waiting) await sleep(20);
          }
          assert.equal(waiting, true, 'The removal waits for rf-a.');
          // The waiting removal already holds its header lock (section 1.8, review F11).
          await prober.query("SET lock_timeout='750ms'");
          const headerProbe = await prober
            .query(
              'SELECT 1 FROM cc.jobs WHERE job_id=$1 FOR NO KEY UPDATE NOWAIT',
              [sync.id],
            )
            .then(
              () => 'taken',
              (error) => (error.code === '55P03' ? 'locked' : error.message),
            );
          assert.equal(
            headerProbe,
            'locked',
            'The removal locks its header before its device rows.',
          );
          // The waiting removal holds no lock on the later devices.
          const probe = async (deviceId) => {
            await prober.query("SET lock_timeout='750ms'");
            try {
              await prober.query(
                'SELECT 1 FROM cc.devices WHERE customer_id=$1 AND device_id=$2 FOR UPDATE',
                [customer, deviceId],
              );
              return 'taken';
            } catch (error) {
              if (error.code === '55P03') return 'locked';
              throw error;
            }
          };
          assert.equal(await probe('rf-b'), 'taken');
          assert.equal(await probe('rf-c'), 'taken');
          await holder.query('COMMIT');
          assert.equal((await finish).rows[0].result.status, 'ready');
          assert.deepEqual(
            (
              await admin(
                `SELECT device_id FROM cc.devices WHERE customer_id=$1 AND device_id LIKE 'rf-%'
                  AND removed_at IS NOT NULL ORDER BY device_id`,
                [customer],
              )
            ).map((row) => row.device_id),
            ['rf-a', 'rf-b', 'rf-c'],
          );
          assert.equal((await deviceRow('rf-kept')).removed_at, null);
        } finally {
          // An abandoned finish may keep the full-sync lease. Let it run out, then clear the lease.
          await Promise.allSettled([holder.end(), prober.end()]);
          if (finish)
            await Promise.allSettled([
              finish.then(
                () => undefined,
                () => undefined,
              ),
            ]);
          await migrator
            .query(
              `UPDATE cc.device_sync_state SET sync_id=NULL,sync_actor=NULL,sync_generation=NULL,
                sync_attempt=NULL,sync_expires_at=NULL WHERE customer_id=$1`,
              [customer],
            )
            .catch(() => undefined);
          await Promise.allSettled([finisher.end()]);
        }
      },
    );

    // Section 1.2 and review F13: a failed full-sync finish records its own observed target paths.
    await check(
      'a failed full sync records its observed target paths, with and without staged devices',
      async () => {
        await resetSync();
        const partial = await requestAs(reader);
        const partialAttempt = randomUUID();
        await claimSync(partial.id, partialAttempt);
        await stage(partial.id, partialAttempt, [
          device('fs-a', { orgUnitPath: '/School A' }),
          device('fs-b', { orgUnitPath: '/School B' }),
        ]);
        const before = await publications(partial.id);
        await finishSync(partial.id, partialAttempt, 'quota');
        const header = await jobRow(partial.id);
        assert.equal(header.status, 'failed');
        assert.equal(header.failure, 'quota');
        assert.equal(header.target_count, 2);
        assert.equal(header.succeeded, 2);
        assert.deepEqual(header.target_org_unit_paths, [
          '/School A',
          '/School B',
        ]);
        assert.ok(
          header.finished_at,
          'A failed full sync records its finish time.',
        );
        assert.equal(await publications(partial.id), before + 1);
        const empty = await requestAs(reader);
        const emptyAttempt = randomUUID();
        await claimSync(empty.id, emptyAttempt);
        await finishSync(empty.id, emptyAttempt, 'quota');
        const emptyHeader = await jobRow(empty.id);
        assert.equal(emptyHeader.status, 'failed');
        assert.equal(emptyHeader.target_count, 0);
        assert.deepEqual(emptyHeader.target_org_unit_paths, []);
        await resetSync();
      },
    );

    // Section 1.5 and review F12: the purge closes no header that finished or renewed in its wait.
    await check(
      'the purge leaves a full sync that finished in its wait completed',
      async () => {
        await resetSync();
        const sync = await requestAs(reader);
        const attempt = randomUUID();
        await claimSync(sync.id, attempt);
        // The committed lease lapses, so the purge selects the header. The worker renews the lease in
        // the transaction that finishes the sync, before the purge revalidates.
        await migrator.query(
          "UPDATE cc.device_sync_state SET sync_expires_at=clock_timestamp()-interval '1 minute' WHERE customer_id=$1",
          [customer],
        );
        const finisher = await connect('cc-migrator', 'cc-app');
        const purge = await connect('cc-migrator', 'cc-app');
        let purgeRun = null;
        try {
          const finisherPid = (
            await finisher.query('SELECT pg_backend_pid() AS pid')
          ).rows[0].pid;
          const purgePid = (await purge.query('SELECT pg_backend_pid() AS pid'))
            .rows[0].pid;
          await finisher.query('BEGIN');
          await finisher.query(
            "UPDATE cc.device_sync_state SET sync_expires_at=clock_timestamp()+interval '10 minutes' WHERE customer_id=$1",
            [customer],
          );
          const finished = await finisher.query(
            'SELECT cc.finish_device_sync($1,$2,$3,$4,$5) AS result',
            [customer, sync.id, attempt, null, null],
          );
          assert.equal(finished.rows[0].result.status, 'ready');
          assert.equal(
            (
              await finisher.query(
                'SELECT status FROM cc.jobs WHERE job_id=$1',
                [sync.id],
              )
            ).rows[0].status,
            'completed',
          );
          purgeRun = purge.query('SELECT cc.purge_jobs($1,$2) AS result', [
            customer,
            100,
          ]);
          purgeRun.catch(() => undefined);
          assert.equal(
            await waitsFor(purgePid, finisherPid),
            true,
            'The purge waits for the finishing sync.',
          );
          await finisher.query('COMMIT');
          const settled = await jobRow(sync.id);
          const published = await publications(sync.id);
          await purgeRun;
          const header = await jobRow(sync.id);
          assert.equal(header.status, 'completed');
          assert.equal(header.failure, null);
          assert.equal(header.revision, settled.revision);
          assert.equal(await publications(sync.id), published);
        } finally {
          await finisher.query('ROLLBACK').catch(() => undefined);
          if (purgeRun) await purgeRun.catch(() => undefined);
          await Promise.allSettled([finisher.end(), purge.end()]);
          await resetSync();
        }
      },
    );

    await check(
      'the purge leaves a full sync that renewed its lease in the wait running',
      async () => {
        await resetSync();
        const sync = await requestAs(reader);
        const attempt = randomUUID();
        await claimSync(sync.id, attempt);
        await migrator.query(
          "UPDATE cc.device_sync_state SET sync_expires_at=clock_timestamp()-interval '1 minute' WHERE customer_id=$1",
          [customer],
        );
        const renewer = await connect('cc-migrator', 'cc-app');
        const purge = await connect('cc-migrator', 'cc-app');
        let purgeRun = null;
        let waited = false;
        try {
          const renewerPid = (
            await renewer.query('SELECT pg_backend_pid() AS pid')
          ).rows[0].pid;
          const purgePid = (await purge.query('SELECT pg_backend_pid() AS pid'))
            .rows[0].pid;
          await renewer.query('BEGIN');
          await renewer.query(
            "UPDATE cc.device_sync_state SET sync_expires_at=clock_timestamp()+interval '10 minutes' WHERE customer_id=$1",
            [customer],
          );
          purgeRun = purge.query('SELECT cc.purge_jobs($1,$2) AS result', [
            customer,
            100,
          ]);
          purgeRun.catch(() => undefined);
          waited = await waitsBriefly(purgePid, renewerPid);
          await renewer.query('COMMIT');
          await purgeRun;
        } finally {
          await renewer.query('ROLLBACK').catch(() => undefined);
          if (purgeRun) await purgeRun.catch(() => undefined);
          await Promise.allSettled([renewer.end(), purge.end()]);
        }
        const header = await jobRow(sync.id);
        assert.equal(header.status, 'running');
        assert.equal(header.finished_at, null);
        assert.equal(
          waited,
          true,
          'The purge waits for the renewed sync lease.',
        );
        await resetSync();
      },
    );

    await check(
      'the purge leaves a refresh job that finished in its wait completed',
      async () => {
        const refresh = randomUUID();
        await result(
          'SELECT cc.create_entity_sync_job($1,1,$2,$3,$4,$5,$6,$7) AS result',
          [
            reader,
            customer,
            'device',
            '["a1","a2"]',
            100,
            refresh,
            randomUUID(),
          ],
        );
        // An unfinished refresh job older than two hours is closable.
        await migrator.query(
          "UPDATE cc.jobs SET created_at=created_at-interval '3 hours' WHERE job_id=$1",
          [refresh],
        );
        const finisher = await connect('cc-migrator', 'cc-app');
        const purge = await connect('cc-migrator', 'cc-app');
        let purgeRun = null;
        try {
          const finisherPid = (
            await finisher.query('SELECT pg_backend_pid() AS pid')
          ).rows[0].pid;
          const purgePid = (await purge.query('SELECT pg_backend_pid() AS pid'))
            .rows[0].pid;
          await finisher.query('BEGIN');
          const batch = await finisher.query(
            'SELECT cc.finish_entity_sync_batch($1,$2,$3,$4) AS result',
            [customer, refresh, 0, null],
          );
          assert.ok(batch.rows[0].result.finishedAt);
          purgeRun = purge.query('SELECT cc.purge_jobs($1,$2) AS result', [
            customer,
            100,
          ]);
          purgeRun.catch(() => undefined);
          assert.equal(
            await waitsFor(purgePid, finisherPid),
            true,
            'The purge waits for the finishing refresh job.',
          );
          await finisher.query('COMMIT');
          const settled = await jobRow(refresh);
          const published = await publications(refresh);
          await purgeRun;
          const header = await jobRow(refresh);
          assert.equal(header.status, 'completed');
          assert.equal(header.revision, settled.revision);
          assert.equal(await publications(refresh), published);
        } finally {
          await finisher.query('ROLLBACK').catch(() => undefined);
          if (purgeRun) await purgeRun.catch(() => undefined);
          await Promise.allSettled([finisher.end(), purge.end()]);
          await resetSync();
        }
      },
    );

    // Rule 2 of the round-4 audit: a lease fence reads the clock after its row lock.
    await check(
      'a request that waited for the state lock replaces the sync whose lease lapsed in the wait',
      async () => {
        await resetSync();
        const sync = await requestAs(reader);
        const attempt = randomUUID();
        await claimSync(sync.id, attempt);
        await migrator.query(
          "UPDATE cc.device_sync_state SET sync_expires_at=clock_timestamp()+interval '2 seconds' WHERE customer_id=$1",
          [customer],
        );
        const holder = await connect('cc-migrator', 'cc-app');
        const requester = await connect('cc-app', 'cc-app');
        let requestRun = null;
        try {
          const holderPid = (
            await holder.query('SELECT pg_backend_pid() AS pid')
          ).rows[0].pid;
          const requesterPid = (
            await requester.query('SELECT pg_backend_pid() AS pid')
          ).rows[0].pid;
          await holder.query('BEGIN');
          await holder.query(
            'SELECT 1 FROM cc.device_sync_state WHERE customer_id=$1 FOR UPDATE',
            [customer],
          );
          const replacement = randomUUID();
          requestRun = requester
            .query(
              'SELECT cc.request_device_sync($1,$2,$3,$4,$5,$6) AS result',
              [reader, 1, customer, generation, replacement, randomUUID()],
            )
            .then(
              (answer) => ({ state: answer.rows[0].result }),
              (error) => ({ error }),
            );
          assert.equal(
            await waitsFor(requesterPid, holderPid),
            true,
            'The request waits for the state lock.',
          );
          await sleep(2200);
          await holder.query('COMMIT');
          const answer = await requestRun;
          assert.equal(answer.error?.message ?? 'no error', 'no error');
          assert.equal(answer.state.status, 'running');
          assert.equal((await syncState()).sync_id, replacement);
          const replaced = await jobRow(sync.id);
          assert.equal(replaced.status, 'failed');
          assert.equal(replaced.failure, 'interrupted');
        } finally {
          await holder.query('ROLLBACK').catch(() => undefined);
          if (requestRun) await requestRun.catch(() => undefined);
          await Promise.allSettled([holder.end(), requester.end()]);
          await resetSync();
        }
      },
    );

    await check('a lease that waited past its expiry is rejected', async () => {
      await resetSync();
      const sync = await requestAs(reader);
      const attempt = randomUUID();
      await claimSync(sync.id, attempt);
      await migrator.query(
        "UPDATE cc.device_sync_state SET sync_expires_at=clock_timestamp()+interval '2 seconds' WHERE customer_id=$1",
        [customer],
      );
      const holder = await connect('cc-migrator', 'cc-app');
      const renewer = await connect('cc-migrator', 'cc-app');
      let renewal = null;
      try {
        const holderPid = (await holder.query('SELECT pg_backend_pid() AS pid'))
          .rows[0].pid;
        const renewerPid = (
          await renewer.query('SELECT pg_backend_pid() AS pid')
        ).rows[0].pid;
        await holder.query('BEGIN');
        await holder.query(
          'SELECT 1 FROM cc.device_sync_state WHERE customer_id=$1 FOR UPDATE',
          [customer],
        );
        renewal = renewer
          .query('SELECT cc.device_sync_lease($1,$2,$3)', [
            customer,
            sync.id,
            attempt,
          ])
          .then(
            () => 'renewed',
            (error) => error.detail ?? error.message,
          );
        assert.equal(
          await waitsFor(renewerPid, holderPid),
          true,
          'The renewal waits for the state lock.',
        );
        await sleep(2200);
        await holder.query('COMMIT');
        const answer = await renewal;
        assert.equal(answer, 'device-sync-changed');
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        if (renewal) await renewal.catch(() => undefined);
        await Promise.allSettled([holder.end(), renewer.end()]);
        await resetSync();
      }
    });

    await check(
      'a finish that waited past its expiry is rejected',
      async () => {
        await resetSync();
        const sync = await requestAs(reader);
        const attempt = randomUUID();
        await claimSync(sync.id, attempt);
        await migrator.query(
          "UPDATE cc.device_sync_state SET sync_expires_at=clock_timestamp()+interval '2 seconds' WHERE customer_id=$1",
          [customer],
        );
        const holder = await connect('cc-migrator', 'cc-app');
        const finisher = await connect('cc-migrator', 'cc-app');
        let finishRun = null;
        try {
          const holderPid = (
            await holder.query('SELECT pg_backend_pid() AS pid')
          ).rows[0].pid;
          const finisherPid = (
            await finisher.query('SELECT pg_backend_pid() AS pid')
          ).rows[0].pid;
          await holder.query('BEGIN');
          await holder.query(
            'SELECT 1 FROM cc.device_sync_state WHERE customer_id=$1 FOR UPDATE',
            [customer],
          );
          finishRun = finisher
            .query('SELECT cc.finish_device_sync($1,$2,$3,$4,$5) AS result', [
              customer,
              sync.id,
              attempt,
              null,
              null,
            ])
            .then(
              (answer) => ({ status: answer.rows[0].result.status }),
              (error) => ({ error: error.detail ?? error.message }),
            );
          assert.equal(
            await waitsFor(finisherPid, holderPid),
            true,
            'The finish waits for the state lock.',
          );
          await sleep(2200);
          await holder.query('COMMIT');
          const answer = await finishRun;
          assert.equal(
            answer.error ?? answer.status ?? 'no answer',
            'device-sync-changed',
          );
        } finally {
          await holder.query('ROLLBACK').catch(() => undefined);
          if (finishRun) await finishRun.catch(() => undefined);
          await Promise.allSettled([holder.end(), finisher.end()]);
          await resetSync();
        }
      },
    );

    // The publication outbox of section 3.6.
    await check(
      'each job change commits one publication row and a rollback leaves none',
      async () => {
        const job = await makeJob({ devices: ['p1'] });
        const count = () =>
          result(
            'SELECT count(*)::int AS result FROM cc.job_publications WHERE job_id=$1',
            [job.jobId],
          );
        const before = await count();
        const admitted = await admit(false);
        assert.equal(admitted.jobId, job.jobId);
        assert.equal(await count(), before + 1);
        const session = await connect('cc-app', 'cc-app');
        try {
          await session.query('BEGIN');
          await session.query(
            'SELECT cc.record_job_change($1,false) AS result',
            [job.jobId],
          );
          await session.query('ROLLBACK');
        } finally {
          await session.end();
        }
        assert.equal(await count(), before + 1);
        await finalize(job.jobId);
      },
    );

    await check(
      'the relay reads progress-only and refresh rows at once and other rows after five seconds',
      async () => {
        const job = await makeJob({ devices: ['p1'] });
        await upsert([device('p1')], new Date(Date.now() - 60 * 60 * 1000));
        const admitted = await admit(false);
        const token = admitted.dispatchToken;
        const attempt = randomUUID();
        const claimed = await claim(job.jobId, token, 0, attempt);
        assert.equal(claimed.outcome, 'claimed');
        const progress = await settle(
          job.jobId,
          token,
          attempt,
          'write',
          [
            {
              operationNumber: 1,
              outcome: 'succeeded',
              values: { annotatedLocation: 'Room 12' },
              verifiedBy: 'write-response',
            },
          ],
          new Date(),
        );
        const publication = progress.publication;
        assert.deepEqual(publication.deviceIds, ['p1']);
        assert.equal(publication.batchCount, 1);
        assert.equal(
          publication.displayId,
          (await jobRow(job.jobId)).display_id,
        );
        assert.equal(publication.requestedBy, confirmer);
        const relay = () =>
          result('SELECT cc.read_job_publications($1,$2) AS result', [
            customer,
            500,
          ]);
        const carries = async (id) =>
          (await relay()).some((element) => element.publicationId === id);
        assert.equal(
          await carries(publication.publicationId),
          false,
          'A row that names devices waits five seconds.',
        );
        await migrator.query(
          "UPDATE cc.job_publications SET created_at=created_at-interval '6 seconds' WHERE publication_id=$1",
          [publication.publicationId],
        );
        assert.equal(await carries(publication.publicationId), true);
        // A refresh row and a progress-only row are read at once.
        await resetSync();
        const refresh = await requestAs(reader);
        const refreshElement = (await relay()).find(
          (element) => element.jobId === refresh.id,
        );
        assert.ok(refreshElement, 'A refresh row is read at once.');
        assert.deepEqual(refreshElement.deviceIds, []);
        assert.equal(refreshElement.batchCount, null);
        assert.equal(
          refreshElement.displayId,
          (await jobRow(refresh.id)).display_id,
        );
        assert.equal(refreshElement.statusChanged, true);
        const syncAttempt = randomUUID();
        await claimSync(refresh.id, syncAttempt);
        await stage(refresh.id, syncAttempt, [device('big000000')]);
        const staged = (await relay()).filter(
          (element) => element.jobId === refresh.id,
        );
        assert.ok(
          staged.some(
            (element) =>
              element.statusChanged === false && element.deviceIds.length === 0,
          ),
          'A progress-only row is read at once.',
        );
        const removed = await result(
          'SELECT cc.complete_job_publications($1,$2) AS result',
          [
            customer,
            JSON.stringify([
              refreshElement.publicationId,
              publication.publicationId,
            ]),
          ],
        );
        assert.equal(removed, 2);
        await prepareFinish(job.jobId, token);
        await finishJob(job.jobId);
      },
    );

    await check(
      'a read-back 404 removes the device and names it in removedIds',
      async () => {
        await upsert([device('gone1')], new Date());
        const job = await makeJob({ devices: ['gone1'] });
        const admitted = await admit(false);
        const attempt = randomUUID();
        await claim(job.jobId, admitted.dispatchToken, 0, attempt);
        await stop(job.jobId, admitted.dispatchToken, 0, attempt);
        await prepareFinish(job.jobId, admitted.dispatchToken);
        const readBack = randomUUID();
        await claimVerification(job.jobId, null, readBack);
        const settled = await settle(
          job.jobId,
          null,
          readBack,
          'read-back',
          [
            {
              operationNumber: 1,
              outcome: 'failed',
              googleStatus: 404,
              googleReason: 'notFound',
              verifiedBy: 'read-back',
              outcomeReason: 'not-found',
            },
          ],
          new Date(),
        );
        assert.deepEqual(settled.removed, ['gone1']);
        assert.deepEqual(settled.publication.removedIds, ['gone1']);
        assert.ok((await deviceRow('gone1')).removed_at instanceof Date);
        assert.equal(await overlay('gone1'), undefined);
        await endJob(job.jobId);
      },
    );

    // Section 5.8: a lock-contended observation waits for the settlement and then sees its overlay.
    await check(
      'a list blocked behind a settlement keeps the accepted value and its overlay',
      async () => {
        await upsert(
          [device('n1', { annotatedLocation: 'Old' })],
          new Date(Date.now() - 60 * 60 * 1000),
        );
        const job = await makeJob({ devices: ['n1'] });
        const admitted = await admit(false);
        const attempt = randomUUID();
        await claim(job.jobId, admitted.dispatchToken, 0, attempt);
        const writer = await connect('cc-app', 'cc-app');
        const lister = await connect('cc-app', 'cc-app');
        try {
          await writer.query('BEGIN');
          const settled = await writer.query(
            'SELECT cc.settle_device_update_operations($1,$2,$3,$4,$5,$6,$7) AS result',
            [
              customer,
              job.jobId,
              admitted.dispatchToken,
              attempt,
              'write',
              JSON.stringify([
                {
                  operationNumber: 1,
                  outcome: 'succeeded',
                  values: { annotatedLocation: 'Room 12' },
                  verifiedBy: 'write-response',
                },
              ]),
              new Date(),
            ],
          );
          assert.equal(settled.rows[0].result.settled.length, 1);
          const pid = (await lister.query('SELECT pg_backend_pid() AS pid'))
            .rows[0].pid;
          const pending = lister.query(
            'SELECT cc.upsert_devices($1,$2,$3,$4) AS result',
            [
              customer,
              JSON.stringify([device('n1', { annotatedLocation: 'Old' })]),
              new Date(),
              'list',
            ],
          );
          // A failing poll must not leave a rejected query unhandled.
          pending.catch(() => undefined);
          let waiting = false;
          for (let round = 0; round < 100 && !waiting; round += 1) {
            const state = await adminRow(
              'SELECT cardinality(pg_blocking_pids($1))>0 AS blocked',
              [pid],
            );
            waiting = state?.blocked === true;
            if (!waiting) await sleep(20);
          }
          assert.equal(waiting, true, 'The list waits for the settlement.');
          await writer.query('COMMIT');
          await pending;
          assert.equal((await deviceRow('n1')).annotated_location, 'Room 12');
          assert.equal((await overlay('n1')).value, 'Room 12');
        } finally {
          await Promise.allSettled([writer.end(), lister.end()]);
        }
        await endJob(job.jobId);
      },
    );

    // The read passes rule 2 with its stamp and moves the overlay it waited on.
    await check(
      'a read blocked behind a settlement applies its newer stamp to the row and the overlay',
      async () => {
        await upsert(
          [device('n2', { annotatedLocation: 'Old' })],
          new Date(Date.now() - 60 * 60 * 1000),
        );
        const job = await makeJob({ devices: ['n2'] });
        const admitted = await admit(false);
        const attempt = randomUUID();
        await claim(job.jobId, admitted.dispatchToken, 0, attempt);
        const settledAt = new Date();
        const readAt = new Date(settledAt.getTime() + 5000);
        const writer = await connect('cc-app', 'cc-app');
        const readerSession = await connect('cc-app', 'cc-app');
        try {
          await writer.query('BEGIN');
          const settled = await writer.query(
            'SELECT cc.settle_device_update_operations($1,$2,$3,$4,$5,$6,$7) AS result',
            [
              customer,
              job.jobId,
              admitted.dispatchToken,
              attempt,
              'write',
              JSON.stringify([
                {
                  operationNumber: 1,
                  outcome: 'succeeded',
                  values: { annotatedLocation: 'Room 12' },
                  verifiedBy: 'write-response',
                },
              ]),
              settledAt,
            ],
          );
          assert.equal(settled.rows[0].result.settled.length, 1);
          const pid = (
            await readerSession.query('SELECT pg_backend_pid() AS pid')
          ).rows[0].pid;
          const pending = readerSession.query(
            'SELECT cc.upsert_devices($1,$2,$3,$4) AS result',
            [
              customer,
              JSON.stringify([device('n2', { annotatedLocation: 'Room 9' })]),
              readAt,
              'read',
            ],
          );
          // A failing poll must not leave a rejected query unhandled.
          pending.catch(() => undefined);
          let waiting = false;
          for (let round = 0; round < 100 && !waiting; round += 1) {
            const state = await adminRow(
              'SELECT cardinality(pg_blocking_pids($1))>0 AS blocked',
              [pid],
            );
            waiting = state?.blocked === true;
            if (!waiting) await sleep(20);
          }
          assert.equal(waiting, true, 'The read waits for the settlement.');
          await writer.query('COMMIT');
          await pending;
          const row = await deviceRow('n2');
          assert.equal(row.annotated_location, 'Room 9');
          assert.equal(
            row.annotated_location_observed_at.getTime(),
            readAt.getTime(),
          );
          const written = await overlay('n2');
          assert.equal(written.value, 'Room 9');
          assert.equal(written.source, 'refresh-read');
          assert.equal(written.observed_at.getTime(), readAt.getTime());
        } finally {
          await Promise.allSettled([writer.end(), readerSession.end()]);
        }
        await endJob(job.jobId);
      },
    );

    // Section 5.4: the write recording needs the batch row of the attempt with a live lease.
    await check(
      'a settlement after the batch lease expires changes no outcome, counter, or publication',
      async () => {
        await upsert(
          [device('f1'), device('f2')],
          new Date(Date.now() - 60 * 60 * 1000),
        );
        const job = await makeJob({ devices: ['f1', 'f2'], batchSize: 1 });
        const admitted = await admit(false);
        const attempt = randomUUID();
        await claim(job.jobId, admitted.dispatchToken, 0, attempt);
        await expireBatches(job.jobId);
        const before = await jobRow(job.jobId);
        const late = await settle(
          job.jobId,
          admitted.dispatchToken,
          attempt,
          'write',
          [
            {
              operationNumber: 1,
              outcome: 'succeeded',
              values: { annotatedLocation: 'Room 12' },
              verifiedBy: 'write-response',
            },
          ],
          new Date(),
        );
        assert.deepEqual(late.settled, []);
        assert.equal(late.publication, null);
        const after = await jobRow(job.jobId);
        assert.deepEqual(
          [
            after.succeeded,
            after.failed,
            after.unknown,
            after.skipped,
            after.revision,
          ],
          [
            before.succeeded,
            before.failed,
            before.unknown,
            before.skipped,
            before.revision,
          ],
        );
        assert.deepEqual(
          (await operations(job.jobId)).map((row) => row.status),
          ['dispatched', 'pending'],
        );
        assert.equal((await deviceRow('f1')).annotated_location, null);
        assert.equal(await overlay('f1'), undefined);
        await endJob(job.jobId);
      },
    );

    await check(
      'a settlement from an attempt that lost its batch changes nothing',
      async () => {
        await upsert([device('f3')], new Date(Date.now() - 60 * 60 * 1000));
        const job = await makeJob({ devices: ['f3'] });
        const admitted = await admit(false);
        const attempt = randomUUID();
        await claim(job.jobId, admitted.dispatchToken, 0, attempt);
        await stop(job.jobId, admitted.dispatchToken, 0, attempt);
        const before = await jobRow(job.jobId);
        const late = await settle(
          job.jobId,
          admitted.dispatchToken,
          attempt,
          'write',
          [
            {
              operationNumber: 1,
              outcome: 'succeeded',
              values: { annotatedLocation: 'Room 12' },
              verifiedBy: 'write-response',
            },
          ],
          new Date(),
        );
        assert.deepEqual(late.settled, []);
        assert.equal(late.publication, null);
        const after = await jobRow(job.jobId);
        assert.deepEqual(
          [after.succeeded, after.unknown, after.revision],
          [before.succeeded, before.unknown, before.revision],
        );
        assert.deepEqual(
          (await operations(job.jobId)).map((row) => row.status),
          ['dispatched'],
        );
        assert.equal((await deviceRow('f3')).annotated_location, null);
        assert.equal(await overlay('f3'), undefined);
        await endJob(job.jobId);
      },
    );

    // Sections 5.4, 5.7, and 5.10: a lease fence reads its clock after the lock waits (review F3).
    await check(
      'a settlement that waits on the job row fences on the lease that lapsed in the wait',
      async () => {
        await upsert([device('w1')], new Date(Date.now() - 60 * 60 * 1000));
        const job = await makeJob({ devices: ['w1'] });
        const admitted = await admit(false);
        const attempt = randomUUID();
        await claim(job.jobId, admitted.dispatchToken, 0, attempt);
        const holder = await connect('cc-migrator', 'cc-app');
        const writer = await connect('cc-app', 'cc-app');
        try {
          const holderPid = (
            await holder.query('SELECT pg_backend_pid() AS pid')
          ).rows[0].pid;
          const writerPid = (
            await writer.query('SELECT pg_backend_pid() AS pid')
          ).rows[0].pid;
          const before = await jobRow(job.jobId);
          const recorded = await publications(job.jobId);
          // The lease lives when the settlement starts, and lapses while it waits.
          await migrator.query(
            `UPDATE cc.device_update_batches SET lease_expires_at=clock_timestamp()+interval '1500 milliseconds'
              WHERE job_id=$1`,
            [job.jobId],
          );
          await holder.query('BEGIN');
          await holder.query(
            'SELECT 1 FROM cc.jobs WHERE job_id=$1 FOR UPDATE',
            [job.jobId],
          );
          const pending = writer.query(
            'SELECT cc.settle_device_update_operations($1,$2,$3,$4,$5,$6,$7) AS result',
            [
              customer,
              job.jobId,
              admitted.dispatchToken,
              attempt,
              'write',
              JSON.stringify([
                {
                  operationNumber: 1,
                  outcome: 'succeeded',
                  values: { annotatedLocation: 'Room 12' },
                  verifiedBy: 'write-response',
                },
              ]),
              new Date(),
            ],
          );
          pending.catch(() => undefined);
          assert.equal(
            await waitsFor(writerPid, holderPid),
            true,
            'The settlement waits for the job row.',
          );
          assert.equal(
            await until(
              `SELECT clock_timestamp()>lease_expires_at AS lapsed FROM cc.device_update_batches
                WHERE job_id=$1 AND batch=0`,
              [job.jobId],
            ),
            true,
            'The batch lease lapses in the wait.',
          );
          await holder.query('COMMIT');
          const late = (await pending).rows[0].result;
          assert.deepEqual(late.settled, []);
          assert.equal(late.publication, null);
          const after = await jobRow(job.jobId);
          assert.deepEqual(
            [
              after.succeeded,
              after.unknown,
              Number(after.revision),
              after.changed_at.getTime(),
            ],
            [
              before.succeeded,
              before.unknown,
              Number(before.revision),
              before.changed_at.getTime(),
            ],
          );
          assert.equal(await publications(job.jobId), recorded);
          assert.deepEqual(
            (await operations(job.jobId)).map((row) => row.status),
            ['dispatched'],
          );
          assert.equal((await deviceRow('w1')).annotated_location, null);
          assert.equal(await overlay('w1'), undefined);
          await stop(job.jobId, admitted.dispatchToken, 0, attempt);
          await endJob(job.jobId);
        } finally {
          await Promise.allSettled([holder.end(), writer.end()]);
          await migrator
            .query(
              'UPDATE cc.device_update_batches SET lease_expires_at=NULL WHERE job_id=$1',
              [job.jobId],
            )
            .catch(() => undefined);
        }
      },
    );

    await check(
      'a settlement that waits on the device row fences on the lease that lapsed in the wait',
      async () => {
        await upsert([device('w2')], new Date(Date.now() - 60 * 60 * 1000));
        const job = await makeJob({ devices: ['w2'] });
        const admitted = await admit(false);
        const attempt = randomUUID();
        await claim(job.jobId, admitted.dispatchToken, 0, attempt);
        const holder = await connect('cc-migrator', 'cc-app');
        const writer = await connect('cc-app', 'cc-app');
        try {
          const holderPid = (
            await holder.query('SELECT pg_backend_pid() AS pid')
          ).rows[0].pid;
          const writerPid = (
            await writer.query('SELECT pg_backend_pid() AS pid')
          ).rows[0].pid;
          const before = await jobRow(job.jobId);
          const recorded = await publications(job.jobId);
          // The lease lives when the settlement starts, and lapses while it waits.
          await migrator.query(
            `UPDATE cc.device_update_batches SET lease_expires_at=clock_timestamp()+interval '1500 milliseconds'
              WHERE job_id=$1`,
            [job.jobId],
          );
          await holder.query('BEGIN');
          await holder.query(
            'SELECT 1 FROM cc.devices WHERE customer_id=$1 AND device_id=$2 FOR UPDATE',
            [customer, 'w2'],
          );
          const pending = writer.query(
            'SELECT cc.settle_device_update_operations($1,$2,$3,$4,$5,$6,$7) AS result',
            [
              customer,
              job.jobId,
              admitted.dispatchToken,
              attempt,
              'write',
              JSON.stringify([
                {
                  operationNumber: 1,
                  outcome: 'succeeded',
                  values: { annotatedLocation: 'Room 12' },
                  verifiedBy: 'write-response',
                },
              ]),
              new Date(),
            ],
          );
          pending.catch(() => undefined);
          assert.equal(
            await waitsFor(writerPid, holderPid),
            true,
            'The settlement waits for the device row.',
          );
          assert.equal(
            await until(
              `SELECT clock_timestamp()>lease_expires_at AS lapsed FROM cc.device_update_batches
                WHERE job_id=$1 AND batch=0`,
              [job.jobId],
            ),
            true,
            'The batch lease lapses in the wait.',
          );
          await holder.query('COMMIT');
          const late = (await pending).rows[0].result;
          assert.deepEqual(late.settled, []);
          assert.equal(late.publication, null);
          const after = await jobRow(job.jobId);
          assert.deepEqual(
            [
              after.succeeded,
              after.unknown,
              Number(after.revision),
              after.changed_at.getTime(),
            ],
            [
              before.succeeded,
              before.unknown,
              Number(before.revision),
              before.changed_at.getTime(),
            ],
          );
          assert.equal(await publications(job.jobId), recorded);
          assert.deepEqual(
            (await operations(job.jobId)).map((row) => row.status),
            ['dispatched'],
          );
          assert.equal((await deviceRow('w2')).annotated_location, null);
          assert.equal(await overlay('w2'), undefined);
          await stop(job.jobId, admitted.dispatchToken, 0, attempt);
          await endJob(job.jobId);
        } finally {
          await Promise.allSettled([holder.end(), writer.end()]);
          await migrator
            .query(
              'UPDATE cc.device_update_batches SET lease_expires_at=NULL WHERE job_id=$1',
              [job.jobId],
            )
            .catch(() => undefined);
        }
      },
    );

    await check(
      'a settlement that waits on an operation field row fences on the lease that lapsed in the wait',
      async () => {
        await upsert([device('w4')], new Date(Date.now() - 60 * 60 * 1000));
        const job = await makeJob({
          devices: ['w4'],
          fields: [
            { field: 'annotatedUser', requestedValue: 'Ada Lovelace' },
            { field: 'notes', requestedValue: 'Front desk' },
          ],
        });
        const admitted = await admit(false);
        const attempt = randomUUID();
        await claim(job.jobId, admitted.dispatchToken, 0, attempt);
        const holder = await connect('cc-migrator', 'cc-app');
        const writer = await connect('cc-app', 'cc-app');
        try {
          const holderPid = (
            await holder.query('SELECT pg_backend_pid() AS pid')
          ).rows[0].pid;
          const writerPid = (
            await writer.query('SELECT pg_backend_pid() AS pid')
          ).rows[0].pid;
          const before = await jobRow(job.jobId);
          const recorded = await publications(job.jobId);
          // The lease lives when the settlement starts, and lapses while it waits.
          await migrator.query(
            `UPDATE cc.device_update_batches SET lease_expires_at=clock_timestamp()+interval '1500 milliseconds'
              WHERE job_id=$1`,
            [job.jobId],
          );
          await holder.query('BEGIN');
          await holder.query(
            `SELECT 1 FROM cc.device_update_operation_fields
              WHERE job_id=$1 AND operation_number=1 AND field='notes' FOR UPDATE`,
            [job.jobId],
          );
          const pending = writer.query(
            'SELECT cc.settle_device_update_operations($1,$2,$3,$4,$5,$6,$7) AS result',
            [
              customer,
              job.jobId,
              admitted.dispatchToken,
              attempt,
              'write',
              JSON.stringify([
                {
                  operationNumber: 1,
                  outcome: 'succeeded',
                  values: {
                    annotatedUser: 'Ada Lovelace',
                    notes: 'Front desk',
                  },
                  verifiedBy: 'write-response',
                },
              ]),
              new Date(),
            ],
          );
          pending.catch(() => undefined);
          assert.equal(
            await waitsFor(writerPid, holderPid),
            true,
            'The settlement waits for the field row.',
          );
          assert.equal(
            await until(
              `SELECT clock_timestamp()>lease_expires_at AS lapsed FROM cc.device_update_batches
                WHERE job_id=$1 AND batch=0`,
              [job.jobId],
            ),
            true,
            'The batch lease lapses in the wait.',
          );
          await holder.query('COMMIT');
          const late = (await pending).rows[0].result;
          assert.deepEqual(late.settled, []);
          assert.equal(late.publication, null);
          const after = await jobRow(job.jobId);
          assert.deepEqual(
            [
              after.succeeded,
              after.unknown,
              Number(after.revision),
              after.changed_at.getTime(),
            ],
            [
              before.succeeded,
              before.unknown,
              Number(before.revision),
              before.changed_at.getTime(),
            ],
          );
          assert.equal(await publications(job.jobId), recorded);
          assert.equal((await operations(job.jobId))[0].status, 'dispatched');
          assert.equal(
            (await fieldRow(job.jobId, 1, 'annotatedUser')).observed_value,
            null,
          );
          assert.equal(
            (await fieldRow(job.jobId, 1, 'notes')).observed_value,
            null,
          );
          const device = await lagRow('w4');
          assert.equal(device.annotated_user, null);
          assert.equal(device.notes, null);
          assert.equal(await overlayOf('w4', 'annotatedUser'), undefined);
          assert.equal(await overlayOf('w4', 'notes'), undefined);
          await stop(job.jobId, admitted.dispatchToken, 0, attempt);
          await endJob(job.jobId);
        } finally {
          await Promise.allSettled([holder.end(), writer.end()]);
          await migrator
            .query(
              'UPDATE cc.device_update_batches SET lease_expires_at=NULL WHERE job_id=$1',
              [job.jobId],
            )
            .catch(() => undefined);
        }
      },
    );

    await check(
      'a settlement that waits on an operation field row settles when its lease still lives',
      async () => {
        await upsert([device('w5')], new Date(Date.now() - 60 * 60 * 1000));
        const job = await makeJob({
          devices: ['w5'],
          fields: [
            { field: 'annotatedUser', requestedValue: 'Ada Lovelace' },
            { field: 'notes', requestedValue: 'Front desk' },
          ],
        });
        const admitted = await admit(false);
        const attempt = randomUUID();
        await claim(job.jobId, admitted.dispatchToken, 0, attempt);
        const holder = await connect('cc-migrator', 'cc-app');
        const writer = await connect('cc-app', 'cc-app');
        try {
          const holderPid = (
            await holder.query('SELECT pg_backend_pid() AS pid')
          ).rows[0].pid;
          const writerPid = (
            await writer.query('SELECT pg_backend_pid() AS pid')
          ).rows[0].pid;
          await holder.query('BEGIN');
          await holder.query(
            `SELECT 1 FROM cc.device_update_operation_fields
              WHERE job_id=$1 AND operation_number=1 AND field='notes' FOR UPDATE`,
            [job.jobId],
          );
          const pending = writer.query(
            'SELECT cc.settle_device_update_operations($1,$2,$3,$4,$5,$6,$7) AS result',
            [
              customer,
              job.jobId,
              admitted.dispatchToken,
              attempt,
              'write',
              JSON.stringify([
                {
                  operationNumber: 1,
                  outcome: 'succeeded',
                  values: {
                    annotatedUser: 'Ada Lovelace',
                    notes: 'Front desk',
                  },
                  verifiedBy: 'write-response',
                },
              ]),
              new Date(),
            ],
          );
          pending.catch(() => undefined);
          assert.equal(
            await waitsFor(writerPid, holderPid),
            true,
            'The settlement waits for the field row.',
          );
          await holder.query('COMMIT');
          const answer = (await pending).rows[0].result;
          assert.deepEqual(
            answer.settled.map((one) => one.status),
            ['succeeded'],
          );
          assert.equal(
            (await fieldRow(job.jobId, 1, 'annotatedUser')).observed_value,
            'Ada Lovelace',
          );
          assert.equal(
            (await fieldRow(job.jobId, 1, 'notes')).observed_value,
            'Front desk',
          );
          const device = await lagRow('w5');
          assert.equal(device.annotated_user, 'Ada Lovelace');
          assert.equal(device.notes, 'Front desk');
          assert.equal(
            (await overlayOf('w5', 'annotatedUser')).value,
            'Ada Lovelace',
          );
          assert.equal((await overlayOf('w5', 'notes')).value, 'Front desk');
          await stop(job.jobId, admitted.dispatchToken, 0, attempt);
          await endJob(job.jobId);
        } finally {
          await Promise.allSettled([holder.end(), writer.end()]);
          await migrator
            .query(
              'UPDATE cc.device_update_batches SET lease_expires_at=NULL WHERE job_id=$1',
              [job.jobId],
            )
            .catch(() => undefined);
        }
      },
    );

    await check(
      'a read-back that waits on the device row fences on the read-back lease that lapsed in the wait',
      async () => {
        await upsert([device('w3')], new Date(Date.now() - 60 * 60 * 1000));
        const job = await makeJob({ devices: ['w3'] });
        const admitted = await admit(false);
        const attempt = randomUUID();
        await claim(job.jobId, admitted.dispatchToken, 0, attempt);
        await settle(
          job.jobId,
          admitted.dispatchToken,
          attempt,
          'write',
          [
            {
              operationNumber: 1,
              outcome: 'unknown',
              outcomeReason: 'interrupted',
            },
          ],
          new Date(),
        );
        const holder = await connect('cc-migrator', 'cc-app');
        const writer = await connect('cc-app', 'cc-app');
        try {
          const holderPid = (
            await holder.query('SELECT pg_backend_pid() AS pid')
          ).rows[0].pid;
          const writerPid = (
            await writer.query('SELECT pg_backend_pid() AS pid')
          ).rows[0].pid;
          const recorded = await publications(job.jobId);
          // The read-back lease lives when the settlement starts, and lapses while it waits.
          await migrator.query(
            `UPDATE cc.device_update_operations
              SET verify_lease_expires_at=clock_timestamp()+interval '1500 milliseconds' WHERE job_id=$1`,
            [job.jobId],
          );
          await holder.query('BEGIN');
          await holder.query(
            'SELECT 1 FROM cc.devices WHERE customer_id=$1 AND device_id=$2 FOR UPDATE',
            [customer, 'w3'],
          );
          const pending = writer.query(
            'SELECT cc.settle_device_update_operations($1,$2,$3,$4,$5,$6,$7) AS result',
            [
              customer,
              job.jobId,
              null,
              attempt,
              'read-back',
              JSON.stringify([
                {
                  operationNumber: 1,
                  outcome: 'succeeded',
                  values: { annotatedLocation: 'Room 12' },
                  verifiedBy: 'read-back',
                },
              ]),
              new Date(),
            ],
          );
          pending.catch(() => undefined);
          assert.equal(
            await waitsFor(writerPid, holderPid),
            true,
            'The read-back waits for the device row.',
          );
          assert.equal(
            await until(
              `SELECT clock_timestamp()>verify_lease_expires_at AS lapsed FROM cc.device_update_operations
                WHERE job_id=$1`,
              [job.jobId],
            ),
            true,
            'The read-back lease lapses in the wait.',
          );
          await holder.query('COMMIT');
          const late = (await pending).rows[0].result;
          assert.deepEqual(late.settled, []);
          assert.equal(late.publication, null);
          const operation = (await operations(job.jobId))[0];
          assert.equal(operation.status, 'unknown');
          assert.equal(operation.verified_by, null);
          assert.equal(await publications(job.jobId), recorded);
          assert.equal((await deviceRow('w3')).annotated_location, null);
          assert.equal(await overlay('w3'), undefined);
          await stop(job.jobId, admitted.dispatchToken, 0, attempt);
          await endJob(job.jobId);
        } finally {
          await Promise.allSettled([holder.end(), writer.end()]);
          await migrator
            .query(
              'UPDATE cc.device_update_batches SET lease_expires_at=NULL WHERE job_id=$1',
              [job.jobId],
            )
            .catch(() => undefined);
        }
      },
    );

    await check(
      'a renewal that waits on the job row does not revive the lease that lapsed in the wait',
      async () => {
        await upsert([device('w4')], new Date(Date.now() - 60 * 60 * 1000));
        const job = await makeJob({ devices: ['w4'] });
        const admitted = await admit(false);
        const attempt = randomUUID();
        await claim(job.jobId, admitted.dispatchToken, 0, attempt);
        const holder = await connect('cc-migrator', 'cc-app');
        const writer = await connect('cc-app', 'cc-app');
        try {
          const holderPid = (
            await holder.query('SELECT pg_backend_pid() AS pid')
          ).rows[0].pid;
          const writerPid = (
            await writer.query('SELECT pg_backend_pid() AS pid')
          ).rows[0].pid;
          // The lease lives when the renewal starts, and lapses while it waits.
          await migrator.query(
            `UPDATE cc.device_update_batches SET lease_expires_at=clock_timestamp()+interval '1500 milliseconds'
              WHERE job_id=$1`,
            [job.jobId],
          );
          await holder.query('BEGIN');
          await holder.query(
            'SELECT 1 FROM cc.jobs WHERE job_id=$1 FOR UPDATE',
            [job.jobId],
          );
          const pending = writer.query(
            'SELECT cc.renew_device_update_batch($1,$2,$3,$4,$5) AS result',
            [customer, job.jobId, admitted.dispatchToken, 0, attempt],
          );
          pending.catch(() => undefined);
          assert.equal(
            await waitsFor(writerPid, holderPid),
            true,
            'The renewal waits for the job row.',
          );
          assert.equal(
            await until(
              `SELECT clock_timestamp()>lease_expires_at AS lapsed FROM cc.device_update_batches
                WHERE job_id=$1 AND batch=0`,
              [job.jobId],
            ),
            true,
            'The batch lease lapses in the wait.',
          );
          await holder.query('COMMIT');
          const answer = await pending.then(
            (result) => result.rows[0].result,
            (error) => error,
          );
          assert.equal(answer.detail, 'attempt-fenced');
          const held = await adminRow(
            `SELECT clock_timestamp()>lease_expires_at AS lapsed FROM cc.device_update_batches
              WHERE job_id=$1 AND batch=0`,
            [job.jobId],
          );
          assert.equal(
            held.lapsed,
            true,
            'The renewal leaves the lapsed lease alone.',
          );
          await stop(job.jobId, admitted.dispatchToken, 0, attempt);
          await endJob(job.jobId);
        } finally {
          await Promise.allSettled([holder.end(), writer.end()]);
          await migrator
            .query(
              'UPDATE cc.device_update_batches SET lease_expires_at=NULL WHERE job_id=$1',
              [job.jobId],
            )
            .catch(() => undefined);
        }
      },
    );

    // Section 5.10: the reaper never acts while a lease lives, and it waits out the grace.
    await check(
      'the reaper leaves a live attempt, honors the grace, and then finalizes',
      async () => {
        await upsert(
          [device('g1'), device('g2')],
          new Date(Date.now() - 60 * 60 * 1000),
        );
        const job = await makeJob({ devices: ['g1', 'g2'], batchSize: 1 });
        const admitted = await admit(false);
        const attempt = randomUUID();
        await claim(job.jobId, admitted.dispatchToken, 0, attempt);
        assert.equal((await finalize(job.jobId)).outcome, 'busy');
        assert.equal((await jobRow(job.jobId)).status, 'running');
        assert.deepEqual(
          (await operations(job.jobId)).map((row) => row.status),
          ['dispatched', 'pending'],
        );
        await migrator.query(
          `UPDATE cc.device_update_batches SET lease_expires_at=clock_timestamp()-interval '10 seconds'
            WHERE job_id=$1`,
          [job.jobId],
        );
        assert.equal((await finalize(job.jobId)).outcome, 'busy');
        assert.equal((await jobRow(job.jobId)).status, 'running');
        await migrator.query(
          `UPDATE cc.device_update_batches SET lease_expires_at=clock_timestamp()-interval '31 seconds'
            WHERE job_id=$1`,
          [job.jobId],
        );
        const done = await finalize(job.jobId);
        assert.equal(done.status, 'needs-review');
        assert.deepEqual(
          (await operations(job.jobId)).map((row) => row.status),
          ['unknown', 'skipped'],
        );
      },
    );

    // Section 5.7: the write recording claims the read-back and keeps the open-request delay.
    await check(
      'an unknown write result reserves its read-back for the same attempt and keeps the delay',
      async () => {
        await upsert([device('h1')], new Date(Date.now() - 60 * 60 * 1000));
        const job = await makeJob({ devices: ['h1'] });
        const admitted = await admit(false);
        const attempt = randomUUID();
        await claim(job.jobId, admitted.dispatchToken, 0, attempt);
        const settledAt = new Date();
        const verifyAfter = new Date(settledAt.getTime() + 30 * 1000);
        const settled = await settle(
          job.jobId,
          admitted.dispatchToken,
          attempt,
          'write',
          [
            {
              operationNumber: 1,
              outcome: 'unknown',
              outcomeReason: 'interrupted',
              verifyAfter: verifyAfter.toISOString(),
            },
          ],
          settledAt,
        );
        assert.equal(settled.settled[0].status, 'unknown');
        const reserved = await adminRow(
          `SELECT verify_attempt,verify_after,verify_lease_expires_at FROM cc.device_update_operations
            WHERE job_id=$1`,
          [job.jobId],
        );
        assert.equal(reserved.verify_attempt, attempt);
        assert.equal(reserved.verify_after.getTime(), verifyAfter.getTime());
        assert.ok(
          reserved.verify_lease_expires_at.getTime() > settledAt.getTime(),
        );
        assert.deepEqual(
          await claimVerification(job.jobId, null, randomUUID()),
          [],
        );
        await migrator.query(
          `UPDATE cc.device_update_operations SET verify_lease_expires_at=clock_timestamp()-interval '1 second'
            WHERE job_id=$1`,
          [job.jobId],
        );
        const claimed = await claimVerification(job.jobId, null, attempt);
        assert.equal(claimed.length, 1);
        assert.equal(
          new Date(claimed[0].verifyAfter).getTime(),
          verifyAfter.getTime(),
        );
        await endJob(job.jobId);
      },
    );

    // Section 1.3: a full sync records the path it listed, not the cached device path.
    await check(
      'a full sync target records the listed OrgUnit path of a moved device',
      async () => {
        await upsert(
          [device('m1', { orgUnitPath: '/Old' })],
          new Date(Date.now() - 60 * 60 * 1000),
        );
        await resetSync();
        const sync = await requestAs(reader);
        const attempt = randomUUID();
        await claimSync(sync.id, attempt);
        await stage(sync.id, attempt, [device('m1', { orgUnitPath: '/New' })]);
        await finishSync(sync.id, attempt);
        const target = (
          await admin(
            `SELECT t.org_unit_path AS target,d.org_unit_path AS device FROM cc.job_targets t
              JOIN cc.devices d ON d.customer_id=$1 AND d.device_id=t.device_id
              WHERE t.job_id=$2`,
            [customer, sync.id],
          )
        )[0];
        assert.equal(target.target, '/New');
        assert.equal(target.device, '/New');
        assert.deepEqual((await jobRow(sync.id)).target_org_unit_paths, [
          '/New',
        ]);
      },
    );

    // Section 1.3: the header derives its failure from the current batch records.
    await check(
      'a successful replacement of a failed refresh batch clears the failure',
      async () => {
        const refresh = randomUUID();
        await result(
          'SELECT cc.create_entity_sync_job($1,1,$2,$3,$4,$5,$6,$7) AS result',
          [reader, customer, 'device', '["j1","j2"]', 1, refresh, randomUUID()],
        );
        await result(
          'SELECT cc.finish_entity_sync_batch($1,$2,$3,$4) AS result',
          [customer, refresh, 0, 'quota'],
        );
        await result(
          'SELECT cc.finish_entity_sync_batch($1,$2,$3,$4) AS result',
          [customer, refresh, 0, null],
        );
        await result(
          'SELECT cc.finish_entity_sync_batch($1,$2,$3,$4) AS result',
          [customer, refresh, 1, null],
        );
        const header = await jobRow(refresh);
        assert.equal(header.status, 'completed');
        assert.equal(header.failure, null);
        assert.equal(header.failed, 0);
        assert.equal(header.succeeded, 2);
      },
    );

    // Section 3.6: claims record their visible change, and the takeover refreshes its counters.
    await check(
      'a first claim and a takeover record their visible changes',
      async () => {
        await upsert(
          [device('k1'), device('k2')],
          new Date(Date.now() - 60 * 60 * 1000),
        );
        const job = await makeJob({ devices: ['k1', 'k2'], batchSize: 1 });
        const admitted = await admit(false);
        const token = admitted.dispatchToken;
        const attempt = randomUUID();
        const count = () =>
          result(
            'SELECT count(*)::int AS result FROM cc.job_publications WHERE job_id=$1',
            [job.jobId],
          );
        const before = await jobRow(job.jobId);
        const recorded = await count();
        assert.equal(before.started_at, null);
        const claimed = await claim(job.jobId, token, 0, attempt);
        assert.equal(claimed.outcome, 'claimed');
        const afterClaim = await jobRow(job.jobId);
        assert.notEqual(afterClaim.started_at, null);
        assert.equal(Number(afterClaim.revision), Number(before.revision) + 1);
        assert.equal(await count(), recorded + 1);
        const first = await claim(job.jobId, token, 1, attempt);
        assert.equal(first.outcome, 'claimed');
        // The second batch changes the public operation timestamps, so it records a change (review F8).
        const afterSecond = await jobRow(job.jobId);
        assert.ok(Number(afterSecond.revision) > Number(afterClaim.revision));
        assert.equal(await count(), recorded + 2);
        await migrator.query(
          `UPDATE cc.device_update_batches SET lease_expires_at=clock_timestamp()-interval '60 seconds'
            WHERE job_id=$1 AND batch=1`,
          [job.jobId],
        );
        const takeover = await claim(job.jobId, token, 1, randomUUID());
        assert.equal(takeover.outcome, 'claimed');
        assert.equal(takeover.readBack.length, 1);
        const afterTakeover = await jobRow(job.jobId);
        assert.equal(afterTakeover.unknown, 1);
        assert.ok(
          Number(afterTakeover.revision) > Number(afterSecond.revision),
        );
        assert.equal(await count(), recorded + 3);
        await endJob(job.jobId);
        // A rolled-back claim leaves no publication row.
        await upsert([device('k3')], new Date(Date.now() - 60 * 60 * 1000));
        const rolled = await makeJob({ devices: ['k3'] });
        const rolledAdmit = await admit(false);
        const session = await connect('cc-app', 'cc-app');
        try {
          await session.query('BEGIN');
          const inFlight = await session.query(
            'SELECT cc.claim_device_update_batch($1,$2,$3,$4,$5,$6) AS result',
            [
              customer,
              rolled.jobId,
              rolledAdmit.dispatchToken,
              0,
              randomUUID(),
              'rollback',
            ],
          );
          assert.equal(inFlight.rows[0].result.outcome, 'claimed');
          await session.query('ROLLBACK');
        } finally {
          await session.end();
        }
        assert.equal((await jobRow(rolled.jobId)).started_at, null);
        assert.equal(
          await result(
            'SELECT count(*)::int AS result FROM cc.job_publications WHERE job_id=$1',
            [rolled.jobId],
          ),
          1,
        );
        await endJob(rolled.jobId);
      },
    );

    // The failure requester rules of section 2.1.
    await check(
      'a failure names its requester and the projection hides another principal failure',
      async () => {
        await resetSync();
        const requested = await requestAs(other);
        const attempt = randomUUID();
        await claimSync(requested.id, attempt);
        await finishSync(requested.id, attempt, null, 'quota');
        const stored = await syncState();
        assert.equal(stored.telemetry_failure, 'quota');
        assert.equal(stored.telemetry_failure_requested_by, other);
        assert.equal(stored.failure, null);
        assert.equal(stored.failure_requested_by, null);
        assert.equal((await readAs(reader)).telemetryFailure, null);
        assert.equal((await readAs(auditor)).telemetryFailure, 'quota');
        assert.equal((await readAs(other)).telemetryFailure, 'quota');
        const second = await requestAs(reader);
        assert.equal((await syncState()).telemetry_failure, 'quota');
        const secondAttempt = randomUUID();
        await claimSync(second.id, secondAttempt);
        const readByReader = await finishSync(
          second.id,
          secondAttempt,
          'network-failure',
        );
        assert.equal(readByReader.failure, 'network-failure');
        const after = await syncState();
        assert.equal(after.failure, 'network-failure');
        assert.equal(after.failure_requested_by, reader);
        assert.equal(after.telemetry_failure, 'quota');
        assert.equal(after.telemetry_failure_requested_by, other);
        assert.equal((await readAs(reader)).failure, 'network-failure');
        assert.equal((await readAs(other)).failure, null);
        assert.equal((await readAs(auditor)).failure, 'network-failure');
        assert.equal((await readAs(foreign)).failure, null);
        assert.equal((await readAs(platformReader)).failure, 'network-failure');
      },
    );

    await check(
      'abandon and replacement record the sync actor and a clean finish clears both requesters',
      async () => {
        await resetSync();
        const abandoned = await requestAs(reader);
        await result(
          'SELECT cc.abandon_device_sync($1,$2,$3,$4,$5) AS result',
          [reader, 1, customer, abandoned.id, 'orchestration-unavailable'],
        );
        const stored = await syncState();
        assert.equal(stored.failure, 'orchestration-unavailable');
        assert.equal(stored.failure_requested_by, reader);
        const lapsed = await requestAs(reader);
        await migrator.query(
          "UPDATE cc.device_sync_state SET sync_expires_at=clock_timestamp()-interval '1 second' WHERE customer_id=$1",
          [customer],
        );
        assert.equal((await readAs(reader)).failure, 'interrupted');
        assert.equal((await readAs(other)).failure, null);
        const replacement = await requestAs(other);
        const replaced = await syncState();
        assert.equal(replaced.failure, 'interrupted');
        assert.equal(replaced.failure_requested_by, reader);
        assert.equal(replaced.sync_id, replacement.id);
        await migrator.query(
          "UPDATE cc.jobs SET finished_at=clock_timestamp()-interval '1 day' WHERE job_id=$1",
          [lapsed.id],
        );
        const closed = await jobRow(lapsed.id);
        assert.equal(closed.status, 'failed');
        assert.equal(closed.failure, 'interrupted');
        const attempt = randomUUID();
        await claimSync(replacement.id, attempt);
        await finishSync(replacement.id, attempt);
        const clean = await syncState();
        assert.equal(clean.failure, null);
        assert.equal(clean.failure_requested_by, null);
        assert.equal(clean.telemetry_failure, null);
        assert.equal(clean.telemetry_failure_requested_by, null);
        assert.equal((await jobRow(replacement.id)).status, 'completed');
      },
    );

    // Section 2.1: the expired sync names its actor. The retained failure keeps its own requester.
    await check(
      'an expired sync names its actor, not the retained failure requester',
      async () => {
        await resetSync();
        const failed = await requestAs(other);
        const failedAttempt = randomUUID();
        await claimSync(failed.id, failedAttempt);
        await finishSync(failed.id, failedAttempt, 'quota');
        assert.equal((await syncState()).failure, 'quota');
        assert.equal((await syncState()).failure_requested_by, other);
        const lapsed = await requestAs(reader);
        await migrator.query(
          "UPDATE cc.device_sync_state SET sync_expires_at=clock_timestamp()-interval '1 second' WHERE customer_id=$1",
          [customer],
        );
        assert.equal((await readAs(reader)).failure, 'interrupted');
        assert.equal((await readAs(other)).failure, null);
        assert.equal((await readAs(auditor)).failure, 'interrupted');
        const header = await jobRow(lapsed.id);
        assert.equal(header.requested_by, reader);
        assert.equal(header.status, 'running');
        await resetSync();
      },
    );

    await check(
      'the check constraints reject a failure without its requester',
      async () => {
        await rejects(
          migrator.query(
            "UPDATE cc.device_sync_state SET failure='quota' WHERE customer_id=$1",
            [customer],
          ),
          '23514',
        );
        await rejects(
          migrator.query(
            'UPDATE cc.device_sync_state SET failure_requested_by=$2 WHERE customer_id=$1',
            [customer, reader],
          ),
          '23514',
        );
      },
    );

    await check(
      'cc.job_visible passes the requester and the jobs:read holders and fails the others',
      async () => {
        const visible = (actor, version, requestedBy) =>
          result('SELECT cc.job_visible($1,$2,$3,$4) AS result', [
            actor,
            version,
            customer,
            requestedBy,
          ]);
        assert.equal(await visible(reader, 1, reader), true);
        assert.equal(await visible(reader, 1, null), false);
        assert.equal(await visible(other, 1, reader), false);
        assert.equal(await visible(auditor, 1, other), true);
        assert.equal(await visible(platformReader, 1, other), true);
        assert.equal(await visible(foreign, 1, other), false);
        assert.equal(await visible(auditor, 2, other), false);
        await migrator.query(
          'UPDATE cc.application_principals SET enabled=false WHERE id=$1',
          [platformReader],
        );
        assert.equal(await visible(platformReader, 1, other), false);
        await migrator.query(
          'UPDATE cc.application_principals SET enabled=true WHERE id=$1',
          [platformReader],
        );
        assert.equal(await visible(platformReader, 1, other), true);
      },
    );

    await check(
      'a requester reads the columns of section 2.1 and a jobs:read control sees every failure',
      async () => {
        const columns = [
          'customerId',
          'generation',
          'status',
          'observedAt',
          'deviceCount',
          'failure',
          'telemetryFailure',
          'startedAt',
          'checkedAt',
          'stale',
        ];
        await resetSync();
        const requested = await requestAs(reader);
        for (const key of columns) assert.ok(key in requested.state, key);
        const attempt = randomUUID();
        await claimSync(requested.id, attempt);
        await finishSync(requested.id, attempt, 'request-failed');
        for (const [actor, expected] of [
          [reader, 'request-failed'],
          [auditor, 'request-failed'],
          [other, null],
        ]) {
          const state = await readAs(actor);
          for (const key of columns) assert.ok(key in state, key);
          assert.equal(state.failure, expected);
        }
        const clean = await requestAs(other);
        const cleanAttempt = randomUUID();
        await claimSync(clean.id, cleanAttempt);
        await finishSync(clean.id, cleanAttempt, null, 'request-failed');
        for (const [actor, expected] of [
          [other, 'request-failed'],
          [auditor, 'request-failed'],
          [reader, null],
        ]) {
          const state = await readAs(actor);
          assert.equal(state.failure, null);
          assert.equal(state.telemetryFailure, expected);
        }
      },
    );

    // The retry reports of section 5.9.
    await check(
      'a backoff report rejects a null token, a null attempt, an old token, a fenced attempt, an expired lease, and a non-increasing sequence',
      async () => {
        const report = (jobId, token, batch, attempt, sequence) =>
          result(
            'SELECT cc.report_device_update_backoff($1,$2,$3,$4,$5,$6) AS result',
            [customer, jobId, token, batch, attempt, sequence],
          );
        const job = await makeJob({ devices: ['e1', 'e2'] });
        const admitted = await admit(false);
        const token = admitted.dispatchToken;
        const attempt = randomUUID();
        await claim(job.jobId, token, 0, attempt);
        assert.equal(
          await report(job.jobId, randomUUID(), 0, attempt, 1),
          false,
        );
        assert.equal(await report(job.jobId, token, 0, randomUUID(), 1), false);
        assert.equal(await report(job.jobId, token, 0, attempt, 2), true);
        assert.equal(await report(job.jobId, token, 0, attempt, 2), false);
        assert.equal(await report(job.jobId, token, 0, attempt, 1), false);
        assert.equal(await report(job.jobId, token, 0, attempt, 3), true);
        await rejects(
          result(
            'SELECT cc.report_device_update_backoff($1,$2,$3,$4,$5,$6) AS result',
            [customer, job.jobId, null, 0, attempt, 4],
          ),
          '22023',
        );
        await rejects(
          result(
            'SELECT cc.report_device_update_backoff($1,$2,$3,$4,$5,$6) AS result',
            [customer, job.jobId, token, 0, null, 4],
          ),
          '22023',
        );
        assert.equal(await report(job.jobId, token, 0, attempt, 4), true);
        await expireBatches(job.jobId);
        assert.equal(await report(job.jobId, token, 0, attempt, 4), false);
        await rejects(
          result(
            'SELECT cc.report_device_update_backoff($1,$2,$3,$4,$5,$6) AS result',
            [customer, job.jobId, token, 0, attempt, null],
          ),
          '22023',
        );
        await finalize(job.jobId);
      },
    );

    await check(
      'hold acceptance rejects an old report, a lost lease, and an applied report',
      async () => {
        const accept = () =>
          result('SELECT cc.accept_device_update_hold($1) AS result', [
            customer,
          ]);
        assert.equal(await accept(), null);
        const job = await makeJob({ devices: ['e1', 'e2'] });
        const admitted = await admit(false);
        const token = admitted.dispatchToken;
        const attempt = randomUUID();
        await claim(job.jobId, token, 0, attempt);
        await result(
          'SELECT cc.report_device_update_backoff($1,$2,$3,$4,$5,$6) AS result',
          [customer, job.jobId, token, 0, attempt, 1],
        );
        const accepted = await accept();
        assert.equal(accepted.jobId, job.jobId);
        assert.equal(accepted.holdAttempt, attempt);
        assert.equal(accepted.holdSequence, 1);
        assert.equal(await accept(), null);
        await result(
          'SELECT cc.report_device_update_backoff($1,$2,$3,$4,$5,$6) AS result',
          [customer, job.jobId, token, 0, attempt, 2],
        );
        await migrator.query(
          "UPDATE cc.device_update_jobs SET backoff_reported_at=clock_timestamp()-interval '31 seconds' WHERE job_id=$1",
          [job.jobId],
        );
        assert.equal(await accept(), null);
        await migrator.query(
          'UPDATE cc.device_update_jobs SET backoff_reported_at=clock_timestamp() WHERE job_id=$1',
          [job.jobId],
        );
        await expireBatches(job.jobId);
        assert.equal(await accept(), null);
        await finalize(job.jobId);
      },
    );
    // S2 and review F16: the shared sync lease rejects a null attempt at each of its callers.
    await check(
      'a renewal with a null attempt changes no lease and no sync',
      async () => {
        await resetSync();
        const sync = await requestAs(reader);
        const before = await adminRow(
          'SELECT sync_id,sync_attempt,sync_expires_at FROM cc.device_sync_state WHERE customer_id=$1',
          [customer],
        );
        // The runtime role holds no execute grant on the lease helper, so the check runs as the
        // migration role that the renewal tests use.
        const renewer = await connect('cc-migrator', 'cc-app');
        try {
          await rejects(
            renewer.query('SELECT cc.device_sync_lease($1,$2,$3)', [
              customer,
              sync.id,
              null,
            ]),
            null,
            'device-sync-changed',
          );
        } finally {
          await renewer.end();
        }
        const after = await adminRow(
          'SELECT sync_id,sync_attempt,sync_expires_at FROM cc.device_sync_state WHERE customer_id=$1',
          [customer],
        );
        assert.equal(after.sync_id, before.sync_id);
        assert.equal(
          after.sync_expires_at.toISOString(),
          before.sync_expires_at.toISOString(),
        );
        await resetSync();
      },
    );

    await check(
      'a staged device page with a null attempt changes no target, device, or header',
      async () => {
        await resetSync();
        const sync = await requestAs(reader);
        const before = await jobRow(sync.id);
        const published = await publications(sync.id);
        await rejects(
          result('SELECT cc.stage_devices($1,$2,$3,$4) AS result', [
            customer,
            sync.id,
            null,
            JSON.stringify([device('null-a')]),
          ]),
          null,
          'device-sync-changed',
        );
        const after = await jobRow(sync.id);
        assert.equal(after.succeeded, before.succeeded);
        assert.equal(after.revision, before.revision);
        assert.equal(await publications(sync.id), published);
        assert.equal(
          await result(
            'SELECT count(*)::int AS result FROM cc.job_targets WHERE job_id=$1',
            [sync.id],
          ),
          0,
        );
        assert.equal(
          await result(
            'SELECT count(*)::int AS result FROM cc.devices WHERE customer_id=$1 AND device_id=$2',
            [customer, 'null-a'],
          ),
          0,
        );
        await resetSync();
      },
    );

    await check(
      'a staged battery page with a null attempt changes no battery row',
      async () => {
        await resetSync();
        await upsert([device('null-b')], new Date(Date.now() - 60 * 60 * 1000));
        const sync = await requestAs(reader);
        await rejects(
          result('SELECT cc.stage_device_batteries($1,$2,$3,$4) AS result', [
            customer,
            sync.id,
            null,
            JSON.stringify([
              {
                deviceId: 'null-b',
                battery: {
                  status: 'reported',
                  health: 'normal',
                  capacityPercent: 90,
                  reportedAt: '2026-10-17T12:00:00.000Z',
                },
                reports: [],
              },
            ]),
          ]),
          null,
          'device-sync-changed',
        );
        const stored = await adminRow(
          'SELECT battery_status FROM cc.devices WHERE customer_id=$1 AND device_id=$2',
          [customer, 'null-b'],
        );
        assert.equal(stored.battery_status, 'no-report');
        await resetSync();
      },
    );

    // S1 and review F17: the finish reads the clock after its header lock and its device locks.
    await check(
      'a finish that waited for the header row revalidates the lease that lapsed in the wait',
      async () => {
        await resetSync();
        await upsert([device('fh-a')], new Date(Date.now() - 60 * 60 * 1000));
        const sync = await requestAs(reader);
        const attempt = randomUUID();
        await claimSync(sync.id, attempt);
        await migrator.query(
          "UPDATE cc.device_sync_state SET sync_expires_at=clock_timestamp()+interval '1200 milliseconds' WHERE customer_id=$1",
          [customer],
        );
        const holder = await connect('cc-migrator', 'cc-app');
        const finisher = await connect('cc-migrator', 'cc-app');
        let finish = null;
        try {
          const holderPid = (
            await holder.query('SELECT pg_backend_pid() AS pid')
          ).rows[0].pid;
          const finisherPid = (
            await finisher.query('SELECT pg_backend_pid() AS pid')
          ).rows[0].pid;
          await holder.query('BEGIN');
          await holder.query(
            'SELECT 1 FROM cc.jobs WHERE job_id=$1 FOR UPDATE',
            [sync.id],
          );
          finish = finisher.query(
            'SELECT cc.finish_device_sync($1,$2,$3,$4,$5) AS result',
            [customer, sync.id, attempt, null, null],
          );
          finish.catch(() => undefined);
          assert.equal(
            await waitsFor(finisherPid, holderPid),
            true,
            'The finish waits for the header row.',
          );
          assert.equal(
            await until(
              'SELECT clock_timestamp()>sync_expires_at AS lapsed FROM cc.device_sync_state WHERE customer_id=$1',
              [customer],
            ),
            true,
            'The lease lapses in the wait.',
          );
          await holder.query('COMMIT');
          await rejects(finish, null, 'device-sync-changed');
        } finally {
          await holder.query('ROLLBACK').catch(() => undefined);
          if (finish) await finish.catch(() => undefined);
          await Promise.allSettled([holder.end(), finisher.end()]);
          await resetSync();
        }
        const header = await jobRow(sync.id);
        assert.equal(header.status, 'running');
        assert.equal(header.finished_at, null);
        assert.equal((await deviceRow('fh-a')).removed_at, null);
      },
    );

    await check(
      'a finish that waited for a device row revalidates the lease that lapsed in the wait',
      async () => {
        await resetSync();
        await upsert([device('fd-a')], new Date(Date.now() - 60 * 60 * 1000));
        const sync = await requestAs(reader);
        const attempt = randomUUID();
        await claimSync(sync.id, attempt);
        await migrator.query(
          "UPDATE cc.device_sync_state SET sync_expires_at=clock_timestamp()+interval '1200 milliseconds' WHERE customer_id=$1",
          [customer],
        );
        const holder = await connect('cc-migrator', 'cc-app');
        const finisher = await connect('cc-migrator', 'cc-app');
        let finish = null;
        try {
          const holderPid = (
            await holder.query('SELECT pg_backend_pid() AS pid')
          ).rows[0].pid;
          const finisherPid = (
            await finisher.query('SELECT pg_backend_pid() AS pid')
          ).rows[0].pid;
          await holder.query('BEGIN');
          await holder.query(
            'SELECT 1 FROM cc.devices WHERE customer_id=$1 AND device_id=$2 FOR UPDATE',
            [customer, 'fd-a'],
          );
          finish = finisher.query(
            'SELECT cc.finish_device_sync($1,$2,$3,$4,$5) AS result',
            [customer, sync.id, attempt, null, null],
          );
          finish.catch(() => undefined);
          assert.equal(
            await waitsFor(finisherPid, holderPid),
            true,
            'The finish waits for the device row.',
          );
          assert.equal(
            await until(
              'SELECT clock_timestamp()>sync_expires_at AS lapsed FROM cc.device_sync_state WHERE customer_id=$1',
              [customer],
            ),
            true,
            'The lease lapses in the wait.',
          );
          await holder.query('COMMIT');
          await rejects(finish, null, 'device-sync-changed');
        } finally {
          await holder.query('ROLLBACK').catch(() => undefined);
          if (finish) await finish.catch(() => undefined);
          await Promise.allSettled([holder.end(), finisher.end()]);
          await resetSync();
        }
        const header = await jobRow(sync.id);
        assert.equal(header.status, 'running');
        assert.equal((await deviceRow('fd-a')).removed_at, null);
      },
    );

    // S1 to S3 and review F14: the final finish keeps its dispatch-token fence and it is harmless.
    await check(
      'a finish with a rotated token changes no status, revision, or publication',
      async () => {
        const job = await makeJob({ devices: ['fr-a'] });
        const admitted = await admit(false);
        const token = admitted.dispatchToken;
        const attempt = randomUUID();
        await claim(job.jobId, token, 0, attempt);
        // The runner records its page and stops, so the finish sees no live lease.
        await stop(job.jobId, token, 0, attempt);
        assert.equal((await prepareFinish(job.jobId, token)).outcome, 'ready');
        // The runner lapses, so the tick rotates the token before the prepared finish lands.
        await migrator.query(
          "UPDATE cc.device_update_jobs SET heartbeat_at=clock_timestamp()-interval '20 minutes' WHERE job_id=$1",
          [job.jobId],
        );
        const recovered = await recover();
        const start = recovered.starts.find((row) => row.jobId === job.jobId);
        assert.ok(start, 'The tick rotates the token of the lapsed runner.');
        assert.notEqual(start.dispatchToken, token);
        const before = await jobRow(job.jobId);
        const published = await publications(job.jobId);
        const stale = await finishWithToken(job.jobId, token);
        if (finishFence > 0) assert.equal(stale.outcome, 'superseded');
        const after = await jobRow(job.jobId);
        assert.equal(after.status, before.status);
        assert.equal(after.finished_at, null);
        assert.equal(after.revision, before.revision);
        assert.equal(await publications(job.jobId), published);
        assert.equal(after.unknown, before.unknown);
        await finalize(job.jobId);
      },
    );

    await check(
      'a finish after the reaper closed the job changes no revision or publication',
      async () => {
        const job = await makeJob({ devices: ['fr-b'] });
        const admitted = await admit(false);
        const token = admitted.dispatchToken;
        const attempt = randomUUID();
        await claim(job.jobId, token, 0, attempt);
        // The runner records its page and stops, so the finish sees no live lease.
        await stop(job.jobId, token, 0, attempt);
        assert.equal((await prepareFinish(job.jobId, token)).outcome, 'ready');
        await expireBatches(job.jobId);
        assert.equal((await finalize(job.jobId)).outcome, 'finalized');
        const before = await jobRow(job.jobId);
        const published = await publications(job.jobId);
        const repeat = await finishWithToken(job.jobId, token, 'quota');
        if (finishFence > 0) assert.equal(repeat.outcome, 'finished');
        const after = await jobRow(job.jobId);
        assert.equal(after.status, before.status);
        assert.equal(after.failure, before.failure);
        assert.equal(
          after.finished_at.toISOString(),
          before.finished_at.toISOString(),
        );
        assert.equal(after.revision, before.revision);
        assert.equal(await publications(job.jobId), published);
      },
    );

    // S1 and review F15: the settlement locks its operation rows before it reads the clock.
    await check(
      'a settlement that waited for its operation row fences on the read-back lease that lapsed in the wait',
      async () => {
        await upsert([device('fe-a')], new Date(Date.now() - 60 * 60 * 1000));
        const job = await makeJob({ devices: ['fe-a'] });
        const admitted = await admit(false);
        const token = admitted.dispatchToken;
        const writer = randomUUID();
        await claim(job.jobId, token, 0, writer);
        await settle(
          job.jobId,
          token,
          writer,
          'write',
          [
            {
              operationNumber: 1,
              outcome: 'unknown',
              outcomeReason: 'open-request',
              verifiedBy: 'write-response',
            },
          ],
          new Date(),
        );
        const readBack = randomUUID();
        // The write reservation of the same attempt lapses, and the read-back claim takes it over.
        await migrator.query(
          "UPDATE cc.device_update_operations SET verify_lease_expires_at=clock_timestamp()-interval '1 second' WHERE job_id=$1",
          [job.jobId],
        );
        const claimedReadBack = await claimVerification(
          job.jobId,
          [1],
          readBack,
        );
        assert.equal(claimedReadBack.length, 1);
        await migrator.query(
          "UPDATE cc.device_update_operations SET verify_lease_expires_at=clock_timestamp()+interval '3 seconds' WHERE job_id=$1",
          [job.jobId],
        );
        const holder = await connect('cc-migrator', 'cc-app');
        const settler = await connect('cc-app', 'cc-app');
        let settlement = null;
        const beforeRow = await jobRow(job.jobId);
        try {
          const holderPid = (
            await holder.query('SELECT pg_backend_pid() AS pid')
          ).rows[0].pid;
          const settlerPid = (
            await settler.query('SELECT pg_backend_pid() AS pid')
          ).rows[0].pid;
          await holder.query('BEGIN');
          await holder.query(
            'SELECT 1 FROM cc.device_update_operations WHERE job_id=$1 AND operation_number=1 FOR UPDATE',
            [job.jobId],
          );
          settlement = settler.query(
            'SELECT cc.settle_device_update_operations($1,$2,$3,$4,$5,$6,$7) AS result',
            [
              customer,
              job.jobId,
              token,
              readBack,
              'read-back',
              JSON.stringify([
                {
                  operationNumber: 1,
                  outcome: 'succeeded',
                  values: { annotatedLocation: 'Room 12' },
                  verifiedBy: 'read-back',
                },
              ]),
              new Date(),
            ],
          );
          settlement.catch(() => undefined);
          assert.equal(
            await waitsFor(settlerPid, holderPid),
            true,
            'The settlement waits for the operation row.',
          );
          assert.equal(
            await until(
              'SELECT clock_timestamp()>verify_lease_expires_at AS lapsed FROM cc.device_update_operations WHERE job_id=$1 AND operation_number=1',
              [job.jobId],
            ),
            true,
            'The read-back lease lapses in the wait.',
          );
          await holder.query('COMMIT');
          const settled = (await settlement).rows[0].result;
          assert.deepEqual(settled.settled, []);
          assert.equal(settled.publication, null);
        } finally {
          await holder.query('ROLLBACK').catch(() => undefined);
          if (settlement) await settlement.catch(() => undefined);
          await Promise.allSettled([holder.end(), settler.end()]);
        }
        const row = (await operations(job.jobId))[0];
        assert.equal(row.status, 'unknown');
        assert.equal(row.verify_attempt, readBack);
        assert.equal((await deviceRow('fe-a')).annotated_location, null);
        assert.equal((await jobRow(job.jobId)).revision, beforeRow.revision);
        await endJob(job.jobId);
      },
    );

    await check(
      'a settlement that waited for its operation row keeps a replacement read-back claim',
      async () => {
        await upsert([device('fc-a')], new Date(Date.now() - 60 * 60 * 1000));
        const job = await makeJob({ devices: ['fc-a'] });
        const admitted = await admit(false);
        const token = admitted.dispatchToken;
        const writer = randomUUID();
        await claim(job.jobId, token, 0, writer);
        await settle(
          job.jobId,
          token,
          writer,
          'write',
          [
            {
              operationNumber: 1,
              outcome: 'unknown',
              outcomeReason: 'open-request',
              verifiedBy: 'write-response',
            },
          ],
          new Date(),
        );
        const readBack = randomUUID();
        const replacement = randomUUID();
        // The write reservation of the same attempt lapses, and the read-back claim takes it over.
        await migrator.query(
          "UPDATE cc.device_update_operations SET verify_lease_expires_at=clock_timestamp()-interval '1 second' WHERE job_id=$1",
          [job.jobId],
        );
        const claimedReadBack = await claimVerification(
          job.jobId,
          [1],
          readBack,
        );
        assert.equal(claimedReadBack.length, 1);
        await migrator.query(
          "UPDATE cc.device_update_operations SET verify_lease_expires_at=clock_timestamp()+interval '3 seconds' WHERE job_id=$1",
          [job.jobId],
        );
        const holder = await connect('cc-migrator', 'cc-app');
        const settler = await connect('cc-app', 'cc-app');
        let settlement = null;
        try {
          const holderPid = (
            await holder.query('SELECT pg_backend_pid() AS pid')
          ).rows[0].pid;
          const settlerPid = (
            await settler.query('SELECT pg_backend_pid() AS pid')
          ).rows[0].pid;
          await holder.query('BEGIN');
          await holder.query(
            'SELECT 1 FROM cc.device_update_operations WHERE job_id=$1 AND operation_number=1 FOR UPDATE',
            [job.jobId],
          );
          settlement = settler.query(
            'SELECT cc.settle_device_update_operations($1,$2,$3,$4,$5,$6,$7) AS result',
            [
              customer,
              job.jobId,
              token,
              readBack,
              'read-back',
              JSON.stringify([
                {
                  operationNumber: 1,
                  outcome: 'succeeded',
                  values: { annotatedLocation: 'Room 12' },
                  verifiedBy: 'read-back',
                },
              ]),
              new Date(),
            ],
          );
          settlement.catch(() => undefined);
          assert.equal(
            await waitsFor(settlerPid, holderPid),
            true,
            'The settlement waits for the operation row.',
          );
          // The claim of another attempt reserves the operation before the settlement proceeds.
          await holder.query(
            "UPDATE cc.device_update_operations SET verify_attempt=$2,verify_lease_expires_at=clock_timestamp()+interval '120 minutes' WHERE job_id=$1 AND operation_number=1",
            [job.jobId, replacement],
          );
          await holder.query('COMMIT');
          const settled = (await settlement).rows[0].result;
          assert.deepEqual(settled.settled, []);
          assert.equal(settled.publication, null);
        } finally {
          await holder.query('ROLLBACK').catch(() => undefined);
          if (settlement) await settlement.catch(() => undefined);
          await Promise.allSettled([holder.end(), settler.end()]);
        }
        const row = (await operations(job.jobId))[0];
        assert.equal(row.status, 'unknown');
        assert.equal(row.verify_attempt, replacement);
        assert.equal((await deviceRow('fc-a')).annotated_location, null);
        await endJob(job.jobId);
      },
    );

    // S3 and review F18: a batch that loses the race to the purge records nothing.
    await check(
      'the purge keeps its interrupted refresh header against a late batch finisher',
      async () => {
        const refresh = randomUUID();
        await result(
          'SELECT cc.create_entity_sync_job($1,1,$2,$3,$4,$5,$6,$7) AS result',
          [
            reader,
            customer,
            'device',
            '["pl-a","pl-b"]',
            1,
            refresh,
            randomUUID(),
          ],
        );
        await migrator.query(
          "UPDATE cc.jobs SET created_at=created_at-interval '3 hours' WHERE job_id=$1",
          [refresh],
        );
        const before = await publications(refresh);
        const purge = await connect('cc-migrator', 'cc-app');
        const finisher = await connect('cc-migrator', 'cc-app');
        let finishRun = null;
        try {
          const purgePid = (await purge.query('SELECT pg_backend_pid() AS pid'))
            .rows[0].pid;
          const finisherPid = (
            await finisher.query('SELECT pg_backend_pid() AS pid')
          ).rows[0].pid;
          await purge.query('BEGIN');
          await purge.query('SELECT cc.purge_jobs($1,$2) AS result', [
            customer,
            100,
          ]);
          finishRun = finisher.query(
            'SELECT cc.finish_entity_sync_batch($1,$2,$3,$4) AS result',
            [customer, refresh, 0, null],
          );
          finishRun.catch(() => undefined);
          assert.equal(
            await waitsFor(finisherPid, purgePid),
            true,
            'The late batch waits for the purged detail row.',
          );
          await purge.query('COMMIT');
          await finishRun;
        } finally {
          await purge.query('ROLLBACK').catch(() => undefined);
          if (finishRun) await finishRun.catch(() => undefined);
          await Promise.allSettled([purge.end(), finisher.end()]);
        }
        const header = await jobRow(refresh);
        assert.equal(header.status, 'failed');
        assert.equal(header.failure, 'interrupted');
        assert.ok(header.finished_at, 'The purge records the finish time.');
        assert.equal(await publications(refresh), before + 1);
        assert.equal(
          (
            await admin(
              'SELECT count(*)::int AS result FROM cc.entity_sync_batches WHERE job_id=$1',
              [refresh],
            )
          )[0].result,
          0,
        );
      },
    );

    // S3 and review F19: an interrupted full-sync closure keeps its observed target metadata.
    await check(
      'an interrupted full sync records its observed target count and paths',
      async () => {
        await resetSync();
        const replaced = await requestAs(reader);
        const replacedAttempt = randomUUID();
        await claimSync(replaced.id, replacedAttempt);
        await stage(replaced.id, replacedAttempt, [
          device('im-a', { orgUnitPath: '/Audit' }),
        ]);
        await migrator.query(
          "UPDATE cc.device_sync_state SET sync_expires_at=clock_timestamp()-interval '1 second' WHERE customer_id=$1",
          [customer],
        );
        await requestAs(reader);
        const replacedHeader = await jobRow(replaced.id);
        assert.equal(replacedHeader.status, 'failed');
        assert.equal(replacedHeader.failure, 'interrupted');
        assert.equal(replacedHeader.target_count, 1);
        assert.equal(replacedHeader.succeeded, 1);
        assert.deepEqual(replacedHeader.target_org_unit_paths, ['/Audit']);
        // The purge closes a full sync without a live lease.
        const replacement = await adminRow(
          'SELECT sync_id FROM cc.device_sync_state WHERE customer_id=$1',
          [customer],
        );
        const purgeAttempt = randomUUID();
        await claimSync(replacement.sync_id, purgeAttempt);
        await stage(replacement.sync_id, purgeAttempt, [
          device('im-b', { orgUnitPath: '/School B' }),
          device('im-c', { orgUnitPath: '/Audit' }),
        ]);
        await migrator.query(
          "UPDATE cc.device_sync_state SET sync_expires_at=clock_timestamp()-interval '1 second' WHERE customer_id=$1",
          [customer],
        );
        await result('SELECT cc.purge_jobs($1,$2) AS result', [customer, 100]);
        const purgedHeader = await jobRow(replacement.sync_id);
        assert.equal(purgedHeader.status, 'failed');
        assert.equal(purgedHeader.failure, 'interrupted');
        assert.equal(purgedHeader.target_count, 2);
        assert.equal(purgedHeader.succeeded, 2);
        assert.deepEqual(purgedHeader.target_org_unit_paths, [
          '/Audit',
          '/School B',
        ]);
        // A closure without staged devices records an empty observation.
        const empty = await requestAs(reader);
        const emptyAttempt = randomUUID();
        await claimSync(empty.id, emptyAttempt);
        await migrator.query(
          "UPDATE cc.device_sync_state SET sync_expires_at=clock_timestamp()-interval '1 second' WHERE customer_id=$1",
          [customer],
        );
        await result('SELECT cc.purge_jobs($1,$2) AS result', [customer, 100]);
        const emptyHeader = await jobRow(empty.id);
        assert.equal(emptyHeader.status, 'failed');
        assert.equal(emptyHeader.target_count, 0);
        assert.equal(emptyHeader.succeeded, 0);
        assert.deepEqual(emptyHeader.target_org_unit_paths, []);
        await resetSync();
      },
    );

    // S1 and review F20: the soft delete prelocks every requested row in device_id order.
    await check(
      'the soft delete prelock covers a removed row that a refresh revived',
      async () => {
        await upsert([device('sd-a')], new Date(Date.now() - 60 * 60 * 1000));
        await upsert([device('sd-b')], new Date(Date.now() - 60 * 60 * 1000));
        await result('SELECT cc.soft_delete_devices($1,$2) AS result', [
          customer,
          JSON.stringify(['sd-a']),
        ]);
        const holder = await connect('cc-migrator', 'cc-app');
        const deleter = await connect('cc-migrator', 'cc-app');
        const reviver = await connect('cc-migrator', 'cc-app');
        let deletion = null;
        try {
          const holderPid = (
            await holder.query('SELECT pg_backend_pid() AS pid')
          ).rows[0].pid;
          const deleterPid = (
            await deleter.query('SELECT pg_backend_pid() AS pid')
          ).rows[0].pid;
          await holder.query('BEGIN');
          await holder.query(
            'SELECT 1 FROM cc.devices WHERE customer_id=$1 AND device_id=$2 FOR UPDATE',
            [customer, 'sd-b'],
          );
          deletion = deleter.query(
            'SELECT cc.soft_delete_devices($1,$2) AS result',
            [customer, JSON.stringify(['sd-a', 'sd-b'])],
          );
          deletion.catch(() => undefined);
          assert.equal(
            await waitsFor(deleterPid, holderPid),
            true,
            'The deletion waits for the present row.',
          );
          // The prelock holds the removed row too, so a revival waits instead of racing it.
          await reviver.query("SET lock_timeout='750ms'");
          const revived = await reviver
            .query(
              "UPDATE cc.devices SET removed_at=NULL WHERE customer_id=$1 AND device_id='sd-a'",
              [customer],
            )
            .then(
              () => 'taken',
              (error) => (error.code === '55P03' ? 'locked' : error.message),
            );
          assert.equal(
            revived,
            'locked',
            'The deletion holds the removed row in the prelock.',
          );
          await holder.query('COMMIT');
          await deletion;
        } finally {
          await holder.query('ROLLBACK').catch(() => undefined);
          if (deletion) await deletion.catch(() => undefined);
          await Promise.allSettled([
            holder.end(),
            deleter.end(),
            reviver.end(),
          ]);
        }
        assert.deepEqual(
          (
            await admin(
              `SELECT device_id FROM cc.devices WHERE customer_id=$1 AND device_id LIKE 'sd-%'
                AND removed_at IS NOT NULL ORDER BY device_id`,
              [customer],
            )
          ).map((row) => row.device_id),
          ['sd-a', 'sd-b'],
        );
      },
    );
    // Round 6: the serialization rules S1, S2, and S3 of the eng-lead ruling. Every check names the
    // rule it measures, so a later regression names the rule it breaks. These checks carry the
    // reviewer's round-5 rule probes into this module.
    const detailRow = (jobId) =>
      adminRow(
        `SELECT kestra_execution_id,dispatch_token,first_claimed_at,heartbeat_at
          FROM cc.device_update_jobs WHERE job_id=$1`,
        [jobId],
      );
    // A fixture that rotates the dispatch token changes one detail field on purpose. Every other field
    // of the detail row stays comparable, so a call that writes heartbeat_at or first_claimed_at after
    // the rotation still fails its own check.
    const withoutDispatchToken = (detail) => {
      const rest = { ...detail };
      delete rest.dispatch_token;
      return rest;
    };
    const batchRow = (jobId, batch = 0) =>
      adminRow(
        `SELECT attempt_id,execution_id,lease_expires_at,settled_at
          FROM cc.device_update_batches WHERE job_id=$1 AND batch=$2`,
        [jobId, batch],
      );
    const headerWait = async (client, jobId) => {
      const locked = await client.query(
        'SELECT 1 FROM cc.jobs WHERE job_id=$1 FOR UPDATE',
        [jobId],
      );
      return locked;
    };
    const pidOf = async (client) =>
      (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const makeRefresh = async (ids = ['s1-a', 's1-b'], batchSize = 1) => {
      const refresh = randomUUID();
      await result(
        'SELECT cc.create_entity_sync_job($1,1,$2,$3,$4,$5,$6,$7) AS result',
        [
          reader,
          customer,
          'device',
          JSON.stringify(ids),
          batchSize,
          refresh,
          randomUUID(),
        ],
      );
      return refresh;
    };
    const makeSync = async () => {
      await resetSync();
      const sync = await requestAs(reader);
      const attempt = randomUUID();
      await claimSync(sync.id, attempt);
      return { id: sync.id, attempt };
    };
    // A held header row blocks the writer. The caller waits on it and reports the lock timeout.
    const headerBlocks = async ({ name, role, prepare, run }) => {
      const sync = await makeSync();
      if (prepare) await prepare(sync);
      const holder = await connect('cc-migrator', 'cc-app');
      const caller = await connect(role, 'cc-app');
      try {
        await holder.query('BEGIN');
        await headerWait(holder, sync.id);
        await caller.query("SET lock_timeout='300ms'");
        const code = await run(caller, sync).then(
          () => null,
          (error) => error.code,
        );
        assert.equal(
          code,
          '55P03',
          `${name} must wait for the full-sync header.`,
        );
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        await Promise.allSettled([holder.end(), caller.end()]);
      }
      await resetSync();
    };
    // A header waiter holds no detail lock. A second session proves the detail row is free.
    const waitsOnHeaderWithoutDetail = async (name, run) => {
      const refresh = await makeRefresh();
      const holder = await connect('cc-migrator', 'cc-app');
      const caller = await connect('cc-app', 'cc-app');
      const observer = await connect('cc-migrator', 'cc-app');
      let pending = null;
      try {
        await holder.query('BEGIN');
        await headerWait(holder, refresh);
        const holderPid = await pidOf(holder);
        const callerPid = await pidOf(caller);
        pending = run(caller, refresh);
        pending.catch(() => undefined);
        assert.equal(
          await waitsFor(callerPid, holderPid),
          true,
          `${name} waits for the header row.`,
        );
        await observer.query('BEGIN');
        const detailFree = await observer
          .query(
            'SELECT 1 FROM cc.entity_sync_jobs WHERE job_id=$1 FOR UPDATE NOWAIT',
            [refresh],
          )
          .then(
            () => true,
            (error) => error.code,
          );
        await observer.query('ROLLBACK');
        assert.equal(
          detailFree,
          true,
          `${name} holds no detail lock while it waits for the header.`,
        );
        await holder.query('COMMIT');
        await pending;
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        await observer.query('ROLLBACK').catch(() => undefined);
        if (pending) await pending.catch(() => undefined);
        await Promise.allSettled([holder.end(), caller.end(), observer.end()]);
      }
    };
    // A settled job and a lapsed lease give the writer its own contention fixture.
    const heldJob = async (deviceId, options = {}) => {
      const job = await makeJob({ devices: [deviceId], ...options });
      const admitted = await admit(false);
      assert.equal(admitted.jobId, job.jobId, 'The admission picks this job.');
      const attempt = randomUUID();
      await claim(job.jobId, admitted.dispatchToken, 0, attempt);
      return { ...job, token: admitted.dispatchToken, attempt };
    };
    // The admission picks the oldest accepted job, so every rule check starts from closed jobs.
    // A lease that lapsed inside its 30-second grace moves past the grace too, so a failed check
    // never leaves a busy job that the finalizer cannot close.
    const closeOpenWriteJobs = async () => {
      await migrator.query(
        `UPDATE cc.device_update_batches SET lease_expires_at=clock_timestamp()-interval '60 seconds'
          WHERE lease_expires_at>clock_timestamp()-interval '60 seconds'`,
      );
      const open = await admin(
        `SELECT job_id FROM cc.jobs WHERE kind='device-update'
          AND status IN ('accepted','queued','held','running') ORDER BY created_at`,
      );
      for (const row of open)
        await migrator.query('SELECT cc.finalize_device_update_job($1,$2,$3)', [
          customer,
          row.job_id,
          null,
        ]);
    };
    const ruleCheck = async (name, body) =>
      check(name, async () => {
        await closeOpenWriteJobs();
        await body();
      });

    await ruleCheck(
      'S2 a null-token start changes no execution metadata',
      async () => {
        const job = await makeJob({ devices: ['ns-a'] });
        const before = await detailRow(job.jobId);
        await rejects(
          result('SELECT cc.record_device_update_start($1,$2,$3,$4)', [
            customer,
            job.jobId,
            null,
            'null-token-start',
          ]),
          null,
          'attempt-fenced',
        );
        assert.deepEqual(await detailRow(job.jobId), before);
      },
    );

    await ruleCheck(
      'S2 a null-token preparation changes no operation, counter, or publication',
      async () => {
        const job = await makeJob({ devices: ['np-a'] });
        const before = await jobRow(job.jobId);
        const published = await publications(job.jobId);
        const prepared = await prepareFinish(job.jobId, null);
        assert.equal(prepared.outcome, 'superseded');
        assert.deepEqual(await jobRow(job.jobId), before);
        assert.equal(await publications(job.jobId), published);
        assert.deepEqual(
          (await operations(job.jobId)).map((row) => row.status),
          ['pending'],
        );
      },
    );

    await ruleCheck(
      'S3 a late start on a terminal job changes no execution metadata',
      async () => {
        const job = await heldJob('ls-a');
        assert.equal((await endJob(job.jobId)).outcome, 'finalized');
        const before = await detailRow(job.jobId);
        const header = await jobRow(job.jobId);
        const published = await publications(job.jobId);
        await result('SELECT cc.record_device_update_start($1,$2,$3,$4)', [
          customer,
          job.jobId,
          job.token,
          'late-terminal-start',
        ]);
        assert.deepEqual(await detailRow(job.jobId), before);
        assert.equal((await jobRow(job.jobId)).revision, header.revision);
        assert.equal(await publications(job.jobId), published);
      },
    );

    await ruleCheck(
      'S3 a release on a terminal job keeps its batch attempt and settled_at',
      async () => {
        const job = await heldJob('tr-a');
        assert.equal((await endJob(job.jobId)).outcome, 'finalized');
        const before = await batchRow(job.jobId);
        await stop(job.jobId, job.token, 0, job.attempt);
        assert.deepEqual(await batchRow(job.jobId), before);
      },
    );

    for (const [label, invalidCustomer] of [
      ['a wrong customer', 'C-missing'],
      ['a null customer', null],
    ]) {
      await ruleCheck(
        `S1 a renewal requires its customer-scoped header for ${label}`,
        async () => {
          const job = await heldJob('rn-a');
          const before = await batchRow(job.jobId);
          await rejects(
            result(
              'SELECT cc.renew_device_update_batch($1,$2,$3,$4,$5) AS result',
              [invalidCustomer, job.jobId, job.token, 0, job.attempt],
            ),
            null,
            'attempt-fenced',
          );
          assert.deepEqual(await batchRow(job.jobId), before);
          await endJob(job.jobId);
        },
      );

      await ruleCheck(
        `S1 a release requires its customer-scoped header for ${label}`,
        async () => {
          const job = await heldJob('rl-a');
          const before = await batchRow(job.jobId);
          await rejects(
            result(
              'SELECT cc.release_device_update_batch($1,$2,$3,$4,$5) AS result',
              [invalidCustomer, job.jobId, job.token, 0, job.attempt],
            ),
            null,
            'attempt-fenced',
          );
          assert.deepEqual(await batchRow(job.jobId), before);
          await endJob(job.jobId);
        },
      );
    }

    await ruleCheck(
      'S1 a sync claim takes the full-sync header before it mutates',
      async () => {
        await headerBlocks({
          name: 'The sync claim',
          role: 'cc-app',
          run: (client, sync) =>
            client.query('SELECT cc.claim_device_sync($1,$2,$3)', [
              customer,
              sync.id,
              sync.attempt,
            ]),
        });
      },
    );

    await ruleCheck(
      'S1 a sync lease takes the full-sync header before it mutates',
      async () => {
        await headerBlocks({
          name: 'The sync lease',
          role: 'cc-migrator',
          run: (client, sync) =>
            client.query('SELECT cc.device_sync_lease($1,$2,$3)', [
              customer,
              sync.id,
              sync.attempt,
            ]),
        });
      },
    );

    await ruleCheck(
      'S1 a staged battery page takes the full-sync header before it mutates',
      async () => {
        await headerBlocks({
          name: 'The staged battery page',
          role: 'cc-app',
          prepare: (sync) =>
            upsert(
              [device(`bt-${sync.id}`)],
              new Date(Date.now() - 60 * 60 * 1000),
            ),
          run: (client, sync) =>
            client.query('SELECT cc.stage_device_batteries($1,$2,$3,$4)', [
              customer,
              sync.id,
              sync.attempt,
              JSON.stringify([
                {
                  deviceId: `bt-${sync.id}`,
                  battery: {
                    status: 'reported',
                    health: 'normal',
                    capacityPercent: 90,
                    reportedAt: '2026-10-05T12:00:00.000Z',
                  },
                  reports: [],
                },
              ]),
            ]),
        });
      },
    );

    await ruleCheck(
      'S1 a refresh batch waits for the header without holding the detail row',
      async () => {
        await waitsOnHeaderWithoutDetail(
          'The refresh batch',
          (client, refresh) =>
            client.query('SELECT cc.finish_entity_sync_batch($1,$2,$3,$4)', [
              customer,
              refresh,
              0,
              null,
            ]),
        );
      },
    );

    await ruleCheck(
      'S1 an abandoned refresh waits for the header without holding the detail row',
      async () => {
        await waitsOnHeaderWithoutDetail(
          'The abandoned refresh',
          (client, refresh) =>
            client.query('SELECT cc.abandon_entity_sync_job($1,$2,$3,$4)', [
              reader,
              1,
              customer,
              refresh,
            ]),
        );
      },
    );

    await ruleCheck(
      'S1 admission sets its clock after the header wait',
      async () => {
        const job = await makeJob({ devices: ['ad-a'] });
        const holder = await connect('cc-migrator', 'cc-app');
        const caller = await connect('cc-app', 'cc-app');
        let pending = null;
        try {
          await holder.query('BEGIN');
          await headerWait(holder, job.jobId);
          const holderPid = await pidOf(holder);
          const callerPid = await pidOf(caller);
          pending = caller.query(
            'SELECT cc.admit_device_update_job($1,false) AS result',
            [customer],
          );
          pending.catch(() => undefined);
          assert.equal(
            await waitsFor(callerPid, holderPid),
            true,
            'The admission waits for the header row.',
          );
          const releasedAt = (
            await holder.query('SELECT clock_timestamp() AS at')
          ).rows[0].at;
          await holder.query('COMMIT');
          const admitted = (await pending).rows[0].result;
          assert.equal(admitted.jobId, job.jobId);
          const saved = await adminRow(
            `SELECT j.admitted_at,u.start_deadline_at FROM cc.jobs j
              JOIN cc.device_update_jobs u ON u.job_id=j.job_id WHERE j.job_id=$1`,
            [job.jobId],
          );
          assert.ok(
            saved.admitted_at >= releasedAt,
            'Admission must not stamp its pre-wait clock.',
          );
        } finally {
          await holder.query('ROLLBACK').catch(() => undefined);
          if (pending) await pending.catch(() => undefined);
          await Promise.allSettled([holder.end(), caller.end()]);
        }
        await endJob(job.jobId);
      },
    );

    await ruleCheck(
      'S1 a final finish leaves a live dispatched batch running',
      async () => {
        const job = await heldJob('lf-a');
        const finished = await finishWithToken(job.jobId, job.token);
        assert.equal(finished.outcome, 'busy');
        assert.equal((await jobRow(job.jobId)).status, 'running');
        assert.deepEqual(
          (await operations(job.jobId)).map((row) => row.status),
          ['dispatched'],
        );
        await endJob(job.jobId);
      },
    );

    await ruleCheck(
      'S3 a completed refresh keeps its outcome against a late batch',
      async () => {
        const refresh = await makeRefresh(['lb-a'], 1);
        await result(
          'SELECT cc.finish_entity_sync_batch($1,$2,$3,$4) AS result',
          [customer, refresh, 0, null],
        );
        const before = await jobRow(refresh);
        assert.equal(before.status, 'completed');
        await result(
          'SELECT cc.finish_entity_sync_batch($1,$2,$3,$4) AS result',
          [customer, refresh, 0, 'quota'],
        );
        assert.deepEqual(await jobRow(refresh), before);
        assert.equal(
          (
            await admin(
              'SELECT count(*)::int AS result FROM cc.entity_sync_batches WHERE job_id=$1',
              [refresh],
            )
          )[0].result,
          1,
        );
      },
    );

    // Round 6, R6-8: the clock reads and the header lifecycle validates before the detail and batch
    // locks. A repeat on a completed refresh never waits on a descendant row.
    await ruleCheck(
      'S1 a completed refresh repeat does not wait on its detail row',
      async () => {
        const refresh = await makeRefresh(['r6h-a'], 1);
        await result(
          'SELECT cc.finish_entity_sync_batch($1,$2,$3,$4) AS result',
          [customer, refresh, 0, null],
        );
        const before = await jobRow(refresh);
        assert.equal(before.status, 'completed');
        const holder = await connect('cc-migrator', 'cc-app');
        const caller = await connect('cc-app', 'cc-app');
        try {
          await holder.query('BEGIN');
          await holder.query(
            'SELECT 1 FROM cc.entity_sync_jobs WHERE job_id=$1 FOR UPDATE',
            [refresh],
          );
          await caller.query("SET lock_timeout='300ms'");
          const answer = await caller
            .query(
              'SELECT cc.finish_entity_sync_batch($1,$2,$3,$4) AS result',
              [customer, refresh, 0, 'quota'],
            )
            .then(
              (rows) => ({ result: rows.rows[0].result }),
              (error) => ({ code: error.code, message: error.message }),
            );
          assert.equal(
            answer.code,
            undefined,
            `A completed refresh must check its header before its detail lock: ${answer.message ?? ''}`,
          );
          assert.ok(answer.result, 'The repeat returns the job projection.');
        } finally {
          await holder.query('ROLLBACK').catch(() => undefined);
          await Promise.allSettled([holder.end(), caller.end()]);
        }
        assert.deepEqual(await jobRow(refresh), before);
        assert.equal(
          (
            await admin(
              'SELECT count(*)::int AS result FROM cc.entity_sync_batches WHERE job_id=$1',
              [refresh],
            )
          )[0].result,
          1,
          'A completed refresh keeps its one batch record.',
        );
      },
    );

    // Round 6, R6-9: the clock reads and the header lifecycle validates before the detail lock.
    await ruleCheck(
      'S1 an abandoned completed refresh rejects before its detail lock',
      async () => {
        const refresh = await makeRefresh(['r6i-a'], 1);
        await result(
          'SELECT cc.finish_entity_sync_batch($1,$2,$3,$4) AS result',
          [customer, refresh, 0, null],
        );
        const before = await jobRow(refresh);
        const published = await publications(refresh);
        const holder = await connect('cc-migrator', 'cc-app');
        const caller = await connect('cc-app', 'cc-app');
        try {
          await holder.query('BEGIN');
          await holder.query(
            'SELECT 1 FROM cc.entity_sync_jobs WHERE job_id=$1 FOR UPDATE',
            [refresh],
          );
          await caller.query("SET lock_timeout='300ms'");
          const answer = await caller
            .query('SELECT cc.abandon_entity_sync_job($1,$2,$3,$4) AS result', [
              reader,
              1,
              customer,
              refresh,
            ])
            .then(
              () => ({ accepted: true }),
              (error) => ({ code: error.code, detail: error.detail }),
            );
          assert.notEqual(
            answer.code,
            '55P03',
            'An abandoned completed refresh must not wait on its detail row.',
          );
          assert.equal(answer.detail, 'entity-sync-changed');
        } finally {
          await holder.query('ROLLBACK').catch(() => undefined);
          await Promise.allSettled([holder.end(), caller.end()]);
        }
        assert.deepEqual(await jobRow(refresh), before);
        assert.equal(await publications(refresh), published);
      },
    );

    const syncStateRow = () =>
      adminRow(
        `SELECT sync_id,sync_attempt,sync_expires_at FROM cc.device_sync_state
          WHERE customer_id=$1`,
        [customer],
      );

    // Round 6, R6-10: the claim loads the scoped full-sync header, so its fence sees a terminal or
    // missing header before it renews the state tuple. The reviewer found this by inspection.
    await ruleCheck(
      'S1 a sync claim validates the full-sync header before it mutates',
      async () => {
        await resetSync();
        const sync = await requestAs(reader);
        const attempt = randomUUID();
        await claimSync(sync.id, attempt);
        await migrator.query(
          "UPDATE cc.jobs SET status='failed',finished_at=clock_timestamp() WHERE job_id=$1",
          [sync.id],
        );
        // The state tuple keeps a live lease while its header is terminal.
        await migrator.query(
          `UPDATE cc.device_sync_state SET sync_attempt=NULL,
            sync_expires_at=clock_timestamp()+interval '5 minutes' WHERE customer_id=$1`,
          [customer],
        );
        const before = await syncStateRow();
        await rejects(
          claimSync(sync.id, randomUUID()),
          null,
          'device-sync-changed',
        );
        assert.equal(
          (
            await adminRow(
              'SELECT sync_attempt FROM cc.device_sync_state WHERE customer_id=$1',
              [customer],
            )
          ).sync_attempt,
          null,
          'A rejected claim writes no attempt.',
        );
        assert.deepEqual(await syncStateRow(), before);
        // A state tuple whose header is missing rejects too.
        await migrator.query('DELETE FROM cc.jobs WHERE job_id=$1', [sync.id]);
        await rejects(
          claimSync(sync.id, randomUUID()),
          null,
          'device-sync-changed',
        );
        assert.deepEqual(await syncStateRow(), before);
        await resetSync();
      },
    );

    // Round 6, R6-11: the lease helper loads the scoped full-sync header, so both staging entry
    // points share its complete fence. The reviewer found this by inspection.
    await ruleCheck(
      'S1 a sync lease validates the full-sync header before it renews',
      async () => {
        await resetSync();
        const sync = await requestAs(reader);
        const attempt = randomUUID();
        await claimSync(sync.id, attempt);
        await migrator.query(
          "UPDATE cc.jobs SET status='failed',finished_at=clock_timestamp() WHERE job_id=$1",
          [sync.id],
        );
        const before = await syncStateRow();
        // The lease helper carries no execute grant for the runtime role.
        const renewer = await connect('cc-migrator', 'cc-app');
        try {
          await rejects(
            renewer.query('SELECT cc.device_sync_lease($1,$2,$3)', [
              customer,
              sync.id,
              attempt,
            ]),
            null,
            'device-sync-changed',
          );
        } finally {
          await renewer.end();
        }
        assert.deepEqual(await syncStateRow(), before);
        // The staging entry point shares the helper's fence, so it writes no page either.
        await rejects(
          stage(sync.id, attempt, [device('r6k-a')]),
          null,
          'device-sync-changed',
        );
        assert.deepEqual(await syncStateRow(), before);
        assert.equal(
          await result(
            'SELECT count(*)::int AS result FROM cc.job_targets WHERE job_id=$1',
            [sync.id],
          ),
          0,
        );
        assert.equal(
          await result(
            'SELECT count(*)::int AS result FROM cc.devices WHERE customer_id=$1 AND device_id=$2',
            [customer, 'r6k-a'],
          ),
          0,
        );
        // A state tuple whose header is missing rejects and renews nothing.
        await migrator.query('DELETE FROM cc.jobs WHERE job_id=$1', [sync.id]);
        const gone = await connect('cc-migrator', 'cc-app');
        try {
          await rejects(
            gone.query('SELECT cc.device_sync_lease($1,$2,$3)', [
              customer,
              sync.id,
              attempt,
            ]),
            null,
            'device-sync-changed',
          );
        } finally {
          await gone.end();
        }
        assert.deepEqual(await syncStateRow(), before);
        await resetSync();
      },
    );

    // A completed full sync that left the seven-day retention window. Every other closure candidate
    // of the customer ends first, so a wait on the sync state in these checks comes from the
    // retention pass and not from the interrupted-sync pass.
    const makeRetentionSync = async () => {
      await migrator.query(
        `UPDATE cc.jobs SET status='failed',finished_at=COALESCE(finished_at,clock_timestamp())
          WHERE customer_id=$1 AND kind='inventory-refresh' AND scope_kind='all-devices'
            AND status='running'`,
        [customer],
      );
      await resetSync();
      const sync = await requestAs(reader);
      const attempt = randomUUID();
      await claimSync(sync.id, attempt);
      await finishSync(sync.id, attempt);
      await migrator.query(
        "UPDATE cc.jobs SET finished_at=clock_timestamp()-interval '8 days' WHERE job_id=$1",
        [sync.id],
      );
      await resetSync();
      return sync.id;
    };

    // Round 6, R6-12: retention takes the sync state before the header, and the deletion itself
    // stays allowed.
    await ruleCheck(
      'S1 full-sync retention takes the sync state before it deletes the header',
      async () => {
        const candidate = await makeRetentionSync();
        const before = await jobRow(candidate);
        const holder = await connect('cc-migrator', 'cc-app');
        const purge = await connect('cc-migrator', 'cc-app');
        try {
          await holder.query('BEGIN');
          await holder.query(
            'SELECT 1 FROM cc.device_sync_state WHERE customer_id=$1 FOR UPDATE',
            [customer],
          );
          await purge.query("SET lock_timeout='300ms'");
          const answer = await purge
            .query('SELECT cc.purge_jobs($1,$2) AS result', [customer, 100])
            .then(
              () => ({ accepted: true }),
              (error) => ({ code: error.code }),
            );
          assert.equal(
            answer.code,
            '55P03',
            'A full-sync retention writer must take the sync state before the header.',
          );
        } finally {
          await holder.query('ROLLBACK').catch(() => undefined);
          await Promise.allSettled([holder.end(), purge.end()]);
        }
        assert.deepEqual(await jobRow(candidate), before);
        // The control: with the state row free, retention still deletes the completed sync.
        await result('SELECT cc.purge_jobs($1,$2) AS result', [customer, 100]);
        assert.equal(
          await result(
            'SELECT count(*)::int AS result FROM cc.jobs WHERE job_id=$1',
            [candidate],
          ),
          0,
          'Retention still deletes a completed full sync after seven days.',
        );
      },
    );

    // Round 6, R6-12: the candidate reads again after its wait, so a row that a concurrent
    // retention session removed is not counted twice and no error follows.
    await ruleCheck(
      'S1 full-sync retention rechecks its candidate after the state wait',
      async () => {
        const candidate = await makeRetentionSync();
        const holder = await connect('cc-migrator', 'cc-app');
        const purge = await connect('cc-migrator', 'cc-app');
        let run = null;
        let removed = null;
        try {
          const holderPid = await pidOf(holder);
          const purgePid = await pidOf(purge);
          await holder.query('BEGIN');
          await holder.query(
            'SELECT 1 FROM cc.device_sync_state WHERE customer_id=$1 FOR UPDATE',
            [customer],
          );
          run = purge.query('SELECT cc.purge_jobs($1,$2) AS result', [
            customer,
            100,
          ]);
          run.catch(() => undefined);
          assert.equal(
            await waitsFor(purgePid, holderPid),
            true,
            'The purge waits for the sync state row.',
          );
          // A concurrent retention session removes the candidate during the wait.
          await holder.query('DELETE FROM cc.jobs WHERE job_id=$1', [
            candidate,
          ]);
          await holder.query('COMMIT');
          removed = (await run).rows[0].result;
        } finally {
          await holder.query('ROLLBACK').catch(() => undefined);
          if (run) await run.catch(() => undefined);
          await Promise.allSettled([holder.end(), purge.end()]);
        }
        assert.equal(
          removed,
          0,
          'A candidate removed in the wait is not deleted or counted again.',
        );
        assert.equal(
          await result(
            'SELECT count(*)::int AS result FROM cc.jobs WHERE job_id=$1',
            [candidate],
          ),
          0,
        );
      },
    );

    // Round 2 of B2b: review findings R1-F1 to R1-F6 and the eng-lead lock-order ruling. Within one
    // transaction, every sync-state lock comes before any connection lock, including the key-share
    // lock of a publication insert. After every blocking wait, a writer reads the clock again and
    // rejects an expired lease or a changed connection before any committed change. A holder takes
    // the named rows, the caller waits on them, and `during` lets time pass or changes a row in the
    // holder transaction before the holder ends.
    const syncWait = async ({
      rows,
      sql,
      values,
      prepare = null,
      during = null,
      commit = false,
    }) => {
      const holder = await connect('cc-migrator', 'cc-app');
      const caller = await connect('cc-app', 'cc-app');
      let pending = null;
      try {
        if (prepare) await prepare(caller);
        await holder.query('BEGIN');
        for (const [text, args] of rows) await holder.query(text, args);
        const holderPid = await pidOf(holder);
        const callerPid = await pidOf(caller);
        pending = caller.query(sql, values).then(
          (queried) => ({ rows: queried.rows }),
          (error) => ({
            code: error.code,
            detail: error.detail,
            message: error.message,
          }),
        );
        assert.equal(
          await waitsFor(callerPid, holderPid),
          true,
          'The call waits on the held row.',
        );
        if (during) await during(holder);
        const releasedAt = (
          await holder.query('SELECT clock_timestamp() AS at')
        ).rows[0].at;
        await holder.query(commit ? 'COMMIT' : 'ROLLBACK');
        return { answer: await pending, releasedAt };
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        if (pending) await pending;
        await Promise.allSettled([holder.end(), caller.end()]);
      }
    };
    const stateSnapshot = () =>
      adminRow('SELECT * FROM cc.device_sync_state WHERE customer_id=$1', [
        customer,
      ]);
    const heldSyncState = () => [
      'SELECT 1 FROM cc.device_sync_state WHERE customer_id=$1 FOR UPDATE',
      [customer],
    ];
    const heldConnection = () => [
      'SELECT 1 FROM cc.google_connection WHERE customer_id=$1 FOR UPDATE',
      [customer],
    ];
    const heldDevice = (deviceId) => [
      'SELECT 1 FROM cc.devices WHERE customer_id=$1 AND device_id=$2 FOR UPDATE',
      [customer, deviceId],
    ];
    const disableConnection = (holder) =>
      holder.query(
        'UPDATE cc.google_connection SET active=false WHERE customer_id=$1',
        [customer],
      );
    const restoreConnection = () =>
      migrator.query('UPDATE cc.google_connection SET active=true');
    const shortSyncLease = () =>
      migrator.query(
        "UPDATE cc.device_sync_state SET sync_expires_at=clock_timestamp()+interval '1200 milliseconds' WHERE customer_id=$1",
        [customer],
      );
    const syncLeaseLapses = async () =>
      assert.equal(
        await until(
          'SELECT clock_timestamp()>sync_expires_at AS lapsed FROM cc.device_sync_state WHERE customer_id=$1',
          [customer],
        ),
        true,
        'The sync lease lapses in the wait.',
      );
    const requestSql =
      'SELECT cc.request_device_sync($1,$2,$3,$4,$5,$6) AS result';
    const createSql =
      'SELECT cc.create_entity_sync_job($1,1,$2,$3,$4,$5,$6,$7) AS result';
    const purgeSql = 'SELECT cc.purge_jobs($1,$2) AS result';
    // Every running full-sync header ends first, so only the schedule of a check decides its waits.
    const closeRunningSyncs = async () => {
      await migrator.query(
        `UPDATE cc.jobs SET status='failed',finished_at=COALESCE(finished_at,clock_timestamp())
          WHERE customer_id=$1 AND kind='inventory-refresh' AND scope_kind='all-devices'
            AND status='running'`,
        [customer],
      );
      await resetSync();
    };

    // R1-F1 (P1): the purge publishes an interrupted ID-list refresh, and that publication takes a
    // key-share lock on the connection row. A full-sync claim holds the sync state while it waits for
    // its header, and it then takes the connection row FOR UPDATE. At f002b94 the purge requested the
    // sync state after its publication, so the two calls deadlocked (40P01). The purge now takes the
    // sync state before any header lock or publication, so it waits for the claim instead.
    const purgeAgainstClaim = async (prepare) => {
      await closeRunningSyncs();
      const interrupted = await makeRefresh(['r1f1-closed'], 1);
      await migrator.query(
        "UPDATE cc.jobs SET created_at=clock_timestamp()-interval '3 hours' WHERE job_id=$1",
        [interrupted],
      );
      const prepared = await prepare();
      const sync = await requestAs(reader);
      const holder = await connect('cc-migrator', 'cc-app');
      const claimant = await connect('cc-app', 'cc-app');
      const purger = await connect('cc-app', 'cc-app');
      // The claim answer carries a credential envelope. Only its outcome enters the result.
      const outcomeOf = (promise) =>
        promise.then(
          () => ({ accepted: true }),
          (error) => ({
            accepted: false,
            code: error.code,
            message: error.message,
          }),
        );
      let claimRun = null;
      let purgeRun = null;
      try {
        const holderPid = await pidOf(holder);
        const claimPid = await pidOf(claimant);
        const purgePid = await pidOf(purger);
        await holder.query('BEGIN');
        await holder.query('SELECT 1 FROM cc.jobs WHERE job_id=$1 FOR UPDATE', [
          sync.id,
        ]);
        claimRun = outcomeOf(
          claimant.query('SELECT cc.claim_device_sync($1,$2,$3) AS result', [
            customer,
            sync.id,
            randomUUID(),
          ]),
        );
        assert.equal(
          await waitsFor(claimPid, holderPid),
          true,
          'The claim holds the sync state and waits for its header.',
        );
        purgeRun = outcomeOf(purger.query(purgeSql, [customer, 100]));
        assert.equal(
          await waitsFor(purgePid, claimPid),
          true,
          'The purge waits for the sync state that the claim holds.',
        );
        await holder.query('COMMIT');
        const [claimed, purged] = await Promise.all([claimRun, purgeRun]);
        assert.notEqual(
          claimed.code,
          '40P01',
          'The claim must not deadlock against the purge.',
        );
        assert.notEqual(
          purged.code,
          '40P01',
          'The purge must not deadlock against the claim.',
        );
        assert.equal(claimed.accepted, true, claimed.message);
        assert.equal(purged.accepted, true, purged.message);
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        if (claimRun) await claimRun;
        if (purgeRun) await purgeRun;
        await Promise.allSettled([holder.end(), claimant.end(), purger.end()]);
      }
      const closed = await jobRow(interrupted);
      assert.equal(closed.status, 'failed');
      assert.equal(closed.failure, 'interrupted');
      await resetSync();
      return prepared;
    };

    await ruleCheck(
      'R1-F1 a purge that closes and deletes refresh jobs does not deadlock a full-sync claim',
      async () => {
        const retained = await purgeAgainstClaim(async () => {
          const old = await makeRefresh(['r1f1-old'], 1);
          await result(
            'SELECT cc.finish_entity_sync_batch($1,$2,$3,$4) AS result',
            [customer, old, 0, null],
          );
          await migrator.query(
            "UPDATE cc.jobs SET finished_at=clock_timestamp()-interval '8 days' WHERE job_id=$1",
            [old],
          );
          return old;
        });
        assert.equal(
          await jobRow(retained),
          undefined,
          'Retention still deletes the old refresh job.',
        );
      },
    );

    await ruleCheck(
      'R1-F1 a purge that closes a refresh job and an unnamed full sync does not deadlock a full-sync claim',
      async () => {
        const orphan = await purgeAgainstClaim(async () => {
          // A running full-sync header that the sync state no longer names.
          const unnamed = await requestAs(reader);
          await resetSync();
          return unnamed.id;
        });
        const closed = await jobRow(orphan);
        assert.equal(closed.status, 'failed');
        assert.equal(closed.failure, 'interrupted');
      },
    );

    // R1-F2: a replacement request locks the customer-scoped header of the sync it replaces and
    // rejects a missing header at once. Retention keeps the header that the sync state still names,
    // so only a direct deletion leaves such a pointer, and a normal expired sync stays replaceable.
    await ruleCheck(
      'R1-F2 a replacement request rejects a sync pointer whose scoped header is missing',
      async () => {
        await closeRunningSyncs();
        const sync = await requestAs(reader);
        await migrator.query(
          "UPDATE cc.device_sync_state SET sync_expires_at=clock_timestamp()-interval '1 second' WHERE customer_id=$1",
          [customer],
        );
        await migrator.query('DELETE FROM cc.jobs WHERE job_id=$1', [sync.id]);
        const before = await stateSnapshot();
        const replacement = randomUUID();
        await rejects(
          result(requestSql, [
            reader,
            1,
            customer,
            generation,
            replacement,
            randomUUID(),
          ]),
          null,
          'device-sync-changed',
        );
        assert.deepEqual(await stateSnapshot(), before);
        assert.equal(await jobRow(replacement), undefined);
        await resetSync();
      },
    );

    await ruleCheck(
      'R1-F2 retention keeps the full-sync header that the sync state names, and a replacement request succeeds',
      async () => {
        await closeRunningSyncs();
        const sync = await requestAs(reader);
        await migrator.query(
          "UPDATE cc.device_sync_state SET sync_expires_at=clock_timestamp()-interval '1 second' WHERE customer_id=$1",
          [customer],
        );
        await result(purgeSql, [customer, 100]);
        const closed = await jobRow(sync.id);
        assert.equal(closed.status, 'failed');
        assert.equal(closed.failure, 'interrupted');
        assert.equal(
          (await syncStateRow()).sync_id,
          sync.id,
          'The closure keeps the expired state pointer.',
        );
        await migrator.query(
          "UPDATE cc.jobs SET finished_at=clock_timestamp()-interval '8 days' WHERE job_id=$1",
          [sync.id],
        );
        await result(purgeSql, [customer, 100]);
        assert.ok(
          await jobRow(sync.id),
          'Retention keeps the header that the sync state still names.',
        );
        const replacement = await requestAs(reader);
        assert.equal(replacement.state.status, 'running');
        assert.equal((await syncStateRow()).sync_id, replacement.id);
        await result(purgeSql, [customer, 100]);
        assert.equal(
          await jobRow(sync.id),
          undefined,
          'Retention deletes the old header once the state names its replacement.',
        );
        await closeRunningSyncs();
      },
    );

    for (const [label, held] of [
      ['sync-state', heldSyncState],
      ['connection', heldConnection],
    ])
      await ruleCheck(
        `R1-F2 a request revalidates a connection disabled in its ${label} wait`,
        async () => {
          await closeRunningSyncs();
          const id = randomUUID();
          let observed;
          try {
            observed = await syncWait({
              rows: [held()],
              sql: requestSql,
              values: [reader, 1, customer, generation, id, randomUUID()],
              during: disableConnection,
              commit: true,
            });
          } finally {
            await restoreConnection();
          }
          assert.equal(
            observed.answer.detail,
            'connection-changed',
            `A request must revalidate the connection after its ${label} wait: ${observed.answer.message ?? 'accepted'}`,
          );
          assert.equal(await jobRow(id), undefined);
          assert.equal((await syncStateRow()).sync_id, null);
        },
      );

    await ruleCheck(
      'S1 a request that waits on the connection row stamps its sync after the wait',
      async () => {
        await closeRunningSyncs();
        const id = randomUUID();
        const { answer, releasedAt } = await syncWait({
          rows: [heldConnection()],
          sql: requestSql,
          values: [reader, 1, customer, generation, id, randomUUID()],
          during: () => sleep(200),
        });
        assert.equal(answer.code, undefined, answer.message);
        const header = await jobRow(id);
        assert.ok(
          header.started_at >= releasedAt,
          'The request stamps started_at after the wait.',
        );
        assert.ok(
          (await stateSnapshot()).sync_started_at >= releasedAt,
          'The request stamps the sync state after the wait.',
        );
        await closeRunningSyncs();
      },
    );

    // The credential functions take the advisory lock, then the principal row of their actor FOR UPDATE,
    // and then the connection row FOR UPDATE (007 cc.google_connection_actor, 011
    // cc.google_bound_generation). A writer that references a principal row takes it before the
    // connection row, so it never holds the connection row while it waits for that principal. At
    // f002b94 the header insert of a request and of a refresh job checked its customer key first.
    const againstCredentialAction = async ({ actor, sql, values }) => {
      const action = await connect('cc-migrator', 'cc-app');
      const caller = await connect('cc-app', 'cc-app');
      let pending = null;
      try {
        await action.query('BEGIN');
        await action.query('SELECT pg_advisory_xact_lock(7240173008)');
        await action.query(
          'SELECT 1 FROM cc.application_principals WHERE id=$1 FOR UPDATE',
          [actor],
        );
        const actionPid = await pidOf(action);
        const callerPid = await pidOf(caller);
        pending = caller.query(sql, values).then(
          () => ({ accepted: true }),
          (error) => ({
            accepted: false,
            code: error.code,
            message: error.message,
          }),
        );
        assert.equal(
          await waitsFor(callerPid, actionPid),
          true,
          'The call waits for the principal row of its actor.',
        );
        const locked = await action
          .query(
            'SELECT 1 FROM cc.google_connection WHERE customer_id=$1 FOR UPDATE',
            [customer],
          )
          .then(
            () => ({ accepted: true }),
            (error) => ({
              accepted: false,
              code: error.code,
              message: error.message,
            }),
          );
        await action.query(locked.accepted ? 'COMMIT' : 'ROLLBACK');
        const answer = await pending;
        assert.notEqual(
          answer.code,
          '40P01',
          'The call must not deadlock against a credential action.',
        );
        assert.notEqual(
          locked.code,
          '40P01',
          'A credential action must not deadlock against the call.',
        );
        assert.equal(answer.accepted, true, answer.message);
        assert.equal(locked.accepted, true, locked.message);
      } finally {
        await action.query('ROLLBACK').catch(() => undefined);
        if (pending) await pending;
        await Promise.allSettled([action.end(), caller.end()]);
      }
    };

    await ruleCheck(
      'S1 a request takes its principal rows before the connection row',
      async () => {
        await closeRunningSyncs();
        await againstCredentialAction({
          actor: reader,
          sql: requestSql,
          values: [reader, 1, customer, generation, randomUUID(), randomUUID()],
        });
        await closeRunningSyncs();
      },
    );

    // The first request of a customer creates its sync state row. The customer key of that row takes the
    // connection KEY SHARE lock, so the requester principal row must lock before the state insert.
    await ruleCheck(
      'S1 a first request takes its principal row before its state insert locks the connection row',
      async () => {
        await closeRunningSyncs();
        const kept = (
          await adminRow(
            'SELECT to_jsonb(s) AS row FROM cc.device_sync_state s WHERE customer_id=$1',
            [customer],
          )
        ).row;
        await migrator.query(
          'DELETE FROM cc.device_sync_state WHERE customer_id=$1',
          [customer],
        );
        try {
          await againstCredentialAction({
            actor: reader,
            sql: requestSql,
            values: [
              reader,
              1,
              customer,
              generation,
              randomUUID(),
              randomUUID(),
            ],
          });
        } finally {
          await migrator.query(
            'INSERT INTO cc.device_sync_state(customer_id) VALUES($1) ON CONFLICT(customer_id) DO NOTHING',
            [customer],
          );
          await closeRunningSyncs();
          // The version trigger keeps every version on an update. Only an insert restores
          // a stored version, so the fixture replaces the row instead of updating it.
          await migrator.query(
            'DELETE FROM cc.device_sync_state WHERE customer_id=$1',
            [customer],
          );
          await migrator.query(
            'INSERT INTO cc.device_sync_state SELECT * FROM jsonb_populate_record(NULL::cc.device_sync_state,$1::jsonb)',
            [JSON.stringify(kept)],
          );
        }
        assert.deepEqual(
          (
            await adminRow(
              'SELECT to_jsonb(s) AS row FROM cc.device_sync_state s WHERE customer_id=$1',
              [customer],
            )
          ).row,
          kept,
          'The check restores the sync state row.',
        );
      },
    );

    await ruleCheck(
      'S1 a refresh job creation takes its principal row before the connection row',
      async () => {
        await againstCredentialAction({
          actor: reader,
          sql: createSql,
          values: [
            reader,
            customer,
            'device',
            JSON.stringify(['r2p-a']),
            1,
            randomUUID(),
            randomUUID(),
          ],
        });
      },
    );

    // Controls: the two writers that record a failure requester and publish keep the principal row
    // before the connection row on both revisions.
    await ruleCheck(
      'S1 control: a failed full-sync finish takes its principal row before the connection row',
      async () => {
        const sync = await makeSync();
        await againstCredentialAction({
          actor: reader,
          sql: 'SELECT cc.finish_device_sync($1,$2,$3,$4,$5) AS result',
          values: [customer, sync.id, sync.attempt, 'quota', null],
        });
        assert.equal((await jobRow(sync.id)).status, 'failed');
        await resetSync();
      },
    );

    await ruleCheck(
      'S1 control: an abandoned full sync takes its principal row before the connection row',
      async () => {
        await closeRunningSyncs();
        const sync = await requestAs(reader);
        await againstCredentialAction({
          actor: reader,
          sql: 'SELECT cc.abandon_device_sync($1,$2,$3,$4,$5) AS result',
          values: [reader, 1, customer, sync.id, 'orchestration-unavailable'],
        });
        assert.equal((await jobRow(sync.id)).status, 'failed');
        await resetSync();
      },
    );

    // R1-F3: the generation helper of a claim waits on the advisory lock and on the connection row.
    // After those waits the claim reads the clock again and rejects the lease that lapsed in them.
    for (const [label, held] of [
      ['connection', heldConnection],
      ['advisory', () => ['SELECT pg_advisory_xact_lock(7240173008)', []]],
    ])
      await ruleCheck(
        `R1-F3 a sync claim rejects a lease that lapses in its ${label} wait`,
        async () => {
          await closeRunningSyncs();
          const sync = await requestAs(reader);
          await shortSyncLease();
          const before = await stateSnapshot();
          const { answer } = await syncWait({
            rows: [held()],
            sql: 'SELECT cc.claim_device_sync($1,$2,$3) AS result',
            values: [customer, sync.id, randomUUID()],
            during: syncLeaseLapses,
          });
          assert.equal(
            answer.detail,
            'device-sync-changed',
            `A claim whose lease lapsed in its ${label} wait must reject: ${answer.message ?? 'accepted'}`,
          );
          assert.equal(
            answer.rows,
            undefined,
            'A rejected claim returns no credential envelope.',
          );
          assert.deepEqual(await stateSnapshot(), before);
          await resetSync();
        },
      );

    // R1-F4 and R1-F5: the staging lease helper renews the lease for ten minutes before a page waits
    // on its device rows. A test trigger caps that renewal at 1.2 seconds for the one session that sets
    // cc.test_short_lease, so the lease lapses within a short device wait. The trigger leaves with the
    // check. The round-1 review measured the same order with the real ten-minute lease.
    const withShortStagingLease = async (body, milliseconds = 1200) => {
      await migrator.query(`CREATE FUNCTION cc.test_short_sync_lease() RETURNS trigger
        LANGUAGE plpgsql AS $f$
        BEGIN
          IF current_setting('cc.test_short_lease',true)='on' AND NEW.sync_expires_at IS NOT NULL THEN
            NEW.sync_expires_at:=LEAST(NEW.sync_expires_at,clock_timestamp()+interval '${milliseconds} milliseconds');
          END IF;
          RETURN NEW;
        END
        $f$`);
      try {
        await migrator.query(`CREATE TRIGGER test_short_sync_lease BEFORE UPDATE ON cc.device_sync_state
          FOR EACH ROW EXECUTE FUNCTION cc.test_short_sync_lease()`);
        return await body();
      } finally {
        await migrator.query(
          'DROP TRIGGER IF EXISTS test_short_sync_lease ON cc.device_sync_state',
        );
        await migrator.query(
          'DROP FUNCTION IF EXISTS cc.test_short_sync_lease()',
        );
      }
    };
    const shortLeaseSession = (caller) =>
      caller.query("SET cc.test_short_lease='on'");

    await ruleCheck(
      'R1-F4 a staged device page rejects a lease that lapses in its device wait',
      async () => {
        await closeRunningSyncs();
        await upsert(
          [device('r1f4-a', { annotatedLocation: 'Before' })],
          new Date(Date.now() - 60 * 60 * 1000),
        );
        const sync = await makeSync();
        const snapshot = async () => ({
          state: await stateSnapshot(),
          header: await jobRow(sync.id),
          published: await publications(sync.id),
          device: await adminRow(
            'SELECT * FROM cc.devices WHERE customer_id=$1 AND device_id=$2',
            [customer, 'r1f4-a'],
          ),
          targets: await admin('SELECT * FROM cc.job_targets WHERE job_id=$1', [
            sync.id,
          ]),
        });
        const before = await snapshot();
        const { answer } = await withShortStagingLease(() =>
          syncWait({
            rows: [heldDevice('r1f4-a')],
            prepare: shortLeaseSession,
            sql: 'SELECT cc.stage_devices($1,$2,$3,$4) AS result',
            values: [
              customer,
              sync.id,
              sync.attempt,
              JSON.stringify([
                device('r1f4-a', { annotatedLocation: 'After' }),
              ]),
            ],
            during: () => sleep(1600),
          }),
        );
        assert.equal(
          answer.detail,
          'device-sync-changed',
          `A page whose lease lapsed in its device wait must reject: ${answer.message ?? 'accepted'}`,
        );
        assert.deepEqual(
          await snapshot(),
          before,
          'An expired page changes no target, device, state, revision, or publication.',
        );
        await resetSync();
      },
    );

    await ruleCheck(
      'R1-F5 a staged battery page rejects a lease that lapses in its device wait',
      async () => {
        await closeRunningSyncs();
        await upsert([device('r1f5-a')], new Date(Date.now() - 60 * 60 * 1000));
        const sync = await makeSync();
        const page = (capacity) =>
          JSON.stringify([
            {
              deviceId: 'r1f5-a',
              battery: {
                status: 'reported',
                health: 'normal',
                capacityPercent: capacity,
                reportedAt: '2026-10-17T12:00:00.000Z',
              },
              reports: [],
            },
          ]);
        await result(
          'SELECT cc.stage_device_batteries($1,$2,$3,$4) AS result',
          [customer, sync.id, sync.attempt, page(90)],
        );
        const snapshot = async () => ({
          state: await stateSnapshot(),
          device: await adminRow(
            'SELECT * FROM cc.devices WHERE customer_id=$1 AND device_id=$2',
            [customer, 'r1f5-a'],
          ),
        });
        const before = await snapshot();
        assert.equal(before.device.battery_capacity_percent, 90);
        const { answer } = await withShortStagingLease(() =>
          syncWait({
            rows: [heldDevice('r1f5-a')],
            prepare: shortLeaseSession,
            sql: 'SELECT cc.stage_device_batteries($1,$2,$3,$4) AS result',
            values: [customer, sync.id, sync.attempt, page(77)],
            during: () => sleep(1600),
          }),
        );
        assert.equal(
          answer.detail,
          'device-sync-changed',
          `A battery page whose lease lapsed in its device wait must reject: ${answer.message ?? 'accepted'}`,
        );
        assert.deepEqual(
          await snapshot(),
          before,
          'An expired battery page changes no battery and no lease.',
        );
        await resetSync();
      },
    );

    // R1-F6: a failed finish reads no generation, so its publication insert waited on the connection
    // row after its last lease fence. It now locks that row before its last clock read.
    await ruleCheck(
      'R1-F6 a failed full-sync finish rejects a lease that lapses in its connection wait',
      async () => {
        await closeRunningSyncs();
        const sync = await makeSync();
        await shortSyncLease();
        const before = {
          state: await stateSnapshot(),
          header: await jobRow(sync.id),
          published: await publications(sync.id),
        };
        const { answer } = await syncWait({
          rows: [heldConnection()],
          sql: 'SELECT cc.finish_device_sync($1,$2,$3,$4,$5) AS result',
          values: [customer, sync.id, sync.attempt, 'quota', null],
          during: syncLeaseLapses,
        });
        assert.equal(
          answer.detail,
          'device-sync-changed',
          `A failed finish whose lease lapsed in its connection wait must reject: ${answer.message ?? 'accepted'}`,
        );
        assert.deepEqual(
          {
            state: await stateSnapshot(),
            header: await jobRow(sync.id),
            published: await publications(sync.id),
          },
          before,
          'A rejected failed finish changes no state, status, revision, or publication.',
        );
        await resetSync();
      },
    );

    // The class of R1-F2 and R1-F6 in the other writers of this card: a refresh job creation
    // revalidates the connection after its connection wait, and every publishing writer stamps its
    // writes after that wait.
    await ruleCheck(
      'S1 a refresh job creation revalidates a connection disabled in its connection wait',
      async () => {
        const job = randomUUID();
        let observed;
        try {
          observed = await syncWait({
            rows: [heldConnection()],
            sql: createSql,
            values: [
              reader,
              customer,
              'device',
              JSON.stringify(['r2c-a']),
              1,
              job,
              randomUUID(),
            ],
            during: disableConnection,
            commit: true,
          });
        } finally {
          await restoreConnection();
        }
        assert.equal(
          observed.answer.detail,
          'connection-changed',
          `A refresh job creation must revalidate the connection after its wait: ${observed.answer.message ?? 'accepted'}`,
        );
        assert.equal(await jobRow(job), undefined);
      },
    );

    await ruleCheck(
      'S1 a refresh batch that waits on the connection row stamps its writes after the wait',
      async () => {
        const refresh = await makeRefresh(['r2c-b'], 1);
        const { answer, releasedAt } = await syncWait({
          rows: [heldConnection()],
          sql: 'SELECT cc.finish_entity_sync_batch($1,$2,$3,$4) AS result',
          values: [customer, refresh, 0, null],
          during: () => sleep(200),
        });
        assert.equal(answer.code, undefined, answer.message);
        const header = await jobRow(refresh);
        assert.equal(header.status, 'completed');
        assert.ok(
          header.finished_at >= releasedAt,
          'The batch stamps finished_at after the wait.',
        );
      },
    );

    await ruleCheck(
      'S1 an abandoned refresh that waits on the connection row stamps its writes after the wait',
      async () => {
        const refresh = await makeRefresh(['r2c-c'], 1);
        const { answer, releasedAt } = await syncWait({
          rows: [heldConnection()],
          sql: 'SELECT cc.abandon_entity_sync_job($1,$2,$3,$4) AS result',
          values: [reader, 1, customer, refresh],
          during: () => sleep(200),
        });
        assert.equal(answer.code, undefined, answer.message);
        const header = await jobRow(refresh);
        assert.equal(header.status, 'failed');
        assert.ok(
          header.finished_at >= releasedAt,
          'The abandonment stamps finished_at after the wait.',
        );
      },
    );

    await ruleCheck(
      'S1 an abandoned full sync that waits on the connection row stamps its writes after the wait',
      async () => {
        await closeRunningSyncs();
        const sync = await requestAs(reader);
        const { answer, releasedAt } = await syncWait({
          rows: [heldConnection()],
          sql: 'SELECT cc.abandon_device_sync($1,$2,$3,$4,$5) AS result',
          values: [reader, 1, customer, sync.id, 'orchestration-unavailable'],
          during: () => sleep(200),
        });
        assert.equal(answer.code, undefined, answer.message);
        const header = await jobRow(sync.id);
        assert.equal(header.status, 'failed');
        assert.ok(
          header.finished_at >= releasedAt,
          'The abandonment stamps finished_at after the wait.',
        );
        assert.ok(
          (await stateSnapshot()).checked_at >= releasedAt,
          'The abandonment stamps the sync state after the wait.',
        );
        await resetSync();
      },
    );

    await ruleCheck(
      'S1 a purge that waits on the connection row stamps its closures after the wait',
      async () => {
        await closeRunningSyncs();
        const refresh = await makeRefresh(['r2c-d'], 1);
        await migrator.query(
          "UPDATE cc.jobs SET created_at=clock_timestamp()-interval '3 hours' WHERE job_id=$1",
          [refresh],
        );
        const unnamed = await requestAs(reader);
        await resetSync();
        const { answer, releasedAt } = await syncWait({
          rows: [heldConnection()],
          sql: purgeSql,
          values: [customer, 100],
          during: () => sleep(200),
        });
        assert.equal(answer.code, undefined, answer.message);
        for (const jobId of [refresh, unnamed.id]) {
          const closed = await jobRow(jobId);
          assert.equal(closed.failure, 'interrupted');
          assert.ok(
            closed.finished_at >= releasedAt,
            'The purge stamps finished_at after the wait.',
          );
        }
      },
    );

    // Section 5.8: every function that changes an overlay locks its device row first. The purge
    // deletes expired overlays, so it locks their device rows in device_id order before the deletion.
    await ruleCheck(
      'S1 the purge locks the device row of an expired overlay before it deletes the overlay',
      async () => {
        await upsert([device('r2o-a')], new Date());
        const job = await makeJob({ devices: ['r2o-a'] });
        await finalize(job.jobId);
        await admin(
          `INSERT INTO cc.device_write_overlays(customer_id,device_id,field,value,observed_at,source,job_id,expires_at)
            VALUES($1,'r2o-a','annotatedLocation','Room 12',clock_timestamp()-interval '40 hours','write-response',$2,
              clock_timestamp()-interval '1 hour')`,
          [customer, job.jobId],
        );
        const holder = await connect('cc-migrator', 'cc-app');
        const purge = await connect('cc-app', 'cc-app');
        try {
          await holder.query('BEGIN');
          await holder.query(...heldDevice('r2o-a'));
          await purge.query("SET lock_timeout='300ms'");
          const answer = await purge.query(purgeSql, [customer, 100]).then(
            () => ({ accepted: true }),
            (error) => ({ code: error.code }),
          );
          assert.equal(
            answer.code,
            '55P03',
            'The purge must lock the device row before it deletes its overlay.',
          );
        } finally {
          await holder.query('ROLLBACK').catch(() => undefined);
          await Promise.allSettled([holder.end(), purge.end()]);
        }
        assert.ok(
          await overlay('r2o-a'),
          'The overlay stays while its device row is held.',
        );
        await result(purgeSql, [customer, 100]);
        assert.equal(await overlay('r2o-a'), undefined);
      },
    );

    await ruleCheck('S2 the purge rejects a null customer', async () => {
      await rejects(result(purgeSql, [null, 100]), '22023');
    });

    await ruleCheck(
      'S1 the write-job finalizer rejects a full-sync header',
      async () => {
        const sync = await makeSync();
        const before = await jobRow(sync.id);
        await rejects(finalize(sync.id), '22023');
        assert.deepEqual(await jobRow(sync.id), before);
        await resetSync();
      },
    );

    // Round 3 of B2b. Rule G: advisory lock 7240173008 is the global access lock. Every function that
    // can reach it takes it first, before any row lock and before any other advisory lock. A full-sync
    // claim, a full-sync finish, and a device-update batch claim reach it through
    // cc.google_current_generation. At 6fc3b04 each of them took its row locks first and held them while
    // it waited for the global lock. Each check below holds the global lock, lets the call wait for it,
    // and then proves with NOWAIT locks that the named rows stay free during that wait.
    const outcomeOf = (promise) =>
      promise.then(
        () => ({ accepted: true }),
        (error) => ({
          accepted: false,
          code: error.code,
          detail: error.detail,
          message: error.message,
        }),
      );
    const waitsForAny = async (blockedPid, holderPids) => {
      for (let round = 0; round < 200; round += 1) {
        const state = await adminRow(
          'SELECT pg_blocking_pids($1::int) && $2::int[] AS held',
          [blockedPid, holderPids],
        );
        if (state?.held === true) return true;
        await sleep(25);
      }
      return false;
    };
    const globalLockFirst = async ({ name, sql, values, free }) => {
      const holder = await connect('cc-migrator', 'cc-app');
      const caller = await connect('cc-app', 'cc-app');
      const observer = await connect('cc-migrator', 'cc-app');
      let pending = null;
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT pg_advisory_xact_lock(7240173008)');
        const holderPid = await pidOf(holder);
        const callerPid = await pidOf(caller);
        // The answer of a claim carries a credential envelope. Only its outcome enters the result.
        pending = outcomeOf(caller.query(sql, values));
        assert.equal(
          await waitsFor(callerPid, holderPid),
          true,
          `${name} waits for the global access lock.`,
        );
        for (const [label, text, args] of free) {
          const locked = await observer.query(text, args).then(
            () => true,
            (error) => error.code,
          );
          assert.equal(
            locked,
            true,
            `${name} holds no ${label} row while it waits for the global access lock.`,
          );
        }
        await holder.query('COMMIT');
        const answer = await pending;
        assert.equal(answer.accepted, true, answer.message);
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        if (pending) await pending;
        await Promise.allSettled([holder.end(), caller.end(), observer.end()]);
      }
    };
    const freeSyncState = () => [
      'sync-state',
      'SELECT 1 FROM cc.device_sync_state WHERE customer_id=$1 FOR UPDATE NOWAIT',
      [customer],
    ];
    const freeHeader = (jobId) => [
      'job header',
      'SELECT 1 FROM cc.jobs WHERE job_id=$1 FOR UPDATE NOWAIT',
      [jobId],
    ];

    await ruleCheck(
      'G a full-sync claim takes the global access lock before any row lock',
      async () => {
        await closeRunningSyncs();
        const sync = await requestAs(reader);
        await globalLockFirst({
          name: 'A full-sync claim',
          sql: 'SELECT cc.claim_device_sync($1,$2,$3) AS result',
          values: [customer, sync.id, randomUUID()],
          free: [freeSyncState(), freeHeader(sync.id)],
        });
        assert.ok(
          (await syncStateRow()).sync_attempt,
          'The claim records its attempt.',
        );
        await closeRunningSyncs();
      },
    );

    for (const [label, failure] of [
      ['successful', null],
      ['failed', 'quota'],
    ])
      await ruleCheck(
        `G a ${label} full-sync finish takes the global access lock before any row lock`,
        async () => {
          await closeRunningSyncs();
          await upsert(
            [device(`g-finish-${label}`)],
            new Date(Date.now() - 60 * 60 * 1000),
          );
          const sync = await makeSync();
          await globalLockFirst({
            name: `A ${label} full-sync finish`,
            sql: 'SELECT cc.finish_device_sync($1,$2,$3,$4,$5) AS result',
            values: [customer, sync.id, sync.attempt, failure, null],
            free: [
              freeSyncState(),
              freeHeader(sync.id),
              [
                'device',
                'SELECT 1 FROM cc.devices WHERE customer_id=$1 AND device_id=$2 FOR UPDATE NOWAIT',
                [customer, `g-finish-${label}`],
              ],
            ],
          });
          assert.equal(
            (await jobRow(sync.id)).status,
            failure === null ? 'completed' : 'failed',
          );
          await closeRunningSyncs();
        },
      );

    await ruleCheck(
      'G a device-update batch claim takes the global access lock before any row lock',
      async () => {
        const job = await makeJob({ devices: ['g-claim-a'] });
        const admitted = await admit(false);
        assert.equal(
          admitted.jobId,
          job.jobId,
          'The admission picks this job.',
        );
        await globalLockFirst({
          name: 'A batch claim',
          sql: 'SELECT cc.claim_device_update_batch($1,$2,$3,$4,$5,$6) AS result',
          values: [
            customer,
            job.jobId,
            admitted.dispatchToken,
            0,
            randomUUID(),
            'g-claim',
          ],
          free: [
            freeHeader(job.jobId),
            [
              'detail',
              'SELECT 1 FROM cc.device_update_jobs WHERE job_id=$1 FOR UPDATE NOWAIT',
              [job.jobId],
            ],
            [
              'operation',
              'SELECT 1 FROM cc.device_update_operations WHERE job_id=$1 FOR UPDATE NOWAIT',
              [job.jobId],
            ],
          ],
        });
        assert.equal(
          (await operations(job.jobId))[0].status,
          'dispatched',
          'The claim dispatches its operation after the wait.',
        );
        await endJob(job.jobId);
      },
    );

    // R2-F1 (P1): a duplicate request takes its requester principal FOR KEY SHARE before it waits for the
    // sync state (the first-request protection of 6fc3b04). A full-sync writer holds that state while it
    // waits for its header. A Google observation of the same actor takes the global access lock, then
    // that principal FOR UPDATE (007 cc.google_connection_actor). At 6fc3b04 the full-sync writer asked
    // for the global lock only after its header wait, so the three calls formed a principal, state, and
    // global-lock cycle (40P01). Under rule G the full-sync writer holds the global lock before its state
    // row, so the observation waits for that writer, and every call ends with its defined answer. The
    // three calls run as the function owner and as the runtime role. The held header only schedules them.
    const diagnostician = await principal(`${randomUUID()}`, [
      ['devices:read', district()],
      ['connection:diagnose', district()],
    ]);
    const threeWriters = async ({ role, writer }) => {
      await closeRunningSyncs();
      const sync = randomUUID();
      const attempt = randomUUID();
      await result(requestSql, [
        diagnostician,
        1,
        customer,
        generation,
        sync,
        randomUUID(),
      ]);
      if (writer === 'finish') await claimSync(sync, attempt);
      const observation = JSON.stringify(
        (
          await adminRow(
            'SELECT observation FROM cc.google_connection WHERE customer_id=$1',
            [customer],
          )
        ).observation,
      );
      const holder = await connect('cc-migrator', 'cc-app');
      const syncWriter = await connect(role, 'cc-app');
      const requester = await connect(role, 'cc-app');
      const google = await connect(role, 'cc-app');
      const runs = [];
      try {
        const holderPid = await pidOf(holder);
        const writerPid = await pidOf(syncWriter);
        const requestPid = await pidOf(requester);
        const googlePid = await pidOf(google);
        await holder.query('BEGIN');
        await holder.query('SELECT 1 FROM cc.jobs WHERE job_id=$1 FOR UPDATE', [
          sync,
        ]);
        // The answer of a claim carries a credential envelope. Only the outcome of each call enters the result.
        runs.push(
          outcomeOf(
            writer === 'claim'
              ? syncWriter.query(
                  'SELECT cc.claim_device_sync($1,$2,$3) AS result',
                  [customer, sync, attempt],
                )
              : syncWriter.query(
                  'SELECT cc.finish_device_sync($1,$2,$3,$4,$5) AS result',
                  [customer, sync, attempt, null, null],
                ),
          ),
        );
        assert.equal(
          await waitsFor(writerPid, holderPid),
          true,
          `The ${writer} holds the sync state and waits for its header.`,
        );
        runs.push(
          outcomeOf(
            requester.query(requestSql, [
              diagnostician,
              1,
              customer,
              generation,
              randomUUID(),
              randomUUID(),
            ]),
          ),
        );
        assert.equal(
          await waitsFor(requestPid, writerPid),
          true,
          'The duplicate request holds its principal row and waits for the sync state.',
        );
        runs.push(
          outcomeOf(
            google.query(
              'SELECT cc.record_google_observation($1,$2,$3,$4,$5,$6) AS result',
              [
                customer,
                generation,
                observation,
                randomUUID(),
                diagnostician,
                1,
              ],
            ),
          ),
        );
        assert.equal(
          await waitsForAny(googlePid, [requestPid, writerPid]),
          true,
          'The observation waits for the requester principal or for the global access lock.',
        );
        await holder.query('COMMIT');
        const [written, requested, observed] = await Promise.all(runs);
        // Each call catches its own error in outcomeOf, so a deadlock reaches this assertion as code 40P01.
        const codes = {
          [writer]: written.code ?? null,
          request: requested.code ?? null,
          observation: observed.code ?? null,
        };
        assert.equal(
          Object.values(codes).filter((code) => code === '40P01').length,
          0,
          `No call ends with 40P01 in a principal, sync-state, and global-lock cycle. Codes: ${JSON.stringify(codes)}.`,
        );
        assert.equal(written.accepted, true, written.message);
        if (writer === 'claim')
          assert.equal(
            requested.detail,
            'device-sync-running',
            `The duplicate request rejects the running sync: ${requested.message ?? 'accepted'}`,
          );
        else assert.equal(requested.accepted, true, requested.message);
        assert.equal(observed.accepted, true, observed.message);
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        await Promise.allSettled(runs);
        await Promise.allSettled([
          holder.end(),
          syncWriter.end(),
          requester.end(),
          google.end(),
        ]);
      }
      await closeRunningSyncs();
    };
    for (const [label, role] of [
      ['owner', 'cc-migrator'],
      ['runtime role', 'cc-app'],
    ]) {
      await ruleCheck(
        `B2b R2-F1 a duplicate request, a full-sync claim, and a same-actor Google observation do not deadlock (${label})`,
        () => threeWriters({ role, writer: 'claim' }),
      );
      await ruleCheck(
        `B2b R2-F1 a duplicate request, a successful full-sync finish, and a same-actor Google observation do not deadlock (${label})`,
        () => threeWriters({ role, writer: 'finish' }),
      );
    }

    // R2-F2 (P2): a battery page locks its devices and rechecks its lease, and then
    // cc.upsert_device_batteries locks the page devices again from a fresh snapshot. A device that another
    // session inserts during the first wait is visible only to that second lock, so the helper can wait on
    // it after the page fence. The lease repeats after the helper returns, so an expired page changes no
    // battery, no device, and no lease. The trigger of R1-F4 caps the renewal at two seconds here.
    for (const [label, role] of [
      ['owner', 'cc-migrator'],
      ['runtime role', 'cc-app'],
    ])
      await ruleCheck(
        `B2b R2-F2 a staged battery page rejects a lease that lapses in its helper wait on a newly visible device (${label})`,
        async () => {
          await closeRunningSyncs();
          const first = `r2f2-${role}-a`;
          const second = `r2f2-${role}-b`;
          const listedAt = new Date(Date.now() - 60 * 60 * 1000);
          await upsert([device(first)], listedAt);
          assert.equal(
            await deviceRow(second),
            undefined,
            'The second device does not exist before the page.',
          );
          const sync = await makeSync();
          const page = JSON.stringify(
            [first, second].map((deviceId) => ({
              deviceId,
              battery: {
                status: 'reported',
                health: 'normal',
                capacityPercent: 77,
                reportedAt: '2026-10-17T12:00:00.000Z',
              },
              reports: [],
            })),
          );
          const snapshot = async () => ({
            state: await stateSnapshot(),
            devices: await admin(
              'SELECT * FROM cc.devices WHERE customer_id=$1 AND device_id=ANY($2::text[]) ORDER BY device_id',
              [customer, [first, second]],
            ),
          });
          let before = null;
          const answer = await withShortStagingLease(async () => {
            const holderA = await connect('cc-migrator', 'cc-app');
            const holderB = await connect('cc-migrator', 'cc-app');
            const caller = await connect(role, 'cc-app');
            let pending = null;
            try {
              await shortLeaseSession(caller);
              const holderAPid = await pidOf(holderA);
              const holderBPid = await pidOf(holderB);
              const callerPid = await pidOf(caller);
              await holderA.query('BEGIN');
              await holderA.query(...heldDevice(first));
              pending = outcomeOf(
                caller.query(
                  'SELECT cc.stage_device_batteries($1,$2,$3,$4) AS result',
                  [customer, sync.id, sync.attempt, page],
                ),
              );
              assert.equal(
                await waitsFor(callerPid, holderAPid),
                true,
                'The page waits on the first device of its first snapshot.',
              );
              await upsert([device(second)], listedAt);
              await holderB.query('BEGIN');
              await holderB.query(...heldDevice(second));
              before = await snapshot();
              await holderA.query('ROLLBACK');
              assert.equal(
                await waitsFor(callerPid, holderBPid),
                true,
                'The helper waits on the newly visible device after the page fence.',
              );
              // The renewed lease lapses in this second wait.
              await sleep(2400);
              await holderB.query('ROLLBACK');
              return await pending;
            } finally {
              await holderA.query('ROLLBACK').catch(() => undefined);
              await holderB.query('ROLLBACK').catch(() => undefined);
              if (pending) await pending;
              await Promise.allSettled([
                holderA.end(),
                holderB.end(),
                caller.end(),
              ]);
            }
          }, 2000);
          assert.equal(
            answer.detail,
            'device-sync-changed',
            `A battery page whose lease lapsed in its helper wait must reject: ${answer.message ?? 'accepted'}`,
          );
          assert.deepEqual(
            await snapshot(),
            before,
            'An expired battery page changes no battery, no device, and no lease.',
          );
          await resetSync();
        },
      );

    // The start lock order moved in round 5, so its own contention check follows.
    await ruleCheck(
      'S1 a start that waits for the header follows the token of its revision',
      async () => {
        const job = await makeJob({ devices: ['st-a'] });
        const admitted = await admit(false);
        await migrator.query(
          "UPDATE cc.device_update_jobs SET start_deadline_at=clock_timestamp()-interval '1 second' WHERE job_id=$1",
          [job.jobId],
        );
        const holder = await connect('cc-migrator', 'cc-app');
        const caller = await connect('cc-app', 'cc-app');
        let pending = null;
        try {
          await holder.query('BEGIN');
          await headerWait(holder, job.jobId);
          const holderPid = await pidOf(holder);
          const callerPid = await pidOf(caller);
          pending = caller.query(
            'SELECT cc.record_device_update_start($1,$2,$3,$4)',
            [customer, job.jobId, admitted.dispatchToken, 'stale-execution'],
          );
          pending.catch(() => undefined);
          assert.equal(
            await waitsFor(callerPid, holderPid),
            true,
            'The start waits for the header row.',
          );
          const rotation = (
            await holder.query(
              'SELECT cc.recover_device_update_jobs($1) AS result',
              [customer],
            )
          ).rows[0].result;
          assert.ok(
            rotation.starts.some((start) => start.jobId === job.jobId),
            'The tick rotates the token inside the header lock.',
          );
          await holder.query('COMMIT');
          const outcome = await pending.then(
            () => null,
            (error) => error.detail,
          );
          assert.equal(
            outcome,
            'attempt-fenced',
            'The stale start fails on the token of the new revision.',
          );
          assert.equal((await detailRow(job.jobId)).kestra_execution_id, null);
          assert.equal(
            (await jobRow(job.jobId)).status,
            'running',
            'The refused start changes nothing and the job keeps running.',
          );
        } finally {
          await holder.query('ROLLBACK').catch(() => undefined);
          if (pending) await pending.catch(() => undefined);
          await Promise.allSettled([holder.end(), caller.end()]);
        }
        await endJob(job.jobId);
      },
    );

    // The reviewer's round-5 evidence gaps: finish against the tick and the reaper, and a
    // replacement read-back claim made by the claim function instead of a raw update.
    await ruleCheck(
      'S1 a finish that waits for the header returns superseded after the tick rotates the token',
      async () => {
        const job = await heldJob('rt-a');
        await stop(job.jobId, job.token, 0, job.attempt);
        assert.equal(
          (await prepareFinish(job.jobId, job.token)).outcome,
          'ready',
        );
        await migrator.query(
          "UPDATE cc.device_update_jobs SET heartbeat_at=clock_timestamp()-interval '20 minutes' WHERE job_id=$1",
          [job.jobId],
        );
        const before = await jobRow(job.jobId);
        const published = await publications(job.jobId);
        const holder = await connect('cc-migrator', 'cc-app');
        const caller = await connect('cc-app', 'cc-app');
        let pending = null;
        try {
          await holder.query('BEGIN');
          await headerWait(holder, job.jobId);
          const holderPid = await pidOf(holder);
          const callerPid = await pidOf(caller);
          pending = caller
            .query(
              'SELECT cc.finish_device_update_job($1,$2,$3,$4) AS result',
              [customer, job.jobId, job.token, null],
            )
            .then((rows) => rows.rows[0].result);
          pending.catch(() => undefined);
          assert.equal(
            await waitsFor(callerPid, holderPid),
            true,
            'The finish waits for the header row.',
          );
          const rotation = (
            await holder.query(
              'SELECT cc.recover_device_update_jobs($1) AS result',
              [customer],
            )
          ).rows[0].result;
          assert.ok(
            rotation.starts.some((start) => start.jobId === job.jobId),
            'The tick rotates the token inside the header lock.',
          );
          await holder.query('COMMIT');
          const response = await pending;
          assert.equal(response.outcome, 'superseded');
          const after = await jobRow(job.jobId);
          assert.equal(after.revision, before.revision);
          assert.equal(after.finished_at, null);
          assert.equal(await publications(job.jobId), published);
        } finally {
          await holder.query('ROLLBACK').catch(() => undefined);
          if (pending) await pending.catch(() => undefined);
          await Promise.allSettled([holder.end(), caller.end()]);
        }
        await endJob(job.jobId);
      },
    );

    await ruleCheck(
      'S1 a finish that waits for the header returns finished after the reaper closes the job',
      async () => {
        const job = await heldJob('rp-a');
        await stop(job.jobId, job.token, 0, job.attempt);
        assert.equal(
          (await prepareFinish(job.jobId, job.token)).outcome,
          'ready',
        );
        await expireBatches(job.jobId);
        const before = await jobRow(job.jobId);
        const published = await publications(job.jobId);
        const holder = await connect('cc-migrator', 'cc-app');
        const caller = await connect('cc-app', 'cc-app');
        let pending = null;
        try {
          await holder.query('BEGIN');
          await headerWait(holder, job.jobId);
          const holderPid = await pidOf(holder);
          const callerPid = await pidOf(caller);
          pending = caller
            .query(
              'SELECT cc.finish_device_update_job($1,$2,$3,$4) AS result',
              [customer, job.jobId, job.token, null],
            )
            .then((rows) => rows.rows[0].result);
          pending.catch(() => undefined);
          assert.equal(
            await waitsFor(callerPid, holderPid),
            true,
            'The finish waits for the header row.',
          );
          const finalized = (
            await holder.query(
              'SELECT cc.finalize_device_update_job($1,$2,$3) AS result',
              [customer, job.jobId, null],
            )
          ).rows[0].result;
          assert.equal(finalized.outcome, 'finalized');
          await holder.query('COMMIT');
          const response = await pending;
          assert.equal(response.outcome, 'finished');
          assert.equal(
            Number(
              (
                await holder.query(
                  'SELECT revision FROM cc.jobs WHERE job_id=$1',
                  [job.jobId],
                )
              ).rows[0].revision,
            ),
            Number(before.revision) + 1,
            'The reaper adds one revision and the late finish adds none.',
          );
          assert.equal(
            await publications(job.jobId),
            published + 1,
            'The reaper publishes once and the late finish publishes nothing.',
          );
        } finally {
          await holder.query('ROLLBACK').catch(() => undefined);
          if (pending) await pending.catch(() => undefined);
          await Promise.allSettled([holder.end(), caller.end()]);
        }
      },
    );

    await ruleCheck(
      'S1 the read-back claim function fences an old settlement through the header lock',
      async () => {
        await upsert([device('cv-a')], new Date(Date.now() - 60 * 60 * 1000));
        const job = await heldJob('cv-a');
        await settle(
          job.jobId,
          job.token,
          job.attempt,
          'write',
          [
            {
              operationNumber: 1,
              outcome: 'unknown',
              outcomeReason: 'open-request',
              verifiedBy: 'write-response',
            },
          ],
          new Date(),
        );
        const replacement = randomUUID();
        await migrator.query(
          "UPDATE cc.device_update_operations SET verify_lease_expires_at=clock_timestamp()-interval '1 second' WHERE job_id=$1",
          [job.jobId],
        );
        const holder = await connect('cc-migrator', 'cc-app');
        const settler = await connect('cc-app', 'cc-app');
        let settlement = null;
        try {
          await holder.query('BEGIN');
          const reserved = (
            await holder.query(
              'SELECT cc.claim_device_update_verification($1,$2,NULL,$3) AS result',
              [customer, job.jobId, replacement],
            )
          ).rows[0].result;
          assert.equal(reserved.length, 1);
          const holderPid = await pidOf(holder);
          const settlerPid = await pidOf(settler);
          settlement = settler.query(
            'SELECT cc.settle_device_update_operations($1,$2,$3,$4,$5,$6,$7) AS result',
            [
              customer,
              job.jobId,
              null,
              job.attempt,
              'read-back',
              JSON.stringify([
                {
                  operationNumber: 1,
                  outcome: 'succeeded',
                  values: { annotatedLocation: 'Room 12' },
                  verifiedBy: 'read-back',
                },
              ]),
              new Date(),
            ],
          );
          settlement.catch(() => undefined);
          assert.equal(
            await waitsFor(settlerPid, holderPid),
            true,
            'The settlement waits for the claim of the replacement attempt.',
          );
          await holder.query('COMMIT');
          const settled = (await settlement).rows[0].result;
          assert.deepEqual(settled.settled, []);
          assert.equal(settled.publication, null);
        } finally {
          await holder.query('ROLLBACK').catch(() => undefined);
          if (settlement) await settlement.catch(() => undefined);
          await Promise.allSettled([holder.end(), settler.end()]);
        }
        const row = (await operations(job.jobId))[0];
        assert.equal(row.status, 'unknown');
        assert.equal(row.verify_attempt, replacement);
        assert.equal((await deviceRow('cv-a')).annotated_location, null);
        await endJob(job.jobId);
      },
    );

    // Round 6: the superseded and ineligible calls of R6-1 to R6-7 reject under the header lock
    // before they touch a descendant row. A holder takes that row, so a call that still waits
    // returns the 55P03 lock timeout instead of its defined answer.
    const descendantHeld = async ({ rows, sql, values, expect }) => {
      const holder = await connect('cc-migrator', 'cc-app');
      const caller = await connect('cc-app', 'cc-app');
      try {
        await holder.query('BEGIN');
        for (const [text, args] of rows) await holder.query(text, args);
        await caller.query("SET lock_timeout='300ms'");
        const answer = await caller.query(sql, values).then(
          (queried) => ({ rows: queried.rows }),
          (error) => ({
            code: error.code,
            detail: error.detail,
            message: error.message,
          }),
        );
        await expect(answer);
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        await Promise.allSettled([holder.end(), caller.end()]);
      }
    };
    const heldBatchRow = (jobId) => [
      'SELECT 1 FROM cc.device_update_batches WHERE job_id=$1 AND batch=0 FOR UPDATE',
      [jobId],
    ];
    const heldDetailRow = (jobId) => [
      'SELECT 1 FROM cc.device_update_jobs WHERE job_id=$1 FOR UPDATE',
      [jobId],
    ];
    const heldOperationRow = (jobId) => [
      'SELECT 1 FROM cc.device_update_operations WHERE job_id=$1 AND operation_number=1 FOR UPDATE',
      [jobId],
    ];

    // R6-2: the claim reads the batch ownership and its lease eligibility under the header.
    await ruleCheck(
      'R6-2 the batch claim answers busy before it waits on the claimed batch',
      async () => {
        const job = await heldJob('r62-a');
        await descendantHeld({
          rows: [heldBatchRow(job.jobId)],
          sql: 'SELECT cc.claim_device_update_batch($1,$2,$3,$4,$5,$6) AS result',
          values: [
            customer,
            job.jobId,
            job.token,
            0,
            randomUUID(),
            'r62-duplicate',
          ],
          expect: (answer) => {
            assert.equal(
              answer.code,
              undefined,
              'A duplicate claim must answer under the header fence, not wait on the batch row.',
            );
            assert.equal(answer.rows[0].result.outcome, 'busy');
          },
        });
        await endJob(job.jobId);
      },
    );

    // R6-3: the renewal reads the attempt and the live lease under the header.
    await ruleCheck(
      'R6-3 the renewal rejects a wrong attempt before it waits on the batch',
      async () => {
        const job = await heldJob('r63-a');
        await descendantHeld({
          rows: [heldBatchRow(job.jobId)],
          sql: 'SELECT cc.renew_device_update_batch($1,$2,$3,$4,$5) AS result',
          values: [customer, job.jobId, job.token, 0, randomUUID()],
          expect: (answer) => {
            assert.notEqual(
              answer.code,
              '55P03',
              'A wrong-attempt renewal must not wait on the batch row.',
            );
            assert.equal(answer.detail, 'attempt-fenced');
          },
        });
        await endJob(job.jobId);
      },
    );

    // R6-1 prefix: the settlement decides eligibility under the header before any descendant lock.
    await ruleCheck(
      'R6-1 the settlement decides eligibility under the header before it waits on an operation',
      async () => {
        const job = await heldJob('r61p-a');
        await descendantHeld({
          rows: [heldOperationRow(job.jobId)],
          sql: 'SELECT cc.settle_device_update_operations($1,$2,$3,$4,$5,$6,$7) AS result',
          values: [
            customer,
            job.jobId,
            job.token,
            randomUUID(),
            'write',
            JSON.stringify([
              {
                operationNumber: 1,
                outcome: 'succeeded',
                values: { annotatedLocation: 'Room 12' },
                verifiedBy: 'write-response',
              },
            ]),
            new Date(),
          ],
          expect: (answer) => {
            assert.notEqual(
              answer.code,
              '55P03',
              'An already-fenced result must not wait on its operation row.',
            );
            assert.equal(answer.rows[0].result.publication, null);
          },
        });
        await endJob(job.jobId);
      },
    );

    // R6-4: the verification claim decides eligibility under the header before the operation locks.
    await ruleCheck(
      'R6-4 the verification claim rejects a live reservation before it waits on the operation',
      async () => {
        const job = await heldJob('r64-a');
        await settle(
          job.jobId,
          job.token,
          job.attempt,
          'write',
          [
            {
              operationNumber: 1,
              outcome: 'unknown',
              outcomeReason: 'open-request',
              verifiedBy: 'write-response',
            },
          ],
          new Date(),
        );
        await descendantHeld({
          rows: [heldOperationRow(job.jobId)],
          sql: 'SELECT cc.claim_device_update_verification($1,$2,$3,$4) AS result',
          values: [customer, job.jobId, JSON.stringify([1]), randomUUID()],
          expect: (answer) => {
            assert.notEqual(
              answer.code,
              '55P03',
              'A live read-back reservation must be checked before the operation lock.',
            );
            assert.deepEqual(answer.rows[0].result, []);
          },
        });
        await endJob(job.jobId);
      },
    );

    // R6-5: the start reads the clock and validates under the header before the detail lock.
    await ruleCheck(
      'R6-5 a start rejects an old token before it waits on the detail row',
      async () => {
        const job = await heldJob('r65-a');
        await descendantHeld({
          rows: [heldDetailRow(job.jobId)],
          sql: 'SELECT cc.record_device_update_start($1,$2,$3,$4) AS result',
          values: [customer, job.jobId, randomUUID(), 'r65-late-execution'],
          expect: (answer) => {
            assert.notEqual(
              answer.code,
              '55P03',
              'A superseded start must not wait on the detail row.',
            );
            assert.equal(answer.detail, 'attempt-fenced');
          },
        });
        await endJob(job.jobId);
      },
    );

    // R6-6: an abandoned start rejects a missing scoped header and an old token before the detail lock.
    await ruleCheck(
      'R6-6 an abandoned start rejects before it waits on the detail row',
      async () => {
        const job = await heldJob('r66-a');
        await descendantHeld({
          rows: [heldDetailRow(job.jobId)],
          sql: 'SELECT cc.abandon_device_update_start($1,$2,$3) AS result',
          values: [customer, job.jobId, randomUUID()],
          expect: (answer) => {
            assert.notEqual(
              answer.code,
              '55P03',
              'A superseded abandonment must not wait on the detail row.',
            );
          },
        });
        await descendantHeld({
          rows: [heldDetailRow(job.jobId)],
          sql: 'SELECT cc.abandon_device_update_start($1,$2,$3) AS result',
          values: ['C-missing', job.jobId, job.token],
          expect: (answer) => {
            assert.notEqual(
              answer.code,
              '55P03',
              'A missing scoped header must reject before the detail lock.',
            );
          },
        });
        await endJob(job.jobId);
      },
    );

    // R6-7: the backoff report reads its validation rows without a lock before the detail lock.
    await ruleCheck(
      'R6-7 a backoff report with an old token reaches no detail lock',
      async () => {
        const job = await heldJob('r67-a');
        await descendantHeld({
          rows: [heldDetailRow(job.jobId)],
          sql: 'SELECT cc.report_device_update_backoff($1,$2,$3,0,$4,1) AS result',
          values: [customer, job.jobId, randomUUID(), randomUUID()],
          expect: (answer) => {
            assert.notEqual(
              answer.code,
              '55P03',
              'A superseded report must not wait on the detail row.',
            );
            assert.equal(answer.rows[0].result, false);
          },
        });
        await endJob(job.jobId);
      },
    );

    // R6-1: a read-back accepts the three verified outcomes only, and a terminal job stays unchanged.
    await ruleCheck(
      'R6-1 a read-back rejects an outcome other than succeeded, failed, or unknown',
      async () => {
        const job = await heldJob('r61r-a');
        await settle(
          job.jobId,
          job.token,
          job.attempt,
          'write',
          [
            {
              operationNumber: 1,
              outcome: 'unknown',
              outcomeReason: 'open-request',
              verifiedBy: 'write-response',
            },
          ],
          new Date(),
        );
        assert.equal(
          (await prepareFinish(job.jobId, job.token)).outcome,
          'ready',
        );
        assert.equal(
          (await finishWithToken(job.jobId, job.token)).status,
          'needs-review',
        );
        const before = await jobRow(job.jobId);
        const rows = await operations(job.jobId);
        const published = await publications(job.jobId);
        for (const invalid of ['pending', 'skipped']) {
          await rejects(
            result(
              'SELECT cc.settle_device_update_operations($1,$2,$3,$4,$5,$6,$7) AS result',
              [
                customer,
                job.jobId,
                null,
                job.attempt,
                'read-back',
                JSON.stringify([
                  {
                    operationNumber: 1,
                    outcome: invalid,
                    verifiedBy: 'read-back',
                  },
                ]),
                new Date(),
              ],
            ),
            '22023',
          );
        }
        assert.deepEqual(
          await jobRow(job.jobId),
          before,
          'An invalid read-back outcome must leave the header alone.',
        );
        assert.deepEqual(
          await operations(job.jobId),
          rows,
          'An invalid read-back outcome must leave the operations alone.',
        );
        assert.equal(
          await publications(job.jobId),
          published,
          'An invalid read-back outcome must record no publication.',
        );
        // The valid read-back settlement of the same reservation still settles the review.
        await settle(
          job.jobId,
          null,
          job.attempt,
          'read-back',
          [
            {
              operationNumber: 1,
              outcome: 'succeeded',
              values: { annotatedLocation: 'Room 12' },
              verifiedBy: 'read-back',
            },
          ],
          new Date(),
        );
        assert.equal((await jobRow(job.jobId)).status, 'completed');
        assert.equal((await operations(job.jobId))[0].status, 'succeeded');
      },
    );

    // Round 2 of B2a (review findings F1 to F3 and the eng-lead ruling on their class). After every
    // wait, a writer reads a fresh clock and rechecks every value that can change before it writes.
    // A lock set holds only the rows of eligible results. An enumerated input rejects an absent or
    // null value before any lock. A holder takes the named rows, the call waits on them, and `during`
    // commits a change or lets time pass before the holder releases. A holder that changes a row
    // stands in for a writer that skips the header lock.
    const waitedOn = async ({ rows, sql, values, during }) => {
      const holder = await connect('cc-migrator', 'cc-app');
      const caller = await connect('cc-app', 'cc-app');
      let pending = null;
      try {
        await holder.query('BEGIN');
        for (const [text, args] of rows) await holder.query(text, args);
        const holderPid = await pidOf(holder);
        const callerPid = await pidOf(caller);
        pending = caller.query(sql, values).then(
          (queried) => ({ rows: queried.rows }),
          (error) => ({
            code: error.code,
            detail: error.detail,
            message: error.message,
          }),
        );
        assert.equal(
          await waitsFor(callerPid, holderPid),
          true,
          'The call waits on the held row.',
        );
        if (during) await during();
        const releasedAt = (
          await holder.query('SELECT clock_timestamp() AS at')
        ).rows[0].at;
        await holder.query('ROLLBACK');
        return { answer: await pending, releasedAt };
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        if (pending) await pending;
        await Promise.allSettled([holder.end(), caller.end()]);
      }
    };
    const heldHeaderRow = (jobId) => [
      'SELECT 1 FROM cc.jobs WHERE job_id=$1 FOR UPDATE',
      [jobId],
    ];
    const heldDeviceRow = (deviceId) => [
      'SELECT 1 FROM cc.devices WHERE customer_id=$1 AND device_id=$2 FOR UPDATE',
      [customer, deviceId],
    ];
    const heldOperation = (jobId, operationNumber) => [
      'SELECT 1 FROM cc.device_update_operations WHERE job_id=$1 AND operation_number=$2 FOR UPDATE',
      [jobId, operationNumber],
    ];
    const heldConnectionRow = () => [
      'SELECT 1 FROM cc.google_connection WHERE customer_id=$1 FOR UPDATE',
      [customer],
    ];
    const shortLease = (jobId) =>
      migrator.query(
        `UPDATE cc.device_update_batches SET lease_expires_at=clock_timestamp()+interval '1500 milliseconds'
          WHERE job_id=$1`,
        [jobId],
      );
    const leaseLapses = async (jobId) =>
      assert.equal(
        await until(
          `SELECT clock_timestamp()>lease_expires_at AS lapsed FROM cc.device_update_batches
            WHERE job_id=$1 AND batch=0`,
          [jobId],
        ),
        true,
        'The batch lease lapses in the wait.',
      );
    const leaseLapsed = async (jobId) =>
      (
        await adminRow(
          `SELECT clock_timestamp()>lease_expires_at AS lapsed FROM cc.device_update_batches
            WHERE job_id=$1 AND batch=0`,
          [jobId],
        )
      ).lapsed;
    const rotateToken = (jobId) =>
      migrator.query(
        'UPDATE cc.device_update_jobs SET dispatch_token=gen_random_uuid() WHERE job_id=$1',
        [jobId],
      );
    const claimSql =
      'SELECT cc.claim_device_update_batch($1,$2,$3,$4,$5,$6) AS result';
    const settleSql =
      'SELECT cc.settle_device_update_operations($1,$2,$3,$4,$5,$6,$7) AS result';
    const writeResult = (outcome = 'succeeded') =>
      JSON.stringify([
        outcome === 'succeeded'
          ? {
              operationNumber: 1,
              outcome,
              values: { annotatedLocation: 'Room 12' },
              verifiedBy: 'write-response',
            }
          : {
              operationNumber: 1,
              outcome,
              outcomeReason: 'open-request',
              verifiedBy: 'write-response',
            },
      ]);

    // F1: a confirmer of its own, and a batch whose first attempt returned its operation to pending
    // and released the batch. The next claim then has one pending operation to dispatch.
    const releasedBatch = async (deviceId) => {
      const owner = await principal(`${randomUUID()}`, [
        ['devices:read', district()],
        ['devices:write', district()],
        ['devices:bulk-actions', district()],
      ]);
      const job = await makeJob({ devices: [deviceId], createdBy: owner });
      const admitted = await admit(false);
      assert.equal(admitted.jobId, job.jobId, 'The admission picks this job.');
      const attempt = randomUUID();
      assert.equal(
        (await claim(job.jobId, admitted.dispatchToken, 0, attempt)).outcome,
        'claimed',
      );
      await settle(
        job.jobId,
        admitted.dispatchToken,
        attempt,
        'write',
        [{ operationNumber: 1, outcome: 'pending' }],
        new Date(),
      );
      assert.equal((await batchRow(job.jobId)).attempt_id, null);
      return { ...job, token: admitted.dispatchToken, owner };
    };
    const nextClaim = (job) => ({
      sql: claimSql,
      values: [customer, job.jobId, job.token, 0, randomUUID(), 'f1-next'],
    });
    const stoppedInWait = async (job, answer, failure) => {
      assert.equal(
        answer.code,
        undefined,
        `The claim answers instead of failing: ${answer.message}`,
      );
      assert.equal(
        answer.rows[0].result.outcome,
        'stopped',
        'A claim revalidates access after its wait, before dispatch and credential return.',
      );
      assert.equal(answer.rows[0].result.failure, failure);
      assert.equal(answer.rows[0].result.envelope, undefined);
      assert.equal((await jobRow(job.jobId)).failure, failure);
      assert.deepEqual(
        (await operations(job.jobId)).map((row) => [
          row.status,
          row.outcome_reason,
        ]),
        [['skipped', failure]],
      );
      await endJob(job.jobId);
    };
    const disable = (job) => () =>
      migrator.query(
        'UPDATE cc.application_principals SET enabled=false WHERE id=$1',
        [job.owner],
      );

    await ruleCheck(
      'F1 a claim that waits on its batch row stops when the confirmer is disabled in the wait',
      async () => {
        const job = await releasedBatch('f1-a');
        const { answer } = await waitedOn({
          rows: [heldBatchRow(job.jobId)],
          ...nextClaim(job),
          during: disable(job),
        });
        await stoppedInWait(job, answer, 'permission-changed');
      },
    );

    await ruleCheck(
      'F1 a claim that waits on its batch row stops when the permission version changes in the wait',
      async () => {
        const job = await releasedBatch('f1-b');
        const { answer } = await waitedOn({
          rows: [heldBatchRow(job.jobId)],
          ...nextClaim(job),
          during: () =>
            migrator.query(
              'UPDATE cc.application_principals SET permission_version=permission_version+1 WHERE id=$1',
              [job.owner],
            ),
        });
        await stoppedInWait(job, answer, 'permission-changed');
      },
    );

    await ruleCheck(
      'F1 a claim that waits on its batch row stops when a write grant is revoked in the wait',
      async () => {
        const job = await releasedBatch('f1-c');
        const { answer } = await waitedOn({
          rows: [heldBatchRow(job.jobId)],
          ...nextClaim(job),
          during: () =>
            migrator.query(
              "DELETE FROM cc.application_grants WHERE principal_id=$1 AND action='devices:bulk-actions'",
              [job.owner],
            ),
        });
        await stoppedInWait(job, answer, 'permission-changed');
      },
    );

    await ruleCheck(
      'F1 a claim that waits on its batch row stops when the connection changes in the wait',
      async () => {
        const job = await releasedBatch('f1-d');
        let replaced = null;
        try {
          const { answer } = await waitedOn({
            rows: [heldBatchRow(job.jobId)],
            ...nextClaim(job),
            during: async () => {
              replaced = await adminRow(
                `INSERT INTO cc.google_credentials(id,generation,customer_id,envelope,client_id,delegated_subject)
                SELECT gen_random_uuid(),(SELECT max(generation)+1 FROM cc.google_credentials),customer_id,envelope,
                  client_id,delegated_subject FROM cc.google_credentials WHERE id=$1
                RETURNING id,generation`,
                [connection.credential_id],
              );
              await migrator.query(
                'UPDATE cc.google_connection SET credential_id=$2,generation=$3 WHERE customer_id=$1',
                [customer, replaced.id, replaced.generation],
              );
            },
          });
          await stoppedInWait(job, answer, 'connection-changed');
        } finally {
          await migrator.query(
            'UPDATE cc.google_connection SET credential_id=$2,generation=$3 WHERE customer_id=$1',
            [customer, connection.credential_id, generation],
          );
          if (replaced)
            await migrator.query(
              'DELETE FROM cc.google_credentials WHERE id=$1',
              [replaced.id],
            );
        }
      },
    );

    await ruleCheck(
      'F1 a claim that waits on its operation row stops when the confirmer is disabled in the wait',
      async () => {
        const job = await releasedBatch('f1-e');
        const { answer } = await waitedOn({
          rows: [heldOperationRow(job.jobId)],
          ...nextClaim(job),
          during: disable(job),
        });
        await stoppedInWait(job, answer, 'permission-changed');
      },
    );

    await ruleCheck(
      'F1 a claim that waits on the detail row stops when the confirmer is disabled in the wait',
      async () => {
        const job = await releasedBatch('f1-f');
        const { answer } = await waitedOn({
          rows: [heldDetailRow(job.jobId)],
          ...nextClaim(job),
          during: disable(job),
        });
        await stoppedInWait(job, answer, 'permission-changed');
      },
    );

    await ruleCheck(
      'F1 a claim that waits on the connection row stops when the confirmer is disabled in the wait',
      async () => {
        const job = await releasedBatch('f1-g');
        const { answer } = await waitedOn({
          rows: [heldConnectionRow()],
          ...nextClaim(job),
          during: disable(job),
        });
        await stoppedInWait(job, answer, 'permission-changed');
      },
    );

    await ruleCheck(
      'F1 a claim that waits on its batch row returns superseded when the token rotates in the wait',
      async () => {
        const job = await releasedBatch('f1-h');
        const recorded = await publications(job.jobId);
        const { answer } = await waitedOn({
          rows: [heldBatchRow(job.jobId)],
          ...nextClaim(job),
          during: () => rotateToken(job.jobId),
        });
        assert.equal(answer.code, undefined, answer.message);
        assert.equal(
          answer.rows[0].result.outcome,
          'superseded',
          'A claim rechecks its token after the batch wait.',
        );
        assert.deepEqual(
          (await operations(job.jobId)).map((row) => row.status),
          ['pending'],
        );
        assert.equal(await publications(job.jobId), recorded);
        await endJob(job.jobId);
      },
    );

    await ruleCheck(
      'F1 control: a claim that waits on its batch row without an access change claims its batch',
      async () => {
        const job = await releasedBatch('f1-i');
        const { answer } = await waitedOn({
          rows: [heldBatchRow(job.jobId)],
          ...nextClaim(job),
        });
        assert.equal(answer.code, undefined, answer.message);
        assert.equal(answer.rows[0].result.outcome, 'claimed');
        assert.deepEqual(
          (await operations(job.jobId)).map((row) => row.status),
          ['dispatched'],
        );
        await endJob(job.jobId);
      },
    );

    // F2: two unknown operations under two different live read-back attempts. A settlement names both
    // under the first attempt, so only the first result is eligible.
    const mixedReadBacks = async (prefix) => {
      const ids = [`${prefix}-1`, `${prefix}-2`];
      await upsert(
        ids.map((id) => device(id)),
        new Date(Date.now() - 60 * 60 * 1000),
      );
      const job = await makeJob({ devices: ids });
      const admitted = await admit(false);
      assert.equal(admitted.jobId, job.jobId, 'The admission picks this job.');
      const attempt = randomUUID();
      await claim(job.jobId, admitted.dispatchToken, 0, attempt);
      await settle(
        job.jobId,
        admitted.dispatchToken,
        attempt,
        'write',
        [1, 2].map((operationNumber) => ({
          operationNumber,
          outcome: 'unknown',
          outcomeReason: 'interrupted',
        })),
        new Date(),
      );
      await migrator.query(
        `UPDATE cc.device_update_operations SET verify_lease_expires_at=clock_timestamp()-interval '1 second'
          WHERE job_id=$1`,
        [job.jobId],
      );
      const first = randomUUID();
      assert.equal((await claimVerification(job.jobId, [1], first)).length, 1);
      assert.equal(
        (await claimVerification(job.jobId, [2], randomUUID())).length,
        1,
      );
      return { ...job, ids, first };
    };
    const mixedSettlement = (job) => [
      customer,
      job.jobId,
      null,
      job.first,
      'read-back',
      JSON.stringify(
        [1, 2].map((operationNumber) => ({
          operationNumber,
          outcome: 'succeeded',
          values: { annotatedLocation: 'Room 12' },
          verifiedBy: 'read-back',
        })),
      ),
      new Date(),
    ];
    const settlesOnlyFirst = (answer) => {
      assert.equal(
        answer.code,
        undefined,
        'An eligible result must not make a fenced result wait on its descendant rows.',
      );
      assert.deepEqual(
        answer.rows[0].result.settled.map((row) => row.operationNumber),
        [1],
      );
    };

    await ruleCheck(
      'F2 a mixed settlement does not wait on the operation row of its fenced result',
      async () => {
        const job = await mixedReadBacks('f2o');
        await descendantHeld({
          rows: [heldOperation(job.jobId, 2)],
          sql: settleSql,
          values: mixedSettlement(job),
          expect: settlesOnlyFirst,
        });
        assert.deepEqual(
          (await operations(job.jobId)).map((row) => row.status),
          ['succeeded', 'unknown'],
        );
        await endJob(job.jobId);
      },
    );

    await ruleCheck(
      'F2 a mixed settlement does not wait on the device row of its fenced result',
      async () => {
        const job = await mixedReadBacks('f2d');
        await descendantHeld({
          rows: [heldDeviceRow(job.ids[1])],
          sql: settleSql,
          values: mixedSettlement(job),
          expect: settlesOnlyFirst,
        });
        assert.deepEqual(
          (await operations(job.jobId)).map((row) => row.status),
          ['succeeded', 'unknown'],
        );
        await endJob(job.jobId);
      },
    );

    for (const [label, entry] of [
      [
        'a null',
        { operationNumber: 1, outcome: null, verifiedBy: 'read-back' },
      ],
      ['an absent', { operationNumber: 1, verifiedBy: 'read-back' }],
    ])
      await ruleCheck(
        `F2 a read-back with ${label} outcome rejects before any lock`,
        async () => {
          const job = await heldJob(`f2-${label.split(' ')[1]}`);
          await settle(
            job.jobId,
            job.token,
            job.attempt,
            'write',
            JSON.parse(writeResult('unknown')),
            new Date(),
          );
          const before = await operations(job.jobId);
          await descendantHeld({
            rows: [heldHeaderRow(job.jobId), heldOperationRow(job.jobId)],
            sql: settleSql,
            values: [
              customer,
              job.jobId,
              null,
              job.attempt,
              'read-back',
              JSON.stringify([entry]),
              new Date(),
            ],
            expect: (answer) =>
              assert.equal(
                answer.code,
                '22023',
                'An absent or null outcome rejects before the header lock.',
              ),
          });
          assert.deepEqual(await operations(job.jobId), before);
          await endJob(job.jobId);
        },
      );

    await ruleCheck(
      'S2 a settlement with a null kind rejects before any lock',
      async () => {
        const job = await heldJob('f2k-a');
        await descendantHeld({
          rows: [heldHeaderRow(job.jobId)],
          sql: settleSql,
          values: [
            customer,
            job.jobId,
            job.token,
            job.attempt,
            null,
            writeResult(),
            new Date(),
          ],
          expect: (answer) =>
            assert.equal(
              answer.code,
              '22023',
              'A null settlement kind rejects before the header lock.',
            ),
        });
        assert.deepEqual(
          (await operations(job.jobId)).map((row) => row.status),
          ['dispatched'],
        );
        await endJob(job.jobId);
      },
    );

    await ruleCheck(
      'S1 a write settlement that waits on the detail row fences on the lease that lapsed in the wait',
      async () => {
        await upsert([device('f2w-a')], new Date(Date.now() - 60 * 60 * 1000));
        const job = await heldJob('f2w-a');
        const before = await jobRow(job.jobId);
        const recorded = await publications(job.jobId);
        await shortLease(job.jobId);
        const { answer } = await waitedOn({
          rows: [heldDetailRow(job.jobId)],
          sql: settleSql,
          values: [
            customer,
            job.jobId,
            job.token,
            job.attempt,
            'write',
            writeResult(),
            new Date(),
          ],
          during: () => leaseLapses(job.jobId),
        });
        assert.equal(answer.code, undefined, answer.message);
        assert.deepEqual(
          answer.rows[0].result.settled,
          [],
          'A lease that lapsed in the detail wait fences the result.',
        );
        assert.equal(answer.rows[0].result.publication, null);
        assert.equal(
          Number((await jobRow(job.jobId)).revision),
          Number(before.revision),
        );
        assert.equal(await publications(job.jobId), recorded);
        assert.deepEqual(
          (await operations(job.jobId)).map((row) => row.status),
          ['dispatched'],
        );
        assert.equal((await deviceRow('f2w-a')).annotated_location, null);
        await endJob(job.jobId);
      },
    );

    await ruleCheck(
      'S1 a write settlement that waits on its operation row returns fenced when the token rotates in the wait',
      async () => {
        const job = await heldJob('f2t-a');
        const recorded = await publications(job.jobId);
        const { answer } = await waitedOn({
          rows: [heldOperationRow(job.jobId)],
          sql: settleSql,
          values: [
            customer,
            job.jobId,
            job.token,
            job.attempt,
            'write',
            writeResult(),
            new Date(),
          ],
          during: () => rotateToken(job.jobId),
        });
        assert.equal(answer.code, undefined, answer.message);
        assert.equal(
          answer.rows[0].result.outcome,
          'fenced',
          'A write settlement rechecks its token after the operation wait.',
        );
        assert.equal(await publications(job.jobId), recorded);
        assert.deepEqual(
          (await operations(job.jobId)).map((row) => row.status),
          ['dispatched'],
        );
        await endJob(job.jobId);
      },
    );

    await ruleCheck(
      'S1 a settlement of an unknown result does not wait on its device row',
      async () => {
        await upsert([device('f2u-a')], new Date(Date.now() - 60 * 60 * 1000));
        const job = await heldJob('f2u-a');
        await descendantHeld({
          rows: [heldDeviceRow('f2u-a')],
          sql: settleSql,
          values: [
            customer,
            job.jobId,
            job.token,
            job.attempt,
            'write',
            writeResult('unknown'),
            new Date(),
          ],
          expect: (answer) => {
            assert.equal(
              answer.code,
              undefined,
              'A result that changes no device row must not wait on that row.',
            );
            assert.deepEqual(
              answer.rows[0].result.settled.map((row) => row.status),
              ['unknown'],
            );
          },
        });
        await endJob(job.jobId);
      },
    );

    // F3: hold acceptance after a detail-row wait. The lease or the report window lapses in the wait.
    const reportedJob = async (deviceId) => {
      const job = await heldJob(deviceId);
      assert.equal(
        await result(
          'SELECT cc.report_device_update_backoff($1,$2,$3,0,$4,1) AS result',
          [customer, job.jobId, job.token, job.attempt],
        ),
        true,
      );
      return job;
    };
    const acceptSql = 'SELECT cc.accept_device_update_hold($1) AS result';
    const noHold = async (job, answer) => {
      assert.equal(answer.code, undefined, answer.message);
      assert.equal(
        answer.rows[0].result,
        null,
        'A report that lapsed in the detail wait takes no hold.',
      );
      assert.deepEqual(
        await adminRow(
          'SELECT hold_attempt,hold_sequence,hold_written_at FROM cc.device_update_jobs WHERE job_id=$1',
          [job.jobId],
        ),
        { hold_attempt: null, hold_sequence: null, hold_written_at: null },
      );
      await endJob(job.jobId);
    };

    await ruleCheck(
      'F3 hold acceptance rechecks the lease that lapsed during its detail wait',
      async () => {
        const job = await reportedJob('f3-a');
        await shortLease(job.jobId);
        const { answer } = await waitedOn({
          rows: [heldDetailRow(job.jobId)],
          sql: acceptSql,
          values: [customer],
          during: () => leaseLapses(job.jobId),
        });
        await noHold(job, answer);
      },
    );

    await ruleCheck(
      'S1 hold acceptance rechecks the report window that lapsed during its detail wait',
      async () => {
        const job = await reportedJob('f3-b');
        await migrator.query(
          "UPDATE cc.device_update_jobs SET backoff_reported_at=clock_timestamp()-interval '28 seconds' WHERE job_id=$1",
          [job.jobId],
        );
        const { answer } = await waitedOn({
          rows: [heldDetailRow(job.jobId)],
          sql: acceptSql,
          values: [customer],
          during: async () =>
            assert.equal(
              await until(
                `SELECT clock_timestamp()-backoff_reported_at>interval '30 seconds' AS lapsed
                  FROM cc.device_update_jobs WHERE job_id=$1`,
                [job.jobId],
              ),
              true,
              'The report window lapses in the wait.',
            ),
        });
        await noHold(job, answer);
      },
    );

    // The class checks: the renewal, the release, the admission, the tick, the abandoned start, the
    // finish preparation, the reaper, and the read-back claim.
    const renewSql =
      'SELECT cc.renew_device_update_batch($1,$2,$3,$4,$5) AS result';
    const releaseSql =
      'SELECT cc.release_device_update_batch($1,$2,$3,$4,$5) AS result';

    await ruleCheck(
      'S1 a renewal that waits on the detail row does not revive the lease that lapsed in the wait',
      async () => {
        const job = await heldJob('rn2-a');
        await shortLease(job.jobId);
        const { answer } = await waitedOn({
          rows: [heldDetailRow(job.jobId)],
          sql: renewSql,
          values: [customer, job.jobId, job.token, 0, job.attempt],
          during: () => leaseLapses(job.jobId),
        });
        assert.equal(
          answer.detail,
          'attempt-fenced',
          'A lease that lapsed in the detail wait fences the renewal.',
        );
        assert.equal(
          await leaseLapsed(job.jobId),
          true,
          'The renewal leaves the lapsed lease alone.',
        );
        await endJob(job.jobId);
      },
    );

    await ruleCheck(
      'S1 a renewal that waits on its batch row rejects the token rotated in the wait',
      async () => {
        const job = await heldJob('rn2-b');
        const before = await batchRow(job.jobId);
        const { answer } = await waitedOn({
          rows: [heldBatchRow(job.jobId)],
          sql: renewSql,
          values: [customer, job.jobId, job.token, 0, job.attempt],
          during: () => rotateToken(job.jobId),
        });
        assert.equal(
          answer.detail,
          'attempt-fenced',
          'A renewal rechecks its token after the batch wait.',
        );
        assert.deepEqual(await batchRow(job.jobId), before);
        await endJob(job.jobId);
      },
    );

    await ruleCheck(
      'S1 a release stamps settled_at after its batch wait',
      async () => {
        const job = await heldJob('rl2-a');
        const { answer, releasedAt } = await waitedOn({
          rows: [heldBatchRow(job.jobId)],
          sql: releaseSql,
          values: [customer, job.jobId, job.token, 0, job.attempt],
          during: () => sleep(200),
        });
        assert.equal(answer.code, undefined, answer.message);
        const batch = await batchRow(job.jobId);
        assert.equal(batch.attempt_id, null);
        assert.ok(
          batch.settled_at >= releasedAt,
          'A release stamps settled_at from its post-wait clock.',
        );
        await endJob(job.jobId);
      },
    );

    await ruleCheck(
      'S1 a release that waits on its batch row rejects the token rotated in the wait',
      async () => {
        const job = await heldJob('rl2-b');
        const before = await batchRow(job.jobId);
        const { answer } = await waitedOn({
          rows: [heldBatchRow(job.jobId)],
          sql: releaseSql,
          values: [customer, job.jobId, job.token, 0, job.attempt],
          during: () => rotateToken(job.jobId),
        });
        assert.equal(
          answer.detail,
          'attempt-fenced',
          'A release rechecks its token after the batch wait.',
        );
        assert.deepEqual(await batchRow(job.jobId), before);
        await endJob(job.jobId);
      },
    );

    const admitSql = 'SELECT cc.admit_device_update_job($1,$2) AS result';

    await ruleCheck(
      'S2 admission rejects a null hold flag before it admits a job',
      async () => {
        const job = await makeJob({ devices: ['ad2-h'] });
        await rejects(result(admitSql, [customer, null]), '22023');
        assert.equal(
          (await jobRow(job.jobId)).status,
          'accepted',
          'A null hold flag admits nothing.',
        );
        await endJob(job.jobId);
      },
    );

    await ruleCheck(
      'S1 admission reads the running job after its header wait',
      async () => {
        const active = await makeJob({ devices: ['ad2-r'] });
        assert.equal((await admit(false)).jobId, active.jobId);
        const next = await makeJob({ devices: ['ad2-n'] });
        const { answer } = await waitedOn({
          rows: [heldHeaderRow(next.jobId)],
          sql: admitSql,
          values: [customer, false],
          during: () => endJob(active.jobId),
        });
        assert.equal(answer.code, undefined, answer.message);
        assert.equal(
          answer.rows[0].result?.jobId,
          next.jobId,
          'A job that ended in the header wait leaves the write slot free.',
        );
        await endJob(next.jobId);
      },
    );

    await ruleCheck(
      'S1 admission sets the start deadline after its detail wait',
      async () => {
        const job = await makeJob({ devices: ['ad2-d'] });
        const { answer, releasedAt } = await waitedOn({
          rows: [heldDetailRow(job.jobId)],
          sql: admitSql,
          values: [customer, false],
          during: () => sleep(200),
        });
        assert.equal(answer.code, undefined, answer.message);
        assert.equal(answer.rows[0].result?.jobId, job.jobId);
        const saved = await adminRow(
          `SELECT j.admitted_at,u.start_deadline_at FROM cc.jobs j
            JOIN cc.device_update_jobs u ON u.job_id=j.job_id WHERE j.job_id=$1`,
          [job.jobId],
        );
        assert.ok(
          saved.start_deadline_at.getTime() >= releasedAt.getTime() + 120000,
          'A detail wait must not consume the start window.',
        );
        assert.ok(saved.admitted_at >= releasedAt);
        await endJob(job.jobId);
      },
    );

    const recoverSql = 'SELECT cc.recover_device_update_jobs($1) AS result';

    await ruleCheck(
      'S1 a start rotation sets its start deadline after its detail wait',
      async () => {
        const job = await makeJob({ devices: ['rc2-u'] });
        const admitted = await admit(false);
        assert.equal(admitted.jobId, job.jobId);
        await migrator.query(
          "UPDATE cc.device_update_jobs SET start_deadline_at=clock_timestamp()-interval '1 second' WHERE job_id=$1",
          [job.jobId],
        );
        const { answer, releasedAt } = await waitedOn({
          rows: [heldDetailRow(job.jobId)],
          sql: recoverSql,
          values: [customer],
          during: () => sleep(200),
        });
        assert.equal(answer.code, undefined, answer.message);
        assert.ok(
          answer.rows[0].result.starts.some(
            (start) => start.jobId === job.jobId,
          ),
          'The tick rotates the unclaimed start.',
        );
        const saved = await adminRow(
          'SELECT dispatch_count,dispatch_token,start_deadline_at FROM cc.device_update_jobs WHERE job_id=$1',
          [job.jobId],
        );
        assert.equal(saved.dispatch_count, 2);
        assert.notEqual(saved.dispatch_token, admitted.dispatchToken);
        assert.ok(
          saved.start_deadline_at.getTime() >= releasedAt.getTime() + 120000,
          'A detail wait must not consume the new start window.',
        );
        await endJob(job.jobId);
      },
    );

    await ruleCheck(
      'S1 a runner-loss rotation stamps its heartbeat and start deadline after its detail wait',
      async () => {
        const job = await heldJob('rc2-l');
        await stop(job.jobId, job.token, 0, job.attempt);
        await migrator.query(
          "UPDATE cc.device_update_jobs SET heartbeat_at=clock_timestamp()-interval '11 minutes' WHERE job_id=$1",
          [job.jobId],
        );
        const { answer, releasedAt } = await waitedOn({
          rows: [heldDetailRow(job.jobId)],
          sql: recoverSql,
          values: [customer],
          during: () => sleep(200),
        });
        assert.equal(answer.code, undefined, answer.message);
        assert.ok(
          answer.rows[0].result.starts.some(
            (start) => start.jobId === job.jobId,
          ),
          'The tick rotates the lost runner.',
        );
        const saved = await adminRow(
          'SELECT dispatch_count,heartbeat_at,start_deadline_at FROM cc.device_update_jobs WHERE job_id=$1',
          [job.jobId],
        );
        assert.equal(saved.dispatch_count, 2);
        assert.ok(
          saved.heartbeat_at >= releasedAt,
          'The rotation stamps its heartbeat after the detail wait.',
        );
        assert.ok(
          saved.start_deadline_at.getTime() >= releasedAt.getTime() + 120000,
          'A detail wait must not consume the new start window.',
        );
        await endJob(job.jobId);
      },
    );

    await ruleCheck(
      'S1 an abandoned start stamps finished_at after its operation wait',
      async () => {
        const job = await makeJob({ devices: ['ab2-a'] });
        const admitted = await admit(false);
        assert.equal(admitted.jobId, job.jobId);
        const { answer, releasedAt } = await waitedOn({
          rows: [heldOperationRow(job.jobId)],
          sql: 'SELECT cc.abandon_device_update_start($1,$2,$3) AS result',
          values: [customer, job.jobId, admitted.dispatchToken],
          during: () => sleep(200),
        });
        assert.equal(answer.code, undefined, answer.message);
        const saved = await jobRow(job.jobId);
        assert.equal(saved.status, 'failed');
        assert.equal(saved.failure, 'orchestration-unavailable');
        assert.ok(
          saved.finished_at >= releasedAt,
          'The closure stamps finished_at from its post-wait clock.',
        );
        assert.deepEqual(
          (await operations(job.jobId)).map((row) => row.status),
          ['skipped'],
        );
      },
    );

    const prepareSql =
      'SELECT cc.prepare_device_update_finish($1,$2,$3,$4) AS result';
    const fenceTime = (jobId) =>
      adminRow(
        'SELECT status,verify_after FROM cc.device_update_operations WHERE job_id=$1 AND operation_number=1',
        [jobId],
      );

    await ruleCheck(
      'S1 a finish preparation fences at its post-wait time',
      async () => {
        const job = await heldJob('pf2-a');
        await expireBatches(job.jobId);
        const { answer, releasedAt } = await waitedOn({
          rows: [heldOperationRow(job.jobId)],
          sql: prepareSql,
          values: [customer, job.jobId, job.token, null],
          during: () => sleep(200),
        });
        assert.equal(answer.code, undefined, answer.message);
        assert.equal(answer.rows[0].result.outcome, 'ready');
        const fenced = await fenceTime(job.jobId);
        assert.equal(fenced.status, 'unknown');
        assert.ok(
          fenced.verify_after >= releasedAt,
          'The fence time comes from the post-wait clock.',
        );
        await endJob(job.jobId);
      },
    );

    await ruleCheck(
      'S1 a finish preparation that waits on an operation row returns superseded when the token rotates in the wait',
      async () => {
        const job = await heldJob('pf2-b');
        await expireBatches(job.jobId);
        const before = await jobRow(job.jobId);
        const { answer } = await waitedOn({
          rows: [heldOperationRow(job.jobId)],
          sql: prepareSql,
          values: [customer, job.jobId, job.token, null],
          during: () => rotateToken(job.jobId),
        });
        assert.equal(answer.code, undefined, answer.message);
        assert.equal(
          answer.rows[0].result.outcome,
          'superseded',
          'A preparation rechecks its token after the operation wait.',
        );
        assert.equal(
          Number((await jobRow(job.jobId)).revision),
          Number(before.revision),
        );
        assert.equal((await fenceTime(job.jobId)).status, 'dispatched');
        await endJob(job.jobId);
      },
    );

    await ruleCheck('S1 the reaper fences at its post-wait time', async () => {
      const job = await heldJob('fz2-a');
      await expireBatches(job.jobId);
      const { answer, releasedAt } = await waitedOn({
        rows: [heldOperationRow(job.jobId)],
        sql: 'SELECT cc.finalize_device_update_job($1,$2,$3) AS result',
        values: [customer, job.jobId, null],
        during: () => sleep(200),
      });
      assert.equal(answer.code, undefined, answer.message);
      assert.equal(answer.rows[0].result.outcome, 'finalized');
      const fenced = await fenceTime(job.jobId);
      assert.equal(fenced.status, 'unknown');
      assert.ok(
        fenced.verify_after >= releasedAt,
        'The fence time comes from the post-wait clock.',
      );
    });

    await ruleCheck(
      'S1 a verification claim locks only the operations it found eligible',
      async () => {
        const ids = ['cv2-1', 'cv2-2'];
        const job = await makeJob({ devices: ids });
        const admitted = await admit(false);
        assert.equal(admitted.jobId, job.jobId);
        const attempt = randomUUID();
        await claim(job.jobId, admitted.dispatchToken, 0, attempt);
        await settle(
          job.jobId,
          admitted.dispatchToken,
          attempt,
          'write',
          [1, 2].map((operationNumber) => ({
            operationNumber,
            outcome: 'unknown',
            outcomeReason: 'interrupted',
          })),
          new Date(),
        );
        // Operation 1 has no live reservation. The reservation of operation 2 lapses in the wait.
        await migrator.query(
          `UPDATE cc.device_update_operations SET verify_lease_expires_at=CASE WHEN operation_number=1
            THEN clock_timestamp()-interval '1 second' ELSE clock_timestamp()+interval '1500 milliseconds' END
            WHERE job_id=$1`,
          [job.jobId],
        );
        const first = await connect('cc-migrator', 'cc-app');
        const second = await connect('cc-migrator', 'cc-app');
        const caller = await connect('cc-app', 'cc-app');
        let pending = null;
        try {
          await first.query('BEGIN');
          await first.query(...heldOperation(job.jobId, 1));
          const firstPid = await pidOf(first);
          const secondPid = await pidOf(second);
          const callerPid = await pidOf(caller);
          pending = caller
            .query(
              'SELECT cc.claim_device_update_verification($1,$2,$3,$4) AS result',
              [customer, job.jobId, JSON.stringify([1, 2]), randomUUID()],
            )
            .then(
              (queried) => ({ rows: queried.rows }),
              (error) => ({ code: error.code, message: error.message }),
            );
          assert.equal(
            await waitsFor(callerPid, firstPid),
            true,
            'The claim waits on its eligible operation.',
          );
          assert.equal(
            await until(
              `SELECT clock_timestamp()>verify_lease_expires_at AS lapsed FROM cc.device_update_operations
                WHERE job_id=$1 AND operation_number=2`,
              [job.jobId],
            ),
            true,
            'The second reservation lapses in the wait.',
          );
          await second.query('BEGIN');
          await second.query(...heldOperation(job.jobId, 2));
          await first.query('ROLLBACK');
          const waited = await waitsBriefly(callerPid, secondPid);
          await second.query('ROLLBACK');
          const answer = await pending;
          assert.equal(
            waited,
            false,
            'A claim locks no operation that was not eligible under the header.',
          );
          assert.equal(answer.code, undefined, answer.message);
          assert.deepEqual(
            answer.rows[0].result.map((row) => row.operationNumber),
            [1],
          );
        } finally {
          await first.query('ROLLBACK').catch(() => undefined);
          await second.query('ROLLBACK').catch(() => undefined);
          if (pending) await pending;
          await Promise.allSettled([first.end(), second.end(), caller.end()]);
        }
        await endJob(job.jobId);
      },
    );

    await ruleCheck(
      'S2 a verification claim rejects a null operation number before any lock',
      async () => {
        const job = await heldJob('cv2-n');
        await descendantHeld({
          rows: [heldHeaderRow(job.jobId)],
          sql: 'SELECT cc.claim_device_update_verification($1,$2,$3,$4) AS result',
          values: [customer, job.jobId, JSON.stringify([null]), randomUUID()],
          expect: (answer) =>
            assert.equal(
              answer.code,
              '22023',
              'A null operation number rejects before the header lock.',
            ),
        });
        await endJob(job.jobId);
      },
    );

    // The claim revalidation reads the confirmer and the connection as their definer. Like
    // cc.write_capable, it stays an internal helper: only its owner holds EXECUTE. The ACL is read
    // directly, because a superuser session bypasses EXECUTE checks. A null ACL is the default
    // grant to PUBLIC.
    await ruleCheck(
      'S2 the claim revalidation helper is not executable by PUBLIC or the application role',
      async () => {
        for (const signature of [
          'cc.write_capable(uuid,text,text)',
          'cc.device_update_stop_reason(text,uuid,integer,integer,text)',
        ]) {
          const privileges = await adminRow(
            `SELECT count(p.oid)=1 AS present,
              bool_and(p.proacl IS NOT NULL AND NOT EXISTS(SELECT 1 FROM aclexplode(p.proacl) a
                WHERE a.privilege_type='EXECUTE' AND a.grantee<>p.proowner)) AS owner_only
             FROM pg_proc p WHERE p.oid=to_regprocedure($1)`,
            [signature],
          );
          assert.equal(privileges.present, true, `${signature} exists.`);
          assert.equal(
            privileges.owner_only,
            true,
            `${signature} grants EXECUTE to its owner only.`,
          );
        }
      },
    );

    // Round 3 of B2a (review findings R2-F1 to R2-F4 and the eng-lead rulings of round 3). A success
    // names the provenance of its settlement kind. Every enumerated or typed input rejects before any
    // lock. A writer locks every row that it writes before its last clock read, so no write waits.
    const settlementValues = (job, kind, entries) => [
      customer,
      job.jobId,
      kind === 'write' ? job.token : null,
      job.attempt,
      kind,
      JSON.stringify(entries),
      new Date(),
    ];
    // A write job holds its operation under a live lease. A read-back job ended as needs-review, and its
    // unknown operation keeps the live read-back lease of the same attempt.
    const provenanceJob = async (deviceId, kind, options = {}) => {
      await upsert(
        [device(deviceId, { annotatedLocation: 'Old' })],
        new Date(Date.now() - 60 * 60 * 1000),
      );
      const job = await heldJob(deviceId, options);
      if (kind === 'read-back') {
        await settle(
          job.jobId,
          job.token,
          job.attempt,
          'write',
          JSON.parse(writeResult('unknown')),
          new Date(),
        );
        await prepareFinish(job.jobId, job.token);
        assert.equal((await finishJob(job.jobId)).status, 'needs-review');
      }
      return job;
    };
    // Every row that a writer can change for one job and one device.
    const jobState = async (jobId, deviceId) => ({
      operations: await admin(
        `SELECT operation_number,status,attempt_id,verified_by,observed_value,outcome_reason,verify_attempt,
          verify_lease_expires_at,updated_at FROM cc.device_update_operations WHERE job_id=$1
          ORDER BY operation_number`,
        [jobId],
      ),
      header: await adminRow(
        `SELECT status,failure,succeeded,failed,unknown,skipped,revision,changed_at,finished_at
          FROM cc.jobs WHERE job_id=$1`,
        [jobId],
      ),
      detail: await detailRow(jobId),
      batch: (await batchRow(jobId)) ?? null,
      device: (await deviceRow(deviceId)) ?? null,
      overlay: (await overlay(deviceId)) ?? null,
      publications: await publications(jobId),
    });
    // An invalid input rejects while another session holds the job header, so it rejects before the
    // header lock. The same call without that holder rejects too, and it changes nothing.
    const rejectsBeforeLocks = async ({ jobId, deviceId, sql, values }) => {
      const before = await jobState(jobId, deviceId);
      await descendantHeld({
        rows: [heldHeaderRow(jobId)],
        sql,
        values,
        expect: (answer) =>
          assert.equal(
            answer.code,
            '22023',
            'An invalid input rejects before the header lock.',
          ),
      });
      await rejects(result(sql, values), '22023');
      assert.deepEqual(
        await jobState(jobId, deviceId),
        before,
        'An invalid input changes nothing.',
      );
    };
    // R1-F3: the verification read takes the global access lock first, before every row lock. An
    // invalid input rejects while another session holds that lock, so a check that still waited on it
    // would answer 55P03 under the short lock timeout instead of its defined error.
    const rejectsBeforeGlobalLock = async ({ sql, values }) => {
      await descendantHeld({
        rows: [['SELECT pg_advisory_xact_lock(7240173008)', []]],
        sql,
        values,
        expect: (answer) =>
          assert.equal(
            answer.code,
            '22023',
            'An invalid input rejects before the global access lock.',
          ),
      });
      await rejects(result(sql, values), '22023');
    };

    // R2-F1: a success without the provenance of its kind (design sections 5.7 and 7.1, eng-lead
    // ruling 1). At 768f8c3 it reached the locks and committed a success that published no device.
    for (const kind of ['write', 'read-back'])
      for (const [label, provenance] of [
        ['an absent', {}],
        ['a null', { verifiedBy: null }],
      ])
        await ruleCheck(
          `R2-F1 a ${kind} success with ${label} verifiedBy rejects before any lock and changes nothing`,
          async () => {
            const deviceId = `r3p-${kind}-${label.split(' ')[1]}`;
            const job = await provenanceJob(deviceId, kind);
            await rejectsBeforeLocks({
              jobId: job.jobId,
              deviceId,
              sql: settleSql,
              values: settlementValues(job, kind, [
                {
                  operationNumber: 1,
                  outcome: 'succeeded',
                  values: { annotatedLocation: 'Room 12' },
                  ...provenance,
                },
              ]),
            });
            await endJob(job.jobId);
          },
        );

    for (const kind of ['write', 'read-back'])
      await ruleCheck(
        `R2-F1 control: a ${kind} success with the provenance of its kind publishes its device`,
        async () => {
          const deviceId = `r3p-${kind}-control`;
          const job = await provenanceJob(deviceId, kind);
          const source = kind === 'write' ? 'write-response' : 'read-back';
          const answer = await result(
            settleSql,
            settlementValues(job, kind, [
              {
                operationNumber: 1,
                outcome: 'succeeded',
                values: { annotatedLocation: 'Room 12' },
                verifiedBy: source,
              },
            ]),
          );
          assert.deepEqual(answer.published, [deviceId]);
          assert.equal(
            (await deviceRow(deviceId)).annotated_location,
            'Room 12',
          );
          assert.equal((await overlay(deviceId)).source, source);
          await endJob(job.jobId);
        },
      );

    // Eng-lead rulings 1 and 2: a provenance names the source of its settlement kind, and no other value
    // reaches a lock. At 768f8c3 these results reached the locks, and a CHECK rejected the last one there.
    for (const [index, [label, kind, entry]] of [
      [
        'a write success with read-back provenance',
        'write',
        {
          operationNumber: 1,
          outcome: 'succeeded',
          values: { annotatedLocation: 'Room 12' },
          verifiedBy: 'read-back',
        },
      ],
      [
        'a read-back success with write-response provenance',
        'read-back',
        {
          operationNumber: 1,
          outcome: 'succeeded',
          values: { annotatedLocation: 'Room 12' },
          verifiedBy: 'write-response',
        },
      ],
      [
        'a write 404 with read-back provenance',
        'write',
        {
          operationNumber: 1,
          outcome: 'failed',
          googleStatus: 404,
          verifiedBy: 'read-back',
          outcomeReason: 'not-found',
        },
      ],
      [
        'a provenance outside its enumeration',
        'read-back',
        {
          operationNumber: 1,
          outcome: 'unknown',
          verifiedBy: 'manual',
          outcomeReason: 'verification-failed',
        },
      ],
    ].entries())
      await ruleCheck(`S2 ${label} rejects before any lock`, async () => {
        const deviceId = `r3k-${index}`;
        const job = await provenanceJob(deviceId, kind);
        await rejectsBeforeLocks({
          jobId: job.jobId,
          deviceId,
          sql: settleSql,
          values: settlementValues(job, kind, [entry]),
        });
        await endJob(job.jobId);
      });

    // The result fields that the settlement casts, or that a CHECK bounds, reject before any lock. At
    // 768f8c3 a cast or a CHECK rejected them after the locks, or the cast accepted another value.
    for (const [index, [label, entry]] of [
      [
        'a fractional operation number',
        { operationNumber: 1.5, outcome: 'unknown' },
      ],
      [
        'an operation number outside the integer range',
        { operationNumber: 1e10, outcome: 'unknown' },
      ],
      [
        'an operation number that is a string',
        { operationNumber: '1', outcome: 'unknown' },
      ],
      [
        'a fractional Google status',
        { operationNumber: 1, outcome: 'failed', googleStatus: 404.5 },
      ],
      [
        'a negative retry count',
        {
          operationNumber: 1,
          outcome: 'failed',
          googleStatus: 429,
          quotaRetries: -1,
        },
      ],
      [
        'a read-back delay that is not a timestamp',
        { operationNumber: 1, outcome: 'unknown', verifyAfter: 'later' },
      ],
      [
        'a value longer than the device field',
        {
          operationNumber: 1,
          outcome: 'succeeded',
          values: { annotatedLocation: 'x'.repeat(4097) },
          verifiedBy: 'write-response',
        },
      ],
      [
        'a value that is not a string',
        {
          operationNumber: 1,
          outcome: 'succeeded',
          values: { annotatedLocation: 12 },
          verifiedBy: 'write-response',
        },
      ],
      [
        'a value for a field its operation does not hold',
        {
          operationNumber: 1,
          outcome: 'succeeded',
          values: { annotatedLocation: 'Room 12', notes: 'Front desk' },
          verifiedBy: 'write-response',
        },
      ],
      [
        'values that omit a field of its operation',
        {
          operationNumber: 1,
          outcome: 'succeeded',
          values: {},
          verifiedBy: 'write-response',
        },
      ],
    ].entries())
      await ruleCheck(
        `S2 a write settlement with ${label} rejects before any lock`,
        async () => {
          const deviceId = `r3t-${index}`;
          const job = await provenanceJob(deviceId, 'write');
          await rejectsBeforeLocks({
            jobId: job.jobId,
            deviceId,
            sql: settleSql,
            values: settlementValues(job, 'write', [entry]),
          });
          await endJob(job.jobId);
        },
      );

    // Design section 8 (Settlement domains): a succeeded path holds a leading '/', while a failed
    // value-differs result carries the same value as evidence and publishes nothing.
    for (const [index, [label, value]] of [
      ['a null path', null],
      ['a path without a leading slash', 'School B'],
    ].entries())
      await ruleCheck(
        `S2 a succeeded write settlement with ${label} rejects before any lock`,
        async () => {
          const deviceId = `r7s-${index}`;
          const job = await provenanceJob(deviceId, 'write', {
            fields: [{ field: 'orgUnitPath', requestedValue: '/School B' }],
          });
          await rejectsBeforeLocks({
            jobId: job.jobId,
            deviceId,
            sql: settleSql,
            values: settlementValues(job, 'write', [
              {
                operationNumber: 1,
                outcome: 'succeeded',
                values: { orgUnitPath: value },
                verifiedBy: 'write-response',
              },
            ]),
          });
          await endJob(job.jobId);
        },
      );

    for (const [index, [label, value]] of [
      ['a null path', null],
      ['a path without a leading slash', 'School B'],
    ].entries())
      await ruleCheck(
        `a failed value-differs result keeps ${label} as evidence and publishes nothing`,
        async () => {
          const deviceId = `r7f-${index}`;
          const job = await provenanceJob(deviceId, 'write', {
            fields: [{ field: 'orgUnitPath', requestedValue: '/School B' }],
          });
          const before = await lagRow(deviceId);
          const answer = await settle(
            job.jobId,
            job.token,
            job.attempt,
            'write',
            [
              {
                operationNumber: 1,
                outcome: 'failed',
                outcomeReason: 'value-differs',
                googleStatus: 200,
                values: { orgUnitPath: value },
                verifiedBy: 'write-response',
              },
            ],
            new Date(),
          );
          assert.deepEqual(
            answer.settled.map((one) => one.status),
            ['failed'],
          );
          const operation = (await operations(job.jobId))[0];
          assert.equal(operation.status, 'failed');
          assert.equal(operation.outcome_reason, 'value-differs');
          const evidence = await fieldRow(job.jobId, 1, 'orgUnitPath');
          assert.equal(evidence.observed_value, value);
          assert.deepEqual(await lagRow(deviceId), before);
          assert.equal(await overlayOf(deviceId, 'orgUnitPath'), undefined);
          // A failed result never publishes a device (step 4 rule 2).
          const changes = await admin(
            'SELECT device_ids FROM cc.job_publications WHERE job_id=$1',
            [job.jobId],
          );
          assert.ok(
            changes.every((row) => row.device_ids.length === 0),
            `A failed result names no device: ${JSON.stringify(changes)}`,
          );
          await endJob(job.jobId);
        },
      );

    // Fix D1: a stored status is an HTTP status from 100 to 599, or null when no answer arrived.
    // The worker now sends null, and the settlement drops a transport zero from an older worker.
    for (const [index, [label, given, stored]] of [
      ['an absent status', undefined, null],
      ['a transport zero', 0, null],
      ['a real refusal', 403, 403],
    ].entries())
      await ruleCheck(
        `a write settlement with ${label} stores google_status ${stored}`,
        async () => {
          const deviceId = `d1w-${index}`;
          const job = await provenanceJob(deviceId, 'write');
          const entry = {
            operationNumber: 1,
            outcome: 'failed',
            outcomeReason: 'forbidden',
            ...(given === undefined ? {} : { googleStatus: given }),
          };
          const answer = await settle(
            job.jobId,
            job.token,
            job.attempt,
            'write',
            [entry],
            new Date(),
          );
          assert.deepEqual(
            answer.settled.map((one) => one.status),
            ['failed'],
          );
          const operation = await adminRow(
            `SELECT status,google_status FROM cc.device_update_operations
              WHERE job_id=$1 AND operation_number=1`,
            [job.jobId],
          );
          assert.equal(operation.status, 'failed');
          assert.equal(operation.google_status, stored);
          await endJob(job.jobId);
        },
      );

    // A verification claim names whole operation numbers. At 768f8c3 a fraction rounded to another
    // operation after the header lock, and a number outside the integer range failed after it.
    for (const [index, [label, named]] of [
      ['a fractional operation number', [1.5]],
      ['an operation number outside the integer range', [1e10]],
      ['an operation number below one', [0]],
    ].entries())
      await ruleCheck(
        `S2 a verification claim with ${label} rejects before any lock`,
        async () => {
          const deviceId = `r3v-${index}`;
          const job = await provenanceJob(deviceId, 'read-back');
          await rejectsBeforeLocks({
            jobId: job.jobId,
            deviceId,
            sql: 'SELECT cc.claim_device_update_verification($1,$2,$3,$4) AS result',
            values: [customer, job.jobId, JSON.stringify(named), randomUUID()],
          });
          await endJob(job.jobId);
        },
      );

    // Eng-lead ruling 2: the failure of a finish rejects outside its enumeration before any lock. At
    // 768f8c3 the cc.jobs CHECK rejected it after the locks.
    for (const [index, [label, sql, values]] of [
      [
        'a finish preparation',
        prepareSql,
        (job) => [customer, job.jobId, job.token, 'unlisted-failure'],
      ],
      [
        'a final finish',
        'SELECT cc.finish_device_update_job($1,$2,$3,$4) AS result',
        (job) => [customer, job.jobId, job.token, 'unlisted-failure'],
      ],
      [
        'the reaper',
        'SELECT cc.finalize_device_update_job($1,$2,$3) AS result',
        (job) => [customer, job.jobId, 'unlisted-failure'],
      ],
    ].entries())
      await ruleCheck(
        `S2 ${label} rejects a failure outside its enumeration before any lock`,
        async () => {
          const deviceId = `r3f-${index}`;
          const job = await heldJob(deviceId);
          await expireBatches(job.jobId);
          await rejectsBeforeLocks({
            jobId: job.jobId,
            deviceId,
            sql,
            values: values(job),
          });
          await endJob(job.jobId);
        },
      );

    // A start and a batch claim record the execution that runs them. A null execution rejects before
    // any lock. At 768f8c3 the start stored the null, and the claim stored it on the batch row.
    await ruleCheck(
      'S2 a start with a null execution rejects before any lock',
      async () => {
        const job = await makeJob({ devices: ['r3e-a'] });
        const admitted = await admit(false);
        assert.equal(
          admitted.jobId,
          job.jobId,
          'The admission picks this job.',
        );
        await rejectsBeforeLocks({
          jobId: job.jobId,
          deviceId: 'r3e-a',
          sql: 'SELECT cc.record_device_update_start($1,$2,$3,$4) AS result',
          values: [customer, job.jobId, admitted.dispatchToken, null],
        });
        await endJob(job.jobId);
      },
    );

    await ruleCheck(
      'S2 a batch claim with a null execution rejects before any lock',
      async () => {
        const job = await releasedBatch('r3e-b');
        await rejectsBeforeLocks({
          jobId: job.jobId,
          deviceId: 'r3e-b',
          sql: claimSql,
          values: [customer, job.jobId, job.token, 0, randomUUID(), null],
        });
        await endJob(job.jobId);
      },
    );

    // Design sections 5.7 and 5.8 rule 7: a read-back 404 removes its device. The optional provenance
    // does not decide that removal (the class of R2-F1). At 768f8c3 a 404 without verifiedBy kept it.
    await ruleCheck(
      'S2 a read-back 404 without verifiedBy removes its device',
      async () => {
        const deviceId = 'r3g-a';
        const job = await provenanceJob(deviceId, 'read-back');
        const answer = await result(
          settleSql,
          settlementValues(job, 'read-back', [
            {
              operationNumber: 1,
              outcome: 'failed',
              googleStatus: 404,
              googleReason: 'notFound',
              outcomeReason: 'not-found',
            },
          ]),
        );
        assert.deepEqual(
          answer.removed,
          [deviceId],
          'A read-back 404 removes its device without verifiedBy.',
        );
        assert.deepEqual(answer.publication.removedIds, [deviceId]);
        assert.ok((await deviceRow(deviceId)).removed_at instanceof Date);
        await endJob(job.jobId);
      },
    );

    await ruleCheck('S2 control: a write 404 keeps its device', async () => {
      const deviceId = 'r3g-b';
      const job = await provenanceJob(deviceId, 'write');
      const answer = await result(
        settleSql,
        settlementValues(job, 'write', [
          {
            operationNumber: 1,
            outcome: 'failed',
            googleStatus: 404,
            googleReason: 'notFound',
            verifiedBy: 'write-response',
            outcomeReason: 'not-found',
          },
        ]),
      );
      assert.deepEqual(answer.removed, []);
      assert.equal((await deviceRow(deviceId)).removed_at, null);
      await endJob(job.jobId);
    });

    // A settlement that publishes writes an overlay row, and the overlay and publication rows reference
    // the connection row. The settlement locks both before its last clock read, so no write waits on
    // them. At 768f8c3 the overlay insert waited inside its statement, and later writes used the clock
    // from before that wait.
    const publishingSettlement = (job) =>
      settlementValues(job, 'write', [
        {
          operationNumber: 1,
          outcome: 'succeeded',
          values: { annotatedLocation: 'Room 12' },
          verifiedBy: 'write-response',
        },
      ]);
    // Every publication of a call and the change stamp of its header follow the waits of that call.
    const lastPublication = async () =>
      (
        await adminRow(
          'SELECT COALESCE(max(publication_id),0)::text AS id FROM cc.job_publications',
        )
      ).id;
    const publishedAfter = async (jobId, since, releasedAt) => {
      assert.ok(
        (await jobRow(jobId)).changed_at >= releasedAt,
        'The call stamps its header change after the wait.',
      );
      const rows = await admin(
        'SELECT created_at FROM cc.job_publications WHERE job_id=$1 AND publication_id>$2::bigint',
        [jobId, since],
      );
      assert.ok(rows.length > 0, 'The call records a publication.');
      for (const row of rows)
        assert.ok(
          row.created_at >= releasedAt,
          'The call records its publication after the wait.',
        );
    };
    const stampedAfter = async (job, deviceId, answer, releasedAt, since) => {
      assert.equal(answer.code, undefined, answer.message);
      assert.deepEqual(answer.rows[0].result.published, [deviceId]);
      const settled = await adminRow(
        'SELECT status,updated_at FROM cc.device_update_operations WHERE job_id=$1 AND operation_number=1',
        [job.jobId],
      );
      assert.equal(settled.status, 'succeeded');
      assert.ok(
        settled.updated_at >= releasedAt,
        'The settlement stamps its operation after the wait.',
      );
      assert.ok(
        (await detailRow(job.jobId)).heartbeat_at >= releasedAt,
        'The settlement stamps its heartbeat after the wait.',
      );
      assert.equal((await overlay(deviceId)).value, 'Room 12');
      await publishedAfter(job.jobId, since, releasedAt);
    };

    await ruleCheck(
      'S1 a settlement that waits on the connection row stamps its writes after the wait',
      async () => {
        const deviceId = 'r3c-a';
        const job = await provenanceJob(deviceId, 'write');
        const since = await lastPublication();
        const { answer, releasedAt } = await waitedOn({
          rows: [heldConnectionRow()],
          sql: settleSql,
          values: publishingSettlement(job),
          during: () => sleep(200),
        });
        await stampedAfter(job, deviceId, answer, releasedAt, since);
        await endJob(job.jobId);
      },
    );

    await ruleCheck(
      'S1 a settlement that waits on the overlay row stamps its writes after the wait',
      async () => {
        const deviceId = 'r3c-b';
        const job = await provenanceJob(deviceId, 'write');
        // An earlier write left a live overlay on the device.
        await migrator.query(
          `INSERT INTO cc.device_write_overlays(customer_id,device_id,field,value,observed_at,source,job_id,
            operation_number,expires_at) VALUES($1,$2,'annotatedLocation','Earlier',
            clock_timestamp()-interval '1 hour','write-response',$3,1,clock_timestamp()+interval '35 hours')`,
          [customer, deviceId, job.jobId],
        );
        const since = await lastPublication();
        const { answer, releasedAt } = await waitedOn({
          rows: [
            [
              'SELECT 1 FROM cc.device_write_overlays WHERE customer_id=$1 AND device_id=$2 FOR UPDATE',
              [customer, deviceId],
            ],
          ],
          sql: settleSql,
          values: publishingSettlement(job),
          during: () => sleep(200),
        });
        await stampedAfter(job, deviceId, answer, releasedAt, since);
        await endJob(job.jobId);
      },
    );

    // A full-sync finish takes the connection row first and its device rows second
    // (016-device-inventory.sql, cc.finish_device_sync). A settlement takes the connection row before its
    // device rows, so it holds no device row while it waits on the connection row, and the two calls never
    // form a lock cycle. At 768f8c3 the overlay insert took the connection row after the device row.
    await ruleCheck(
      'S1 a settlement that waits on the connection row holds no device row in that wait',
      async () => {
        const deviceId = 'r3c-c';
        const job = await provenanceJob(deviceId, 'write');
        const holder = await connect('cc-migrator', 'cc-app');
        const caller = await connect('cc-app', 'cc-app');
        const probe = await connect('cc-migrator', 'cc-app');
        let pending = null;
        try {
          await holder.query('BEGIN');
          await holder.query(...heldConnectionRow());
          const holderPid = await pidOf(holder);
          const callerPid = await pidOf(caller);
          pending = caller.query(settleSql, publishingSettlement(job)).then(
            (queried) => ({ rows: queried.rows }),
            (error) => ({ code: error.code, message: error.message }),
          );
          assert.equal(
            await waitsFor(callerPid, holderPid),
            true,
            'The settlement waits on the connection row.',
          );
          await probe.query('BEGIN');
          const free = await probe
            .query(
              'SELECT 1 FROM cc.devices WHERE customer_id=$1 AND device_id=$2 FOR UPDATE NOWAIT',
              [customer, deviceId],
            )
            .then(
              () => true,
              (error) => error.code,
            );
          await probe.query('ROLLBACK');
          assert.equal(
            free,
            true,
            'The device row stays free while the settlement waits on the connection row.',
          );
          await holder.query('ROLLBACK');
          const answer = await pending;
          assert.equal(answer.code, undefined, answer.message);
          assert.deepEqual(answer.rows[0].result.published, [deviceId]);
        } finally {
          await probe.query('ROLLBACK').catch(() => undefined);
          await holder.query('ROLLBACK').catch(() => undefined);
          if (pending) await pending;
          await Promise.allSettled([probe.end(), holder.end(), caller.end()]);
        }
        await endJob(job.jobId);
      },
    );

    // R2-F2: a stopped claim locks every pending operation of its job first. After that wait it reads a
    // fresh clock and rechecks its token before it writes. At 768f8c3 the skip update waited on its rows
    // and stamped them with the clock from before that wait.
    const skipStamps = (jobId) =>
      admin(
        `SELECT operation_number,status,outcome_reason,updated_at FROM cc.device_update_operations
          WHERE job_id=$1 ORDER BY operation_number`,
        [jobId],
      );

    await ruleCheck(
      'R2-F2 an initial stop stamps its skipped operation after the operation wait',
      async () => {
        const job = await releasedBatch('r3s-a');
        await disable(job)();
        const { answer, releasedAt } = await waitedOn({
          rows: [heldOperationRow(job.jobId)],
          ...nextClaim(job),
          during: () => sleep(200),
        });
        assert.equal(answer.code, undefined, answer.message);
        assert.equal(answer.rows[0].result.outcome, 'stopped');
        assert.equal(answer.rows[0].result.failure, 'permission-changed');
        assert.equal(answer.rows[0].result.envelope, undefined);
        const rows = await skipStamps(job.jobId);
        assert.deepEqual(
          rows.map((row) => [row.status, row.outcome_reason]),
          [['skipped', 'permission-changed']],
        );
        assert.ok(
          rows[0].updated_at >= releasedAt,
          'A skip stamps its operation from the clock after the operation wait.',
        );
        await endJob(job.jobId);
      },
    );

    await ruleCheck(
      'R2-F2 a stop found after another wait stamps every skipped operation after the skip wait',
      async () => {
        const owner = await principal(`${randomUUID()}`, [
          ['devices:read', district()],
          ['devices:write', district()],
          ['devices:bulk-actions', district()],
        ]);
        const job = await makeJob({
          devices: ['r3s-b1', 'r3s-b2'],
          batchSize: 1,
          createdBy: owner,
        });
        const admitted = await admit(false);
        assert.equal(
          admitted.jobId,
          job.jobId,
          'The admission picks this job.',
        );
        const first = await connect('cc-migrator', 'cc-app');
        const second = await connect('cc-migrator', 'cc-app');
        const caller = await connect('cc-app', 'cc-app');
        let pending = null;
        try {
          // The claim of batch 0 waits on its own operation. The confirmer loses access in that wait.
          // The other batch keeps a pending operation that a second session holds.
          await first.query('BEGIN');
          await first.query(...heldOperation(job.jobId, 1));
          await second.query('BEGIN');
          await second.query(...heldOperation(job.jobId, 2));
          const firstPid = await pidOf(first);
          const secondPid = await pidOf(second);
          const callerPid = await pidOf(caller);
          pending = caller
            .query(claimSql, [
              customer,
              job.jobId,
              admitted.dispatchToken,
              0,
              randomUUID(),
              'r3-next',
            ])
            .then(
              (queried) => ({ rows: queried.rows }),
              (error) => ({ code: error.code, message: error.message }),
            );
          assert.equal(
            await waitsFor(callerPid, firstPid),
            true,
            'The claim waits on the operation of its batch.',
          );
          await migrator.query(
            'UPDATE cc.application_principals SET enabled=false WHERE id=$1',
            [owner],
          );
          await first.query('ROLLBACK');
          assert.equal(
            await waitsFor(callerPid, secondPid),
            true,
            'The stopped claim waits on the pending operation of the other batch.',
          );
          await sleep(200);
          const releasedAt = (
            await second.query('SELECT clock_timestamp() AS at')
          ).rows[0].at;
          await second.query('ROLLBACK');
          const answer = await pending;
          assert.equal(answer.code, undefined, answer.message);
          assert.equal(answer.rows[0].result.outcome, 'stopped');
          assert.equal(answer.rows[0].result.failure, 'permission-changed');
          const rows = await skipStamps(job.jobId);
          assert.deepEqual(
            rows.map((row) => row.status),
            ['skipped', 'skipped'],
          );
          for (const row of rows)
            assert.ok(
              row.updated_at >= releasedAt,
              `Operation ${row.operation_number} takes its skip stamp after the skip wait.`,
            );
        } finally {
          await first.query('ROLLBACK').catch(() => undefined);
          await second.query('ROLLBACK').catch(() => undefined);
          if (pending) await pending;
          await Promise.allSettled([first.end(), second.end(), caller.end()]);
        }
        await endJob(job.jobId);
      },
    );

    // B2c R1-F1: a stop that a later wait finds skips every pending operation of the job. That set
    // locks in operation_number order before the detail row, so a claim that waits on another batch's
    // operation holds no detail row in that wait. At 3804b6b the claim locked the detail row first.
    await ruleCheck(
      'B2c R1-F1 a late stop takes the pending operation set before the detail row',
      async () => {
        const owner = await principal(`${randomUUID()}`, [
          ['devices:read', district()],
          ['devices:write', district()],
          ['devices:bulk-actions', district()],
        ]);
        const job = await makeJob({
          devices: ['r1f1-a', 'r1f1-b'],
          batchSize: 1,
          createdBy: owner,
        });
        const admitted = await admit(false);
        assert.equal(
          admitted.jobId,
          job.jobId,
          'The admission picks this job.',
        );
        const first = await connect('cc-migrator', 'cc-app');
        const second = await connect('cc-migrator', 'cc-app');
        const observer = await connect('cc-migrator', 'cc-app');
        const caller = await connect('cc-app', 'cc-app');
        let pending = null;
        try {
          // The claim of batch 0 waits on its own operation. The confirmer loses access in that wait.
          // The other batch keeps a pending operation that a second session holds.
          await first.query('BEGIN');
          await first.query(...heldOperation(job.jobId, 1));
          await second.query('BEGIN');
          await second.query(...heldOperation(job.jobId, 2));
          const firstPid = await pidOf(first);
          const secondPid = await pidOf(second);
          const callerPid = await pidOf(caller);
          pending = caller
            .query(claimSql, [
              customer,
              job.jobId,
              admitted.dispatchToken,
              0,
              randomUUID(),
              'r1f1-next',
            ])
            .then(
              (queried) => ({ rows: queried.rows }),
              (error) => ({ code: error.code, message: error.message }),
            );
          assert.equal(
            await waitsFor(callerPid, firstPid),
            true,
            'The claim waits on the operation of its batch.',
          );
          await migrator.query(
            'UPDATE cc.application_principals SET enabled=false WHERE id=$1',
            [owner],
          );
          await first.query('ROLLBACK');
          assert.equal(
            await waitsFor(callerPid, secondPid),
            true,
            'The stopped claim waits on the pending operation of the other batch.',
          );
          await observer.query('BEGIN');
          const detail = await observer
            .query(
              'SELECT 1 FROM cc.device_update_jobs WHERE job_id=$1 FOR UPDATE NOWAIT',
              [job.jobId],
            )
            .then(
              () => true,
              (error) => error.code,
            );
          await observer.query('ROLLBACK');
          assert.equal(
            detail,
            true,
            'The late stop holds no detail row while it waits on a pending operation.',
          );
          await second.query('ROLLBACK');
          const answer = await pending;
          assert.equal(answer.code, undefined, answer.message);
          assert.equal(answer.rows[0].result.outcome, 'stopped');
          assert.equal(answer.rows[0].result.failure, 'permission-changed');
          assert.deepEqual(
            (await skipStamps(job.jobId)).map((row) => [
              row.status,
              row.outcome_reason,
            ]),
            [
              ['skipped', 'permission-changed'],
              ['skipped', 'permission-changed'],
            ],
          );
        } finally {
          await observer.query('ROLLBACK').catch(() => undefined);
          await first.query('ROLLBACK').catch(() => undefined);
          await second.query('ROLLBACK').catch(() => undefined);
          if (pending) await pending;
          await Promise.allSettled([
            observer.end(),
            first.end(),
            second.end(),
            caller.end(),
          ]);
        }
        await endJob(job.jobId);
      },
    );

    await ruleCheck(
      'R2-F2 a stopped claim returns superseded when the token rotates in the skip wait',
      async () => {
        const job = await releasedBatch('r3s-c');
        await disable(job)();
        const before = await jobState(job.jobId, 'r3s-c');
        const { answer } = await waitedOn({
          rows: [heldOperationRow(job.jobId)],
          ...nextClaim(job),
          during: () => rotateToken(job.jobId),
        });
        assert.equal(answer.code, undefined, answer.message);
        assert.equal(
          answer.rows[0].result.outcome,
          'superseded',
          'A stopped claim rechecks its token after the skip wait.',
        );
        const after = await jobState(job.jobId, 'r3s-c');
        assert.notEqual(
          after.detail.dispatch_token,
          before.detail.dispatch_token,
        );
        // B2c item 23: the stopped answer writes heartbeat_at and first_claimed_at, so a superseded
        // call must change neither of them.
        assert.equal(
          after.detail.heartbeat_at?.getTime(),
          before.detail.heartbeat_at?.getTime(),
          'A superseded stopped claim writes no heartbeat.',
        );
        assert.equal(
          after.detail.first_claimed_at?.getTime(),
          before.detail.first_claimed_at?.getTime(),
          'A superseded stopped claim writes no first claim.',
        );
        assert.deepEqual(
          { ...after, detail: null },
          { ...before, detail: null },
          'A superseded stop changes nothing.',
        );
        await endJob(job.jobId);
      },
    );

    // The class of the connection wait: every writer that publishes inserts a publication row, and that row
    // references the connection row. A credential or token read holds the connection row FOR UPDATE
    // (008-google-token-coordination.sql), so the insert check waits on it. Each writer locks the connection
    // row before its last clock read, so no write waits on it (round 3). At 768f8c3 the publication insert
    // waited, and the writes of the call used the clock from before that wait.
    const connectionWait = (sql, values) =>
      waitedOn({
        rows: [heldConnectionRow()],
        sql,
        values,
        during: () => sleep(200),
      });

    await ruleCheck(
      'S1 an admission that waits on the connection row stamps its writes after the wait',
      async () => {
        const job = await makeJob({ devices: ['r3n-a'] });
        const since = await lastPublication();
        const { answer, releasedAt } = await connectionWait(admitSql, [
          customer,
          false,
        ]);
        assert.equal(answer.code, undefined, answer.message);
        assert.equal(answer.rows[0].result?.jobId, job.jobId);
        const saved = await adminRow(
          `SELECT j.admitted_at,u.start_deadline_at FROM cc.jobs j
            JOIN cc.device_update_jobs u ON u.job_id=j.job_id WHERE j.job_id=$1`,
          [job.jobId],
        );
        assert.ok(
          saved.admitted_at >= releasedAt,
          'The admission stamps admitted_at after the wait.',
        );
        assert.ok(
          saved.start_deadline_at.getTime() >= releasedAt.getTime() + 120000,
          'A connection wait must not consume the start window.',
        );
        await publishedAfter(job.jobId, since, releasedAt);
        await endJob(job.jobId);
      },
    );

    await ruleCheck(
      'S1 a held admission that waits on the connection row stamps its change after the wait',
      async () => {
        const job = await makeJob({ devices: ['r3n-b'] });
        const since = await lastPublication();
        const { answer, releasedAt } = await connectionWait(admitSql, [
          customer,
          true,
        ]);
        assert.equal(answer.code, undefined, answer.message);
        assert.equal((await jobRow(job.jobId)).status, 'held');
        await publishedAfter(job.jobId, since, releasedAt);
        await endJob(job.jobId);
      },
    );

    await ruleCheck(
      'S1 an abandoned start that waits on the connection row stamps its writes after the wait',
      async () => {
        const job = await makeJob({ devices: ['r3n-c'] });
        const admitted = await admit(false);
        assert.equal(
          admitted.jobId,
          job.jobId,
          'The admission picks this job.',
        );
        const since = await lastPublication();
        const { answer, releasedAt } = await connectionWait(
          'SELECT cc.abandon_device_update_start($1,$2,$3) AS result',
          [customer, job.jobId, admitted.dispatchToken],
        );
        assert.equal(answer.code, undefined, answer.message);
        const saved = await jobRow(job.jobId);
        assert.equal(saved.status, 'failed');
        assert.ok(
          saved.finished_at >= releasedAt,
          'The closure stamps finished_at after the wait.',
        );
        const rows = await skipStamps(job.jobId);
        assert.deepEqual(
          rows.map((row) => row.status),
          ['skipped'],
        );
        assert.ok(
          rows[0].updated_at >= releasedAt,
          'The closure stamps its skip after the wait.',
        );
        await publishedAfter(job.jobId, since, releasedAt);
      },
    );

    await ruleCheck(
      'S1 a stopped claim that waits on the connection row stamps its writes after the wait',
      async () => {
        const job = await releasedBatch('r3n-d');
        await disable(job)();
        const since = await lastPublication();
        const { sql, values } = nextClaim(job);
        const { answer, releasedAt } = await connectionWait(sql, values);
        assert.equal(answer.code, undefined, answer.message);
        assert.equal(answer.rows[0].result.outcome, 'stopped');
        assert.equal(answer.rows[0].result.envelope, undefined);
        const rows = await skipStamps(job.jobId);
        assert.deepEqual(
          rows.map((row) => row.status),
          ['skipped'],
        );
        assert.ok(
          rows[0].updated_at >= releasedAt,
          'The stop stamps its skip after the wait.',
        );
        await publishedAfter(job.jobId, since, releasedAt);
        await endJob(job.jobId);
      },
    );

    await ruleCheck(
      'S1 a finish preparation that waits on the connection row stamps its writes after the wait',
      async () => {
        const job = await heldJob('r3n-e');
        await expireBatches(job.jobId);
        const since = await lastPublication();
        const { answer, releasedAt } = await connectionWait(prepareSql, [
          customer,
          job.jobId,
          job.token,
          null,
        ]);
        assert.equal(answer.code, undefined, answer.message);
        assert.equal(answer.rows[0].result.outcome, 'ready');
        const fenced = await fenceTime(job.jobId);
        assert.equal(fenced.status, 'unknown');
        assert.ok(
          fenced.verify_after >= releasedAt,
          'The fence time comes from the clock after the wait.',
        );
        await publishedAfter(job.jobId, since, releasedAt);
        await endJob(job.jobId);
      },
    );

    await ruleCheck(
      'S1 a final finish that waits on the connection row stamps its writes after the wait',
      async () => {
        const job = await heldJob('r3n-f');
        await expireBatches(job.jobId);
        assert.equal(
          (await prepareFinish(job.jobId, job.token)).outcome,
          'ready',
        );
        const since = await lastPublication();
        const { answer, releasedAt } = await connectionWait(
          'SELECT cc.finish_device_update_job($1,$2,$3,$4) AS result',
          [customer, job.jobId, job.token, null],
        );
        assert.equal(answer.code, undefined, answer.message);
        assert.equal(answer.rows[0].result.status, 'needs-review');
        assert.ok(
          (await jobRow(job.jobId)).finished_at >= releasedAt,
          'The finish stamps finished_at after the wait.',
        );
        await publishedAfter(job.jobId, since, releasedAt);
      },
    );

    await ruleCheck(
      'S1 a final finish that waits on the connection row returns superseded when the token rotates in the wait',
      async () => {
        const job = await heldJob('r3n-h');
        await expireBatches(job.jobId);
        assert.equal(
          (await prepareFinish(job.jobId, job.token)).outcome,
          'ready',
        );
        const before = await jobRow(job.jobId);
        const published = await publications(job.jobId);
        const { answer } = await waitedOn({
          rows: [heldConnectionRow()],
          sql: 'SELECT cc.finish_device_update_job($1,$2,$3,$4) AS result',
          values: [customer, job.jobId, job.token, null],
          during: () => rotateToken(job.jobId),
        });
        assert.equal(answer.code, undefined, answer.message);
        assert.equal(
          answer.rows[0].result.outcome,
          'superseded',
          'A finish rechecks its token after the connection wait.',
        );
        const after = await jobRow(job.jobId);
        assert.equal(after.status, 'running');
        assert.equal(after.finished_at, null);
        assert.equal(Number(after.revision), Number(before.revision));
        assert.equal(await publications(job.jobId), published);
        await endJob(job.jobId);
      },
    );

    await ruleCheck(
      'S1 the reaper that waits on the connection row stamps its writes after the wait',
      async () => {
        const job = await heldJob('r3n-g');
        await expireBatches(job.jobId);
        const since = await lastPublication();
        const { answer, releasedAt } = await connectionWait(
          'SELECT cc.finalize_device_update_job($1,$2,$3) AS result',
          [customer, job.jobId, null],
        );
        assert.equal(answer.code, undefined, answer.message);
        assert.equal(answer.rows[0].result.outcome, 'finalized');
        assert.ok(
          (await jobRow(job.jobId)).finished_at >= releasedAt,
          'The reaper stamps finished_at after the wait.',
        );
        assert.ok(
          (await fenceTime(job.jobId)).verify_after >= releasedAt,
          'The fence time comes from the clock after the wait.',
        );
        await publishedAfter(job.jobId, since, releasedAt);
      },
    );

    // R2-F3 and R2-F4 name the source order of two writers. Neither function stores the clock that the
    // rule adds, so these checks read the function source from the catalog.
    const sourceLines = async (signature) =>
      (
        await adminRow(
          'SELECT prosrc FROM pg_proc WHERE oid=to_regprocedure($1)',
          [signature],
        )
      ).prosrc.split('\n');
    const linesOf = (lines, pattern) =>
      lines.flatMap((line, index) => (pattern.test(line) ? [index] : []));
    const clockRead = /:=\s*clock_timestamp\(\)/;
    const detailLock = /FROM cc\.device_update_jobs\b.*FOR UPDATE/;

    await ruleCheck(
      'R2-F3 admission reads its clock after the header locks and before the detail lock',
      async () => {
        const lines = await sourceLines(
          'cc.admit_device_update_job(text,boolean)',
        );
        const headerLoop = linesOf(lines, /FOR UPDATE LOOP/);
        assert.equal(
          headerLoop.length,
          1,
          'The admission locks its pending headers in one loop.',
        );
        const loopEnd = linesOf(lines, /END LOOP/).find(
          (index) => index > headerLoop[0],
        );
        const details = linesOf(lines, detailLock);
        assert.equal(details.length, 1, 'The admission locks one detail row.');
        const clocks = linesOf(lines, clockRead);
        assert.ok(
          clocks.some((index) => index > loopEnd && index < details[0]),
          'A clock read follows every header wait and precedes the detail lock.',
        );
        assert.ok(
          clocks.some((index) => index > details[0]),
          'A clock read follows the detail wait.',
        );
      },
    );

    await ruleCheck(
      'R2-F4 a start reads its clock after the detail lock and before its write',
      async () => {
        const lines = await sourceLines(
          'cc.record_device_update_start(text,uuid,uuid,text)',
        );
        const details = linesOf(lines, detailLock);
        const writes = linesOf(lines, /UPDATE cc\.device_update_jobs/);
        assert.equal(details.length, 1, 'The start locks its detail row once.');
        assert.equal(writes.length, 1, 'The start writes its detail row once.');
        const clocks = linesOf(lines, clockRead);
        assert.ok(
          clocks.some((index) => index > details[0] && index < writes[0]),
          'A clock read follows the detail wait and precedes the write.',
        );
      },
    );

    // The failure enumeration reads no table, but it stays an internal helper like the claim revalidation.
    await ruleCheck(
      'S2 the failure enumeration helper is not executable by PUBLIC or the application role',
      async () => {
        const signature = 'cc.job_failure_known(text)';
        const privileges = await adminRow(
          `SELECT count(p.oid)=1 AS present,
            bool_and(p.proacl IS NOT NULL AND NOT EXISTS(SELECT 1 FROM aclexplode(p.proacl) a
              WHERE a.privilege_type='EXECUTE' AND a.grantee<>p.proowner)) AS owner_only
           FROM pg_proc p WHERE p.oid=to_regprocedure($1)`,
          [signature],
        );
        assert.equal(privileges.present, true, `${signature} exists.`);
        assert.equal(
          privileges.owner_only,
          true,
          `${signature} grants EXECUTE to its owner only.`,
        );
      },
    );

    // ---- B2c: the worker contract checks of the addendum (addendum:723-783) and the F1 lock order.
    // Item numbers below are the item numbers of the card, so they keep the addendum numbers. ----
    const claimChunk = (jobId, cursor, limit, attempt = randomUUID()) =>
      result(
        'SELECT cc.claim_device_update_verification($1,$2,$3,$4,$5,$6) AS result',
        [customer, jobId, null, attempt, cursor, limit],
      );
    const readVerification = (jobId, operations, attempt) =>
      result(
        'SELECT cc.read_device_update_verification($1,$2,$3,$4) AS result',
        [customer, jobId, attempt, JSON.stringify(operations)],
      );
    const settleSql9 =
      'SELECT cc.settle_device_update_operations($1,$2,$3,$4,$5,$6,$7,$8,$9) AS result';
    const settleWith = (
      jobId,
      token,
      attempt,
      kind,
      outcomes,
      observedAt,
      failure = null,
      scopeFailure = null,
    ) =>
      result(settleSql9, [
        customer,
        jobId,
        token,
        attempt,
        kind,
        JSON.stringify(outcomes),
        observedAt,
        failure,
        scopeFailure,
      ]);
    const scopeRow = (jobId) =>
      adminRow(
        'SELECT scope_observations,scope_failure FROM cc.device_update_jobs WHERE job_id=$1',
        [jobId],
      );
    const unknownOperations = (jobId) =>
      admin(
        'UPDATE cc.device_update_operations SET status=$2 WHERE job_id=$1',
        [jobId, 'unknown'],
      );
    const newestPublication = (jobId) =>
      adminRow(
        `SELECT publication_id,revision,status_changed FROM cc.job_publications
          WHERE job_id=$1 ORDER BY publication_id DESC LIMIT 1`,
        [jobId],
      );
    // A job that holds one claimed batch. The admission picks it, and the harness closes every other
    // open write job before the check runs.
    const claimedJob = async (devices, batchSize = devices.length) => {
      const job = await makeJob({ devices, batchSize });
      const admitted = await admit(false);
      assert.equal(admitted.jobId, job.jobId, 'The admission picks this job.');
      const attempt = randomUUID();
      const claimed = await claim(
        job.jobId,
        admitted.dispatchToken,
        0,
        attempt,
      );
      assert.equal(claimed.outcome, 'claimed');
      return { ...job, token: admitted.dispatchToken, attempt, claimed };
    };
    const newOwner = async () =>
      principal(`${randomUUID()}`, [
        ['devices:read', district()],
        ['devices:write', district()],
        ['devices:bulk-actions', district()],
      ]);

    // Item 1: one pass claims 1,001 unknown operations in chunks of 250, each exactly once.
    await ruleCheck(
      'B2c item 1 the read-back claim returns 1,001 unknown operations in chunks of 250',
      async () => {
        const devices = Array.from(
          { length: 1001 },
          (_, index) => `b2c1-${index}`,
        );
        const job = await makeJob({ devices, batchSize: 250 });
        await unknownOperations(job.jobId);
        const lengths = [];
        const numbers = [];
        let cursor = 0;
        for (let round = 0; round < 6; round += 1) {
          const chunk = await claimChunk(job.jobId, cursor, 250);
          lengths.push(chunk.length);
          numbers.push(...chunk.map((row) => row.operationNumber));
          if (chunk.length > 0) cursor = chunk.at(-1).operationNumber;
        }
        assert.deepEqual(lengths, [250, 250, 250, 250, 1, 0]);
        assert.deepEqual(
          numbers,
          Array.from({ length: 1001 }, (_, index) => index + 1),
          'Each pass claims each operation once.',
        );
        await endJob(job.jobId);
      },
    );

    // Item 2: a completed chunk claim holds only the rows of its chunk, and no row outside the chunk.
    await ruleCheck(
      'B2c item 2 a chunk claim locks only its chunk',
      async () => {
        const job = await makeJob({
          devices: ['b2c2-a', 'b2c2-b'],
          batchSize: 2,
        });
        await unknownOperations(job.jobId);
        const claimer = await connect('cc-app', 'cc-app');
        const control = await connect('cc-migrator', 'cc-app');
        const observer = await connect('cc-migrator', 'cc-app');
        try {
          // The claim runs inside its own transaction, so every lock that it took is still held when
          // the probes ask for the rows.
          await claimer.query('BEGIN');
          const answer = await claimer.query(
            'SELECT cc.claim_device_update_verification($1,$2,$3,$4,$5,$6) AS result',
            [customer, job.jobId, null, randomUUID(), 0, 1],
          );
          assert.deepEqual(
            answer.rows[0].result.map((row) => row.operationNumber),
            [1],
          );
          await control.query('BEGIN');
          const inside = await control
            .query(
              'SELECT 1 FROM cc.device_update_operations WHERE job_id=$1 AND operation_number=1 FOR UPDATE NOWAIT',
              [job.jobId],
            )
            .then(
              () => true,
              (error) => error.code,
            );
          await control.query('ROLLBACK');
          assert.equal(
            inside,
            '55P03',
            'The completed claim holds the operation of its chunk.',
          );
          await observer.query('BEGIN');
          const outside = await observer
            .query(
              'SELECT 1 FROM cc.device_update_operations WHERE job_id=$1 AND operation_number=2 FOR UPDATE NOWAIT',
              [job.jobId],
            )
            .then(
              () => true,
              (error) => error.code,
            );
          await observer.query('ROLLBACK');
          assert.equal(
            outside,
            true,
            'A completed chunk claim leaves an operation outside the chunk free.',
          );
        } finally {
          await claimer.query('ROLLBACK').catch(() => undefined);
          await Promise.allSettled([
            control.end(),
            observer.end(),
            claimer.end(),
          ]);
        }
        await endJob(job.jobId);
      },
    );

    // Item 3: a negative cursor and a limit outside 1 to 250 reject before any lock.
    await ruleCheck(
      'B2c item 3 a bad cursor or limit rejects before any lock',
      async () => {
        const job = await heldJob('b2c3-a');
        for (const values of [
          [customer, job.jobId, null, job.attempt, -1, null],
          [customer, job.jobId, null, job.attempt, 0, 0],
          [customer, job.jobId, null, job.attempt, 0, 251],
        ])
          await rejectsBeforeLocks({
            jobId: job.jobId,
            deviceId: 'b2c3-a',
            sql: 'SELECT cc.claim_device_update_verification($1,$2,$3,$4,$5,$6) AS result',
            values,
          });
        await endJob(job.jobId);
      },
    );

    // Item 4: a null cursor and a null limit claim every eligible operation.
    await ruleCheck(
      'B2c item 4 a null cursor and a null limit claim every eligible operation',
      async () => {
        const job = await makeJob({ devices: ['b2c4-a', 'b2c4-b', 'b2c4-c'] });
        await unknownOperations(job.jobId);
        const chunk = await claimChunk(job.jobId, null, null);
        assert.deepEqual(
          chunk.map((row) => row.operationNumber),
          [1, 2, 3],
        );
        await endJob(job.jobId);
      },
    );

    // Item 5: the read-back exception acts on a terminal job, so a chunk claim still returns its
    // unknown operations after the final finish answers needs-review.
    await ruleCheck(
      'B2c item 5 a chunk claim claims the unknown operations of a terminal job',
      async () => {
        const job = await makeJob({
          devices: ['b2c5-a', 'b2c5-b'],
          batchSize: 2,
        });
        const admitted = await admit(false);
        assert.equal(
          admitted.jobId,
          job.jobId,
          'The admission picks this job.',
        );
        const attempt = randomUUID();
        await claim(job.jobId, admitted.dispatchToken, 0, attempt);
        await settle(
          job.jobId,
          admitted.dispatchToken,
          attempt,
          'write',
          [
            {
              operationNumber: 1,
              outcome: 'succeeded',
              values: { annotatedLocation: 'Room 12' },
              verifiedBy: 'write-response',
            },
          ],
          new Date(),
        );
        assert.equal(
          (
            await prepareFinish(
              job.jobId,
              admitted.dispatchToken,
              'network-failure',
            )
          ).outcome,
          'ready',
        );
        const finished = await finishJob(job.jobId);
        assert.equal(finished.status, 'needs-review');
        const chunk = await claimChunk(job.jobId, 0, 250);
        assert.deepEqual(
          chunk.map((row) => row.operationNumber),
          [2],
          'The terminal job still claims its unknown operation.',
        );
        await endJob(job.jobId);
      },
    );

    // Item 6: one attempt holds two listed operations, so the answer carries the envelope and both.
    await ruleCheck(
      'B2c item 6 an attempt that holds two listed operations receives held',
      async () => {
        const job = await claimedJob(['b2c6-a', 'b2c6-b']);
        await settleWith(
          job.jobId,
          job.token,
          job.attempt,
          'write',
          [
            {
              operationNumber: 1,
              outcome: 'unknown',
              verifiedBy: 'write-response',
            },
            {
              operationNumber: 2,
              outcome: 'unknown',
              verifiedBy: 'write-response',
            },
          ],
          new Date(),
        );
        const answer = await readVerification(job.jobId, [1, 2], job.attempt);
        assert.equal(answer.outcome, 'held');
        assert.equal(answer.generation, generation);
        assert.equal(answer.credentialId, connection.credential_id);
        assert.equal(typeof answer.envelope, 'object');
        assert.equal(typeof answer.checkedAt, 'string');
        assert.equal(Number.isNaN(Date.parse(answer.checkedAt)), false);
        assert.deepEqual(
          answer.operations.map((row) => row.operationNumber),
          [1, 2],
        );
        assert.deepEqual(
          answer.operations.map((row) => row.deviceId),
          ['b2c6-a', 'b2c6-b'],
        );
        for (const row of answer.operations) {
          assert.equal(row.serialNumber, `SN-${row.deviceId}`);
          // An update keeps its values in the operation's field rows (addendum section 2).
          assert.equal(row.baselineValue, null);
          assert.equal(row.requestedValue, null);
          assert.deepEqual(row.fields, [
            {
              field: 'annotatedLocation',
              baselineValue: null,
              requestedValue: 'Room 12',
            },
          ]);
          assert.equal(typeof row.verifyAfter, 'string');
          assert.equal(typeof row.verifyLeaseExpiresAt, 'string');
        }
        await stop(job.jobId, job.token, 0, job.attempt);
        await endJob(job.jobId);
      },
    );

    // Item 7: every hold that does not match answers not-held without an envelope.
    await ruleCheck(
      'B2c item 7 a foreign attempt, a lapsed lease, a settled operation, and an unlisted operation give not-held',
      async () => {
        const job = await claimedJob(['b2c7-a', 'b2c7-b']);
        await settleWith(
          job.jobId,
          job.token,
          job.attempt,
          'write',
          [
            {
              operationNumber: 1,
              outcome: 'unknown',
              verifiedBy: 'write-response',
            },
            {
              operationNumber: 2,
              outcome: 'unknown',
              verifiedBy: 'write-response',
            },
          ],
          new Date(),
        );
        assert.equal(
          (await readVerification(job.jobId, [1, 2], job.attempt)).outcome,
          'held',
        );
        assert.deepEqual(
          await readVerification(job.jobId, [1, 2], randomUUID()),
          { outcome: 'not-held' },
          'Another attempt holds no listed operation.',
        );
        assert.deepEqual(
          await readVerification(job.jobId, [99], job.attempt),
          { outcome: 'not-held' },
          'An operation outside the list is not a hold.',
        );
        await migrator.query(
          `UPDATE cc.device_update_operations SET verify_lease_expires_at=clock_timestamp()-interval '1 minute'
            WHERE job_id=$1 AND operation_number=1`,
          [job.jobId],
        );
        assert.deepEqual(
          await readVerification(job.jobId, [1], job.attempt),
          { outcome: 'not-held' },
          'A lapsed lease is not a hold.',
        );
        const settled = await settleWith(
          job.jobId,
          null,
          job.attempt,
          'read-back',
          [
            {
              operationNumber: 2,
              outcome: 'succeeded',
              values: { annotatedLocation: 'Room 12' },
              verifiedBy: 'read-back',
            },
          ],
          new Date(),
        );
        assert.equal(settled.settled.length, 1);
        assert.deepEqual(
          await readVerification(job.jobId, [2], job.attempt),
          { outcome: 'not-held' },
          'A settled operation is not a hold.',
        );
        await stop(job.jobId, job.token, 0, job.attempt);
        await endJob(job.jobId);
      },
    );

    // Item 8: the global lock comes first, so no row is held while the read waits for it.
    await ruleCheck(
      'B2c item 8 a verification read takes the global access lock before any row lock',
      async () => {
        const job = await provenanceJob('b2c8-a', 'read-back');
        await globalLockFirst({
          name: 'A verification read',
          sql: 'SELECT cc.read_device_update_verification($1,$2,$3,$4) AS result',
          values: [customer, job.jobId, job.attempt, JSON.stringify([1])],
          free: [
            freeHeader(job.jobId),
            [
              'detail',
              'SELECT 1 FROM cc.device_update_jobs WHERE job_id=$1 FOR UPDATE NOWAIT',
              [job.jobId],
            ],
            [
              'operation',
              'SELECT 1 FROM cc.device_update_operations WHERE job_id=$1 FOR UPDATE NOWAIT',
              [job.jobId],
            ],
          ],
        });
        assert.equal(
          (await readVerification(job.jobId, [1], job.attempt)).outcome,
          'held',
        );
        await endJob(job.jobId);
      },
    );

    // Item 9: the credential read raises the detail of a moved generation and of a disconnected
    // connection.
    await ruleCheck(
      'B2c item 9 a verification read raises the credential detail',
      async () => {
        const job = await provenanceJob('b2c9-a', 'read-back');
        const read = () =>
          result(
            'SELECT cc.read_device_update_verification($1,$2,$3,$4) AS result',
            [customer, job.jobId, job.attempt, JSON.stringify([1])],
          );
        await migrator.query(
          'UPDATE cc.jobs SET generation=generation+1 WHERE job_id=$1',
          [job.jobId],
        );
        await rejects(read(), null, 'credential-changed');
        await migrator.query(
          'UPDATE cc.jobs SET generation=$2 WHERE job_id=$1',
          [job.jobId, generation],
        );
        await migrator.query(
          'UPDATE cc.google_connection SET active=false WHERE customer_id=$1',
          [customer],
        );
        await rejects(read(), null, 'connection-disconnected');
        await migrator.query(
          'UPDATE cc.google_connection SET active=true WHERE customer_id=$1',
          [customer],
        );
        await endJob(job.jobId);
      },
    );

    // Item 10: a null input and a list outside its domain reject before any lock. The holder takes the
    // global access lock, the first lock that this read takes (R1-F3).
    await ruleCheck(
      'B2c item 10 a null input and an invalid list reject before any lock',
      async () => {
        const job = await provenanceJob('b2c10-a', 'read-back');
        const before = await jobState(job.jobId, 'b2c10-a');
        for (const values of [
          [customer, null, job.attempt, JSON.stringify([1])],
          [null, job.jobId, job.attempt, JSON.stringify([1])],
          [customer, job.jobId, null, JSON.stringify([1])],
          [customer, job.jobId, job.attempt, null],
          [customer, job.jobId, job.attempt, JSON.stringify([])],
          [
            customer,
            job.jobId,
            job.attempt,
            JSON.stringify(
              Array.from({ length: 251 }, (_, index) => index + 1),
            ),
          ],
          [customer, job.jobId, job.attempt, JSON.stringify([0])],
          [customer, job.jobId, job.attempt, JSON.stringify([1.5])],
          [customer, job.jobId, job.attempt, JSON.stringify(['1'])],
        ])
          await rejectsBeforeGlobalLock({
            sql: 'SELECT cc.read_device_update_verification($1,$2,$3,$4) AS result',
            values,
          });
        assert.deepEqual(
          await jobState(job.jobId, 'b2c10-a'),
          before,
          'An invalid verification read changes nothing.',
        );
        await endJob(job.jobId);
      },
    );

    // Item 10, R1-F3: the read repeats its hold after the connection wait. A hold that lapses in that
    // wait answers not-held with no envelope, and a hold that stays answers held with a post-wait
    // checkedAt (Q4).
    await ruleCheck(
      'B2c item 10 a verification read repeats its hold after the connection wait',
      async () => {
        const held = await provenanceJob('b2c10-held', 'read-back');
        const kept = await waitedOn({
          rows: [heldConnectionRow()],
          sql: 'SELECT cc.read_device_update_verification($1,$2,$3,$4) AS result',
          values: [customer, held.jobId, held.attempt, JSON.stringify([1])],
          during: () => sleep(200),
        });
        assert.equal(kept.answer.code, undefined, kept.answer.message);
        assert.equal(
          kept.answer.rows[0].result.outcome,
          'held',
          'A hold that stays across the connection wait answers held.',
        );
        assert.ok(
          Date.parse(kept.answer.rows[0].result.checkedAt) >=
            kept.releasedAt.getTime(),
          'The checkedAt of a held answer follows the connection wait.',
        );
        await endJob(held.jobId);

        const lapsed = await provenanceJob('b2c10-lapsed', 'read-back');
        const gone = await waitedOn({
          rows: [heldConnectionRow()],
          sql: 'SELECT cc.read_device_update_verification($1,$2,$3,$4) AS result',
          values: [customer, lapsed.jobId, lapsed.attempt, JSON.stringify([1])],
          during: async () => {
            await migrator.query(
              `UPDATE cc.device_update_operations SET verify_lease_expires_at=clock_timestamp()-interval '1 minute'
                WHERE job_id=$1 AND operation_number=1`,
              [lapsed.jobId],
            );
            await sleep(200);
          },
        });
        assert.equal(gone.answer.code, undefined, gone.answer.message);
        assert.deepEqual(
          gone.answer.rows[0].result,
          { outcome: 'not-held' },
          'A hold that lapses in the connection wait answers not-held with no envelope.',
        );
        await endJob(lapsed.jobId);
      },
    );

    // Item 11: the read changes no operation row, header revision, or publication row.
    await ruleCheck(
      'B2c item 11 a verification read changes no row',
      async () => {
        const job = await provenanceJob('b2c11-a', 'read-back');
        const before = await jobState(job.jobId, 'b2c11-a');
        assert.equal(
          (await readVerification(job.jobId, [1], job.attempt)).outcome,
          'held',
        );
        assert.deepEqual(await jobState(job.jobId, 'b2c11-a'), before);
        await endJob(job.jobId);
      },
    );

    // Item 12: the runtime role executes the read, and PUBLIC does not.
    await ruleCheck(
      'B2c item 12 only the runtime role executes a verification read',
      async () => {
        const job = await provenanceJob('b2c12-a', 'read-back');
        assert.equal(
          (await readVerification(job.jobId, [1], job.attempt)).outcome,
          'held',
        );
        const privileges = await adminRow(
          `SELECT count(*)=1 AS present,
            bool_and(EXISTS(SELECT 1 FROM aclexplode(p.proacl) a JOIN pg_roles r ON r.oid=a.grantee
              WHERE a.privilege_type='EXECUTE' AND r.rolname='cc-app')) AS runtime_granted,
            bool_and(NOT EXISTS(SELECT 1 FROM aclexplode(p.proacl) a
              WHERE a.privilege_type='EXECUTE' AND a.grantee=0)) AS public_denied
           FROM pg_proc p WHERE p.oid=to_regprocedure('cc.read_device_update_verification(text,uuid,uuid,jsonb)')`,
        );
        assert.equal(privileges.present, true);
        assert.equal(privileges.runtime_granted, true);
        assert.equal(privileges.public_denied, true);
        await endJob(job.jobId);
      },
    );

    // Item 13: a write settlement records the outcomes, the failure, one revision, and one publication.
    await ruleCheck(
      'B2c item 13 a write settlement records its outcomes, the job failure, one revision, and one publication',
      async () => {
        const job = await claimedJob(
          ['b2c13-a', 'b2c13-b', 'b2c13-c', 'b2c13-d'],
          2,
        );
        const before = await jobRow(job.jobId);
        const published = await publications(job.jobId);
        const answer = await settleWith(
          job.jobId,
          job.token,
          job.attempt,
          'write',
          [
            {
              operationNumber: 1,
              outcome: 'failed',
              googleStatus: 403,
              googleReason: 'forbidden',
              verifiedBy: 'write-response',
            },
            {
              operationNumber: 2,
              outcome: 'failed',
              googleStatus: 403,
              googleReason: 'forbidden',
              verifiedBy: 'write-response',
            },
          ],
          new Date(),
          'delegation-not-authorized',
        );
        assert.deepEqual(
          answer.settled.map((row) => [row.operationNumber, row.status]),
          [
            [1, 'failed'],
            [2, 'failed'],
          ],
        );
        assert.equal(answer.publication.jobId, job.jobId);
        assert.deepEqual(answer.publication.deviceIds, []);
        const after = await jobRow(job.jobId);
        assert.equal(after.failure, 'delegation-not-authorized');
        assert.equal(Number(after.revision), Number(before.revision) + 1);
        assert.equal(await publications(job.jobId), published + 1);
        assert.equal(
          (await newestPublication(job.jobId)).revision,
          after.revision,
        );
        await stop(job.jobId, job.token, 0, job.attempt);
        await endJob(job.jobId);
      },
    );

    // Item 14: the first failure stays, and a fenced call records no failure.
    await ruleCheck(
      'B2c item 14 an earlier job failure stays and a fenced settlement records no failure',
      async () => {
        const job = await claimedJob(['b2c14-a', 'b2c14-b'], 1);
        assert.equal(
          (await claim(job.jobId, job.token, 1, job.attempt)).outcome,
          'claimed',
        );
        await settleWith(
          job.jobId,
          job.token,
          job.attempt,
          'write',
          [
            {
              operationNumber: 1,
              outcome: 'failed',
              verifiedBy: 'write-response',
            },
          ],
          new Date(),
          'quota',
        );
        await settleWith(
          job.jobId,
          job.token,
          job.attempt,
          'write',
          [
            {
              operationNumber: 2,
              outcome: 'failed',
              verifiedBy: 'write-response',
            },
          ],
          new Date(),
          'network-failure',
        );
        assert.equal((await jobRow(job.jobId)).failure, 'quota');
        await stop(job.jobId, job.token, 0, job.attempt);
        await stop(job.jobId, job.token, 1, job.attempt);
        await endJob(job.jobId);

        const fenced = await claimedJob(['b2c14-c']);
        const before = await jobState(fenced.jobId, 'b2c14-c');
        const answer = await settleWith(
          fenced.jobId,
          randomUUID(),
          fenced.attempt,
          'write',
          [
            {
              operationNumber: 1,
              outcome: 'failed',
              verifiedBy: 'write-response',
            },
          ],
          new Date(),
          'provider-unavailable',
        );
        assert.equal(answer.outcome, 'fenced');
        assert.deepEqual(await jobState(fenced.jobId, 'b2c14-c'), before);
        await endJob(fenced.jobId);
      },
    );

    // Item 15: a failure outside the enumeration and a read-back failure reject before any lock.
    await ruleCheck(
      'B2c item 15 an unknown failure code and a read-back failure reject before any lock',
      async () => {
        const write = await claimedJob(['b2c15-a']);
        await rejectsBeforeLocks({
          jobId: write.jobId,
          deviceId: 'b2c15-a',
          sql: settleSql9,
          values: [
            customer,
            write.jobId,
            write.token,
            write.attempt,
            'write',
            JSON.stringify([{ operationNumber: 1, outcome: 'failed' }]),
            new Date(),
            'unlisted-failure',
            null,
          ],
        });
        await endJob(write.jobId);
        const read = await provenanceJob('b2c15-b', 'read-back');
        await rejectsBeforeLocks({
          jobId: read.jobId,
          deviceId: 'b2c15-b',
          sql: settleSql9,
          values: [
            customer,
            read.jobId,
            null,
            read.attempt,
            'read-back',
            JSON.stringify([{ operationNumber: 1, outcome: 'failed' }]),
            new Date(),
            'quota',
            null,
          ],
        });
        await endJob(read.jobId);
      },
    );

    // Item 16: the next claim of the job stops on the recorded failure and skips the pending operations.
    await ruleCheck(
      'B2c item 16 a recorded job failure stops the next claim and skips the pending operations',
      async () => {
        const job = await claimedJob(['b2c16-a', 'b2c16-b'], 1);
        await settleWith(
          job.jobId,
          job.token,
          job.attempt,
          'write',
          [
            {
              operationNumber: 1,
              outcome: 'failed',
              verifiedBy: 'write-response',
            },
          ],
          new Date(),
          'delegation-not-authorized',
        );
        const stopped = await claim(job.jobId, job.token, 1, randomUUID());
        assert.equal(stopped.outcome, 'stopped');
        assert.equal(stopped.failure, 'delegation-not-authorized');
        assert.equal(stopped.operations, undefined);
        assert.deepEqual(
          (await operations(job.jobId)).map((row) => [
            row.operation_number,
            row.status,
            row.outcome_reason,
          ]),
          [
            [1, 'failed', null],
            [2, 'skipped', 'delegation-not-authorized'],
          ],
        );
        await endJob(job.jobId);
      },
    );

    // Item 17: a token that is not current still answers superseded, and it writes nothing.
    await ruleCheck(
      'B2c item 17 a token that is not current still answers superseded',
      async () => {
        const job = await claimedJob(['b2c17-a']);
        const before = await jobState(job.jobId, 'b2c17-a');
        await rotateToken(job.jobId);
        const answer = await claim(job.jobId, job.token, 0, randomUUID());
        assert.equal(answer.outcome, 'superseded');
        const after = await jobState(job.jobId, 'b2c17-a');
        assert.notEqual(
          after.detail.dispatch_token,
          before.detail.dispatch_token,
        );
        assert.deepEqual(
          withoutDispatchToken(after.detail),
          withoutDispatchToken(before.detail),
          'A superseded claim changes no detail row but the token that the test rotated.',
        );
        assert.deepEqual(
          { ...after, detail: null },
          { ...before, detail: null },
          'A superseded claim changes no other row but the token that the test rotated.',
        );
        await endJob(job.jobId);
      },
    );

    // Item 18: a stopped claim answers stopped before busy, and the later batches skip too.
    await ruleCheck(
      'B2c item 18 a claim of a stopped job answers stopped before busy and skips the later batches',
      async () => {
        const job = await claimedJob(
          ['b2c18-a', 'b2c18-b', 'b2c18-c', 'b2c18-d'],
          2,
        );
        await settleWith(
          job.jobId,
          job.token,
          job.attempt,
          'write',
          [
            {
              operationNumber: 1,
              outcome: 'failed',
              googleStatus: 403,
              googleReason: 'forbidden',
              verifiedBy: 'write-response',
            },
          ],
          new Date(),
          'permission-denied',
        );
        const stopped = await claim(job.jobId, job.token, 0, randomUUID());
        assert.equal(stopped.outcome, 'stopped');
        assert.equal(stopped.failure, 'permission-denied');
        assert.deepEqual(
          (await operations(job.jobId)).map((row) => [
            row.operation_number,
            row.status,
            row.outcome_reason,
          ]),
          [
            [1, 'failed', null],
            [2, 'dispatched', null],
            [3, 'skipped', 'permission-denied'],
            [4, 'skipped', 'permission-denied'],
          ],
        );
        const later = await claim(job.jobId, job.token, 1, randomUUID());
        assert.equal(later.outcome, 'stopped');
        assert.equal(later.failure, 'permission-denied');
        await expireBatches(job.jobId);
        assert.equal(
          (await prepareFinish(job.jobId, job.token)).outcome,
          'ready',
        );
        const fenced = (await operations(job.jobId)).find(
          (row) => row.operation_number === 2,
        );
        assert.equal(fenced.status, 'unknown');
        assert.equal(fenced.outcome_reason, 'interrupted');
        await endJob(job.jobId);
      },
    );

    // Item 19: a stopped claim writes its heartbeat, so the tick keeps the live token.
    await ruleCheck(
      'B2c item 19 a stopped claim writes its heartbeat so the tick keeps the token',
      async () => {
        const owner = await newOwner();
        const job = await makeJob({
          devices: ['b2c19-a', 'b2c19-b', 'b2c19-c'],
          batchSize: 1,
          createdBy: owner,
        });
        const admitted = await admit(false);
        assert.equal(
          admitted.jobId,
          job.jobId,
          'The admission picks this job.',
        );
        const token = admitted.dispatchToken;
        const attempt = randomUUID();
        assert.equal(
          (await claim(job.jobId, token, 0, attempt)).outcome,
          'claimed',
        );
        await settleWith(
          job.jobId,
          token,
          attempt,
          'write',
          [
            {
              operationNumber: 1,
              outcome: 'succeeded',
              values: { annotatedLocation: 'Room 12' },
              verifiedBy: 'write-response',
            },
          ],
          new Date(),
        );
        await stop(job.jobId, token, 0, attempt);
        await migrator.query(
          'UPDATE cc.application_principals SET enabled=false WHERE id=$1',
          [owner],
        );
        for (const batch of [1, 2]) {
          await migrator.query(
            `UPDATE cc.device_update_jobs SET heartbeat_at=clock_timestamp()-interval '11 minutes'
              WHERE job_id=$1`,
            [job.jobId],
          );
          const aged = (await detailRow(job.jobId)).heartbeat_at;
          const stopped = await claim(job.jobId, token, batch, randomUUID());
          assert.equal(stopped.outcome, 'stopped');
          assert.equal(stopped.failure, 'permission-changed');
          const state = await detailRow(job.jobId);
          assert.equal(state.dispatch_token, token);
          assert.ok(
            state.heartbeat_at > aged,
            'The stopped claim writes a fresh heartbeat.',
          );
          const tick = await recover();
          assert.ok(
            !tick.starts.some((start) => start.jobId === job.jobId),
            'The tick returns no start for the live execution.',
          );
          const counts = await adminRow(
            'SELECT dispatch_count FROM cc.device_update_jobs WHERE job_id=$1',
            [job.jobId],
          );
          assert.equal(counts.dispatch_count, 1);
        }
        await endJob(job.jobId);
      },
    );

    // Item 20: a done claim writes its heartbeat, so the tick keeps the live token.
    await ruleCheck(
      'B2c item 20 a done claim writes its heartbeat so the tick keeps the token',
      async () => {
        const job = await claimedJob(['b2c20-a']);
        await settleWith(
          job.jobId,
          job.token,
          job.attempt,
          'write',
          [
            {
              operationNumber: 1,
              outcome: 'succeeded',
              values: { annotatedLocation: 'Room 12' },
              verifiedBy: 'write-response',
            },
          ],
          new Date(),
        );
        await stop(job.jobId, job.token, 0, job.attempt);
        await migrator.query(
          `UPDATE cc.device_update_jobs SET heartbeat_at=clock_timestamp()-interval '11 minutes'
            WHERE job_id=$1`,
          [job.jobId],
        );
        const aged = (await detailRow(job.jobId)).heartbeat_at;
        const done = await claim(job.jobId, job.token, 0, randomUUID());
        assert.equal(done.outcome, 'done');
        const state = await adminRow(
          'SELECT dispatch_token,dispatch_count,heartbeat_at FROM cc.device_update_jobs WHERE job_id=$1',
          [job.jobId],
        );
        assert.ok(
          state.heartbeat_at > aged,
          'The done claim writes a fresh heartbeat.',
        );
        assert.equal(state.dispatch_token, job.token);
        assert.equal(state.dispatch_count, 1);
        const tick = await recover();
        assert.ok(
          !tick.starts.some((start) => start.jobId === job.jobId),
          'The tick returns no start for the live execution.',
        );
        await endJob(job.jobId);
      },
    );

    // Item 21: a stopped first claim records the execution, so the tick never abandons the start.
    await ruleCheck(
      'B2c item 21 a stopped first claim keeps the tick from abandoning the start',
      async () => {
        const owner = await newOwner();
        const job = await makeJob({ devices: ['b2c21-a'], createdBy: owner });
        const admitted = await admit(false);
        assert.equal(
          admitted.jobId,
          job.jobId,
          'The admission picks this job.',
        );
        const token = admitted.dispatchToken;
        await migrator.query(
          'UPDATE cc.application_principals SET enabled=false WHERE id=$1',
          [owner],
        );
        const stopped = await claim(job.jobId, token, 0, randomUUID());
        assert.equal(stopped.outcome, 'stopped');
        assert.equal(stopped.failure, 'permission-changed');
        const saved = await adminRow(
          'SELECT first_claimed_at FROM cc.device_update_jobs WHERE job_id=$1',
          [job.jobId],
        );
        assert.ok(saved.first_claimed_at instanceof Date);
        assert.equal((await jobRow(job.jobId)).started_at, null);
        await migrator.query(
          `UPDATE cc.device_update_jobs SET start_deadline_at=clock_timestamp()-interval '1 minute'
            WHERE job_id=$1`,
          [job.jobId],
        );
        let tick = await recover();
        assert.ok(
          !tick.starts.some((start) => start.jobId === job.jobId),
          'The tick never abandons a start that recorded a claim.',
        );
        assert.equal((await jobRow(job.jobId)).status, 'running');
        for (let round = 0; round < 3; round += 1) {
          await migrator.query(
            `UPDATE cc.device_update_jobs SET heartbeat_at=clock_timestamp()-interval '11 minutes'
              WHERE job_id=$1`,
            [job.jobId],
          );
          tick = await recover();
        }
        const final = await jobRow(job.jobId);
        assert.equal(final.status, 'failed');
        assert.equal(final.failure, 'permission-changed');
        assert.equal(
          (
            await adminRow(
              'SELECT dispatch_count FROM cc.device_update_jobs WHERE job_id=$1',
              [job.jobId],
            )
          ).dispatch_count,
          3,
        );
      },
    );

    // Item 22: a stopped and a done answer stamp their heartbeat after the detail wait.
    await ruleCheck(
      'B2c item 22 a stopped or done claim stamps its heartbeat after a detail wait',
      async () => {
        const stoppedJob = await releasedBatch('b2c22-s');
        await migrator.query(
          'UPDATE cc.application_principals SET enabled=false WHERE id=$1',
          [stoppedJob.owner],
        );
        const stopped = await waitedOn({
          rows: [heldDetailRow(stoppedJob.jobId)],
          ...nextClaim(stoppedJob),
          during: () => sleep(200),
        });
        assert.equal(stopped.answer.code, undefined, stopped.answer.message);
        assert.equal(stopped.answer.rows[0].result.outcome, 'stopped');
        const stoppedSaved = await detailRow(stoppedJob.jobId);
        assert.ok(
          stoppedSaved.heartbeat_at >= stopped.releasedAt,
          'The stopped claim stamps its heartbeat after the release.',
        );
        await endJob(stoppedJob.jobId);

        const doneJob = await claimedJob(['b2c22-d']);
        await settleWith(
          doneJob.jobId,
          doneJob.token,
          doneJob.attempt,
          'write',
          [
            {
              operationNumber: 1,
              outcome: 'succeeded',
              values: { annotatedLocation: 'Room 12' },
              verifiedBy: 'write-response',
            },
          ],
          new Date(),
        );
        await stop(doneJob.jobId, doneJob.token, 0, doneJob.attempt);
        const done = await waitedOn({
          rows: [heldDetailRow(doneJob.jobId)],
          sql: claimSql,
          values: [
            customer,
            doneJob.jobId,
            doneJob.token,
            0,
            randomUUID(),
            'b2c22-done',
          ],
          during: () => sleep(200),
        });
        assert.equal(done.answer.code, undefined, done.answer.message);
        assert.equal(done.answer.rows[0].result.outcome, 'done');
        const doneSaved = await detailRow(doneJob.jobId);
        assert.ok(
          doneSaved.heartbeat_at >= done.releasedAt,
          'The done claim stamps its heartbeat after the release.',
        );
        await endJob(doneJob.jobId);
      },
    );

    // Item 23: a done claim rechecks its token after the batch wait, and a busy claim writes nothing.
    await ruleCheck(
      'B2c item 23 a done claim returns superseded when the token rotates in its batch wait',
      async () => {
        const job = await claimedJob(['b2c23-a']);
        await settleWith(
          job.jobId,
          job.token,
          job.attempt,
          'write',
          [
            {
              operationNumber: 1,
              outcome: 'succeeded',
              values: { annotatedLocation: 'Room 12' },
              verifiedBy: 'write-response',
            },
          ],
          new Date(),
        );
        await stop(job.jobId, job.token, 0, job.attempt);
        const before = await jobState(job.jobId, 'b2c23-a');
        const answer = await waitedOn({
          rows: [heldBatchRow(job.jobId)],
          sql: claimSql,
          values: [
            customer,
            job.jobId,
            job.token,
            0,
            randomUUID(),
            'b2c23-done',
          ],
          during: () => rotateToken(job.jobId),
        });
        assert.equal(answer.answer.code, undefined, answer.answer.message);
        assert.equal(
          answer.answer.rows[0].result.outcome,
          'superseded',
          'A done claim rechecks its token after the batch wait.',
        );
        const after = await jobState(job.jobId, 'b2c23-a');
        assert.notEqual(
          after.detail.dispatch_token,
          before.detail.dispatch_token,
        );
        assert.deepEqual(
          withoutDispatchToken(after.detail),
          withoutDispatchToken(before.detail),
          'A superseded done claim writes neither heartbeat_at nor first_claimed_at.',
        );
        assert.deepEqual(
          { ...after, detail: null },
          { ...before, detail: null },
          'A superseded done claim changes no other row but the rotated token.',
        );
        await endJob(job.jobId);
      },
    );

    await ruleCheck('B2c item 23 a busy claim writes nothing', async () => {
      const job = await claimedJob(['b2c23-b']);
      const before = await jobState(job.jobId, 'b2c23-b');
      const busy = await claim(job.jobId, job.token, 0, randomUUID());
      assert.equal(busy.outcome, 'busy');
      assert.deepEqual(await jobState(job.jobId, 'b2c23-b'), before);
      await endJob(job.jobId);
    });

    // Item 24: the preparation and the reaper skip with the recorded job failure, or interrupted.
    await ruleCheck(
      'B2c item 24 the preparation and the reaper skip pending operations with the recorded job failure',
      async () => {
        const prepared = await claimedJob(['b2c24-a', 'b2c24-b'], 1);
        await settleWith(
          prepared.jobId,
          prepared.token,
          prepared.attempt,
          'write',
          [
            {
              operationNumber: 1,
              outcome: 'failed',
              verifiedBy: 'write-response',
            },
          ],
          new Date(),
          'quota',
        );
        await stop(prepared.jobId, prepared.token, 0, prepared.attempt);
        assert.equal(
          (await prepareFinish(prepared.jobId, prepared.token)).outcome,
          'ready',
        );
        assert.deepEqual(
          (await operations(prepared.jobId)).map((row) => [
            row.operation_number,
            row.status,
            row.outcome_reason,
          ]),
          [
            [1, 'failed', null],
            [2, 'skipped', 'quota'],
          ],
          'The preparation skips a pending operation with the recorded failure.',
        );
        await endJob(prepared.jobId);

        const guard = await claimedJob(['b2c24-c', 'b2c24-d'], 1);
        await stop(guard.jobId, guard.token, 0, guard.attempt);
        assert.equal(
          (await prepareFinish(guard.jobId, guard.token)).outcome,
          'ready',
        );
        assert.deepEqual(
          (await operations(guard.jobId)).map((row) => [
            row.operation_number,
            row.status,
            row.outcome_reason,
          ]),
          [
            [1, 'unknown', 'interrupted'],
            [2, 'skipped', 'interrupted'],
          ],
          'Without a recorded failure the preparation skips with interrupted.',
        );
        await endJob(guard.jobId);

        const reaped = await claimedJob(['b2c24-e', 'b2c24-f'], 1);
        await settleWith(
          reaped.jobId,
          reaped.token,
          reaped.attempt,
          'write',
          [
            {
              operationNumber: 1,
              outcome: 'failed',
              verifiedBy: 'write-response',
            },
          ],
          new Date(),
          'quota',
        );
        await expireBatches(reaped.jobId);
        assert.equal((await finalize(reaped.jobId)).outcome, 'finalized');
        assert.deepEqual(
          (await operations(reaped.jobId)).map((row) => [
            row.operation_number,
            row.status,
            row.outcome_reason,
          ]),
          [
            [1, 'failed', null],
            [2, 'skipped', 'quota'],
          ],
          'The reaper skips a pending operation with the recorded failure.',
        );

        const reaperGuard = await claimedJob(['b2c24-g', 'b2c24-h'], 1);
        await expireBatches(reaperGuard.jobId);
        assert.equal((await finalize(reaperGuard.jobId)).outcome, 'finalized');
        assert.deepEqual(
          (await operations(reaperGuard.jobId)).map((row) => [
            row.operation_number,
            row.status,
            row.outcome_reason,
          ]),
          [
            [1, 'unknown', 'interrupted'],
            [2, 'skipped', 'interrupted'],
          ],
          'Without a recorded failure the reaper skips with interrupted.',
        );
      },
    );

    // Item 25: the final finish carries the element of its publication row, and no other answer does.
    await ruleCheck(
      'B2c item 25 the final finish carries the publication element of its row',
      async () => {
        const job = await claimedJob(['b2c25-a', 'b2c25-b']);
        await settleWith(
          job.jobId,
          job.token,
          job.attempt,
          'write',
          [
            {
              operationNumber: 1,
              outcome: 'succeeded',
              values: { annotatedLocation: 'Room 12' },
              verifiedBy: 'write-response',
            },
          ],
          new Date(),
        );
        await stop(job.jobId, job.token, 0, job.attempt);
        await expireBatches(job.jobId);
        assert.equal(
          (await prepareFinish(job.jobId, job.token)).outcome,
          'ready',
        );
        const finished = await finishJob(job.jobId);
        assert.equal(finished.status, 'needs-review');
        assert.ok(
          finished.publication && typeof finished.publication === 'object',
        );
        const newest = await newestPublication(job.jobId);
        assert.equal(
          Number(finished.publication.publicationId),
          Number(newest.publication_id),
          'The element names the row that this finish records.',
        );
        assert.equal(
          Number(finished.publication.revision),
          Number((await jobRow(job.jobId)).revision),
        );
        assert.equal(finished.publication.statusChanged, true);
        const again = await finishJob(job.jobId);
        assert.equal(again.outcome, 'finished');
        assert.equal(again.publication, undefined);
        const busy = await claimedJob(['b2c25-busy']);
        assert.equal(
          (await finishWithToken(busy.jobId, busy.token)).outcome,
          'busy',
        );
        assert.equal(
          (await finishWithToken(busy.jobId, busy.token)).publication,
          undefined,
        );
        await expireBatches(busy.jobId);
        assert.equal(
          (await finishWithToken(busy.jobId, busy.token)).outcome,
          'not-prepared',
        );
        assert.equal(
          (await finishWithToken(busy.jobId, busy.token)).publication,
          undefined,
        );
        await endJob(busy.jobId);
        const late = await claimedJob(['b2c25-c']);
        await rotateToken(late.jobId);
        const superseded = await finishWithToken(late.jobId, late.token, null);
        assert.equal(superseded.outcome, 'superseded');
        assert.equal(superseded.publication, undefined);
        await endJob(late.jobId);
        await endJob(job.jobId);
      },
    );

    // Item 26 (C7): each new signature resolves, and no replaced signature does.
    await ruleCheck(
      'B2c item 26 to_regprocedure resolves each new signature and no replaced signature',
      async () => {
        const signatures = await adminRow(
          `SELECT to_regprocedure('cc.claim_device_update_verification(text,uuid,jsonb,uuid,integer,integer)') IS NOT NULL AS claim_new,
            to_regprocedure('cc.claim_device_update_verification(text,uuid,jsonb,uuid)') IS NULL AS claim_old_gone,
            to_regprocedure('cc.settle_device_update_operations(text,uuid,uuid,uuid,text,jsonb,timestamptz,text,text)') IS NOT NULL AS settle_new,
            to_regprocedure('cc.settle_device_update_operations(text,uuid,uuid,uuid,text,jsonb,timestamptz)') IS NULL AS settle_old_gone,
            to_regprocedure('cc.read_device_update_verification(text,uuid,uuid,jsonb)') IS NOT NULL AS read_new`,
        );
        assert.equal(
          signatures.claim_new,
          true,
          'The new claim signature exists.',
        );
        assert.equal(
          signatures.claim_old_gone,
          true,
          'The four-argument claim signature is gone.',
        );
        assert.equal(
          signatures.settle_new,
          true,
          'The new settlement signature exists.',
        );
        assert.equal(
          signatures.settle_old_gone,
          true,
          'The seven-argument settlement signature is gone.',
        );
        assert.equal(
          signatures.read_new,
          true,
          'The verification read signature exists.',
        );
      },
    );

    // C3: the settlement returns the element of its own publication row.
    await ruleCheck(
      'B2c C3 a write settlement returns the publication element of its row',
      async () => {
        const job = await provenanceJob('b2c26-a', 'write');
        const answer = await settleWith(
          job.jobId,
          job.token,
          job.attempt,
          'write',
          [
            {
              operationNumber: 1,
              outcome: 'succeeded',
              values: { annotatedLocation: 'Room 12' },
              verifiedBy: 'write-response',
            },
          ],
          new Date(),
        );
        assert.ok(answer.publication && typeof answer.publication === 'object');
        assert.equal(answer.publication.jobId, job.jobId);
        assert.equal(
          Number(answer.publication.revision),
          Number((await jobRow(job.jobId)).revision),
        );
        assert.equal(answer.publication.batch, 0);
        assert.deepEqual(answer.publication.deviceIds, ['b2c26-a']);
        assert.equal(
          Number(answer.publication.publicationId),
          Number((await newestPublication(job.jobId)).publication_id),
        );
        assert.equal(answer.publication.statusChanged, false);
        await stop(job.jobId, job.token, 0, job.attempt);
        await endJob(job.jobId);
      },
    );

    // Item 27: the first failure stays, and a later scope observation still records.
    await ruleCheck(
      'B2c item 27 an earlier job failure stays while a later scope observation records',
      async () => {
        const job = await claimedJob(['b2c27-a', 'b2c27-b']);
        const first = await settleWith(
          job.jobId,
          job.token,
          job.attempt,
          'write',
          [
            {
              operationNumber: 1,
              outcome: 'failed',
              googleStatus: 403,
              googleReason: 'forbidden',
              verifiedBy: 'write-response',
            },
          ],
          new Date(),
          'permission-denied',
        );
        assert.equal(first.settled.length, 1);
        const second = await settleWith(
          job.jobId,
          job.token,
          job.attempt,
          'write',
          [
            {
              operationNumber: 2,
              outcome: 'failed',
              googleStatus: 403,
              googleReason: 'invalid_scope',
              verifiedBy: 'write-response',
            },
          ],
          new Date(),
          'permission-denied',
          'scope-mismatch',
        );
        assert.equal(second.settled.length, 1);
        assert.equal((await jobRow(job.jobId)).failure, 'permission-denied');
        assert.deepEqual(await scopeRow(job.jobId), {
          scope_observations: 1,
          scope_failure: 'scope-mismatch',
        });
        await stop(job.jobId, job.token, 0, job.attempt);
        await endJob(job.jobId);
      },
    );

    // Item 28: each scope observation counts, and the latest code wins.
    await ruleCheck(
      'B2c item 28 each scope observation counts and the latest code wins',
      async () => {
        const job = await claimedJob(['b2c28-a', 'b2c28-b']);
        await settleWith(
          job.jobId,
          job.token,
          job.attempt,
          'write',
          [
            {
              operationNumber: 1,
              outcome: 'failed',
              verifiedBy: 'write-response',
            },
          ],
          new Date(),
          'permission-denied',
          'scope-mismatch',
        );
        await settleWith(
          job.jobId,
          job.token,
          job.attempt,
          'write',
          [
            {
              operationNumber: 2,
              outcome: 'failed',
              verifiedBy: 'write-response',
            },
          ],
          new Date(),
          'permission-denied',
          'delegation-not-authorized',
        );
        assert.deepEqual(await scopeRow(job.jobId), {
          scope_observations: 2,
          scope_failure: 'delegation-not-authorized',
        });
        assert.equal((await jobRow(job.jobId)).failure, 'permission-denied');
        await stop(job.jobId, job.token, 0, job.attempt);
        await endJob(job.jobId);
      },
    );

    // Item 29: a fenced settlement and a settlement that changes nothing record no observation.
    await ruleCheck(
      'B2c item 29 a fenced settlement and an empty settlement record no scope observation',
      async () => {
        const fenced = await claimedJob(['b2c29-a']);
        const fencedAnswer = await settleWith(
          fenced.jobId,
          randomUUID(),
          fenced.attempt,
          'write',
          [
            {
              operationNumber: 1,
              outcome: 'failed',
              verifiedBy: 'write-response',
            },
          ],
          new Date(),
          'quota',
          'scope-mismatch',
        );
        assert.equal(fencedAnswer.outcome, 'fenced');
        assert.deepEqual(await scopeRow(fenced.jobId), {
          scope_observations: 0,
          scope_failure: null,
        });
        await endJob(fenced.jobId);

        const empty = await claimedJob(['b2c29-b', 'b2c29-c']);
        const emptyAnswer = await settleWith(
          empty.jobId,
          empty.token,
          empty.attempt,
          'write',
          [
            {
              operationNumber: 99,
              outcome: 'failed',
              verifiedBy: 'write-response',
            },
          ],
          new Date(),
          'quota',
          'scope-mismatch',
        );
        assert.equal(emptyAnswer.outcome, 'settled');
        assert.deepEqual(emptyAnswer.settled, []);
        assert.equal(emptyAnswer.publication, null);
        assert.deepEqual(await scopeRow(empty.jobId), {
          scope_observations: 0,
          scope_failure: null,
        });
        await endJob(empty.jobId);
      },
    );

    // Item 30: an out-of-domain scope input rejects before any lock.
    await ruleCheck(
      'B2c item 30 an out-of-domain scope input rejects before any lock',
      async () => {
        const job = await claimedJob(['b2c30-a']);
        for (const values of [
          [
            customer,
            job.jobId,
            job.token,
            job.attempt,
            'write',
            JSON.stringify([{ operationNumber: 1, outcome: 'failed' }]),
            new Date(),
            'permission-denied',
            'connection-changed',
          ],
          [
            customer,
            job.jobId,
            job.token,
            job.attempt,
            'write',
            JSON.stringify([{ operationNumber: 1, outcome: 'failed' }]),
            new Date(),
            null,
            'scope-mismatch',
          ],
        ])
          await rejectsBeforeLocks({
            jobId: job.jobId,
            deviceId: 'b2c30-a',
            sql: settleSql9,
            values,
          });
        await endJob(job.jobId);
        const read = await provenanceJob('b2c30-b', 'read-back');
        await rejectsBeforeLocks({
          jobId: read.jobId,
          deviceId: 'b2c30-b',
          sql: settleSql9,
          values: [
            customer,
            read.jobId,
            null,
            read.attempt,
            'read-back',
            JSON.stringify([{ operationNumber: 1, outcome: 'failed' }]),
            new Date(),
            'permission-denied',
            'scope-mismatch',
          ],
        });
        await endJob(read.jobId);
      },
    );

    // Item 31: only the settlement function names the scope columns.
    await ruleCheck(
      'B2c item 31 only the settlement function names the scope columns',
      async () => {
        const names = await admin(
          `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
            WHERE n.nspname='cc' AND (p.prosrc LIKE '%scope_observations%' OR p.prosrc LIKE '%scope_failure%')
            ORDER BY p.proname`,
        );
        assert.deepEqual(
          names.map((row) => row.proname),
          ['settle_device_update_operations'],
        );
      },
    );

    // Item 32: the columns hold their domain, and the partial index exists.
    await ruleCheck(
      'B2c item 32 the scope columns hold their domain and the partial index exists',
      async () => {
        const job = await makeJob({ devices: ['b2c32-a'] });
        assert.deepEqual(await scopeRow(job.jobId), {
          scope_observations: 0,
          scope_failure: null,
        });
        await rejects(
          migrator.query(
            'UPDATE cc.device_update_jobs SET scope_observations=-1 WHERE job_id=$1',
            [job.jobId],
          ),
          '23514',
        );
        await rejects(
          migrator.query(
            "UPDATE cc.device_update_jobs SET scope_observations=0,scope_failure='scope-mismatch' WHERE job_id=$1",
            [job.jobId],
          ),
          '23514',
        );
        await rejects(
          migrator.query(
            'UPDATE cc.device_update_jobs SET scope_observations=1,scope_failure=NULL WHERE job_id=$1',
            [job.jobId],
          ),
          '23514',
        );
        await rejects(
          migrator.query(
            "UPDATE cc.device_update_jobs SET scope_observations=0,scope_failure='permission-changed' WHERE job_id=$1",
            [job.jobId],
          ),
          '23514',
        );
        const index = await adminRow(
          `SELECT indexdef FROM pg_indexes WHERE schemaname='cc' AND tablename='device_update_jobs'
            AND indexname='device_update_jobs_scope_observations'`,
        );
        assert.ok(index, 'The partial index exists.');
        assert.match(index.indexdef, /WHERE \(scope_observations > 0\)/);
        await endJob(job.jobId);
      },
    );

    // Item 33 (F1): the upsert takes the connection row before its device rows.
    await ruleCheck(
      'B2c item 33 an upsert locks the connection row before its device rows',
      async () => {
        await upsert(
          [device('b2c-f1-x', { annotatedLocation: 'Old' })],
          new Date(Date.now() - 60 * 60 * 1000),
        );
        const holder = await connect('cc-migrator', 'cc-app');
        const caller = await connect('cc-app', 'cc-app');
        const probe = await connect('cc-migrator', 'cc-app');
        let pending = null;
        try {
          await holder.query('BEGIN');
          await holder.query(...heldConnectionRow());
          const holderPid = await pidOf(holder);
          const callerPid = await pidOf(caller);
          pending = caller
            .query('SELECT cc.upsert_devices($1,$2,$3,$4) AS result', [
              customer,
              JSON.stringify([device('b2c-f1-x'), device('b2c-f1-y')]),
              new Date(),
              'list',
            ])
            .then(
              (queried) => ({ rows: queried.rows }),
              (error) => ({ code: error.code, message: error.message }),
            );
          assert.equal(
            await waitsFor(callerPid, holderPid),
            true,
            'The upsert waits on the connection row.',
          );
          await probe.query('BEGIN');
          const free = await probe
            .query(
              'SELECT 1 FROM cc.devices WHERE customer_id=$1 AND device_id=$2 FOR UPDATE NOWAIT',
              [customer, 'b2c-f1-x'],
            )
            .then(
              () => true,
              (error) => error.code,
            );
          await probe.query('ROLLBACK');
          assert.equal(
            free,
            true,
            'The existing device row stays free while the upsert waits for the connection row.',
          );
          await holder.query('ROLLBACK');
          const answer = await pending;
          assert.equal(answer.code, undefined, answer.message);
          assert.equal(answer.rows[0].result, 2);
        } finally {
          await probe.query('ROLLBACK').catch(() => undefined);
          await holder.query('ROLLBACK').catch(() => undefined);
          if (pending) await pending;
          await Promise.allSettled([probe.end(), holder.end(), caller.end()]);
        }
        assert.ok(await deviceRow('b2c-f1-y'));
      },
    );

    // Item 34 (F1): an upsert and a full-sync finish form no deadlock.
    await ruleCheck(
      'B2c item 34 an upsert and a full-sync finish form no deadlock',
      async () => {
        await upsert(
          [device('b2c-f1-dx', { annotatedLocation: 'Old' })],
          new Date(Date.now() - 60 * 60 * 1000),
        );
        const sync = await makeSync();
        const candidate = await adminRow(
          `SELECT (SELECT d.last_entity_sync FROM cc.devices d
              WHERE d.customer_id=$1 AND d.device_id='b2c-f1-dx')
            < (SELECT s.sync_started_at FROM cc.device_sync_state s WHERE s.customer_id=$1) AS candidate`,
          [customer],
        );
        assert.equal(
          candidate.candidate,
          true,
          'The device X is a removal candidate of the sync.',
        );
        const holder = await connect('cc-migrator', 'cc-app');
        const finisher = await connect('cc-app', 'cc-app');
        const upsertCaller = await connect('cc-app', 'cc-app');
        let finishPending = null;
        let upsertPending = null;
        try {
          await holder.query('BEGIN');
          await holder.query(...heldConnectionRow());
          const holderPid = await pidOf(holder);
          const finisherPid = await pidOf(finisher);
          finishPending = finisher
            .query('SELECT cc.finish_device_sync($1,$2,$3,$4,$5) AS result', [
              customer,
              sync.id,
              sync.attempt,
              null,
              null,
            ])
            .then(
              (queried) => ({ rows: queried.rows }),
              (error) => ({ code: error.code, message: error.message }),
            );
          assert.equal(
            await waitsFor(finisherPid, holderPid),
            true,
            'The finish waits on the connection row.',
          );
          const upsertPid = await pidOf(upsertCaller);
          upsertPending = upsertCaller
            .query('SELECT cc.upsert_devices($1,$2,$3,$4) AS result', [
              customer,
              JSON.stringify([device('b2c-f1-dx'), device('b2c-f1-dy')]),
              new Date(),
              'list',
            ])
            .then(
              (queried) => ({ rows: queried.rows }),
              (error) => ({ code: error.code, message: error.message }),
            );
          assert.equal(
            await waitsForAny(upsertPid, [holderPid, finisherPid]),
            true,
            'The upsert waits on the connection row behind the holder and the finish.',
          );
          await holder.query('ROLLBACK');
          const [finished, upserted] = await Promise.all([
            finishPending,
            upsertPending,
          ]);
          assert.notEqual(
            finished.code,
            '40P01',
            'The full-sync finish does not deadlock.',
          );
          assert.notEqual(
            upserted.code,
            '40P01',
            'The upsert does not deadlock.',
          );
          assert.equal(finished.code, undefined, finished.message);
          assert.equal(upserted.code, undefined, upserted.message);
          assert.equal(upserted.rows[0].result, 2);
        } finally {
          await holder.query('ROLLBACK').catch(() => undefined);
          if (finishPending) await finishPending;
          if (upsertPending) await upsertPending;
          await Promise.allSettled([
            holder.end(),
            finisher.end(),
            upsertCaller.end(),
          ]);
        }
        assert.ok(await deviceRow('b2c-f1-dy'));
        await resetSync();
      },
    );

    // Item 58 (Q3): a malformed element raises, and no device row, publication, or sync-state change stays.
    await ruleCheck(
      'B2c item 58 a malformed upsert element leaves no row, publication, or sync change',
      async () => {
        const before = {
          publications: (
            await adminRow(
              'SELECT count(*)::int AS count FROM cc.job_publications WHERE customer_id=$1',
              [customer],
            )
          ).count,
          sync: await adminRow(
            `SELECT sync_id,sync_attempt,sync_expires_at,failure,failure_requested_by,telemetry_failure,
              telemetry_failure_requested_by,generation,observed_at,device_count,checked_at
              FROM cc.device_sync_state WHERE customer_id=$1`,
            [customer],
          ),
        };
        const error = await rejects(
          upsert(
            [device('q3-a'), device('q3-b', { lastContact: 'not-a-time' })],
            new Date(),
          ),
        );
        assert.equal(error.code, '22007');
        assert.equal(await deviceRow('q3-a'), undefined);
        assert.equal(await deviceRow('q3-b'), undefined);
        assert.equal(
          (
            await adminRow(
              'SELECT count(*)::int AS count FROM cc.job_publications WHERE customer_id=$1',
              [customer],
            )
          ).count,
          before.publications,
        );
        assert.deepEqual(
          await adminRow(
            `SELECT sync_id,sync_attempt,sync_expires_at,failure,failure_requested_by,telemetry_failure,
              telemetry_failure_requested_by,generation,observed_at,device_count,checked_at
              FROM cc.device_sync_state WHERE customer_id=$1`,
            [customer],
          ),
          before.sync,
        );
      },
    );

    // B1 (device actions, section 1): a command job takes the CMD display ID, waits in
    // awaiting-devices without the write slot, and the terminal rule counts expired beside failed.
    await check(
      'B1 command jobs take their own ID and free the write slot to await devices',
      async () => {
        const version = (
          await adminRow(
            'SELECT permission_version FROM cc.application_principals WHERE id=$1',
            [confirmer],
          )
        ).permission_version;
        const actionJob = async (action, kind, prefix, sequence, devices) => {
          const previewId = randomUUID();
          const jobId = randomUUID();
          await admin(
            `INSERT INTO cc.device_update_previews(preview_id, display_id, customer_id, created_by, permission_version, generation, action, action_version, selected, eligible, unchanged, excluded, manifest_digest, expires_at)
            VALUES($1, cc.job_display_id('PV',nextval('cc.preview_number_pv')), $2, $3, $4, $5, $6, CASE WHEN $6='annotated-location' THEN 2 ELSE 1 END, $7, $7, 0, 0, 'manifest-digest', clock_timestamp()+interval '1 hour')`,
            [
              previewId,
              customer,
              confirmer,
              version,
              generation,
              action,
              devices.length,
            ],
          );
          const displayId = (
            await adminRow(
              `INSERT INTO cc.jobs(job_id,display_id,customer_id,kind,scope_kind,status,requested_by,generation,
                target_count,correlation_id)
              VALUES($1,cc.job_display_id('${prefix}',nextval('${sequence}')),$2,'${kind}','devices','accepted',$3,$4,
                $5,$6) RETURNING display_id`,
              [
                jobId,
                customer,
                confirmer,
                generation,
                devices.length,
                randomUUID(),
              ],
            )
          ).display_id;
          await admin(
            `INSERT INTO cc.device_update_jobs(job_id, preview_id, action, confirmed_by, confirmer_permission_version, delegated_subject, batch_size, batch_count)
            VALUES($1, $2, $3, $4, $5, 'admin@example.org', 250, 1)`,
            [jobId, previewId, action, confirmer, version],
          );
          for (const [index, deviceId] of devices.entries())
            await admin(
              `INSERT INTO cc.device_update_operations(job_id,operation_number,device_id,serial_number,
                org_unit_path,baseline_value,requested_value,batch,status,command_id,command_state,poll_after,
                poll_deadline_at)
              VALUES($1,$2,$3,$4,'/School A','ACTIVE',NULL,0,$5,$6,$7,clock_timestamp(),
                clock_timestamp()+interval '7 days')`,
              [
                jobId,
                index + 1,
                deviceId,
                `SN-${deviceId}`,
                kind === 'device-command' ? 'issued' : 'pending',
                kind === 'device-command' ? '4100000001' : null,
                kind === 'device-command' ? 'pending-delivery' : null,
              ],
            );
          return { jobId, displayId };
        };
        const command = await actionJob(
          'reboot',
          'device-command',
          'CMD',
          'cc.job_number_cmd',
          ['cmd-a'],
        );
        assert.match(command.displayId, /^CMD-[0-9]{3,}$/);
        const commandAdmit = await admit();
        assert.equal(commandAdmit.jobId, command.jobId);
        const waiting = await result(
          'SELECT cc.finish_device_update_job($1,$2,$3) AS result',
          [customer, command.jobId, commandAdmit.dispatchToken],
        );
        assert.equal(waiting.status, 'awaiting-devices');
        assert.equal(waiting.finishedAt, null);
        assert.equal(
          (
            await adminRow('SELECT finished_at FROM cc.jobs WHERE job_id=$1', [
              command.jobId,
            ])
          ).finished_at,
          null,
        );
        // The write slot is free while the command waits, so the next write job admits at once.
        const update = await makeJob({ devices: ['cmd-b'] });
        const updateAdmit = await admit();
        assert.equal(updateAdmit.jobId, update.jobId);
        assert.equal(
          (
            await adminRow('SELECT status FROM cc.jobs WHERE job_id=$1', [
              command.jobId,
            ])
          ).status,
          'awaiting-devices',
        );
        // The partial unique index still admits one running write job only.
        await rejects(
          admin("UPDATE cc.jobs SET status='running' WHERE job_id=$1", [
            command.jobId,
          ]),
          '23505',
        );
        // Release the update job, then settle a status job whose last operation expired.
        assert.equal(
          (
            await result(
              'SELECT cc.finalize_device_update_job($1,$2,$3) AS result',
              [customer, update.jobId, null],
            )
          ).status,
          'failed',
        );
        const status = await actionJob(
          'disable',
          'device-status',
          'STS',
          'cc.job_number_sts',
          ['sts-a', 'sts-b'],
        );
        assert.match(status.displayId, /^STS-[0-9]{3,}$/);
        const statusAdmit = await admit();
        assert.equal(statusAdmit.jobId, status.jobId);
        await admin(
          "UPDATE cc.device_update_operations SET status='succeeded',observed_value='DISABLED' WHERE job_id=$1 AND operation_number=1",
          [status.jobId],
        );
        await admin(
          "UPDATE cc.device_update_operations SET status='expired' WHERE job_id=$1 AND operation_number=2",
          [status.jobId],
        );
        const finished = await result(
          'SELECT cc.finish_device_update_job($1,$2,$3) AS result',
          [customer, status.jobId, statusAdmit.dispatchToken],
        );
        assert.equal(finished.status, 'completed-with-errors');
        assert.equal(finished.expired, 1);
        assert.notEqual(finished.finishedAt, null);
      },
    );

    // B5 (section 4 steps 3, 4, 11, and 12): the issue settlement stores Google's command and its
    // first poll, the preparation names the action, and the finish frees the write slot.
    await check(
      'B5 an issue settlement stores the command and the finish frees the write slot',
      async () => {
        const commandConfirmer = await principal(
          'command-confirmer@example.org',
          [
            ['devices:commands', district()],
            ['devices:bulk-actions', district()],
          ],
        );
        const version = (
          await adminRow(
            'SELECT permission_version FROM cc.application_principals WHERE id=$1',
            [commandConfirmer],
          )
        ).permission_version;
        // A command job fixture: a reboot preview, a CMD header, and one pending operation per device.
        const commandJob = async (devices) => {
          const previewId = randomUUID();
          const jobId = randomUUID();
          await admin(
            `INSERT INTO cc.device_update_previews(preview_id, display_id, customer_id, created_by, permission_version, generation, action, action_version, selected, eligible, unchanged, excluded, manifest_digest, expires_at)
            VALUES($1, cc.job_display_id('PV',nextval('cc.preview_number_pv')), $2, $3, $4, $5, 'reboot', 1, $6, $6, 0, 0, 'manifest-digest', clock_timestamp()+interval '1 hour')`,
            [
              previewId,
              customer,
              commandConfirmer,
              version,
              generation,
              devices.length,
            ],
          );
          await admin(
            `INSERT INTO cc.jobs(job_id,display_id,customer_id,kind,scope_kind,status,requested_by,generation,
              target_count,correlation_id)
            VALUES($1,cc.job_display_id('CMD',nextval('cc.job_number_cmd')),$2,'device-command','devices','accepted',$3,$4,$5,$6)`,
            [
              jobId,
              customer,
              commandConfirmer,
              generation,
              devices.length,
              randomUUID(),
            ],
          );
          await admin(
            `INSERT INTO cc.device_update_jobs(job_id, preview_id, action, confirmed_by, confirmer_permission_version, delegated_subject, batch_size, batch_count)
            VALUES($1, $2, 'reboot', $3, $4, 'admin@example.org', 250, 1)`,
            [jobId, previewId, commandConfirmer, version],
          );
          for (const [index, deviceId] of devices.entries())
            await admin(
              `INSERT INTO cc.device_update_operations(job_id,operation_number,device_id,serial_number,
                org_unit_path,baseline_value,requested_value,batch,status)
              VALUES($1,$2,$3,$4,'/School A','ACTIVE',NULL,0,'pending')`,
              [jobId, index + 1, deviceId, `SN-${deviceId}`],
            );
          return { jobId };
        };

        const job = await commandJob(['cmd-issue-1']);
        const admitted = await admit();
        assert.equal(admitted.jobId, job.jobId);
        const attempt = randomUUID();
        const claimed = await claim(
          job.jobId,
          admitted.dispatchToken,
          0,
          attempt,
        );
        assert.equal(claimed.outcome, 'claimed');
        assert.equal(claimed.action, 'reboot');
        const observedAt = new Date();
        const issued = await settle(
          job.jobId,
          admitted.dispatchToken,
          attempt,
          'issue',
          [
            {
              operationNumber: 1,
              outcome: 'issued',
              commandId: '4100000001',
              googleStatus: 200,
            },
          ],
          observedAt,
        );
        assert.deepEqual(
          issued.settled.map((row) => row.operationNumber),
          [1],
        );
        // The issue shape rejects a missing command ID and a command ID on another outcome.
        await rejects(
          result(
            'SELECT cc.settle_device_update_operations($1,$2,$3,$4,$5,$6,$7) AS result',
            [
              customer,
              job.jobId,
              admitted.dispatchToken,
              attempt,
              'issue',
              JSON.stringify([{ operationNumber: 1, outcome: 'issued' }]),
              new Date(),
            ],
          ),
          '22023',
        );
        await rejects(
          result(
            'SELECT cc.settle_device_update_operations($1,$2,$3,$4,$5,$6,$7) AS result',
            [
              customer,
              job.jobId,
              admitted.dispatchToken,
              attempt,
              'issue',
              JSON.stringify([
                {
                  operationNumber: 1,
                  outcome: 'failed',
                  commandId: '4100000001',
                },
              ]),
              new Date(),
            ],
          ),
          '22023',
        );
        // The poll waits 15 s from this settlement, and the 7-day cap counts from the answer.
        const stored = await adminRow(
          `SELECT status,command_id,command_state,poll_after,poll_deadline_at,verified_by
            FROM cc.device_update_operations WHERE job_id=$1 AND operation_number=1`,
          [job.jobId],
        );
        assert.equal(stored.status, 'issued');
        assert.equal(stored.command_id, '4100000001');
        assert.equal(stored.command_state, 'pending-delivery');
        assert.equal(stored.verified_by, null);
        assert.equal(
          Math.round((stored.poll_after - observedAt) / 1000),
          15,
          'the first poll waits 15 s',
        );
        assert.equal(
          Math.round((stored.poll_deadline_at - observedAt) / 86_400_000),
          7,
          'the poll deadline counts 7 days from the answer',
        );
        // The preparation names the action, so the worker skips its read-back (step 4).
        const prepared = await prepareFinish(job.jobId, admitted.dispatchToken);
        assert.equal(prepared.outcome, 'ready');
        assert.equal(prepared.action, 'reboot');
        const waiting = await result(
          'SELECT cc.finish_device_update_job($1,$2,$3) AS result',
          [customer, job.jobId, admitted.dispatchToken],
        );
        assert.equal(waiting.status, 'awaiting-devices');
        assert.equal(waiting.finishedAt, null);
        // The waiting command job keeps no write slot, so the next update job admits at once.
        const update = await makeJob({ devices: ['cmd-issue-2'] });
        const updateAdmit = await admit();
        assert.equal(updateAdmit.jobId, update.jobId);
        await endJob(update.jobId);
      },
    );

    // B5 (section 4 step 11): a lost issue answer stays unknown, the job ends needs-review, and the
    // reaper starts no read-back for it.
    await check(
      'B5 a lost issue answer ends needs-review and the reaper starts no read-back',
      async () => {
        const commandConfirmer = await principal(
          'command-lost-confirmer@example.org',
          [
            ['devices:commands', district()],
            ['devices:bulk-actions', district()],
          ],
        );
        const version = (
          await adminRow(
            'SELECT permission_version FROM cc.application_principals WHERE id=$1',
            [commandConfirmer],
          )
        ).permission_version;
        const previewId = randomUUID();
        const jobId = randomUUID();
        await admin(
          `INSERT INTO cc.device_update_previews(preview_id, display_id, customer_id, created_by, permission_version, generation, action, action_version, selected, eligible, unchanged, excluded, manifest_digest, expires_at)
          VALUES($1, cc.job_display_id('PV',nextval('cc.preview_number_pv')), $2, $3, $4, $5, 'reboot', 1, 1, 1, 0, 0, 'manifest-digest', clock_timestamp()+interval '1 hour')`,
          [previewId, customer, commandConfirmer, version, generation],
        );
        await admin(
          `INSERT INTO cc.jobs(job_id,display_id,customer_id,kind,scope_kind,status,requested_by,generation,
            target_count,correlation_id)
          VALUES($1,cc.job_display_id('CMD',nextval('cc.job_number_cmd')),$2,'device-command','devices','accepted',$3,$4,1,$5)`,
          [jobId, customer, commandConfirmer, generation, randomUUID()],
        );
        await admin(
          `INSERT INTO cc.device_update_jobs(job_id, preview_id, action, confirmed_by, confirmer_permission_version, delegated_subject, batch_size, batch_count)
          VALUES($1, $2, 'reboot', $3, $4, 'admin@example.org', 250, 1)`,
          [jobId, previewId, commandConfirmer, version],
        );
        await admin(
          `INSERT INTO cc.device_update_operations(job_id,operation_number,device_id,serial_number,
            org_unit_path,baseline_value,requested_value,batch,status)
          VALUES($1,1,'cmd-lost-1','SN-cmd-lost-1','/School A','ACTIVE',NULL,0,'pending')`,
          [jobId],
        );
        const admitted = await admit();
        assert.equal(admitted.jobId, jobId);
        const attempt = randomUUID();
        assert.equal(
          (await claim(jobId, admitted.dispatchToken, 0, attempt)).outcome,
          'claimed',
        );
        // The POST reached Google and no answer arrived. The rule sends no second POST.
        const lost = await settle(
          jobId,
          admitted.dispatchToken,
          attempt,
          'issue',
          [
            {
              operationNumber: 1,
              outcome: 'unknown',
              outcomeReason: 'ambiguous',
              googleStatus: 0,
            },
          ],
          new Date(),
        );
        assert.deepEqual(
          lost.settled.map((row) => row.operationNumber),
          [1],
        );
        assert.equal(
          (
            await adminRow(
              'SELECT status,outcome_reason,poll_after FROM cc.device_update_operations WHERE job_id=$1',
              [jobId],
            )
          ).status,
          'unknown',
        );
        // The runner died before its finish. The reaper takes the job after its heartbeat lapses.
        await admin(
          `UPDATE cc.device_update_jobs SET dispatch_count=3,
            heartbeat_at=clock_timestamp()-interval '11 minutes' WHERE job_id=$1`,
          [jobId],
        );
        const recovered = await recover();
        assert.equal(
          recovered.reconciles.includes(jobId),
          false,
          'the reaper starts no read-back for a command job',
        );
        const state = await adminRow(
          'SELECT status,finished_at FROM cc.jobs WHERE job_id=$1',
          [jobId],
        );
        assert.equal(state.status, 'needs-review');
        assert.notEqual(state.finished_at, null);
        // The unknown operation keeps its status for review.
        const kept = await adminRow(
          'SELECT status,outcome_reason FROM cc.device_update_operations WHERE job_id=$1',
          [jobId],
        );
        assert.equal(kept.status, 'unknown');
        assert.equal(kept.outcome_reason, 'ambiguous');
      },
    );

    // B5 (review F1): command issuance reuses the write ownership contract. An issue settlement with a
    // null or wrong dispatch token, a token rotated in a wait, or a terminal job fences before it
    // changes anything. The current token still settles its operation.
    await check(
      'B5 an issue settlement obeys the dispatch-token fences and the job lifecycle and changes nothing',
      async () => {
        const commandConfirmer = await principal(
          'command-fence-confirmer@example.org',
          [
            ['devices:commands', district()],
            ['devices:bulk-actions', district()],
          ],
        );
        const version = (
          await adminRow(
            'SELECT permission_version FROM cc.application_principals WHERE id=$1',
            [commandConfirmer],
          )
        ).permission_version;
        const previewId = randomUUID();
        const jobId = randomUUID();
        await admin(
          `INSERT INTO cc.device_update_previews(preview_id, display_id, customer_id, created_by, permission_version, generation, action, action_version, selected, eligible, unchanged, excluded, manifest_digest, expires_at)
          VALUES($1, cc.job_display_id('PV',nextval('cc.preview_number_pv')), $2, $3, $4, $5, 'reboot', 1, 1, 1, 0, 0, 'manifest-digest', clock_timestamp()+interval '1 hour')`,
          [previewId, customer, commandConfirmer, version, generation],
        );
        await admin(
          `INSERT INTO cc.jobs(job_id,display_id,customer_id,kind,scope_kind,status,requested_by,generation,
            target_count,correlation_id)
          VALUES($1,cc.job_display_id('CMD',nextval('cc.job_number_cmd')),$2,'device-command','devices','accepted',$3,$4,1,$5)`,
          [jobId, customer, commandConfirmer, generation, randomUUID()],
        );
        await admin(
          `INSERT INTO cc.device_update_jobs(job_id, preview_id, action, confirmed_by, confirmer_permission_version, delegated_subject, batch_size, batch_count)
          VALUES($1, $2, 'reboot', $3, $4, 'admin@example.org', 250, 1)`,
          [jobId, previewId, commandConfirmer, version],
        );
        await admin(
          `INSERT INTO cc.device_update_operations(job_id,operation_number,device_id,serial_number,
            org_unit_path,baseline_value,requested_value,batch,status)
          VALUES($1,1,'cmd-fence-1','SN-cmd-fence-1','/School A','ACTIVE',NULL,0,'pending')`,
          [jobId],
        );
        const admitted = await admit();
        assert.equal(admitted.jobId, jobId);
        const attempt = randomUUID();
        assert.equal(
          (await claim(jobId, admitted.dispatchToken, 0, attempt)).outcome,
          'claimed',
        );
        // The snapshot holds every row that an issue settlement writes: the header and its counters,
        // the detail metadata, the operation row, and the publication. The dispatch token is recorded
        // apart, because the rotation probe changes it on purpose.
        const snapshot = async () => {
          const detail = await adminRow(
            'SELECT * FROM cc.device_update_jobs WHERE job_id=$1',
            [jobId],
          );
          const { dispatch_token: token, ...metadata } = detail;
          return {
            job: await adminRow('SELECT * FROM cc.jobs WHERE job_id=$1', [
              jobId,
            ]),
            metadata,
            token,
            operations: await admin(
              'SELECT * FROM cc.device_update_operations WHERE job_id=$1 ORDER BY operation_number',
              [jobId],
            ),
            publications: await publications(jobId),
          };
        };
        const issue = JSON.stringify([
          {
            operationNumber: 1,
            outcome: 'unknown',
            outcomeReason: 'ambiguous',
            googleStatus: 0,
          },
        ]);
        const settleIssue = (token) =>
          result(
            'SELECT cc.settle_device_update_operations($1,$2,$3,$4,$5,$6,$7) AS result',
            [customer, jobId, token, attempt, 'issue', issue, new Date()],
          );
        const before = await snapshot();
        assert.equal(before.operations[0].status, 'dispatched');
        // A null token fences the issue kind explicitly, as it fences the write kind.
        assert.equal(
          (await settleIssue(null)).outcome,
          'fenced',
          'A null dispatch token fences an issue settlement.',
        );
        assert.deepEqual(await snapshot(), before);
        // A token of another attempt fences the same way.
        assert.equal(
          (await settleIssue(randomUUID())).outcome,
          'fenced',
          'A superseded dispatch token fences an issue settlement.',
        );
        assert.deepEqual(await snapshot(), before);
        // The second guard repeats the token after the operation and detail waits. The holder blocks
        // the operation row, the migration role rotates the token, and the released call fences.
        const { answer: rotated } = await waitedOn({
          rows: [heldOperationRow(jobId)],
          sql: settleSql,
          values: [
            customer,
            jobId,
            admitted.dispatchToken,
            attempt,
            'issue',
            issue,
            new Date(),
          ],
          during: () => rotateToken(jobId),
        });
        assert.equal(rotated.code, undefined, rotated.message);
        assert.equal(
          rotated.rows[0].result.outcome,
          'fenced',
          'An issue settlement repeats its token after the operation wait.',
        );
        const afterRotation = await snapshot();
        assert.notEqual(
          afterRotation.token,
          before.token,
          'The probe rotated the dispatch token in the wait.',
        );
        assert.deepEqual(afterRotation.job, before.job);
        assert.deepEqual(afterRotation.metadata, before.metadata);
        assert.deepEqual(afterRotation.operations, before.operations);
        assert.equal(afterRotation.publications, before.publications);
        // The current token settles its operation, so the fences reject only a superseded call.
        const settled = await settle(
          jobId,
          afterRotation.token,
          attempt,
          'issue',
          [
            {
              operationNumber: 1,
              outcome: 'unknown',
              outcomeReason: 'ambiguous',
              googleStatus: 0,
            },
          ],
          new Date(),
        );
        assert.deepEqual(
          settled.settled.map((row) => row.operationNumber),
          [1],
        );
        const stored = (await operations(jobId))[0];
        assert.equal(stored.status, 'unknown');
        assert.equal(stored.outcome_reason, 'ambiguous');
        // A terminal job fences the issue kind too, as the write guard does.
        assert.equal((await endJob(jobId)).outcome, 'finalized');
        const closed = await snapshot();
        assert.equal(closed.job.status, 'needs-review');
        assert.notEqual(closed.job.finished_at, null);
        assert.equal(
          (await settleIssue(closed.token)).outcome,
          'fenced',
          'A terminal job fences an issue settlement.',
        );
        assert.deepEqual(await snapshot(), closed);
      },
    );
  } finally {
    await migrator.query('UPDATE cc.google_connection SET active=$1', [
      wasActive,
    ]);
    await migrator.query(
      'UPDATE cc.google_connection SET generation=$2 WHERE customer_id=$1',
      [customer, generation],
    );
    for (const id of principals)
      try {
        await migrator.query(
          `DELETE FROM cc.device_update_jobs WHERE job_id IN (SELECT job_id FROM cc.jobs WHERE requested_by=$1)`,
          [id],
        );
        await migrator.query(
          'DELETE FROM cc.device_update_previews WHERE created_by=$1',
          [id],
        );
        await migrator.query(
          'DELETE FROM cc.device_write_overlays WHERE customer_id=$1 AND device_id IN (SELECT device_id FROM cc.devices WHERE customer_id=$1)',
          [customer],
        );
        await migrator.query('DELETE FROM cc.jobs WHERE requested_by=$1', [id]);
        await migrator.query(
          'UPDATE cc.device_sync_state SET sync_id=NULL,sync_expires_at=NULL WHERE customer_id=$1 AND sync_actor=$2',
          [customer, id],
        );
        await migrator.query(
          'DELETE FROM cc.application_grants WHERE principal_id=$1',
          [id],
        );
        await migrator.query(
          'DELETE FROM cc.application_principals WHERE id=$1',
          [id],
        );
      } catch {
        /* A fixture row that another table still names stays. */
      }
    await migrator.query(
      "DELETE FROM cc.devices WHERE customer_id=$1 AND device_id LIKE 'big%'",
      [customer],
    );
  }
  if (failures.length)
    throw new Error(`Device write job checks failed: ${failures.join(' | ')}`);
  return results;
}

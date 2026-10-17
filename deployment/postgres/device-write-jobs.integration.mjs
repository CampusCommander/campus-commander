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
        "SELECT job_id FROM cc.jobs WHERE kind='device-update' AND status='running' ORDER BY created_at",
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
    }) => {
      const jobId = randomUUID();
      const previewId = randomUUID();
      const version = (
        await adminRow(
          'SELECT permission_version FROM cc.application_principals WHERE id=$1',
          [createdBy],
        )
      ).permission_version;
      await admin(
        `INSERT INTO cc.device_update_previews(preview_id,display_id,customer_id,created_by,permission_version,
          generation,field,mode,value,selected,eligible,unchanged,excluded,manifest_digest,expires_at)
        VALUES($1,cc.job_display_id('PV',nextval('cc.preview_number_pv')),$2,$3,$4,$5,'annotatedLocation',$6,$7,$8,$8,0,0,
          'manifest-digest',clock_timestamp()+interval '1 hour')`,
        [
          previewId,
          customer,
          createdBy,
          version,
          generation,
          mode,
          mode === 'clear' ? null : value,
          devices.length,
        ],
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
        `INSERT INTO cc.device_update_jobs(job_id,preview_id,field,mode,value,confirmed_by,confirmer_permission_version,
          delegated_subject,batch_size,batch_count)
        VALUES($1,$2,'annotatedLocation',$3,$4,$5,$6,'spencer@easton-consulting.com',$7,$8)`,
        [
          jobId,
          previewId,
          mode,
          mode === 'clear' ? null : value,
          createdBy,
          version,
          batchSize,
          Math.ceil(devices.length / batchSize),
        ],
      );
      for (const [index, deviceId] of devices.entries())
        await admin(
          `INSERT INTO cc.device_update_operations(job_id,operation_number,device_id,serial_number,org_unit_path,
            baseline_value,requested_value,batch,status)
          VALUES($1,$2,$3,$4,'/School A',NULL,$5,$6,'pending')`,
          [
            jobId,
            index + 1,
            deviceId,
            `SN-${deviceId}`,
            mode === 'clear' ? null : value,
            Math.floor(index / batchSize),
          ],
        );
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
      if (kind === 'write' && settled.settled && settled.settled.length > 0)
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
        `SELECT operation_number,device_id,status,attempt_id,observed_value,observed_at,verified_by,outcome_reason,
          verify_attempt FROM cc.device_update_operations WHERE job_id=$1 ORDER BY operation_number`,
        [jobId],
      );
    const jobRow = (jobId) =>
      adminRow('SELECT * FROM cc.jobs WHERE job_id=$1', [jobId]);
    const deviceRow = (deviceId) =>
      adminRow(
        'SELECT annotated_location,annotated_location_observed_at,removed_at FROM cc.devices WHERE customer_id=$1 AND device_id=$2',
        [customer, deviceId],
      );
    const overlay = async (deviceId) =>
      (
        await admin(
          'SELECT * FROM cc.device_write_overlays WHERE customer_id=$1 AND device_id=$2',
          [customer, deviceId],
        )
      )[0];
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
          `INSERT INTO cc.device_update_previews(preview_id,display_id,customer_id,created_by,permission_version,
            generation,field,mode,value,selected,eligible,unchanged,excluded,manifest_digest,expires_at)
          VALUES($1,cc.job_display_id('PV',nextval('cc.preview_number_pv')),$2,$3,1,$4,'annotatedLocation','replace',
            'Room 12',1,1,0,0,'manifest-digest',clock_timestamp()-interval '25 hours')`,
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
              value: 'Room 12',
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
              value: 'Stale',
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
              value: 'Room 12',
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
              value: 'Room 12',
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
              value: 'Room 12',
              verifiedBy: 'write-response',
            },
            {
              operationNumber: 2,
              outcome: 'succeeded',
              value: 'Room 12',
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
              value: null,
              verifiedBy: 'write-response',
            },
            {
              operationNumber: 2,
              outcome: 'succeeded',
              value: null,
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
              value: 'Room 12',
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
              value: 'Room 12',
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
              value: 'Room 9',
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
              value: 'quiet-room',
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
              value: 'stale-room',
              verifiedBy: 'read-back',
            },
          ],
          new Date(listed.getTime() + 60 * 60 * 1000),
        );
        assert.equal(settled.settled.length, 1);
        const recorded = (await operations(older.jobId))[0];
        assert.equal(recorded.status, 'succeeded');
        assert.equal(recorded.observed_value, 'stale-room');
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
              value: 'late-room',
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
              value: 'stale-room',
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
              value: 'Room 12',
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
                  value: 'Room 12',
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
                  value: 'Room 12',
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
              value: 'Room 12',
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
              value: 'Room 12',
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
                  value: 'Room 12',
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
                  value: 'Room 12',
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
                  value: 'Room 12',
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
                  value: 'Room 12',
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
                  value: 'Room 12',
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
    const heldJob = async (deviceId) => {
      const job = await makeJob({ devices: [deviceId] });
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
                  value: 'Room 12',
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
                value: 'Room 12',
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
              value: 'Room 12',
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
              value: 'Room 12',
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
          value: 'Room 12',
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
          'cc.write_capable(uuid,text)',
          'cc.device_update_stop_reason(text,uuid,integer,integer)',
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
    const provenanceJob = async (deviceId, kind) => {
      await upsert(
        [device(deviceId, { annotatedLocation: 'Old' })],
        new Date(Date.now() - 60 * 60 * 1000),
      );
      const job = await heldJob(deviceId);
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
                  value: 'Room 12',
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
                value: 'Room 12',
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
          value: 'Room 12',
          verifiedBy: 'read-back',
        },
      ],
      [
        'a read-back success with write-response provenance',
        'read-back',
        {
          operationNumber: 1,
          outcome: 'succeeded',
          value: 'Room 12',
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
          value: 'x'.repeat(4097),
          verifiedBy: 'write-response',
        },
      ],
      [
        'a value that is not a string',
        {
          operationNumber: 1,
          outcome: 'succeeded',
          value: 12,
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
          value: 'Room 12',
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

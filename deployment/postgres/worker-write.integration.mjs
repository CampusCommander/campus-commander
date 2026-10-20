import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// The P2 worker checks of design section 8.3. Each check drives the real worker
// module against the integration database through the runtime role.
const workspace = resolve(import.meta.dirname, '../..');
const load = (path) => import(pathToFileURL(resolve(workspace, path)).href);

export async function qualifyWorkerWrites({ runtime, migrator, issuer }) {
  const [worker, google, sync, cacheModule] = await Promise.all([
    load('worker/src/device-update.ts'),
    load('libs/google-connection/src/index.ts'),
    load('worker/src/device-sync.ts'),
    load('worker/src/entity-cache.ts'),
  ]);
  const { DeviceUpdateJobs } = worker;
  const { BatchServiceError, GoogleConnectionError } = google;
  const { DeviceSyncError } = sync;
  const { EntityCacheError } = cacheModule;
  const connection = (
    await migrator.query('SELECT * FROM cc.google_connection')
  ).rows[0];
  const customer = connection.customer_id;
  const generation = connection.generation;
  const wasActive = connection.active;
  await migrator.query('UPDATE cc.google_connection SET active=true');
  const results = [];
  const failures = [];
  const principals = [];
  const result = (text, values = []) =>
    runtime.query(text, values).then((r) => r.rows[0].result);
  const admin = (text, values = []) =>
    migrator.query(text, values).then((r) => r.rows);
  const adminRow = (text, values = []) =>
    migrator.query(text, values).then((r) => r.rows[0]);
  const check = async (name, body) => {
    calls.length = 0;
    try {
      await body();
      results.push(`${name}: pass`);
    } catch (error) {
      failures.push(name);
      results.push(`${name}: FAIL ${error.message}`);
      await releaseAll();
    }
    process.stderr.write(`check ${results.at(-1)}\n`);
  };
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
  const district = { kind: 'district', customerId: customer };

  // The worker pool. Every call is one autocommit statement (rule W).
  const calls = [];
  const pool = {
    async query(text, values = []) {
      calls.push({ text, values });
      return runtime.query(text, values);
    },
  };
  const settlements = () =>
    calls.filter((call) =>
      call.text.includes('settle_device_update_operations'),
    );

  const confirmer = await principal(`worker-${randomUUID()}`, [
    ['devices:read', district],
    ['devices:write', district],
    ['devices:bulk-actions', district],
    ['jobs:read', district],
  ]);
  const version = (
    await adminRow(
      'SELECT permission_version FROM cc.application_principals WHERE id=$1',
      [confirmer],
    )
  ).permission_version;

  const makeJob = async ({
    devices,
    batchSize = 250,
    mode = 'replace',
    value = 'Room 12',
  }) => {
    const jobId = randomUUID();
    const previewId = randomUUID();
    await admin(
      `INSERT INTO cc.device_update_previews(preview_id,display_id,customer_id,created_by,permission_version,
        generation,field,mode,value,selected,eligible,unchanged,excluded,manifest_digest,expires_at)
      VALUES($1,cc.job_display_id('PV',nextval('cc.preview_number_pv')),$2,$3,$4,$5,'annotatedLocation',$6,$7,$8,$8,0,0,
        'manifest-digest',clock_timestamp()+interval '1 hour')`,
      [
        previewId,
        customer,
        confirmer,
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
        $5,$6,clock_timestamp())`,
      [jobId, customer, confirmer, generation, devices.length, randomUUID()],
    );
    await admin(
      `INSERT INTO cc.device_update_jobs(job_id,preview_id,field,mode,value,confirmed_by,confirmer_permission_version,
        delegated_subject,batch_size,batch_count)
      VALUES($1,$2,'annotatedLocation',$3,$4,$5,$6,'admin@example.org',$7,$8)`,
      [
        jobId,
        previewId,
        mode,
        mode === 'clear' ? null : value,
        confirmer,
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
    const admitted = await result(
      'SELECT cc.admit_device_update_job($1,$2) AS result',
      [customer, false],
    );
    assert.equal(
      admitted.jobId,
      jobId,
      'The admission must admit the seeded job.',
    );
    return { jobId, admitted };
  };

  /** A reader that reports the events of one write call and one read-back. */
  const readerOf = (script) => {
    const calls = [];
    return {
      calls,
      async patchAnnotatedLocations(
        _credential,
        _customer,
        writes,
        signal,
        options,
      ) {
        calls.push({
          name: 'patch',
          writes: writes.map((write) => ({ ...write })),
        });
        const result = { succeeded: new Map(), failed: new Map() };
        for (const round of script.rounds) {
          if (signal.aborted) break;
          if (round.kill) throw new Error('worker killed');
          const ids = round.ids;
          await options.onSend?.(ids);
          for (const id of ids) {
            const answer = round.parts[id];
            const event = {
              id,
              status: answer.status,
              attempts: answer.attempts ?? { quota: 0, transient: 0 },
              request: { id, method: 'PATCH', path: `/devices/${id}` },
              outcome:
                answer.kind === 'success'
                  ? {
                      kind: 'success',
                      page: { deviceId: id },
                      pageIndex: 0,
                      hasNextPage: false,
                    }
                  : answer.kind === 'retry'
                    ? {
                        kind: 'retry',
                        failure: {
                          kind: answer.failureKind ?? 'transient',
                          status: answer.status,
                          reason: answer.reason ?? null,
                          attempts: answer.attempts ?? {
                            quota: 0,
                            transient: 1,
                          },
                          body: null,
                        },
                        retryInMs: 1000,
                      }
                    : {
                        kind: 'failed',
                        failure: {
                          kind: answer.failureKind ?? 'auth',
                          status: answer.status,
                          reason: answer.reason ?? null,
                          attempts: answer.attempts ?? {
                            quota: 0,
                            transient: 0,
                          },
                          body: answer.body ?? null,
                        },
                      },
            };
            if (event.outcome.kind === 'success')
              result.succeeded.set(id, [event.outcome.page]);
            else if (event.outcome.kind === 'failed')
              result.failed.set(id, event.outcome.failure);
            await options.onResponse?.(event);
          }
          await options.onBatch?.({
            round: 1,
            sentCount: ids.length,
            outerStatus: 200,
            durationMs: 1,
            pending: 0,
          });
        }
        return result;
      },
      async deviceStates(_credential, _customer, ids) {
        calls.push({ name: 'deviceStates', ids: [...ids] });
        return ids.map((id) => ({
          deviceId: id,
          status: 'found',
          device: { deviceId: id, annotatedLocation: script.state(id) },
        }));
      },
    };
  };

  const cacheOf = (options = {}) => {
    const calls = [];
    return {
      calls,
      async setRecords(entries) {
        calls.push({ name: 'setRecords', entries });
      },
      async remove(keys) {
        calls.push({ name: 'remove', keys });
      },
      async removeMembers() {},
      async extendMembers() {},
      async increment(key) {
        calls.push({ name: 'increment', key });
      },
      async publish(channel, message) {
        if (options.failPublish) throw options.failPublish;
        calls.push({ name: 'publish', channel, message });
      },
      async close() {},
    };
  };

  const run = (
    jobId,
    batch,
    { reader, cache = cacheOf(), batchSize = 250, token, attempt } = {},
  ) =>
    new DeviceUpdateJobs(
      pool,
      { open: () => ({ subject: 'fixture@example.invalid' }) },
      reader,
      cache,
      { batchSize },
    ).runBatch(
      {
        customerId: customer,
        jobId,
        dispatchToken: token,
        batch,
        correlationId: randomUUID(),
      },
      AbortSignal.timeout(120_000),
    );
  const tokenOf = async (jobId) =>
    (
      await adminRow(
        'SELECT dispatch_token FROM cc.device_update_jobs WHERE job_id=$1',
        [jobId],
      )
    ).dispatch_token;
  const operation = (jobId, number) =>
    adminRow(
      'SELECT status,outcome_reason,verified_by,observed_value,verify_attempt FROM cc.device_update_operations WHERE job_id=$1 AND operation_number=$2',
      [jobId, number],
    );
  const header = (jobId) =>
    adminRow(
      `SELECT j.status,j.failure,d.scope_observations,d.scope_failure
        FROM cc.jobs j JOIN cc.device_update_jobs d ON d.job_id=j.job_id WHERE j.job_id=$1`,
      [jobId],
    );
  const device = (deviceId) => ({
    deviceId,
    serialNumber: `SN-${deviceId}`,
    model: 'Lenovo 100e Gen 4',
    assetTag: null,
    orgUnitPath: '/School A',
    lastContact: '2026-10-05T12:00:00.000Z',
    annotatedLocation: 'Room 1',
    notes: null,
    status: 'ACTIVE',
  });
  const seedDevice = (deviceId) =>
    result('SELECT cc.upsert_devices($1,$2,$3,$4) AS result', [
      customer,
      JSON.stringify([device(deviceId)]),
      new Date().toISOString(),
      'list',
    ]);
  const releaseAll = async () => {
    await migrator.query(
      `UPDATE cc.device_update_batches SET lease_expires_at=clock_timestamp()-interval '60 seconds'`,
    );
    for (const row of await admin(
      "SELECT job_id FROM cc.jobs WHERE kind='device-update' AND status='running'",
    ))
      await migrator.query('SELECT cc.finalize_device_update_job($1,$2,$3)', [
        customer,
        row.job_id,
        null,
      ]);
  };

  try {
    await check(
      'a refusal fails one operation and reads back none of them',
      async () => {
        for (const [answer, failure] of [
          [
            { status: 403, failureKind: 'auth', reason: 'forbidden' },
            'permission-denied',
          ],
          [
            { status: 400, failureKind: 'rejected', reason: 'badRequest' },
            null,
          ],
          [{ status: 404, failureKind: 'not-found', reason: 'notFound' }, null],
        ]) {
          const { jobId } = await makeJob({ devices: ['d-refusal'] });
          const token = await tokenOf(jobId);
          const reader = readerOf({
            rounds: [{ ids: ['d-refusal'], parts: { 'd-refusal': answer } }],
            state: () => 'Room 12',
          });
          const response = await run(jobId, 0, { reader, token });
          assert.equal(
            response.outcome,
            failure === null ? 'settled' : 'stopped',
            `status ${answer.status}`,
          );
          const row = await operation(jobId, 1);
          assert.equal(row.status, 'failed');
          assert.equal(
            reader.calls.filter((one) => one.name === 'deviceStates').length,
            0,
          );
          assert.equal((await header(jobId)).failure, failure);
          await releaseAll();
        }
      },
    );

    await check(
      'a lost request then a refusal is read back to succeeded',
      async () => {
        const { jobId } = await makeJob({ devices: ['d-lost'] });
        const token = await tokenOf(jobId);
        const reader = readerOf({
          rounds: [
            {
              ids: ['d-lost'],
              parts: {
                'd-lost': { kind: 'retry', status: 0, reason: 'timeout' },
              },
            },
            {
              ids: ['d-lost'],
              parts: {
                'd-lost': {
                  status: 403,
                  failureKind: 'auth',
                  reason: 'forbidden',
                  attempts: { quota: 0, transient: 1 },
                },
              },
            },
          ],
          state: () => 'Room 12',
        });
        const response = await run(jobId, 0, { reader, token, batchSize: 1 });
        assert.equal(response.outcome, 'stopped');
        assert.equal(response.failure, 'permission-denied');
        const row = await operation(jobId, 1);
        assert.equal(row.status, 'succeeded');
        assert.equal(row.verified_by, 'read-back');
        assert.equal(row.observed_value, 'Room 12');
        assert.equal(
          reader.calls.filter((one) => one.name === 'deviceStates').length,
          1,
        );
        await releaseAll();
      },
    );

    await check(
      'a fatal batch error keeps a 2xx and leaves the sent operation unknown',
      async () => {
        const { jobId } = await makeJob({ devices: ['d-kept', 'd-sent'] });
        const token = await tokenOf(jobId);
        const reader = readerOf({
          rounds: [
            {
              ids: ['d-kept'],
              parts: { 'd-kept': { kind: 'success' } },
            },
          ],
          state: () => 'Room 12',
        });
        const patch = reader.patchAnnotatedLocations;
        let sent = 0;
        reader.patchAnnotatedLocations = async (
          credential,
          customerId,
          writes,
          signal,
          options,
        ) => {
          const first = await patch(
            credential,
            customerId,
            [writes[0]],
            signal,
            options,
          );
          sent += 1;
          await options.onSend?.(['d-sent']);
          throw new BatchServiceError(
            'malformed-response',
            'malformed multipart',
          );
        };
        const response = await run(jobId, 0, { reader, token, batchSize: 1 });
        assert.equal(sent, 1);
        assert.equal(response.outcome, 'stopped');
        assert.equal(response.failure, 'invalid-response');
        assert.equal((await operation(jobId, 1)).status, 'succeeded');
        const second = await operation(jobId, 2);
        assert.equal(
          second.status,
          'succeeded',
          'The read-back of place 4 settles the sent operation.',
        );
        assert.equal(second.verified_by, 'read-back');
        assert.equal((await header(jobId)).failure, 'invalid-response');
        await releaseAll();
      },
    );

    await check(
      'a graceful stop returns unsent operations to pending and releases',
      async () => {
        const { jobId } = await makeJob({ devices: ['d-stop'] });
        const token = await tokenOf(jobId);
        const stopping = new AbortController();
        const reader = readerOf({
          rounds: [{ ids: ['d-stop'], parts: {} }],
          state: () => 'Room 12',
        });
        const patch = reader.patchAnnotatedLocations;
        reader.patchAnnotatedLocations = async (
          credential,
          customerId,
          writes,
          signal,
          options,
        ) => {
          // The batch service stops sending once its signal aborts.
          stopping.abort();
          return patch(credential, customerId, writes, signal, options);
        };
        const response = await new DeviceUpdateJobs(
          pool,
          { open: () => ({}) },
          reader,
          cacheOf(),
        ).runBatch(
          {
            customerId: customer,
            jobId,
            dispatchToken: token,
            batch: 0,
            correlationId: randomUUID(),
          },
          stopping.signal,
        );
        assert.equal(response.outcome, 'settled');
        const row = await operation(jobId, 1);
        assert.equal(
          row.status,
          'pending',
          'An unsent operation returns to pending.',
        );
        const batch = await adminRow(
          'SELECT attempt_id,lease_expires_at FROM cc.device_update_batches WHERE job_id=$1 AND batch=0',
          [jobId],
        );
        assert.equal(batch.attempt_id, null, 'The release clears the lease.');
        await releaseAll();
      },
    );

    await check(
      'a mint failure skips the claimed operations and records the failure',
      async () => {
        const { jobId } = await makeJob({ devices: ['d-mint'] });
        const token = await tokenOf(jobId);
        const reader = readerOf({
          rounds: [],
          state: () => 'Room 12',
        });
        reader.patchAnnotatedLocations = async () => {
          throw new GoogleConnectionError('network-failure');
        };
        const response = await run(jobId, 0, { reader, token });
        assert.equal(response.outcome, 'stopped');
        assert.equal(response.failure, 'network-failure');
        const row = await operation(jobId, 1);
        assert.equal(row.status, 'skipped');
        assert.equal(row.outcome_reason, 'network-failure');
        assert.equal((await header(jobId)).failure, 'network-failure');
        assert.equal(
          reader.calls.filter((one) => one.name === 'deviceStates').length,
          0,
        );
        await releaseAll();
      },
    );

    await check(
      'a scope observation records its failure and its count',
      async () => {
        const { jobId } = await makeJob({
          devices: ['d-scope-1', 'd-scope-2', 'd-scope-3'],
        });
        const token = await tokenOf(jobId);
        const reader = readerOf({
          rounds: [
            {
              ids: ['d-scope-1'],
              parts: {
                'd-scope-1': {
                  status: 403,
                  failureKind: 'auth',
                  reason: 'forbidden',
                },
              },
            },
            {
              ids: ['d-scope-2'],
              parts: {
                'd-scope-2': {
                  status: 403,
                  failureKind: 'auth',
                  reason: 'invalid_scope',
                  body: { error: { errors: [{ reason: 'invalid_scope' }] } },
                },
              },
            },
            {
              ids: ['d-scope-3'],
              parts: {
                'd-scope-3': {
                  status: 403,
                  failureKind: 'auth',
                  reason: 'invalid_scope',
                  body: { error: { errors: [{ reason: 'invalid_scope' }] } },
                },
              },
            },
          ],
          state: () => 'Room 12',
        });
        const response = await run(jobId, 0, { reader, token, batchSize: 1 });
        assert.equal(response.outcome, 'stopped');
        const row = await header(jobId);
        assert.equal(row.failure, 'permission-denied');
        assert.equal(row.scope_observations, 2);
        assert.equal(row.scope_failure, 'scope-mismatch');
        const scopeParameters = settlements().map((call) => call.values[8]);
        assert.equal(
          scopeParameters[0],
          null,
          'The round-1 settlement carries no scope failure.',
        );
        assert.equal(scopeParameters[1], 'scope-mismatch');
        await releaseAll();
      },
    );

    await check(
      'a duplicate request answers done and sends nothing',
      async () => {
        const { jobId } = await makeJob({ devices: ['d-duplicate'] });
        const token = await tokenOf(jobId);
        const first = readerOf({
          rounds: [
            {
              ids: ['d-duplicate'],
              parts: { 'd-duplicate': { kind: 'success' } },
            },
          ],
          state: () => 'Room 12',
        });
        await run(jobId, 0, { reader: first, token });
        const second = readerOf({ rounds: [], state: () => 'Room 12' });
        const response = await run(jobId, 0, { reader: second, token });
        assert.deepEqual(response, { outcome: 'done' });
        assert.equal(second.calls.length, 0);
        await releaseAll();
      },
    );

    await check(
      'a batch keeps no entity entry and a read-back 404 removes its key',
      async () => {
        const { jobId } = await makeJob({ devices: ['d-cache'] });
        await seedDevice('d-cache');
        const token = await tokenOf(jobId);
        const cache = cacheOf();
        const reader = readerOf({
          rounds: [
            {
              ids: ['d-cache'],
              parts: {
                'd-cache': { kind: 'retry', status: 0, reason: 'timeout' },
              },
            },
            {
              ids: ['d-cache'],
              parts: {
                'd-cache': {
                  status: 403,
                  failureKind: 'auth',
                  reason: 'forbidden',
                  attempts: { quota: 0, transient: 1 },
                },
              },
            },
          ],
          state: () => 'Room 12',
        });
        reader.deviceStates = async (_credential, _customer, ids) => {
          reader.calls.push({ name: 'deviceStates', ids: [...ids] });
          return ids.map((id) => ({ deviceId: id, status: 'missing' }));
        };
        await run(jobId, 0, { reader, cache, token, batchSize: 1 });
        assert.equal(
          cache.calls.filter((call) => call.name === 'setRecords').length,
          0,
          'The write path stores no entity entry.',
        );
        const removed = cache.calls.filter((call) => call.name === 'remove');
        assert.deepEqual(removed[0].keys, [
          `cc:entity:device:${customer}:d-cache`,
        ]);
        assert.equal((await operation(jobId, 1)).status, 'failed');
        await releaseAll();
      },
    );

    await check('a publication row survives a Redis failure', async () => {
      const { jobId } = await makeJob({ devices: ['d-publish'] });
      const token = await tokenOf(jobId);
      const cache = cacheOf();
      cache.publish = async () => {
        throw new EntityCacheError();
      };
      const reader = readerOf({
        rounds: [
          { ids: ['d-publish'], parts: { 'd-publish': { kind: 'success' } } },
        ],
        state: () => 'Room 12',
      });
      const response = await run(jobId, 0, { reader, cache, token });
      assert.equal(response.outcome, 'settled');
      const rows = await admin(
        'SELECT publication_id FROM cc.job_publications WHERE job_id=$1',
        [jobId],
      );
      assert.ok(rows.length >= 1, 'The row stays for the relay.');
      await releaseAll();
    });

    await check(
      '1001 unknown operations read back in five chunks under 250 results',
      async () => {
        const jobId = randomUUID();
        const previewId = randomUUID();
        await admin(
          `INSERT INTO cc.device_update_previews(preview_id,display_id,customer_id,created_by,permission_version,
          generation,field,mode,value,selected,eligible,unchanged,excluded,manifest_digest,expires_at)
        VALUES($1,cc.job_display_id('PV',nextval('cc.preview_number_pv')),$2,$3,$4,$5,'annotatedLocation','replace','Room 12',1001,1001,0,0,
          'manifest-digest',clock_timestamp()+interval '1 hour')`,
          [previewId, customer, confirmer, version, generation],
        );
        await admin(
          `INSERT INTO cc.jobs(job_id,display_id,customer_id,kind,scope_kind,status,requested_by,generation,
          target_count,correlation_id,created_at)
        VALUES($1,cc.job_display_id('UPD',nextval('cc.job_number_upd')),$2,'device-update','devices','running',$3,$4,
          1001,$5,clock_timestamp())`,
          [jobId, customer, confirmer, generation, randomUUID()],
        );
        await admin(
          `INSERT INTO cc.device_update_jobs(job_id,preview_id,field,mode,value,confirmed_by,confirmer_permission_version,
          delegated_subject,batch_size,batch_count)
        VALUES($1,$2,'annotatedLocation','replace','Room 12',$3,$4,'admin@example.org',250,5)`,
          [jobId, previewId, confirmer, version],
        );
        await admin(
          `INSERT INTO cc.device_update_operations(job_id,operation_number,device_id,serial_number,org_unit_path,
          baseline_value,requested_value,batch,status,outcome_reason)
        SELECT $1,n,'bulk-'||n,'SN-bulk-'||n,'/School A',NULL,'Room 12',(n-1)/250,'unknown','interrupted'
        FROM generate_series(1,1001) n`,
          [jobId],
        );
        const reader = readerOf({ rounds: [], state: () => 'Room 12' });
        const cache = cacheOf();
        const summary = await new DeviceUpdateJobs(
          pool,
          { open: () => ({}) },
          reader,
          cache,
        ).runReconcile(
          {
            customerId: customer,
            jobId,
            operationNumber: 'all',
            correlationId: randomUUID(),
          },
          AbortSignal.timeout(30_000),
        );
        assert.equal(summary.outcome, 'settled');
        assert.equal(summary.readBack.claimed, 1001);
        assert.equal(summary.readBack.settled, 1001);
        assert.equal(summary.readBack.verified, 1001);
        const chunks = settlements();
        assert.equal(
          chunks.length,
          5,
          'Five chunks of 250, 250, 250, 250, and 1.',
        );
        for (const call of chunks)
          assert.ok(JSON.parse(call.values[5]).length <= 250);
        assert.equal(
          (
            await adminRow(
              "SELECT count(*)::int AS count FROM cc.device_update_operations WHERE job_id=$1 AND status='succeeded'",
              [jobId],
            )
          ).count,
          1001,
        );
        // Release the write slot for the checks that follow.
        await admin("UPDATE cc.jobs SET status='completed' WHERE job_id=$1", [
          jobId,
        ]);
      },
    );

    await check(
      'a killed runner leaves dispatched operations that a retry fences and reads back',
      async () => {
        const { jobId } = await makeJob({ devices: ['d-kill-1', 'd-kill-2'] });
        const token = await tokenOf(jobId);
        // The first attempt claims, then dies before the write leaves.
        const dying = readerOf({ rounds: [], state: () => 'Room 12' });
        dying.patchAnnotatedLocations = async () => {
          throw new DeviceSyncError('worker-stopping');
        };
        await assert.rejects(
          run(jobId, 0, { reader: dying, token }),
          (error) => error.code === 'worker-stopping',
        );
        const dispatched = await admin(
          'SELECT status FROM cc.device_update_operations WHERE job_id=$1 ORDER BY 1',
          [jobId],
        );
        assert.deepEqual(
          dispatched.map((row) => row.status),
          ['dispatched', 'dispatched'],
        );
        // The lease and the grace lapse while no worker runs.
        await admin(
          "UPDATE cc.device_update_batches SET lease_expires_at=clock_timestamp()-interval '2 minutes' WHERE job_id=$1",
          [jobId],
        );
        await admin(
          "UPDATE cc.device_update_jobs SET heartbeat_at=clock_timestamp()-interval '3 minutes' WHERE job_id=$1",
          [jobId],
        );
        const retry = readerOf({ rounds: [], state: () => 'Room 12' });
        const answer = await run(jobId, 0, { reader: retry, token });
        assert.equal(answer.outcome, 'settled');
        const rows = await admin(
          'SELECT status,verified_by FROM cc.device_update_operations WHERE job_id=$1 ORDER BY 1',
          [jobId],
        );
        assert.deepEqual(
          rows.map((row) => [row.status, row.verified_by]),
          [
            ['succeeded', 'read-back'],
            ['succeeded', 'read-back'],
          ],
        );
        assert.equal(
          retry.calls.filter((call) => call.name === 'patch').length,
          0,
          'A fenced operation sends no part.',
        );
        await releaseAll();
      },
    );

    await check(
      'a stopping settlement keeps the failure for later claims',
      async () => {
        const { jobId } = await makeJob({
          devices: ['d-a1-1', 'd-a1-2', 'd-a1-3', 'd-a1-4'],
          batchSize: 2,
        });
        const token = await tokenOf(jobId);
        const reader = readerOf({
          rounds: [
            {
              ids: ['d-a1-1'],
              parts: {
                'd-a1-1': {
                  status: 403,
                  failureKind: 'auth',
                  reason: 'forbidden',
                },
              },
            },
            { ids: [], parts: {}, kill: true },
          ],
          state: () => 'Room 12',
        });
        await assert.rejects(run(jobId, 0, { reader, token, batchSize: 1 }));
        assert.equal((await header(jobId)).failure, 'permission-denied');
        const later = readerOf({ rounds: [], state: () => 'Room 12' });
        const same = await run(jobId, 0, { reader: later, token });
        assert.deepEqual(same, {
          outcome: 'stopped',
          failure: 'permission-denied',
        });
        const next = await run(jobId, 1, { reader: later, token });
        assert.deepEqual(next, {
          outcome: 'stopped',
          failure: 'permission-denied',
        });
        assert.equal(later.calls.length, 0, 'A stopped claim sends no part.');
        await releaseAll();
      },
    );

    await check(
      'a stopped claim refreshes the heartbeat so no start recovers',
      async () => {
        const { jobId } = await makeJob({
          devices: ['d-a2-1', 'd-a2-2', 'd-a2-3'],
          batchSize: 1,
        });
        const token = await tokenOf(jobId);
        const reader = readerOf({
          rounds: [
            {
              ids: ['d-a2-1'],
              parts: {
                'd-a2-1': {
                  status: 403,
                  failureKind: 'auth',
                  reason: 'forbidden',
                },
              },
            },
          ],
          state: () => 'Room 12',
        });
        const response = await run(jobId, 0, { reader, token, batchSize: 1 });
        assert.equal(response.outcome, 'stopped');
        for (const batch of [1, 2]) {
          await admin(
            "UPDATE cc.device_update_jobs SET heartbeat_at=clock_timestamp()-interval '11 minutes' WHERE job_id=$1",
            [jobId],
          );
          const later = readerOf({ rounds: [], state: () => 'Room 12' });
          const stopped = await run(jobId, batch, { reader: later, token });
          assert.equal(stopped.outcome, 'stopped');
          const recovery = await result(
            'SELECT cc.recover_device_update_jobs($1) AS result',
            [customer],
          );
          assert.deepEqual(
            recovery.starts.filter((start) => start.jobId === jobId),
            [],
            'A stopped claim refreshes the heartbeat.',
          );
        }
        await releaseAll();
      },
    );
  } finally {
    await migrator.query(
      'UPDATE cc.google_connection SET active=$2 WHERE customer_id=$1',
      [customer, wasActive],
    );
    await releaseAll();
  }
  if (failures.length)
    throw new Error(
      `Device write worker checks failed: ${failures.join(' | ')}`,
    );
  return results;
}

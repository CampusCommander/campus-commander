import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export async function qualifyDeviceInventory({ runtime, migrator, issuer }) {
  const connection = (
    await migrator.query('SELECT * FROM cc.google_connection')
  ).rows[0];
  const customer = connection.customer_id;
  const generation = connection.generation;
  const wasActive = connection.active;
  await migrator.query('UPDATE cc.google_connection SET active=true');
  const reader = randomUUID();
  const outsider = randomUUID();
  try {
    for (const id of [reader, outsider])
      await migrator.query(
        'INSERT INTO cc.application_principals(id,issuer,subject,display_name) VALUES($1,$2,$3,$3)',
        [id, issuer, id],
      );
    await migrator.query(
      'INSERT INTO cc.application_grants(principal_id,action,scope) VALUES($1,$2,$3)',
      [
        reader,
        'devices:read',
        JSON.stringify({ kind: 'district', customerId: customer }),
      ],
    );
    const result = (sql, values) =>
      runtime.query(sql, values).then((r) => r.rows[0].result);
    const read = (who = reader) =>
      result('SELECT cc.read_device_sync($1,1) AS result', [who]);
    const request = (id = randomUUID()) =>
      result('SELECT cc.request_device_sync($1,1,$2,$3,$4,$5) AS result', [
        reader,
        customer,
        generation,
        id,
        randomUUID(),
      ]).then((state) => ({ id, state }));
    const claim = (id, attempt) =>
      result('SELECT cc.claim_device_sync($1,$2,$3) AS result', [
        customer,
        id,
        attempt,
      ]);
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
    const stage = (id, attempt, devices) =>
      result('SELECT cc.stage_devices($1,$2,$3,$4) AS result', [
        customer,
        id,
        attempt,
        JSON.stringify(devices),
      ]);
    const batteries = (id, attempt, values) =>
      result('SELECT cc.stage_device_batteries($1,$2,$3,$4) AS result', [
        customer,
        id,
        attempt,
        JSON.stringify(values),
      ]);
    const finish = (id, attempt, failure = null, telemetry = null) =>
      result('SELECT cc.finish_device_sync($1,$2,$3,$4,$5) AS result', [
        customer,
        id,
        attempt,
        failure,
        telemetry,
      ]);
    const rows = async () =>
      (
        await runtime.query(
          'SELECT device_id,model,last_entity_sync,removed_at,battery_status FROM cc.devices WHERE customer_id=$1 ORDER BY device_id',
          [customer],
        )
      ).rows;
    const detail = (code) => (error) => error.detail === code;
    const fullSync = async (devices, failure = null) => {
      const { id } = await request();
      const attempt = randomUUID();
      await claim(id, attempt);
      await stage(id, attempt, devices);
      return finish(id, attempt, failure);
    };

    assert.equal((await read()).status, 'never');
    await assert.rejects(read(outsider), (error) => error.code === '42501');

    // Full sync: upsert, battery, publication.
    const first = await request();
    assert.equal(first.state.status, 'running');
    await assert.rejects(request(), detail('device-sync-running'));
    const attempt = randomUUID();
    const claimed = await claim(first.id, attempt);
    assert.equal(claimed.generation, generation);
    await assert.rejects(
      claim(first.id, randomUUID()),
      detail('device-sync-claimed'),
    );
    assert.equal(
      await stage(first.id, attempt, [
        device('d1'),
        device('d2'),
        device('d2', { model: 'HP' }),
      ]),
      2,
      'The last page entry for a device wins and the count is distinct devices.',
    );
    assert.equal(
      await batteries(first.id, attempt, [
        {
          deviceId: 'd1',
          battery: {
            status: 'reported',
            health: 'replace-soon',
            capacityPercent: 78,
            reportedAt: '2026-10-05T13:50:00.000Z',
          },
          reports: [
            {
              reportedAt: '2026-10-05T13:50:00.000Z',
              health: 'replace-soon',
              capacityPercent: 78,
            },
          ],
        },
      ]),
      1,
    );
    const ready = await finish(first.id, attempt);
    assert.equal(ready.status, 'ready');
    assert.equal(ready.deviceCount, 2);
    assert.equal(ready.stale, false);
    let current = await rows();
    assert.deepEqual(
      current.map((row) => [
        row.device_id,
        row.model,
        row.battery_status,
        row.removed_at,
      ]),
      [
        ['d1', 'Lenovo 100e Gen 4', 'reported', null],
        ['d2', 'HP', 'no-report', null],
      ],
    );
    assert.ok(current.every((row) => row.last_entity_sync instanceof Date));

    // A full sync without d2 soft-deletes d2 and keeps its row.
    const second = await fullSync([device('d1'), device('d3')]);
    assert.equal(second.deviceCount, 2);
    current = await rows();
    assert.deepEqual(
      current.map((row) => [row.device_id, row.removed_at !== null]),
      [
        ['d1', false],
        ['d2', true],
        ['d3', false],
      ],
    );
    const lastRemoved = (after = '') =>
      result('SELECT cc.page_last_removed_device_ids($1,$2,$3) AS result', [
        customer,
        after,
        1000,
      ]);
    assert.deepEqual(
      await lastRemoved(),
      ['d2'],
      'The last full sync names the devices it removed.',
    );
    assert.deepEqual(await lastRemoved('d2'), []);
    await fullSync([device('d1'), device('d3')]);
    assert.deepEqual(
      await lastRemoved(),
      [],
      'A sync that removes nothing names no devices.',
    );

    // A failed full sync removes nothing and keeps the publication.
    const failed = await fullSync([device('d1')], 'provider-unavailable');
    assert.equal(failed.status, 'failed');
    assert.equal(failed.stale, true);
    assert.equal(failed.deviceCount, 2);
    assert.deepEqual(
      (await rows()).map((row) => row.removed_at !== null),
      [false, true, false],
    );

    // Entity sync job: slices, upsert with an explicit read time, soft delete, idempotent finish.
    const jobId = randomUUID();
    const job = await result(
      'SELECT cc.create_entity_sync_job($1,1,$2,$3,$4,$5,$6,$7) AS result',
      [
        reader,
        customer,
        'device',
        JSON.stringify(['d1', 'd2', 'd3']),
        2,
        jobId,
        randomUUID(),
      ],
    );
    assert.equal(job.batchCount, 2);
    assert.equal(job.entityType, 'device');
    assert.equal(job.finishedAt, null);
    await assert.rejects(
      result(
        'SELECT cc.create_entity_sync_job($1,1,$2,$3,$4,$5,$6,$7) AS result',
        [outsider, customer, 'device', '["d1"]', 2, randomUUID(), randomUUID()],
      ),
      (error) => error.code === '42501',
    );
    const batch0 = await result(
      'SELECT cc.read_entity_sync_batch($1,$2,$3) AS result',
      [customer, jobId, 0],
    );
    assert.deepEqual(batch0.ids, ['d1', 'd2']);
    assert.equal(batch0.batchCount, 2);
    assert.equal(batch0.generation, generation);
    assert.ok(batch0.credentialId);
    const batch1 = await result(
      'SELECT cc.read_entity_sync_batch($1,$2,$3) AS result',
      [customer, jobId, 1],
    );
    assert.deepEqual(batch1.ids, ['d3']);
    await assert.rejects(
      result('SELECT cc.read_entity_sync_batch($1,$2,$3) AS result', [
        customer,
        jobId,
        2,
      ]),
      detail('entity-sync-changed'),
    );
    const syncedAt = new Date(Date.now() + 60_000).toISOString();
    const olderAt = new Date(Date.now() - 60_000).toISOString();
    assert.equal(
      await result('SELECT cc.upsert_devices($1,$2,$3) AS result', [
        customer,
        JSON.stringify([device('d2', { model: 'Acer' })]),
        syncedAt,
      ]),
      1,
    );
    const d2 = (await rows()).find((row) => row.device_id === 'd2');
    assert.equal(d2.removed_at, null, 'An upsert clears removed_at.');
    assert.equal(d2.last_entity_sync.toISOString(), syncedAt);
    assert.equal(
      await result('SELECT cc.upsert_devices($1,$2,$3) AS result', [
        customer,
        JSON.stringify([device('d2', { model: 'Older' })]),
        olderAt,
      ]),
      0,
      'An older read cannot overwrite a newer row.',
    );
    assert.equal(
      (await rows()).find((row) => row.device_id === 'd2').model,
      'Acer',
    );
    assert.equal(
      await result('SELECT cc.soft_delete_devices($1,$2) AS result', [
        customer,
        JSON.stringify(['d3', 'missing']),
      ]),
      1,
    );
    const records = await result(
      'SELECT cc.read_device_records($1,$2) AS result',
      [customer, JSON.stringify(['d1', 'd2', 'd3'])],
    );
    assert.deepEqual(
      records.map((record) => record.deviceId),
      ['d1', 'd2'],
      'Removed devices stay out of records.',
    );
    assert.equal(records[1].model, 'Acer');
    assert.equal(records[1].battery.status, 'no-report');
    assert.equal(typeof records[1].lastEntitySync, 'string');
    const page = await result(
      'SELECT cc.page_device_records($1,$2,$3) AS result',
      [customer, '', 1],
    );
    assert.deepEqual(
      page.map((record) => record.deviceId),
      ['d1'],
    );
    assert.deepEqual(
      (
        await result('SELECT cc.page_device_records($1,$2,$3) AS result', [
          customer,
          'd1',
          10,
        ])
      ).map((r) => r.deviceId),
      ['d2'],
    );
    const once = await result(
      'SELECT cc.finish_entity_sync_batch($1,$2,$3,$4) AS result',
      [customer, jobId, 0, null],
    );
    assert.equal(once.completedBatches, 1);
    assert.equal(once.finishedAt, null);
    const twice = await result(
      'SELECT cc.finish_entity_sync_batch($1,$2,$3,$4) AS result',
      [customer, jobId, 0, null],
    );
    assert.equal(
      twice.completedBatches,
      1,
      'Finishing a batch twice counts once.',
    );
    const done = await result(
      'SELECT cc.finish_entity_sync_batch($1,$2,$3,$4) AS result',
      [customer, jobId, 1, 'quota'],
    );
    assert.equal(done.failedBatches, 1);
    assert.equal(done.failure, 'quota');
    assert.ok(done.finishedAt);
    await assert.rejects(
      result('SELECT cc.read_entity_sync_batch($1,$2,$3) AS result', [
        customer,
        jobId,
        0,
      ]),
      detail('entity-sync-changed'),
    );
    const abandonedId = randomUUID();
    await result(
      'SELECT cc.create_entity_sync_job($1,1,$2,$3,$4,$5,$6,$7) AS result',
      [reader, customer, 'device', '["d1"]', 100, abandonedId, randomUUID()],
    );
    const abandoned = await result(
      'SELECT cc.abandon_entity_sync_job($1,1,$2,$3) AS result',
      [reader, customer, abandonedId],
    );
    assert.equal(abandoned.failure, 'orchestration-unavailable');
    assert.ok(abandoned.finishedAt);
    await migrator.query(
      "UPDATE cc.entity_sync_jobs SET finished_at=finished_at-interval '2 days' WHERE job_id=$1",
      [abandonedId],
    );
    assert.equal(
      await result('SELECT cc.purge_entity_sync_jobs($1,$2) AS result', [
        customer,
        100,
      ]),
      1,
    );

    // A job that no batch finishes ends as interrupted after two hours. The purge reaps it a day later.
    const stuckId = randomUUID();
    await result(
      'SELECT cc.create_entity_sync_job($1,1,$2,$3,$4,$5,$6,$7) AS result',
      [reader, customer, 'device', '["d1"]', 100, stuckId, randomUUID()],
    );
    const stuck = async () =>
      (
        await migrator.query(
          'SELECT failure,finished_at FROM cc.entity_sync_jobs WHERE job_id=$1',
          [stuckId],
        )
      ).rows[0];
    await result('SELECT cc.purge_entity_sync_jobs($1,$2) AS result', [
      customer,
      100,
    ]);
    assert.equal(
      (await stuck()).finished_at,
      null,
      'A young unfinished job stays open.',
    );
    await migrator.query(
      "UPDATE cc.entity_sync_jobs SET created_at=created_at-interval '3 hours' WHERE job_id=$1",
      [stuckId],
    );
    await result('SELECT cc.purge_entity_sync_jobs($1,$2) AS result', [
      customer,
      100,
    ]);
    assert.equal((await stuck()).failure, 'interrupted');
    assert.ok((await stuck()).finished_at instanceof Date);
    await migrator.query(
      "UPDATE cc.entity_sync_jobs SET finished_at=finished_at-interval '2 days' WHERE job_id=$1",
      [stuckId],
    );
    assert.equal(
      await result('SELECT cc.purge_entity_sync_jobs($1,$2) AS result', [
        customer,
        100,
      ]),
      1,
    );
    assert.equal(await stuck(), undefined);

    // Job creation accepts only plain device identifiers and a bounded batch size.
    const create = (ids, size = 100) =>
      result(
        'SELECT cc.create_entity_sync_job($1,1,$2,$3,$4,$5,$6,$7) AS result',
        [
          reader,
          customer,
          'device',
          JSON.stringify(ids),
          size,
          randomUUID(),
          randomUUID(),
        ],
      );
    for (const [ids, size] of [
      [['d1', 'd>2'], 100],
      [['d1\r'], 100],
      [[], 100],
      [[1], 100],
      [['x'.repeat(129)], 100],
      [['d1'], 0],
      [['d1'], 1001],
    ])
      await assert.rejects(
        create(ids, size),
        (error) => error.code === '22023',
      );

    // Expired leases still report interruption.
    const lost = await request();
    const lostAttempt = randomUUID();
    await claim(lost.id, lostAttempt);
    await migrator.query(
      "UPDATE cc.device_sync_state SET sync_expires_at=clock_timestamp()-interval '1 second' WHERE customer_id=$1",
      [customer],
    );
    const interrupted = await read();
    assert.equal(interrupted.status, 'failed');
    assert.equal(interrupted.failure, 'interrupted');
    await assert.rejects(
      stage(lost.id, lostAttempt, [device('d5')]),
      detail('device-sync-changed'),
    );
    await assert.rejects(
      finish(lost.id, lostAttempt),
      detail('device-sync-changed'),
    );
    const next = await request();
    const abandonedSync = await result(
      'SELECT cc.abandon_device_sync($1,1,$2,$3,$4) AS result',
      [reader, customer, next.id, 'orchestration-unavailable'],
    );
    assert.equal(abandonedSync.failure, 'orchestration-unavailable');

    await migrator.query(
      'UPDATE cc.application_principals SET permission_version=2 WHERE id=$1',
      [reader],
    );
    await assert.rejects(read(), (error) => error.code === '42501');
    return [
      'device inventory reads require current devices:read authority: pass',
      'one worker attempt claims a device sync and duplicate dispatch is rejected: pass',
      'a full sync soft-deletes devices Google no longer returns and a failed sync removes nothing: pass',
      'the last full sync names the devices it removed: pass',
      'entity sync jobs slice IDs into batches and count each batch once: pass',
      'the purge ends jobs unfinished after two hours and rejects unsafe job IDs: pass',
      'upserts stamp last_entity_sync and clear removed_at: pass',
      'expired leases report interruption and reject late publication: pass',
    ];
  } finally {
    await migrator.query('UPDATE cc.google_connection SET active=$1', [
      wasActive,
    ]);
  }
}

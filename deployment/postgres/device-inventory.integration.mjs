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
  const otherReader = randomUUID();
  try {
    for (const id of [reader, outsider, otherReader])
      await migrator.query(
        'INSERT INTO cc.application_principals(id,issuer,subject,display_name) VALUES($1,$2,$3,$3)',
        [id, issuer, id],
      );
    for (const id of [reader, otherReader])
      await migrator.query(
        'INSERT INTO cc.application_grants(principal_id,action,scope) VALUES($1,$2,$3)',
        [
          id,
          'devices:read',
          JSON.stringify({ kind: 'district', customerId: customer }),
        ],
      );
    const result = (sql, values) =>
      runtime.query(sql, values).then((r) => r.rows[0].result);
    const results = [];
    const failures = [];
    // Every rewritten check reports its own name, so a failing-first run names each one.
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
    const requestAs = (actor, id = randomUUID()) =>
      result('SELECT cc.request_device_sync($1,1,$2,$3,$4,$5) AS result', [
        actor,
        customer,
        generation,
        id,
        randomUUID(),
      ]).then((state) => ({ id, state }));
    // to_jsonb reads a missing version column as null, so this helper also runs on the parent revision.
    const versions = async (deviceId) => {
      const row = (
        await migrator.query(
          `SELECT to_jsonb(d)->>'record_version' AS record_version,
                  to_jsonb(s)->>'telemetry_version' AS telemetry_version
             FROM cc.devices d LEFT JOIN cc.device_sync_state s ON s.customer_id=d.customer_id
            WHERE d.customer_id=$1 AND d.device_id=$2`,
          [customer, deviceId],
        )
      ).rows[0];
      const number = (value) =>
        value === null || value === undefined ? null : Number(value);
      return row
        ? {
            record: number(row.record_version),
            telemetry: number(row.telemetry_version),
          }
        : null;
    };
    const elementVersion = async (deviceId) => {
      const current = await versions(deviceId);
      return current && current.record !== null && current.telemetry !== null
        ? current.record + current.telemetry
        : null;
    };
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
    const elementRecord = (element) =>
      element && typeof element === 'object' && 'record' in element
        ? element.record
        : element;
    const records = await result(
      'SELECT cc.read_device_records($1,$2) AS result',
      [customer, JSON.stringify(['d1', 'd2', 'd3'])],
    );
    assert.deepEqual(
      records.map((entry) => elementRecord(entry)?.deviceId),
      ['d1', 'd2'],
      'Removed devices stay out of records.',
    );
    assert.equal(elementRecord(records[1])?.model, 'Acer');
    assert.equal(elementRecord(records[1])?.battery.status, 'no-report');
    assert.equal(typeof elementRecord(records[1])?.lastEntitySync, 'string');
    const page = await result(
      'SELECT cc.page_device_records($1,$2,$3) AS result',
      [customer, '', 1],
    );
    assert.deepEqual(
      page.map((entry) => elementRecord(entry)?.deviceId),
      ['d1'],
    );
    assert.deepEqual(
      (
        await result('SELECT cc.page_device_records($1,$2,$3) AS result', [
          customer,
          'd1',
          10,
        ])
      ).map((entry) => elementRecord(entry)?.deviceId),
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
    await check(
      'the purge removes an abandoned refresh job after 7 days and keeps a write job',
      async () => {
        const abandonedId = randomUUID();
        await result(
          'SELECT cc.create_entity_sync_job($1,1,$2,$3,$4,$5,$6,$7) AS result',
          [
            reader,
            customer,
            'device',
            '["d1"]',
            100,
            abandonedId,
            randomUUID(),
          ],
        );
        const abandoned = await result(
          'SELECT cc.abandon_entity_sync_job($1,1,$2,$3) AS result',
          [reader, customer, abandonedId],
        );
        assert.equal(abandoned.failure, 'orchestration-unavailable');
        assert.ok(abandoned.finishedAt);
        await migrator.query(
          "UPDATE cc.jobs SET finished_at=finished_at-interval '8 days' WHERE job_id=$1",
          [abandonedId],
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
            [abandonedId],
          ),
          0,
        );
      },
    );

    // A job that no batch finishes ends as interrupted after two hours. The purge reaps it a week later.
    await check(
      'the purge ends jobs unfinished after two hours and reaps them a week later',
      async () => {
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
        await result('SELECT cc.purge_jobs($1,$2) AS result', [customer, 100]);
        assert.equal(
          (await stuck()).finished_at,
          null,
          'A young unfinished job stays open.',
        );
        await migrator.query(
          "UPDATE cc.jobs SET created_at=created_at-interval '3 hours' WHERE job_id=$1",
          [stuckId],
        );
        await result('SELECT cc.purge_jobs($1,$2) AS result', [customer, 100]);
        assert.equal((await stuck()).failure, 'interrupted');
        assert.ok((await stuck()).finished_at instanceof Date);
        await migrator.query(
          "UPDATE cc.jobs SET finished_at=finished_at-interval '8 days' WHERE job_id=$1",
          [stuckId],
        );
        assert.ok(
          (await result('SELECT cc.purge_jobs($1,$2) AS result', [
            customer,
            100,
          ])) >= 1,
        );
        assert.equal(await stuck(), undefined);
      },
    );

    // Job creation accepts only plain device identifiers and a bounded batch size.
    await check(
      'job creation rejects a malformed ID, an empty list, a non-string, an over-long ID, and a batch size outside 1 to 1000',
      async () => {
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
        // The rewrite records the header first and one target row per ID.
        const createdId = randomUUID();
        await result(
          'SELECT cc.create_entity_sync_job($1,1,$2,$3,$4,$5,$6,$7) AS result',
          [
            reader,
            customer,
            'device',
            '["jobs-d1","jobs-d2"]',
            100,
            createdId,
            randomUUID(),
          ],
        );
        assert.deepEqual(
          (
            await migrator.query(
              'SELECT target_count,scope_kind,status FROM cc.jobs WHERE job_id=$1',
              [createdId],
            )
          ).rows[0],
          {
            target_count: 2,
            scope_kind: 'devices',
            status: 'running',
          },
        );
        assert.match(
          (
            await migrator.query(
              'SELECT display_id FROM cc.jobs WHERE job_id=$1',
              [createdId],
            )
          ).rows[0].display_id,
          /^REF-[0-9]{3,}$/,
        );
        assert.equal(
          (
            await migrator.query(
              'SELECT count(*)::int AS targets FROM cc.job_targets WHERE job_id=$1',
              [createdId],
            )
          ).rows[0].targets,
          2,
        );
      },
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

    // P3: the entry versions of section 1.8 and the versioned elements of section 5.11.
    await check(
      'each device writer raises record_version by one and an unchanged update keeps it',
      async () => {
        const id = 'p3ver-a';
        const unchanged = device(id);
        const upsert = (entry, at) =>
          result('SELECT cc.upsert_devices($1,$2,$3,$4) AS result', [
            customer,
            JSON.stringify([entry]),
            at,
            'list',
          ]);
        await upsert(unchanged, '2026-10-01T10:00:00.000Z');
        const first = (await versions(id)).record;
        assert.ok(
          Number.isInteger(first),
          'The record_version column exists after an upsert.',
        );
        await upsert(unchanged, '2026-10-01T10:00:00.000Z');
        assert.equal(
          (await versions(id)).record,
          first,
          'An update without a change keeps the version.',
        );
        await upsert(
          { ...unchanged, serialNumber: 'SN-changed' },
          '2026-10-01T11:00:00.000Z',
        );
        assert.equal((await versions(id)).record, first + 1);
        await result('SELECT cc.soft_delete_devices($1,$2) AS result', [
          customer,
          JSON.stringify([id]),
        ]);
        assert.equal((await versions(id)).record, first + 2);
        const removed = await result(
          'SELECT cc.read_device_records($1,$2) AS result',
          [customer, JSON.stringify([id])],
        );
        assert.deepEqual(removed, [], 'A removed device is not an entry.');
      },
    );

    await check(
      'read and page return present entries with the sum of both versions',
      async () => {
        const present = 'p3read-a';
        const removed = 'p3read-b';
        await result('SELECT cc.upsert_devices($1,$2,$3,$4) AS result', [
          customer,
          JSON.stringify([device(present), device(removed)]),
          '2026-10-02T10:00:00.000Z',
          'list',
        ]);
        await result('SELECT cc.soft_delete_devices($1,$2) AS result', [
          customer,
          JSON.stringify([removed]),
        ]);
        const records = await result(
          'SELECT cc.read_device_records($1,$2) AS result',
          [customer, JSON.stringify([present, removed])],
        );
        assert.equal(records.length, 1);
        assert.equal(
          records[0].record?.deviceId,
          present,
          'The read returns an entry with its record.',
        );
        assert.equal('removedAt' in records[0].record, false);
        assert.equal(records[0].version, await elementVersion(present));
        const page = await result(
          'SELECT cc.page_device_records($1,$2,$3) AS result',
          [customer, 'p3read-', 1000],
        );
        assert.deepEqual(
          page.map((entry) => entry.record?.deviceId),
          [present],
          'The page returns an entry with its record.',
        );
        assert.equal(page[0].version, await elementVersion(present));
      },
    );

    await check(
      'a telemetry failure raises telemetry_version and a new requester keeps it',
      async () => {
        const id = 'p3tel-a';
        const sync = async (who, telemetry) => {
          const { id: syncId } = await requestAs(who);
          const attempt = randomUUID();
          await claim(syncId, attempt);
          await stage(syncId, attempt, [device(id)]);
          return finish(syncId, attempt, null, telemetry);
        };
        await sync(reader, null);
        const before = (await versions(id)).telemetry;
        assert.ok(
          Number.isInteger(before),
          'The telemetry_version column exists after a finish.',
        );
        await sync(reader, 'quota');
        const afterClear = (await versions(id)).telemetry;
        assert.equal(afterClear, before + 1);
        const entry = await result(
          'SELECT cc.read_device_records($1,$2) AS result',
          [customer, JSON.stringify([id])],
        );
        assert.equal(entry[0].version, await elementVersion(id));
        await sync(otherReader, 'quota');
        const stored = (
          await migrator.query(
            'SELECT telemetry_version,telemetry_failure_requested_by FROM cc.device_sync_state WHERE customer_id=$1',
            [customer],
          )
        ).rows[0];
        assert.equal(
          Number(stored.telemetry_version),
          afterClear,
          'Only the failure raises the telemetry version.',
        );
        assert.equal(stored.telemetry_failure_requested_by, otherReader);
        await sync(reader, null);
      },
    );

    await check(
      'an explicit telemetry version on a rewrite never lowers the stored version',
      async () => {
        const current = (await versions('p3tel-a')).telemetry;
        assert.ok(
          Number.isInteger(current),
          'The telemetry_version column exists before the rewrite.',
        );
        await migrator.query(
          'UPDATE cc.device_sync_state SET telemetry_version=0 WHERE customer_id=$1',
          [customer],
        );
        assert.equal(
          (await versions('p3tel-a')).telemetry,
          current,
          'A rewrite without a telemetry failure keeps the stored version.',
        );
      },
    );

    await check(
      'an Asset tag of 1,024 characters and one of 300 supplementary characters store',
      async () => {
        const longTag = 'A'.repeat(1024);
        // A supplementary character is one code point and two UTF-16 units, so
        // length() counts 300 and the contract counts 600.
        const supplementaryTag = '𠮷'.repeat(300);
        const ids = ['asset-long', 'asset-wide'];
        try {
          assert.equal(
            await result('SELECT cc.upsert_devices($1,$2,$3,$4) AS result', [
              customer,
              JSON.stringify([
                device(ids[0], { assetTag: longTag }),
                device(ids[1], { assetTag: supplementaryTag }),
              ]),
              '2026-10-05T12:00:00.000Z',
              'list',
            ]),
            2,
          );
          const stored = (
            await migrator.query(
              'SELECT device_id,asset_tag,length(asset_tag) AS code_points FROM cc.devices WHERE customer_id=$1 AND device_id=ANY($2::text[]) ORDER BY device_id',
              [customer, ids],
            )
          ).rows;
          assert.deepEqual(
            stored.map((row) => [
              row.device_id,
              row.asset_tag,
              row.code_points,
            ]),
            [
              [ids[0], longTag, 1024],
              [ids[1], supplementaryTag, 300],
            ],
          );
          const records = await result(
            'SELECT cc.read_device_records($1,$2) AS result',
            [customer, JSON.stringify(ids)],
          );
          assert.deepEqual(
            records.map((entry) => [
              entry.record.deviceId,
              entry.record.assetTag,
            ]),
            [
              [ids[0], longTag],
              [ids[1], supplementaryTag],
            ],
            'The record that the API publishes carries the whole tag.',
          );
        } finally {
          await migrator.query(
            'DELETE FROM cc.devices WHERE customer_id=$1 AND device_id=ANY($2::text[])',
            [customer, ids],
          );
        }
      },
    );

    await migrator.query(
      'UPDATE cc.application_principals SET permission_version=2 WHERE id=$1',
      [reader],
    );
    await assert.rejects(read(), (error) => error.code === '42501');
    if (failures.length)
      throw new Error(
        `Device inventory checks failed: ${failures.join(' | ')}`,
      );
    return [
      ...results,
      'device inventory reads require current devices:read authority: pass',
      'one worker attempt claims a device sync and duplicate dispatch is rejected: pass',
      'a full sync soft-deletes devices Google no longer returns and a failed sync removes nothing: pass',
      'the last full sync names the devices it removed: pass',
      'entity sync jobs slice IDs into batches and count each batch once: pass',
      'upserts stamp last_entity_sync and clear removed_at: pass',
      'expired leases report interruption and reject late publication: pass',
    ];
  } finally {
    await migrator.query('UPDATE cc.google_connection SET active=$1', [
      wasActive,
    ]);
  }
}

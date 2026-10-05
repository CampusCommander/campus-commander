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
    const purge = () =>
      result('SELECT cc.purge_device_syncs($1,5000) AS result', [customer]);
    const published = async () =>
      (
        await runtime.query(
          'SELECT d.* FROM cc.devices d JOIN cc.device_sync_state s ON d.sync_id=s.current_sync_id WHERE s.customer_id=$1 ORDER BY d.device_id',
          [customer],
        )
      ).rows;
    const detail = (code) => (error) => error.detail === code;

    assert.equal((await read()).status, 'never');
    await assert.rejects(read(outsider), (error) => error.code === '42501');

    const first = await request();
    assert.equal(first.state.status, 'running');
    await assert.rejects(request(), detail('device-sync-running'));
    const attempt = randomUUID();
    const claimed = await claim(first.id, attempt);
    assert.equal(claimed.generation, generation);
    assert.ok(claimed.credentialId);
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
    );
    assert.equal(
      await batteries(first.id, attempt, [
        {
          deviceId: 'd1',
          battery: {
            status: 'reported',
            health: 'replace-soon',
            capacityPercent: 78,
            reportedAt: '2026-10-05T11:00:00.000Z',
          },
          reports: [
            {
              reportedAt: '2026-10-05T11:00:00.000Z',
              health: 'replace-soon',
              capacityPercent: 78,
            },
          ],
        },
        { deviceId: 'unknown', battery: { status: 'no-report' }, reports: [] },
      ]),
      1,
    );
    const ready = await finish(first.id, attempt);
    assert.equal(ready.status, 'ready');
    assert.equal(ready.deviceCount, 2);
    assert.equal(ready.stale, false);
    let rows = await published();
    assert.deepEqual(
      rows.map((row) => row.model),
      ['Lenovo 100e Gen 4', 'HP'],
    );
    assert.equal(rows[0].battery_health, 'replace-soon');
    assert.equal(rows[1].battery_status, 'no-report');
    await assert.rejects(
      finish(first.id, attempt),
      detail('device-sync-changed'),
    );

    const failed = await request();
    const failedAttempt = randomUUID();
    await claim(failed.id, failedAttempt);
    await stage(failed.id, failedAttempt, [device('d9')]);
    const failure = await finish(failed.id, failedAttempt, 'permission-denied');
    assert.equal(failure.status, 'failed');
    assert.equal(failure.failure, 'permission-denied');
    assert.equal(failure.stale, true);
    assert.equal(failure.deviceCount, 2);
    assert.equal(failure.observedAt, ready.observedAt);
    assert.equal(await purge(), 1);
    assert.equal((await published()).length, 2);

    const blind = await request();
    const blindAttempt = randomUUID();
    await claim(blind.id, blindAttempt);
    await stage(blind.id, blindAttempt, [device('d1')]);
    const unavailable = await finish(
      blind.id,
      blindAttempt,
      null,
      'permission-denied',
    );
    assert.equal(unavailable.status, 'ready');
    assert.equal(unavailable.telemetryFailure, 'permission-denied');
    rows = await published();
    assert.deepEqual(
      rows.map((row) => row.battery_status),
      ['unavailable'],
    );
    assert.equal(await purge(), 2);

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
    assert.equal(interrupted.stale, true);
    await assert.rejects(
      stage(lost.id, lostAttempt, [device('d5')]),
      detail('device-sync-changed'),
    );
    await assert.rejects(
      finish(lost.id, lostAttempt),
      detail('device-sync-changed'),
    );
    const next = await request();
    assert.equal(next.state.status, 'running');
    const abandoned = await result(
      'SELECT cc.abandon_device_sync($1,1,$2,$3,$4) AS result',
      [reader, customer, next.id, 'orchestration-unavailable'],
    );
    assert.equal(abandoned.failure, 'orchestration-unavailable');

    await migrator.query(
      'UPDATE cc.application_principals SET permission_version=2 WHERE id=$1',
      [reader],
    );
    await assert.rejects(read(), (error) => error.code === '42501');
    return [
      'device inventory reads require current devices:read authority: pass',
      'one worker attempt claims a device sync and duplicate dispatch is rejected: pass',
      'failed syncs keep the published inventory and mark it stale: pass',
      'telemetry failure publishes devices with unavailable battery data: pass',
      'expired leases report interruption and reject late publication: pass',
    ];
  } finally {
    await migrator.query('UPDATE cc.google_connection SET active=$1', [
      wasActive,
    ]);
  }
}

import { evidenceSecurity } from './evidence-security.mjs';
import { qualificationSignIn } from './qualification-sign-in.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';

export async function qualifyDevicesApi({
  browser,
  publicOrigin,
  directory,
  evidenceDirectory,
  setSubject,
  migrator,
  redis,
}) {
  const context = await evidenceSecurity.newContext(browser, {
    ignoreHTTPSErrors: true,
  });
  const faultPath = join(directory, 'google-health-fault.json');
  try {
    setSubject('administrator');
    const page = await context.newPage();
    await qualificationSignIn(page, publicOrigin, evidenceDirectory, 'devices');
    const api = context.request;
    const session = await (
      await api.get(`${publicOrigin}/api/auth/session`)
    ).json();
    evidenceSecurity.register('csrf-token', session.csrfToken);
    const headers = { origin: publicOrigin, 'x-csrf-token': session.csrfToken };
    const root = `${publicOrigin}/api/devices`;
    const sync = async () => {
      const response = await api.get(`${root}/sync`);
      assert.equal(response.status(), 200, await response.text());
      return (await response.json()).sync;
    };
    const run = async () => {
      const response = await api.post(`${root}/sync`, { headers, data: {} });
      assert.equal(response.status(), 201, await response.text());
      for (let attempt = 0; attempt < 240; attempt++) {
        const state = await sync();
        if (state.status !== 'running') return state;
        await setTimeout(500);
      }
      throw new Error('The device sync did not settle.');
    };
    const query = async (data) => {
      const response = await api.post(`${root}/query`, { headers, data });
      assert.equal(response.status(), 200, await response.text());
      return (await response.json()).page;
    };
    const fault = (mode) => writeFile(faultPath, JSON.stringify({ mode }));

    assert.equal((await sync()).status, 'never');
    assert.equal((await api.post(`${root}/sync`, { data: {} })).status(), 403);
    assert.equal(
      (
        await api.post(`${root}/query`, { headers, data: { limit: 1001 } })
      ).status(),
      400,
    );

    const ready = await run();
    assert.equal(ready.status, 'ready');
    assert.equal(ready.deviceCount, 450);
    assert.equal(ready.telemetryFailure, null);
    const first = await query({});
    assert.equal(first.total, 450);
    assert.equal(first.matching, 450);
    assert.equal(first.rows.length, 100);
    assert.equal(first.rows[0].serialNumber, 'C0A1-0000');
    assert.equal(JSON.stringify(first).includes('envelope'), false);
    assert.equal(first.refreshJobId, null);
    assert.equal(first.rows[0].stale, false);
    assert.match(first.rows[0].lastEntitySync, /^\d{4}-\d{2}-\d{2}T/);
    const detail0 = await api.get(`${root}/synthetic-device-0`);
    assert.equal(detail0.status(), 200, await detail0.text());
    assert.equal((await detail0.json()).device.removedAt, null);
    const units = await api.get(`${root}/org-units`);
    assert.equal(units.status(), 200, await units.text());
    assert.deepEqual((await units.json()).orgUnits, [
      { path: '/', devices: 150 },
      { path: '/School A', devices: 150 },
      { path: '/School B', devices: 150 },
    ]);
    assert.equal(
      (
        await query({
          predicates: [
            { field: 'assetTag', operator: 'startsWith', value: 'HS-04' },
          ],
        })
      ).matching,
      96,
    );
    assert.equal(
      (
        await query({
          predicates: [
            { field: 'battery', operator: 'is', values: ['replace-soon'] },
          ],
        })
      ).matching,
      135,
    );
    assert.equal(
      (
        await query({
          predicates: [
            { field: 'orgUnitPath', operator: 'in', values: ['/School A'] },
          ],
        })
      ).matching,
      150,
    );
    const select = async (path, data) => {
      const response = await api.post(`${root}/selection${path}`, {
        headers,
        data,
      });
      assert.equal(response.status(), 200, await response.text());
      return response.json();
    };
    const tab = { gridId: 'devices', tabId: randomUUID() };
    const hs04 = [
      { field: 'assetTag', operator: 'startsWith', value: 'HS-04' },
    ];
    assert.equal((await select('', tab)).selection.selectedCount, 0);
    assert.equal(
      (
        await api.post(`${root}/selection/ops`, {
          data: { ...tab, ops: [{ op: 'deselectAll' }] },
        })
      ).status(),
      403,
    );
    assert.deepEqual(
      (
        await select('/ops', {
          ...tab,
          ops: [{ op: 'selectAll', predicates: hs04 }],
        })
      ).selection,
      {
        terms: [{ type: 'all', predicates: hs04 }],
        groups: [],
        added: 0,
        excluded: 0,
        selectedCount: 96,
      },
    );
    const changed = await select('/ops', {
      ...tab,
      ops: [
        { op: 'deselect', ids: ['synthetic-device-1'] },
        { op: 'select', ids: ['synthetic-device-0'] },
      ],
    });
    assert.equal(changed.selection.selectedCount, 96);
    assert.deepEqual(
      (
        await select('/resolve', {
          ...tab,
          rowIds: [
            'synthetic-device-0',
            'synthetic-device-1',
            'synthetic-device-2',
          ],
          groupRoutes: [],
        })
      ).selected,
      {
        'synthetic-device-0': true,
        'synthetic-device-1': false,
        'synthetic-device-2': true,
      },
    );
    // HS-04 holds 29 Replace soon devices. Device 1 is one of them and is deselected.
    assert.equal(
      (
        await query({
          selection: tab,
          predicates: [
            { field: 'battery', operator: 'is', values: ['replace-soon'] },
          ],
        })
      ).matching,
      28,
    );
    assert.equal(
      (await select('', { gridId: 'devices', tabId: randomUUID() })).selection
        .selectedCount,
      0,
    );
    assert.equal(
      (await select('/ops', { ...tab, ops: [{ op: 'deselectAll' }] })).selection
        .selectedCount,
      0,
    );
    const groups = async (data) => {
      const response = await api.post(`${root}/groups`, { headers, data });
      assert.equal(response.status(), 200, await response.text());
      return (await response.json()).groups;
    };
    const battery = await groups({ group: { by: ['battery'], keys: [] } });
    assert.equal(battery.matching, 450);
    assert.equal(battery.groupCount, battery.groups.length);
    assert.equal(
      battery.groups.reduce((sum, group) => sum + group.devices, 0),
      450,
    );
    assert.equal(
      battery.groups.find((group) => group.key === 'replace-soon')?.devices,
      135,
    );
    assert.equal(battery.groups[0].key, 'normal');
    const schoolA = await groups({
      group: { by: ['orgUnitPath', 'model'], keys: ['/School A'] },
    });
    assert.equal(schoolA.matching, 150);
    assert.equal(
      (
        await query({
          group: { by: ['battery'], keys: ['replace-soon'] },
          limit: 1000,
        })
      ).rows.length,
      135,
    );
    // While grouped, LibreGrid selects whole groups under the active filters.
    const grouped = {
      predicates: hs04,
      by: ['battery'],
      route: ['replace-soon'],
    };
    assert.equal(
      (
        await select('/ops', {
          ...tab,
          ops: [{ op: 'selectGroup', ...grouped }],
        })
      ).selection.selectedCount,
      29,
    );
    assert.deepEqual(
      (
        await select('/resolve', {
          ...tab,
          rowIds: [],
          groupRoutes: ['replace-soon', 'normal', 'no|such'],
          predicates: hs04,
          by: ['battery'],
        })
      ).selected,
      { 'replace-soon': true, normal: false, 'no|such': false },
    );
    assert.equal(
      (
        await select('/ops', {
          ...tab,
          ops: [{ op: 'deselectGroup', ...grouped }],
        })
      ).selection.selectedCount,
      0,
    );
    const detail = await (await api.get(`${root}/synthetic-device-1`)).json();
    assert.deepEqual(
      {
        health: detail.device.battery.health,
        capacity: detail.device.battery.capacityPercent,
      },
      { health: 'replace-soon', capacity: 78 },
    );
    assert.equal(detail.device.batteryReports.length, 3);
    assert.equal((await api.get(`${root}/synthetic-device-9`)).ok(), true);
    assert.equal(
      (await (await api.get(`${root}/synthetic-device-9`)).json()).device
        .battery.status,
      'no-report',
    );
    assert.equal((await api.get(`${root}/missing-device`)).status(), 404);

    if (migrator) {
      await migrator.query(
        "UPDATE cc.devices SET last_entity_sync=now()-interval '2 days' WHERE device_id IN ('synthetic-device-0','synthetic-device-1','synthetic-device-3')",
      );
      await fault('device-removed');
      const stalePage = await query({
        predicates: [
          {
            field: 'orgUnitPath',
            operator: 'in',
            values: ['/School A', '/School B', '/'],
          },
        ],
        limit: 5,
      });
      assert.ok(stalePage.refreshJobId, 'Stale rows start a refresh job.');
      assert.equal(
        stalePage.rows.find((row) => row.deviceId === 'synthetic-device-0')
          .stale,
        true,
      );
      const again = await query({ limit: 5 });
      assert.equal(
        again.refreshJobId,
        null,
        'The in-flight set stops a second dispatch.',
      );
      const bySerial = (serialNumber) =>
        query({
          predicates: [
            { field: 'serialNumber', operator: 'equals', value: serialNumber },
          ],
        });
      let refreshed;
      let gone;
      for (let attempt = 0; attempt < 120; attempt++) {
        refreshed = await bySerial('C0A1-0000');
        gone = await bySerial('C0A1-0003');
        if (refreshed.rows[0]?.stale === false && gone.matching === 0) break;
        await setTimeout(500);
      }
      assert.ok(
        refreshed.rows[0]?.stale === false && gone.matching === 0,
        'Batch did not refresh C0A1-0000 and remove C0A1-0003 within 60 s.',
      );
      const removed = await api.get(`${root}/synthetic-device-3`);
      assert.equal(removed.status(), 200);
      assert.ok((await removed.json()).device.removedAt);

      // The job finishes only after the worker wrote Redis and freed its claims.
      let job;
      for (let attempt = 0; attempt < 120; attempt++) {
        job = (
          await migrator.query(
            "SELECT j.finished_at, j.batch_count, (SELECT count(*) FROM cc.entity_sync_batches b WHERE b.job_id=j.job_id AND b.status='completed') AS completed, (SELECT count(*) FROM cc.entity_sync_batches b WHERE b.job_id=j.job_id AND b.status='failed') AS failed FROM cc.entity_sync_jobs j WHERE j.job_id=$1",
            [stalePage.refreshJobId],
          )
        ).rows[0];
        if (job?.finished_at) break;
        await setTimeout(500);
      }
      assert.ok(
        job?.finished_at,
        'The refresh job did not finish within 60 s.',
      );
      assert.equal(Number(job.completed), job.batch_count);
      assert.equal(Number(job.failed), 0);

      const customerKey = (prefix) => `${prefix}:device:C0123456`;
      const entity = (id) => `${customerKey('cc:entity')}:${id}`;
      // Redis deletes a sorted set with its last member. The default ACL reads EXISTS, not ZCARD.
      assert.equal(
        await redis.exists(customerKey('cc:entity-inflight')),
        0,
        'The worker freed every in-flight claim.',
      );
      const cached = JSON.parse(await redis.get(entity('synthetic-device-0')));
      assert.equal(cached.deviceId, 'synthetic-device-0');
      assert.equal(typeof cached.lastEntitySync, 'string');
      assert.ok(
        Date.parse(cached.lastEntitySync) > Date.parse(ready.observedAt),
        'The batch, not the first full sync, wrote the cached record.',
      );
      assert.equal('stale' in cached, false);
      assert.equal('removedAt' in cached, false);
      assert.equal(await redis.get(entity('synthetic-device-3')), null);

      await rm(faultPath, { force: true });
      const restored = await run();
      assert.equal(
        restored.deviceCount,
        450,
        'A full sync returns the device.',
      );
      assert.equal((await bySerial('C0A1-0003')).matching, 1);
      const generation = await redis.get(customerKey('cc:query-gen'));
      assert.match(generation ?? '', /^\d+$/);
      assert.ok(Number(generation) >= 1);
      assert.equal(await redis.exists(entity('synthetic-device-3')), 1);
    }

    await fault('telemetry-privilege-denied');
    const blind = await run();
    assert.equal(blind.status, 'ready');
    assert.equal(blind.telemetryFailure, 'permission-denied');
    assert.equal(
      (
        await query({
          predicates: [
            { field: 'battery', operator: 'is', values: ['unavailable'] },
          ],
        })
      ).matching,
      450,
    );

    await fault('device-privilege-denied');
    const failed = await run();
    assert.equal(failed.status, 'failed');
    assert.equal(failed.failure, 'permission-denied');
    assert.equal(failed.stale, true);
    assert.equal((await query({})).total, 450);
    return [
      'device sync runs through Kestra and the worker and publishes 450 simulated devices: pass',
      'device filters match asset tag, battery class, and organization unit counts: pass',
      'device selection keeps Select All terms, row exceptions, and per-tab isolation: pass',
      'device groups count devices and select whole groups: pass',
      'device details include Google battery class, capacity, and recent reports: pass',
      'telemetry denial publishes devices with unavailable battery data: pass',
      'inventory denial keeps the published devices and marks them stale: pass',
      ...(migrator
        ? [
            'stale devices refresh through one Kestra batch and a removed device leaves the grid: pass',
            'the refresh job finishes and the worker fills and prunes Redis: pass',
          ]
        : []),
    ];
  } finally {
    await rm(faultPath, { force: true });
    await context.close();
  }
}

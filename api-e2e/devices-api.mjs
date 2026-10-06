import { evidenceSecurity } from './evidence-security.mjs';
import { qualificationSignIn } from './qualification-sign-in.mjs';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';

export async function qualifyDevicesApi({
  browser,
  publicOrigin,
  directory,
  evidenceDirectory,
  setSubject,
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
        await api.post(`${root}/query`, { headers, data: { limit: 500 } })
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
      'device details include Google battery class, capacity, and recent reports: pass',
      'telemetry denial publishes devices with unavailable battery data: pass',
      'inventory denial keeps the published devices and marks them stale: pass',
    ];
  } finally {
    await rm(faultPath, { force: true });
    await context.close();
  }
}

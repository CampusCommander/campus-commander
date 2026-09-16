import assert from 'node:assert/strict';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from '@playwright/test';

export async function qualifyGoogleHealth({
  page,
  publicOrigin,
  migrator,
  directory,
  evidenceDirectory,
}) {
  const admin = page.context().request;
  const root = `${publicOrigin}/api/google-connection`;
  const session = await (
    await admin.get(`${publicOrigin}/api/auth/session`)
  ).json();
  const headers = { origin: publicOrigin, 'x-csrf-token': session.csrfToken };
  const input = {
    customerId: 'C0123456',
    generation: 1,
    capabilities: ['customer-identity', 'domain-observations'],
  };
  const faultPath = join(directory, 'google-health-fault.json');
  const fault = (mode) => writeFile(faultPath, JSON.stringify({ mode }));
  const ready = () =>
    migrator.query(
      "UPDATE cc.google_health_checks SET retry_at=clock_timestamp()-interval '1 second'",
    );
  const read = async () => {
    const response = await admin.get(`${root}/health`);
    assert.equal(response.status(), 200, await response.text());
    return (await response.json()).health;
  };
  const check = async (capabilities = input.capabilities) => {
    const response = await admin.post(`${root}/health/check`, {
      headers,
      data: { ...input, capabilities },
    });
    assert.equal(response.status(), 201, await response.text());
    return (await response.json()).health;
  };
  const initial = await read();
  assert.equal(initial.customerId, input.customerId);
  assert.equal(initial.capabilities.length, 2);
  assert.equal(JSON.stringify(initial).includes('envelope'), false);
  assert.equal(
    (await admin.post(`${root}/health/check`, { data: input })).status(),
    403,
  );
  assert.equal(
    (
      await admin.post(`${root}/health/check`, {
        headers,
        data: { ...input, capabilities: ['school-ou-references'] },
      })
    ).status(),
    400,
  );
  assert.equal(
    (
      await admin.post(`${root}/health/check`, { headers, data: input })
    ).status(),
    429,
  );
  try {
    await ready();
    await fault('domain-delegation-denied');
    const partial = await check();
    assert.equal(partial.capabilities[0].failure, null);
    assert.equal(partial.capabilities[1].failure, 'delegation-not-authorized');
    assert.equal(partial.capabilities[1].scopeVerified, false);
    assert.equal(
      partial.capabilities[1].lastSucceededAt,
      initial.capabilities[1].lastSucceededAt,
    );
    await ready();
    await fault('domain-privilege-denied');
    const denied = await check(['domain-observations']);
    assert.equal(denied.capabilities[1].failure, 'permission-denied');
    assert.equal(denied.capabilities[1].scopeVerified, true);
    assert.deepEqual(denied.capabilities[0], partial.capabilities[0]);
    await ready();
    const legacy = await admin.post(`${root}/check`, {
      headers,
      data: { customerId: input.customerId, generation: 1 },
    });
    assert.equal(legacy.status(), 503, await legacy.text());
    const afterLegacy = await read();
    assert.deepEqual(afterLegacy.capabilities, denied.capabilities);
    assert.equal(afterLegacy.backgroundFailure, 'permission-denied');
    assert.ok(afterLegacy.check.finishedAt);
    assert.equal(
      (
        await migrator.query(
          "SELECT count(*)::int AS count FROM cc.security_events WHERE event='connection-checked' AND detail='health-inconclusive'",
        )
      ).rows[0].count,
      1,
    );
    for (const [mode, failure] of [
      ['quota', 'quota'],
      ['network', 'network-failure'],
    ]) {
      await ready();
      await fault(mode);
      const failed = await check(['domain-observations']);
      assert.equal(failed.capabilities[1].failure, failure);
      assert.equal(
        failed.capabilities[1].lastSucceededAt,
        initial.capabilities[1].lastSucceededAt,
      );
    }
    await ready();
    await fault('wrong-customer');
    const beforeWrong = await (await admin.get(root)).json();
    const wrong = await check();
    assert.equal(wrong.capabilities[0].failure, 'wrong-customer');
    assert.deepEqual(await (await admin.get(root)).json(), beforeWrong);
    await ready();
    await fault('delay-domain');
    const running = check(['domain-observations']);
    await expect
      .poll(
        async () =>
          (
            await migrator.query(
              'SELECT finished_at IS NULL AS pending FROM cc.google_health_checks',
            )
          ).rows[0].pending,
      )
      .toBe(true);
    const inFlight = await read();
    assert.equal(inFlight.check.finishedAt, null);
    assert.equal(
      (
        await admin.post(`${root}/health/check`, { headers, data: input })
      ).status(),
      429,
    );
    assert.equal(
      (
        await admin.post(`${root}/check`, {
          headers,
          data: { customerId: input.customerId, generation: 1 },
        })
      ).status(),
      429,
    );
    await running;
    await ready();
    await fault('');
    const recovered = await check();
    assert.ok(
      recovered.capabilities.every(
        (item) => item.scopeVerified && item.failure === null,
      ),
    );
    assert.equal(recovered.backgroundFailure, null);
    assert.ok(recovered.check.finishedAt);
    const events = (
      await migrator.query(
        "SELECT detail FROM cc.security_events WHERE correlation_id=$1 AND event='connection-checked'",
        [recovered.capabilities[0].correlationId],
      )
    ).rows.map((row) => row.detail);
    assert.ok(
      events.includes('health-started') && events.includes('health-completed'),
    );
    assert.equal(
      (await (await admin.get(root)).json()).connection.customerId,
      input.customerId,
    );
    assert.equal(
      (await admin.get(`${publicOrigin}/api/auth/session`)).status(),
      200,
    );
  } finally {
    await rm(faultPath, { force: true });
  }
  await writeFile(
    `${evidenceDirectory}/google-health-api.json`,
    JSON.stringify(
      {
        schemaVersion: 1,
        fixture: 'real-api-postgres-synthetic-google-transport',
        checks: [
          'scoped health read without private credential data',
          'CSRF and enabled capability allowlist',
          'shared legacy and capability diagnostic concurrency limit',
          'partial DWD authorization preserves working capability',
          'token scope verification does not imply administrator privilege',
          'combined read failure preserves independent capability observations',
          'quota and network failures retain historical success',
          'wrong customer cannot update connection observation',
          'explicit recovery succeeds without customer reset',
          'health start and completion retain correlation evidence',
          'Google failure preserves local sign-in',
        ],
        limits: [
          'Live restricted-role and revocation tests remain pending.',
          'Current Directory methods have no verified license-specific error contract.',
        ],
      },
      null,
      2,
    ),
  );
}

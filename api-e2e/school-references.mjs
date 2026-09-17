import assert from 'node:assert/strict';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from '@playwright/test';

export async function qualifySchoolReferencesApi({
  browser,
  publicOrigin,
  migrator,
  directory,
  evidenceDirectory,
  setSubject,
}) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const faultPath = join(directory, 'google-health-fault.json');
  let actor;
  let priorVersion;
  try {
    setSubject('administrator');
    const page = await context.newPage();
    await page.goto(`${publicOrigin}/api/auth/login`);
    await expect(
      page.getByRole('heading', { name: 'Your account', exact: true }),
    ).toBeVisible({ timeout: 15000 });
    const api = context.request;
    const session = await (
      await api.get(`${publicOrigin}/api/auth/session`)
    ).json();
    actor = session.identity.id;
    priorVersion = session.identity.permissionVersion;
    const headers = { origin: publicOrigin, 'x-csrf-token': session.csrfToken };
    const root = `${publicOrigin}/api/schools/references`;
    const read = async () => {
      const response = await api.get(root);
      assert.equal(response.status(), 200, await response.text());
      return (await response.json()).references;
    };
    const initial = await read();
    assert.equal(initial.observation, null);
    const input = {
      customerId: initial.customerId,
      generation: initial.generation,
    };
    const refresh = (data = input) =>
      api.post(`${root}/refresh`, { headers, data });
    const ready = () =>
      migrator.query(
        "UPDATE cc.school_reference_state SET retry_at=clock_timestamp()-interval '1 second'",
      );
    const fault = (mode) => writeFile(faultPath, JSON.stringify({ mode }));
    assert.equal(
      (await api.post(`${root}/refresh`, { data: input })).status(),
      403,
    );
    assert.equal((await refresh({ ...input, observation: {} })).status(), 400);
    assert.equal(
      (await refresh({ ...input, customerId: 'C9999999' })).status(),
      409,
    );
    const first = await refresh();
    assert.equal(first.status(), 201, await first.text());
    const valid = (await first.json()).references;
    assert.equal(valid.fresh, true);
    assert.equal(valid.observation.units.length, 3);
    assert.equal(JSON.stringify(valid).includes('envelope'), false);
    assert.equal(JSON.stringify(valid).includes('PRIVATE KEY'), false);
    assert.equal((await refresh()).status(), 429);
    for (const [mode, failure] of [
      ['ou-delegation-denied', 'delegation-not-authorized'],
      ['ou-privilege-denied', 'permission-denied'],
      ['ou-invalid', 'invalid-response'],
    ]) {
      await ready();
      await fault(mode);
      const response = await refresh();
      assert.equal(response.status(), 201, await response.text());
      const failed = (await response.json()).references;
      assert.equal(failed.failure, failure);
      assert.equal(failed.fresh, false);
      assert.deepEqual(failed.observation, valid.observation);
    }
    await ready();
    await fault('ou-delay');
    const pending = refresh();
    await expect.poll(async () => (await read()).checking).toBe(true);
    assert.equal((await refresh()).status(), 429);
    const success = await pending;
    assert.equal(success.status(), 201, await success.text());
    const recovered = (await success.json()).references;
    assert.equal(recovered.fresh, true);
    assert.notEqual(recovered.observation.revision, valid.observation.revision);
    await ready();
    const revoked = refresh();
    await expect.poll(async () => (await read()).checking).toBe(true);
    await migrator.query(
      'UPDATE cc.application_principals SET permission_version=permission_version+1 WHERE id=$1',
      [actor],
    );
    const denied = await revoked;
    assert.equal(denied.status(), 401, await denied.text());
    assert.equal((await denied.json()).code, 'access-changed');
    const retained = (
      await migrator.query('SELECT observation FROM cc.school_reference_state')
    ).rows[0].observation;
    assert.deepEqual(retained, recovered.observation);
    await writeFile(
      `${evidenceDirectory}/school-references-api.json`,
      JSON.stringify(
        {
          schemaVersion: 1,
          fixture: 'real-api-postgres-synthetic-google-transport',
          checks: [
            'current manager read excludes private credential material',
            'CSRF, strict input, customer binding, and refresh rate enforcement',
            'isolated OU scope produces a complete validated hierarchy',
            'DWD, privilege, and invalid hierarchy failures preserve prior references without freshness',
            'concurrent refresh rejection and successful recovery',
            'authority change during provider read denies publication and response',
          ],
          limits: [
            'School definitions, grant assignment, and the selector remain outside this increment.',
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    await rm(faultPath, { force: true });
    // The synthetic authority change must not alter later fixture checks.
    if (actor && priorVersion)
      await migrator.query(
        'UPDATE cc.application_principals SET permission_version=$1 WHERE id=$2',
        [priorVersion, actor],
      );
    await context.close();
  }
}

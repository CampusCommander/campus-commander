import { evidenceSecurity } from './evidence-security.mjs';
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
  auditAccessibility,
}) {
  const admin = page.context().request;
  const root = `${publicOrigin}/api/google-connection`;
  const session = await (
    await admin.get(`${publicOrigin}/api/auth/session`)
  ).json();
  evidenceSecurity.register('csrf-token', session.csrfToken);
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
  assert.equal(initial.capabilities.length, 6);
  assert.equal(JSON.stringify(initial).includes('envelope'), false);
  const capabilityResult = (health, capability) => {
    const result = health.capabilities.find(
      (item) => item.capability === capability,
    );
    assert.ok(result, `The health state names ${capability}.`);
    return result;
  };
  assert.equal(
    (await admin.post(`${root}/health/check`, { data: input })).status(),
    403,
  );
  assert.equal(
    (
      await admin.post(`${root}/health/check`, {
        headers,
        data: { ...input, capabilities: ['users'] },
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
    const partialCustomer = capabilityResult(partial, 'customer-identity');
    const partialDomain = capabilityResult(partial, 'domain-observations');
    assert.equal(partialCustomer.failure, null);
    assert.equal(partialDomain.failure, 'delegation-not-authorized');
    assert.equal(partialDomain.scopeVerified, false);
    assert.equal(
      partialDomain.lastSucceededAt,
      capabilityResult(initial, 'domain-observations').lastSucceededAt,
    );
    await page.goto(`${publicOrigin}/diagnostics`);
    const customerPanel = page.getByRole('article', {
      name: 'Customer identity',
      exact: true,
    });
    const domainPanel = page.getByRole('article', {
      name: 'Customer domains',
      exact: true,
    });
    await expect(customerPanel).toContainText('Last check passed');
    await expect(domainPanel).toContainText('Delegation not authorized');
    // The health answer holds six results. Setup grants all six scopes, so the
    // footer counts the six setup capabilities.
    await expect(page.locator('footer')).toContainText(
      '1 of 6 capabilities need attention',
    );
    await ready();
    await fault('domain-privilege-denied');
    await page.getByRole('button', { name: 'Refresh Google status' }).click();
    await page
      .getByRole('button', { name: 'Recheck Customer domains', exact: true })
      .click();
    await expect(domainPanel).toContainText('Google access denied');
    await expect(
      page.locator('#google-health [role=status]').first(),
    ).toBeFocused();
    const denied = await read();
    const deniedDomain = capabilityResult(denied, 'domain-observations');
    assert.equal(deniedDomain.failure, 'permission-denied');
    assert.equal(deniedDomain.scopeVerified, true);
    assert.deepEqual(
      capabilityResult(denied, 'customer-identity'),
      capabilityResult(partial, 'customer-identity'),
    );
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
      const failedDomain = capabilityResult(failed, 'domain-observations');
      assert.equal(failedDomain.failure, failure);
      assert.equal(
        failedDomain.lastSucceededAt,
        capabilityResult(initial, 'domain-observations').lastSucceededAt,
      );
    }
    await ready();
    await fault('wrong-customer');
    const beforeWrong = await (await admin.get(root)).json();
    const wrong = await check();
    assert.equal(
      capabilityResult(wrong, 'customer-identity').failure,
      'wrong-customer',
    );
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
    await page.getByRole('button', { name: 'Refresh Google status' }).click();
    await page.getByRole('button', { name: 'Check Google access' }).click();
    // Check Google access checks all six capabilities. Every result is current,
    // and the footer counts the six setup capabilities.
    await expect(page.locator('footer')).toContainText(
      'Google: 6 last checks passed',
    );
    const recovered = await read();
    for (const capability of [
      'customer-identity',
      'domain-observations',
      'school-ou-references',
      'device-inventory',
      'device-telemetry',
      'device-changes',
    ]) {
      const item = capabilityResult(recovered, capability);
      assert.equal(item.failure, null, capability);
      assert.equal(item.scopeVerified, true, capability);
      assert.ok(item.checkedAt, `${capability} records a check time.`);
    }
    assert.equal(recovered.backgroundFailure, null);
    assert.ok(recovered.check.finishedAt);
    await page
      .getByText('Configure required Google authorization', { exact: true })
      .click();
    await expect(
      page.getByLabel('Required Google capability scopes'),
    ).toContainText('orgunit');
    await expect(
      page.getByRole('link', {
        name: 'Open domain-wide delegation in the Google Admin console',
      }),
    ).toHaveAttribute('href', /orgunit/);
    for (const theme of ['light', 'dark']) {
      await page.getByRole('button', { name: 'Choose theme' }).click();
      await page.getByRole('menuitem', { name: `Use ${theme} theme` }).click();
      await expect(page.getByRole('menu')).toHaveCount(0);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await auditAccessibility(page, `google-capability-health-${theme}`);
      await evidenceSecurity.screenshot(page, {
        path: `${evidenceDirectory}/google-capability-health-${theme}.png`,
        fullPage: true,
      });
    }
    for (const [width, zoom] of [
      [320, 1],
      [1280, 2],
    ]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate((value) => {
        document.documentElement.style.zoom = String(value);
      }, zoom);
      await expect
        .poll(
          () =>
            page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          {
            message: `Google health must fit at width ${width} and zoom ${zoom}.`,
          },
        )
        .toBe(true);
    }
    await page.evaluate(() => {
      document.documentElement.style.zoom = '';
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    const events = (
      await migrator.query(
        "SELECT detail FROM cc.security_events WHERE correlation_id=$1 AND event='connection-checked'",
        [capabilityResult(recovered, 'customer-identity').correlationId],
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
    // Restore the shared API token after the intentional combined-read rejection.
    await ready();
    const background = await admin.post(`${root}/check`, {
      headers,
      data: { customerId: input.customerId, generation: 1 },
    });
    assert.equal(background.status(), 201, await background.text());
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
          'real browser targeted check, footer health, result focus, and recovery',
          'light and dark accessibility, 320-pixel reflow, and 200 percent CSS zoom',
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

import { evidenceSecurity } from './evidence-security.mjs';
import { qualificationSignIn } from './qualification-sign-in.mjs';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { expect } from '@playwright/test';

export async function qualifyCustomerSettings({
  page,
  publicOrigin,
  migrator,
  redis,
  restartApi,
  auditAccessibility,
  evidenceDirectory,
}) {
  const admin = page.context().request;
  const root = `${publicOrigin}/api/customer`;
  const session = await (
    await admin.get(`${publicOrigin}/api/auth/session`)
  ).json();
  evidenceSecurity.register('csrf-token', session.csrfToken);
  const headers = { origin: publicOrigin, 'x-csrf-token': session.csrfToken };
  const read = async () => {
    const response = await admin.get(root);
    assert.equal(response.status(), 200, await response.text());
    return (await response.json()).customer;
  };
  const initial = await read();
  assert.equal(initial.revision, 0);
  assert.equal(initial.onboarding.settingsConfirmedAt, null);
  const input = {
    customerId: initial.customerId,
    expectedRevision: 0,
    requestId: randomUUID(),
    settings: { displayName: 'Fixture district' },
  };
  for (const invalidHeaders of [
    { origin: publicOrigin },
    { ...headers, origin: 'https://wrong.invalid' },
  ]) {
    assert.equal(
      (
        await admin.post(`${root}/settings`, {
          headers: invalidHeaders,
          data: input,
        })
      ).status(),
      403,
    );
  }
  assert.equal(
    (
      await admin.post(`${root}/settings`, {
        headers,
        data: {
          ...input,
          settings: { ...input.settings, hostname: 'wrong.invalid' },
        },
      })
    ).status(),
    400,
  );
  assert.equal(
    (
      await admin.post(`${root}/settings`, {
        headers,
        data: { ...input, customerId: 'C9999999' },
      })
    ).status(),
    403,
  );
  assert.equal(
    (await admin.get(`${root}/receipts/${randomUUID()}`)).status(),
    404,
  );
  const originalGrants = (
    await migrator.query(
      "SELECT scope FROM cc.application_grants WHERE principal_id=$1 AND action='customer:write'",
      [session.identity.id],
    )
  ).rows;
  try {
    await migrator.query(
      "DELETE FROM cc.application_grants WHERE principal_id=$1 AND action='customer:write'",
      [session.identity.id],
    );
    assert.equal(
      (await admin.post(`${root}/settings`, { headers, data: input })).status(),
      403,
    );
    assert.deepEqual(await read(), initial);
  } finally {
    for (const { scope } of originalGrants)
      await migrator.query(
        "INSERT INTO cc.application_grants(principal_id,action,scope) VALUES($1,'customer:write',$2)",
        [session.identity.id, JSON.stringify(scope)],
      );
  }
  await page.goto(`${publicOrigin}/customer-settings`);
  await expect(page.getByLabel('Customer display name')).toHaveValue(
    initial.primaryDomain,
  );
  let receipt;
  let submitted;
  const lostResponse = async (route) => {
    submitted = route.request().postDataJSON();
    const response = await route.fetch();
    assert.equal(response.status(), 201, await response.text());
    receipt = await response.json();
    await route.abort('failed');
  };
  await page.route('**/api/customer/settings', lostResponse);
  await page
    .getByLabel('Customer display name')
    .fill('Confirmed fixture district');
  await page
    .getByRole('button', { name: 'Save customer settings', exact: true })
    .focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert')).toContainText(
    'We have not received a save confirmation',
  );
  await page.unroute('**/api/customer/settings', lostResponse);
  await page.reload();
  await expect(page.getByLabel('Customer display name')).toHaveValue(
    'Confirmed fixture district',
  );
  await page.getByRole('button', { name: 'Check save status' }).click();
  await expect(
    page.getByRole('heading', { name: 'Save confirmed' }),
  ).toBeVisible();
  assert.equal(receipt.revision, 1);
  const retried = await admin.post(`${root}/settings`, {
    headers,
    data: submitted,
  });
  assert.equal(retried.status(), 201);
  assert.deepEqual(await retried.json(), receipt);
  const auditCount = async () =>
    Number(
      (
        await migrator.query(
          "SELECT count(*) FROM cc.security_events WHERE event='customer-settings-changed'",
        )
      ).rows[0].count,
    );
  assert.equal(await auditCount(), 1);
  await expect(page.getByRole('navigation')).toContainText(
    'Confirmed fixture district',
  );

  // Another client saves after this browser reads revision one.
  await page.getByLabel('Customer display name').fill('My preserved district');
  const concurrent = {
    ...input,
    requestId: randomUUID(),
    expectedRevision: 1,
    settings: { displayName: 'Concurrent saved district' },
  };
  assert.equal(
    (
      await admin.post(`${root}/settings`, { headers, data: concurrent })
    ).status(),
    201,
  );
  await page
    .getByRole('button', { name: 'Save customer settings', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Review the latest saved name' }),
  ).toBeVisible();
  await expect(page.getByLabel('Customer display name')).toHaveValue(
    'My preserved district',
  );
  await expect(
    page.getByRole('button', { name: 'Save customer settings', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText('Concurrent saved district', { exact: true }),
  ).toBeVisible();
  assert.equal(await auditCount(), 2);
  for (const theme of ['light', 'dark']) {
    await page.getByRole('button', { name: 'Choose theme' }).click();
    await page.getByRole('menuitem', { name: `Use ${theme} theme` }).click();
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(page.locator('mat-label')).toHaveCSS(
      'color',
      theme === 'dark' ? 'rgb(154, 160, 166)' : 'rgb(95, 99, 104)',
    );
    for (const item of await page.locator('.card li').all())
      await expect(item).toHaveCSS(
        'color',
        theme === 'dark' ? 'rgb(232, 234, 237)' : 'rgb(32, 33, 36)',
      );
    await auditAccessibility(page, `customer-settings-conflict-${theme}`);
    await evidenceSecurity.screenshot(page, {
      path: `${evidenceDirectory}/customer-settings-${theme}.png`,
      fullPage: true,
    });
  }
  await page.getByRole('button', { name: 'Keep my edited name' }).click();
  await page
    .getByRole('button', { name: 'Save customer settings', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Save confirmed' }),
  ).toBeVisible();
  assert.equal((await read()).revision, 3);
  assert.equal(await auditCount(), 3);
  for (const [width, zoom] of [
    [1280, '2'],
    [320, '1'],
  ]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate((zoom) => {
      document.body.style.zoom = zoom;
    }, zoom);
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
  }
  await page.evaluate(() => {
    document.body.style.zoom = '1';
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page
    .getByLabel('Customer display name')
    .fill('Unsaved name through recovery');
  await page.context().setOffline(true);
  await page.getByRole('button', { name: 'Refresh saved settings' }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Saved customer settings are unavailable',
  );
  await expect(page.getByLabel('Customer display name')).toHaveValue(
    'Unsaved name through recovery',
  );
  await page.context().setOffline(false);
  const beforeRestart = await read();
  const connectionBefore = await (
    await admin.get(`${publicOrigin}/api/google-connection`)
  ).json();
  const candidatesBefore = Number(
    (
      await migrator.query(
        'SELECT count(*) FROM cc.google_credential_candidates',
      )
    ).rows[0].count,
  );
  await restartApi();
  assert.deepEqual(await read(), beforeRestart);
  const refreshed = page.waitForResponse(
    (response) =>
      response.url() === root && response.request().method() === 'GET',
  );
  await page.getByRole('button', { name: 'Refresh saved settings' }).click();
  assert.equal((await refreshed).status(), 200);
  await expect(
    page.getByRole('button', { name: 'Refresh saved settings' }),
  ).toBeEnabled();
  await expect(page.getByLabel('Customer display name')).toHaveValue(
    'Unsaved name through recovery',
  );

  const cookie = (await page.context().cookies()).find(
    (cookie) => cookie.name === '__Host-cc-session',
  );
  assert.ok(cookie);
  const sessionKey = `cc:auth:session:${createHash('sha256').update(cookie.value).digest('hex')}`;
  assert.equal(await redis.del(sessionKey), 1);
  await page.getByRole('button', { name: 'Refresh saved settings' }).click();
  await expect(
    page.getByRole('button', { name: 'Recheck access' }),
  ).toBeVisible();
  const loginPage = await page.context().newPage();
  await qualificationSignIn(
    loginPage,
    publicOrigin,
    evidenceDirectory,
    'customer-settings',
  );
  await evidenceSecurity.close(loginPage);
  await page.getByRole('button', { name: 'Recheck access' }).click();
  await expect(page.getByLabel('Customer display name')).toHaveValue(
    'Unsaved name through recovery',
  );
  await expect(
    page.getByRole('button', { name: 'Save customer settings', exact: true }),
  ).toBeEnabled();
  assert.deepEqual(await read(), beforeRestart);
  assert.deepEqual(
    await (await admin.get(`${publicOrigin}/api/google-connection`)).json(),
    connectionBefore,
  );
  assert.equal(
    Number(
      (
        await migrator.query(
          'SELECT count(*) FROM cc.google_credential_candidates',
        )
      ).rows[0].count,
    ),
    candidatesBefore,
  );
  await page.reload();
  await expect(page.getByLabel('Customer display name')).toHaveValue(
    'My preserved district',
  );
  await expect(
    page.getByRole('heading', { name: 'Setup progress' }),
  ).toBeVisible();
  await writeFile(
    `${evidenceDirectory}/customer-settings.json`,
    JSON.stringify(
      {
        schemaVersion: 1,
        fixture: 'real-api-postgres-redis-synthetic-google-transport',
        checks: [
          'strict settings allowlist',
          'CSRF and current scoped write authority',
          'durable lost-response receipt after reload',
          'exact retry creates one audit event',
          'concurrent save conflicts preserve draft and require revision review',
          'keyboard save',
          'light and dark automated accessibility',
          '200 percent CSS zoom and 320-pixel reflow',
          'offline refresh preserves draft',
          'API process restart preserves customer, settings, and draft',
          'Redis session loss requires sign-in and preserves confirmed business progress',
          'access recovery preserves draft without repeated credential verification',
          'reload restores confirmed progress',
        ],
        screenReaderWalkthrough: 'not-run',
      },
      null,
      2,
    ),
  );
}

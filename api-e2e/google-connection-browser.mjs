import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

/** Use the public page with the real API and a test-owned Google transport. */
export async function stageGoogleConnectionBrowser({
  page,
  publicOrigin,
  input,
  auditAccessibility,
  evidenceDirectory,
}) {
  await page.goto(`${publicOrigin}/google-connection`);
  await expect(
    page.getByRole('heading', {
      name: 'Import a service account',
      exact: true,
    }),
  ).toBeVisible();
  const file = page.getByLabel('Service-account JSON key file');
  await file.setInputFiles({
    name: 'wrong-client.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({ web: { client_id: 'sign-in-client' } }),
    ),
  });
  await expect(page.getByRole('alert')).toContainText(
    'Select a service-account JSON key file',
  );
  const choose = page.waitForEvent('filechooser');
  await page
    .getByRole('button', { name: 'Choose service-account file', exact: true })
    .focus();
  await page.keyboard.press('Enter');
  await (
    await choose
  ).setFiles({
    name: 'synthetic-service-account.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(input.serviceAccount)),
  });
  await expect(
    page.getByLabel('Service account client ID', { exact: true }),
  ).toHaveValue(input.clientId);
  await page.getByLabel('Delegated administrator email').fill(input.subject);
  await page.context().setOffline(true);
  await page
    .getByRole('button', { name: 'Refresh saved status', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText(
    'Saved connection status is unavailable',
  );
  await expect(page.getByLabel('Delegated administrator email')).toHaveValue(
    input.subject,
  );
  await expect(
    page.getByRole('button', { name: 'Check credentials', exact: true }),
  ).toBeDisabled();
  await page.context().setOffline(false);
  await page
    .getByRole('button', { name: 'Refresh saved status', exact: true })
    .click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByText('Configure Google delegation', { exact: true }).click();
  await expect(page.getByLabel('Required Google scopes')).toContainText(
    'admin.directory.customer.readonly',
  );
  await expect(page.getByLabel('Required Google scopes')).toContainText(
    'admin.directory.domain.readonly',
  );
  for (const theme of ['light', 'dark']) {
    await page.getByRole('button', { name: 'Choose theme' }).click();
    await page.getByRole('menuitem', { name: `Use ${theme} theme` }).click();
    await expect(page.locator('mat-label').first()).toHaveCSS(
      'color',
      theme === 'dark' ? 'rgb(154, 160, 166)' : 'rgb(95, 99, 104)',
    );
    await auditAccessibility(page, `google-connection-import-${theme}`);
    await page.screenshot({
      path: `${evidenceDirectory}/google-connection-import-${theme}.png`,
      fullPage: true,
    });
  }
  let candidate;
  const staged = Promise.withResolvers();
  const stageRoute = async (route) => {
    try {
      const response = await route.fetch();
      assert.equal(response.status(), 201, await response.text());
      candidate = await response.json();
      staged.resolve();
    } catch (error) {
      staged.reject(error);
    } finally {
      await route.abort('failed');
    }
  };
  await page.route('**/api/google-connection/candidates', stageRoute);
  await page
    .getByRole('button', { name: 'Check credentials', exact: true })
    .focus();
  await page.keyboard.press('Enter');
  await staged.promise;
  await expect(page.getByRole('alert')).toContainText(
    'credential result is unknown',
  );
  await page.unroute('**/api/google-connection/candidates', stageRoute);
  assert.equal(
    await file.count(),
    0,
    'The import control must close after submission.',
  );
  const storage = await page.evaluate(() =>
    JSON.stringify({
      local: { ...localStorage },
      session: { ...sessionStorage },
    }),
  );
  assert.equal(storage.includes('PRIVATE KEY'), false);
  assert.equal(storage.includes('access_token'), false);
  assert.equal(
    (await page.locator('body').textContent()).includes('PRIVATE KEY'),
    false,
  );
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Review Google customer', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(candidate.observation.customerId, { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('secondary.fixture.invalid — Secondary domain.', {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByText('alias.fixture.invalid — Alias. Not verified.', {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Confirm customer', exact: true }),
  ).toBeDisabled();
  for (const theme of ['light', 'dark']) {
    await page.getByRole('button', { name: 'Choose theme' }).click();
    await page.getByRole('menuitem', { name: `Use ${theme} theme` }).click();
    await auditAccessibility(page, `google-connection-review-${theme}`);
    await page.screenshot({
      path: `${evidenceDirectory}/google-connection-review-${theme}.png`,
      fullPage: true,
    });
  }
  for (const [width, zoom] of [
    [1280, '2'],
    [320, '1'],
  ]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate((zoom) => {
      document.body.style.zoom = zoom;
    }, zoom);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      true,
    );
  }
  await page.evaluate(() => {
    document.body.style.zoom = '1';
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  return candidate;
}

export async function confirmGoogleConnectionBrowser({
  page,
  candidate,
  evidenceDirectory,
  auditAccessibility,
}) {
  const committed = Promise.withResolvers();
  const release = Promise.withResolvers();
  const routePattern = `**/api/google-connection/candidates/${candidate.id}/confirm`;
  const confirmRoute = async (route) => {
    assert.deepEqual(route.request().postDataJSON(), {
      customerId: candidate.observation.customerId,
      confirmed: true,
    });
    try {
      const response = await route.fetch();
      assert.equal(response.status(), 201, await response.text());
      committed.resolve();
      await release.promise;
    } catch (error) {
      committed.reject(error);
    } finally {
      await route.abort('failed');
    }
  };
  await page.route(routePattern, confirmRoute);
  try {
    await page
      .getByRole('checkbox', {
        name: 'I verified this customer ID and primary domain',
      })
      .check();
    const confirm = page.getByRole('button', {
      name: 'Confirm customer',
      exact: true,
    });
    await expect(confirm).toBeEnabled();
    await confirm.focus();
    await expect(confirm).toBeFocused();
    await page.keyboard.press('Enter');
    await committed.promise;
    await expect(confirm).toBeDisabled();
    release.resolve();
    await expect(page.getByRole('alert')).toContainText(
      'Confirmation did not return a result',
    );
    await page
      .getByRole('button', { name: 'Refresh saved status', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: 'Customer connected', exact: true }),
    ).toBeVisible();
  } finally {
    release.resolve();
    await page.unroute(routePattern, confirmRoute);
  }
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Customer connected', exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole('navigation')
      .getByText(candidate.observation.customerId, { exact: true }),
  ).toBeVisible();
  for (const theme of ['light', 'dark']) {
    await page.getByRole('button', { name: 'Choose theme' }).click();
    await page.getByRole('menuitem', { name: `Use ${theme} theme` }).click();
    await auditAccessibility(page, `google-connection-confirmed-${theme}`);
  }
  await writeFile(
    `${evidenceDirectory}/google-connection-browser.json`,
    JSON.stringify(
      {
        schemaVersion: 1,
        fixture: 'real-api-database-synthetic-google-transport',
        rules: [
          'UI-01',
          'UI-02',
          'UI-03',
          'UI-04',
          'UI-05',
          'UI-06',
          'UI-07',
          'UI-08',
          'UI-09',
          'UI-10',
          'FORM-01',
        ],
        checks: [
          'keyboard file import and confirmation',
          'reject sign-in client file',
          'offline input preservation and stale-state denial',
          'exact client ID and shared read-only scope text',
          'lost import response and reload recover public candidate metadata',
          'customer, primary and secondary domains, aliases, and verification flags before confirmation',
          'confirmation requires explicit customer review',
          'pending confirmation prevents duplicate submission',
          'lost confirmation response recovers durable customer binding',
          'credentials absent from DOM and browser storage',
          'light and dark automated accessibility',
          '200 percent CSS zoom and 320-pixel overflow',
        ],
        screenReaderWalkthrough: 'not-run',
      },
      null,
      2,
    ),
  );
}

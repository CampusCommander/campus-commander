import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

/**
 * Screenshot the Devices grid of a running mock-backed review environment.
 *
 * Run `npm exec -- nx run api-e2e:client-review-mock` first, then run this script.
 * It reads `dist/client-review/runtime.json`, signs in as the review administrator,
 * connects the printed mock credential when the environment holds no connection,
 * refreshes the inventory, and saves the grid with the status bar count.
 *
 * Usage: node api-e2e/client-review-mock-browser.mjs [output.png]
 */
const runtime = JSON.parse(
  await readFile('dist/client-review/runtime.json', 'utf8'),
);
assert.equal(
  runtime.googleServices,
  'admin-sdk-mock',
  'Start the client-review-mock target before this screenshot step.',
);
const output =
  process.argv[2] ?? `dist/client-review/devices-${runtime.tier}.png`;
const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  await page.goto(`${runtime.url}/api/auth/login`);
  await page
    .getByRole('button', { name: 'Sign in as review administrator' })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Your account', exact: true }),
  ).toBeVisible({ timeout: 15000 });
  await page.getByRole('link', { name: 'Devices' }).click();
  await expect(
    page.getByRole('heading', { name: 'Devices', level: 1 }),
  ).toBeVisible();
  // A fresh review environment starts without a Google connection. Connect the
  // mock credential through the same page a reviewer uses.
  if (
    await page
      .getByRole('heading', { name: 'Connect Google Workspace' })
      .isVisible()
  ) {
    await page.getByRole('link', { name: 'Open Google connection' }).click();
    await expect(
      page.getByRole('heading', { name: 'Import a service account' }),
    ).toBeVisible();
    await page
      .getByLabel('Service-account JSON key file')
      .setInputFiles(runtime.sampleKeyPath);
    await page
      .getByLabel('Delegated administrator email')
      .fill(runtime.delegatedEmail);
    await page.getByRole('button', { name: 'Check credentials' }).click();
    await expect(
      page.getByRole('heading', { name: 'Review Google customer' }),
    ).toBeVisible({ timeout: 120000 });
    await page
      .getByRole('checkbox', {
        name: 'I verified this customer ID and primary domain',
      })
      .check();
    await page.getByRole('button', { name: 'Confirm customer' }).click();
    await expect(
      page.getByRole('heading', { name: 'Customer connected' }),
    ).toBeVisible({ timeout: 120000 });
    process.stdout.write(
      `Connected Google customer ${runtime.customerId} as ${runtime.delegatedEmail}\n`,
    );
    await page.getByRole('link', { name: 'Devices' }).click();
    await expect(
      page.getByRole('heading', { name: 'Devices', level: 1 }),
    ).toBeVisible();
  }
  await page.getByRole('button', { name: 'Refresh inventory' }).click();
  const count = page.getByText(
    `${runtime.deviceCount} matching devices · ${runtime.deviceCount} in district`,
  );
  await expect(count).toBeVisible({ timeout: 600_000 });
  await count.scrollIntoViewIfNeeded();
  await page.screenshot({ path: output, fullPage: true });
  const statusBar = page.getByText('matching devices');
  await expect(statusBar).toBeVisible();
  process.stdout.write(
    `Saved ${output} with ${runtime.deviceCount} devices from ${runtime.url}\n`,
  );
} finally {
  await browser.close();
}

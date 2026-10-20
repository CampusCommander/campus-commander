import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

/**
 * Screenshot the Devices grid and the Google connection page of a running
 * mock-backed review environment.
 *
 * Run `npm exec -- nx run api-e2e:client-review-mock` first, then run this script.
 * It reads `dist/client-review/runtime.json`, signs in as the review administrator,
 * connects the printed mock credential when the environment holds no connection,
 * refreshes the inventory, saves the grid with the status bar count, and saves the
 * connection page with the domains the mock serves.
 *
 * Usage: node api-e2e/client-review-mock-browser.mjs [devices.png] [connection.png]
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
const connectionOutput =
  process.argv[3] ?? `dist/client-review/google-connection-${runtime.tier}.png`;
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
  // The Devices page settles on the connect prompt, an empty inventory with a
  // refresh control, or the published grid. Wait for one settled state before
  // branching, so the connection response never races the first check.
  const connectPrompt = page.getByRole('heading', {
    name: 'Connect Google Workspace',
  });
  const refreshInventory = page.getByRole('button', {
    name: 'Refresh inventory',
  });
  const publishedRefresh = page.getByRole('button', {
    name: 'Refresh',
    exact: true,
  });
  await expect(
    connectPrompt.or(refreshInventory).or(publishedRefresh),
  ).toBeVisible({ timeout: 120000 });
  // A fresh review environment starts without a Google connection. Connect the
  // mock credential through the same page a reviewer uses.
  if (await connectPrompt.isVisible()) {
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
    await expect(refreshInventory.or(publishedRefresh)).toBeVisible({
      timeout: 300000,
    });
  }
  // The status bar prints counts with the en-US grouping the component uses.
  const formattedCount = runtime.deviceCount.toLocaleString('en-US');
  const readSync = () =>
    page.evaluate(async () => {
      const response = await fetch('/api/devices/sync', {
        headers: { accept: 'application/json' },
      });
      return (await response.json()).sync;
    });
  const before = await readSync();
  const refreshStartedAt = Date.now();
  if (await refreshInventory.isVisible()) {
    await refreshInventory.click();
  } else {
    // The environment already holds a published inventory. Refresh through the
    // menu the same way a reviewer does.
    await publishedRefresh.click();
    await page.getByRole('menuitem', { name: 'Refresh Devices' }).click();
  }
  // The grid keeps the published inventory while the next sync runs. The
  // projection reports a new checkedAt when a sync completes, and the running
  // state keeps the previous value. Wait for the new one, so the recorded count
  // and time belong to this refresh.
  await expect
    .poll(
      async () => {
        const state = await readSync();
        return (
          state?.status === 'ready' && state.checkedAt !== before?.checkedAt
        );
      },
      { timeout: 600_000 },
    )
    .toBe(true);
  const refreshSeconds = (Date.now() - refreshStartedAt) / 1000;
  const sync = await readSync();
  const syncSeconds =
    (Date.parse(sync.checkedAt) - Date.parse(sync.startedAt)) / 1000;
  process.stdout.write(
    `Sync: status ${sync.status}, generation ${sync.generation}, ${sync.deviceCount} devices, ${syncSeconds.toFixed(1)} s from ${sync.startedAt} to ${sync.checkedAt}\n`,
  );
  process.stdout.write(
    `Refresh Devices: ${refreshSeconds.toFixed(1)} s from the click to the completed sync\n`,
  );
  const count = page.getByText(
    `${formattedCount} matching devices · ${formattedCount} in district`,
  );
  await expect(count).toBeVisible({ timeout: 120_000 });
  await count.scrollIntoViewIfNeeded();
  await page.screenshot({ path: output, fullPage: true });
  const statusBar = page.getByText('matching devices');
  await expect(statusBar).toBeVisible();
  process.stdout.write(
    `Saved ${output} with ${runtime.deviceCount} devices from ${runtime.url}\n`,
  );
  // The connection page lists the domains the mock serves. Capture it after the
  // sync, so it holds the connection record a reviewer inspects.
  await page.getByRole('link', { name: 'Google connection' }).click();
  await expect(
    page.getByRole('heading', { name: 'Customer connected' }),
  ).toBeVisible({ timeout: 60000 });
  const domainRows = page.locator('h3:has-text("Domains") + ul > li');
  await expect(domainRows.first()).toBeVisible({ timeout: 60000 });
  await domainRows.first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: connectionOutput, fullPage: true });
  const domains = (await domainRows.allInnerTexts()).map((text) =>
    text.replace(/\s+/g, ' ').trim(),
  );
  process.stdout.write(
    `Saved ${connectionOutput} with domains: ${domains.join(' | ')}\n`,
  );
} finally {
  await browser.close();
}

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

export async function runProfileBrowser({ url, bootstrapFile }) {
  const endpoint = new URL(url);
  assert.equal(endpoint.protocol, 'https:');
  assert.equal(endpoint.hostname, 'campus.example.org');
  assert.ok(endpoint.port, 'Use the isolated fixture listener.');
  const credential = (await readFile(bootstrapFile, 'utf8')).trim();
  assert.ok(credential.length >= 32);
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--host-resolver-rules=MAP campus.example.org 127.0.0.1',
      '--no-proxy-server',
    ],
  });
  try {
    // The separate HTTPS fault fixture verifies trust and certificate failures.
    const unauthenticated = await browser.newContext({
      ignoreHTTPSErrors: true,
    });
    const deniedPage = await unauthenticated.newPage();
    const denied = await deniedPage.goto(url, {
      waitUntil: 'domcontentloaded',
    });
    assert.equal(denied.status(), 401);
    await unauthenticated.close();
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      httpCredentials: { username: 'operator', password: credential },
    });
    const page = await context.newPage();
    const startupResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/startup' &&
        response.status() === 200,
      { timeout: 30000 },
    );
    const navigation = await page.goto(url, { waitUntil: 'domcontentloaded' });
    assert.equal(navigation.status(), 200);
    const report = await (await startupResponse).json();
    assert.equal(report.status, 'ready');
    assert.equal(report.checks.length, 8);
    assert.ok(report.checks.every((check) => check.status === 'ready'));
    await page
      .getByRole('heading', { name: 'Installation checks ready', exact: true })
      .waitFor();
    assert.equal(await page.locator('.installation-status li').count(), 8);
    assert.equal(
      await page
        .getByRole('heading', {
          name: 'Application service started',
          exact: true,
        })
        .count(),
      1,
    );
    const displayed = await page
      .locator('.installation-status li')
      .allTextContents();
    for (const check of report.checks)
      assert.ok(displayed.some((text) => text.includes(check.name)));
    return {
      status: 'passed',
      browser: `Chromium ${browser.version()}`,
      unauthenticatedStatus: 401,
      authenticatedStatus: 200,
      readyChecks: report.checks.map(({ name }) => name),
      responseInterception: false,
      certificateVerification:
        'disabled only for this synthetic browser fixture; verified separately by HTTPS tests',
      districtBrowserTrustQualified: false,
      humanWalkthrough: false,
    };
  } finally {
    await browser.close();
  }
}

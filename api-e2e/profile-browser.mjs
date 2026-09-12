import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { startScreenReader } from './screen-reader.mjs';

export async function applicationBrowser(
  publicOrigin,
  run,
  { recoverySeconds = 0 } = {},
) {
  const reader =
    process.env.CC_AUTH_SCREEN_READER === '1'
      ? await startScreenReader()
      : undefined;
  let browser;
  try {
    browser = await chromium.launch({
      ...(reader ? { headless: false, slowMo: 250, env: reader.env } : {}),
      args: [
        '--host-resolver-rules=MAP host.docker.internal 127.0.0.1,MAP campus.example.org 127.0.0.1',
        ...(reader ? ['--force-renderer-accessibility'] : []),
      ],
    });
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    const activate = async (control) => {
      if (reader) {
        await control.focus();
        await new Promise((done) => setTimeout(done, 1500));
        await control.press('Enter');
      } else await control.click();
    };
    const errors = [];
    const observations = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(publicOrigin);
    if (reader) {
      await page.bringToFront();
      await reader.waitForControl('Sign in to Campus Commander');
      await page
        .getByRole('link', { name: 'Sign in to Campus Commander' })
        .focus();
      await reader.waitForControl('Sign in to Campus Commander', true);
    }
    await activate(
      page.getByRole('link', { name: 'Sign in to Campus Commander' }),
    );
    await expect(
      page.getByRole('heading', { name: 'Your account', exact: true }),
    ).toBeVisible({ timeout: 15000 });
    await expect(page).toHaveTitle('Your account · Campus Commander');
    const checks = async ({
      recoverySeconds: bound = recoverySeconds,
      recoveryDeadline,
    } = {}) => {
      await activate(
        page.getByRole('link', { name: 'Diagnostics', exact: true }).first(),
      );
      await expect(page).toHaveTitle('Diagnostics · Campus Commander');
      if (reader) await new Promise((done) => setTimeout(done, 2000));
      for (const name of [
        'PostgreSQL',
        'Redis',
        'Kestra',
        'Artifact storage',
      ]) {
        const operation = {
          PostgreSQL: 'postgresql',
          Redis: 'redis',
          Kestra: 'kestra',
          'Artifact storage': 'artifacts',
        }[name];
        const deadline = recoveryDeadline ?? Date.now() + bound * 1000;
        let passed = false;
        do {
          const response = page.waitForResponse(
            (result) =>
              new URL(result.url()).pathname ===
                `/api/diagnostics/${operation}` &&
              result.request().method() === 'POST',
            { timeout: 45000 },
          );
          const card = page
            .getByRole('article')
            .filter({ has: page.getByRole('heading', { name, exact: true }) });
          await activate(
            card.getByRole('button', { name: `Check ${name}`, exact: true }),
          );
          const result = await response;
          assert.equal(result.status(), 201);
          const body = await result.json();
          observations.push({
            operation,
            status: body.status,
            correlationId: body.correlationId,
            observedAt: new Date().toISOString(),
          });
          passed =
            body.status === 'passed' &&
            (recoveryDeadline === undefined || Date.now() <= recoveryDeadline);
          if (!passed && Date.now() < deadline)
            await new Promise((done) => setTimeout(done, 2000));
        } while (!passed && Date.now() < deadline);
        assert.ok(
          passed,
          `${name} operation did not recover within ${bound} seconds.`,
        );
        const card = page
          .getByRole('article')
          .filter({ has: page.getByRole('heading', { name, exact: true }) });
        await expect(
          card.getByText(
            'The check passed. The service returned the expected result.',
          ),
        ).toBeVisible({ timeout: 45000 });
        if (reader) await new Promise((done) => setTimeout(done, 1000));
      }
    };
    await checks();
    const lifecycle = await run({ page, context, checks });
    await activate(page.getByRole('button', { name: 'Open user menu' }));
    await activate(page.getByRole('menuitem', { name: 'Sign out' }));
    await expect(
      page.getByRole('heading', { name: 'Sign in', exact: true }),
    ).toBeVisible();
    assert.deepEqual(errors, []);
    const screenReader = reader ? await reader.verify() : undefined;
    return {
      status: 'passed',
      ...(screenReader ? { screenReader } : {}),
      browser: browser.version(),
      operations: ['postgresql', 'redis', 'kestra', 'artifacts'],
      observations,
      recoveryBoundSeconds: recoverySeconds,
      ...(lifecycle ? { lifecycle } : {}),
      districtBrowserTrustQualified: false,
      tls: 'synthetic CA; browser trust prompts omitted only in fixture',
    };
  } finally {
    await browser?.close();
    await reader?.stop();
  }
}

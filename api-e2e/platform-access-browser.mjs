import { evidenceSecurity } from './evidence-security.mjs';
import { expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

export async function qualifyPlatformAccessBrowser({
  page,
  publicOrigin,
  identity,
  auditAccessibility,
  evidenceDirectory,
}) {
  await page.goto(`${publicOrigin}/platform-users`);
  await expect(
    page.getByRole('heading', { name: 'Platform access', exact: true }),
  ).toBeVisible();
  await page
    .locator(`[data-principal-id="${identity.id}"]`)
    .getByRole('button', {
      name: `Review access for ${identity.displayName}`,
      exact: true,
    })
    .click();
  await expect(
    page.getByRole('heading', {
      name: `Access for ${identity.displayName}`,
      exact: true,
    }),
  ).toBeVisible();
  const grant = page.getByRole('checkbox', {
    name: 'View security events',
    exact: true,
  });
  await page
    .getByRole('button', { name: 'Review access changes', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText(
    'There are no changes to review.',
  );
  await grant.check();
  await page.context().setOffline(true);
  await page
    .getByRole('button', { name: 'Refresh platform users', exact: true })
    .click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(grant).toBeChecked();
  await expect(
    page.getByRole('button', { name: 'Review access changes', exact: true }),
  ).toBeDisabled();
  await page.context().setOffline(false);
  await page
    .getByRole('button', { name: 'Refresh platform users', exact: true })
    .click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(grant).toBeChecked();
  await page
    .getByRole('button', { name: 'Review access changes', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Confirm access changes', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Confirm access changes', exact: true }),
  ).toBeDisabled();
  await page
    .getByRole('checkbox', { name: 'Enable application sign-in', exact: true })
    .uncheck();
  await expect(
    page.getByRole('heading', { name: 'Confirm access changes', exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole('checkbox', { name: 'Enable application sign-in', exact: true })
    .check();
  await page
    .getByRole('button', { name: 'Review access changes', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Confirm access changes', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('checkbox', {
      name: 'I checked the person and the permissions shown above.',
      exact: true,
    })
    .check();
  await page.context().setOffline(true);
  await page
    .getByRole('button', {
      name: 'Reload access and discard edits',
      exact: true,
    })
    .click();
  await expect(page.getByRole('alert')).toContainText(
    'Access details are unavailable.',
  );
  await expect(
    page.getByRole('heading', { name: 'Confirm access changes', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Review access changes', exact: true }),
  ).toBeDisabled();
  await expect(grant).toBeChecked();
  await page.context().setOffline(false);
  await page
    .getByRole('button', {
      name: 'Reload access and discard edits',
      exact: true,
    })
    .click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(grant).not.toBeChecked();
  await grant.check();
  await page
    .getByRole('button', { name: 'Review access changes', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Confirm access changes', exact: true }),
  ).toBeVisible();
  for (const theme of ['light', 'dark']) {
    await page.getByRole('button', { name: 'Choose theme' }).click();
    await page.getByRole('menuitem', { name: `Use ${theme} theme` }).click();
    await auditAccessibility(page, `platform-access-review-${theme}`);
    await evidenceSecurity.screenshot(page, {
      path: `${evidenceDirectory}/platform-access-review-${theme}.png`,
      fullPage: true,
    });
  }
  await page
    .getByRole('checkbox', {
      name: 'I checked the person and the permissions shown above.',
      exact: true,
    })
    .check();
  const confirmation = page.getByRole('button', {
    name: 'Confirm access changes',
    exact: true,
  });
  await expect(confirmation).toBeEnabled();
  await confirmation.focus();
  await expect(confirmation).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('status', { name: 'Platform access status' }),
  ).toContainText(
    'Access saved. This person must sign in again. Change reference:',
  );
  await page
    .getByRole('button', {
      name: 'Reload access and discard edits',
      exact: true,
    })
    .click();
  await expect(
    page.getByRole('status', { name: 'Platform access status' }),
  ).toContainText('Permissions loaded.');
  await expect(grant).toBeChecked();
  const receiptHistory = page.getByRole('region', {
    name: 'Access change history',
  });
  await expect(receiptHistory.locator('summary')).not.toHaveCount(0);
  const receiptText = await receiptHistory
    .locator('summary')
    .first()
    .textContent();
  await page.reload();
  await page
    .locator(`[data-principal-id="${identity.id}"]`)
    .getByRole('button')
    .click();
  await expect(receiptHistory).toContainText(receiptText);
  await expect(grant).toBeChecked();
  await grant.uncheck();
  await page
    .getByRole('button', { name: 'Review access changes', exact: true })
    .click();
  await page
    .getByRole('checkbox', {
      name: 'I checked the person and the permissions shown above.',
      exact: true,
    })
    .check();
  const mutationUrl = `${publicOrigin}/api/platform-users/${identity.id}/access`;
  await page.route(
    mutationUrl,
    async (route) => {
      const result = await route.fetch();
      expect(result.status()).toBe(201);
      await route.abort('connectionreset');
    },
    { times: 1 },
  );
  await page
    .getByRole('button', { name: 'Confirm access changes', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText(
    'We have not received a save confirmation.',
  );
  await expect(
    page.getByRole('button', { name: 'Review access changes', exact: true }),
  ).toBeDisabled();
  await page
    .getByRole('button', {
      name: 'Reload access and discard edits',
      exact: true,
    })
    .click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(grant).not.toBeChecked();
  await expect(receiptHistory.locator('summary').first()).not.toHaveText(
    receiptText,
  );
  await receiptHistory.locator('summary').first().click();
  await expect(
    receiptHistory.getByRole('heading', { name: 'Saved permissions' }).first(),
  ).toBeVisible();
  await page.setViewportSize({ width: 320, height: 720 });
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  await page
    .getByRole('button', { name: 'Review access changes', exact: true })
    .focus();
  await expect(
    page.getByRole('button', { name: 'Review access changes', exact: true }),
  ).toBeFocused();
  await evidenceSecurity.screenshot(page, {
    path: `${evidenceDirectory}/platform-access-mobile.png`,
    fullPage: true,
  });
  await writeFile(
    `${evidenceDirectory}/platform-access-browser.json`,
    JSON.stringify(
      {
        status: 'passed',
        sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], {
          encoding: 'utf8',
        }).trim(),
        recordedAt: new Date().toISOString(),
        checks: [
          'principal list and exact identity detail',
          'offline draft preservation and disabled review',
          'failed detail reload invalidates confirmed preview',
          'unchanged review explains the required edit',
          'receipt history survives browser reload',
          'lost confirmation response reports unknown outcome and reconciles committed receipt',
          'server review and explicit grant confirmation',
          'editing invalidates reviewed changes',
          'audited receipt and persisted exact grants',
          'light and dark accessibility',
          'keyboard confirmation and 320 pixel reflow',
        ],
        limits: [
          'District and school presets require verified resource integration.',
          'Human screen-reader walkthrough remains not run.',
        ],
      },
      null,
      2,
    ),
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${publicOrigin}/invitations`);
  await expect(
    page.getByRole('heading', { name: 'Platform invitations', exact: true }),
  ).toBeVisible();
}

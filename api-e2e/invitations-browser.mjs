import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { expect } from '@playwright/test';
import { setTimeout as delay } from 'node:timers/promises';

export async function qualifyInvitationBrowser({
  browser,
  page,
  publicOrigin,
  migrator,
  principalId,
  setSubject,
  auditAccessibility,
  evidenceDirectory,
}) {
  await migrator.query(
    `INSERT INTO cc.application_grants(principal_id,action,scope)
    SELECT $1,action,'{"kind":"platform"}'::jsonb FROM cc.application_actions ON CONFLICT DO NOTHING`,
    [principalId],
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${publicOrigin}/invitations`);
  await expect(
    page.getByRole('heading', { name: 'Platform invitations', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('No invitations yet.', { exact: true }),
  ).toBeVisible();
  for (const theme of ['light', 'dark']) {
    await page.getByRole('button', { name: 'Choose theme' }).click();
    await page.getByRole('menuitem', { name: `Use ${theme} theme` }).click();
    await auditAccessibility(page, `invitations-${theme}`);
    await page.screenshot({
      path: `${evidenceDirectory}/invitations-${theme}.png`,
      fullPage: true,
    });
  }
  await page
    .getByLabel('Recipient label', { exact: true })
    .fill('Controlled recipient');
  await page
    .getByLabel('Sign-in subject', { exact: true })
    .fill('invited-platform-user');
  await page
    .getByRole('checkbox', { name: 'Read customer settings', exact: true })
    .check();
  await page.context().setOffline(true);
  await page
    .getByRole('button', { name: 'Refresh invitations', exact: true })
    .click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByLabel('Recipient label', { exact: true })).toHaveValue(
    'Controlled recipient',
  );
  await page.context().setOffline(false);
  await page
    .getByRole('button', { name: 'Refresh invitations', exact: true })
    .click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Create invitation', exact: true })
    .focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByLabel('Invitation link', { exact: true }),
  ).toBeVisible();
  const link = await page
    .getByLabel('Invitation link', { exact: true })
    .inputValue();
  assert.ok(
    link.startsWith(`${publicOrigin}/invitation#`),
    'The invitation uses a fragment link.',
  );
  const marker = new URL(link).hash.slice(1);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page
    .getByRole('button', { name: 'Copy invitation link', exact: true })
    .click();
  await expect(
    page.getByText(
      'Invitation link copied. Share it with the intended recipient.',
      { exact: true },
    ),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Invitation link', { exact: true })).toHaveCount(
    0,
  );
  const recipient = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 900 },
    reducedMotion: 'reduce',
  });
  const recipientPage = await recipient.newPage();
  try {
    setSubject('invited-platform-user');
    await recipientPage.goto(link);
    await expect(
      recipientPage.getByRole('heading', {
        name: 'Accept a platform invitation',
        exact: true,
      }),
    ).toBeVisible();
    await expect.poll(() => new URL(recipientPage.url()).hash.length).toBe(0);
    await recipientPage
      .getByRole('button', {
        name: 'Sign in to accept invitation',
        exact: true,
      })
      .click();
    await expect(
      recipientPage.getByText(
        'Your identity is verified. Ask your inviter to review and confirm your access.',
        { exact: true },
      ),
    ).toBeVisible();
    assert.equal(
      (
        await recipient.request.get(`${publicOrigin}/api/auth/session`)
      ).status(),
      401,
    );
    assert.equal(
      (
        await migrator.query(
          "SELECT id FROM cc.application_principals WHERE subject='invited-platform-user'",
        )
      ).rowCount,
      0,
    );
    for (const theme of ['light', 'dark']) {
      await recipientPage.evaluate(
        (theme) => (document.documentElement.dataset.theme = theme),
        theme,
      );
      await auditAccessibility(
        recipientPage,
        `invitation-awaiting-confirmation-${theme}`,
      );
    }
    await expect(
      recipientPage.getByText('invited-platform-user', { exact: true }),
    ).toBeVisible();
    setSubject('administrator');
    await page
      .getByRole('button', { name: 'Refresh invitations', exact: true })
      .click();
    const item = page.getByRole('article', {
      name: 'Invitation for Controlled recipient',
      exact: true,
    });
    await item
      .getByRole('button', { name: 'Review identity', exact: true })
      .click();
    await expect(
      item.getByText('invited-platform-user', { exact: true }),
    ).toBeVisible();
    await expect(
      item.getByRole('button', {
        name: 'Confirm identity and grant access',
        exact: true,
      }),
    ).toBeDisabled();
    for (const theme of ['light', 'dark']) {
      await page.getByRole('button', { name: 'Choose theme' }).click();
      await page.getByRole('menuitem', { name: `Use ${theme} theme` }).click();
      await auditAccessibility(page, `invitation-identity-review-${theme}`);
    }
    await item
      .getByRole('checkbox', {
        name: 'I verified this exact identity and its intended access.',
        exact: true,
      })
      .check();
    await item
      .getByRole('button', {
        name: 'Confirm identity and grant access',
        exact: true,
      })
      .click();
    await expect(
      page.getByText('Access granted. The recipient can now sign in.', {
        exact: true,
      }),
    ).toBeVisible();
    await recipientPage
      .getByRole('button', { name: 'Check invitation status', exact: true })
      .click();
    await expect(
      recipientPage.getByText(
        'Your inviter confirmed your access. Sign in to continue.',
        { exact: true },
      ),
    ).toBeVisible();
    setSubject('invited-platform-user');
    await recipientPage
      .getByRole('link', { name: 'Sign in to Campus Commander', exact: true })
      .click();
    await expect(
      recipientPage.getByRole('heading', { name: 'Your account', exact: true }),
    ).toBeVisible();
    const session = await (
      await recipient.request.get(`${publicOrigin}/api/auth/session`)
    ).json();
    assert.deepEqual(session.identity.permissions, ['identity:read']);
    assert.deepEqual(session.identity.grants, [
      { action: 'customer:read', scope: { kind: 'platform' } },
    ]);
    await expect(
      recipientPage.getByRole('link', { name: 'Diagnostics', exact: true }),
    ).toHaveCount(0);
    await expect(
      recipientPage.getByRole('link', {
        name: 'Platform invitations',
        exact: true,
      }),
    ).toHaveCount(0);
    assert.equal(
      (
        await recipient.request.get(`${publicOrigin}/api/auth/invitations`)
      ).status(),
      403,
    );
    assert.equal(
      (
        await recipient.request.post(`${publicOrigin}/api/auth/invitations`, {
          headers: { origin: publicOrigin, 'x-csrf-token': session.csrfToken },
          data: { label: 'Forbidden', expiresInHours: 24, grants: [] },
        })
      ).status(),
      403,
    );
    setSubject('administrator');
    const adminSession = await (
      await page.context().request.get(`${publicOrigin}/api/auth/session`)
    ).json();
    const client = page.context().request;
    const csrf = {
      'x-csrf-token': adminSession.csrfToken,
      origin: publicOrigin,
    };
    assert.equal(
      (
        await client.post(`${publicOrigin}/api/auth/invitations`, {
          data: { label: 'Invalid origin', expiresInHours: 24, grants: [] },
          headers: { ...csrf, origin: 'https://wrong.invalid' },
        })
      ).status(),
      403,
    );
    assert.equal(
      (
        await client.post(`${publicOrigin}/api/auth/invitations`, {
          data: { label: 'Missing CSRF', expiresInHours: 24, grants: [] },
          headers: { origin: publicOrigin },
        })
      ).status(),
      403,
    );
    const listed = await (
      await client.get(`${publicOrigin}/api/auth/invitations`)
    ).text();
    assert.ok(
      !listed.includes(marker),
      'Invitation lists exclude bearer tokens.',
    );
    assert.ok(
      !listed.includes('token_hash'),
      'Invitation lists exclude token hashes.',
    );
    await page
      .getByLabel('Recipient label', { exact: true })
      .fill('Revoked recipient');
    await page
      .getByRole('button', { name: 'Create invitation', exact: true })
      .click();
    await expect(
      page.getByLabel('Invitation link', { exact: true }),
    ).toBeVisible();
    const revokedLink = await page
      .getByLabel('Invitation link', { exact: true })
      .inputValue();
    await page.reload();
    const revoked = page.getByRole('article', {
      name: 'Invitation for Revoked recipient',
      exact: true,
    });
    await revoked
      .getByRole('button', { name: 'Revoke invitation', exact: true })
      .click();
    await expect(revoked).toContainText('revoked');
    await delay(2100);
    await recipientPage.goto(revokedLink);
    await recipientPage
      .getByRole('button', {
        name: 'Sign in to accept invitation',
        exact: true,
      })
      .click();
    await expect(recipientPage.getByRole('alert')).toBeVisible();
    await recipientPage.getByLabel('Invitation code', { exact: true }).fill('');
    for (const theme of ['light', 'dark']) {
      await recipientPage.evaluate(
        (theme) => (document.documentElement.dataset.theme = theme),
        theme,
      );
      await auditAccessibility(recipientPage, `invitation-revoked-${theme}`);
    }
    await page.setViewportSize({ width: 320, height: 720 });
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
    await page
      .getByRole('button', { name: 'Refresh invitations', exact: true })
      .focus();
    await expect(
      page.getByRole('button', { name: 'Refresh invitations', exact: true }),
    ).toBeFocused();
    await writeFile(
      `${evidenceDirectory}/invitations-browser.json`,
      JSON.stringify(
        {
          status: 'passed',
          sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], {
            encoding: 'utf8',
          }).trim(),
          recordedAt: new Date().toISOString(),
          checks: [
            'copyable fragment link without SMTP',
            'browser removes invitation fragment',
            'link absent after creator reload',
            'separate OIDC browser and pending inviter confirmation',
            'no principal or grants before confirmation',
            'reviewed exact identity and grant ceiling',
            'invited sign-in receives only intended grants',
            'direct unauthorized invitation reads and writes denied',
            'CSRF and origin denial',
            'revoked link denied',
            'offline form preservation',
            'light and dark accessibility',
            'keyboard controls and 320 pixel reflow',
          ],
          limits: [
            'Human screen-reader walkthrough remains unperformed.',
            'District and school invitation scopes require their owning verified resource tasks.',
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    setSubject('administrator');
    await recipient.close();
  }
}

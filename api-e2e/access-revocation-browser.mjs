import { evidenceSecurity } from './evidence-security.mjs';
import { expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { changeApplicationAccess } from '../deployment/bootstrap/application-access.mjs';
import {
  qualificationBrowserStep,
  qualificationSignIn,
} from './qualification-sign-in.mjs';

export async function qualifyAccessRevocationBrowser({
  browser,
  publicOrigin,
  migrator,
  setSubject,
  auditAccessibility,
  evidenceDirectory,
}) {
  const context = await evidenceSecurity.newContext(browser, {
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 900 },
    reducedMotion: 'reduce',
  });
  try {
    setSubject('administrator');
    const invitations = await context.newPage();
    await qualificationSignIn(
      invitations,
      publicOrigin,
      evidenceDirectory,
      'access-revocation',
    );
    const session = await (
      await context.request.get(`${publicOrigin}/api/auth/session`)
    ).json();
    evidenceSecurity.register('csrf-token', session.csrfToken);
    const target = (
      await (
        await context.request.get(`${publicOrigin}/api/platform-users`)
      ).json()
    ).items.find((item) => item.id !== session.identity.id && item.enabled);
    expect(target).toBeTruthy();
    const label = invitations.getByRole('textbox', {
      name: 'Recipient label',
      exact: true,
    });
    await qualificationBrowserStep(
      invitations,
      publicOrigin,
      evidenceDirectory,
      'access-revocation-invitation',
      async () => {
        await invitations.goto(`${publicOrigin}/invitations`);
        await label.fill('Recoverable unsent invitation');
      },
    );
    const access = await context.newPage();
    await access.goto(`${publicOrigin}/platform-users`);
    await access
      .locator(`[data-principal-id="${target.id}"]`)
      .getByRole('button')
      .click();
    const grant = access.getByRole('checkbox', {
      name: 'Read security events',
      exact: true,
    });
    await grant.check();
    await access
      .getByRole('button', { name: 'Review access changes', exact: true })
      .click();
    await access
      .getByRole('checkbox', {
        name: 'I reviewed this identity and its exact access changes.',
        exact: true,
      })
      .check();
    await expect(
      access.getByRole('button', {
        name: 'Confirm access changes',
        exact: true,
      }),
    ).toBeEnabled();
    const changeVersion = async () => {
      const principal = (
        await migrator.query(
          'SELECT issuer,permission_version FROM cc.application_principals WHERE id=$1',
          [session.identity.id],
        )
      ).rows[0];
      await changeApplicationAccess(
        migrator,
        {
          action: 'confirm-platform-administrator',
          principalId: session.identity.id,
          expectedVersion: principal.permission_version,
          confirmation: 'grant-platform-administrator',
        },
        principal.issuer,
        3,
      );
    };
    await changeVersion();
    await invitations
      .getByRole('button', { name: 'Refresh invitations', exact: true })
      .click();
    await expect(
      invitations.getByRole('region', { name: 'Restore application access' }),
    ).toBeVisible();
    await expect(
      invitations
        .getByRole('alert')
        .filter({ hasText: 'Your application access changed.' }),
    ).toBeVisible();
    await access
      .getByRole('button', { name: 'Refresh platform users', exact: true })
      .click();
    await expect(
      access.getByRole('region', { name: 'Restore application access' }),
    ).toBeVisible();
    await expect(grant).toBeChecked();
    await expect(grant).toBeDisabled();
    await expect(
      access.getByRole('heading', {
        name: 'Confirm access changes',
        exact: true,
      }),
    ).toHaveCount(0);
    await auditAccessibility(access, 'access-revocation-interrupted');
    await evidenceSecurity.screenshot(access, {
      path: `${evidenceDirectory}/access-revocation-interrupted.png`,
      fullPage: true,
    });
    const signIn = async (page) => {
      const popupPromise = context.waitForEvent('page');
      await page
        .getByRole('link', { name: 'Sign in in another tab', exact: true })
        .click();
      const popup = await popupPromise;
      await expect(
        popup.getByRole('heading', { name: 'Your account', exact: true }),
      ).toBeVisible();
      return popup;
    };
    const popup = await signIn(invitations);
    await invitations
      .getByRole('button', { name: 'Recheck access', exact: true })
      .click();
    await expect(label).toHaveValue('Recoverable unsent invitation');
    await expect(
      invitations.getByRole('button', {
        name: 'Create invitation',
        exact: true,
      }),
    ).toBeDisabled();
    await invitations
      .getByRole('button', { name: 'Refresh invitations', exact: true })
      .click();
    await expect(
      invitations.getByRole('button', {
        name: 'Create invitation',
        exact: true,
      }),
    ).toBeEnabled();
    await access
      .getByRole('button', { name: 'Recheck access', exact: true })
      .click();
    await expect(grant).toBeChecked();
    await expect(
      access.getByRole('button', {
        name: 'Review access changes',
        exact: true,
      }),
    ).toBeDisabled();
    await access
      .getByRole('button', { name: 'Refresh platform users', exact: true })
      .click();
    await access
      .getByRole('button', { name: 'Review access changes', exact: true })
      .click();
    await expect(
      access.getByRole('button', {
        name: 'Confirm access changes',
        exact: true,
      }),
    ).toBeDisabled();
    await popup.close();
    await changeVersion();
    await invitations
      .getByRole('button', { name: 'Refresh invitations', exact: true })
      .click();
    await expect(
      invitations.getByRole('region', { name: 'Restore application access' }),
    ).toBeVisible();
    setSubject(target.subject);
    const other = await signIn(invitations);
    await invitations
      .getByRole('button', { name: 'Recheck access', exact: true })
      .click();
    await expect(
      invitations.getByRole('heading', { name: 'Sign in', exact: true }),
    ).toBeVisible();
    await expect(label).toHaveCount(0);
    await other.close();
    await writeFile(
      `${evidenceDirectory}/access-revocation-browser.json`,
      JSON.stringify(
        {
          status: 'passed',
          sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], {
            encoding: 'utf8',
          }).trim(),
          recordedAt: new Date().toISOString(),
          checks: [
            'stale invitation and access tabs remain open with recoverable values',
            'revocation clears reviewed confirmation and disables changes',
            'separate-tab sign-in restores only the same principal',
            'fresh observations and explicit review required after recovery',
            'different principal closes the previous draft',
            'interrupted state passes automated accessibility',
          ],
          limits: [
            'Human screen-reader validation and school integration remain pending.',
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    setSubject('administrator');
    await evidenceSecurity.close(context);
  }
}

import { evidenceSecurity } from './evidence-security.mjs';
import { qualificationSignIn } from './qualification-sign-in.mjs';
import { expect } from '@playwright/test';

export async function qualifyDevicesBrowser({
  browser,
  auditAccessibility,
  publicOrigin,
  evidenceDirectory,
  setSubject,
}) {
  const context = await evidenceSecurity.newContext(browser, {
    ignoreHTTPSErrors: true,
  });
  try {
    setSubject('administrator');
    const page = await context.newPage();
    await qualificationSignIn(
      page,
      publicOrigin,
      evidenceDirectory,
      'devices-browser',
    );
    await page.getByRole('link', { name: 'Devices' }).click();
    await expect(
      page.getByRole('heading', { name: 'Devices', level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Inventory observation is stale' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Refresh inventory' }).click();
    await expect(
      page.getByText('450 matching devices · 450 in district'),
    ).toBeVisible({ timeout: 120_000 });
    await expect(
      page.getByRole('heading', { name: 'Inventory observation is stale' }),
    ).toHaveCount(0);
    await auditAccessibility(page, 'devices');

    await page.locator('.add-filter').click();
    await page.getByRole('combobox', { name: 'Filter field' }).fill('asset');
    await page.getByRole('option', { name: 'Asset tag', exact: true }).click();
    await page.getByLabel('Operator').selectOption('startsWith');
    await page.getByLabel('Value').fill('HS-04');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(
      page.getByRole('button', {
        name: 'Asset tag starts with: HS-04',
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByText('96 matching devices · 450 in district'),
    ).toBeVisible();

    // Back to devices keeps the header sort and scrolls back to the opened row.
    const assetHeader = page.getByRole('columnheader', { name: 'Asset tag' });
    await assetHeader.click();
    await assetHeader.click();
    await expect(assetHeader).toHaveAttribute('aria-sort', 'descending');
    await page.getByRole('gridcell').first().hover();
    await page.mouse.wheel(0, 20_000);
    await page
      .getByRole('button', { name: 'Open details for C0A1-0001' })
      .click();
    await expect(
      page.getByRole('heading', { name: 'C0A1-0001', level: 1 }),
    ).toBeVisible();
    await page.getByRole('link', { name: 'Back to devices' }).click();
    await expect(
      page.getByRole('columnheader', { name: 'Asset tag' }),
    ).toHaveAttribute('aria-sort', 'descending');
    await expect(
      page.getByRole('button', { name: 'Open details for C0A1-0001' }),
    ).toBeInViewport();

    // Keyboard users open details from the focused details cell (UI-09).
    await page.getByRole('columnheader', { name: 'Serial' }).click();
    await expect(
      page.getByRole('columnheader', { name: 'Serial' }),
    ).toHaveAttribute('aria-sort', 'ascending');
    await page.getByRole('gridcell').first().hover();
    await page.mouse.wheel(0, -20_000);
    await page
      .getByRole('gridcell', { name: 'C0A1-0001', exact: true })
      .click();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Enter');
    await expect(
      page.getByRole('heading', { name: 'C0A1-0001', level: 1 }),
    ).toBeVisible();
    await expect(page.getByText('78% of design capacity')).toBeVisible();
    await expect(page.getByText('Classified by Google')).toBeVisible();
    await auditAccessibility(page, 'device-details');
    await page.getByRole('button', { name: 'Next device' }).click();
    await expect(
      page.getByRole('heading', { name: 'C0A1-0002', level: 1 }),
    ).toBeVisible();
    await page.getByRole('link', { name: 'Back to devices' }).click();
    await expect(
      page.getByRole('button', {
        name: 'Asset tag starts with: HS-04',
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByText('96 matching devices · 450 in district'),
    ).toBeVisible();

    await page.goto(`${publicOrigin}/devices/synthetic-device-9`);
    await expect(
      page.getByRole('heading', { name: 'No battery report' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Next device' }),
    ).toBeDisabled();
    return [
      'devices page refreshes a stale inventory and shows counts: pass',
      'Back to devices keeps the header sort and scrolls to the opened row: pass',
      'keyboard Enter on the details cell opens device details: pass',
      'typed asset tag filter narrows the grid and keeps its chip after details: pass',
      'device details show Google battery health and follow the filtered order: pass',
      'deep-linked device without battery reports names the power-status policy: pass',
    ];
  } finally {
    await context.close();
  }
}

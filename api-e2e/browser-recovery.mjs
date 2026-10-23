import {
  navigateAfterNetworkChange,
  reloadAfterNetworkChange,
} from './navigation-fixture.mjs';
import { qualificationBrowserStep } from './qualification-sign-in.mjs';

// Playwright budgets a navigation and an action at 30 s. A recovery must not
// shorten a wait that passed before the recovery wrapped it.
const navigationTimeoutMs = 30000;
const actionTimeoutMs = 30000;
// The settings field assertion after a reload uses 15 s. The ready check
// stands in for the first part of that assertion.
const settingsViewTimeoutMs = 15000;

/**
 * Reload the customer settings page and recover a reload that an installation
 * network change aborts. The ready check waits for the settings field, so a
 * reload that leaves the document blank fails the attempt instead of passing.
 * The load keeps the Playwright navigation budget.
 */
export function reloadCustomerSettings(page, options = {}) {
  return reloadAfterNetworkChange(page, {
    ...options,
    timeoutMs: navigationTimeoutMs + settingsViewTimeoutMs,
    loadTimeoutMs: navigationTimeoutMs,
    ready: () =>
      page.getByLabel('Customer display name').waitFor({
        state: 'visible',
        timeout: settingsViewTimeoutMs,
      }),
  });
}

/**
 * Open the platform users page and click the access button of one principal.
 * A network change that aborts the navigation or a request of the page starts
 * the navigation again. The navigation and the click keep the Playwright
 * budgets, and the click waits for the row that it needs. A final failure
 * writes the page URL, the document state, the console errors, and the failed
 * requests.
 */
export function openPlatformUsers(
  page,
  { publicOrigin, principalId, evidenceDirectory, label },
) {
  const rowButton = page
    .locator(`[data-principal-id="${principalId}"]`)
    .getByRole('button');
  return qualificationBrowserStep(
    page,
    publicOrigin,
    evidenceDirectory,
    label,
    async () => {
      await navigateAfterNetworkChange(page, `${publicOrigin}/platform-users`, {
        timeoutMs: navigationTimeoutMs + actionTimeoutMs,
        loadTimeoutMs: navigationTimeoutMs,
        ready: () =>
          rowButton.waitFor({ state: 'visible', timeout: actionTimeoutMs }),
      });
      await rowButton.click({ timeout: actionTimeoutMs });
    },
    // The navigation helper recovers the network change. A step retry would
    // multiply the navigation attempts and the recovery records.
    { retryOnNetworkChange: false },
  );
}

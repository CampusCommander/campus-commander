import {
  navigateAfterNetworkChange,
  reloadAfterNetworkChange,
} from './navigation-fixture.mjs';
import { qualificationBrowserStep } from './qualification-sign-in.mjs';

// A page load waits for the first visible view of the application. The
// application budgets 5 s for each boot request, and a lazy route chunk has no
// timeout, so the bound is larger than the boot path it waits for.
const pageViewTimeoutMs = 15000;

/**
 * Reload the customer settings page and recover a reload that an installation
 * network change aborts. The ready check waits for the settings field, so a
 * reload that leaves the document blank fails the attempt instead of passing.
 */
export function reloadCustomerSettings(page, options = {}) {
  return reloadAfterNetworkChange(page, {
    ...options,
    ready: () =>
      page
        .getByLabel('Customer display name')
        .waitFor({ state: 'visible', timeout: pageViewTimeoutMs }),
  });
}

/**
 * Open the platform users page and click the access button of one principal.
 * A network change that aborts the navigation or a request of the page starts
 * the navigation again. A final failure writes the page URL, the document
 * state, the console errors, and the failed requests.
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
        ready: () =>
          rowButton.waitFor({ state: 'visible', timeout: pageViewTimeoutMs }),
      });
      await rowButton.click();
    },
    // The navigation helper recovers the network change. A step retry would
    // multiply the navigation attempts and the recovery records.
    { retryOnNetworkChange: false },
  );
}

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
// The post-restart sign-in wait of the all-Docker qualification uses 15 s.
// The sign-in heading assertion of the auth test used the Playwright default
// of 5 s, and the run of 2026-10-23 expired that budget after the test paused
// and resumed PostgreSQL and Redis.
const signInViewTimeoutMs = 15000;

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
 * Open the sign-in page and recover a navigation that an installation network
 * change aborts. The ready check waits for the sign-in heading, so a document
 * that loads without a sign-in view fails the attempt instead of passing. The
 * navigation keeps the Playwright navigation budget, and the ready check keeps
 * the 15 s budget of the post-restart sign-in wait.
 */
export function openSignInPage(
  page,
  { publicOrigin, evidenceDirectory, label },
) {
  const heading = page.getByRole('heading', { name: 'Sign in', exact: true });
  return qualificationBrowserStep(
    page,
    publicOrigin,
    evidenceDirectory,
    label,
    async () => {
      await navigateAfterNetworkChange(page, publicOrigin, {
        timeoutMs: navigationTimeoutMs + signInViewTimeoutMs,
        loadTimeoutMs: navigationTimeoutMs,
        // The sign-in page reads the session and answers 401 before it renders
        // the heading. That status is not a server failure, and it must not
        // suppress the recovery of a network change in the same attempt.
        ignoreHttpStatuses: [401],
        ready: () =>
          heading.waitFor({ state: 'visible', timeout: signInViewTimeoutMs }),
      });
    },
    // The navigation helper recovers the network change. A step retry would
    // multiply the navigation attempts and the recovery records.
    { retryOnNetworkChange: false },
  );
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

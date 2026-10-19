import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { expect } from '@playwright/test';
import {
  isNetworkChangeRequest,
  requestFailureErrorText,
} from './network-change.mjs';

const stepAttemptLimit = 3;
const attemptEventLimit = 100;
// A failed navigation makes the browser commit its own error page. The commit
// arrives as a navigation of its own, and it interrupts a navigation that
// starts before it.
const errorPageInterruption =
  'is interrupted by another navigation to "chrome-error://chromewebdata/"';
const pendingNavigationTimeoutMs = 1000;
// A sign-in navigation that does not commit within this bound counts as a
// failed attempt. An installation network change can leave a sign-in
// navigation without an answer, and the sign-in flow must start again.
const signInNavigationTimeoutMs = 10000;
const unfinishedSignInNavigation = 'the sign-in navigation did not commit';
const missingSignInNavigation = 'the sign-in navigation did not start';

/** Build the failure of a sign-in navigation that did not commit in time. */
const signInNavigationFailure = (url, cause) =>
  new Error(
    `${unfinishedSignInNavigation} within ${signInNavigationTimeoutMs} ms: ${url}`,
    { cause },
  );

/**
 * Build the failure of an activation that started no sign-in navigation. The
 * step does not recover this failure, because the link was absent or not
 * actionable.
 */
const signInNavigationStartFailure = (url, cause) =>
  new Error(
    `${missingSignInNavigation} within ${signInNavigationTimeoutMs} ms: ${url}`,
    { cause },
  );

/** Decide whether an error reports a sign-in navigation that did not commit. */
const isUnfinishedSignInNavigation = (error) =>
  error?.message?.includes(unfinishedSignInNavigation) === true;

/** Decide whether an error reports the timeout of a Playwright action. */
const isActionTimeout = (error) =>
  /Timeout \d+ms exceeded/.test(error?.message ?? '');

/**
 * Run a navigation action that must commit within the sign-in bound. The
 * action starts the navigation with `waitUntil: 'commit'`, so the bound
 * measures the document commit, not the load of its assets. A timeout reports
 * a sign-in navigation that did not commit, so the step can recover the
 * attempt. Every other failure passes through.
 */
const signInNavigation = (url, action) =>
  action.catch((error) => {
    if (!isActionTimeout(error)) throw error;
    throw signInNavigationFailure(url, error);
  });

/**
 * Watch for the navigation request that a sign-in activation starts. The
 * answer is true after a navigation request for the sign-in URL, and false
 * when no such request arrives within the sign-in bound. An activation that
 * fails before the sign-in navigation starts keeps its own failure class.
 */
const signInNavigationStarted = (page, signInUrl) => {
  const watch = page.waitForRequest?.bind(page);
  if (!watch) return Promise.resolve(true);
  return watch(
    (request) =>
      request.isNavigationRequest?.() === true &&
      request.url().startsWith(signInUrl),
    { timeout: signInNavigationTimeoutMs },
  ).then(
    () => true,
    () => false,
  );
};

/**
 * Wait for a pending navigation of the page, so the next action starts from a
 * settled document. The wait ends at the timeout when the page has no pending
 * navigation.
 */
const settlePendingNavigation = async (page) => {
  const wait = page.waitForNavigation?.bind(page);
  if (!wait) return;
  await wait({
    waitUntil: 'commit',
    timeout: pendingNavigationTimeoutMs,
  }).catch(() => null);
};

export async function qualificationSignIn(
  page,
  publicOrigin,
  evidenceDirectory,
  label,
) {
  const signInUrl = `${publicOrigin}/api/auth/login`;
  return qualificationBrowserStep(
    page,
    publicOrigin,
    evidenceDirectory,
    `${label}-sign-in`,
    async () => {
      // The bound covers the document commit. A slow asset does not fail a
      // navigation that committed.
      await signInNavigation(
        signInUrl,
        page.goto(signInUrl, {
          waitUntil: 'commit',
          timeout: signInNavigationTimeoutMs,
        }),
      );
      // The account readiness assertion holds the account view of the
      // committed document.
      await expect(
        page.getByRole('heading', { name: 'Your account', exact: true }),
      ).toBeVisible({ timeout: 15000 });
    },
  );
}

/**
 * Run a sign-in flow that starts at the sign-in link: activate the link and
 * wait for the account heading. A retry loads the origin page first, so the
 * retry runs the flow again from a settled document. An activation whose
 * navigation does not commit within the sign-in bound reports a sign-in
 * navigation that did not commit, and the step recovers the attempt. An
 * activation that fails before the sign-in navigation starts keeps its own
 * failure class. Every other navigation failure keeps its own class.
 * `activate` overrides the link activation, for the screen-reader flow.
 */
export async function qualificationLinkSignIn(
  page,
  publicOrigin,
  evidenceDirectory,
  label,
  {
    activate = (control) =>
      control.click({ timeout: signInNavigationTimeoutMs }),
  } = {},
) {
  const signInUrl = `${publicOrigin}/api/auth/login`;
  const accountHeading = () =>
    page.getByRole('heading', { name: 'Your account', exact: true });
  let run = 0;
  return qualificationBrowserStep(
    page,
    publicOrigin,
    evidenceDirectory,
    `${label}-sign-in`,
    async () => {
      run++;
      if (run > 1) {
        // The retry starts from the origin page. The bound covers the
        // document commit, so a slow asset does not fail the retry.
        await signInNavigation(
          publicOrigin,
          page.goto(publicOrigin, {
            waitUntil: 'commit',
            timeout: signInNavigationTimeoutMs,
          }),
        );
        // A failed attempt can finish the sign-in on the server. The origin
        // page then answers with the account view.
        const signedIn = await accountHeading()
          .waitFor({ state: 'visible', timeout: 3000 })
          .then(
            () => true,
            () => false,
          );
        if (signedIn) return;
      }
      // The activation starts the sign-in navigation. The wait started before
      // the activation reports the commit of that navigation. The request
      // watch holds the evidence that the sign-in navigation started.
      const commit = page.waitForNavigation
        ? page
            .waitForNavigation({
              waitUntil: 'commit',
              timeout: signInNavigationTimeoutMs,
            })
            .then(
              () => null,
              (error) => error,
            )
        : Promise.resolve(null);
      const started = signInNavigationStarted(page, signInUrl);
      let activationFailure = null;
      await activate(
        page.getByRole('link', {
          name: 'Sign in to Campus Commander',
          exact: true,
        }),
      ).catch((error) => {
        activationFailure = error;
      });
      const navigationFailure = await commit;
      const navigationStarted = await started;
      if (navigationFailure) {
        if (!isActionTimeout(navigationFailure)) throw navigationFailure;
        // A commit that the bound ends is a sign-in navigation without a
        // commit only after the sign-in navigation started. Every other case
        // keeps the activation failure.
        if (!navigationStarted)
          throw (
            activationFailure ??
            signInNavigationStartFailure(signInUrl, navigationFailure)
          );
        throw signInNavigationFailure(
          signInUrl,
          activationFailure ?? navigationFailure,
        );
      }
      if (activationFailure) throw activationFailure;
      await accountHeading().waitFor({ state: 'visible', timeout: 15000 });
    },
  );
}

/**
 * Run a browser step and recover an action that an installation network
 * change aborts.
 *
 * When the action fails, and a request failed with ERR_NETWORK_CHANGED during
 * that attempt, the step runs the action again. An attempt that the error page
 * of an earlier failed navigation interrupts is recoverable in the same way.
 * An attempt that a sign-in navigation without a commit ends is recoverable in
 * the same way, and the next attempt starts after the pending navigation
 * settles. The step runs the action at most three times. An HTTP error status
 * fails the attempt at once, even when the same attempt saw a network change.
 * Every other failure fails at once. A final failure writes a record with the
 * events of every attempt. A passing step reports every recovered attempt with
 * its failed request routes, the attempts of a nested reload helper included.
 * A caller passes `retryOnNetworkChange: false` when the action must not run
 * again, or when another helper already recovers the action.
 */
export async function qualificationBrowserStep(
  page,
  publicOrigin,
  evidenceDirectory,
  label,
  action,
  { retryOnNetworkChange = true } = {},
) {
  const events = [];
  const recoveries = [];
  let attempt = 0;
  let attemptEventCount = 0;
  let attemptNetworkChange = false;
  let attemptRoutes = [];
  let attemptHttpError = null;
  const record = (event) => {
    if (attemptEventCount < attemptEventLimit) {
      attemptEventCount++;
      events.push(event);
    }
  };
  const resource = (url) => {
    const parsed = new URL(url);
    return {
      local: parsed.origin === publicOrigin,
      route: parsed.pathname.startsWith('/api/auth/')
        ? 'authentication'
        : parsed.pathname.endsWith('.js')
          ? 'script'
          : parsed.pathname.startsWith('/api/google-connection')
            ? 'connection-api'
            : parsed.pathname.startsWith('/api/customer')
              ? 'customer-api'
              : parsed.pathname === '/google-connection'
                ? 'connection-page'
                : parsed.pathname === '/invitations'
                  ? 'invitations-page'
                  : parsed.pathname === '/'
                    ? 'application-root'
                    : parsed.pathname === '/account'
                      ? 'account'
                      : 'other',
    };
  };
  const failed = (request) => {
    const target = resource(request.url());
    if (isNetworkChangeRequest(request)) {
      attemptNetworkChange = true;
      attemptRoutes.push(target.route);
    }
    record({
      kind: 'request-failed',
      ...target,
      error:
        requestFailureErrorText(request).match(/ERR_[A-Z_]+/)?.[0] ??
        'unclassified',
    });
  };
  const response = (value) => {
    const status = value.status();
    if (status >= 400 && !attemptHttpError)
      attemptHttpError = { status, url: value.url() };
    if (
      value.request().isNavigationRequest() ||
      status >= 400 ||
      new URL(value.url()).pathname.startsWith('/api/')
    )
      record({
        kind: 'response',
        ...resource(value.url()),
        status,
      });
  };
  const pageError = (error) =>
    record({
      kind: 'page-error',
      codes: error.message
        .match(
          /\b(?:NG[0-9]{4}|TypeError|ReferenceError|SyntaxError|RangeError|URIError|EvalError|AggregateError|Error)\b/g,
        )
        ?.slice(0, 10) ?? ['unclassified'],
    });
  page.on('requestfailed', failed);
  page.on('response', response);
  page.on('pageerror', pageError);
  try {
    let failure = null;
    for (attempt = 1; attempt <= stepAttemptLimit; attempt++) {
      attemptEventCount = 0;
      attemptNetworkChange = false;
      attemptRoutes = [];
      attemptHttpError = null;
      try {
        await action();
        if (attemptNetworkChange)
          // A nested helper recovered the action. The step reports the routes
          // of that recovery, though the step ran the action once.
          recoveries.push({ attempt, routes: [...new Set(attemptRoutes)] });
        if (recoveries.length > 0) {
          const routes = [
            ...new Set(recoveries.flatMap((recovery) => recovery.routes)),
          ];
          console.log(
            `${label}: recovered from a network change after ${attempt} attempts, failed request routes: ${routes.join(', ')}`,
          );
        }
        return { attempts: attempt, recoveries };
      } catch (error) {
        if (attemptHttpError) {
          // A server failure fails the attempt at once, even when the same
          // attempt also saw a network change. The failure record holds the
          // response event and the request event of the attempt.
          failure = new Error(
            `${error.message}. The page answered HTTP ${attemptHttpError.status} for ${attemptHttpError.url}`,
            { cause: error },
          );
          break;
        }
        failure = error;
        const interruption =
          error?.message?.includes(errorPageInterruption) === true;
        const unfinished = isUnfinishedSignInNavigation(error);
        if (
          !retryOnNetworkChange ||
          (!attemptNetworkChange && !interruption && !unfinished) ||
          attempt === stepAttemptLimit
        )
          break;
        const routes = [...new Set(attemptRoutes)];
        recoveries.push({ attempt, routes });
        events.push({
          kind: interruption
            ? 'error-page-interruption'
            : unfinished
              ? 'pending-sign-in-navigation'
              : 'network-change-retry',
          attempt,
          routes,
        });
        await settlePendingNavigation(page);
      }
    }
    const documentState = await Promise.race([
      page
        .evaluate(() => ({
          readyState: document.readyState,
          applicationChildren:
            document.querySelector('app-root')?.childElementCount ?? 0,
          headings: document.querySelectorAll('h1').length,
          busyRegions: document.querySelectorAll('[aria-busy="true"]').length,
          alerts: document.querySelectorAll('[role="alert"]').length,
        }))
        .catch(() => null),
      delay(1000, null, { ref: false }),
    ]);
    await writeFile(
      `${evidenceDirectory}/${label}-failure.json`,
      JSON.stringify(
        {
          schemaVersion: 1,
          finalLocation: resource(page.url()),
          documentState,
          events,
        },
        null,
        2,
      ),
    );
    throw failure;
  } finally {
    page.off('requestfailed', failed);
    page.off('response', response);
    page.off('pageerror', pageError);
  }
}

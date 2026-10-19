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
/** The default hook of a step call that needs no preparation or check. */
const noOperation = async () => undefined;

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
 * Wait for the first visible view of the committed origin document. The
 * candidates are name and locator pairs. The answer is the name of the first
 * visible view, or `none` when no view becomes visible within the bound. A
 * view that stays hidden does not end the wait of another view.
 */
const firstVisibleView = (candidates, timeout) => {
  const first = new Promise((resolve) => {
    let pending = candidates.length;
    let answered = false;
    const answer = (view) => {
      if (answered) return;
      answered = true;
      resolve(view);
    };
    for (const [view, locator] of candidates)
      locator.waitFor({ state: 'visible', timeout }).then(
        () => answer(view),
        () => {
          pending -= 1;
          if (pending === 0) answer('none');
        },
      );
  });
  return Promise.race([first, delay(timeout, 'none', { ref: false })]);
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

/**
 * Start the request watch and the commit watch of a sign-in activation. The
 * request watch holds the evidence that the sign-in navigation started, and
 * it records the request time. The commit watch settles on the first
 * document commit after it starts. Neither watch has a timeout, because the
 * activation preparation can outlast the commit bound. The caller bounds
 * both waits.
 */
const signInWatches = (page, signInUrl) => {
  const state = { startedAt: null, navigationStartSeen: false };
  const started = (
    page.waitForRequest
      ? page.waitForRequest(
          (request) =>
            request.isNavigationRequest?.() === true &&
            request.url().startsWith(signInUrl),
          { timeout: 0 },
        )
      : Promise.resolve(true)
  ).then(
    () => {
      state.navigationStartSeen = true;
      state.startedAt = Date.now();
      return true;
    },
    () => false,
  );
  const commit = { settled: false, error: null };
  const watch = (
    page.waitForNavigation
      ? page.waitForNavigation({ waitUntil: 'commit', timeout: 0 })
      : Promise.resolve()
  ).then(
    () => {
      commit.settled = true;
    },
    (error) => {
      commit.settled = true;
      commit.error = error;
    },
  );
  return { state, started, commit, watch };
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
 * retry runs the flow again from a settled document. The retry waits for the
 * account view or the sign-in view, so a slow account document is not
 * mistaken for the sign-in page. An activation whose navigation does not
 * commit within the sign-in bound reports a sign-in navigation that did not
 * commit, and the step recovers the attempt. An activation that fails before
 * the sign-in navigation starts keeps its own failure class. Every other
 * navigation failure keeps its own class.
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
  const signInLink = () =>
    page.getByRole('link', {
      name: 'Sign in to Campus Commander',
      exact: true,
    });
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
        // page then answers with the account view, after its own readiness
        // budget. The sign-in view is the other possible answer.
        const view = await firstVisibleView(
          [
            ['account', accountHeading()],
            ['sign-in', signInLink()],
          ],
          15000,
        );
        if (view === 'account') return;
      }
      // Both watches start before the activation, so an immediate navigation
      // is observed. Neither watch has a timeout, because activation
      // preparation can outlast the commit bound and is not a navigation
      // failure. The request watch holds the evidence that the sign-in
      // navigation started.
      const {
        state,
        started,
        commit,
        watch: commitWatch,
      } = signInWatches(page, signInUrl);
      let activationFailure = null;
      await activate(signInLink()).catch((error) => {
        activationFailure = error;
      });
      // A failed activation that started no sign-in navigation keeps its own
      // failure class. The step does not recover it, because the link was
      // absent or not actionable. A click that ends at its timeout while the
      // sign-in navigation is pending is an unfinished navigation, not an
      // absent link. A failed activation needs only a short wait for a start
      // that the failure may have raced.
      const navigationStarted = state.navigationStartSeen
        ? true
        : await Promise.race([
            started,
            delay(
              activationFailure
                ? pendingNavigationTimeoutMs
                : signInNavigationTimeoutMs,
              false,
              { ref: false },
            ),
          ]);
      if (activationFailure && !navigationStarted) throw activationFailure;
      if (!navigationStarted) throw signInNavigationStartFailure(signInUrl);
      // The activation preparation is not part of the commit bound. The
      // bound starts when the sign-in navigation request arrives.
      if (!commit.settled) {
        const remaining =
          signInNavigationTimeoutMs - (Date.now() - state.startedAt);
        await Promise.race([
          commitWatch,
          delay(Math.max(0, remaining), null, { ref: false }),
        ]);
      }
      if (!commit.settled) throw signInNavigationFailure(signInUrl);
      if (commit.error) {
        if (!isActionTimeout(commit.error)) throw commit.error;
        throw signInNavigationFailure(signInUrl, commit.error);
      }
      // An activation error after the commit keeps its own failure class.
      if (activationFailure) throw activationFailure;
      await accountHeading().waitFor({ state: 'visible', timeout: 15000 });
    },
  );
}

/**
 * Run a sign-in flow whose login response the caller holds.
 *
 * The step holds the response of the sign-in route, activates the link,
 * runs the caller's progress check while the response is held, releases the
 * response, and bounds the navigation commit from the release. A commit
 * that does not arrive inside the bound reports a sign-in navigation that
 * did not commit, and the step recovers the attempt. A retry loads the
 * origin page first, so a failed attempt that finished the sign-in is
 * detected before another activation. A failure after the commit keeps its
 * own class.
 * `prepare` installs the observation of the current document. `observe`
 * runs the progress check before the release.
 * Each attempt owns its hold. A failed attempt releases the hold and waits
 * for its intercepted request to settle before the step retries the flow
 * or removes the route. The wait keeps the failed progress assertion, and
 * it keeps a rejected route handler out of the failure path.
 */
export async function qualificationHeldSignIn(
  page,
  publicOrigin,
  evidenceDirectory,
  label,
  { prepare = noOperation, observe = noOperation } = {},
) {
  const signInUrl = `${publicOrigin}/api/auth/login`;
  const holdPattern = '**/api/auth/login';
  const accountHeading = () =>
    page.getByRole('heading', { name: 'Your account', exact: true });
  const signInLink = () =>
    page.getByRole('link', {
      name: 'Sign in to Campus Commander',
      exact: true,
    });
  // The route stays installed across attempts, because page.unroute waits
  // for a pending navigation. The retry origin navigation cancels that
  // navigation first.
  const hold = { attempt: null };
  const releaseHold = (attempt) => {
    attempt.released = true;
    attempt.release.resolve();
    if (attempt.continued === attempt.intercepted) attempt.settled.resolve();
  };
  const continueRoute = async (intercepted) => {
    try {
      await intercepted.continue();
    } catch {
      // page.unroute continues an in-flight route itself, and it marks the
      // route handled. A continue that races the removal reports that state.
    }
  };
  const holdResponse = async (intercepted) => {
    const attempt = hold.attempt;
    // A request that races the first attempt passes without a hold.
    if (!attempt) {
      await continueRoute(intercepted);
      return;
    }
    attempt.intercepted += 1;
    try {
      await attempt.release.promise;
      await continueRoute(intercepted);
    } finally {
      attempt.continued += 1;
      if (attempt.released && attempt.continued === attempt.intercepted)
        attempt.settled.resolve();
    }
  };
  let run = 0;
  let completed = false;
  await page.route(holdPattern, holdResponse);
  try {
    const result = await qualificationBrowserStep(
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
          // A failed attempt can finish the sign-in on the server. The
          // origin page then answers with the account view, after its own
          // readiness budget. The sign-in view is the other possible answer.
          const view = await firstVisibleView(
            [
              ['account', accountHeading()],
              ['sign-in', signInLink()],
            ],
            15000,
          );
          if (view === 'account') return;
        }
        await prepare();
        const attempt = {
          release: Promise.withResolvers(),
          released: false,
          intercepted: 0,
          continued: 0,
          settled: Promise.withResolvers(),
        };
        hold.attempt = attempt;
        try {
          const {
            state,
            started,
            commit,
            watch: commitWatch,
          } = signInWatches(page, signInUrl);
          // The click cannot be awaited before the release, because the hold
          // keeps its navigation pending.
          const activation = { failure: null };
          const click = signInLink()
            .click({ timeout: signInNavigationTimeoutMs })
            .then(
              () => undefined,
              (error) => {
                activation.failure = error;
              },
            );
          let navigationStarted = state.navigationStartSeen;
          if (!navigationStarted) {
            const outcome = await Promise.race([
              started,
              click.then(() =>
                delay(pendingNavigationTimeoutMs, activation, { ref: false }),
              ),
              delay(signInNavigationTimeoutMs, null, { ref: false }),
            ]);
            navigationStarted = outcome === true;
            // A failed activation that started no sign-in navigation keeps
            // its own failure class.
            if (!navigationStarted && activation.failure)
              throw activation.failure;
          }
          if (!navigationStarted) throw signInNavigationStartFailure(signInUrl);
          // The progress check runs while the route holds the response.
          await observe();
          // The bound starts at the release, because the hold is not part of
          // the navigation.
          const releasedAt = Date.now();
          releaseHold(attempt);
          if (!commit.settled) {
            const remaining =
              signInNavigationTimeoutMs - (Date.now() - releasedAt);
            await Promise.race([
              commitWatch,
              delay(Math.max(0, remaining), null, { ref: false }),
            ]);
          }
          if (!commit.settled) throw signInNavigationFailure(signInUrl);
          if (commit.error) {
            if (!isActionTimeout(commit.error)) throw commit.error;
            throw signInNavigationFailure(signInUrl, commit.error);
          }
          await accountHeading().waitFor({ state: 'visible', timeout: 15000 });
        } finally {
          hold.attempt = null;
          releaseHold(attempt);
          // page.unroute continues an in-flight route itself, and it marks
          // the route handled. Settle the owned route before that removal.
          if (attempt.continued < attempt.intercepted)
            await Promise.race([
              attempt.settled.promise,
              delay(pendingNavigationTimeoutMs, null, { ref: false }),
            ]);
        }
      },
    );
    completed = true;
    return result;
  } finally {
    // A failed observation must not leave an attempt parked.
    const attempt = hold.attempt;
    hold.attempt = null;
    if (attempt) releaseHold(attempt);
    if (completed) await page.unroute(holdPattern);
    else {
      // A stalled navigation keeps page.unroute pending. Bound the wait.
      await Promise.race([
        page.unroute(holdPattern).catch(() => null),
        delay(pendingNavigationTimeoutMs, null, { ref: false }),
      ]);
    }
  }
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

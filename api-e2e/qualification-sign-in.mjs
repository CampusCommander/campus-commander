import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { expect } from '@playwright/test';
import {
  isNetworkChangeRequest,
  requestFailureErrorText,
} from './network-change.mjs';

const stepAttemptLimit = 3;
const attemptEventLimit = 100;

export async function qualificationSignIn(
  page,
  publicOrigin,
  evidenceDirectory,
  label,
) {
  return qualificationBrowserStep(
    page,
    publicOrigin,
    evidenceDirectory,
    `${label}-sign-in`,
    async () => {
      await page.goto(`${publicOrigin}/api/auth/login`);
      await expect(
        page.getByRole('heading', { name: 'Your account', exact: true }),
      ).toBeVisible({ timeout: 15000 });
    },
  );
}

/**
 * Run a browser step and recover an action that an installation network
 * change aborts.
 *
 * When the action fails, and a request failed with ERR_NETWORK_CHANGED during
 * that attempt, the step runs the action again. The step runs the action at
 * most three times. An HTTP error status fails the attempt at once, even when
 * the same attempt saw a network change. Every other failure fails at once. A
 * final failure writes a record with the events of every attempt. A passing
 * step reports every recovered attempt with its failed request routes, the
 * attempts of a nested reload helper included. A caller passes
 * `retryOnNetworkChange: false` when the action must not run again, or when
 * another helper already recovers the action.
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
        if (
          !retryOnNetworkChange ||
          !attemptNetworkChange ||
          attempt === stepAttemptLimit
        )
          break;
        const routes = [...new Set(attemptRoutes)];
        recoveries.push({ attempt, routes });
        events.push({ kind: 'network-change-retry', attempt, routes });
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

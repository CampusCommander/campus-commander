import { setTimeout } from 'node:timers/promises';
import {
  isNetworkChangeReloadError,
  isNetworkChangeRequest,
  requestFailureErrorText,
} from './network-change.mjs';

const reloadAttemptLimit = 3;

const createAttempt = () => {
  let decide;
  const decided = new Promise((resolve) => {
    decide = resolve;
  });
  const attempt = {
    outcome: null,
    httpError: null,
    decided,
    observe(outcome) {
      if (attempt.outcome) return;
      attempt.outcome = outcome;
      decide(outcome);
    },
    override(outcome) {
      attempt.outcome = outcome;
      decide(outcome);
    },
  };
  return attempt;
};

/** Build the failure of an attempt that recorded an HTTP error status. */
const httpErrorFailure = ({ status, url }, cause) =>
  new Error(`page.reload: HTTP ${status} for ${url}`, { cause });

/** Read the HTTP error status of a page response. */
const httpErrorStatus = (response) => {
  const status = response?.status?.();
  return Number.isFinite(status) && status >= 400 ? status : null;
};

/**
 * Reload a page and recover a reload that an installation network change
 * aborts.
 *
 * A request of the page that fails with ERR_NETWORK_CHANGED after a reload
 * starts, and before the page is ready, starts another reload. The optional
 * `ready` function reports that the page reached the state the caller needs.
 * Without `ready`, a resolved reload is ready. The helper observes every
 * response of the page for the whole attempt, the reload and the ready wait
 * included. An HTTP error status of the page, or of a request of the page,
 * ends a failed attempt at once, and that attempt never retries. A passing
 * ready decides the attempt, with or without a recorded HTTP error. A reload
 * error other than a network change fails at once. A request failure with
 * another error code does not decide the attempt, because a reload cancels the
 * in-flight requests of the previous page. No attempt starts after the
 * deadline `timeoutMs`, the first attempt included.
 */
export async function reloadAfterNetworkChange(
  page,
  { retryDelayMs = 250, timeoutMs = 15000, ready } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let networkChanges = 0;
  let previousError = null;
  let attempt = null;
  const expired = () => !Number.isFinite(deadline) || Date.now() >= deadline;
  const deadlineError = () =>
    previousError ??
    new Error(
      Number.isFinite(timeoutMs)
        ? `page.reload: the ${timeoutMs} ms timeout expired before a reload started`
        : `page.reload: invalid timeoutMs ${timeoutMs}`,
    );

  const onRequestFailed = (request) => {
    if (!attempt) return;
    // Only a network change decides the attempt. Every other request failure,
    // such as the ERR_ABORTED cancellation of an in-flight request, keeps the
    // behavior of the reload helper before this change: the reload result and
    // the ready function decide.
    if (!isNetworkChangeRequest(request)) return;
    attempt.observe({
      retry: true,
      error: new Error(
        `page request failed: ${requestFailureErrorText(request)} for ${request.url?.() ?? 'unknown URL'}`,
      ),
    });
  };

  // The active attempt records every response of the page for the whole
  // attempt, the reload and the ready wait included. An attempt that fails
  // with such a record fails at once, and that attempt never retries.
  const onResponse = (response) => {
    if (!attempt || attempt.httpError) return;
    const status = httpErrorStatus(response);
    if (status === null) return;
    attempt.httpError = { status, url: response.url?.() ?? 'unknown URL' };
  };

  const listening =
    typeof page.on === 'function' && typeof page.off === 'function';
  if (listening) {
    page.on('requestfailed', onRequestFailed);
    page.on('response', onResponse);
  }
  try {
    for (
      let attemptNumber = 1;
      attemptNumber <= reloadAttemptLimit;
      attemptNumber++
    ) {
      if (attemptNumber > 1) {
        const remaining = Number.isFinite(deadline) ? deadline - Date.now() : 0;
        await setTimeout(Math.min(retryDelayMs, Math.max(0, remaining)));
      }
      if (expired()) throw deadlineError();
      const current = createAttempt();
      attempt = current;
      let response = null;
      try {
        response = await page.reload({
          timeout: Math.max(1, deadline - Date.now()),
        });
      } catch (error) {
        if (!isNetworkChangeReloadError(error)) throw error;
        current.observe({ retry: true, error });
      }
      // The document response of the reload belongs to the attempt. An HTTP
      // error status there ends the attempt at once.
      if (httpErrorStatus(response) !== null)
        current.override({
          retry: false,
          error: httpErrorFailure({
            status: response.status(),
            url: response.url(),
          }),
        });
      let outcome = current.outcome;
      if (!outcome && ready)
        outcome = await Promise.race([
          current.decided,
          Promise.resolve()
            .then(() => ready())
            .then(
              () => null,
              (error) => ({ retry: false, error }),
            ),
        ]);
      if (!outcome) return { attempts: attemptNumber, networkChanges };
      // A retry hides the server failure of the attempt. An HTTP error status
      // recorded in the attempt, from the reload or the ready wait, ends it at
      // once. The ready function decides a passing attempt.
      if (current.httpError)
        outcome = {
          retry: false,
          error: httpErrorFailure(current.httpError, outcome.error),
        };
      if (!outcome.retry) throw outcome.error;
      if (attemptNumber === reloadAttemptLimit || Date.now() >= deadline)
        throw outcome.error;
      networkChanges++;
      previousError = outcome.error;
    }
  } finally {
    if (listening) {
      page.off('requestfailed', onRequestFailed);
      page.off('response', onResponse);
    }
  }
}

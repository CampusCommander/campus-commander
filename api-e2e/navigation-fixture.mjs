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
    decided,
    observe(outcome) {
      if (attempt.outcome) return;
      attempt.outcome = outcome;
      decide(outcome);
    },
  };
  return attempt;
};

/**
 * Reload a page and recover a reload that an installation network change
 * aborts.
 *
 * A request of the page that fails with ERR_NETWORK_CHANGED after a reload
 * starts, and before the page is ready, starts another reload. The optional
 * `ready` function reports that the page reached the state the caller needs.
 * Without `ready`, a resolved reload is ready. A reload error other than a
 * network change, an HTTP error status, and a failed ready function fail at
 * once. A request failure with another error code does not decide the attempt,
 * because a reload cancels the in-flight requests of the previous page.
 */
export async function reloadAfterNetworkChange(
  page,
  { retryDelayMs = 250, timeoutMs = 15000, ready } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let networkChanges = 0;
  let previousError = null;
  let attempt = null;

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

  const listening =
    typeof page.on === 'function' && typeof page.off === 'function';
  if (listening) page.on('requestfailed', onRequestFailed);
  try {
    for (
      let attemptNumber = 1;
      attemptNumber <= reloadAttemptLimit;
      attemptNumber++
    ) {
      if (attemptNumber > 1) {
        await setTimeout(
          Math.min(retryDelayMs, Math.max(0, deadline - Date.now())),
        );
        if (Date.now() >= deadline) throw previousError;
      }
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
      if (!current.outcome && response?.status?.() >= 400)
        current.observe({
          retry: false,
          error: new Error(
            `page.reload: HTTP ${response.status()} for ${response.url()}`,
          ),
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
      if (!outcome.retry) throw outcome.error;
      if (attemptNumber === reloadAttemptLimit || Date.now() >= deadline)
        throw outcome.error;
      networkChanges++;
      previousError = outcome.error;
    }
  } finally {
    if (listening) page.off('requestfailed', onRequestFailed);
  }
}

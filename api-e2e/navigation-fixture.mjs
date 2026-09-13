import { setTimeout } from 'node:timers/promises';

/** Retry only a page reload interrupted by an installation network change. */
export async function reloadAfterNetworkChange(
  page,
  { retryDelayMs = 250, timeoutMs = 15000 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let networkChanges = 0;
  for (let attempts = 1; attempts <= 3; attempts++) {
    try {
      await page.reload({ timeout: Math.max(1, deadline - Date.now()) });
      return { attempts, networkChanges };
    } catch (error) {
      if (
        !error.message?.includes('net::ERR_NETWORK_CHANGED') ||
        attempts === 3 ||
        Date.now() >= deadline
      )
        throw error;
      networkChanges++;
      await setTimeout(
        Math.min(retryDelayMs, Math.max(0, deadline - Date.now())),
      );
    }
  }
}

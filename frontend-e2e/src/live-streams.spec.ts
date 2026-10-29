import { expect, test } from '@playwright/test';
import { installLiveStreams } from './live-streams';

/**
 * The shared fake holds every stream open, as a real server does. A spec that relies on
 * it must not see a second open after the app's five-second reopen delay, and must be
 * able to send one event, close one stream, and count the open streams by URL path.
 *
 * The app opens its own feeds on this page. The test counts a path of its own, so an app
 * feed never changes the count.
 */
const path = '/api/test/stream';

test('holds a fake stream open past the reopen delay', async ({ page }) => {
  // Every API answer fails, so the app opens no authenticated feed of its own.
  await page.route('**/api/**', (route) =>
    route.fulfill({ status: 404, json: {} }),
  );
  const streams = await installLiveStreams(page);
  await page.goto('/');

  // One stream opens once and records each event that it receives.
  await page.evaluate((url) => {
    const received: string[] = [];
    (window as unknown as { __received: string[] }).__received = received;
    const source = new EventSource(url);
    source.addEventListener('entity-batch', (event) =>
      received.push((event as MessageEvent<string>).data),
    );
  }, path);

  await streams.waitForOpen(path);
  expect(await streams.openCount(path)).toBe(1);
  // The page constructed one stream and no other.
  expect(await streams.constructions()).toEqual([path]);

  // The app replaces a stream that ends after five seconds. The fake must not end it.
  await page.waitForTimeout(5_500);
  expect(await streams.openCount(path)).toBe(1);
  expect(await streams.constructedCount(path)).toBe(1);

  // One event reaches the page's own listener.
  const delivered = await streams.send(path, 'entity-batch', {
    type: 'entity-batch',
  });
  expect(delivered).toBe(1);
  expect(
    await page.evaluate(
      () => (window as unknown as { __received: string[] }).__received,
    ),
  ).toEqual(['{"type":"entity-batch"}']);

  // A closed stream stays closed, and the count drops.
  expect(await streams.close(path)).toBe(1);
  expect(await streams.openCount(path)).toBe(0);
  expect(await streams.constructedCount(path)).toBe(1);
});

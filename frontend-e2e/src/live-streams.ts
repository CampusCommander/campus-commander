/// <reference lib="dom" />
import { type Page } from '@playwright/test';

/**
 * The live event streams of one page, as a real server holds them.
 *
 * Playwright cannot hold an SSE answer open with `route.fulfill`: a complete body ends the
 * connection at once, and the app reopens it after its reopen delay. A spec that runs past
 * that delay then reads the feed again. The fake below replaces `EventSource` before the
 * page loads. Each fake opens once and stays open until a test closes it or the page
 * closes, so no stream ends or reopens without a test asking for it.
 *
 * A test sends one event to a stream, closes a stream, and counts the open streams by URL
 * path.
 */
export interface LiveStreams {
  /** The URL path of every open stream, sorted. A path opened twice appears twice. */
  openUrls(): Promise<string[]>;
  /** The number of open streams for one URL path. */
  openCount(path: string): Promise<number>;
  /** Waits until at least one stream of the URL path is open. */
  waitForOpen(path: string, timeoutMs?: number): Promise<void>;
  /** Sends one event to every open stream of one URL path. Throws when none is open. */
  send(path: string, type: string, data?: unknown): Promise<number>;
  /** Closes every open stream of one URL path. Returns how many closed. */
  close(path: string): Promise<number>;
}

/** The controls that the fake exposes to the test through the page. */
interface StreamControls {
  openUrls(): string[];
  openCount(path: string): number;
  send(path: string, type: string, data: string): number;
  close(path: string): number;
}

const installed = new WeakMap<Page, LiveStreams>();

/**
 * Installs the fake streams on a page and returns the controls. Call it before the page
 * loads, since the fake replaces `EventSource` with an init script. A second call returns
 * the same controls and registers no second script.
 */
export async function installLiveStreams(page: Page): Promise<LiveStreams> {
  const existing = installed.get(page);
  if (existing) return existing;
  await page.addInitScript(installFakeStreams);
  const streams = controls(page);
  installed.set(page, streams);
  return streams;
}

/** The fake streams of a page that `installLiveStreams` fitted. */
export function liveStreams(page: Page): LiveStreams {
  const streams = installed.get(page);
  if (!streams) {
    throw new Error('Call installLiveStreams(page) before the page loads');
  }
  return streams;
}

/** Runs in the page before any app script. It holds no timer that reopens a stream. */
function installFakeStreams(): void {
  const root = window as unknown as {
    __liveStreams?: StreamControls;
    EventSource: unknown;
  };
  if (root.__liveStreams) return;

  const streams: FakeEventSource[] = [];

  class FakeEventSource extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSED = 2;
    readyState = 0;
    readonly url: string;
    readonly withCredentials: boolean;
    /** The URL path, which is the key that a test counts and sends by. */
    readonly path: string;

    constructor(url: string | URL, init?: EventSourceInit) {
      super();
      const resolved = new URL(String(url), window.location.href);
      this.url = resolved.href;
      this.path = resolved.pathname;
      this.withCredentials = init?.withCredentials ?? false;
      streams.push(this);
      // A real stream opens after its constructor returns, so the app registers its
      // listeners first. A stream that a test closed meanwhile stays closed.
      setTimeout(() => {
        if (this.readyState !== 0) return;
        this.readyState = 1;
        this.dispatchEvent(new Event('open'));
      }, 0);
    }

    close(): void {
      this.readyState = 2;
    }
  }

  const open = (): FakeEventSource[] =>
    streams.filter((stream) => stream.readyState !== 2);
  const byPath = (path: string): FakeEventSource[] =>
    open().filter((stream) => stream.path === path);

  root.EventSource = FakeEventSource;
  root.__liveStreams = {
    openUrls: () =>
      open()
        .map((stream) => stream.path)
        .sort(),
    openCount: (path) => byPath(path).length,
    send: (path, type, data) => {
      const targets = byPath(path);
      for (const stream of targets)
        stream.dispatchEvent(new MessageEvent(type, { data }));
      return targets.length;
    },
    close: (path) => {
      const targets = byPath(path);
      for (const stream of targets) stream.close();
      return targets.length;
    },
  };
}

/** The test-side calls into the fake. Every call runs in the page that holds the streams. */
function controls(page: Page): LiveStreams {
  return {
    openUrls: () =>
      page.evaluate(() => {
        const state = (window as unknown as { __liveStreams?: StreamControls })
          .__liveStreams;
        if (!state) throw new Error('The fake live streams are not installed');
        return state.openUrls();
      }),
    openCount: (path) =>
      page.evaluate((url) => {
        const state = (window as unknown as { __liveStreams?: StreamControls })
          .__liveStreams;
        if (!state) throw new Error('The fake live streams are not installed');
        return state.openCount(url);
      }, path),
    async waitForOpen(path, timeoutMs = 5000) {
      try {
        await page.waitForFunction(
          (url) => {
            const state = (
              window as unknown as { __liveStreams?: StreamControls }
            ).__liveStreams;
            return (state?.openCount(url) ?? 0) > 0;
          },
          path,
          { timeout: timeoutMs, polling: 50 },
        );
      } catch {
        throw new Error(`No open stream for ${path} after ${timeoutMs} ms`);
      }
    },
    async send(path, type, data) {
      // A string body stays as written. Every other value travels as JSON.
      const body =
        typeof data === 'string' ? data : JSON.stringify(data ?? null);
      const delivered = await page.evaluate(
        ({ url, name, payload }) => {
          const state = (
            window as unknown as { __liveStreams?: StreamControls }
          ).__liveStreams;
          if (!state)
            throw new Error('The fake live streams are not installed');
          return state.send(url, name, payload);
        },
        { url: path, name: type, payload: body },
      );
      if (delivered === 0) {
        const open = await page.evaluate(() => {
          const state = (
            window as unknown as { __liveStreams?: StreamControls }
          ).__liveStreams;
          return state ? state.openUrls() : [];
        });
        throw new Error(
          `No open stream for ${path}. Open streams: ${open.join(', ') || 'none'}`,
        );
      }
      return delivered;
    },
    close: (path) =>
      page.evaluate((url) => {
        const state = (window as unknown as { __liveStreams?: StreamControls })
          .__liveStreams;
        if (!state) throw new Error('The fake live streams are not installed');
        return state.close(url);
      }, path),
  };
}

import { DOCUMENT } from '@angular/common';
import { Injectable, inject } from '@angular/core';
import { JobStream, type JobEventSource, type StreamGate } from './job-stream';

/** The part of the document that decides whether the tab is hidden. Tests supply a fake. */
export type VisibilityDocument = Pick<
  Document,
  'visibilityState' | 'addEventListener' | 'removeEventListener'
>;

/** One store that follows a feed. */
export interface LiveFeedHandlers {
  /** Opens the feed. The first subscriber's factory owns the connection. */
  open: () => JobEventSource;
  /** Milliseconds before a closed connection reopens. */
  reopenDelay: () => number;
  /** Milliseconds without any event, pings included, before the connection counts as dead. */
  timeout: () => number;
  /** The event names that `changed` receives. */
  events: readonly string[];
  /** The longest reopen wait, when failed attempts back off. */
  reopenCap?: () => number;
  /**
   * Asks whether the connection may open. `retry` waits again.
   * `stop` leaves it closed until a resume or a restart.
   */
  gate?: () => StreamGate | Promise<StreamGate>;
  /** Every open, including an open that this subscriber joined late. */
  opened: () => void;
  /** One message of a requested event. */
  changed: (data: string) => void;
  /** Every close or lost connection. */
  closed?: () => void;
}

export interface LiveFeedSubscription {
  /** A connection exists, or one of its attempts is in flight. */
  readonly active: boolean;
  /** The connection has opened since the last close. */
  readonly connected: boolean;
  /** Resolves after the first open attempt: a connection, a waiting retry, or a stopped feed. */
  readonly ready: Promise<void>;
  /** Leaves the feed. The last subscriber closes the tab's connection. */
  close(): void;
  /** Replaces the connection, as a new person needs a new session cookie. */
  restart(): void;
  /** Opens a connection that a gate or a close left closed. */
  resume(): void;
}

interface Feed {
  url: string;
  subscribers: Set<LiveFeedHandlers>;
  /** The subscriber whose factory and reconnect rules own the connection. */
  owner: LiveFeedHandlers;
  stream: JobStream;
  settle: () => void;
  ready: Promise<void>;
}

/**
 * One EventSource per feed URL in each tab (finding 7).
 *
 * Every store subscribes here instead of opening its own connection. A subscriber
 * receives each event of its feed, reads on every open, and the last subscriber
 * closes the connection. A hidden tab holds no connection, and a visible tab
 * opens its feeds again. The watchdog and reopen rules of `JobStream` apply to
 * the shared connection, so a dead connection reopens once for every subscriber.
 */
@Injectable({ providedIn: 'root' })
export class LiveFeeds {
  private readonly doc = inject(DOCUMENT);
  private readonly feeds = new Map<string, Feed>();
  private hidden = false;

  constructor() {
    this.hidden = this.doc.visibilityState === 'hidden';
    this.doc.addEventListener('visibilitychange', this.onVisibility);
  }

  /**
   * Follows one feed. The first subscriber opens the tab's connection. A subscriber
   * that joins an open connection reads at once, as on an open.
   */
  subscribe(url: string, subscriber: LiveFeedHandlers): LiveFeedSubscription {
    let feed = this.feeds.get(url);
    const joined = feed;
    if (!feed) {
      let settle: () => void = () => undefined;
      const ready = new Promise<void>((resolve) => {
        settle = resolve;
      });
      const created: Feed = {
        url,
        subscribers: new Set(),
        owner: subscriber,
        stream: null as unknown as JobStream,
        settle,
        ready,
      };
      created.stream = new JobStream({
        open: () => created.owner.open(),
        reopenDelay: () => created.owner.reopenDelay(),
        timeout: () => created.owner.timeout(),
        reopenCap: () => created.owner.reopenCap?.(),
        gate: () => (created.owner.gate ? created.owner.gate() : 'open'),
        events: () => [
          ...new Set(
            [...created.subscribers].flatMap((item) => item.events),
          ),
        ],
        settled: () => created.settle(),
        opened: () => {
          for (const item of created.subscribers) item.opened();
        },
        changed: (data) => {
          for (const item of created.subscribers) item.changed(data);
        },
        closed: () => {
          for (const item of created.subscribers) item.closed?.();
        },
      });
      this.feeds.set(url, created);
      feed = created;
    }
    feed.subscribers.add(subscriber);
    if (this.hidden) feed.settle();
    else feed.stream.start();
    // The connection is already open. This subscriber missed its open event.
    if (joined?.stream.connected) subscriber.opened();
    return {
      get active() {
        return feed.stream.active;
      },
      get connected() {
        return feed.stream.connected;
      },
      ready: feed.ready,
      close: () => this.release(feed as Feed, subscriber),
      restart: () => {
        if (this.feeds.get(url) !== feed) return;
        if (this.hidden) feed.stream.stop();
        else feed.stream.restart();
      },
      resume: () => {
        if (this.feeds.get(url) !== feed || this.hidden) return;
        if (feed.stream.connected) subscriber.opened();
        else feed.stream.resume();
      },
    };
  }

  private release(feed: Feed, subscriber: LiveFeedHandlers): void {
    if (!feed.subscribers.delete(subscriber)) return;
    if (feed.subscribers.size) {
      if (feed.owner === subscriber) {
        const next = feed.subscribers.values().next().value;
        if (next) feed.owner = next;
      }
      return;
    }
    feed.stream.stop();
    this.feeds.delete(feed.url);
  }

  /** A hidden tab holds no connection. A visible tab opens every feed it still follows. */
  private readonly onVisibility = (): void => {
    const hidden = this.doc.visibilityState === 'hidden';
    if (hidden === this.hidden) return;
    this.hidden = hidden;
    for (const feed of this.feeds.values()) {
      if (hidden) feed.stream.stop();
      else feed.stream.start();
    }
  };
}
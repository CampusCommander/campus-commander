import { DOCUMENT } from '@angular/common';
import { Injectable, inject } from '@angular/core';
import { JobStream, type JobEventSource } from './job-stream';

/**
 * Every frame name of the one stream (`GET /api/events`). The stream carries the frame names
 * and payloads of the two former feeds, so the connection reads them all.
 */
const STREAM_EVENTS = [
  'job-changed',
  'entity-batch',
  'job-finished',
  'full-sync',
] as const;

/** One store that follows a feed. */
export interface LiveFeedHandlers {
  /** Opens the feed. The first subscriber's factory owns the connection. */
  open: () => JobEventSource;
  /** The event names that `changed` receives. */
  events: readonly string[];
  /**
   * Every open, including an open that this subscriber joined late.
   * `replaced` is true when the open belongs to a connection that replaced an earlier one.
   */
  opened: (replaced: boolean) => void;
  /** One message of a requested event. */
  changed: (data: string) => void;
  /** Every close or lost connection. */
  closed?: () => void;
}

export interface LiveFeedSubscription {
  /** A connection exists. */
  readonly active: boolean;
  /** The connection has opened since the last close. */
  readonly connected: boolean;
  /** Resolves after the first open attempt: a connection or a waiting retry. */
  readonly ready: Promise<void>;
  /** Leaves the feed. The last subscriber closes the tab's connection. */
  close(): void;
  /** Replaces the connection, as a new person needs a new session cookie. */
  restart(): void;
  /** Opens a connection that a close left closed. */
  resume(): void;
}

interface Feed {
  url: string;
  subscribers: Set<LiveFeedHandlers>;
  /** The subscriber whose factory owns the connection. */
  owner: LiveFeedHandlers;
  stream: JobStream;
  settle: () => void;
  ready: Promise<void>;
}

/**
 * One EventSource for each feed URL in a tab (finding 7).
 *
 * Every store subscribes here instead of opening its own connection. The browser uses one URL,
 * `GET /api/events`, so a visible tab holds one connection for every store on the page. A
 * subscriber receives each event that it names, reads on every open, and the last subscriber
 * closes the connection. A hidden tab holds no connection, and a visible tab opens it again.
 *
 * One reopen rule serves the connection: 5 seconds after a close, doubling up to 60 seconds
 * after failed attempts, and dead after 60 seconds without an event. A subscriber cannot gate,
 * delay, or close the connection of another subscriber.
 */
@Injectable({ providedIn: 'root' })
export class LiveFeeds {
  private readonly doc = inject(DOCUMENT);
  private readonly feeds = new Map<string, Feed>();
  private hidden = false;
  /** Milliseconds before a closed connection reopens. */
  reopenDelay = 5000;
  /** Milliseconds that a doubled reopen wait never exceeds. */
  reopenCap = 60_000;
  /** Milliseconds without any event, pings included, before the connection counts as dead. */
  timeout = 60_000;

  constructor() {
    this.hidden = this.doc.visibilityState === 'hidden';
    this.doc.addEventListener('visibilitychange', this.onVisibility);
  }

  /**
   * Follows one feed. The first subscriber opens the tab's connection. A subscriber that joins
   * an open connection reads at once, as on an open.
   */
  subscribe(url: string, subscriber: LiveFeedHandlers): LiveFeedSubscription {
    let feed = this.feeds.get(url);
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
        reopenDelay: () => this.reopenDelay,
        reopenCap: () => this.reopenCap,
        timeout: () => this.timeout,
        events: () => STREAM_EVENTS,
        settled: () => created.settle(),
        opened: (replaced) => {
          for (const item of created.subscribers) item.opened(replaced);
        },
        changed: (name, data) => {
          for (const item of created.subscribers) {
            if (item.events.includes(name)) item.changed(data);
          }
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
    if (feed.stream.connected) subscriber.opened(false);
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
        if (feed.stream.connected) subscriber.opened(false);
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

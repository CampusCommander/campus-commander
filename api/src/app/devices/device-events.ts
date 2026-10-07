import {
  ENTITY_EVENTS_PING_SECONDS,
  entityEventSchema,
  entityEventsChannel,
  type EntityEvent,
} from '@campus/application-contracts';

/** One open event stream. */
export interface EventListener {
  event(event: EntityEvent): void;
  /** The subscriber connection ended. The stream closes so the browser reconnects and reconciles. */
  close(): void;
}

/** A dedicated Redis connection in subscriber mode. */
export interface Subscriber {
  subscribe(channel: string, onMessage: (message: string) => void): Promise<void>;
  unsubscribe(channel: string): Promise<void>;
  close(): Promise<void>;
}

interface Channel {
  listeners: Set<EventListener>;
  ready: Promise<void>;
}

/**
 * Fans worker events out to open streams (D6). One subscriber connection serves every customer.
 * A channel stays subscribed while it has listeners. Pub/Sub keeps no history, so a lost connection closes every stream.
 */
export class EventFanout {
  // Explicit fields: Node's type-stripping test runner rejects parameter properties.
  private readonly open: (lost: () => void) => Promise<Subscriber>;
  private subscriber: Promise<Subscriber> | null = null;
  private readonly channels = new Map<string, Channel>();

  constructor(open: (lost: () => void) => Promise<Subscriber>) {
    this.open = open;
  }

  /** Returns the function that removes the listener. */
  async listen(
    customerId: string,
    listener: EventListener,
  ): Promise<() => Promise<void>> {
    const channel = entityEventsChannel(customerId);
    let entry = this.channels.get(channel);
    if (!entry) {
      const created: Channel = {
        listeners: new Set(),
        ready: this.connection().then((subscriber) =>
          subscriber.subscribe(channel, (message) =>
            this.deliver(channel, message),
          ),
        ),
      };
      created.ready.catch(() => {
        if (this.channels.get(channel) === created) this.channels.delete(channel);
      });
      this.channels.set(channel, created);
      entry = created;
    }
    entry.listeners.add(listener);
    try {
      await entry.ready;
    } catch (error) {
      entry.listeners.delete(listener);
      throw error;
    }
    return async () => {
      const current = this.channels.get(channel);
      if (!current?.listeners.delete(listener) || current.listeners.size) return;
      this.channels.delete(channel);
      const subscriber = this.subscriber;
      await subscriber
        ?.then((connection) => connection.unsubscribe(channel))
        .catch(() => undefined);
    };
  }

  /** Shutdown ends every stream, so the HTTP server can close. */
  async close(): Promise<void> {
    this.lose();
  }

  private deliver(channel: string, message: string): void {
    let event: EntityEvent;
    try {
      event = entityEventSchema.parse(JSON.parse(message));
    } catch {
      // The worker publishes only valid events. Anything else is dropped.
      return;
    }
    for (const listener of this.channels.get(channel)?.listeners ?? [])
      listener.event(event);
  }

  private lose(): void {
    const listeners = [...this.channels.values()].flatMap((entry) => [
      ...entry.listeners,
    ]);
    this.channels.clear();
    const previous = this.subscriber;
    this.subscriber = null;
    void previous
      ?.then((subscriber) => subscriber.close())
      .catch(() => undefined);
    for (const listener of listeners) listener.close();
  }

  private connection(): Promise<Subscriber> {
    if (this.subscriber) return this.subscriber;
    // Only the current connection may report a loss. A late end event from an old one changes nothing.
    const current: Promise<Subscriber> = this.open(() => {
      if (this.subscriber === current) this.lose();
    });
    this.subscriber = current;
    current.catch(() => {
      if (this.subscriber === current) this.subscriber = null;
    });
    return current;
  }
}

/** Bytes buffered for one browser before its stream ends. The browser reconnects and reconciles. */
export const MAX_BUFFERED_BYTES = 1_048_576;

/** One SSE frame. The payload type names the event, so EventSource listens by name. */
export function frame(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** The writable side of one SSE response. */
export interface EventSink {
  write(chunk: string): boolean;
  end(): void;
  once(event: 'close', listener: () => void): unknown;
  readonly writableLength: number;
}

/**
 * Stream one customer's events to one browser (D6, D12). The stream starts after the subscription is active,
 * so a reconnect that reads state afterwards misses nothing. Each ping re-checks the session first.
 */
export async function streamEvents(
  sink: EventSink,
  options: {
    customerId: string;
    fanout: Pick<EventFanout, 'listen'>;
    begin: () => void;
    recheck: () => Promise<boolean>;
    pingMs?: number;
  },
): Promise<boolean> {
  let closed = false;
  let started = false;
  // Assigned after the subscription resolves, and read by finish() earlier.
  // eslint-disable-next-line prefer-const
  let timer: ReturnType<typeof setInterval> | undefined;
  let unlisten: (() => Promise<void>) | undefined;
  const finish = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    void unlisten?.().catch(() => undefined);
    sink.end();
  };
  const send = (chunk: string) => {
    if (closed || !started) return;
    sink.write(chunk);
    if (sink.writableLength > MAX_BUFFERED_BYTES) finish();
  };
  sink.once('close', finish);
  try {
    unlisten = await options.fanout.listen(options.customerId, {
      event: (event) => send(frame(event.type, event)),
      close: finish,
    });
  } catch {
    return false;
  }
  if (closed) {
    await unlisten().catch(() => undefined);
    return true;
  }
  options.begin();
  started = true;
  sink.write('retry: 3000\n\n');
  timer = setInterval(() => {
    void options.recheck().then(
      (allowed) => (allowed ? send(frame('ping', {})) : finish()),
      () => finish(),
    );
  }, options.pingMs ?? ENTITY_EVENTS_PING_SECONDS * 1000);
  return true;
}

/** The part of EventSource that a job stream uses. Tests supply a fake. */
export type JobEventSource = Pick<
  EventSource,
  'addEventListener' | 'close' | 'readyState'
>;

const CLOSED = 2;

/** Whether a connection may open. `retry` waits again. `stop` leaves it closed. */
export type StreamGate = 'open' | 'retry' | 'stop';

export interface JobStreamOptions {
  /** Opens one stream to the feed. */
  open: () => JobEventSource;
  /** Milliseconds before a closed stream reopens. */
  reopenDelay: () => number;
  /** Milliseconds without any event, pings included, before the stream counts as dead. */
  timeout: () => number;
  /**
   * The event names that `changed` receives. A `ping` never counts.
   * Default: `job-changed`.
   */
  events?: () => readonly string[];
  /** The longest reopen wait. Each failed attempt doubles the wait up to this cap. */
  reopenCap?: () => number | undefined;
  /**
   * Asks whether the next stream may open. `retry` waits for the reopen delay.
   * `stop` leaves the stream closed until `resume()` or `restart()`.
   * It runs at every open, the first included.
   */
  gate?: () => StreamGate | Promise<StreamGate>;
  /** One open attempt has finished: a stream exists, a retry waits, or the gate stopped it. */
  settled?: () => void;
  /** Every stream open, first or after a reconnect, resynchronizes the reader (section 3.4). */
  opened: () => void;
  /** One message payload of a requested event. */
  changed: (name: string, data: string) => void;
  /** Every close or lost connection. Live updates end until the next open. */
  closed?: () => void;
}

/**
 * The event stream of one feed URL (design 3.3 and 3.4).
 * A stream without events past the timeout counts as dead. A closed stream reopens after the delay.
 */
export class JobStream {
  private stream: JobEventSource | null = null;
  private reopenTimer: ReturnType<typeof setTimeout> | undefined;
  private watchdog: ReturnType<typeof setTimeout> | undefined;
  /** A stream has opened since the last close. */
  private isOpen = false;
  /** A gate answer is pending. A second open waits for it. */
  private opening = false;
  /** A gate stopped the stream. Only `resume` and `restart` clear it. */
  private stopped = false;
  /** Failed reopen attempts. Each one doubles the wait when the feed caps it. */
  private attempts = 0;
  /** Invalidates a gate answer that a close made obsolete. */
  private attempt = 0;

  constructor(private readonly options: JobStreamOptions) {}

  /** True while a stream is open. */
  get active(): boolean {
    return this.stream !== null;
  }

  /** True while the current stream has fired `open` and has not closed. */
  get connected(): boolean {
    return this.isOpen;
  }

  /** Opens the stream when none is open. */
  start(): void {
    if (!this.stream && !this.opening && !this.stopped) this.open();
  }

  /** Closes the stream and cancels its scheduled reopen. */
  stop(): void {
    this.stopped = false;
    this.close();
    clearTimeout(this.reopenTimer);
    this.reopenTimer = undefined;
    this.attempts = 0;
  }

  /** Replaces the open stream, as a new person needs a new session cookie. */
  restart(): void {
    this.close();
    clearTimeout(this.reopenTimer);
    this.reopenTimer = undefined;
    this.stopped = false;
    this.open();
  }

  /** Clears a stopped stream and opens it now. */
  resume(): void {
    if (this.stream || this.opening) return;
    this.stopped = false;
    this.open();
  }

  private open(): void {
    this.close();
    clearTimeout(this.reopenTimer);
    this.reopenTimer = undefined;
    const gate = this.options.gate;
    if (!gate) {
      this.connect();
      this.options.settled?.();
      return;
    }
    const answer = gate();
    if (typeof answer !== 'string') {
      const attempt = ++this.attempt;
      this.opening = true;
      void this.gated(attempt, answer);
      return;
    }
    this.decide(answer);
    this.options.settled?.();
  }

  private async gated(
    attempt: number,
    answer: Promise<StreamGate>,
  ): Promise<void> {
    const result = await answer;
    // A close or another open replaced this attempt. Its answer changes nothing.
    if (attempt !== this.attempt) return;
    this.opening = false;
    this.decide(result);
    this.options.settled?.();
  }

  private decide(result: StreamGate): void {
    if (result === 'open') {
      this.connect();
      return;
    }
    if (result === 'retry') {
      this.scheduleReopen();
      return;
    }
    // The session ended or the page left. Only a resume or a restart opens again.
    this.stopped = true;
  }

  private connect(): void {
    const stream = this.options.open();
    this.stream = stream;
    const current = () => this.stream === stream;
    stream.addEventListener('open', () => {
      if (!current()) return;
      this.isOpen = true;
      this.attempts = 0;
      this.watch();
      this.options.opened();
    });
    stream.addEventListener('ping', () => {
      if (current()) this.watch();
    });
    for (const name of this.options.events?.() ?? ['job-changed']) {
      stream.addEventListener(name, (message) => {
        if (!current()) return;
        this.watch();
        this.options.changed(name, (message as MessageEvent<string>).data);
      });
    }
    stream.addEventListener('error', () => {
      if (!current()) return;
      if (stream.readyState === CLOSED) {
        // A closed stream reopens after the delay.
        this.scheduleReopen();
        return;
      }
      // EventSource retries while CONNECTING. Live updates end until the next open,
      // and the native reconnection keeps its own retry.
      this.options.closed?.();
    });
  }

  private close(): void {
    const hadStream = this.stream !== null;
    this.attempt++;
    this.opening = false;
    this.isOpen = false;
    clearTimeout(this.watchdog);
    this.watchdog = undefined;
    this.stream?.close();
    this.stream = null;
    // A close reports a connection that ended, not an open that finds nothing to close.
    if (hadStream) this.options.closed?.();
  }

  private watch(): void {
    clearTimeout(this.watchdog);
    this.watchdog = undefined;
    const timeout = this.options.timeout();
    if (timeout > 0)
      this.watchdog = setTimeout(() => this.scheduleReopen(), timeout);
  }

  private scheduleReopen(): void {
    this.close();
    clearTimeout(this.reopenTimer);
    const cap = this.options.reopenCap?.();
    const delay =
      cap === undefined
        ? this.options.reopenDelay()
        : Math.min(this.options.reopenDelay() * 2 ** this.attempts, cap);
    this.attempts = cap === undefined ? 0 : this.attempts + 1;
    this.reopenTimer = setTimeout(() => this.open(), delay);
  }
}

/** The part of EventSource that a job stream uses. Tests supply a fake. */
export type JobEventSource = Pick<
  EventSource,
  'addEventListener' | 'close' | 'readyState'
>;

const CLOSED = 2;

export interface JobStreamOptions {
  /** Opens one stream to the jobs channel. */
  open: () => JobEventSource;
  /** Milliseconds before a closed stream reopens. */
  reopenDelay: () => number;
  /** Milliseconds without any event, pings included, before the stream counts as dead. */
  timeout: () => number;
  /** Every stream open, first or after a reconnect, resynchronizes the reader (section 3.4). */
  opened: () => void;
  /** One `job-changed` message payload. */
  changed: (data: string) => void;
  /** Every close or lost connection. Live updates end until the next open. */
  closed?: () => void;
}

/**
 * The event stream of the Jobs page and the job detail page (design 3.3 and 3.4).
 * A stream without events past the timeout counts as dead. A closed stream reopens after the delay.
 */
export class JobStream {
  private stream: JobEventSource | null = null;
  private reopenTimer: ReturnType<typeof setTimeout> | undefined;
  private watchdog: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: JobStreamOptions) {}

  /** True while a stream is open. */
  get active(): boolean {
    return this.stream !== null;
  }

  /** Opens the stream when none is open. */
  start(): void {
    if (!this.stream) this.open();
  }

  /** Closes the stream and cancels its scheduled reopen. */
  stop(): void {
    this.close();
    clearTimeout(this.reopenTimer);
    this.reopenTimer = undefined;
  }

  /** Replaces the open stream, as a new person needs a new session cookie. */
  restart(): void {
    this.close();
    this.open();
  }

  private open(): void {
    this.close();
    const stream = this.options.open();
    this.stream = stream;
    const current = () => this.stream === stream;
    stream.addEventListener('open', () => {
      if (!current()) return;
      this.watch();
      this.options.opened();
    });
    stream.addEventListener('ping', () => {
      if (current()) this.watch();
    });
    stream.addEventListener('job-changed', (message) => {
      if (!current()) return;
      this.watch();
      this.options.changed((message as MessageEvent<string>).data);
    });
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
    clearTimeout(this.watchdog);
    this.watchdog = undefined;
    this.stream?.close();
    this.stream = null;
    this.options.closed?.();
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
    this.reopenTimer = setTimeout(
      () => this.open(),
      this.options.reopenDelay(),
    );
  }
}

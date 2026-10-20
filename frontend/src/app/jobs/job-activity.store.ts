import {
  Injectable,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import {
  jobActivitySchema,
  jobEventSchema,
  jobSeenSchema,
  type JobActivity,
  type JobEvent,
} from '@campus/application-contracts';
import { AuthStore } from '../auth.store';
import { jobsReadable } from './jobs.store';
import { JobReader, type JobRevisions } from './job-reader';
import { JobStream, type JobEventSource } from './job-stream';

/** The shortest delay between timed rereads (design 3.4). */
export const ACTIVITY_EXPIRY_FLOOR_MS = 60_000;

/**
 * The activity summary of the shell (design 2.5 and 3.4).
 *
 * One `JobReader` reads `GET /api/jobs/activity` and one `JobStream` listens on
 * `/api/jobs/events`. The badge reads `running.count` and attention reads `attention`
 * from the latest answer. A successful `seen` request marks the reader dirty. After each
 * successful read, one timed reread follows at `recent.nextExpiryAt`.
 */
@Injectable({ providedIn: 'root' })
export class JobActivityStore {
  private readonly auth = inject(AuthStore);
  /** Opens the jobs event stream. Tests replace it. */
  eventSource: (url: string) => JobEventSource = (url) => new EventSource(url);
  /** Milliseconds before a closed stream reopens. */
  reopenDelay = 5000;
  /** Milliseconds without any event, pings included, before the stream counts as dead. */
  streamTimeout = 60_000;

  readonly summary = signal<JobActivity | null>(null);
  /** The first read has no answer yet. */
  readonly loading = signal(true);
  /** A successful read has produced the current state at least once. */
  readonly loaded = signal(false);
  readonly error = signal('');
  /** The stream is open. The panel shows "Updated live" only then. */
  readonly live = signal(false);

  /** The badge count. It never comes from the capped row lists (design 3.4). */
  readonly runningCount = computed(() => this.summary()?.running.count ?? 0);
  readonly attention = computed(() => this.summary()?.attention ?? false);

  private readonly reader = new JobReader(() => this.read());
  private readonly events = new JobStream({
    open: () => this.eventSource('/api/jobs/events'),
    reopenDelay: () => this.reopenDelay,
    timeout: () => this.streamTimeout,
    // Every stream open marks the reader dirty (section 3.4).
    opened: () => {
      this.live.set(true);
      this.reader.opened();
    },
    changed: (data) => this.onEvent(data),
    closed: () => this.live.set(false),
  });
  /** The shell shows the button. The summary, stream, and timers run only then. */
  private started = false;
  /** The person of the current state. Another person clears it. */
  private identity: string | null = null;
  /** Increments on another person. Late answers and events are dropped. */
  private epoch = 0;
  /** The single scheduled reread at `recent.nextExpiryAt`. */
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    // The summary, reader, stream, timers, and pending requests belong to one person.
    effect(() => {
      const identity = this.auth.session()?.identity.id ?? null;
      const readable = jobsReadable(this.auth);
      untracked(() => {
        if (!readable || identity === null) {
          // A sign-out, a session interruption, or lost access clears this person's state.
          if (this.started) this.stop();
          this.identity = null;
          return;
        }
        if (this.identity !== null && identity !== this.identity) this.reset();
        this.identity = identity;
        if (!this.started) this.start();
      });
    });
  }

  /** Opens the panel. Each opening asks the server to mark the activity seen. */
  async seen(): Promise<void> {
    if (!this.started) return;
    const epoch = this.epoch;
    const identity = this.auth.session()?.identity.id ?? null;
    // A held answer must not reach another person or a stopped shell.
    const current = () =>
      epoch === this.epoch &&
      this.started &&
      (this.auth.session()?.identity.id ?? null) === identity;
    try {
      const response = await this.auth.request('/api/jobs/activity/seen', {});
      if (!current()) return;
      if (!response.ok) return;
      const parsed = jobSeenSchema.safeParse(
        await response.json().catch(() => null),
      );
      if (!current() || !parsed.success) return;
      // No job event and no reconnect take part. The reread clears the dot (design 3.4).
      this.reader.invalidate();
    } catch {
      // The dot stays. The next opening sends the request again.
    }
  }

  /** Stops the stream and the timers and clears the summary of one person. */
  private stop(): void {
    this.started = false;
    this.epoch++;
    this.reader.clear();
    this.events.stop();
    this.clearExpiry();
    this.live.set(false);
    this.summary.set(null);
    this.loading.set(true);
    this.loaded.set(false);
    this.error.set('');
  }

  private start(): void {
    this.started = true;
    this.events.start();
    if (!this.loaded()) this.loading.set(true);
    void this.reader.request();
  }

  /** Clears the previous person's state before the next person's answers arrive. */
  private reset(): void {
    this.epoch++;
    this.reader.clear();
    this.clearExpiry();
    this.summary.set(null);
    this.loading.set(true);
    this.loaded.set(false);
    this.error.set('');
    // The stream carries the session cookie. A new person needs a new stream.
    this.events.restart();
    // Do not wait for the stream open to remove the previous person's state.
    void this.reader.request();
  }

  /** One read of the activity summary. */
  private async read(): Promise<JobRevisions | null> {
    const epoch = this.epoch;
    const identity = this.auth.session()?.identity.id ?? null;
    const current = () =>
      epoch === this.epoch &&
      (this.auth.session()?.identity.id ?? null) === identity;
    try {
      const response = await this.auth.request('/api/jobs/activity');
      if (!current()) return [];
      if (response.status === 403) {
        // A 403 clears the summary and every indicator of the button.
        this.summary.set(null);
        this.loading.set(false);
        this.loaded.set(false);
        this.error.set('Activity is unavailable.');
        this.clearExpiry();
        return [];
      }
      if (!response.ok) {
        this.failed(false);
        return null;
      }
      const parsed = jobActivitySchema.safeParse(
        await response.json().catch(() => null),
      );
      if (!current()) return [];
      if (!parsed.success) {
        this.failed(false);
        return null;
      }
      const activity = parsed.data;
      this.summary.set(activity);
      this.loading.set(false);
      this.loaded.set(true);
      this.error.set('');
      this.scheduleExpiry(activity);
      return [
        ...activity.running.jobs,
        ...activity.waiting.jobs,
        ...activity.recent.jobs,
      ].map((job) => ({ jobId: job.jobId, revision: job.revision }));
    } catch {
      if (!current()) return [];
      this.failed(true);
      return null;
    }
  }

  private failed(offline: boolean): void {
    this.loading.set(false);
    if (!this.summary()) {
      this.error.set(
        offline
          ? 'Cannot reach Campus Commander. Activity is unavailable.'
          : 'Activity is unavailable.',
      );
    } else {
      this.error.set('');
    }
  }

  /**
   * One reread at `recent.nextExpiryAt`, measured from `observedAt` so the client clock
   * never decides the time. Timed rereads run at most once per 60 s.
   */
  private scheduleExpiry(activity: JobActivity): void {
    this.clearExpiry();
    const next = activity.recent.nextExpiryAt;
    if (!next) return;
    const observed = Date.parse(activity.observedAt);
    const expiry = Date.parse(next);
    if (!Number.isFinite(observed) || !Number.isFinite(expiry)) return;
    const delay = Math.max(ACTIVITY_EXPIRY_FLOOR_MS, expiry - observed);
    const epoch = this.epoch;
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = undefined;
      if (!this.started || epoch !== this.epoch) return;
      void this.reader.request();
    }, delay);
  }

  private clearExpiry(): void {
    if (this.expiryTimer !== undefined) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
  }

  private onEvent(data: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const result = jobEventSchema.safeParse(parsed);
    if (result.success) this.reader.changed(result.data as JobEvent);
  }
}

/** The revision that a successful read of one job returned, or one `job-changed` event. */
export interface JobRevision {
  jobId: string;
  revision: number;
}

/** The revisions of every job in a successful read. A failed read returns null. */
export type JobRevisions = readonly JobRevision[];
export type JobRead = () => Promise<JobRevisions | null>;

/**
 * The single-flight reader of section 3.4.
 *
 * A `job-changed` event is an invalidation only. The reader keeps the highest revision of each job,
 * so a duplicate event starts no read. A dirty reader reads once after 250 ms. An event during a
 * read marks it dirty again. A failed read keeps its revisions and retries after 5 s.
 */
export class JobReader {
  /** Milliseconds between an invalidation and its read. */
  readonly debounceMs = 250;
  /** Milliseconds before a failed read tries again. */
  readonly retryMs = 5000;

  private readonly revisions = new Map<string, number>();
  private dirty = false;
  /** A query change or Refresh waits while a read is in flight. */
  private queued = false;
  private reading = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Increments on stop. A continuation from an earlier run schedules no work. */
  private generation = 0;

  constructor(private readonly read: JobRead) {}

  /** The highest revision that a read of this job returned. */
  revision(jobId: string): number {
    return this.revisions.get(jobId) ?? 0;
  }

  /** An event at or below the held revision leaves the reader clean. */
  changed(job: JobRevision): void {
    if (job.revision <= this.revision(job.jobId)) return;
    this.invalidate();
  }

  /**
   * Every stream open, first or after a reconnect, marks every reader dirty.
   * An open supersedes a failed-read backoff and resynchronizes after the debounce.
   */
  opened(): void {
    this.dirty = true;
    this.clearTimer();
    this.schedule(this.debounceMs);
  }

  /**
   * A query change or Refresh reads now. A read in flight finishes first, then one read follows.
   * Returns false when the request joined a read in flight.
   */
  request(): Promise<boolean> {
    if (this.reading) {
      this.queued = true;
      return Promise.resolve(false);
    }
    return this.run();
  }

  /** Stops scheduled reads. Held revisions stay, so a return to the page keeps its baseline. */
  stop(): void {
    this.generation++;
    this.clearTimer();
    this.dirty = false;
    this.queued = false;
  }

  /** Forgets the held revisions of another person. */
  clear(): void {
    this.stop();
    this.revisions.clear();
  }

  private invalidate(): void {
    this.dirty = true;
    this.schedule(this.debounceMs);
  }

  private schedule(delay: number): void {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.run();
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async run(): Promise<boolean> {
    if (this.reading) {
      this.queued = true;
      return false;
    }
    this.clearTimer();
    this.reading = true;
    // A read answers every invalidation that arrived before it started.
    this.dirty = false;
    // A stop invalidates this continuation. A request after the stop still runs.
    const generation = this.generation;
    let revisions: JobRevisions | null;
    try {
      revisions = await this.read();
    } catch {
      revisions = null;
    }
    this.reading = false;
    if (generation !== this.generation) {
      if (this.queued) {
        this.queued = false;
        return this.run();
      }
      return false;
    }
    if (revisions === null) {
      // The read failed. Keep the revisions and the dirty state, then retry after 5 s.
      this.dirty = true;
      this.clearTimer();
      if (this.queued) {
        this.queued = false;
        return this.run();
      }
      this.schedule(this.retryMs);
      return false;
    }
    for (const job of revisions) {
      if (job.revision > this.revision(job.jobId))
        this.revisions.set(job.jobId, job.revision);
    }
    if (this.queued) {
      this.queued = false;
      return this.run();
    }
    // An event during the read marks the reader dirty again. It reads once more.
    if (this.dirty) this.schedule(this.debounceMs);
    return true;
  }
}

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobReader, type JobRevisions } from './job-reader';

const one = (jobId: string, revision: number): JobRevisions => [
  { jobId, revision },
];

/** Let pending promise continuations run without advancing timers. */
const flush = async () => {
  for (let index = 0; index < 10; index++) await Promise.resolve();
};

describe('JobReader', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('starts no read at or below the highest revision that a read returned', async () => {
    const read = vi.fn(async () => one('job-a', 3));
    const reader = new JobReader(read);
    await reader.request();
    reader.changed({ jobId: 'job-a', revision: 3 });
    reader.changed({ jobId: 'job-a', revision: 2 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('reads once after 250 ms for an event above the held revision', async () => {
    let current = 1;
    const read = vi.fn(async () => one('job-a', current));
    const reader = new JobReader(read);
    await reader.request();
    reader.changed({ jobId: 'job-a', revision: 2 });
    reader.changed({ jobId: 'job-a', revision: 3 });
    await vi.advanceTimersByTimeAsync(249);
    expect(read).toHaveBeenCalledTimes(1);
    current = 3;
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
    expect(reader.revision('job-a')).toBe(3);
  });

  it('treats a job that the reader does not hold as dirty', async () => {
    const read = vi.fn(async () => one('job-a', 1));
    const reader = new JobReader(read);
    await reader.request();
    reader.changed({ jobId: 'job-b', revision: 1 });
    await vi.advanceTimersByTimeAsync(250);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('reads once more when an event arrives during a read', async () => {
    let finish: (revisions: JobRevisions) => void = () => undefined;
    const read = vi.fn(
      () =>
        new Promise<JobRevisions | null>((resolve) => {
          finish = resolve;
        }),
    );
    const reader = new JobReader(read);
    const first = reader.request();
    reader.changed({ jobId: 'job-a', revision: 2 });
    await vi.advanceTimersByTime(250);
    // The timer fired while the first read still runs.
    expect(read).toHaveBeenCalledTimes(1);
    finish(one('job-a', 1));
    // The first read answers the event with one more read.
    await flush();
    expect(read).toHaveBeenCalledTimes(2);
    finish(one('job-a', 2));
    await first;
    expect(reader.revision('job-a')).toBe(2);
  });

  it('keeps the revisions and dirty state of a failed read and retries after 5 s', async () => {
    const read = vi
      .fn<() => Promise<JobRevisions | null>>()
      .mockResolvedValueOnce(one('job-a', 1))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(one('job-a', 2));
    const reader = new JobReader(read);
    await reader.request();
    reader.changed({ jobId: 'job-a', revision: 2 });
    await vi.advanceTimersByTimeAsync(250);
    expect(read).toHaveBeenCalledTimes(2);
    expect(reader.revision('job-a')).toBe(1);
    await vi.advanceTimersByTimeAsync(4999);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(3);
    expect(reader.revision('job-a')).toBe(2);
  });

  it('marks the reader dirty on every stream open', async () => {
    const read = vi.fn(async () => one('job-a', 1));
    const reader = new JobReader(read);
    reader.opened();
    await vi.advanceTimersByTimeAsync(250);
    expect(read).toHaveBeenCalledTimes(1);
    reader.opened();
    await vi.advanceTimersByTimeAsync(250);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('never overlaps reads and reads once more after a request during a read', async () => {
    let finish: (revisions: JobRevisions) => void = () => undefined;
    const read = vi.fn(
      () =>
        new Promise<JobRevisions | null>((resolve) => {
          finish = resolve;
        }),
    );
    const reader = new JobReader(read);
    const first = reader.request();
    const second = reader.request();
    expect(read).toHaveBeenCalledTimes(1);
    expect(await second).toBe(false);
    finish(one('job-a', 1));
    await flush();
    expect(read).toHaveBeenCalledTimes(2);
    finish(one('job-a', 2));
    await first;
    expect(reader.revision('job-a')).toBe(2);
  });

  it('stops scheduled reads without losing the held revisions', async () => {
    const read = vi.fn(async () => one('job-a', 1));
    const reader = new JobReader(read);
    await reader.request();
    reader.changed({ jobId: 'job-a', revision: 2 });
    reader.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).toHaveBeenCalledTimes(1);
    expect(reader.revision('job-a')).toBe(1);
  });
});

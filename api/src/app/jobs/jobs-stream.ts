import type { SessionResponse } from '@campus/application-contracts';
import { seesEveryJob } from './jobs';

/** The session check of the jobs stream ping. */
export interface JobStreamAuth {
  authenticate(
    cookie: string | undefined,
    action: string,
    correlationId: string,
    options: { slide: boolean },
  ): Promise<SessionResponse>;
}

/** The read that resolves the customer of a session. */
export interface JobStreamReads {
  customer(session: SessionResponse): Promise<string>;
}

export interface JobStreamRecheck {
  /** False ends the stream, so the browser reconnects and reads the state it may no longer see. */
  allowed: boolean;
  /** The session of this ping when the check succeeded. */
  session: SessionResponse | null;
}

/**
 * One ping of the jobs stream (section 3.3). The session and both read actions must still hold for the
 * customer that opened the stream. A removed `jobs:read` closes the stream of a holder of every job.
 */
export async function recheckJobStream(input: {
  auth: JobStreamAuth;
  jobs: JobStreamReads;
  cookie: string | undefined;
  correlationId: string;
  customerId: string;
  everyJob: boolean;
}): Promise<JobStreamRecheck> {
  try {
    const session = await input.auth.authenticate(
      input.cookie,
      'identity:read',
      input.correlationId,
      { slide: false },
    );
    const customerId = await input.jobs.customer(session);
    return {
      allowed:
        customerId === input.customerId &&
        seesEveryJob(session, input.customerId) === input.everyJob,
      session,
    };
  } catch {
    return { allowed: false, session: null };
  }
}

import {
  userStreamEventSchema,
  type DeviceSyncFailure,
  type EntityEvent,
  type SessionResponse,
  type UserSyncState,
} from '@campus/application-contracts';
import type { Forwarded } from '../devices/device-events';

/** The reads that one users feed runs for the caller (document A section 8). */
export interface UserStreamReads {
  /** The failure of one job, as the caller may see it. A missing header row reads null. */
  jobFailure(jobId: string): Promise<DeviceSyncFailure | null>;
  /** The user sync state projection of the caller. */
  sync(): Promise<UserSyncState | null>;
}

/** The failures of a user sync state that the caller cannot see read null. */
export const userWithoutFailures = (sync: UserSyncState): UserSyncState => ({
  ...sync,
  failure: null,
});

/**
 * The event mapping of the users feed (document A section 8). An event never carries a job ID, a
 * job record, a requester, or a failure that the caller cannot see. Every event names the entity
 * type `user` (A section 15.4).
 */
export function userForward(
  seesEveryJob: boolean,
  reads: UserStreamReads,
): (event: EntityEvent, failed: boolean) => Promise<Forwarded | null> {
  return async (event, failed) => {
    if (event.type === 'entity-batch') {
      // A device batch shares the channel. The users feed forwards user events alone.
      if (event.entityType !== 'user') return null;
      return {
        event: userStreamEventSchema.parse({
          type: 'entity-batch',
          entityType: 'user',
          userIds: event.deviceIds,
          removedIds: event.removedIds,
        }),
      };
    }
    if (event.type === 'job-finished') {
      if (event.job.entityType !== 'user') return null;
      if (failed)
        return {
          event: userStreamEventSchema.parse({
            type: 'job-finished',
            entityType: 'user',
            failure: null,
          }),
          end: true,
        };
      const failure = seesEveryJob
        ? event.job.failure
        : await reads.jobFailure(event.job.jobId);
      return {
        event: userStreamEventSchema.parse({
          type: 'job-finished',
          entityType: 'user',
          failure,
        }),
      };
    }
    if (event.type === 'user-full-sync') {
      if (failed)
        return {
          event: userStreamEventSchema.parse({
            type: 'user-full-sync',
            entityType: 'user',
            sync: userWithoutFailures(event.sync),
          }),
          end: true,
        };
      if (seesEveryJob)
        return {
          event: userStreamEventSchema.parse({
            type: 'user-full-sync',
            entityType: 'user',
            sync: event.sync,
          }),
        };
      // The projection runs the job visibility predicate for the failure requester.
      const sync = await reads.sync();
      return {
        event: userStreamEventSchema.parse({
          type: 'user-full-sync',
          entityType: 'user',
          sync: sync ?? userWithoutFailures(event.sync),
        }),
      };
    }
    // A category job changed the schema list. The event carries no job data (B section 9).
    if (event.type === 'schema-change')
      return {
        event: userStreamEventSchema.parse({
          type: 'schema-change',
          entityType: 'user',
        }),
        ...(failed ? { end: true } : {}),
      };
    // No other channel event reaches the users feed.
    return null;
  };
}

/** The session check of the users feed ping. */
export interface UserStreamAuth {
  authenticate(
    cookie: string | undefined,
    action: string,
    correlationId: string,
    options: { slide: boolean },
  ): Promise<SessionResponse>;
}

/** The reads of one users feed ping. */
export interface UserStreamPingReads {
  /** The user sync of the customer, after the users:read authority of the session. */
  current(session: SessionResponse): Promise<{ customerId: string } | null>;
  /** True when the session holds jobs:read or jobs:manage at platform or district scope. */
  jobVisibility(session: SessionResponse, customerId: string): boolean;
}

export interface UserStreamRecheck {
  /** False ends the stream, so the browser reconnects and reads the state it may no longer see. */
  allowed: boolean;
  /** The session of this ping when the check succeeded. */
  session: SessionResponse | null;
}

/**
 * One ping of the users feed (document A section 8). The session must still hold users:read for
 * the customer, and its job visibility must not change. A revoked users:read closes the stream,
 * so the browser reconnects and reads the state it may no longer see. The rule mirrors the
 * Devices stream ping.
 */
export async function recheckUserStream(input: {
  auth: UserStreamAuth;
  reads: UserStreamPingReads;
  cookie: string | undefined;
  correlationId: string;
  customerId: string;
  seesEveryJob: boolean;
}): Promise<UserStreamRecheck> {
  try {
    const session = await input.auth.authenticate(
      input.cookie,
      'identity:read',
      input.correlationId,
      { slide: false },
    );
    const current = await input.reads.current(session);
    return {
      allowed:
        current?.customerId === input.customerId &&
        input.reads.jobVisibility(session, input.customerId) ===
          input.seesEveryJob,
      session,
    };
  } catch {
    return { allowed: false, session: null };
  }
}

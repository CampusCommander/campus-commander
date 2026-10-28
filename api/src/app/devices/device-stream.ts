import {
  deviceStreamEventSchema,
  type DeviceSyncFailure,
  type DeviceSyncState,
  type EntityEvent,
  type SessionResponse,
} from '@campus/application-contracts';
import type { Forwarded } from './device-events';

/** The reads that one Devices stream runs for the caller (section 3.1). */
export interface DeviceStreamReads {
  /** The failure of one job, as the caller may see it. A missing header row reads null. */
  jobFailure(jobId: string): Promise<DeviceSyncFailure | null>;
  /** The sync state projection of the caller. */
  sync(): Promise<DeviceSyncState | null>;
}

/** The failures of a sync state that the caller cannot see read null. */
export const withoutFailures = (sync: DeviceSyncState): DeviceSyncState => ({
  ...sync,
  failure: null,
  telemetryFailure: null,
});

/**
 * The mapping table of section 3.1. An event never carries a job ID, a job record, or a requester,
 * and it never carries a failure that the caller cannot see.
 */
export function deviceForward(
  seesEveryJob: boolean,
  reads: DeviceStreamReads,
): (event: EntityEvent, failed: boolean) => Promise<Forwarded | null> {
  return async (event, failed) => {
    if (event.type === 'entity-batch')
      return {
        event: deviceStreamEventSchema.parse({
          type: 'entity-batch',
          entityType: event.entityType,
          deviceIds: event.deviceIds,
          removedIds: event.removedIds,
        }),
      };
    if (event.type === 'job-finished') {
      if (failed)
        return { event: { type: 'job-finished', failure: null }, end: true };
      const failure = seesEveryJob
        ? event.job.failure
        : await reads.jobFailure(event.job.jobId);
      return {
        event: deviceStreamEventSchema.parse({ type: 'job-finished', failure }),
      };
    }
    if (event.type === 'full-sync') {
      if (failed)
        return {
          event: { type: 'full-sync', sync: withoutFailures(event.sync) },
          end: true,
        };
      if (seesEveryJob)
        return {
          event: deviceStreamEventSchema.parse({
            type: 'full-sync',
            sync: event.sync,
          }),
        };
      // The projection runs the predicate for each failure requester of section 2.1.
      const sync = await reads.sync();
      return {
        event: deviceStreamEventSchema.parse({
          type: 'full-sync',
          sync: sync ?? withoutFailures(event.sync),
        }),
      };
    }
    // No other channel event reaches the Devices stream.
    return null;
  };
}

/** The session check of the Devices stream ping. */
export interface DeviceStreamAuth {
  authenticate(
    cookie: string | undefined,
    action: string,
    correlationId: string,
    options: { slide: boolean },
  ): Promise<SessionResponse>;
}

/** The reads of one Devices stream ping. */
export interface DeviceStreamPingReads {
  /** The sync of the customer, after the devices:read authority of the session. */
  current(session: SessionResponse): Promise<{ customerId: string } | null>;
  /** True when the session holds jobs:read or jobs:manage at platform or district scope. */
  jobVisibility(session: SessionResponse, customerId: string): boolean;
}

export interface DeviceStreamRecheck {
  /** False ends the stream, so the browser reconnects and reads the state it may no longer see. */
  allowed: boolean;
  /** The session of this ping when the check succeeded. */
  session: SessionResponse | null;
}

/**
 * One ping of the Devices stream (section 3.3). The session must still hold devices:read for the
 * customer, and its job visibility must not change. A changed visibility closes the stream,
 * so the browser reconnects and reads the failures it may now see or no longer see.
 */
export async function recheckDeviceStream(input: {
  auth: DeviceStreamAuth;
  reads: DeviceStreamPingReads;
  cookie: string | undefined;
  correlationId: string;
  customerId: string;
  seesEveryJob: boolean;
}): Promise<DeviceStreamRecheck> {
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

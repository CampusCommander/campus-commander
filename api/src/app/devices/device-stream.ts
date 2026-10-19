import {
  deviceStreamEventSchema,
  type DeviceSyncFailure,
  type DeviceSyncState,
  type EntityEvent,
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

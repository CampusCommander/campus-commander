import {
  isAuthorized,
  type SessionResponse,
} from '@campus/application-contracts';
import {
  recheckDeviceStream,
  type DeviceStreamPingReads,
} from '../devices/device-stream';
import {
  recheckUserStream,
  type UserStreamPingReads,
} from '../users/user-stream';
import {
  recheckJobStream,
  type JobStreamAuth,
  type JobStreamReads,
} from '../jobs/jobs-stream';

/** The open device feed of one stream, with the job visibility of its caller. */
export type EventStreamDevice = DeviceStreamPingReads & {
  seesEveryJob: boolean;
};

/** The open users feed of one stream, with the job visibility of its caller. */
export type EventStreamUsers = UserStreamPingReads & {
  seesEveryJob: boolean;
};

export interface EventStreamRecheck {
  /** False ends the stream, so the browser reconnects and reads the state it may no longer see. */
  allowed: boolean;
  /** The session of this ping when the check succeeded. */
  session: SessionResponse | null;
}

/**
 * One ping of the one stream (scope item 6). The job feed decides first, and its refusal is the
 * refusal of the stream. Every open feed adds the check of its own stream. A feed that is left
 * out closes the stream when the caller can now read it, so the browser reconnects and receives
 * every feed it may now see.
 *
 * Every check reads the session without sliding it, so an open tab never keeps an unattended
 * session alive (the D6 amendment).
 */
export async function recheckEventStream(input: {
  auth: JobStreamAuth;
  jobs: JobStreamReads;
  cookie: string | undefined;
  correlationId: string;
  customerId: string;
  everyJob: boolean;
  /** The open device feed, or null when the stream carries the job feed alone. */
  device: EventStreamDevice | null;
  /** The open users feed, or null when the stream does not carry it. */
  users?: EventStreamUsers | null;
  /** The open rule of the Devices stream. It runs only while the device feed is left out. */
  canOpenDevice(session: SessionResponse): Promise<boolean>;
  /** The open rule of the users feed. It runs only while the users feed is left out. */
  canOpenUsers?(session: SessionResponse): Promise<boolean>;
}): Promise<EventStreamRecheck> {
  try {
    const job = await recheckJobStream({
      auth: input.auth,
      jobs: input.jobs,
      cookie: input.cookie,
      correlationId: input.correlationId,
      customerId: input.customerId,
      everyJob: input.everyJob,
    });
    const session = job.session;
    if (!job.allowed || !session) return { allowed: false, session: null };
    let current = session;
    if (input.device) {
      const checked = await recheckDeviceStream({
        auth: input.auth,
        reads: input.device,
        cookie: input.cookie,
        correlationId: input.correlationId,
        customerId: input.customerId,
        seesEveryJob: input.device.seesEveryJob,
      });
      if (!checked.allowed) return { allowed: false, session: null };
      current = checked.session ?? current;
    }
    if (input.users) {
      const checked = await recheckUserStream({
        auth: input.auth,
        reads: input.users,
        cookie: input.cookie,
        correlationId: input.correlationId,
        customerId: input.customerId,
        seesEveryJob: input.users.seesEveryJob,
      });
      if (!checked.allowed) return { allowed: false, session: null };
      current = checked.session ?? current;
    }
    // A feed that the stream leaves out closes it when the caller can now open it, so the browser
    // reconnects and receives both feeds.
    if (!input.device && (await input.canOpenDevice(current)))
      return { allowed: false, session: null };
    if (
      !input.users &&
      input.canOpenUsers &&
      (await input.canOpenUsers(current))
    )
      return { allowed: false, session: null };
    return { allowed: true, session: current };
  } catch {
    return { allowed: false, session: null };
  }
}

/**
 * The open rule of the Devices stream as a check that writes no audit row. `AuthService.authorize`
 * answers the same rule, and it records every denial. A stream that repeats this check on each ping
 * must not write a denial per ping, so the rule reads the grants directly.
 */
export function deviceReadable(
  phase: number | undefined,
  session: SessionResponse,
  customerId: string,
): boolean {
  return (
    phase === 3 &&
    isAuthorized(session.identity.grants, 'devices:read', {
      kind: 'district',
      customerId,
    })
  );
}

/** The open rule of the users feed, as `deviceReadable` answers it for the Devices stream. */
export function userReadable(
  phase: number | undefined,
  session: SessionResponse,
  customerId: string,
): boolean {
  return (
    phase === 3 &&
    isAuthorized(session.identity.grants, 'users:read', {
      kind: 'district',
      customerId,
    })
  );
}

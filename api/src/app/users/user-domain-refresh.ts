import { HttpException } from '@nestjs/common';
import type {
  GoogleHealth,
  GoogleHealthCapability,
  GoogleHealthFailure,
  SessionResponse,
  UserSyncState,
} from '@campus/application-contracts';

/** The two reads that a Refresh Domain request refreshes (document A section 8). */
const refreshCapabilities: GoogleHealthCapability[] = [
  'customer-identity',
  'domain-observations',
];

export interface UserDomainRefreshPort {
  /** Authorize connection:diagnose for this district. */
  authorize(
    session: SessionResponse,
    customerId: string,
    correlationId: string,
  ): Promise<void>;
  /** Start the full user sync. A running sync throws 409. A start failure throws 503. */
  requestSync(
    session: SessionResponse,
    current: UserSyncState,
    correlationId: string,
  ): Promise<UserSyncState>;
  /** Run the two capability checks and answer the stored health state. */
  checkHealth(
    session: SessionResponse,
    customerId: string,
    generation: number,
    capabilities: GoogleHealthCapability[],
    correlationId: string,
  ): Promise<GoogleHealth>;
}

export interface UserDomainRefreshAnswer {
  status: 'refreshed' | 'failed';
  reason: GoogleHealthFailure | 'busy' | 'unavailable' | null;
}

export interface UserDomainRefreshResult {
  sync: UserSyncState;
  domain: UserDomainRefreshAnswer;
}

/**
 * Refresh Domain: start the full user sync, then check the domain details. It mirrors
 * api/src/app/devices/device-domain-refresh.ts for the user state (document A section 8).
 */
export class UserDomainRefresh {
  private readonly port: UserDomainRefreshPort;

  constructor(port: UserDomainRefreshPort) {
    this.port = port;
  }

  private async domain(
    session: SessionResponse,
    sync: UserSyncState,
    correlationId: string,
  ): Promise<UserDomainRefreshAnswer> {
    try {
      const health = await this.port.checkHealth(
        session,
        sync.customerId,
        sync.generation,
        refreshCapabilities,
        correlationId,
      );
      // The stored state lists every capability. Only this refresh decides the answer.
      const failed = health.capabilities.find(
        (entry: GoogleHealth['capabilities'][number]) =>
          refreshCapabilities.includes(entry.capability) &&
          entry.failure !== null,
      );
      return failed
        ? { status: 'failed', reason: failed.failure }
        : { status: 'refreshed', reason: null };
    } catch (error) {
      // A check failure leaves the sync running. The client names each cause.
      return {
        status: 'failed',
        reason:
          error instanceof HttpException && error.getStatus() === 429
            ? 'busy'
            : 'unavailable',
      };
    }
  }

  async request(
    session: SessionResponse,
    current: UserSyncState,
    correlationId: string,
  ): Promise<UserDomainRefreshResult> {
    await this.port.authorize(session, current.customerId, correlationId);
    const sync = await this.port.requestSync(session, current, correlationId);
    return { sync, domain: await this.domain(session, sync, correlationId) };
  }
}

import { HttpException } from '@nestjs/common';
import type {
  DeviceSyncState,
  GoogleHealth,
  GoogleHealthCapability,
  GoogleHealthFailure,
  SessionResponse,
} from '@campus/application-contracts';

/** The two reads that a Refresh Domain request refreshes. */
const refreshCapabilities: GoogleHealthCapability[] = [
  'customer-identity',
  'domain-observations',
];

export interface DomainRefreshPort {
  /** Authorize connection:diagnose for this district. */
  authorize(
    session: SessionResponse,
    customerId: string,
    correlationId: string,
  ): Promise<void>;
  /** Start the full device sync. A running sync throws 409. A start failure throws 503. */
  requestSync(
    session: SessionResponse,
    current: DeviceSyncState,
    correlationId: string,
  ): Promise<DeviceSyncState>;
  /** Run the two capability checks and answer the stored health state. */
  checkHealth(
    session: SessionResponse,
    customerId: string,
    generation: number,
    capabilities: GoogleHealthCapability[],
    correlationId: string,
  ): Promise<GoogleHealth>;
}

export interface DomainRefreshAnswer {
  status: 'refreshed' | 'failed';
  reason: GoogleHealthFailure | 'busy' | 'unavailable' | null;
}

export interface DomainRefreshResult {
  sync: DeviceSyncState;
  domain: DomainRefreshAnswer;
}

/**
 * Refresh Domain: start the full device sync, then check the domain details. The sync carries
 * each device's org unit and battery data, so no Google org unit tree read runs here.
 */
export class DeviceDomainRefresh {
  private readonly port: DomainRefreshPort;

  constructor(port: DomainRefreshPort) {
    this.port = port;
  }

  private async domain(
    session: SessionResponse,
    sync: DeviceSyncState,
    correlationId: string,
  ): Promise<DomainRefreshAnswer> {
    try {
      const health = await this.port.checkHealth(
        session,
        sync.customerId,
        sync.generation,
        refreshCapabilities,
        correlationId,
      );
      const failed = health.capabilities.find(
        (entry: GoogleHealth['capabilities'][number]) => entry.failure !== null,
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
    current: DeviceSyncState,
    correlationId: string,
  ): Promise<DomainRefreshResult> {
    await this.port.authorize(session, current.customerId, correlationId);
    const sync = await this.port.requestSync(session, current, correlationId);
    return { sync, domain: await this.domain(session, sync, correlationId) };
  }
}

import { ConflictException } from '@nestjs/common';
import {
  GOOGLE_CAPABILITIES,
  deviceOrgUnitTreeSchema,
  type DeviceOrgUnitTree,
  type DeviceOrgUnitTreeEntry,
  type DeviceOrgUnitTreeState,
  type SessionResponse,
} from '@campus/application-contracts';
import { failure, type DelegatedCredential } from '@campus/google-connection';
import {
  DEVICE_WRITE_ACCESS_DEADLINE_MILLISECONDS,
  WriteAccessDeadlineError,
  beforeDeadline,
  type DeviceWriteAccessContext,
} from './device-write-access';

/** The capability and the one scope that the tree read mints, from section 6. */
export const DEVICE_ORG_UNIT_SCOPE = GOOGLE_CAPABILITIES.find(
  (capability) => capability.id === 'school-ou-references',
)!.scope;

/** The Google failures that prove a missing grant. Every other code is unavailable. */
const deniedCodes = ['delegation-not-authorized', 'scope-mismatch'];

/** The connection, the person check, the credential, and the Google read. */
export interface OrgUnitTreePort {
  /**
   * Resolve the connected customer through cc.device_writer. The function requires
   * devices:write and raises 42501 for every other caller. Null means no connection.
   */
  connection(
    session: SessionResponse,
  ): Promise<DeviceWriteAccessContext | null>;
  /** Run the person check of DEVICE_UPDATE_ACTIONS for the connected district. */
  authorize(
    session: SessionResponse,
    customerId: string,
    correlationId: string,
  ): Promise<void>;
  /** Open the active credential through cc.device_write_credential. Null means no connection. */
  credential(
    session: SessionResponse,
    context: DeviceWriteAccessContext,
  ): Promise<DelegatedCredential | null>;
  /** Read orgunits.list with the OU read scope alone. */
  read(
    credential: DelegatedCredential,
    customerId: string,
    signal: AbortSignal,
  ): Promise<DeviceOrgUnitTreeEntry[]>;
}

function measuredAt(): string {
  return new Date().toISOString();
}

/** The route options. Production uses the write-check deadline. */
export interface DeviceOrgUnitTreeOptions {
  /** The overall deadline of one read, from its first call. */
  deadlineMilliseconds?: number;
}

/**
 * The organization unit tree of the connected customer (design section 6).
 * One deadline covers the credential read and the Google read. The route keeps no cache.
 */
export class DeviceOrgUnitTreeRoute {
  private readonly port: OrgUnitTreePort;
  private readonly deadlineMilliseconds: number;

  constructor(port: OrgUnitTreePort, options: DeviceOrgUnitTreeOptions = {}) {
    this.port = port;
    this.deadlineMilliseconds =
      options.deadlineMilliseconds ?? DEVICE_WRITE_ACCESS_DEADLINE_MILLISECONDS;
  }

  private answer(
    state: DeviceOrgUnitTreeState,
    code: DeviceOrgUnitTree['failure'],
    orgUnits: DeviceOrgUnitTreeEntry[] | null,
  ): DeviceOrgUnitTree {
    return deviceOrgUnitTreeSchema.parse({
      state,
      scope: DEVICE_ORG_UNIT_SCOPE,
      failure: code,
      orgUnits,
      observedAt: measuredAt(),
    });
  }

  async read(
    session: SessionResponse,
    correlationId: string,
  ): Promise<DeviceOrgUnitTree> {
    // cc.device_writer names the connected customer and refuses every caller without a write action.
    const context = await this.port.connection(session);
    if (!context)
      throw new ConflictException({ reason: 'connection-required' });
    await this.port.authorize(session, context.customerId, correlationId);
    const deadline = Date.now() + this.deadlineMilliseconds;
    let credential: DelegatedCredential | null;
    try {
      credential = await beforeDeadline(
        this.port.credential(session, context),
        deadline,
      );
    } catch (error) {
      if (error instanceof WriteAccessDeadlineError)
        return this.answer('unavailable', 'network-failure', null);
      throw error;
    }
    if (!credential)
      throw new ConflictException({ reason: 'connection-required' });
    const remaining = deadline - Date.now();
    if (remaining <= 0)
      return this.answer('unavailable', 'network-failure', null);
    try {
      const orgUnits = await this.port.read(
        credential,
        context.customerId,
        AbortSignal.timeout(remaining),
      );
      return this.answer('granted', null, orgUnits);
    } catch (error) {
      const code = failure(error, 'read').code;
      return this.answer(
        deniedCodes.includes(code) ? 'denied' : 'unavailable',
        code,
        null,
      );
    }
  }
}

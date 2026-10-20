import type {
  Action,
  ResourceScope,
  SessionResponse,
} from '@campus/application-contracts';

/** Every device update route requires these actions at the connected customer's district scope. */
export const DEVICE_UPDATE_ACTIONS = [
  'devices:read',
  'devices:write',
  'devices:bulk-actions',
] as const;

export interface DeviceUpdateAuthorizer {
  authorize(
    session: SessionResponse,
    action: Action,
    resource: ResourceScope,
    correlationId: string,
  ): Promise<void>;
}

/** Run the person check of one device update request, in the order of the routes. */
export async function requireDeviceUpdateActions(
  auth: DeviceUpdateAuthorizer,
  session: SessionResponse,
  customerId: string,
  correlationId: string,
): Promise<void> {
  for (const action of DEVICE_UPDATE_ACTIONS)
    await auth.authorize(
      session,
      action,
      { kind: 'district', customerId },
      correlationId,
    );
}

/** Reconcile reads one job and starts one write flow, so it requires both actions (design 469). */
export const RECONCILE_ACTIONS = ['jobs:read', 'devices:write'] as const;

export async function requireReconcileActions(
  auth: DeviceUpdateAuthorizer,
  session: SessionResponse,
  customerId: string,
  correlationId: string,
): Promise<void> {
  for (const action of RECONCILE_ACTIONS)
    await auth.authorize(
      session,
      action,
      { kind: 'district', customerId },
      correlationId,
    );
}

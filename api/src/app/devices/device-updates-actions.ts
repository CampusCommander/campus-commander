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

/** A command route adds `devices:commands` to the read and Bulk Actions pair (section 6). */
export const DEVICE_COMMAND_ROUTE_ACTIONS = [
  'devices:read',
  'devices:bulk-actions',
  'devices:commands',
] as const;

/** A status route adds `devices:status` to the read and Bulk Actions pair (section 6). */
export const DEVICE_STATUS_ROUTE_ACTIONS = [
  'devices:read',
  'devices:bulk-actions',
  'devices:status',
] as const;

export interface DeviceUpdateAuthorizer {
  authorize(
    session: SessionResponse,
    action: Action,
    resource: ResourceScope,
    correlationId: string,
  ): Promise<void>;
}

/** Run one person check per action, in order. The first refusal stops the request. */
export async function requireDeviceActions(
  auth: DeviceUpdateAuthorizer,
  session: SessionResponse,
  customerId: string,
  correlationId: string,
  actions: readonly Action[],
): Promise<void> {
  for (const action of actions)
    await auth.authorize(
      session,
      action,
      { kind: 'district', customerId },
      correlationId,
    );
}

/** Run the person check of one device update request, in the order of the routes. */
export async function requireDeviceUpdateActions(
  auth: DeviceUpdateAuthorizer,
  session: SessionResponse,
  customerId: string,
  correlationId: string,
): Promise<void> {
  await requireDeviceActions(
    auth,
    session,
    customerId,
    correlationId,
    DEVICE_UPDATE_ACTIONS,
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

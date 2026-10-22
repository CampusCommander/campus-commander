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

/**
 * Reconcile of an update operation requires `jobs:read` and `devices:write` (design 469).
 * Reconcile of a status operation requires `jobs:read` and `devices:status` (design section 6).
 * The read check runs before the job lookup. The write check runs after the operation lookup.
 * A command operation has no Reconcile, so it has no list.
 */
export const RECONCILE_READ_ACTIONS = ['jobs:read'] as const;
export const RECONCILE_UPDATE_ACTIONS = ['devices:write'] as const;
export const RECONCILE_STATUS_ACTIONS = ['devices:status'] as const;

/** One Reconcile check: the read of the job, or the write check of the operation kind. */
export type ReconcileCheck = 'read' | 'update' | 'status';

/** The action list of one Reconcile check. */
export function reconcileActions(check: ReconcileCheck): readonly Action[] {
  if (check === 'read') return RECONCILE_READ_ACTIONS;
  return check === 'status'
    ? RECONCILE_STATUS_ACTIONS
    : RECONCILE_UPDATE_ACTIONS;
}

export async function requireReconcileActions(
  auth: DeviceUpdateAuthorizer,
  session: SessionResponse,
  customerId: string,
  correlationId: string,
  check: ReconcileCheck,
): Promise<void> {
  await requireDeviceActions(
    auth,
    session,
    customerId,
    correlationId,
    reconcileActions(check),
  );
}

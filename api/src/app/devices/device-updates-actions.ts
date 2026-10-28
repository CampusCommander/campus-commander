import {
  DEVICE_ACTION_PERMISSIONS,
  isAuthorized,
  type Action,
  type DeviceAction,
  type ResourceScope,
  type SessionResponse,
} from '@campus/application-contracts';

/** Every device update route requires these actions at the connected customer's district scope. */
export const DEVICE_UPDATE_ACTIONS = [
  'devices:read',
  'devices:write',
  'devices:bulk-actions',
] as const;

/**
 * A command or status route checks read and Bulk Actions before any read. The permission of the
 * requested action follows, because one menu entry now carries two permissions (section 2).
 */
export const DEVICE_ACTION_ROUTE_ACTIONS = [
  'devices:read',
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

/**
 * Run the person check of the requested action at district scope, after the family guard. The
 * permission of each action sits in `DEVICE_ACTION_PERMISSIONS`, so a route never guesses one.
 */
export async function requireDeviceAction(
  auth: DeviceUpdateAuthorizer,
  session: SessionResponse,
  customerId: string,
  correlationId: string,
  action: DeviceAction,
): Promise<void> {
  await requireDeviceActions(auth, session, customerId, correlationId, [
    DEVICE_ACTION_PERMISSIONS[action],
  ]);
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
 * Reconcile of an update operation requires the job read and `devices:write` (design 469).
 * Reconcile of a disable or re-enable operation requires the job read and `devices:status`
 * (design section 6). Reconcile of a Deprovision operation requires the job read and
 * `devices:deprovision` (record default D13).
 * The read check runs before the job lookup. The write check runs after the operation lookup.
 * A command operation has no Reconcile, so it has no list.
 * The read check accepts `jobs:read` or `jobs:manage`, because `jobs:manage` holds the job
 * visibility of `jobs:read` (engineering default 16).
 */
export const RECONCILE_READ_ACTIONS = ['jobs:read', 'jobs:manage'] as const;
export const RECONCILE_UPDATE_ACTIONS = ['devices:write'] as const;
export const RECONCILE_STATUS_ACTIONS = ['devices:status'] as const;
export const RECONCILE_DEPROVISION_ACTIONS = ['devices:deprovision'] as const;

/** One Reconcile check: the read of the job, or the write check of the operation kind. */
export type ReconcileCheck = 'read' | 'update' | 'status' | 'deprovision';

/** The action list of one Reconcile check. */
export function reconcileActions(check: ReconcileCheck): readonly Action[] {
  if (check === 'read') return RECONCILE_READ_ACTIONS;
  if (check === 'deprovision') return RECONCILE_DEPROVISION_ACTIONS;
  return check === 'status'
    ? RECONCILE_STATUS_ACTIONS
    : RECONCILE_UPDATE_ACTIONS;
}

/**
 * The one read action of a Reconcile. A person holding `jobs:manage` reads through it, so a
 * manager never needs `jobs:read` as well. A person holding neither is checked against
 * `jobs:read`, so the refusal and its audit row name the read permission.
 */
function reconcileReadAction(
  session: SessionResponse,
  customerId: string,
): Action {
  const scope: ResourceScope = { kind: 'district', customerId };
  return isAuthorized(session.identity.grants, 'jobs:manage', scope)
    ? 'jobs:manage'
    : 'jobs:read';
}

export async function requireReconcileActions(
  auth: DeviceUpdateAuthorizer,
  session: SessionResponse,
  customerId: string,
  correlationId: string,
  check: ReconcileCheck,
): Promise<void> {
  if (check === 'read') {
    await auth.authorize(
      session,
      reconcileReadAction(session, customerId),
      { kind: 'district', customerId },
      correlationId,
    );
    return;
  }
  await requireDeviceActions(
    auth,
    session,
    customerId,
    correlationId,
    reconcileActions(check),
  );
}

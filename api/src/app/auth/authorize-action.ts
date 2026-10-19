import { ForbiddenException } from '@nestjs/common';
import {
  isAuthorized,
  type Action,
  type ResourceScope,
  type SessionResponse,
} from '@campus/application-contracts';

export interface AuthorizeDeps {
  /** The deployment phase. Authorization applies in phase 3 only. */
  phase: number | undefined;
  audit(
    event: 'access-denied',
    correlationId: string,
    actorId: string,
    detail: string,
  ): Promise<void>;
}

/** Authorize one action for one resource, and record an access-denied row before a 403. */
export async function authorizeAction(
  deps: AuthorizeDeps,
  session: SessionResponse,
  action: Action,
  resource: ResourceScope,
  correlationId: string,
): Promise<void> {
  if (
    deps.phase !== 3 ||
    !isAuthorized(session.identity.grants, action, resource)
  ) {
    await deps.audit(
      'access-denied',
      correlationId,
      session.identity.id,
      action,
    );
    throw new ForbiddenException('This action requires additional permission.');
  }
}

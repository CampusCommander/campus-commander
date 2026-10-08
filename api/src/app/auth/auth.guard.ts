import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type {
  Permission,
  SessionResponse,
} from '@campus/application-contracts';
import type { Request } from 'express';
import { AuthService, equalToken } from './auth.service';
import { ConfigurationService } from '../configuration/configuration.service';

export const RequirePermission = (permission: Permission) =>
  SetMetadata('permission', permission);
export interface AuthenticatedRequest extends Request {
  correlationId: string;
  session: SessionResponse;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
    private readonly configuration: ConfigurationService,
  ) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const permission =
      this.reflector.getAllAndOverride<Permission>('permission', [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'identity:read';
    request.session = await this.auth.authenticate(
      request.headers.cookie,
      permission,
      request.correlationId,
    );
    if (!['GET', 'HEAD'].includes(request.method)) {
      if (
        request.headers.origin !== this.configuration.auth.publicOrigin ||
        !equalToken(request.get('x-csrf-token'), request.session.csrfToken) ||
        !request.is('application/json')
      ) {
        await this.auth.recordDeniedRequest(
          request.correlationId,
          request.session.identity.id,
        );
        throw new ForbiddenException(
          'The request failed browser security checks.',
        );
      }
    }
    return true;
  }
}

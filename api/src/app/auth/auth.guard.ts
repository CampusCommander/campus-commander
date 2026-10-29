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

/**
 * The body media types of one route. A POST route without this metadata takes JSON only. The
 * upload route names `text/csv`, because its body is the raw file (design section 4).
 */
export const AcceptBody = (...mediaTypes: string[]) =>
  SetMetadata('bodyMediaTypes', mediaTypes);

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
    const bodyTypes = this.reflector.getAllAndOverride<string[]>(
      'bodyMediaTypes',
      [context.getHandler(), context.getClass()],
    ) ?? ['application/json'];
    request.session = await this.auth.authenticate(
      request.headers.cookie,
      permission,
      request.correlationId,
    );
    if (!['GET', 'HEAD'].includes(request.method)) {
      if (
        request.headers.origin !== this.configuration.auth.publicOrigin ||
        !equalToken(request.get('x-csrf-token'), request.session.csrfToken) ||
        !bodyTypes.some((mediaType) => request.is(mediaType))
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

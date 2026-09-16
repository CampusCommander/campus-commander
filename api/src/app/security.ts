import {
  Catch,
  HttpException,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

export function securityHeaders(
  request: Request & { correlationId?: string },
  response: Response,
  next: NextFunction,
) {
  request.correlationId = randomUUID();
  response.setHeader('x-correlation-id', request.correlationId);
  response.setHeader('cache-control', 'no-store');
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader(
    'content-security-policy',
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  );
  next();
}

@Catch()
export class ApplicationExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const request = host
      .switchToHttp()
      .getRequest<Request & { correlationId: string }>();
    const response = host.switchToHttp().getResponse<Response>();
    if (
      !/^\/api\/(?:auth|diagnostics|application)(?:\/|$)/.test(request.path) &&
      exception instanceof HttpException
    ) {
      response.status(exception.getStatus()).json(exception.getResponse());
      return;
    }
    const status =
      exception instanceof ZodError
        ? 400
        : exception instanceof HttpException
          ? exception.getStatus()
          : 503;
    const errors: Record<number, [string, string]> = {
      400: [
        'invalid-request',
        'The request is invalid. Check the values and retry.',
      ],
      401: ['unauthenticated', 'Sign in to continue.'],
      403: [
        'forbidden',
        'This request requires additional permission or valid browser security checks.',
      ],
      404: ['not-found', 'This route is unavailable.'],
      429: ['busy', 'A check is already running. Wait before another request.'],
    };
    const [code, message] = errors[status] ?? [
      'unavailable',
      'The service is unavailable. Retry or contact the installation operator.',
    ];
    response
      .status(status)
      .json({ code, message, correlationId: request.correlationId });
  }
}

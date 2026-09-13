import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  Res,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import { preferencesSchema } from '@campus/application-contracts';
import type { Response } from 'express';
import {
  AuthService,
  loginCookie,
  sessionCookie,
  readCookie,
} from './auth.service';
import { EnrollmentService, enrollmentCookie } from './enrollment.service';
import { ConfigurationService } from '../configuration/configuration.service';
import { z } from 'zod';
import { AuthGuard, type AuthenticatedRequest } from './auth.guard';

const cookieOptions = {
  secure: true,
  httpOnly: true,
  sameSite: 'lax' as const,
  path: '/',
};

@Controller('api/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly enrollment: EnrollmentService,
    private readonly configuration: ConfigurationService,
  ) {}

  @Post('enrollment/start')
  async enroll(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
    @Res() response: Response,
  ) {
    if (
      request.headers.origin !== this.configuration.auth.publicOrigin ||
      !request.is('application/json')
    )
      throw new ForbiddenException();
    const input = z.strictObject({ code: z.string() }).parse(body);
    const paired = await this.enrollment.pair(input.code);
    const result = await this.auth
      .start(request.correlationId, paired.id)
      .catch(async (error: unknown) => {
        await this.enrollment.failed(paired.id).catch(() => undefined);
        throw error;
      });
    response.cookie(loginCookie, result.token, {
      ...cookieOptions,
      maxAge: 300000,
    });
    response.cookie(enrollmentCookie, paired.token, {
      ...cookieOptions,
      maxAge: 600000,
    });
    response.json({ url: result.url });
  }

  @Get('enrollment/status')
  enrollmentStatus(@Req() request: AuthenticatedRequest) {
    return this.enrollment.browser(
      readCookie(request.headers.cookie, enrollmentCookie),
    );
  }

  @Get('login')
  async login(@Req() request: AuthenticatedRequest, @Res() response: Response) {
    const result = await this.auth.start(request.correlationId);
    response.cookie(loginCookie, result.token, {
      ...cookieOptions,
      maxAge: 300000,
    });
    response.clearCookie(enrollmentCookie, cookieOptions);
    response.redirect(303, result.url);
  }

  @Get('callback')
  async callback(
    @Req() request: AuthenticatedRequest,
    @Res() response: Response,
  ) {
    response.clearCookie(loginCookie, cookieOptions);
    try {
      const result = await this.auth.callback(
        request.originalUrl,
        request.headers.cookie,
        request.correlationId,
      );
      if ('enrollment' in result) {
        response.redirect(303, '/setup?verified=1');
        return;
      }
      response.cookie(sessionCookie, result.token, {
        ...cookieOptions,
        maxAge: result.seconds * 1000,
      });
      response.redirect(303, '/');
    } catch {
      await this.auth
        .recordDeniedLogin(request.correlationId)
        .catch(() => undefined);
      response.redirect(
        303,
        readCookie(request.headers.cookie, enrollmentCookie)
          ? '/setup?error=sign-in-failed'
          : '/login?error=sign-in-failed',
      );
    }
  }

  @Get('session')
  @UseGuards(AuthGuard)
  session(@Req() request: AuthenticatedRequest) {
    return request.session;
  }

  @Post('logout')
  @UseGuards(AuthGuard)
  async logout(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.auth.logout(
      request.headers.cookie,
      request.session,
      request.correlationId,
    );
    response.clearCookie(sessionCookie, cookieOptions);
    return { status: 'signed-out' };
  }

  @Post('preferences')
  @UseGuards(AuthGuard)
  preferences(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    return this.auth.preferences(
      request.session,
      preferencesSchema.parse(body),
      request.correlationId,
    );
  }
}

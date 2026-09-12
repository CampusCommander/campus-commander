import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { preferencesSchema } from '@campus/application-contracts';
import type { Response } from 'express';
import { AuthService, loginCookie, sessionCookie } from './auth.service';
import { AuthGuard, type AuthenticatedRequest } from './auth.guard';

const cookieOptions = {
  secure: true,
  httpOnly: true,
  sameSite: 'lax' as const,
  path: '/',
};

@Controller('api/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Get('login')
  async login(@Req() request: AuthenticatedRequest, @Res() response: Response) {
    const result = await this.auth.start(request.correlationId);
    response.cookie(loginCookie, result.token, {
      ...cookieOptions,
      maxAge: 300000,
    });
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
      response.cookie(sessionCookie, result.token, {
        ...cookieOptions,
        maxAge: result.seconds * 1000,
      });
      response.redirect(303, '/');
    } catch {
      await this.auth
        .recordDeniedLogin(request.correlationId)
        .catch(() => undefined);
      response.redirect(303, '/login?error=sign-in-failed');
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

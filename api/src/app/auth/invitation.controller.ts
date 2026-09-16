import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import {
  confirmInvitationSchema,
  createInvitationSchema,
  invitationRevisionSchema,
  invitationTokenSchema,
} from '@campus/application-contracts';
import { z } from 'zod';
import type { Response } from 'express';
import { AuthGuard, type AuthenticatedRequest } from './auth.guard';
import { AuthService, loginCookie, readCookie } from './auth.service';
import { enrollmentCookie } from './enrollment.service';
import { InvitationService, invitationCookie } from './invitation.service';
import { ConfigurationService } from '../configuration/configuration.service';

@Controller('api/auth/invitations')
export class InvitationController {
  constructor(
    private readonly invitations: InvitationService,
    private readonly auth: AuthService,
    private readonly configuration: ConfigurationService,
  ) {}

  @Get()
  @UseGuards(AuthGuard)
  async list(@Req() request: AuthenticatedRequest) {
    await this.auth.authorize(
      request.session,
      'platform-users:read',
      { kind: 'platform' },
      request.correlationId,
    );
    return this.invitations.list(request.session, request.correlationId);
  }

  @Post()
  @UseGuards(AuthGuard)
  async create(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    await this.auth.authorize(
      request.session,
      'platform-users:invite',
      { kind: 'platform' },
      request.correlationId,
    );
    return this.invitations.create(
      request.session,
      createInvitationSchema.parse(body),
      request.correlationId,
    );
  }

  @Post(':id/confirm')
  @UseGuards(AuthGuard)
  async confirm(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    await this.auth.authorize(
      request.session,
      'platform-users:invite',
      { kind: 'platform' },
      request.correlationId,
    );
    const input = confirmInvitationSchema.parse(body);
    return this.invitations.confirm(
      request.session,
      z.uuid().parse(id),
      input.version,
      input.subject,
      request.correlationId,
    );
  }

  @Post(':id/revoke')
  @UseGuards(AuthGuard)
  async revoke(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    await this.auth.authorize(
      request.session,
      'platform-users:invite',
      { kind: 'platform' },
      request.correlationId,
    );
    return this.invitations.revoke(
      request.session,
      z.uuid().parse(id),
      invitationRevisionSchema.parse(body).version,
      request.correlationId,
    );
  }

  @Post('redeem')
  async redeem(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
    @Res() response: Response,
  ) {
    if (
      request.headers.origin !== this.configuration.auth.publicOrigin ||
      !request.is('application/json')
    )
      throw new ForbiddenException();
    const input = z.strictObject({ token: invitationTokenSchema }).parse(body);
    const claimed = await this.invitations.claim(
      input.token,
      request.socket.remoteAddress ?? 'unknown',
      request.correlationId,
    );
    const login = await this.auth.start(request.correlationId, undefined, {
      id: claimed.id,
      browserHash: claimed.browserHash,
    });
    const options = {
      secure: true,
      httpOnly: true,
      sameSite: 'lax' as const,
      path: '/',
    };
    response.clearCookie(enrollmentCookie, options);
    response.cookie(loginCookie, login.token, { ...options, maxAge: 300_000 });
    response.cookie(invitationCookie, claimed.browserToken, {
      ...options,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    response.json({ url: login.url });
  }

  @Get('status')
  status(@Req() request: AuthenticatedRequest) {
    return this.invitations.browser(
      readCookie(request.headers.cookie, invitationCookie),
      request.correlationId,
    );
  }
}

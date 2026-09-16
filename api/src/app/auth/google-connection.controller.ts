import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  googleCredentialImportSchema,
  googleCustomerConfirmationSchema,
} from '@campus/application-contracts';
import { z } from 'zod';
import { AuthGuard, type AuthenticatedRequest } from './auth.guard';
import { AuthService } from './auth.service';
import { GoogleConnectionService } from './google-connection.service';

@Controller('api/google-connection')
@UseGuards(AuthGuard)
export class GoogleConnectionController {
  constructor(
    private readonly connection: GoogleConnectionService,
    private readonly auth: AuthService,
  ) {}

  @Get()
  async read(@Req() request: AuthenticatedRequest) {
    return { connection: await this.connection.read(request.session) };
  }

  @Get('candidates/:id')
  candidate(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.connection.candidate(request.session, z.uuid().parse(id));
  }

  @Post('candidates')
  async stage(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    await this.auth.authorize(
      request.session,
      'connection:manage',
      { kind: 'platform' },
      request.correlationId,
    );
    return this.connection.stage(
      request.session,
      googleCredentialImportSchema.parse(body),
      request.correlationId,
    );
  }

  @Post('candidates/:id/confirm')
  async confirm(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    await this.auth.authorize(
      request.session,
      'connection:manage',
      { kind: 'platform' },
      request.correlationId,
    );
    const input = googleCustomerConfirmationSchema.parse(body);
    return this.connection.confirm(
      request.session,
      z.uuid().parse(id),
      input.customerId,
      request.correlationId,
    );
  }
}

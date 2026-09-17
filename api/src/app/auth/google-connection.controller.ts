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
  googleCredentialReplacementSchema,
  googleCredentialActivationSchema,
  googleReplacementActivationSchema,
  googleKeyRotationSchema,
  googleHealthCheckSchema,
  googleCustomerIdSchema,
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

  @Get('health')
  async health(@Req() request: AuthenticatedRequest) {
    return { health: await this.connection.health(request.session) };
  }

  @Post('health/check')
  async checkHealth(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ) {
    const input = googleHealthCheckSchema.parse(body);
    const authorize = (session = request.session) =>
      this.auth.authorize(
        session,
        'connection:diagnose',
        { kind: 'district', customerId: input.customerId },
        request.correlationId,
      );
    await authorize();
    try {
      return {
        health: await this.connection.checkHealth(
          request.session,
          input,
          request.correlationId,
        ),
      };
    } finally {
      await authorize(
        await this.auth.authenticate(
          request.headers.cookie,
          'identity:read',
          request.correlationId,
        ),
      );
    }
  }

  @Post('check')
  async check(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = z
      .strictObject({
        customerId: googleCustomerIdSchema,
        generation: z.number().int().positive(),
        retry: z.boolean().default(false),
      })
      .parse(body);
    const authorize = (session = request.session) =>
      this.auth.authorize(
        session,
        'connection:diagnose',
        { kind: 'district', customerId: input.customerId },
        request.correlationId,
      );
    await authorize();
    try {
      return await this.connection.check(
        request.session,
        input.customerId,
        input.generation,
        input.retry,
        request.correlationId,
      );
    } finally {
      await authorize(
        await this.auth.authenticate(
          request.headers.cookie,
          'identity:read',
          request.correlationId,
        ),
      );
    }
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

  private async manage(request: AuthenticatedRequest) {
    await this.auth.authorize(
      request.session,
      'connection:manage',
      { kind: 'platform' },
      request.correlationId,
    );
  }

  @Get('credentials')
  async management(@Req() request: AuthenticatedRequest) {
    await this.manage(request);
    return this.connection.management(request.session);
  }

  @Post('replacements')
  async replace(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    await this.manage(request);
    return this.connection.replace(
      request.session,
      googleCredentialReplacementSchema.parse(body),
      request.correlationId,
    );
  }

  @Post('replacements/:id/activate')
  async activateReplacement(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    await this.manage(request);
    return this.connection.activateReplacement(
      request.session,
      z.uuid().parse(id),
      googleReplacementActivationSchema.parse(body),
      request.correlationId,
    );
  }

  @Post('credentials/rotate-key')
  async rotateKey(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    await this.manage(request);
    return this.connection.rotateKey(
      request.session,
      googleKeyRotationSchema.parse(body),
      request.correlationId,
    );
  }

  @Post('credentials/disconnect')
  async disconnect(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ) {
    await this.manage(request);
    return this.connection.disconnect(
      request.session,
      googleCredentialActivationSchema.parse(body),
      request.correlationId,
    );
  }
}

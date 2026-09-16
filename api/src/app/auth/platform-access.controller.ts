import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { platformAccessChangeSchema } from '@campus/application-contracts';
import { z } from 'zod';
import { AuthGuard, type AuthenticatedRequest } from './auth.guard';
import { AuthService } from './auth.service';
import { PlatformAccessService } from './platform-access.service';

const pageSchema = z.strictObject({
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const confirmationSchema = platformAccessChangeSchema.extend({
  actorVersion: z.number().int().positive(),
  confirmation: z.literal('change-platform-access'),
  invitationIds: z.array(z.uuid()).max(50),
});

@Controller('api/platform-users')
@UseGuards(AuthGuard)
export class PlatformAccessController {
  constructor(
    private readonly access: PlatformAccessService,
    private readonly auth: AuthService,
  ) {}

  @Get()
  async list(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    await this.auth.authorize(
      request.session,
      'platform-users:read',
      { kind: 'platform' },
      request.correlationId,
    );
    const page = pageSchema.parse(query);
    return this.access.list(request.session, page.offset, page.limit);
  }

  @Get(':id')
  async read(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    await this.auth.authorize(
      request.session,
      'platform-users:read',
      { kind: 'platform' },
      request.correlationId,
    );
    return this.access.read(request.session, z.uuid().parse(id));
  }

  @Get(':id/receipts')
  async receipts(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Query() query: unknown,
  ) {
    await this.auth.authorize(
      request.session,
      'platform-users:read',
      { kind: 'platform' },
      request.correlationId,
    );
    const input = pageSchema.omit({ limit: true }).parse(query);
    return this.access.receipts(
      request.session,
      z.uuid().parse(id),
      input.offset,
    );
  }

  @Post(':id/review')
  async review(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    await this.auth.authorize(
      request.session,
      'platform-users:manage',
      { kind: 'platform' },
      request.correlationId,
    );
    return this.access.review(
      request.session,
      z.uuid().parse(id),
      platformAccessChangeSchema.parse(body),
    );
  }

  @Post(':id/access')
  async change(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    await this.auth.authorize(
      request.session,
      'platform-users:manage',
      { kind: 'platform' },
      request.correlationId,
    );
    const input = confirmationSchema.parse(body);
    return this.access.change(
      request.session,
      z.uuid().parse(id),
      input,
      input.actorVersion,
      input.invitationIds,
      request.correlationId,
    );
  }
}

import {
  Body,
  ConflictException,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import {
  deviceUpdateConfirmRequestSchema,
  deviceUpdatePreviewRequestSchema,
} from '@campus/application-contracts';
import { AuthGuard, type AuthenticatedRequest } from '../auth/auth.guard';
import { AuthService } from '../auth/auth.service';
import { DeviceUpdatesService } from './device-updates.service';
import { DevicesService } from './devices.service';

const previewIdSchema = z.uuid();
const targetsQuerySchema = z.strictObject({
  disposition: z.enum(['eligible', 'unchanged', 'excluded']).optional(),
  cursor: z.string().regex(/^\d+$/).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

@Controller('api/devices/updates')
@UseGuards(AuthGuard)
export class DeviceUpdatesController {
  private readonly devices: DevicesService;
  private readonly updates: DeviceUpdatesService;
  private readonly auth: AuthService;

  constructor(
    devices: DevicesService,
    updates: DeviceUpdatesService,
    auth: AuthService,
  ) {
    this.devices = devices;
    this.updates = updates;
    this.auth = auth;
  }

  /** Resolve the connected customer, then require the read and both write actions for it. */
  private async current(request: AuthenticatedRequest) {
    const sync = await this.devices.sync(request.session);
    if (sync)
      for (const action of [
        'devices:read',
        'devices:write',
        'devices:bulk-actions',
      ] as const)
        await this.auth.authorize(
          request.session,
          action,
          { kind: 'district', customerId: sync.customerId },
          request.correlationId,
        );
    return sync;
  }

  @Post('previews')
  async preview(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = deviceUpdatePreviewRequestSchema.parse(body);
    const current = await this.current(request);
    if (!current)
      throw new ConflictException({ reason: 'connection-required' });
    return this.updates.preview(request.session, current, input);
  }

  @Get('previews/:previewId')
  async previewById(
    @Req() request: AuthenticatedRequest,
    @Param('previewId') previewId: string,
  ) {
    const id = previewIdSchema.parse(previewId);
    await this.current(request);
    return this.updates.previewById(request.session, id);
  }

  @Get('previews/:previewId/targets')
  async targets(
    @Req() request: AuthenticatedRequest,
    @Param('previewId') previewId: string,
    @Query() query: unknown,
  ) {
    const id = previewIdSchema.parse(previewId);
    const page = targetsQuerySchema.parse(query);
    await this.current(request);
    return this.updates.targets(
      request.session,
      id,
      page.disposition,
      page.cursor,
      page.limit,
    );
  }

  @Post('previews/:previewId/confirm')
  async confirm(
    @Req() request: AuthenticatedRequest,
    @Param('previewId') previewId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const id = previewIdSchema.parse(previewId);
    const input = deviceUpdateConfirmRequestSchema.parse(body);
    const current = await this.current(request);
    if (!current)
      throw new ConflictException({ reason: 'connection-required' });
    const result = await this.updates.confirm(
      request.session,
      current,
      id,
      input,
    );
    if (result.existing) response.status(200);
    return result.receipt;
  }
}

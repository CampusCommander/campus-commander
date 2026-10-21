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
  deviceActionConfirmRequestSchema,
  deviceCommandPreviewRequestSchema,
  deviceStatusPreviewRequestSchema,
  type Action,
  type SessionResponse,
} from '@campus/application-contracts';
import { AuthGuard, type AuthenticatedRequest } from '../auth/auth.guard';
import { AuthService } from '../auth/auth.service';
import { JobService } from '../jobs/job-service';
import {
  COMMAND_PREVIEW_FAMILY,
  STATUS_PREVIEW_FAMILY,
} from './device-actions';
import { DeviceActionsService } from './device-actions.service';
import {
  DEVICE_COMMAND_ROUTE_ACTIONS,
  DEVICE_STATUS_ROUTE_ACTIONS,
  requireDeviceActions,
} from './device-updates-actions';
import { DevicesService } from './devices.service';

const previewIdSchema = z.uuid();
const targetsQuerySchema = z.strictObject({
  disposition: z.enum(['eligible', 'excluded']).optional(),
  cursor: z.string().regex(/^\d+$/).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

/** Resolve the connected customer, then require the read, Bulk Actions, and family action. */
async function resolveCustomer(
  devices: DevicesService,
  auth: AuthService,
  session: SessionResponse,
  correlationId: string,
  actions: readonly Action[],
) {
  const sync = await devices.sync(session);
  if (sync)
    await requireDeviceActions(
      auth,
      session,
      sync.customerId,
      correlationId,
      actions,
    );
  return sync;
}

/** The command family of section 7. Its body names the one command type of this build. */
@Controller('api/devices/commands')
@UseGuards(AuthGuard)
export class DeviceCommandsController {
  constructor(
    private readonly devices: DevicesService,
    private readonly actions: DeviceActionsService,
    private readonly auth: AuthService,
    private readonly jobs: JobService,
  ) {}

  private current(request: AuthenticatedRequest) {
    return resolveCustomer(
      this.devices,
      this.auth,
      request.session,
      request.correlationId,
      DEVICE_COMMAND_ROUTE_ACTIONS,
    );
  }

  @Post('previews')
  async preview(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = deviceCommandPreviewRequestSchema.parse(body);
    const current = await this.current(request);
    if (!current)
      throw new ConflictException({ reason: 'connection-required' });
    return this.actions.preview(request.session, current, 'reboot', {
      gridId: input.gridId,
      tabId: input.tabId,
    });
  }

  @Get('previews/:previewId')
  async previewById(
    @Req() request: AuthenticatedRequest,
    @Param('previewId') previewId: string,
  ) {
    const id = previewIdSchema.parse(previewId);
    await this.current(request);
    return this.actions.previewById(
      request.session,
      id,
      COMMAND_PREVIEW_FAMILY,
    );
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
    return this.actions.targets(
      request.session,
      id,
      COMMAND_PREVIEW_FAMILY,
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
    const input = deviceActionConfirmRequestSchema.parse(body);
    const current = await this.current(request);
    if (!current)
      throw new ConflictException({ reason: 'connection-required' });
    const result = await this.actions.confirm(
      request.session,
      current,
      id,
      input,
      COMMAND_PREVIEW_FAMILY,
    );
    if (result.existing) response.status(200);
    if (!result.existing)
      await this.jobs.admit(current.customerId).catch(() => undefined);
    return result.receipt;
  }
}

/** The status family of section 7. Its body names Disable or Re-enable. */
@Controller('api/devices/status-changes')
@UseGuards(AuthGuard)
export class DeviceStatusChangesController {
  constructor(
    private readonly devices: DevicesService,
    private readonly actions: DeviceActionsService,
    private readonly auth: AuthService,
    private readonly jobs: JobService,
  ) {}

  private current(request: AuthenticatedRequest) {
    return resolveCustomer(
      this.devices,
      this.auth,
      request.session,
      request.correlationId,
      DEVICE_STATUS_ROUTE_ACTIONS,
    );
  }

  @Post('previews')
  async preview(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = deviceStatusPreviewRequestSchema.parse(body);
    const current = await this.current(request);
    if (!current)
      throw new ConflictException({ reason: 'connection-required' });
    return this.actions.preview(request.session, current, input.statusAction, {
      gridId: input.gridId,
      tabId: input.tabId,
    });
  }

  @Get('previews/:previewId')
  async previewById(
    @Req() request: AuthenticatedRequest,
    @Param('previewId') previewId: string,
  ) {
    const id = previewIdSchema.parse(previewId);
    await this.current(request);
    return this.actions.previewById(request.session, id, STATUS_PREVIEW_FAMILY);
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
    return this.actions.targets(
      request.session,
      id,
      STATUS_PREVIEW_FAMILY,
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
    const input = deviceActionConfirmRequestSchema.parse(body);
    const current = await this.current(request);
    if (!current)
      throw new ConflictException({ reason: 'connection-required' });
    const result = await this.actions.confirm(
      request.session,
      current,
      id,
      input,
      STATUS_PREVIEW_FAMILY,
    );
    if (result.existing) response.status(200);
    if (!result.existing)
      await this.jobs.admit(current.customerId).catch(() => undefined);
    return result.receipt;
  }
}

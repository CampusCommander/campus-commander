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
  type DeviceAction,
  type DeviceSyncState,
  type SessionResponse,
} from '@campus/application-contracts';
import { AuthGuard, type AuthenticatedRequest } from '../auth/auth.guard';
import { AuthService } from '../auth/auth.service';
import { JobService } from '../jobs/job-service';
import {
  COMMAND_PREVIEW_ACTION,
  COMMAND_PREVIEW_FAMILY,
  STATUS_PREVIEW_FAMILY,
} from './device-actions';
import { DeviceActionsService } from './device-actions.service';
import {
  DEVICE_ACTION_ROUTE_ACTIONS,
  requireDeviceActions,
  requireDeviceAction,
} from './device-updates-actions';
import { DevicesService } from './devices.service';

const previewIdSchema = z.uuid();
const targetsQuerySchema = z.strictObject({
  disposition: z.enum(['eligible', 'excluded']).optional(),
  cursor: z.string().regex(/^\d+$/).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

/** Resolve the connected customer, then require the read and Bulk Actions pair. */
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

/**
 * The person check of one requested action. The route passes it to the service after the family
 * guard, so the service checks the action of a stored preview before it reads any job (section 2).
 */
function actionAuthorizer(
  auth: AuthService,
  request: AuthenticatedRequest,
  current: DeviceSyncState,
) {
  return (action: DeviceAction) =>
    requireDeviceAction(
      auth,
      request.session,
      current.customerId,
      request.correlationId,
      action,
    );
}

/** The command family of section 7. Its body names one of the three command types. */
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
      DEVICE_ACTION_ROUTE_ACTIONS,
    );
  }

  @Post('previews')
  async preview(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = deviceCommandPreviewRequestSchema.parse(body);
    const current = await this.current(request);
    if (!current)
      throw new ConflictException({ reason: 'connection-required' });
    return this.actions.preview(
      request.session,
      current,
      COMMAND_PREVIEW_ACTION[input.commandType],
      { gridId: input.gridId, tabId: input.tabId },
      actionAuthorizer(this.auth, request, current),
    );
  }

  @Get('previews/:previewId')
  async previewById(
    @Req() request: AuthenticatedRequest,
    @Param('previewId') previewId: string,
  ) {
    const id = previewIdSchema.parse(previewId);
    const current = await this.current(request);
    return this.actions.previewById(
      request.session,
      id,
      COMMAND_PREVIEW_FAMILY,
      current ? actionAuthorizer(this.auth, request, current) : undefined,
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
    const current = await this.current(request);
    return this.actions.targets(
      request.session,
      id,
      COMMAND_PREVIEW_FAMILY,
      page.disposition,
      page.cursor,
      page.limit,
      current ? actionAuthorizer(this.auth, request, current) : undefined,
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
      actionAuthorizer(this.auth, request, current),
    );
    if (result.existing) response.status(200);
    if (!result.existing)
      await this.jobs.admit(current.customerId).catch(() => undefined);
    return result.receipt;
  }
}

/** The status family of section 7. Its body names Disable, Re-enable, or Deprovision. */
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
      DEVICE_ACTION_ROUTE_ACTIONS,
    );
  }

  @Post('previews')
  async preview(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = deviceStatusPreviewRequestSchema.parse(body);
    const current = await this.current(request);
    if (!current)
      throw new ConflictException({ reason: 'connection-required' });
    return this.actions.preview(
      request.session,
      current,
      input.statusAction,
      { gridId: input.gridId, tabId: input.tabId },
      actionAuthorizer(this.auth, request, current),
      input.statusAction === 'deprovision' ? input.deprovisionReason : null,
    );
  }

  @Get('previews/:previewId')
  async previewById(
    @Req() request: AuthenticatedRequest,
    @Param('previewId') previewId: string,
  ) {
    const id = previewIdSchema.parse(previewId);
    const current = await this.current(request);
    return this.actions.previewById(
      request.session,
      id,
      STATUS_PREVIEW_FAMILY,
      current ? actionAuthorizer(this.auth, request, current) : undefined,
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
    const current = await this.current(request);
    return this.actions.targets(
      request.session,
      id,
      STATUS_PREVIEW_FAMILY,
      page.disposition,
      page.cursor,
      page.limit,
      current ? actionAuthorizer(this.auth, request, current) : undefined,
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
      actionAuthorizer(this.auth, request, current),
    );
    if (result.existing) response.status(200);
    if (!result.existing)
      await this.jobs.admit(current.customerId).catch(() => undefined);
    return result.receipt;
  }
}

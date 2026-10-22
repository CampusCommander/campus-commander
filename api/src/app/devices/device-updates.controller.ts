import {
  BadRequestException,
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
import { GoogleDeviceReader } from '@campus/google-connection';
import { AuthGuard, type AuthenticatedRequest } from '../auth/auth.guard';
import { AuthService } from '../auth/auth.service';
import { JobService } from '../jobs/job-service';
import { requireDeviceUpdateActions } from './device-updates-actions';
import { DeviceOrgUnitTreeRoute } from './device-org-unit-tree';
import { DeviceUpdatesService } from './device-updates.service';
import { DeviceWriteAccessRoutes } from './device-write-access-routes';
import { DeviceWriteAccessService } from './device-write-access.service';
import { DevicesService } from './devices.service';

const previewIdSchema = z.uuid();
const targetsQuerySchema = z.strictObject({
  disposition: z.enum(['eligible', 'unchanged', 'excluded']).optional(),
  // The cursor names the previous target: its device ordinal and its field position.
  cursor: z
    .string()
    .regex(/^\d{1,9}:\d{1,9}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

@Controller('api/devices/updates')
@UseGuards(AuthGuard)
export class DeviceUpdatesController {
  private readonly devices: DevicesService;
  private readonly updates: DeviceUpdatesService;
  private readonly auth: AuthService;
  private readonly writeAccess: DeviceWriteAccessRoutes;
  private readonly orgUnits: DeviceOrgUnitTreeRoute;
  private readonly jobs: JobService;

  constructor(
    devices: DevicesService,
    updates: DeviceUpdatesService,
    auth: AuthService,
    access: DeviceWriteAccessService,
    jobs: JobService,
  ) {
    this.devices = devices;
    this.updates = updates;
    this.auth = auth;
    this.writeAccess = new DeviceWriteAccessRoutes(access);
    const reader = new GoogleDeviceReader();
    this.orgUnits = new DeviceOrgUnitTreeRoute({
      connection: (session) => access.connection(session),
      authorize: (session, customerId, correlationId) =>
        requireDeviceUpdateActions(
          this.auth,
          session,
          customerId,
          correlationId,
        ),
      credential: (session, context) => access.credential(session, context),
      read: (credential, customerId, signal) =>
        reader.readOrgUnitTree(credential, customerId, signal),
    });
    this.jobs = jobs;
  }

  /** Resolve the connected customer, then require the read and both write actions for it. */
  private async current(request: AuthenticatedRequest) {
    const sync = await this.devices.sync(request.session);
    if (sync)
      await requireDeviceUpdateActions(
        this.auth,
        request.session,
        sync.customerId,
        request.correlationId,
      );
    return sync;
  }

  @Get('access')
  async access(@Req() request: AuthenticatedRequest) {
    return this.writeAccess.read(request.session, request.correlationId);
  }

  @Post('access/check')
  async accessCheck(@Req() request: AuthenticatedRequest) {
    return this.writeAccess.check(request.session, request.correlationId);
  }

  /** The organization unit tree of the connected customer (design section 6). */
  @Get('org-units')
  async orgUnitTree(@Req() request: AuthenticatedRequest) {
    return this.orgUnits.read(request.session, request.correlationId);
  }

  /**
   * A refused change names the field label and its limit (design section 1). The generic 400 body
   * of the error filter would hide that message, so this route answers the first issue.
   */
  private previewInput(body: unknown) {
    const parsed = deviceUpdatePreviewRequestSchema.safeParse(body);
    if (parsed.success) return parsed.data;
    throw new BadRequestException({
      reason: 'invalid-change',
      message: parsed.error.issues[0]?.message ?? 'The request is invalid.',
    });
  }

  @Post('previews')
  async preview(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = this.previewInput(body);
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
    // After the commit, run admission (design section 2.4). A missed run repeats on the next tick.
    if (!result.existing)
      await this.jobs.admit(current.customerId).catch(() => undefined);
    return result.receipt;
  }
}

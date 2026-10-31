import {
  Body,
  ConflictException,
  Controller,
  Get,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type {
  Action,
  DeviceExportReceipt,
  DeviceSyncState,
} from '@campus/application-contracts';
import { AuthGuard, type AuthenticatedRequest } from '../auth/auth.guard';
import { AuthService } from '../auth/auth.service';
import {
  DEVICE_EXPORT_ACTIONS,
  DEVICE_EXPORT_FILE_ACTIONS,
  deviceExportInput,
} from './device-exports';
import { DeviceExportsService } from './device-exports.service';
import { requireDeviceActions } from './device-updates-actions';
import { DevicesService } from './devices.service';

/**
 * The export routes of the device export and import workflow
 * (`docs/superpowers/specs/2026-10-28-device-export-import-design.md`, sections 1, 4, and 5).
 */
@Controller('api/devices/exports')
@UseGuards(AuthGuard)
export class DeviceExportsController {
  constructor(
    private readonly devices: DevicesService,
    private readonly exports: DeviceExportsService,
    private readonly auth: AuthService,
  ) {}

  /**
   * Resolve the connected customer, then run one person check per action in order. The caller must
   * hold every action at the customer's district scope, and the first refusal stops the request.
   */
  private async current(
    request: AuthenticatedRequest,
    actions: readonly Action[],
  ): Promise<DeviceSyncState> {
    const sync = await this.devices.sync(request.session);
    if (!sync) throw new ConflictException({ reason: 'connection-required' });
    await requireDeviceActions(
      this.auth,
      request.session,
      sync.customerId,
      request.correlationId,
      actions,
    );
    return sync;
  }

  @Post()
  async create(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<DeviceExportReceipt> {
    const input = deviceExportInput(body);
    const current = await this.current(request, DEVICE_EXPORT_ACTIONS);
    return this.exports.request(
      request.session,
      current,
      input,
      request.correlationId,
      request.headers.cookie,
    );
  }

  /**
   * Stream the published file as an attachment (design section 4). The download name comes from the
   * job, so a browser saves the file under the name that the job page shows.
   */
  @Get(':displayId/file')
  async file(
    @Req() request: AuthenticatedRequest,
    @Param('displayId') displayId: string,
    @Res() response: Response,
  ): Promise<void> {
    const current = await this.current(request, DEVICE_EXPORT_FILE_ACTIONS);
    const file = await this.exports.file(request.session, current, displayId);
    response.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${file.name}"`,
      'content-length': String(file.sizeBytes),
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    });
    // The answer has started, so a failed read can only end the transfer.
    await pipeline(Readable.from(file.stream), response).catch(() =>
      response.destroy(),
    );
  }
}

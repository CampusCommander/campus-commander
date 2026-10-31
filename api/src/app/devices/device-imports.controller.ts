import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  DEVICE_ACTION_PERMISSIONS,
  deviceImportExecuteRequestSchema,
  deviceImportPlanCancelRequestSchema,
  deviceImportReportQuerySchema,
  googleDriveImportRequestSchema,
  type Action,
  type DeviceImportExecuteAnswer,
  type DeviceImportPlanCancelAnswer,
  type DeviceImportReceipt,
  type DeviceImportReport,
  type DeviceSyncState,
  type GoogleDriveImportReceipt,
} from '@campus/application-contracts';
import {
  AcceptBody,
  AuthGuard,
  type AuthenticatedRequest,
} from '../auth/auth.guard';
import { AuthService } from '../auth/auth.service';
import {
  DEVICE_IMPORT_ACTIONS,
  DEVICE_IMPORT_DOWNLOAD_ACTIONS,
  deviceImportEmptyBodySchema,
  deviceImportUploadInput,
} from './device-imports';
import { DeviceImportExecuteService } from './device-import-execute.service';
import { DeviceImportsService } from './device-imports.service';
import { requireDeviceActions } from './device-updates-actions';
import { DevicesService } from './devices.service';

/**
 * The import routes of the device export and import workflow
 * (`docs/superpowers/specs/2026-10-28-device-export-import-design.md`, sections 1, 4, 6, and 8).
 * The upload takes the raw file. Every other route takes JSON, because `AuthGuard` refuses any
 * other body type unless the route names it.
 */
@Controller('api/devices/imports')
@UseGuards(AuthGuard)
export class DeviceImportsController {
  constructor(
    private readonly devices: DevicesService,
    private readonly imports: DeviceImportsService,
    private readonly executeFlow: DeviceImportExecuteService,
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

  /**
   * Stream the uploaded file as `text/csv` (design section 4). The route names its body type, so the
   * guard passes the raw file and refuses a JSON body here. The store receives the request stream
   * itself, so no buffer holds the file.
   */
  @Post()
  @AcceptBody('text/csv')
  async upload(
    @Req() request: AuthenticatedRequest,
    @Query() query: unknown,
  ): Promise<DeviceImportReceipt> {
    const input = deviceImportUploadInput(query);
    const current = await this.current(request, DEVICE_IMPORT_ACTIONS);
    return this.imports.upload(
      request.session,
      current,
      input,
      request,
      request.correlationId,
    );
  }

  /**
   * Create a validation job from a Drive file (design section 7). The route checks the import
   * permissions as the upload route does, then reads the file metadata as the person. A file that
   * Google refuses answers 404, a refused token answers 409 with its cause, and a file of another
   * type answers 422.
   */
  @Post('drive')
  async drive(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<GoogleDriveImportReceipt> {
    const input = googleDriveImportRequestSchema.parse(body);
    const current = await this.current(request, DEVICE_IMPORT_ACTIONS);
    return this.imports.driveImport(
      request.session,
      current,
      input,
      request.headers.cookie,
      request.correlationId,
    );
  }

  /** The counts, the refresh facts, one page of a view, and the plan (design section 1). */
  @Get(':displayId/report')
  async report(
    @Req() request: AuthenticatedRequest,
    @Param('displayId') displayId: string,
    @Query() query: unknown,
  ): Promise<DeviceImportReport> {
    const input = deviceImportReportQuerySchema.parse(query);
    const current = await this.current(request, DEVICE_IMPORT_ACTIONS);
    return this.imports.report(request.session, current, displayId, input);
  }

  /**
   * Stream the rejected rows as a CSV attachment (design section 1). The download needs the job
   * visibility and `devices:read`, and the store streams one page of source rows at a time.
   */
  @Get(':displayId/rejected')
  async rejected(
    @Req() request: AuthenticatedRequest,
    @Param('displayId') displayId: string,
    @Res() response: Response,
  ): Promise<void> {
    const current = await this.current(request, DEVICE_IMPORT_DOWNLOAD_ACTIONS);
    const file = await this.imports.rejected(
      request.session,
      current,
      displayId,
    );
    response.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${file.name}"`,
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    });
    // The answer has started, so a failed read can only end the transfer.
    await pipeline(Readable.from(file.chunks), response).catch(() =>
      response.destroy(),
    );
  }

  /** Cancel the open plan of the requester (design section 7). Nothing runs. */
  @Post(':displayId/cancel')
  async cancel(
    @Req() request: AuthenticatedRequest,
    @Param('displayId') displayId: string,
    @Body() body: unknown,
  ): Promise<DeviceImportPlanCancelAnswer> {
    const input = deviceImportPlanCancelRequestSchema.parse(body);
    const current = await this.current(request, DEVICE_IMPORT_ACTIONS);
    return this.imports.cancel(request.session, current, displayId, input);
  }

  /**
   * Execute the open plan of the named job (design section 7). The route rechecks the three import
   * actions and each status permission that the plan recorded, then one transaction runs the phrase,
   * the plan lock, the paged previews, and the links. A repeated Execute answers 200 with the stored
   * receipts of its jobs.
   */
  @Post(':displayId/execute')
  @HttpCode(200)
  async execute(
    @Req() request: AuthenticatedRequest,
    @Param('displayId') displayId: string,
    @Body() body: unknown,
  ): Promise<DeviceImportExecuteAnswer> {
    const input = deviceImportExecuteRequestSchema.parse(body);
    const current = await this.current(request, DEVICE_IMPORT_ACTIONS);
    const statuses = await this.imports.statusActions(
      request.session,
      current,
      displayId,
    );
    await requireDeviceActions(
      this.auth,
      request.session,
      current.customerId,
      request.correlationId,
      statuses.map((action) => DEVICE_ACTION_PERMISSIONS[action]),
    );
    return this.executeFlow.execute(
      request.session,
      current,
      displayId,
      input,
      request.correlationId,
    );
  }

  /** Validate the stored file of the named job again (state 19). */
  @Post(':displayId/revalidate')
  async revalidate(
    @Req() request: AuthenticatedRequest,
    @Param('displayId') displayId: string,
    @Body() body: unknown,
  ): Promise<DeviceImportReceipt> {
    deviceImportEmptyBodySchema.parse(body);
    const current = await this.current(request, DEVICE_IMPORT_ACTIONS);
    return this.imports.revalidate(
      request.session,
      current,
      displayId,
      request.correlationId,
    );
  }
}

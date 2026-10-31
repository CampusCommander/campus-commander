import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  googleDriveSessionRequestSchema,
  type GoogleDriveAccess,
  type GoogleDriveSession,
  type GoogleDriveTabList,
} from '@campus/application-contracts';
import { AuthGuard, type AuthenticatedRequest } from '../auth/auth.guard';
import { DriveService } from './drive.service';

/**
 * The three Drive routes of the devices dialog
 * (`docs/superpowers/specs/2026-10-30-device-drive-slice-design.md`, sections 1, 4, and 5).
 *
 * The access read checks `devices:read` in the store. The session and tab list routes check the
 * import permissions at the connected customer's district. The session answer carries the token
 * once, and every response of the application carries `cache-control: no-store`.
 */
@Controller('api/google/drive')
@UseGuards(AuthGuard)
export class DriveController {
  constructor(private readonly drive: DriveService) {}

  /** The access of a Sheet export and a Drive import (design section 1). */
  @Get()
  access(@Req() request: AuthenticatedRequest): Promise<GoogleDriveAccess> {
    return this.drive.access(request.session, request.headers.cookie);
  }

  /** One `drive.file` token for the session subject (design section 4). */
  @Post('session')
  @HttpCode(200)
  session(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<GoogleDriveSession> {
    googleDriveSessionRequestSchema.parse(body);
    return this.drive.session(
      request.session,
      request.headers.cookie,
      request.correlationId,
    );
  }

  /** The tabs of one Sheet, read as the session subject (design section 1). */
  @Get('files/:fileId/tabs')
  tabs(
    @Req() request: AuthenticatedRequest,
    @Param('fileId') fileId: string,
  ): Promise<GoogleDriveTabList> {
    return this.drive.tabs(
      request.session,
      request.headers.cookie,
      fileId,
      request.correlationId,
    );
  }
}

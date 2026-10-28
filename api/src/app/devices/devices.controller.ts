import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import {
  deviceByIdsSchema,
  deviceDomainRefreshSchema,
  deviceGroupQuerySchema,
  deviceQuerySchema,
  deviceSelectionChangeSchema,
  deviceSelectionKeySchema,
  deviceSelectionRefreshSchema,
  deviceSelectionResolveSchema,
  entityEventSchema,
  entityEventsChannel,
  type EntityEvent,
  type SessionResponse,
} from '@campus/application-contracts';
import { AuthGuard, type AuthenticatedRequest } from '../auth/auth.guard';
import { AuthService } from '../auth/auth.service';
import { GoogleConnectionService } from '../auth/google-connection.service';
import { DeviceEventsService } from './device-events.service';
import { streamEvents } from './device-events';
import { DeviceDomainRefresh } from './device-domain-refresh';
import { selectionRefreshStatus } from './device-selection-refresh';
import { deviceForward, recheckDeviceStream } from './device-stream';
import { DevicesService } from './devices.service';

const deviceIdSchema = z.string().min(1).max(128);

/** The entity channel and its schema. The Devices stream forwards the events of section 3.1. */
const entityListener = {
  channel: entityEventsChannel,
  parse: (message: string): EntityEvent | null => {
    try {
      const parsed = entityEventSchema.safeParse(JSON.parse(message));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  },
};

@Controller('api/devices')
@UseGuards(AuthGuard)
export class DevicesController {
  private readonly domainRefresh: DeviceDomainRefresh;

  constructor(
    private readonly devices: DevicesService,
    private readonly auth: AuthService,
    private readonly deviceEvents: DeviceEventsService,
    connection: GoogleConnectionService,
  ) {
    this.domainRefresh = new DeviceDomainRefresh({
      authorize: (session, customerId, correlationId) =>
        this.auth.authorize(
          session,
          'connection:diagnose',
          { kind: 'district', customerId },
          correlationId,
        ),
      requestSync: (session, current, correlationId) =>
        this.devices.requestSync(session, current, correlationId),
      checkHealth: (
        session,
        customerId,
        generation,
        capabilities,
        correlationId,
      ) =>
        connection.checkHealth(
          session,
          { customerId, generation, capabilities },
          correlationId,
        ),
    });
  }

  /** Resolve the connected customer, then require devices:read for it. */
  private async current(request: AuthenticatedRequest) {
    return this.currentFor(request.session, request.correlationId);
  }

  private async currentFor(session: SessionResponse, correlationId: string) {
    const sync = await this.devices.sync(session);
    if (sync)
      await this.auth.authorize(
        session,
        'devices:read',
        { kind: 'district', customerId: sync.customerId },
        correlationId,
      );
    return sync;
  }

  @Get('sync')
  async sync(@Req() request: AuthenticatedRequest) {
    return { sync: await this.current(request) };
  }

  @Post('sync')
  async requestSync(@Req() request: AuthenticatedRequest) {
    const current = await this.current(request);
    if (!current)
      throw new ConflictException({ reason: 'connection-required' });
    return {
      sync: await this.devices.requestSync(
        request.session,
        current,
        request.correlationId,
      ),
    };
  }

  @Post('query')
  @HttpCode(200)
  async query(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = deviceQuerySchema.parse(body);
    await this.current(request);
    return {
      page: await this.devices.page(
        request.session,
        input,
        request.correlationId,
      ),
    };
  }

  @Post('groups')
  @HttpCode(200)
  async groups(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = deviceGroupQuerySchema.parse(body);
    await this.current(request);
    return { groups: await this.devices.groups(request.session, input) };
  }

  /** Rows that a refresh signal names. The client sends only the rows its grid holds (D7). */
  @Post('by-ids')
  @HttpCode(200)
  async byIds(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = deviceByIdsSchema.parse(body);
    await this.current(request);
    return {
      rows: await this.devices.rowsById(request.session, input.deviceIds),
    };
  }

  @Post('freshness')
  @HttpCode(200)
  async freshness(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = deviceQuerySchema.parse(body);
    await this.current(request);
    return {
      freshness: await this.devices.freshness(request.session, input),
    };
  }

  @Post('selection')
  @HttpCode(200)
  async selection(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const key = deviceSelectionKeySchema.parse(body);
    await this.current(request);
    return { selection: await this.devices.selection(request.session, key) };
  }

  @Post('selection/ops')
  @HttpCode(200)
  async changeSelection(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ) {
    const input = deviceSelectionChangeSchema.parse(body);
    await this.current(request);
    return {
      selection: await this.devices.changeSelection(
        request.session,
        { gridId: input.gridId, tabId: input.tabId },
        input.ops,
      ),
    };
  }

  @Post('selection/resolve')
  @HttpCode(200)
  async resolveSelection(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ) {
    const input = deviceSelectionResolveSchema.parse(body);
    await this.current(request);
    return {
      selected: await this.devices.resolveSelection(
        request.session,
        { gridId: input.gridId, tabId: input.tabId },
        input.rowIds,
        input.groupRoutes,
        input.predicates,
        input.by,
      ),
    };
  }

  /** Re-read the selected devices from Google. The get-by-IDs pipeline is unchanged. */
  @Post('selection/refresh')
  async refreshSelection(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const key = deviceSelectionKeySchema.parse(body);
    const current = await this.current(request);
    if (!current)
      throw new ConflictException({ reason: 'connection-required' });
    const refresh = deviceSelectionRefreshSchema.parse(
      await this.devices.refreshSelection(
        request.session,
        current.customerId,
        key,
        request.correlationId,
      ),
    );
    // A fully claimed selection starts no job and answers 200.
    response.status(selectionRefreshStatus(refresh));
    return { refresh };
  }

  /** Run the full device sync, then re-read the domain details. */
  @Post('domain/refresh')
  async refreshDomain(@Req() request: AuthenticatedRequest) {
    const current = await this.current(request);
    if (!current)
      throw new ConflictException({ reason: 'connection-required' });
    return {
      refresh: deviceDomainRefreshSchema.parse(
        await this.domainRefresh.request(
          request.session,
          current,
          request.correlationId,
        ),
      ),
    };
  }

  @Get('org-units')
  async orgUnits(@Req() request: AuthenticatedRequest) {
    await this.current(request);
    return { orgUnits: await this.devices.orgUnits(request.session) };
  }

  /** Server-Sent Events for this customer's device refreshes (D6, D12). */
  @Get('events')
  async events(
    @Req() request: AuthenticatedRequest,
    @Res() response: Response,
  ): Promise<void> {
    const current = await this.current(request);
    if (!current)
      throw new ConflictException({ reason: 'connection-required' });
    // A holder of jobs:read or jobs:manage at platform or district scope receives every failure.
    const seesEveryJob = this.devices.jobVisibility(
      request.session,
      current.customerId,
    );
    const started = await streamEvents<EntityEvent>(response, {
      customerId: current.customerId,
      fanout: this.deviceEvents.fanout,
      listener: entityListener,
      begin: () => {
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          'x-accel-buffering': 'no',
        });
      },
      // A ping goes out only while the session and devices:read still hold for this customer, and
      // while its jobs:read visibility is unchanged.
      // The recheck leaves the idle timeout alone. An open tab must not keep an unattended session alive.
      recheck: async () => {
        const checked = await recheckDeviceStream({
          auth: this.auth,
          reads: {
            current: (session) =>
              this.currentFor(session, request.correlationId),
            jobVisibility: (session, customerId) =>
              this.devices.jobVisibility(session, customerId),
          },
          cookie: request.headers.cookie,
          correlationId: request.correlationId,
          customerId: current.customerId,
          seesEveryJob,
        });
        if (checked.session) request.session = checked.session;
        return checked.allowed;
      },
      // Section 3.1: no job ID, no job record, no requester, and no failure that the caller cannot see.
      forward: deviceForward(seesEveryJob, {
        jobFailure: (jobId) =>
          this.devices.jobFailure(request.session, current.customerId, jobId),
        sync: () => this.devices.sync(request.session),
      }),
    });
    if (!started && !response.headersSent)
      throw new ServiceUnavailableException({ reason: 'events-unavailable' });
  }

  @Get(':deviceId')
  async device(
    @Req() request: AuthenticatedRequest,
    @Param('deviceId') deviceId: string,
  ) {
    const id = deviceIdSchema.parse(deviceId);
    await this.current(request);
    return { device: await this.devices.device(request.session, id) };
  }
}

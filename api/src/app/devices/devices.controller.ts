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
  deviceGroupQuerySchema,
  deviceQuerySchema,
  deviceSelectionChangeSchema,
  deviceSelectionKeySchema,
  deviceSelectionResolveSchema,
} from '@campus/application-contracts';
import { AuthGuard, type AuthenticatedRequest } from '../auth/auth.guard';
import { AuthService } from '../auth/auth.service';
import { DeviceEventsService } from './device-events.service';
import { streamEvents } from './device-events';
import { DevicesService } from './devices.service';

const deviceIdSchema = z.string().min(1).max(128);

@Controller('api/devices')
@UseGuards(AuthGuard)
export class DevicesController {
  constructor(
    private readonly devices: DevicesService,
    private readonly auth: AuthService,
    private readonly deviceEvents: DeviceEventsService,
  ) {}

  /** Resolve the connected customer, then require devices:read for it. */
  private async current(request: AuthenticatedRequest) {
    const sync = await this.devices.sync(request.session);
    if (sync)
      await this.auth.authorize(
        request.session,
        'devices:read',
        { kind: 'district', customerId: sync.customerId },
        request.correlationId,
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
    const started = await streamEvents(response, {
      customerId: current.customerId,
      fanout: this.deviceEvents.fanout,
      begin: () => {
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          'x-accel-buffering': 'no',
        });
      },
      // A ping goes out only while the session and devices:read still hold for this customer.
      recheck: async () => {
        try {
          request.session = await this.auth.authenticate(
            request.headers.cookie,
            'identity:read',
            request.correlationId,
          );
          return (await this.current(request))?.customerId === current.customerId;
        } catch {
          return false;
        }
      },
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

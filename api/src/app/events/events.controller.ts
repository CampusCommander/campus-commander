import {
  Controller,
  ForbiddenException,
  Get,
  Req,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import type {
  DeviceSyncState,
  EntityEvent,
  JobEvent,
  SessionResponse,
} from '@campus/application-contracts';
import { AuthGuard, type AuthenticatedRequest } from '../auth/auth.guard';
import { AuthService } from '../auth/auth.service';
import { ConfigurationService } from '../configuration/configuration.service';
import { DeviceEventsService } from '../devices/device-events.service';
import { streamEvents, type StreamFeed } from '../devices/device-events';
import { deviceForward } from '../devices/device-stream';
import { entityListener } from '../devices/devices.controller';
import { DevicesService } from '../devices/devices.service';
import { seesEveryJob } from '../jobs/jobs';
import { jobListener } from '../jobs/jobs.controller';
import { JobsService } from '../jobs/jobs.service';
import {
  deviceReadable,
  recheckEventStream,
} from './events-stream';

/** One event of the one stream. The two feeds read disjoint channel schemas. */
type StreamEvent = JobEvent | EntityEvent;

@Controller('api/events')
@UseGuards(AuthGuard)
export class EventsController {
  constructor(
    private readonly jobs: JobsService,
    private readonly devices: DevicesService,
    private readonly auth: AuthService,
    private readonly deviceEvents: DeviceEventsService,
    private readonly configuration: ConfigurationService,
  ) {}

  /** Server-Sent Events for the job feed and the device feed of this caller. */
  @Get()
  async events(
    @Req() request: AuthenticatedRequest,
    @Res() response: Response,
  ): Promise<void> {
    // The job feed opens under the open rule of the Jobs stream, and its refusal is this route's.
    const customerId = await this.jobs.customer(request.session);
    const everyJob = seesEveryJob(request.session, customerId);
    const device = await this.deviceFeed(
      request.session,
      customerId,
      request.correlationId,
    );
    // A holder of jobs:read or jobs:manage at platform or district scope receives every failure.
    const deviceEveryJob = device
      ? this.devices.jobVisibility(request.session, customerId)
      : false;
    const forwardDevice = deviceForward(deviceEveryJob, {
      jobFailure: (jobId) =>
        this.devices.jobFailure(request.session, customerId, jobId),
      sync: () => this.devices.sync(request.session),
    });
    const feeds: StreamFeed<StreamEvent>[] = [
      {
        listener: jobListener,
        forward: async (event, failed) => {
          if (failed || event.type !== 'job-changed') return null;
          if (everyJob) return { event };
          // The same predicate as every job read decides the event of another person's job.
          const visible = await this.jobs.visible(
            request.session,
            customerId,
            event.requestedBy,
          );
          return visible ? { event } : null;
        },
      },
    ];
    // A caller without devices:read, or a customer without a sync, receives the job feed alone.
    if (device)
      feeds.push({
        listener: entityListener,
        // Section 3.1: no job ID, no job record, no requester, and no failure that the caller cannot see.
        forward: (event, failed) => {
          if (event.type === 'job-changed') return null;
          return forwardDevice(event, failed);
        },
      });
    const started = await streamEvents<StreamEvent>(response, {
      customerId,
      fanout: this.deviceEvents.fanout,
      feeds,
      begin: () => {
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          'x-accel-buffering': 'no',
        });
      },
      // One ping interval for both feeds (scope item 6). The rechecks leave the idle timeout alone,
      // so an open tab never keeps an unattended session alive.
      recheck: async () => {
        const checked = await recheckEventStream({
          auth: this.auth,
          jobs: this.jobs,
          cookie: request.headers.cookie,
          correlationId: request.correlationId,
          customerId,
          everyJob,
          device: device
            ? {
                seesEveryJob: deviceEveryJob,
                current: (session) =>
                  this.opened(session, customerId, request.correlationId),
                jobVisibility: (session, id) =>
                  this.devices.jobVisibility(session, id),
              }
            : null,
          canOpenDevice: (session) => this.canOpenDevice(session, customerId),
        });
        if (checked.session) request.session = checked.session;
        return checked.allowed;
      },
    });
    if (!started && !response.headersSent)
      throw new ServiceUnavailableException({ reason: 'events-unavailable' });
  }

  /**
   * The device feed of this stream, or null when the caller cannot open it and the stream carries
   * the job feed alone. Every other failure of the open refuses the stream, as the Devices stream
   * refuses it.
   */
  private async deviceFeed(
    session: SessionResponse,
    customerId: string,
    correlationId: string,
  ): Promise<DeviceSyncState | null> {
    try {
      return await this.opened(session, customerId, correlationId);
    } catch (error) {
      if (error instanceof ForbiddenException) return null;
      throw error;
    }
  }

  /** The sync of the customer, after devices:read for it. A customer without a sync reads null. */
  private async opened(
    session: SessionResponse,
    customerId: string,
    correlationId: string,
  ): Promise<DeviceSyncState | null> {
    const sync = await this.devices.sync(session);
    if (sync?.customerId !== customerId) return null;
    await this.auth.authorize(
      session,
      'devices:read',
      { kind: 'district', customerId },
      correlationId,
    );
    return sync;
  }

  /** True when the caller can now open the device feed that this stream leaves out. */
  private async canOpenDevice(
    session: SessionResponse,
    customerId: string,
  ): Promise<boolean> {
    if (!deviceReadable(this.configuration.deployment?.phase, session, customerId))
      return false;
    const sync = await this.devices.sync(session);
    return sync?.customerId === customerId;
  }
}
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import {
  jobActionSchema,
  jobDisplayIdSchema,
  jobEventSchema,
  jobEventsChannel,
  jobStatusSchema,
  type JobEvent,
} from '@campus/application-contracts';
import { AuthGuard, type AuthenticatedRequest } from '../auth/auth.guard';
import { AuthService } from '../auth/auth.service';
import { DeviceEventsService } from '../devices/device-events.service';
import { streamEvents } from '../devices/device-events';
import { requireReconcileActions } from '../devices/device-updates-actions';
import { OrchestrationService } from '../orchestration/orchestration.service';
import { JobsService } from './jobs.service';
import { operationCursorSchema, seesEveryJob } from './jobs';
import { recheckJobStream } from './jobs-stream';

/** A repeated query key or a comma-separated value. */
const many = <Schema extends z.ZodTypeAny>(schema: Schema, max = 100) =>
  z
    .preprocess(
      (value) =>
        value === undefined
          ? undefined
          : Array.isArray(value)
            ? value
            : String(value).split(','),
      z.array(schema).max(max),
    )
    .optional();

const listQuerySchema = z.strictObject({
  jobId: jobDisplayIdSchema.optional(),
  status: many(jobStatusSchema),
  action: many(jobActionSchema),
  entityType: many(z.literal('device')),
  requestedBy: many(z.uuid()),
  createdFrom: z.iso.datetime({ offset: true }).optional(),
  createdTo: z.iso.datetime({ offset: true }).optional(),
  finishedFrom: z.iso.datetime({ offset: true }).optional(),
  finishedTo: z.iso.datetime({ offset: true }).optional(),
  cursor: z.string().min(1).max(1024).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/** One operation number names one stored operation. `all` belongs to the flow, never to this route. */
const operationNumberSchema = z.coerce.number().int().min(1).max(2_147_483_647);

const operationsQuerySchema = z.strictObject({
  attention: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  // The operation numbers of the changes on one results page. The dialog reads them in one call
  // (design section 8), so the route bounds the list at ten.
  number: many(operationNumberSchema, 10),
  // The route answers "<operation>:<fieldPosition>", so it accepts the cursor that it returned.
  cursor: operationCursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

const requestersQuerySchema = z.strictObject({
  query: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(20).optional(),
});

/** The cancel request carries no revision, so its body is an empty strict object (design section 1). */
const cancelBodySchema = z.strictObject({});

/** The job channel and its schema. The Jobs stream sends `job-changed` only. */
export const jobListener = {
  channel: jobEventsChannel,
  parse: (message: string): JobEvent | null => {
    try {
      const parsed = jobEventSchema.safeParse(JSON.parse(message));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  },
};

@Controller('api/jobs')
@UseGuards(AuthGuard)
export class JobsController {
  constructor(
    private readonly jobs: JobsService,
    private readonly auth: AuthService,
    private readonly deviceEvents: DeviceEventsService,
    private readonly orchestration: OrchestrationService,
  ) {}

  @Get()
  async list(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    const input = listQuerySchema.parse(query);
    const customerId = await this.jobs.customer(request.session);
    return this.jobs.list(
      request.session,
      customerId,
      input,
      input.cursor,
      input.limit,
    );
  }

  @Get('activity')
  async activity(@Req() request: AuthenticatedRequest) {
    const customerId = await this.jobs.customer(request.session);
    return this.jobs.activity(request.session, customerId);
  }

  @Post('activity/seen')
  @HttpCode(200)
  async seen(@Req() request: AuthenticatedRequest) {
    await this.jobs.customer(request.session);
    return this.jobs.seen(request.session);
  }

  @Get('requesters')
  async requesters(
    @Req() request: AuthenticatedRequest,
    @Query() query: unknown,
  ) {
    const input = requestersQuerySchema.parse(query);
    const customerId = await this.jobs.customer(request.session);
    return this.jobs.requesters(
      request.session,
      customerId,
      input.query ?? '',
      input.limit,
    );
  }

  /** Server-Sent Events for this customer's visible jobs (section 3.3). */
  @Get('events')
  async events(
    @Req() request: AuthenticatedRequest,
    @Res() response: Response,
  ): Promise<void> {
    const customerId = await this.jobs.customer(request.session);
    const everyJob = seesEveryJob(request.session, customerId);
    const started = await streamEvents<JobEvent>(response, {
      customerId,
      fanout: this.deviceEvents.fanout,
      feeds: [
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
      ],
      begin: () => {
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          'x-accel-buffering': 'no',
        });
      },
      // A ping goes out only while the session and its read actions still hold for this customer.
      recheck: async () => {
        const checked = await recheckJobStream({
          auth: this.auth,
          jobs: this.jobs,
          cookie: request.headers.cookie,
          correlationId: request.correlationId,
          customerId,
          everyJob,
        });
        if (checked.session) request.session = checked.session;
        return checked.allowed;
      },
    });
    if (!started && !response.headersSent)
      throw new ServiceUnavailableException({ reason: 'events-unavailable' });
  }

  @Get(':displayId')
  async detail(
    @Req() request: AuthenticatedRequest,
    @Param('displayId') displayId: string,
  ) {
    const id = jobDisplayIdSchema.parse(displayId);
    const customerId = await this.jobs.customer(request.session);
    return this.jobs.detail(request.session, customerId, id);
  }

  @Get(':displayId/operations')
  async operations(
    @Req() request: AuthenticatedRequest,
    @Param('displayId') displayId: string,
    @Query() query: unknown,
  ) {
    const input = operationsQuerySchema.parse(query);
    const id = jobDisplayIdSchema.parse(displayId);
    const customerId = await this.jobs.customer(request.session);
    return this.jobs.operations(
      request.session,
      customerId,
      id,
      input.attention === true,
      input.cursor,
      input.limit,
      input.number,
    );
  }

  /** Request the cancel of one job (design section 5). The SQL function decides every refusal. */
  @Post(':displayId/cancel')
  @HttpCode(200)
  async cancel(
    @Req() request: AuthenticatedRequest,
    @Param('displayId') displayId: string,
    @Body() body: unknown,
  ) {
    cancelBodySchema.parse(body ?? {});
    const id = jobDisplayIdSchema.parse(displayId);
    const customerId = await this.jobs.customer(request.session);
    return this.jobs.cancel(
      request.session,
      customerId,
      id,
      request.correlationId,
    );
  }

  /** Start the read-back of one `unknown` operation (design section 2.6). */
  @Post(':displayId/operations/:operationNumber/reconcile')
  @HttpCode(202)
  async reconcile(
    @Req() request: AuthenticatedRequest,
    @Param('displayId') displayId: string,
    @Param('operationNumber') operationNumber: string,
  ) {
    const id = jobDisplayIdSchema.parse(displayId);
    const number = operationNumberSchema.parse(operationNumber);
    const customerId = await this.jobs.customer(request.session);
    return this.jobs.reconcile(
      request.session,
      customerId,
      id,
      number,
      request.correlationId,
      this.orchestration,
      (check) =>
        requireReconcileActions(
          this.auth,
          request.session,
          customerId,
          request.correlationId,
          check,
        ),
    );
  }
}

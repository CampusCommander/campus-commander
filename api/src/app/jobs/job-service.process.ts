import {
  Injectable,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import {
  jobEventSchema,
  jobEventsChannel,
  type JobEvent,
} from '@campus/application-contracts';
import { DeviceEventsService } from '../devices/device-events.service';
import { JOB_RELAY_MS, JOB_TICK_MS, JobService } from './job-service';

/**
 * The timers and the job channel listener of the one job service instance (design section 6.5).
 * The tick and the relay run on their own timers, so a slow tick never delays the relay
 * (design section 3.6).
 */
@Injectable()
export class JobServiceProcess
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  readonly jobs: JobService;
  private readonly events: DeviceEventsService;
  private ticker?: ReturnType<typeof setInterval>;
  private relayer?: ReturnType<typeof setInterval>;
  private readonly listening = new Set<string>();
  private removers: (() => Promise<void>)[] = [];

  constructor(jobs: JobService, events: DeviceEventsService) {
    this.jobs = jobs;
    this.events = events;
  }

  onApplicationBootstrap(): void {
    this.ticker = setInterval(() => {
      void this.tick();
    }, JOB_TICK_MS);
    this.relayer = setInterval(() => {
      // The relay never rejects: a failed run keeps its rows for the next tick.
      void this.jobs.relay().catch(() => undefined);
    }, JOB_RELAY_MS);
    this.ticker.unref?.();
    this.relayer.unref?.();
  }

  private async tick() {
    await this.jobs.tick().catch(() => undefined);
    await this.listen();
  }

  /** A terminal `job-changed` cleans the hold at once. The tick repeats the work. */
  private async listen() {
    for (const customerId of await this.jobs.customers().catch(() => [])) {
      if (this.listening.has(customerId)) continue;
      this.listening.add(customerId);
      try {
        const remove = await this.events.fanout.listen<JobEvent>(customerId, {
          channel: jobEventsChannel,
          parse: (message) => {
            try {
              const parsed = jobEventSchema.safeParse(JSON.parse(message));
              return parsed.success ? parsed.data : null;
            } catch {
              return null;
            }
          },
          event: (event) => {
            void this.jobs
              .changed(customerId, event.jobId)
              .catch(() => undefined);
          },
          close: () => {
            this.listening.delete(customerId);
          },
        });
        this.removers.push(remove);
      } catch {
        this.listening.delete(customerId);
      }
    }
  }

  async onApplicationShutdown(): Promise<void> {
    clearInterval(this.ticker);
    clearInterval(this.relayer);
    this.ticker = undefined;
    this.relayer = undefined;
    const removers = this.removers;
    this.removers = [];
    // DeviceEventsService owns the subscriber connection, so this process only removes its listeners.
    for (const remove of removers) await remove().catch(() => undefined);
  }
}

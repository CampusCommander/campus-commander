import { BeforeApplicationShutdown, Injectable } from '@nestjs/common';
import { CacheService } from '../cache/cache.service';
import { EventFanout, redisSubscriber } from './device-events';

/** One Redis subscriber connection per API instance (D6). */
@Injectable()
export class DeviceEventsService implements BeforeApplicationShutdown {
  readonly fanout: EventFanout;

  constructor(cache: CacheService) {
    this.fanout = new EventFanout(async (lost) => {
      const client = cache.subscriber();
      if (!client) throw new Error('The event service is unavailable.');
      return redisSubscriber(client, lost);
    });
  }

  /** Nest closes the HTTP server after this hook. Open streams would hold it open. */
  async beforeApplicationShutdown() {
    await this.fanout.close();
  }
}

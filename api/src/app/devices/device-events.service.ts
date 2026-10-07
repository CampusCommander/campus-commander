import { BeforeApplicationShutdown, Injectable } from '@nestjs/common';
import { CacheService } from '../cache/cache.service';
import { EventFanout } from './device-events';

/** One Redis subscriber connection per API instance (D6). */
@Injectable()
export class DeviceEventsService implements BeforeApplicationShutdown {
  readonly fanout: EventFanout;

  constructor(cache: CacheService) {
    this.fanout = new EventFanout(async (lost) => {
      const client = cache.subscriber();
      if (!client) throw new Error('The event service is unavailable.');
      // The client does not reconnect. A lost connection closes every stream, and the next stream reconnects.
      client.on('error', lost);
      client.on('end', lost);
      await client.connect();
      return {
        subscribe: async (channel, onMessage) => {
          await client.subscribe(channel, (message) => onMessage(String(message)));
        },
        unsubscribe: async (channel) => {
          await client.unsubscribe(channel);
        },
        close: async () => {
          if (client.isOpen) client.destroy();
        },
      };
    });
  }

  /** Nest closes the HTTP server after this hook. Open streams would hold it open. */
  async beforeApplicationShutdown() {
    await this.fanout.close();
  }
}

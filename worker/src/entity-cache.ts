import { createClient } from 'redis';

export class EntityCacheError extends Error {
  readonly code = 'cache-unavailable';
  constructor() {
    super('cache-unavailable');
    this.name = 'EntityCacheError';
  }
}

/** The worker's view of Redis: records, in-flight IDs, the query generation, and events. */
export interface EntityCache {
  setRecords(
    entries: { key: string; value: string }[],
    seconds: number,
  ): Promise<void>;
  remove(keys: string[]): Promise<void>;
  removeMembers(key: string, members: string[]): Promise<void>;
  increment(key: string): Promise<void>;
  publish(channel: string, message: string): Promise<void>;
  close(): Promise<void>;
}

/** A cache that writes nothing. A full sync uses it when the Redis configuration or secret is missing. */
export const noEntityCache: EntityCache = {
  setRecords: async () => undefined,
  remove: async () => undefined,
  removeMembers: async () => undefined,
  increment: async () => undefined,
  publish: async () => undefined,
  close: async () => undefined,
};

const chunk = 500;

export class WorkerRedis implements EntityCache {
  private readonly client;
  private connecting?: Promise<void>;

  constructor(options: {
    url: string;
    password: string;
    tls: { servername: string; ca?: Buffer } | null;
  }) {
    const url = new URL(options.url);
    this.client = createClient({
      username: 'worker',
      password: options.password,
      disableOfflineQueue: true,
      commandsQueueMaxLength: 1000,
      commandOptions: { timeout: 3000 },
      socket: {
        host: url.hostname,
        port: Number(url.port || 6379),
        connectTimeout: 3000,
        reconnectStrategy: false,
        ...(options.tls
          ? {
              tls: true as const,
              servername: options.tls.servername,
              rejectUnauthorized: true,
              ...(options.tls.ca ? { ca: options.tls.ca } : {}),
            }
          : {}),
      },
    });
    this.client.on('error', () => {
      /* Batch runners report cache-unavailable. */
    });
  }

  private async run<T>(
    work: (client: NonNullable<WorkerRedis['client']>) => Promise<T>,
  ): Promise<T> {
    try {
      if (!this.client.isReady) {
        this.connecting ??= this.client
          .connect()
          .then(() => undefined)
          .finally(() => {
            this.connecting = undefined;
          });
        await this.connecting;
      }
      return await work(this.client);
    } catch {
      if (this.client.isOpen) this.client.destroy();
      throw new EntityCacheError();
    }
  }

  async setRecords(entries: { key: string; value: string }[], seconds: number) {
    for (let start = 0; start < entries.length; start += chunk) {
      await this.run(async (client) => {
        const multi = client.multi();
        for (const entry of entries.slice(start, start + chunk))
          multi.set(entry.key, entry.value, { EX: seconds });
        await multi.exec();
      });
    }
  }

  async remove(keys: string[]) {
    if (keys.length) await this.run((client) => client.del(keys));
  }

  async removeMembers(key: string, members: string[]) {
    if (members.length) await this.run((client) => client.sRem(key, members));
  }

  async increment(key: string) {
    await this.run((client) => client.incr(key));
  }

  async publish(channel: string, message: string) {
    await this.run((client) => client.publish(channel, message));
  }

  async close() {
    if (this.client.isOpen) this.client.destroy();
  }
}

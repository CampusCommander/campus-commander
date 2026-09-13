import {
  Injectable,
  OnApplicationShutdown,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createClient } from 'redis';
import { ConfigurationService } from '../configuration/configuration.service';

@Injectable()
export class CacheService implements OnApplicationShutdown {
  private readonly client;
  private connecting?: Promise<void>;

  constructor(configuration: ConfigurationService) {
    const service = configuration.deployment?.services.redis;
    if (!service || !configuration.deployment?.applicationAuth) return;
    const url = new URL(service.endpoint.url);
    const transport = service.endpoint.tls;
    this.client = createClient({
      username: 'default',
      password: configuration
        .secret(service.passwordSecretRef)
        .toString('utf8'),
      disableOfflineQueue: true,
      commandsQueueMaxLength: 100,
      commandOptions: { timeout: 3000 },
      socket: {
        host: url.hostname,
        port: Number(url.port || 6379),
        connectTimeout: 3000,
        reconnectStrategy: false,
        ...(transport.mode !== 'disabled'
          ? {
              tls: true as const,
              servername: url.hostname,
              rejectUnauthorized: true,
              ...(transport.mode === 'private-ca'
                ? { ca: configuration.secret(transport.caSecretRef) }
                : {}),
            }
          : {}),
      },
    });
    this.client.on('error', () => {
      /* Authentication fails closed when Redis fails. */
    });
  }

  private async connection() {
    if (!this.client)
      throw new ServiceUnavailableException(
        'The session service is unavailable.',
      );
    if (!this.client.isReady) {
      this.connecting ??= this.client
        .connect()
        .then(() => undefined)
        .finally(() => {
          this.connecting = undefined;
        });
      await this.connecting;
    }
    return this.client;
  }

  private async execute<T>(
    run: (client: NonNullable<CacheService['client']>) => Promise<T>,
  ): Promise<T> {
    const client = await this.connection();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        run(client),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            if (client.isOpen) client.destroy();
            reject(
              new ServiceUnavailableException('The session service timed out.'),
            );
          }, 3000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async get(key: string) {
    return this.execute((client) => client.get(key));
  }
  async consume(key: string) {
    return this.execute((client) => client.getDel(key));
  }
  async set(key: string, value: string, seconds: number) {
    return this.execute((client) => client.set(key, value, { EX: seconds }));
  }
  async reserve(key: string, owner: string, seconds: number) {
    return this.execute((client) =>
      client.set(key, owner, { EX: seconds, NX: true }),
    );
  }
  async release(key: string, owner: string) {
    return this.execute((client) =>
      client.eval(
        "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
        { keys: [key], arguments: [owner] },
      ),
    );
  }
  async remove(key: string) {
    return this.execute((client) => client.del(key));
  }
  async replace(key: string, expected: string, value: string) {
    return this.execute((client) =>
      client.eval(
        "local ttl=redis.call('TTL',KEYS[1]); if ttl>0 and redis.call('GET',KEYS[1])==ARGV[1] then redis.call('SET',KEYS[1],ARGV[2],'EX',ttl); return 1 end return 0",
        { keys: [key], arguments: [expected, value] },
      ),
    );
  }
  async expire(key: string, seconds: number) {
    return this.execute((client) => client.expire(key, seconds));
  }
  async onApplicationShutdown() {
    if (this.client?.isOpen) this.client.destroy();
  }
}

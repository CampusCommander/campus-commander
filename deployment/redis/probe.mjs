import net from 'node:net';
import tls from 'node:tls';
import { readFile } from 'node:fs/promises';
import { secretPath } from './runtime.mjs';

function command(parts) {
  const chunks = [Buffer.from(`*${parts.length}\r\n`)];
  for (const part of parts) {
    const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part);
    chunks.push(
      Buffer.from(`$${bytes.length}\r\n`),
      bytes,
      Buffer.from('\r\n'),
    );
  }
  return Buffer.concat(chunks);
}

/** Verify authentication and TLS before reporting Redis readiness. */
export async function probeRedis(
  service,
  resolveSecret = (ref) => readFile(secretPath(ref)),
) {
  let socket;
  try {
    const endpoint = new URL(service.endpoint.url);
    const encrypted = service.endpoint.tls.mode !== 'disabled';
    if (encrypted !== (endpoint.protocol === 'rediss:'))
      throw new Error('Invalid transport.');
    if (service.placement.kind === 'external' && !encrypted)
      throw new Error('External TLS required.');
    const password = await resolveSecret(service.passwordSecretRef);
    const options = {
      host: endpoint.hostname,
      port: Number(endpoint.port || 6379),
    };
    if (encrypted) {
      options.servername = endpoint.hostname;
      options.rejectUnauthorized = true;
      if (service.endpoint.tls.mode === 'private-ca') {
        options.ca = await resolveSecret(service.endpoint.tls.caSecretRef);
      }
    }
    await new Promise((done, reject) => {
      socket = encrypted ? tls.connect(options) : net.connect(options);
      const timer = setTimeout(
        () => socket.destroy(new Error('Probe timed out.')),
        service.health.timeoutSeconds * 1000,
      );
      socket.once('close', () => clearTimeout(timer));
      socket.once('error', reject);
      socket.once('end', () => reject(new Error('Incomplete response.')));
      socket.once(encrypted ? 'secureConnect' : 'connect', () => {
        socket.write(
          Buffer.concat([command(['AUTH', password]), command(['PING'])]),
        );
      });
      let response = Buffer.alloc(0);
      socket.on('data', (bytes) => {
        response = Buffer.concat([response, bytes]);
        if (response.length > 4096 || response.includes(45)) {
          reject(new Error('Redis rejected the readiness probe.'));
          socket.destroy();
        } else if (response.toString() === '+OK\r\n+PONG\r\n') {
          done();
          socket.destroy();
        }
      });
    });
    return { component: 'redis', status: 'ready' };
  } catch {
    socket?.destroy();
    return {
      component: 'redis',
      status: 'not-ready',
      instruction:
        'Check Redis reachability, credentials, and certificate trust.',
    };
  }
}

import http from 'node:http';
import https from 'node:https';
import type { DeploymentConfig } from 'deployment';
import type { ConfigurationService } from './configuration.service';

export class ServiceResponseError extends Error {
  constructor(readonly status: number) {
    super('The internal service rejected the request.');
  }
}

export class ServiceTimeoutError extends Error {
  constructor() {
    super('The internal service timed out.');
  }
}

/** Bound internal responses and verify the configured TLS trust. */
export function serviceRequest(
  configuration: ConfigurationService,
  service: DeploymentConfig['services']['kestra'],
  path: string,
  authorization: string,
  method = 'GET',
  body?: string,
  contentType = 'application/json',
): Promise<string> {
  const endpoint = new URL(service.endpoint.url);
  const transport = endpoint.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request(
      endpoint,
      {
        path,
        method,
        timeout: 5000,
        rejectUnauthorized: true,
        ...(service.endpoint.tls.mode === 'private-ca'
          ? { ca: configuration.secret(service.endpoint.tls.caSecretRef) }
          : {}),
        headers: {
          authorization,
          accept: 'application/json',
          ...(body
            ? {
                'content-type': contentType,
                'content-length': Buffer.byteLength(body),
              }
            : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (bytes: Buffer) => {
          size += bytes.length;
          if (size > 65536) {
            request.destroy(
              new Error('The internal response exceeded its size limit.'),
            );
            return;
          }
          chunks.push(bytes);
        });
        response.on('error', reject);
        response.on('end', () => {
          if (
            !response.statusCode ||
            response.statusCode < 200 ||
            response.statusCode >= 300
          )
            reject(new ServiceResponseError(response.statusCode ?? 502));
          else resolve(Buffer.concat(chunks).toString('utf8'));
        });
      },
    );
    const timeout = setTimeout(
      () => request.destroy(new ServiceTimeoutError()),
      5000,
    );
    request.once('close', () => clearTimeout(timeout));
    request.on('timeout', () => request.destroy(new ServiceTimeoutError()));
    request.on('error', reject);
    request.end(body);
  });
}

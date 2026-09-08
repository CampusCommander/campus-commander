import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { credentialFromAuthorization } from './access.mjs';
import { secretPath } from '../redis/runtime.mjs';
import { parseDeploymentConfig } from '../../dist/deployment/lib/deployment.js';

const assetPath =
  /^\/(?:assets\/)?[A-Za-z0-9_/-]+\.(?:js|css|ico|png|svg|woff2?)$/;
const finish = (response, status, message) => {
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(message);
};

/** Serve only the protected Phase 1 surface through the configured TLS edge. */
export async function createBootstrapEdge({
  config: input,
  verify,
  getStatus = async () => ({ status: 'not-ready', checks: [] }),
  resolveSecret = (ref) => readFile(secretPath(ref)),
}) {
  const config = parseDeploymentConfig(input);
  const edge = config.services.edge;
  if (edge.placement.kind !== 'local')
    throw new Error('The installation requires a managed HTTPS edge.');
  const material = {
    cert: await resolveSecret(edge.serverTls.certificateSecretRef),
    key: await resolveSecret(edge.serverTls.privateKeySecretRef),
    minVersion: 'TLSv1.2',
  };
  const upstreams = {};
  for (const name of ['frontend', 'api']) {
    const service = config.services[name];
    upstreams[name] = {
      url: new URL(service.endpoint.url),
      ca:
        service.endpoint.tls.mode === 'private-ca'
          ? await resolveSecret(service.endpoint.tls.caSecretRef)
          : undefined,
    };
  }
  const server = https.createServer(material, async (request, response) => {
    response.setHeader('strict-transport-security', 'max-age=31536000');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader(
      'content-security-policy',
      "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
    );
    if (request.method !== 'GET' && request.method !== 'HEAD')
      return finish(response, 405, 'Method unavailable.\n');
    const path = request.url || '';
    if (path === '/health/live') return finish(response, 200, 'live\n');
    if (path === '/health' || path === '/health/ready') {
      try {
        const status = await getStatus();
        return finish(
          response,
          status.status === 'ready' ? 200 : 503,
          `${status.status === 'ready' ? 'ready' : 'not-ready'}\n`,
        );
      } catch {
        return finish(response, 503, 'not-ready\n');
      }
    }
    const api = path === '/api' || path === '/api/startup';
    if (
      path.includes('..') ||
      !(api || path === '/' || path === '/index.html' || assetPath.test(path))
    ) {
      return finish(response, 404, 'Route unavailable.\n');
    }
    let accepted = false;
    try {
      accepted = await verify(
        credentialFromAuthorization(request.headers.authorization),
      );
    } catch {
      /* Deny unavailable verification. */
    }
    if (!accepted) {
      response.setHeader(
        'www-authenticate',
        'Basic realm="Installation", charset="UTF-8"',
      );
      return finish(response, 401, 'Installation access required.\n');
    }
    const target = upstreams[api ? 'api' : 'frontend'];
    const transport = target.url.protocol === 'https:' ? https : http;
    const upstream = transport.request(
      target.url,
      {
        method: request.method,
        path,
        ca: target.ca,
        rejectUnauthorized: true,
        headers: {
          host: target.url.host,
          accept: request.headers.accept || '*/*',
          ...(api ? { authorization: request.headers.authorization } : {}),
        },
        timeout: 5000,
      },
      (incoming) => {
        const status = incoming.statusCode || 502;
        if (status >= 300 && status < 400) {
          incoming.destroy();
          return finish(response, 502, 'Startup service unavailable.\n');
        }
        response.writeHead(status, {
          'content-type':
            incoming.headers['content-type'] || 'application/octet-stream',
          'cache-control': 'no-store',
        });
        incoming.on('error', () => response.destroy());
        incoming.pipe(response);
      },
    );
    upstream.on('timeout', () =>
      upstream.destroy(new Error('Upstream timed out.')),
    );
    upstream.on('error', () => {
      if (!response.headersSent)
        finish(response, 502, 'Startup service unavailable.\n');
      else response.destroy();
    });
    response.once('close', () => upstream.destroy());
    upstream.end();
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  return server;
}

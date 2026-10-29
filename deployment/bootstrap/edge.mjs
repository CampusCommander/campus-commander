import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { credentialFromAuthorization } from './access.mjs';
import { secretPath } from '../redis/runtime.mjs';
import { parseDeploymentConfig } from '../../dist/deployment/lib/deployment.js';
import {
  proxyApplication,
  requestDeadline,
  requestDeadlines,
} from './application-edge.mjs';

const assetPath =
  /^\/(?:assets\/)?[A-Za-z0-9_/-]+\.(?:js|css|ico|png|svg|woff2?)$/;
const finish = (response, status, message) => {
  // The request deadline can answer a slow body first. That answer owns the connection, so a
  // later refusal must not write a second status line.
  if (response.headersSent) return response.destroy();
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(message);
};

/**
 * Bound the input of one HTTP/1.1 request. The listener raises `requestTimeout` to the upload
 * deadline, and Node applies that value to every request of the server, so this timer restores
 * the ordinary ten-second deadline. The deadline covers the request body only. A request whose
 * framing declares no body returns at once. A request whose body arrived keeps its answer and
 * its open event stream whatever the method, because the parser reports the complete message.
 *
 * The returned predicate reports whether this timer ended the request. An awaited continuation
 * checks it before it writes, because the 408 owns the connection once the timer fires.
 */
function enforceRequestDeadline(request, response, deadlines) {
  // Only a framed body waits for input. The method proves nothing: GET, HEAD, and DELETE can
  // carry one. A message that already arrived needs no timer even when nothing reads it.
  const declaresBody =
    request.headers['transfer-encoding'] !== undefined ||
    Number(request.headers['content-length'] ?? 0) > 0;
  if (!declaresBody || request.complete) return () => false;
  let expired = false;
  const timer = setTimeout(
    () => {
      // The parser read the whole framed body before the deadline. The answer itself may take
      // longer than the deadline, as an event stream does.
      if (request.complete) return;
      expired = true;
      if (!response.headersSent) {
        response.writeHead(408, {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'close',
        });
        response.end('The request timed out.\n');
      } else response.destroy();
      // An unfinished request ends at its deadline. Closing the connection stops a client from
      // sending the rest of a body that already answered 408, or that no longer has a reader.
      request.socket.destroy();
    },
    requestDeadline(request.method, request.url, deadlines),
  );
  timer.unref();
  const clear = () => clearTimeout(timer);
  // Only the end of the input clears the deadline. A finished answer does not prove that the
  // request body arrived, so the timer closes an unfinished body even after its answer.
  request.once('end', clear);
  request.once('close', clear);
  request.once('aborted', clear);
  return () => expired;
}

/** Serve application routes and protected installer checks through the TLS edge. */
export async function createBootstrapEdge({
  config: input,
  verify,
  getStatus = async () => ({ status: 'not-ready', checks: [] }),
  resolveSecret = (ref) => readFile(secretPath(ref)),
  deadlines = requestDeadlines,
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
    const deadlineExpired = enforceRequestDeadline(
      request,
      response,
      deadlines,
    );
    response.setHeader('strict-transport-security', 'max-age=31536000');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader(
      'content-security-policy',
      // AG Grid draws its icons from data: SVG images. Scripts stay same-origin.
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
    );
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
    if (config.phase >= 2 && path !== '/api/startup')
      return proxyApplication(
        request,
        response,
        upstreams,
        config.applicationAuth.publicOrigin,
        config.phase,
      );
    if (request.method !== 'GET' && request.method !== 'HEAD')
      return finish(response, 405, 'Method unavailable.\n');
    const api =
      path === '/api' || path === '/api/startup' || path === '/api/application';
    if (
      path.includes('..') ||
      !(
        api ||
        path === '/' ||
        path === '/startup' ||
        path === '/index.html' ||
        assetPath.test(path)
      )
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
    // Verification can take longer than the body deadline. The timer already answered 408 and
    // closed the connection, so a late result must send no headers and start no upstream request.
    if (deadlineExpired()) return;
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
        // The deadline can answer between the verified continuation and this answer. Never
        // write a second status line on a connection that the 408 already owns.
        if (response.headersSent) return incoming.destroy();
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
  // Node applies this value to every HTTP/1.1 request of the server, so it takes the longest
  // body deadline. The per-request timer bounds every other path to its own deadline.
  server.requestTimeout = deadlines.importUpload;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  return server;
}

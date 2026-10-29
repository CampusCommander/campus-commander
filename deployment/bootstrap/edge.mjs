import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { credentialFromAuthorization } from './access.mjs';
import { secretPath } from '../redis/runtime.mjs';
import { parseDeploymentConfig } from '../../dist/deployment/lib/deployment.js';
import { proxyApplication, responseHeaders } from './application-edge.mjs';

const assetPath =
  /^\/(?:assets\/)?[A-Za-z0-9_/-]+\.(?:js|css|ico|png|svg|woff2?)$/;
const finish = (response, status, message) => {
  // The request deadline answers a slow body. The body reader then rejects on the closed
  // stream, and this second answer must not throw.
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(message);
};

/**
 * The HTTP/2 listener has no incoming request deadline. Bound each stream with the configured
 * `requestTimeout` value. The deadline covers the request body only, so a completed request and
 * an open event stream outlive it. A session inactivity timer would reset on busy sibling
 * streams, so each stream gets its own timer.
 */
function enforceRequestDeadline(server, request, response) {
  const stream = request.stream;
  if (!stream || stream.endAfterHeaders) return;
  const timer = setTimeout(() => {
    if (!response.headersSent) {
      response.writeHead(408, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end('The request timed out.\n');
    }
    if (!stream.destroyed) stream.close(http2.constants.NGHTTP2_CANCEL);
  }, server.requestTimeout);
  timer.unref();
  const clear = () => clearTimeout(timer);
  // The compatibility request emits `end` only when the application reads its body. An unread
  // GET or HEAD request never emits it, even after the client completes its input with an
  // empty DATA END_STREAM. The stream reports that completion, so watch both.
  stream.once('end', clear);
  stream.once('close', clear);
  stream.once('aborted', clear);
  request.once('end', clear);
  request.once('close', clear);
  request.once('aborted', clear);
  response.once('finish', clear);
  response.once('close', clear);
}

/** Serve application routes and protected installer checks through the TLS edge. */
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
  // One request handler serves HTTP/2 and HTTP/1.1 with the same routes, limits, and timeouts.
  const handleRequest = async (request, response) => {
    enforceRequestDeadline(server, request, response);
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
          // The upstream receives its configured endpoint name, so Node verifies the upstream
          // certificate against that endpoint and not against the public client host.
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
        response.writeHead(status, responseHeaders(incoming, false));
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
  };
  const server = http2.createSecureServer(
    { ...material, allowHTTP1: true },
    handleRequest,
  );
  // node:http2 has no closeAllConnections. Keep the teardown that process shutdown and the
  // callers use, and reach both protocols through the TLS socket of each connection.
  const sockets = new Set();
  // The server accepts a TCP connection before its TLS handshake. A peer that never sends a
  // ClientHello has no TLS socket, so the forced teardown tracks the accepted transport too.
  const transports = new Set();
  /** Each HTTP/2 session with its open stream count, last stream, and idle timer. */
  const sessions = new Map();
  let stopping = false;
  /**
   * Close an HTTP/2 session that holds no open stream for the keep-alive timeout, as the
   * server closes an idle HTTP/1.1 connection. A session with an open stream stays open.
   */
  const closeIdleSession = (session, entry) => {
    if (stopping || !server.keepAliveTimeout || entry.open > 0) return;
    if (session.closed || session.destroyed) return;
    entry.idle = setTimeout(() => {
      entry.idle = undefined;
      if (entry.open > 0 || session.closed || session.destroyed) return;
      session.close();
    }, server.keepAliveTimeout);
    entry.idle.unref();
  };
  server.on('session', (session) => {
    const entry = { open: 0, lastStreamId: 0, idle: undefined };
    sessions.set(session, entry);
    session.on('stream', (stream) => {
      entry.open += 1;
      // GOAWAY names the last stream the edge may have processed, so a client does not resend
      // a request that ran.
      entry.lastStreamId = Math.max(entry.lastStreamId, stream.id);
      clearTimeout(entry.idle);
      entry.idle = undefined;
      stream.once('close', () => {
        entry.open -= 1;
        if (entry.open === 0) closeIdleSession(session, entry);
      });
    });
    session.once('close', () => {
      clearTimeout(entry.idle);
      sessions.delete(session);
    });
    // A new session with no request is idle, as an idle HTTP/1.1 connection is.
    closeIdleSession(session, entry);
  });
  server.on('connection', (socket) => {
    transports.add(socket);
    socket.once('close', () => transports.delete(socket));
  });
  server.on('secureConnection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.closeAllConnections = () => {
    for (const socket of sockets) socket.destroy();
    // A connection that never finished its handshake exists only here.
    for (const socket of transports) socket.destroy();
  };
  /**
   * Begin the stop. GOAWAY tells every HTTP/2 client to open a new connection for later
   * requests, and an open stream keeps its session until the caller destroys the sockets.
   * Each HTTP/1.1 connection ends now, so only the grace timer remains.
   */
  server.stopConnections = () => {
    if (stopping) return;
    stopping = true;
    for (const [session, entry] of [...sessions]) {
      if (session.closed || session.destroyed) continue;
      session.goaway(http2.constants.NGHTTP2_NO_ERROR, entry.lastStreamId);
    }
    // ALPN names the protocol of each TLS socket, so an HTTP/2 session is never ended here.
    for (const socket of sockets) {
      if (socket.alpnProtocol !== 'h2') socket.end();
    }
  };
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  return server;
}

/**
 * Stop the edge on SIGINT or SIGTERM. GOAWAY and the end of every HTTP/1.1 connection start
 * at once. The edge destroys every remaining socket after the grace, which ends before the
 * ten-second Docker stop timeout.
 */
export function stopOnSignals(server, { graceMs = 5000 } = {}) {
  const stop = () => {
    // Tell every HTTP/2 client to reconnect and end each HTTP/1.1 connection. The close call
    // also sends GOAWAY with the same last stream, which the protocol allows.
    server.stopConnections();
    const deadline = setTimeout(() => server.closeAllConnections(), graceMs);
    deadline.unref();
    server.close(() => clearTimeout(deadline));
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop);
  return stop;
}

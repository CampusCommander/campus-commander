import http from 'node:http';
import https from 'node:https';

const pages = new Set([
  '/',
  '/index.html',
  '/login',
  '/account',
  '/diagnostics',
  '/startup',
  '/setup',
]);
const getRoutes = new Set([
  '/api/application',
  '/api/auth/login',
  '/api/auth/callback',
  '/api/auth/session',
  '/api/auth/enrollment/status',
  '/api/diagnostics',
]);
const postRoutes = new Set([
  '/api/auth/logout',
  '/api/auth/preferences',
  '/api/auth/enrollment/start',
  '/api/auth/enrollment/operator',
  '/api/diagnostics/postgresql',
  '/api/diagnostics/redis',
  '/api/diagnostics/kestra',
  '/api/diagnostics/artifacts',
]);
const assets =
  /^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.(?:js|css|ico|png|svg|woff2?)$/;
const phase3Pages = new Set([
  '/invitation',
  '/invitations',
  '/platform-users',
  '/google-connection',
  '/customer-settings',
]);
const invitationReads = new Set([
  '/api/auth/invitations',
  '/api/auth/invitations/status',
]);
const invitationWrites = new Set([
  '/api/auth/invitations',
  '/api/auth/invitations/redeem',
]);
const invitationChange =
  /^\/api\/auth\/invitations\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/(?:confirm|revoke)$/;
const principalRead =
  /^\/api\/platform-users(?:\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?:\/receipts)?)?$/;
const principalWrite =
  /^\/api\/platform-users\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/(?:review|access)$/;
const connectionRead =
  /^\/api\/google-connection(?:\/health|\/credentials|\/candidates\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})?$/;
const connectionWrite =
  /^\/api\/google-connection\/(?:health\/check|check|credentials\/(?:rotate-key|disconnect)|replacements(?:\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/activate)?|candidates(?:\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/confirm)?)$/;
const customerRead =
  /^\/api\/customer(?:\/receipts\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})?$/;
const schoolIdPath =
  '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const schoolRead = new RegExp(
  `^/api/schools(?:/(?:${schoolIdPath}(?:/audit)?|reviews/${schoolIdPath}))?$`,
);
const schoolWrite = new RegExp(
  `^/api/schools/reviews(?:/${schoolIdPath}/confirm)?$`,
);
const finish = (response, status, message) => {
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(message);
};

/** Proxy only released pages and bounded application requests. */
export async function proxyApplication(
  request,
  response,
  upstreams,
  publicOrigin,
  phase = 2,
) {
  const path = request.url ?? '';
  if (
    path.length > 4096 ||
    !path.startsWith('/') ||
    path.startsWith('//') ||
    path.includes('..') ||
    path.includes('\\')
  )
    return finish(response, 404, 'Route unavailable.\n');
  if (request.headers.host !== new URL(publicOrigin).host)
    return finish(response, 421, 'Use the configured application address.\n');
  const pathname = path.split('?')[0];
  const readable =
    getRoutes.has(pathname) ||
    (phase === 3 &&
      (invitationReads.has(pathname) ||
        principalRead.test(pathname) ||
        connectionRead.test(pathname) ||
        customerRead.test(pathname) ||
        pathname === '/api/schools/references' ||
        schoolRead.test(pathname)));
  const writable =
    postRoutes.has(pathname) ||
    (phase === 3 &&
      (invitationWrites.has(pathname) ||
        invitationChange.test(pathname) ||
        principalWrite.test(pathname) ||
        connectionWrite.test(pathname) ||
        pathname === '/api/customer/settings' ||
        pathname === '/api/schools/references/refresh' ||
        schoolWrite.test(pathname)));
  const api = readable || writable;
  const page =
    pages.has(pathname) || (phase === 3 && phase3Pages.has(pathname));
  if (!api && !page && !assets.test(pathname))
    return finish(response, 404, 'Route unavailable.\n');
  const methodAllowed =
    request.method === 'POST'
      ? writable
      : ['GET', 'HEAD'].includes(request.method) && (!api || readable);
  if (!methodAllowed) return finish(response, 405, 'Method unavailable.\n');
  let body;
  if (request.method === 'POST') {
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of request) {
        size += chunk.length;
        const limit =
          phase === 3 &&
          [
            '/api/google-connection/candidates',
            '/api/google-connection/replacements',
            '/api/schools/reviews',
          ].includes(pathname)
            ? 65536
            : 4096;
        if (size > limit)
          return finish(response, 413, 'The request exceeds the size limit.\n');
        chunks.push(chunk);
      }
      body = Buffer.concat(chunks);
    } catch {
      return finish(response, 400, 'The request body is invalid.\n');
    }
  }
  const target = upstreams[api ? 'api' : 'frontend'];
  const transport = target.url.protocol === 'https:' ? https : http;
  const headers = {
    host: target.url.host,
    accept: request.headers.accept ?? '*/*',
  };
  if (api) {
    if (
      pathname === '/api/auth/enrollment/operator' &&
      typeof request.headers.authorization === 'string'
    )
      headers.authorization = request.headers.authorization;
    for (const name of ['cookie', 'origin', 'x-csrf-token', 'content-type']) {
      if (typeof request.headers[name] === 'string')
        headers[name] = request.headers[name];
    }
  }
  if (body) headers['content-length'] = body.length;
  const upstream = transport.request(
    target.url,
    {
      path,
      method: request.method,
      headers,
      ca: target.ca,
      rejectUnauthorized: true,
      timeout: 45000,
    },
    (incoming) => {
      const forwarded = {
        'content-type':
          incoming.headers['content-type'] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      };
      if (api)
        for (const name of ['set-cookie', 'location', 'x-correlation-id']) {
          if (incoming.headers[name]) forwarded[name] = incoming.headers[name];
        }
      response.writeHead(incoming.statusCode ?? 502, forwarded);
      incoming.on('error', () => response.destroy());
      incoming.pipe(response);
    },
  );
  upstream.on('timeout', () =>
    upstream.destroy(new Error('The application request timed out.')),
  );
  upstream.on('error', () => {
    if (!response.headersSent)
      finish(response, 502, 'The application service is unavailable.\n');
    else response.destroy();
  });
  response.once('close', () => upstream.destroy());
  upstream.end(body);
}

import http from 'node:http';
import https from 'node:https';

const pages = new Set([
  '/',
  '/index.html',
  '/login',
  '/account',
  '/diagnostics',
  '/startup',
]);
const getRoutes = new Set([
  '/api/application',
  '/api/auth/login',
  '/api/auth/callback',
  '/api/auth/session',
  '/api/diagnostics',
]);
const postRoutes = new Set([
  '/api/auth/logout',
  '/api/auth/preferences',
  '/api/diagnostics/postgresql',
  '/api/diagnostics/redis',
  '/api/diagnostics/kestra',
  '/api/diagnostics/artifacts',
]);
const assets =
  /^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.(?:js|css|ico|png|svg|woff2?)$/;
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
  const api = getRoutes.has(pathname) || postRoutes.has(pathname);
  if (!api && !pages.has(pathname) && !assets.test(pathname))
    return finish(response, 404, 'Route unavailable.\n');
  const methodAllowed =
    request.method === 'POST'
      ? postRoutes.has(pathname)
      : ['GET', 'HEAD'].includes(request.method) &&
        (!api || getRoutes.has(pathname));
  if (!methodAllowed) return finish(response, 405, 'Method unavailable.\n');
  let body;
  if (request.method === 'POST') {
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 4096)
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

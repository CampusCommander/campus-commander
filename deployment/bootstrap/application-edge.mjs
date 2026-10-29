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
  '/schools',
  '/devices',
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
const deviceRead = /^\/api\/devices\/[A-Za-z0-9_-]{1,128}$/;
const devicePage = /^\/devices\/(?!update$)[A-Za-z0-9_-]{1,128}$/;
const deviceWrite =
  /^\/api\/devices\/(?:sync|query|groups|by-ids|freshness|selection(?:\/(?:ops|refresh|resolve))?|domain\/refresh)$/;
const jobDisplayIdPath = '(?:UPD|REF|CMD|STS|EXP|IMP)-\\d{3,}';
const previewIdPath =
  '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
// The routes of design section 1. A file route names the job kind of its own display ID, so an
// export file never answers for an import job and the reverse.
const exportDisplayIdPath = 'EXP-\\d{3,}';
const importDisplayIdPath = 'IMP-\\d{3,}';
const deviceExportFile = new RegExp(
  `^/api/devices/exports/${exportDisplayIdPath}/file$`,
);
const deviceExportWrite = /^\/api\/devices\/exports$/;
const deviceImportReport = new RegExp(
  `^/api/devices/imports/${importDisplayIdPath}/report$`,
);
const deviceImportRejected = new RegExp(
  `^/api/devices/imports/${importDisplayIdPath}/rejected$`,
);
const deviceImportWrite = new RegExp(
  `^/api/devices/imports(?:/${importDisplayIdPath}/(?:revalidate|execute|cancel))?$`,
);
// The one path that streams its body. Every other POST buffers its body under a cap.
export const importUploadPath = '/api/devices/imports';
// The cap of the streamed upload: 1 GiB, the bound of design section 4.
export const importUploadLimit = 1073741824;
/**
 * Body deadlines in milliseconds. The upload streams a file of up to 1 GiB, so a POST to the
 * upload path alone takes the long deadline. Every other request keeps the ten-second deadline
 * of the base.
 */
export const requestDeadlines = { request: 10000, importUpload: 1800000 };
const jobRead = new RegExp(
  `^/api/jobs(?:/(?:activity|requesters|events|${jobDisplayIdPath}(?:/operations)?))?$`,
);
// An operation number is a whole number from 1. The route rejects the rest. The cancel route
// takes no part of the path after the display ID.
const jobWrite = new RegExp(
  `^/api/jobs/(?:activity/seen|${jobDisplayIdPath}/(?:cancel|operations/[1-9]\\d{0,8}/reconcile))$`,
);
const deviceUpdateRead = new RegExp(
  `^/api/devices/updates/(?:access|org-units|previews/${previewIdPath}(?:/targets)?)$`,
);
const deviceUpdateWrite = new RegExp(
  `^/api/devices/updates/(?:access/check|previews|previews/${previewIdPath}/confirm)$`,
);
// One edit list carries up to 2,500 edits, so it alone takes the larger device-write body.
const deviceUpdateEdit = /^\/api\/devices\/updates\/edit-previews$/;
// The two action families of design section 7. Each family keeps one permission and one menu entry.
const deviceActionRead = new RegExp(
  `^/api/devices/(?:commands|status-changes)/previews/${previewIdPath}(?:/targets)?$`,
);
const deviceActionWrite = new RegExp(
  `^/api/devices/(?:commands|status-changes)/previews(?:/${previewIdPath}/confirm)?$`,
);
const jobPage = new RegExp(`^/jobs(?:/${jobDisplayIdPath})?$`);
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

/** Copy an upstream answer. Every route keeps the base headers. */
function responseHeaders(incoming, api, download = false) {
  const source = incoming.headers;
  const headers = {
    'content-type': source['content-type'] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  };
  if (api)
    for (const name of ['set-cookie', 'location', 'x-correlation-id']) {
      if (source[name]) headers[name] = source[name];
    }
  // Only a file download names its file. Every other route drops the header, as the base does.
  if (api && download && source['content-disposition'])
    headers['content-disposition'] = source['content-disposition'];
  return headers;
}

/**
 * The body deadline of one request, in milliseconds. Only a POST to the exact upload path takes
 * the long deadline. A GET or HEAD on that path, with or without its query, keeps the ordinary
 * deadline, because neither method uploads a file.
 */
export function requestDeadline(method, path, deadlines = requestDeadlines) {
  return method === 'POST' && (path ?? '').split('?')[0] === importUploadPath
    ? deadlines.importUpload
    : deadlines.request;
}

/**
 * Upstream idle timeouts in milliseconds. Node applies `timeout` to socket inactivity.
 * The event stream pings every 25 seconds, so 75 seconds allows two missed pings.
 */
export const upstreamTimeouts = { request: 45000, events: 75000 };

/**
 * The event streams take the event idle timeout. The one stream of `/api/events` carries the job
 * feed and the device feed, so it holds the connection open between pings like they do.
 */
const eventStreams = new Set([
  '/api/events',
  '/api/devices/events',
  '/api/jobs/events',
]);

/** Proxy only released pages and bounded application requests. */
export async function proxyApplication(
  request,
  response,
  upstreams,
  publicOrigin,
  phase = 2,
  timeouts = upstreamTimeouts,
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
        eventStreams.has(pathname) ||
        deviceRead.test(pathname) ||
        schoolRead.test(pathname) ||
        jobRead.test(pathname) ||
        deviceUpdateRead.test(pathname) ||
        deviceActionRead.test(pathname) ||
        deviceExportFile.test(pathname) ||
        deviceImportReport.test(pathname) ||
        deviceImportRejected.test(pathname)));
  const writable =
    postRoutes.has(pathname) ||
    (phase === 3 &&
      (invitationWrites.has(pathname) ||
        invitationChange.test(pathname) ||
        principalWrite.test(pathname) ||
        connectionWrite.test(pathname) ||
        pathname === '/api/customer/settings' ||
        pathname === '/api/schools/references/refresh' ||
        deviceWrite.test(pathname) ||
        schoolWrite.test(pathname) ||
        jobWrite.test(pathname) ||
        deviceUpdateWrite.test(pathname) ||
        deviceUpdateEdit.test(pathname) ||
        deviceActionWrite.test(pathname) ||
        deviceExportWrite.test(pathname) ||
        deviceImportWrite.test(pathname)));
  const api = readable || writable;
  const page =
    pages.has(pathname) ||
    (phase === 3 &&
      (phase3Pages.has(pathname) ||
        devicePage.test(pathname) ||
        jobPage.test(pathname)));
  if (!api && !page && !assets.test(pathname))
    return finish(response, 404, 'Route unavailable.\n');
  // The one event stream answers GET alone. A HEAD request would open an upstream event stream,
  // so it is refused here before any upstream request starts.
  if (pathname === '/api/events' && request.method !== 'GET')
    return finish(response, 405, 'Method unavailable.\n');
  const methodAllowed =
    request.method === 'POST'
      ? writable
      : ['GET', 'HEAD'].includes(request.method) && (!api || readable);
  if (!methodAllowed) return finish(response, 405, 'Method unavailable.\n');
  // The import upload streams its file to the API. Every other POST buffers its body under a
  // cap, so a refusal answers before any upstream request starts.
  const upload = request.method === 'POST' && pathname === importUploadPath;
  let body;
  if (request.method === 'POST' && !upload) {
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of request) {
        size += chunk.length;
        const limit =
          phase === 3 &&
          (principalWrite.test(pathname) ||
            deviceWrite.test(pathname) ||
            deviceUpdateEdit.test(pathname))
            ? // Device bodies carry ID batches, group routes, and set filters. An edit list
              // carries up to 2,500 edits.
              98304
            : phase === 3 &&
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
  // The request deadline answered this request and closed its stream. Send nothing upstream.
  if (response.headersSent) return;
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
  // A refused upload must not answer 502 from the upstream request it cancelled.
  let refused = false;
  const upstream = transport.request(
    target.url,
    {
      path,
      method: request.method,
      headers,
      ca: target.ca,
      rejectUnauthorized: true,
      timeout: eventStreams.has(pathname) ? timeouts.events : timeouts.request,
    },
    (incoming) => {
      response.writeHead(
        incoming.statusCode ?? 502,
        responseHeaders(
          incoming,
          api,
          deviceExportFile.test(pathname) ||
            deviceImportRejected.test(pathname),
        ),
      );
      incoming.on('error', () => response.destroy());
      incoming.pipe(response);
    },
  );
  upstream.on('timeout', () =>
    upstream.destroy(new Error('The application request timed out.')),
  );
  upstream.on('error', () => {
    if (refused) return;
    if (!response.headersSent)
      finish(response, 502, 'The application service is unavailable.\n');
    else response.destroy();
  });
  response.once('close', () => upstream.destroy());
  if (upload) {
    // Count the bytes as they pass, so the edge never holds the file. The cap answers 413 and
    // stops the transfer to the API. The refused request then ends, as a buffered refusal does,
    // so a client that keeps sending holds no stream.
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (refused || size <= importUploadLimit) return;
      refused = true;
      request.unpipe(upstream);
      upstream.destroy();
      finish(response, 413, 'The request exceeds the size limit.\n');
      request.destroy();
    });
    request.once('error', () => upstream.destroy());
    request.pipe(upstream);
    return;
  }
  upstream.end(body);
}

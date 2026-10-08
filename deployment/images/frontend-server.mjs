import { createReadStream, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { extname, resolve, sep } from 'node:path';

const root = resolve('/app/browser');
const port = Number(process.env.PORT ?? 8080);
const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const certificatePath = process.env.TLS_CERT_FILE;
const keyPath = process.env.TLS_KEY_FILE;
if (Boolean(certificatePath) !== Boolean(keyPath)) {
  throw new Error('TLS certificate and key files must be configured together.');
}

const handleRequest = (request, response) => {
  if (request.method === 'GET' && request.url === '/health/live') {
    respondJson(response, 200, { service: 'frontend', status: 'live' });
    return;
  }

  if (
    request.method === 'GET' &&
    (request.url === '/health' || request.url === '/health/ready')
  ) {
    respondJson(response, 200, {
      service: 'frontend',
      status: 'ready',
      checks: [{ name: 'static-content', status: 'ready' }],
    });
    return;
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    respondJson(response, 405, { error: 'method-not-allowed' });
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(
      new URL(request.url ?? '/', 'http://localhost').pathname,
    );
  } catch {
    respondJson(response, 400, { error: 'invalid-path' });
    return;
  }
  const requestedPath = resolve(root, `.${pathname}`);
  const safePath = requestedPath.startsWith(`${root}${sep}`)
    ? requestedPath
    : '';
  const filePath = fileExists(safePath)
    ? safePath
    : resolve(root, 'index.html');

  response.writeHead(200, {
    'content-type':
      contentTypes[extname(filePath)] ?? 'application/octet-stream',
  });
  if (request.method === 'HEAD') response.end();
  else {
    const stream = createReadStream(filePath);
    stream.on('error', () => response.destroy());
    stream.pipe(response);
  }
};

const server = certificatePath
  ? createSecureServer(
      {
        cert: readFileSync(certificatePath),
        key: readFileSync(keyPath),
        minVersion: 'TLSv1.2',
      },
      handleRequest,
    )
  : createServer(handleRequest);

server.listen(port, '0.0.0.0', () => {
  console.log(
    `Frontend startup content listening with ${certificatePath ? 'HTTPS' : 'HTTP'} on port ${port}`,
  );
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    const deadline = setTimeout(() => server.closeAllConnections(), 5000);
    deadline.unref();
    server.close((error) => {
      clearTimeout(deadline);
      if (error) {
        console.error('Frontend shutdown failed');
        process.exitCode = 1;
      }
    });
  });
}

function fileExists(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function respondJson(response, statusCode, body) {
  response.writeHead(statusCode, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

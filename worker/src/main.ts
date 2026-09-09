import { readFileSync } from 'node:fs';
import {
  createServer,
  type RequestListener,
  type ServerResponse,
} from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { handleSyntheticDispatch, readDispatchSecret } from './dispatch';

const port = Number(process.env.PORT ?? 3001);
const dispatchSecretPath = process.env['WORKER_DISPATCH_SECRET_FILE'];
if (!dispatchSecretPath) {
  throw new Error('WORKER_DISPATCH_SECRET_FILE is required.');
}
const dispatchSecret = readDispatchSecret(dispatchSecretPath);
const stopping = new AbortController();

const certificatePath = process.env['TLS_CERT_FILE'];
const keyPath = process.env['TLS_KEY_FILE'];
if (Boolean(certificatePath) !== Boolean(keyPath)) {
  throw new Error('TLS certificate and key files must be configured together.');
}
if (process.env['REQUIRE_TLS'] === 'true' && !certificatePath) {
  throw new Error('REQUIRE_TLS requires TLS certificate and key files.');
}

const handleRequest: RequestListener = async (request, response) => {
  if (request.method === 'GET' && request.url === '/health/live') {
    respond(response, 200, { service: 'worker', status: 'live' });
    return;
  }

  if (
    request.method === 'GET' &&
    (request.url === '/health' || request.url === '/health/ready')
  ) {
    respond(response, 200, {
      service: 'worker',
      status: 'ready',
      checks: [{ name: 'process-started', status: 'ready' }],
    });
    return;
  }

  if (
    await handleSyntheticDispatch(request, response, {
      secret: dispatchSecret,
      signal: stopping.signal,
    })
  ) {
    return;
  }

  respond(response, 404, { error: 'not-found' });
};

const server =
  certificatePath && keyPath
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
    `Worker probe listening with ${certificatePath ? 'HTTPS' : 'HTTP'} on port ${port}`,
  );
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    stopping.abort();
    const deadline = setTimeout(() => server.closeAllConnections(), 5000);
    deadline.unref();
    server.close((error) => {
      clearTimeout(deadline);
      if (error) {
        console.error('Worker shutdown failed');
        process.exitCode = 1;
      }
    });
  });
}

function respond(response: ServerResponse, statusCode: number, body: object) {
  response.writeHead(statusCode, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

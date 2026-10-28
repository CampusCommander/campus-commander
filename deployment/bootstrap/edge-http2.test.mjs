import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  connectionHeaders,
  requestHost,
  responseHeaders,
} from './application-edge.mjs';
import { createBootstrapEdge } from './edge.mjs';

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const closeServer = async (server) => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
};
// A client request reads the answer as the edge sent it. The upstream answer of the stub
// carries the connection-specific headers an HTTP/1.1 server adds.
function createApiStub() {
  const requests = [];
  const open = new Set();
  const server = http.createServer((request, response) => {
    requests.push({
      method: request.method,
      url: request.url,
      headers: { ...request.headers },
    });
    request.resume();
    if ((request.url ?? '').startsWith('/api/jobs/events')) {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
      });
      response.write('retry: 3000\n\n');
      open.add(response);
      response.once('close', () => open.delete(response));
      return;
    }
    response.writeHead(200, {
      'content-type': 'application/json',
      'set-cookie': 'session=example',
      'x-correlation-id': 'example-correlation',
    });
    response.end('api');
  });
  return { server, requests, open };
}
const createFrontendStub = () =>
  http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('frontend');
  });

async function freePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function createMaterial() {
  const directory = await mkdtemp(join(tmpdir(), 'cc-edge-http2-'));
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(directory, 'key.pem'),
      '-out',
      join(directory, 'cert.pem'),
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  );
  return {
    directory,
    cert: await readFile(join(directory, 'cert.pem')),
    key: await readFile(join(directory, 'key.pem')),
  };
}

/** Start the real edge on one TLS port with a stub frontend and a stub API. */
async function startEnvironment() {
  const material = await createMaterial();
  const frontend = createFrontendStub();
  const api = createApiStub();
  await listen(frontend);
  await listen(api.server);
  const port = await freePort();
  const origin = `https://127.0.0.1:${port}`;
  const config = JSON.parse(
    await readFile('deployment/examples/all-docker.json', 'utf8'),
  );
  config.phase = 3;
  config.services.frontend.endpoint.url = `http://127.0.0.1:${frontend.address().port}`;
  config.services.api.endpoint.url = `http://127.0.0.1:${api.server.address().port}`;
  config.services.edge.access = 'application';
  config.applicationAuth = {
    issuer: 'https://identity.example.invalid',
    clientId: 'synthetic-client',
    clientSecretRef: { provider: 'file', path: '/run/secrets/oidc-client' },
    publicOrigin: origin,
  };
  const edge = await createBootstrapEdge({
    config,
    verify: async () => false,
    resolveSecret: async (ref) =>
      ref.path.endsWith('private-key') ? material.key : material.cert,
  });
  await new Promise((resolve) => edge.listen(port, '127.0.0.1', resolve));
  const environment = {
    ...material,
    edge,
    frontend,
    api,
    origin,
    cert: material.cert,
    close: async () => {
      for (const response of api.open) response.destroy();
      edge.closeAllConnections();
      await new Promise((resolve) => edge.close(resolve));
      await closeServer(frontend);
      await closeServer(api.server);
      await rm(material.directory, { recursive: true, force: true });
    },
  };
  return environment;
}

function h1Request(
  environment,
  { path, method = 'GET', headers = {}, body, hold = false, servername },
) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        hostname: '127.0.0.1',
        port: Number(new URL(environment.origin).port),
        path,
        method,
        ca: environment.cert,
        headers,
        agent: false,
        ...(servername ? { servername } : {}),
      },
      (response) => {
        if (hold) {
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: '',
            httpVersion: response.httpVersion,
          });
          request.destroy();
          return;
        }
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
            httpVersion: response.httpVersion,
          }),
        );
      },
    );
    request.on('error', reject);
    request.end(body);
  });
}

/** Open one HTTP/2 stream. `headers` settles with the answer headers. */
function h2Open(
  environment,
  client,
  { path, method = 'GET', headers = {}, body },
) {
  const stream = client.request({
    ':path': path,
    ':method': method,
    ...headers,
  });
  const answer = new Promise((resolve, reject) => {
    stream.on('response', (received) =>
      resolve({ status: received[':status'], headers: received }),
    );
    stream.on('error', reject);
  });
  const payload = new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
  });
  payload.catch(() => undefined);
  stream.end(body);
  return { stream, answer, payload };
}

const session = (environment) =>
  http2.connect(environment.origin, { ca: environment.cert });

/** The headers of an answer that a protocol does not generate for itself. */
function comparable(headers) {
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (key.startsWith(':') || key === 'date' || connectionHeaders.has(key))
      continue;
    result[key] = Array.isArray(value) ? value : [value];
  }
  return Object.fromEntries(
    Object.entries(result).sort(([left], [right]) => left.localeCompare(right)),
  );
}

test(
  'the edge answers eight event streams and a request on one HTTP/2 session',
  {
    timeout: 30000,
  },
  async () => {
    const environment = await startEnvironment();
    const client = session(environment);
    try {
      const streams = [];
      for (let index = 0; index < 8; index += 1)
        streams.push(h2Open(environment, client, { path: '/api/jobs/events' }));
      const answered = await Promise.all(streams.map(({ answer }) => answer));
      for (const { status } of answered) assert.equal(status, 200);
      assert.equal(
        environment.api.open.size,
        8,
        'Eight event streams stay open at the same time.',
      );
      const started = Date.now();
      const request = h2Open(environment, client, { path: '/api/jobs' });
      const answer = await request.answer;
      const body = await request.payload;
      const elapsed = Date.now() - started;
      assert.equal(answer.status, 200);
      assert.equal(body, 'api');
      assert.ok(
        elapsed < 2000,
        `The ninth stream answered after ${elapsed} ms.`,
      );
      assert.equal(
        environment.api.open.size,
        8,
        'The eight event streams are still open.',
      );
      for (const { stream } of streams) stream.close();
    } finally {
      client.close();
      await environment.close();
    }
  },
);

test(
  'each route class answers the same over HTTP/1.1 and HTTP/2',
  {
    timeout: 30000,
  },
  async () => {
    const environment = await startEnvironment();
    const client = session(environment);
    // One entry per route class of application-edge.test.mjs: an API read, an API write, an
    // event stream, a frontend page, a frontend asset, and each answer the edge makes itself.
    const classes = [
      { name: 'api read', path: '/api/jobs' },
      {
        name: 'api write',
        path: `/api/jobs/${'UPD-001'}/cancel`,
        method: 'POST',
        body: '{}',
        headers: { 'content-type': 'application/json' },
      },
      { name: 'event stream', path: '/api/jobs/events', hold: true },
      { name: 'frontend page', path: '/jobs/UPD-001' },
      { name: 'frontend asset', path: '/main.js' },
      { name: 'installer route', path: '/health/live' },
      { name: 'unknown route', path: '/api/devices' },
      { name: 'wrong method', path: '/api/schools', method: 'POST', body: '' },
      {
        name: 'oversized body',
        path: '/api/schools/references/refresh',
        method: 'POST',
        body: 'x'.repeat(4097),
      },
      {
        name: 'wrong address',
        path: '/',
        headers: {
          host: 'other.example.org',
          ':authority': 'other.example.org',
        },
        // The client host names the TLS certificate here, so verify the test server by name.
        servername: 'localhost',
      },
    ];
    try {
      for (const route of classes) {
        const h1Headers = { ...route.headers };
        delete h1Headers[':authority'];
        const h1 = await h1Request(environment, {
          path: route.path,
          method: route.method,
          headers: h1Headers,
          body: route.body,
          hold: route.hold,
          servername: route.servername,
        });
        const opened = h2Open(environment, client, {
          path: route.path,
          method: route.method,
          headers: route.headers,
          body: route.body,
        });
        const h2 = await opened.answer;
        assert.equal(h1.httpVersion, '1.1');
        assert.equal(h2.status, h1.status, route.name);
        assert.deepEqual(
          comparable(h2.headers),
          comparable(h1.headers),
          route.name,
        );
        if (route.hold) opened.stream.close();
        else assert.equal(await opened.payload, h1.body, route.name);
      }
    } finally {
      client.close();
      await environment.close();
    }
  },
);

test(
  'an HTTP/2 request reaches the upstream with a host and no pseudo-header',
  {
    timeout: 30000,
  },
  async () => {
    const environment = await startEnvironment();
    const client = session(environment);
    try {
      const request = h2Open(environment, client, { path: '/api/jobs' });
      assert.equal((await request.answer).status, 200);
      await request.payload;
      const forwarded = environment.api.requests.at(-1).headers;
      assert.deepEqual(
        Object.keys(forwarded).filter((name) => name.startsWith(':')),
        [],
        'The upstream request carries no HTTP/2 pseudo-header.',
      );
      assert.equal(
        forwarded.host,
        `127.0.0.1:${new URL(environment.origin).port}`,
      );
      // The same host arrives over HTTP/1.1, so both protocols send one upstream shape.
      assert.equal(
        (await h1Request(environment, { path: '/api/jobs' })).status,
        200,
      );
      assert.equal(
        environment.api.requests.at(-1).headers.host,
        forwarded.host,
      );
    } finally {
      client.close();
      await environment.close();
    }
  },
);

test('an upstream answer reaches both protocols without a connection header', () => {
  const upstreamAnswer = {
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'keep-alive': 'timeout=5',
      'proxy-connection': 'keep-alive',
      'transfer-encoding': 'chunked',
      upgrade: 'h2c',
      'set-cookie': 'session=example',
      'x-correlation-id': 'example-correlation',
    },
  };
  assert.deepEqual(responseHeaders(upstreamAnswer, true), {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'set-cookie': 'session=example',
    'x-correlation-id': 'example-correlation',
  });
  assert.deepEqual(responseHeaders(upstreamAnswer, false), {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  });
});

test(
  'the edge tears down an open stream of each protocol',
  {
    timeout: 30000,
  },
  async () => {
    const environment = await startEnvironment();
    const client = session(environment);
    try {
      const stream = h2Open(environment, client, { path: '/api/jobs/events' });
      assert.equal((await stream.answer).status, 200);
      const agent = new https.Agent({ keepAlive: true, ca: environment.cert });
      let socket;
      await new Promise((resolve, reject) => {
        const request = https.get(
          {
            hostname: '127.0.0.1',
            port: Number(new URL(environment.origin).port),
            path: '/health/live',
            ca: environment.cert,
            agent,
          },
          (response) => {
            socket = response.socket;
            response.resume();
            response.on('end', resolve);
          },
        );
        request.on('error', reject);
      });
      const sessionClosed = once(client, 'close');
      const socketClosed = once(socket, 'close');
      environment.edge.closeAllConnections();
      await Promise.all([sessionClosed, socketClosed]);
      agent.destroy();
    } finally {
      client.close();
      await environment.close();
    }
  },
);

test('the edge reads the client host from :authority', () => {
  assert.equal(
    requestHost({
      headers: { ':authority': 'app.example.org', host: 'other' },
    }),
    'app.example.org',
  );
  assert.equal(
    requestHost({ headers: { host: 'app.example.org' } }),
    'app.example.org',
  );
  assert.equal(requestHost({ headers: {} }), '');
});

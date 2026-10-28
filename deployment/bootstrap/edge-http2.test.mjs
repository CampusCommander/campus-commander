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
import { setTimeout as delay } from 'node:timers/promises';
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
function createApiStub(material) {
  const requests = [];
  const open = new Set();
  const api = { requests, open, answerDelay: 0 };
  const handler = (request, response) => {
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
    const answer = () => {
      if (response.destroyed || response.writableEnded) return;
      response.writeHead(200, {
        'content-type': 'application/json',
        'set-cookie': 'session=example',
        'x-correlation-id': 'example-correlation',
      });
      response.end('api');
    };
    if (api.answerDelay > 0) setTimeout(answer, api.answerDelay).unref();
    else answer();
  };
  api.server = material
    ? https.createServer(material, handler)
    : http.createServer(handler);
  return api;
}
const createFrontendStub = (material) => {
  const requests = [];
  const handler = (request, response) => {
    requests.push({ headers: { ...request.headers } });
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('frontend');
  };
  const server = material
    ? https.createServer(material, handler)
    : http.createServer(handler);
  server.requests = requests;
  return server;
};

async function freePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function createMaterial({
  subject = '/CN=localhost',
  names = 'DNS:localhost,IP:127.0.0.1',
} = {}) {
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
      subject,
      '-addext',
      `subjectAltName=${names}`,
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

/**
 * Start the real edge with HTTPS upstreams. Each upstream endpoint is `https://localhost:<port>`
 * and its certificate names `localhost`. The public origin is `https://app.example.org`, so the
 * configured endpoint name and the public host differ.
 */
async function startSecureEnvironment({
  phase = 3,
  certificate = 'endpoint',
} = {}) {
  const edgeMaterial = await createMaterial({
    subject: '/CN=app.example.org',
    names: 'DNS:localhost,DNS:app.example.org,IP:127.0.0.1',
  });
  const upstreamMaterial = await createMaterial(
    certificate === 'endpoint'
      ? { subject: '/CN=localhost', names: 'DNS:localhost' }
      : {
          subject: '/CN=upstream.example.org',
          names: 'DNS:upstream.example.org',
        },
  );
  const frontend = createFrontendStub(upstreamMaterial);
  const api = createApiStub(upstreamMaterial);
  await listen(frontend);
  await listen(api.server);
  const port = await freePort();
  const config = JSON.parse(
    await readFile('deployment/examples/all-docker.json', 'utf8'),
  );
  config.phase = phase;
  if (phase >= 2) {
    config.services.edge.access = 'application';
    config.applicationAuth = {
      issuer: 'https://identity.example.invalid',
      clientId: 'synthetic-client',
      clientSecretRef: { provider: 'file', path: '/run/secrets/oidc-client' },
      publicOrigin: 'https://app.example.org',
    };
  }
  for (const [name, server] of [
    ['frontend', frontend],
    ['api', api.server],
  ]) {
    config.services[name].endpoint.url =
      `https://localhost:${server.address().port}`;
    config.services[name].endpoint.tls = {
      mode: 'private-ca',
      caSecretRef: { provider: 'file', path: '/run/secrets/upstream-ca' },
    };
    // A local TLS endpoint carries the listener certificate references of the deployment model.
    config.services[name].serverTls = {
      certificateSecretRef: {
        provider: 'file',
        path: '/run/secrets/upstream-certificate',
      },
      privateKeySecretRef: {
        provider: 'file',
        path: '/run/secrets/upstream-private-key',
      },
    };
  }
  const edge = await createBootstrapEdge({
    config,
    verify: async () => true,
    resolveSecret: async (ref) => {
      if (ref.path.endsWith('edge-certificate')) return edgeMaterial.cert;
      if (ref.path.endsWith('edge-private-key')) return edgeMaterial.key;
      if (ref.path.endsWith('upstream-ca')) return upstreamMaterial.cert;
      throw new Error(`Unexpected secret reference: ${ref.path}`);
    },
  });
  await new Promise((resolve) => edge.listen(port, '127.0.0.1', resolve));
  return {
    origin: `https://127.0.0.1:${port}`,
    cert: edgeMaterial.cert,
    edge,
    frontend,
    api,
    close: async () => {
      for (const response of api.open) response.destroy();
      edge.closeAllConnections();
      await new Promise((resolve) => edge.close(resolve));
      await closeServer(frontend);
      await closeServer(api.server);
      await rm(edgeMaterial.directory, { recursive: true, force: true });
      await rm(upstreamMaterial.directory, { recursive: true, force: true });
    },
  };
}

/** Each request builder, its upstream classes, and the route that reaches each class. */
const upstreamRoutes = (phase, environment) =>
  phase >= 2
    ? [
        {
          name: 'api',
          path: '/api/jobs',
          requests: environment.api.requests,
          host: `localhost:${environment.api.server.address().port}`,
        },
        {
          name: 'frontend',
          path: '/main.js',
          requests: environment.frontend.requests,
          host: `localhost:${environment.frontend.address().port}`,
        },
      ]
    : [
        {
          name: 'api',
          path: '/api/startup',
          requests: environment.api.requests,
          host: `localhost:${environment.api.server.address().port}`,
          headers: {
            authorization: `Basic ${Buffer.from('operator:example').toString('base64')}`,
          },
        },
        {
          name: 'frontend',
          path: '/',
          requests: environment.frontend.requests,
          host: `localhost:${environment.frontend.address().port}`,
        },
      ];

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
  const first = new Promise((resolve, reject) => {
    stream.once('data', (chunk) => resolve(chunk.toString('utf8')));
    stream.on('error', reject);
  });
  first.catch(() => undefined);
  const payload = new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
  });
  payload.catch(() => undefined);
  stream.end(body);
  return { stream, answer, first, payload };
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
      assert.match(
        await streams[0].first,
        /retry: 3000/,
        'The event stream delivers its first frame over HTTP/2.',
      );
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
  'the upstream request carries the configured endpoint host and no pseudo-header',
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
        `127.0.0.1:${environment.api.server.address().port}`,
        'The upstream receives its configured endpoint, not the public host.',
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

test(
  'an HTTPS upstream certificate named by the endpoint answers behind another public origin',
  {
    timeout: 60000,
  },
  async () => {
    // The public origin is app.example.org. Each upstream certificate names localhost, the
    // configured endpoint. The edge must verify the endpoint, as it did before HTTP/2.
    for (const [builder, phase] of [
      ['application', 3],
      ['installer', 1],
    ]) {
      const environment = await startSecureEnvironment({ phase });
      const client = session(environment);
      try {
        for (const route of upstreamRoutes(phase, environment)) {
          const h1 = await h1Request(environment, {
            path: route.path,
            headers: { host: 'app.example.org', ...route.headers },
          });
          assert.equal(
            h1.status,
            200,
            `${builder} ${route.name} answers over HTTP/1.1.`,
          );
          const opened = h2Open(environment, client, {
            path: route.path,
            headers: { ':authority': 'app.example.org', ...route.headers },
          });
          assert.equal(
            (await opened.answer).status,
            200,
            `${builder} ${route.name} answers over HTTP/2.`,
          );
          await opened.payload;
          assert.equal(
            route.requests.at(-1).headers.host,
            route.host,
            `${builder} ${route.name} sends the configured endpoint host upstream.`,
          );
        }
      } finally {
        client.close();
        await environment.close();
      }
    }
  },
);

test(
  'the edge refuses an upstream certificate for another name',
  {
    timeout: 60000,
  },
  async () => {
    for (const [builder, phase] of [
      ['application', 3],
      ['installer', 1],
    ]) {
      const environment = await startSecureEnvironment({
        phase,
        certificate: 'other',
      });
      const client = session(environment);
      try {
        for (const route of upstreamRoutes(phase, environment)) {
          const h1 = await h1Request(environment, {
            path: route.path,
            headers: { host: 'app.example.org', ...route.headers },
          });
          assert.equal(
            h1.status,
            502,
            `${builder} ${route.name} refuses the certificate over HTTP/1.1.`,
          );
          const opened = h2Open(environment, client, {
            path: route.path,
            headers: { ':authority': 'app.example.org', ...route.headers },
          });
          assert.equal(
            (await opened.answer).status,
            502,
            `${builder} ${route.name} refuses the certificate over HTTP/2.`,
          );
          await opened.payload;
          assert.equal(
            route.requests.length,
            0,
            `${builder} ${route.name} never reaches the untrusted upstream.`,
          );
        }
      } finally {
        client.close();
        await environment.close();
      }
    }
  },
);

test(
  'an unfinished HTTP/2 request body ends with 408',
  {
    timeout: 30000,
  },
  async () => {
    const environment = await startEnvironment();
    // The listener applies its configured incoming request deadline. Shorten it for the check.
    assert.equal(environment.edge.requestTimeout, 10000);
    environment.edge.requestTimeout = 400;
    const client = session(environment);
    try {
      const stream = client.request({
        ':path': '/api/auth/preferences',
        ':method': 'POST',
        'content-type': 'application/json',
        'content-length': 2,
      });
      const status = new Promise((resolve, reject) => {
        stream.on('response', (headers) => resolve(headers[':status']));
        stream.on('error', reject);
      });
      stream.write('{');
      assert.equal(await status, 408);
      assert.equal(
        environment.api.requests.length,
        0,
        'No upstream request starts for an incomplete body.',
      );
    } finally {
      client.close();
      await environment.close();
    }
  },
);

test(
  'a completed request and an open event stream outlive the request deadline',
  {
    timeout: 30000,
  },
  async () => {
    const environment = await startEnvironment();
    environment.edge.requestTimeout = 400;
    // Hold the upstream answer past the deadline. The request body completes first, so the
    // deadline must not cut the answer of a completed request.
    environment.api.answerDelay = 700;
    const client = session(environment);
    try {
      const events = h2Open(environment, client, { path: '/api/jobs/events' });
      assert.equal((await events.answer).status, 200);
      assert.match(await events.first, /retry: 3000/);
      const started = Date.now();
      const post = h2Open(environment, client, {
        path: '/api/auth/preferences',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"theme":"example"}',
      });
      assert.equal((await post.answer).status, 200);
      assert.ok(
        Date.now() - started >= 400,
        'The upstream answer arrived after the deadline.',
      );
      assert.equal(await post.payload, 'api');
      await delay(700);
      assert.equal(
        environment.api.open.size,
        1,
        'The event stream stays open past the deadline.',
      );
      assert.equal(
        events.stream.closed,
        false,
        'The deadline does not end the event stream.',
      );
      const again = h2Open(environment, client, { path: '/api/jobs' });
      assert.equal((await again.answer).status, 200);
      await again.payload;
      events.stream.close();
    } finally {
      client.close();
      await environment.close();
    }
  },
);

test(
  'an event request that completes after its headers outlives the request deadline',
  {
    timeout: 30000,
  },
  async () => {
    const environment = await startEnvironment();
    environment.edge.requestTimeout = 400;
    const client = session(environment);
    try {
      const stream = client.request(
        { ':path': '/api/jobs/events', ':method': 'GET' },
        { endStream: false },
      );
      const answer = new Promise((resolve, reject) => {
        stream.on('response', (headers) => resolve(headers[':status']));
        stream.on('error', reject);
      });
      const received = [];
      stream.on('data', (chunk) => received.push(chunk.toString('utf8')));
      const readable = async (pattern) => {
        const until = Date.now() + 3000;
        while (Date.now() < until) {
          if (received.join('').includes(pattern)) return;
          await delay(20);
        }
        assert.fail(`No ${pattern} arrived within 3 s.`);
      };
      assert.equal(await answer, 200);
      await readable('retry: 3000');
      assert.equal(environment.api.open.size, 1);
      // The client completes its request input with an empty DATA END_STREAM. The unread
      // request never emits end, so only the stream reports the completed input.
      stream.end();
      await delay(700);
      assert.equal(
        stream.closed,
        false,
        'The completed request stays open past the deadline.',
      );
      assert.equal(
        environment.api.open.size,
        1,
        'The upstream event stream stays open.',
      );
      const [upstream] = environment.api.open;
      upstream.write('data: later\n\n');
      await readable('data: later');
      stream.close();
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

test(
  'closing an HTTP/2 event stream releases its upstream request',
  {
    timeout: 30000,
  },
  async () => {
    const environment = await startEnvironment();
    const client = session(environment);
    try {
      const opened = h2Open(environment, client, { path: '/api/jobs/events' });
      assert.equal((await opened.answer).status, 200);
      assert.equal(environment.api.open.size, 1);
      opened.stream.close();
      const deadline = Date.now() + 2000;
      while (environment.api.open.size > 0 && Date.now() < deadline)
        await delay(20);
      assert.equal(
        environment.api.open.size,
        0,
        'The edge closed the upstream stream with the HTTP/2 stream.',
      );
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

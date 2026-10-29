import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import tls from 'node:tls';
import {
  importUploadPath,
  requestDeadline,
  requestDeadlines,
} from './application-edge.mjs';
import { createBootstrapEdge } from './edge.mjs';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function listen(server) {
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return server.address().port;
}

async function close(server) {
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
}

/**
 * Start a Phase 3 edge in front of a stub API and a stub frontend. The stub API answers each
 * request through `answer(request, response)`, so a test holds an answer past a deadline.
 */
async function startEdge({ answer, deadlines } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'cc-edge-deadline-'));
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
      'subjectAltName=DNS:localhost',
    ],
    { stdio: 'ignore' },
  );
  const cert = await readFile(join(directory, 'cert.pem'));
  const key = await readFile(join(directory, 'key.pem'));
  const api = http.createServer(
    answer ?? ((request, response) => response.end('api')),
  );
  const frontend = http.createServer((request, response) =>
    response.end('frontend'),
  );
  const apiPort = await listen(api);
  const frontendPort = await listen(frontend);
  const config = JSON.parse(
    await readFile('deployment/examples/all-docker.json', 'utf8'),
  );
  config.phase = 3;
  config.services.edge.access = 'application';
  config.services.frontend.endpoint.url = `http://127.0.0.1:${frontendPort}`;
  config.services.api.endpoint.url = `http://127.0.0.1:${apiPort}`;
  config.applicationAuth = {
    issuer: 'https://identity.example.invalid',
    clientId: 'synthetic-client',
    clientSecretRef: { provider: 'file', path: '/run/secrets/oidc-client' },
    publicOrigin: 'https://localhost',
  };
  const edge = await createBootstrapEdge({
    config,
    verify: async () => true,
    resolveSecret: async (ref) =>
      ref.path.endsWith('private-key') ? key : cert,
    ...(deadlines ? { deadlines } : {}),
  });
  const port = await listen(edge);
  return {
    edge,
    api,
    frontend,
    port,
    cert,
    async stop() {
      await close(edge);
      await close(api);
      await close(frontend);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

const statusOf = (data) => Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1]);

/**
 * Send one request over TLS and settle when its socket closes. `body` is the bytes written with
 * the headers. `trickle` keeps sending one byte every `interval` until the peer closes.
 */
function send(
  port,
  cert,
  {
    method = 'POST',
    path = '/',
    headers = {},
    body = '',
    trickle = false,
    keepAlive = false,
  },
) {
  return new Promise((resolve) => {
    const started = Date.now();
    let data = '';
    let writes = 0;
    const socket = tls.connect(
      { port, host: 'localhost', servername: 'localhost', ca: cert },
      () => {
        const lines = [`${method} ${path} HTTP/1.1`, 'Host: localhost'];
        for (const [name, value] of Object.entries(headers))
          lines.push(`${name}: ${value}`);
        if (!keepAlive) lines.push('Connection: close');
        socket.write(`${lines.join('\r\n')}\r\n\r\n${body}`);
      },
    );
    let timer;
    if (trickle)
      timer = setInterval(() => {
        if (socket.destroyed) return;
        writes += 1;
        socket.write('y');
      }, 50);
    socket.on('data', (chunk) => {
      data += chunk.toString('latin1');
    });
    socket.on('error', () => undefined);
    socket.on('close', () => {
      clearInterval(timer);
      resolve({
        status: statusOf(data),
        data,
        writes,
        elapsed: Date.now() - started,
      });
    });
  });
}

/**
 * Send headers and a partial body, then finish the declared body over `ms`. The edge sees a
 * slow body that completes before the long deadline.
 */
function sendSlowBody(port, cert, { method = 'POST', path, size, first, ms }) {
  return new Promise((resolve) => {
    const started = Date.now();
    let data = '';
    let sent = first;
    const socket = tls.connect(
      { port, host: 'localhost', servername: 'localhost', ca: cert },
      async () => {
        socket.write(
          `${method} ${path} HTTP/1.1\r\nHost: localhost\r\n` +
            `Content-Length: ${size}\r\nConnection: close\r\n\r\n` +
            'x'.repeat(first),
        );
        const steps = Math.max(1, Math.ceil((size - first) / 3));
        const step = Math.max(1, Math.floor(ms / steps));
        while (sent < size && !socket.destroyed) {
          await delay(step);
          const chunk = Math.min(3, size - sent);
          sent += chunk;
          socket.write('x'.repeat(chunk));
        }
      },
    );
    socket.on('data', (chunk) => {
      data += chunk.toString('latin1');
    });
    socket.on('error', () => undefined);
    socket.on('close', () =>
      resolve({ status: statusOf(data), data, elapsed: Date.now() - started }),
    );
  });
}

test('the ten-second body deadline covers unfinished GET, HEAD, and POST input', async () => {
  const started = [];
  // Hold every API answer, so only the edge deadline ends an unfinished request.
  const fixture = await startEdge({
    answer: (request, response) => {
      started.push(request.url);
      void request.resume();
      setTimeout(() => {
        if (!response.destroyed) response.end('api');
      }, 20000).unref();
    },
  });
  try {
    const [get, head, post] = await Promise.all([
      // A GET on the upload path is not an upload. It keeps the ordinary deadline.
      send(fixture.port, fixture.cert, {
        method: 'GET',
        path: `${importUploadPath}?mode=sync-changes&name=devices-2026-10-29.csv`,
        headers: { 'content-length': 2 },
        body: 'x',
      }),
      send(fixture.port, fixture.cert, {
        method: 'HEAD',
        path: '/api/jobs',
        headers: { 'content-length': 2 },
        body: 'x',
      }),
      send(fixture.port, fixture.cert, {
        method: 'POST',
        path: '/api/auth/preferences',
        headers: { 'content-length': 1000, 'content-type': 'application/json' },
        body: '{',
        trickle: true,
      }),
    ]);
    for (const [name, result] of [
      ['GET', get],
      ['HEAD', head],
      ['POST', post],
    ]) {
      assert.equal(result.status, 408, `${name} answered 408.`);
      assert.ok(
        result.elapsed >= 9000 && result.elapsed < 15000,
        `${name} waited ${result.elapsed} ms. The deadline is ten seconds.`,
      );
      // Each send settles only when the peer closes the connection.
      assert.ok(
        result.data.toLowerCase().includes('connection: close'),
        `${name} answered on a closing connection.`,
      );
    }
    // The trickling POST proves the peer closed input that was still arriving.
    assert.ok(post.writes >= 50, 'The POST kept sending after the answer.');
    assert.ok(
      get.data.includes('The request timed out.'),
      'The GET answer carries the deadline text.',
    );
    assert.ok(post.data.includes('The request timed out.'), 'POST text.');
    // Only a buffered body waits before its upstream request. A read forwards at once.
    assert.equal(
      started.includes('/api/auth/preferences'),
      false,
      'An unfinished POST body started no upstream request.',
    );
  } finally {
    await fixture.stop();
  }
});

test('completed input and event answers outlive the ten-second deadline', async () => {
  const fixture = await startEdge({
    answer: (request, response) => {
      if (request.url.startsWith('/api/devices/events')) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const timer = setInterval(
          () => response.write('event: ping\ndata: {}\n\n'),
          50,
        );
        const stop = setTimeout(() => {
          clearInterval(timer);
          response.end();
        }, 10500);
        response.once('close', () => {
          clearInterval(timer);
          clearTimeout(stop);
        });
        stop.unref();
        timer.unref();
        return;
      }
      void request.resume();
      setTimeout(() => {
        if (!response.destroyed) response.end('api');
      }, 10400).unref();
    },
  });
  try {
    const [get, post, events] = await Promise.all([
      // The framed body arrived at once, so the answer may take longer than the deadline.
      send(fixture.port, fixture.cert, {
        method: 'GET',
        path: '/api/jobs',
        headers: { 'content-length': 2 },
        body: 'xy',
      }),
      send(fixture.port, fixture.cert, {
        method: 'POST',
        path: '/api/auth/preferences',
        headers: { 'content-length': 2, 'content-type': 'application/json' },
        body: '{}',
      }),
      send(fixture.port, fixture.cert, {
        method: 'GET',
        path: '/api/devices/events',
      }),
    ]);
    assert.equal(get.status, 200, 'A completed GET body kept its answer.');
    assert.ok(
      get.elapsed >= 10000,
      `The completed GET answered after ${get.elapsed} ms.`,
    );
    assert.equal(post.status, 200, 'A completed POST body kept its answer.');
    assert.equal(events.status, 200, 'The event response answered 200.');
    assert.ok(
      (events.data.match(/event: ping/g) ?? []).length >= 100,
      `The event response sent ${events.data.length} bytes past the deadline.`,
    );
    assert.ok(
      events.elapsed >= 10000,
      `The event response ran ${events.elapsed} ms.`,
    );
  } finally {
    await fixture.stop();
  }
});

test('the long body deadline applies only to POST on the exact upload path', async () => {
  const deadlines = { request: 300, importUpload: 1500 };
  const fixture = await startEdge({
    deadlines,
    answer: (request, response) => {
      if (
        request.method === 'POST' &&
        request.url.startsWith(importUploadPath)
      ) {
        request.on('data', () => undefined);
        request.on('end', () => response.end('api'));
        return;
      }
      // A read answers at once, so only the input deadline can close its unfinished body.
      if (request.url.startsWith('/api/jobs')) return response.end('api');
      // Hold every other read, so only the edge deadline ends it.
      setTimeout(() => {
        if (!response.destroyed) response.end('api');
      }, 2000).unref();
    },
  });
  try {
    const [upload, get, head, ordinary, early] = await Promise.all([
      // The upload finishes its body after the ordinary deadline, before the long one.
      sendSlowBody(fixture.port, fixture.cert, {
        path: `${importUploadPath}?mode=sync-changes&name=devices-2026-10-29.csv`,
        size: 20,
        first: 2,
        ms: 600,
      }),
      send(fixture.port, fixture.cert, {
        method: 'GET',
        path: `${importUploadPath}?mode=sync-changes&name=devices-2026-10-29.csv`,
        headers: { 'content-length': 2 },
        body: 'x',
      }),
      send(fixture.port, fixture.cert, {
        method: 'HEAD',
        path: importUploadPath,
        headers: { 'content-length': 2 },
        body: 'x',
      }),
      // An ordinary POST body keeps the short deadline.
      sendSlowBody(fixture.port, fixture.cert, {
        path: '/api/auth/preferences',
        size: 20,
        first: 2,
        ms: 600,
      }),
      // The answer arrives at once. The input deadline still closes the unfinished body.
      send(fixture.port, fixture.cert, {
        method: 'GET',
        path: '/api/jobs',
        headers: { 'content-length': 2 },
        body: 'x',
        keepAlive: true,
      }),
    ]);
    assert.equal(upload.status, 200, 'The slow upload passed.');
    assert.ok(
      upload.elapsed >= 500,
      `The upload answered after ${upload.elapsed} ms, past the short deadline.`,
    );
    for (const [name, result] of [
      ['GET', get],
      ['HEAD', head],
      ['POST /api/auth/preferences', ordinary],
    ]) {
      assert.equal(result.status, 408, `${name} answered 408.`);
      assert.ok(
        result.elapsed >= 250 && result.elapsed < 1200,
        `${name} waited ${result.elapsed} ms, not the short deadline.`,
      );
    }
    // A finished answer does not end the input deadline. The unfinished body closes at it.
    assert.equal(early.status, 200, 'The early answer passed.');
    assert.ok(
      early.elapsed >= 250 && early.elapsed < 1200,
      `The unfinished body closed the connection after ${early.elapsed} ms.`,
    );
    assert.equal(
      early.data.includes('408 Request Timeout'),
      false,
      'A sent answer was not replaced by a 408.',
    );
  } finally {
    await fixture.stop();
  }
});

test('the listener carries the thirty-minute upload deadline and keeps the base limits', async () => {
  assert.deepEqual(requestDeadlines, { request: 10000, importUpload: 1800000 });
  const fixture = await startEdge();
  try {
    assert.equal(fixture.edge.requestTimeout, 1800000);
    assert.equal(fixture.edge.headersTimeout, 10000);
    assert.equal(fixture.edge.keepAliveTimeout, 5000);
  } finally {
    await fixture.stop();
  }
  // The path rule names both the method and the exact path.
  const deadlines = { request: 7, importUpload: 11 };
  assert.equal(requestDeadline('POST', importUploadPath, deadlines), 11);
  assert.equal(
    requestDeadline('POST', `${importUploadPath}?mode=a&name=b`, deadlines),
    11,
  );
  assert.equal(requestDeadline('GET', importUploadPath, deadlines), 7);
  assert.equal(
    requestDeadline('HEAD', `${importUploadPath}?mode=a`, deadlines),
    7,
  );
  assert.equal(
    requestDeadline('POST', `${importUploadPath}/IMP-001/execute`, deadlines),
    7,
  );
  assert.equal(requestDeadline('POST', '/api/devices/exports', deadlines), 7);
});

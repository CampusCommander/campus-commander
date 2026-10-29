import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { importUploadLimit, proxyApplication } from './application-edge.mjs';

test('application routes require Phase 3 and exact methods and paths', async () => {
  const listen = (server) =>
    new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = (server) => `http://127.0.0.1:${server.address().port}`;
  const frontend = http.createServer((request, response) =>
    response.end('frontend'),
  );
  const api = http.createServer((request, response) => response.end('api'));
  let edge;
  try {
    await listen(frontend);
    await listen(api);
    let phase = 3;
    edge = http.createServer((request, response) =>
      proxyApplication(
        request,
        response,
        {
          frontend: { url: new URL(origin(frontend)) },
          api: { url: new URL(origin(api)) },
        },
        origin(edge),
        phase,
      ),
    );
    await listen(edge);
    const id = '11111111-1111-4111-8111-111111111111';
    const customerId = 'C'.repeat(32);
    const schoolIds = Array.from({ length: 256 }, () => randomUUID());
    const grantBody = {
      expectedVersion: 2147483647,
      actorVersion: 2147483647,
      enabled: true,
      grants: schoolIds.map((schoolId) => ({
        action: 'security-events:read',
        scope: { kind: 'school', schoolId, customerId },
      })),
      schoolRevisions: schoolIds.map((schoolId) => ({
        schoolId,
        customerId,
        revision: 2147483647,
      })),
      invitationIds: Array.from({ length: 50 }, () => randomUUID()),
      confirmation: 'change-platform-access',
    };
    const confirmation = JSON.stringify(grantBody);
    assert.ok(Buffer.byteLength(confirmation) > 65536);
    for (const operation of ['review', 'access']) {
      assert.equal(
        (
          await fetch(`${origin(edge)}/api/platform-users/${id}/${operation}`, {
            method: 'POST',
            body:
              operation === 'access'
                ? confirmation
                : JSON.stringify({
                    expectedVersion: 2147483647,
                    enabled: true,
                    grants: grantBody.grants,
                  }),
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await fetch(`${origin(edge)}/api/platform-users/${id}/${operation}`, {
            method: 'POST',
            body: 'x'.repeat(98305),
          })
        ).status,
        413,
      );
    }
    assert.equal(
      (
        await fetch(`${origin(edge)}/api/google-connection/candidates`, {
          method: 'POST',
          body: 'x'.repeat(12000),
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(`${origin(edge)}/api/google-connection/candidates`, {
          method: 'POST',
          body: 'x'.repeat(65537),
        })
      ).status,
      413,
    );
    assert.equal(
      (
        await fetch(
          `${origin(edge)}/api/google-connection/candidates/${id}/confirm`,
          { method: 'POST', body: 'x'.repeat(4097) },
        )
      ).status,
      413,
    );
    const routes = [
      ['GET', '/api/schools', 'api'],
      ['GET', `/api/schools/${id}`, 'api'],
      ['GET', `/api/schools/${id}/audit`, 'api'],
      ['GET', `/api/schools/reviews/${id}`, 'api'],
      ['POST', '/api/schools/reviews', 'api'],
      ['POST', `/api/schools/reviews/${id}/confirm`, 'api'],
      ['GET', '/api/schools/references', 'api'],
      ['POST', '/api/schools/references/refresh', 'api'],
      ['GET', '/api/customer', 'api'],
      ['GET', `/api/customer/receipts/${id}`, 'api'],
      ['POST', '/api/customer/settings', 'api'],
      ['GET', '/customer-settings', 'frontend'],
      ['GET', '/schools', 'frontend'],
      ['GET', '/api/google-connection', 'api'],
      ['GET', '/api/google-connection/health', 'api'],
      ['GET', '/api/google-connection/credentials', 'api'],
      ['POST', '/api/google-connection/replacements', 'api'],
      ['POST', `/api/google-connection/replacements/${id}/activate`, 'api'],
      ['POST', '/api/google-connection/credentials/rotate-key', 'api'],
      ['POST', '/api/google-connection/credentials/disconnect', 'api'],
      ['POST', '/api/google-connection/health/check', 'api'],
      ['GET', `/api/google-connection/candidates/${id}`, 'api'],
      ['POST', '/api/google-connection/candidates', 'api'],
      ['POST', '/api/google-connection/check', 'api'],
      ['POST', `/api/google-connection/candidates/${id}/confirm`, 'api'],
      ['GET', '/invitations', 'frontend'],
      ['GET', '/platform-users', 'frontend'],
      ['GET', '/invitation', 'frontend'],
      ['GET', '/google-connection', 'frontend'],
      ['GET', '/api/auth/invitations', 'api'],
      ['GET', '/api/auth/invitations/status', 'api'],
      ['POST', '/api/auth/invitations', 'api'],
      ['POST', '/api/auth/invitations/redeem', 'api'],
      ['POST', `/api/auth/invitations/${id}/confirm`, 'api'],
      ['POST', `/api/auth/invitations/${id}/revoke`, 'api'],
      ['GET', '/api/platform-users', 'api'],
      ['GET', `/api/platform-users/${id}`, 'api'],
      ['GET', `/api/platform-users/${id}/receipts`, 'api'],
      ['POST', `/api/platform-users/${id}/review`, 'api'],
      ['POST', `/api/platform-users/${id}/access`, 'api'],
      ['GET', '/api/devices/sync', 'api'],
      ['POST', '/api/devices/sync', 'api'],
      ['POST', '/api/devices/query', 'api'],
      ['POST', '/api/devices/groups', 'api'],
      ['POST', '/api/devices/selection', 'api'],
      ['POST', '/api/devices/selection/ops', 'api'],
      ['POST', '/api/devices/selection/refresh', 'api'],
      ['POST', '/api/devices/selection/resolve', 'api'],
      ['POST', '/api/devices/domain/refresh', 'api'],
      ['POST', '/api/devices/by-ids', 'api'],
      ['POST', '/api/devices/freshness', 'api'],
      ['GET', '/api/devices/events', 'api'],
      ['GET', '/api/devices/synthetic-device-1', 'api'],
      ['GET', '/api/devices/org-units', 'api'],
      // A single device segment still reads as a device route, and only a POST to it streams.
      ['GET', '/api/devices/imports', 'api'],
      ['GET', '/devices', 'frontend'],
      ['GET', '/devices/synthetic-device-1', 'frontend'],
      ['GET', '/api/jobs', 'api'],
      ['GET', '/api/jobs/UPD-001', 'api'],
      ['GET', '/api/jobs/UPD-001/operations', 'api'],
      ['POST', '/api/jobs/UPD-001/operations/1/reconcile', 'api'],
      ['POST', '/api/jobs/UPD-001/cancel', 'api'],
      ['POST', '/api/jobs/REF-001/cancel', 'api'],
      ['GET', '/api/jobs/CMD-001', 'api'],
      ['GET', '/api/jobs/CMD-001/operations', 'api'],
      ['POST', '/api/jobs/CMD-001/operations/1/reconcile', 'api'],
      ['GET', '/api/jobs/STS-001', 'api'],
      ['POST', '/api/jobs/STS-001/operations/1/reconcile', 'api'],
      ['GET', '/api/jobs/activity', 'api'],
      ['POST', '/api/jobs/activity/seen', 'api'],
      ['GET', '/api/jobs/requesters', 'api'],
      ['GET', '/api/jobs/events', 'api'],
      ['GET', '/api/devices/updates/access', 'api'],
      ['GET', '/api/devices/updates/org-units', 'api'],
      ['POST', '/api/devices/updates/access/check', 'api'],
      ['POST', '/api/devices/updates/previews', 'api'],
      ['POST', '/api/devices/updates/edit-previews', 'api'],
      ['GET', `/api/devices/updates/previews/${id}`, 'api'],
      ['GET', `/api/devices/updates/previews/${id}/targets`, 'api'],
      ['POST', `/api/devices/updates/previews/${id}/confirm`, 'api'],
      ['POST', '/api/devices/commands/previews', 'api'],
      ['GET', `/api/devices/commands/previews/${id}`, 'api'],
      ['GET', `/api/devices/commands/previews/${id}/targets`, 'api'],
      ['POST', `/api/devices/commands/previews/${id}/confirm`, 'api'],
      ['POST', '/api/devices/status-changes/previews', 'api'],
      ['GET', `/api/devices/status-changes/previews/${id}`, 'api'],
      ['GET', `/api/devices/status-changes/previews/${id}/targets`, 'api'],
      ['POST', `/api/devices/status-changes/previews/${id}/confirm`, 'api'],
      ['GET', '/jobs', 'frontend'],
      ['GET', '/jobs/UPD-001', 'frontend'],
      // The export and import paths of design section 1.
      ['POST', '/api/devices/exports', 'api'],
      ['GET', '/api/devices/exports/EXP-001/file', 'api'],
      [
        'POST',
        '/api/devices/imports?mode=sync-all&name=devices-2026-10-29.csv',
        'api',
      ],
      ['POST', '/api/devices/imports/IMP-001/revalidate', 'api'],
      ['GET', '/api/devices/imports/IMP-001/report', 'api'],
      ['GET', '/api/devices/imports/IMP-001/rejected', 'api'],
      ['POST', '/api/devices/imports/IMP-001/execute', 'api'],
      ['POST', '/api/devices/imports/IMP-001/cancel', 'api'],
      // Job routes and job pages carry both file kinds.
      ['GET', '/api/jobs/EXP-001', 'api'],
      ['GET', '/api/jobs/EXP-001/operations', 'api'],
      ['POST', '/api/jobs/EXP-001/cancel', 'api'],
      ['GET', '/api/jobs/IMP-001', 'api'],
      ['GET', '/api/jobs/IMP-001/operations', 'api'],
      ['POST', '/api/jobs/IMP-001/cancel', 'api'],
      ['GET', '/jobs/EXP-001', 'frontend'],
      ['GET', '/jobs/IMP-001', 'frontend'],
    ];
    for (const [method, path, expected] of routes) {
      const response = await fetch(`${origin(edge)}${path}`, { method });
      assert.equal(response.status, 200, `${method} ${path}`);
      assert.equal(await response.text(), expected);
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    for (const [method, path, status] of [
      ['POST', '/api/schools', 405],
      ['GET', '/api/devices', 404],
      ['GET', '/jobs/UPD-001/receipt', 404],
      ['GET', '/devices/update', 404],
      ['GET', `/devices/update/previews/${id}`, 404],
      ['GET', `/devices/update/previews/${id}/confirm`, 404],
      ['GET', '/devices/a/b', 404],
      ['GET', '/api/devices/a/b', 404],
      ['GET', `/api/devices/${'x'.repeat(129)}`, 404],
      ['POST', '/api/devices/synthetic-device-1', 405],
      ['POST', '/api/devices/selection/other', 404],
      ['POST', '/api/devices/events', 405],
      ['POST', '/api/devices/by-ids/extra', 404],
      ['GET', '/api/devices/selection/ops', 405],
      ['PUT', '/api/devices/groups', 405],
      ['GET', '/api/schools/reviews', 405],
      ['POST', `/api/schools/${id}`, 405],
      ['GET', `/api/schools/reviews/${id}/confirm`, 405],
      ['GET', '/api/schools/not-a-uuid', 404],
      ['GET', `/api/schools/reviews/${id}/audit`, 404],
      ['POST', '/api/schools/references', 405],
      ['GET', '/api/schools/references/refresh', 405],
      ['GET', '/api/schools/references/private', 404],
      ['POST', '/api/google-connection/health', 405],
      ['GET', '/api/google-connection/health/check', 405],
      ['GET', '/api/google-connection/health/private', 404],
      ['POST', '/api/customer', 405],
      ['GET', '/api/customer/settings', 405],
      ['POST', `/api/customer/receipts/${id}`, 405],
      ['GET', '/api/customer/receipts/not-a-uuid', 404],
      ['GET', `/api/auth/invitations/${id}/confirm`, 405],
      ['POST', '/api/auth/invitations/status', 405],
      ['DELETE', '/api/auth/invitations', 405],
      ['POST', '/api/auth/invitations/not-a-uuid/revoke', 404],
      ['POST', `/api/auth/invitations/${id}/arbitrary`, 404],
      ['GET', '/api/auth/invitations/private', 404],
      ['GET', `/api/platform-users/${id}/access`, 405],
      ['POST', `/api/platform-users/${id}`, 405],
      ['POST', `/api/platform-users/${id}/receipts`, 405],
      ['POST', '/api/platform-users/not-a-uuid/access', 404],
      ['POST', '/api/jobs', 405],
      ['GET', '/api/jobs/activity/seen', 405],
      ['POST', '/api/jobs/UPD-001', 405],
      ['POST', '/api/jobs/UPD-001/operations', 405],
      ['GET', '/api/jobs/UPD-001/operations/1/reconcile', 405],
      ['POST', '/api/jobs/events', 405],
      ['POST', '/api/jobs/requesters', 405],
      ['GET', '/api/jobs/not-a-display-id', 404],
      ['GET', '/api/jobs/UPD-001/private', 404],
      ['POST', '/api/jobs/UPD-001/operations/0/reconcile', 404],
      ['POST', '/api/jobs/UPD-001/operations/one/reconcile', 404],
      // The cancel route takes one display ID and no part after it.
      ['GET', '/api/jobs/UPD-001/cancel', 405],
      ['POST', '/api/jobs/UPD-001/cancel/extra', 404],
      ['POST', '/api/jobs/UPD-001/cancelled', 404],
      ['POST', '/api/jobs/activity/cancel', 404],
      ['POST', '/api/jobs/not-a-display-id/cancel', 404],
      ['GET', '/api/devices/updates/access/check', 405],
      ['POST', '/api/devices/updates/access', 405],
      ['GET', '/api/devices/updates/previews', 405],
      ['GET', '/api/devices/updates/edit-previews', 405],
      ['POST', `/api/devices/updates/previews/${id}`, 405],
      ['GET', `/api/devices/updates/previews/${id}/confirm`, 405],
      ['POST', `/api/devices/updates/previews/${id}/targets`, 405],
      ['GET', '/api/devices/updates/previews/not-a-uuid', 404],
      ['GET', '/api/devices/commands/previews', 405],
      ['POST', `/api/devices/commands/previews/${id}`, 405],
      ['GET', `/api/devices/commands/previews/${id}/confirm`, 405],
      ['POST', `/api/devices/commands/previews/${id}/targets`, 405],
      ['GET', '/api/devices/status-changes/previews', 405],
      ['POST', `/api/devices/status-changes/previews/${id}`, 405],
      ['GET', `/api/devices/status-changes/previews/${id}/confirm`, 405],
      ['POST', `/api/devices/status-changes/previews/${id}/targets`, 405],
      ['GET', '/api/devices/status-changes/previews/not-a-uuid', 404],
      ['PUT', '/api/devices/commands/previews', 405],
      // The file routes are reads, and the other new paths keep one method each.
      ['POST', '/api/devices/exports/EXP-001/file', 405],
      ['GET', '/api/devices/imports/IMP-001/execute', 405],
      ['GET', '/api/devices/imports/IMP-001/cancel', 405],
      ['GET', '/api/devices/imports/IMP-001/revalidate', 405],
      ['POST', '/api/devices/imports/IMP-001/report', 405],
      ['POST', '/api/devices/imports/IMP-001/rejected', 405],
      // A file path names the job kind of its own route, so another kind answers 404.
      ['GET', '/api/devices/exports/UPD-001/file', 404],
      ['GET', '/api/devices/imports/UPD-001/report', 404],
      ['POST', '/api/devices/imports/EXP-001/cancel', 404],
      ['GET', '/api/devices/exports/EXP-001', 404],
      ['POST', '/api/devices/imports/IMP-001', 404],
      ['GET', '/api/devices/imports/IMP-1/report', 404],
      ['POST', '/api/devices/imports/IMP-001/execute/extra', 404],
      ['GET', '/api/jobs/EXP-1', 404],
      ['GET', '/api/jobs/IMP-1/operations', 404],
    ]) {
      assert.equal(
        (await fetch(`${origin(edge)}${path}`, { method })).status,
        status,
        path,
      );
    }
    assert.equal(
      (
        await fetch(`${origin(edge)}/api/schools/references/refresh`, {
          method: 'POST',
          body: 'x'.repeat(4097),
        })
      ).status,
      413,
    );
    // Device selection and query bodies carry ID batches, group routes, and set filters.
    for (const [size, status] of [
      [65536, 200],
      [98305, 413],
    ])
      assert.equal(
        (
          await fetch(`${origin(edge)}/api/devices/selection/resolve`, {
            method: 'POST',
            body: 'x'.repeat(size),
          })
        ).status,
        status,
        `${size} bytes`,
      );
    // A by-ids body carries up to 500 device IDs.
    for (const [size, status] of [
      [65536, 200],
      [98305, 413],
    ])
      assert.equal(
        (
          await fetch(`${origin(edge)}/api/devices/by-ids`, {
            method: 'POST',
            body: 'x'.repeat(size),
          })
        ).status,
        status,
        `by-ids ${size} bytes`,
      );
    // The edit route accepts an edit list of 98,304 bytes and refuses one byte more.
    for (const [size, status] of [
      [98304, 200],
      [98305, 413],
    ])
      assert.equal(
        (
          await fetch(`${origin(edge)}/api/devices/updates/edit-previews`, {
            method: 'POST',
            body: 'x'.repeat(size),
          })
        ).status,
        status,
        `edit-previews ${size} bytes`,
      );
    // The selection preview and its confirm keep the 4,096-byte cap.
    for (const path of [
      '/api/devices/updates/previews',
      `/api/devices/updates/previews/${id}/confirm`,
    ])
      assert.equal(
        (
          await fetch(`${origin(edge)}${path}`, {
            method: 'POST',
            body: 'x'.repeat(4097),
          })
        ).status,
        413,
        `${path} 4097 bytes`,
      );
    // Every import path but the upload keeps the 4,096-byte buffered cap.
    for (const [size, status] of [
      [4096, 200],
      [4097, 413],
    ])
      assert.equal(
        (
          await fetch(
            `${origin(edge)}/api/devices/imports/IMP-001/revalidate`,
            { method: 'POST', body: 'x'.repeat(size) },
          )
        ).status,
        status,
        `revalidate ${size} bytes`,
      );
    phase = 2;
    for (const [method, path] of routes) {
      assert.equal(
        (await fetch(`${origin(edge)}${path}`, { method })).status,
        404,
        path,
      );
    }
  } finally {
    for (const server of [edge, frontend, api])
      if (server) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
  }
});

test('the device event stream outlives the request timeout while pings flow', async () => {
  const listen = (server) =>
    new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = (server) => `http://127.0.0.1:${server.address().port}`;
  const api = http.createServer((request, response) => {
    if (
      !request.url.startsWith('/api/devices/events') &&
      !request.url.startsWith('/api/jobs/events')
    )
      return;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('retry: 3000\n\n');
    // A silent stream must end at the edge.
    if (request.url.endsWith('silent=1')) return;
    let sent = 0;
    const timer = setInterval(() => {
      response.write('event: ping\ndata: {}\n\n');
      sent += 1;
      if (sent === 6) {
        clearInterval(timer);
        response.end();
      }
    }, 50);
  });
  const frontend = http.createServer((request, response) =>
    response.end('frontend'),
  );
  let edge;
  try {
    await listen(api);
    await listen(frontend);
    edge = http.createServer((request, response) =>
      proxyApplication(
        request,
        response,
        {
          frontend: { url: new URL(origin(frontend)) },
          api: { url: new URL(origin(api)) },
        },
        origin(edge),
        3,
        { request: 120, events: 200 },
      ),
    );
    await listen(edge);
    const guard = () => ({ signal: AbortSignal.timeout(2000) });
    const events = await fetch(`${origin(edge)}/api/devices/events`, guard());
    assert.equal(events.headers.get('content-type'), 'text/event-stream');
    assert.equal(events.headers.get('cache-control'), 'no-store');
    const text = await events.text();
    assert.equal(
      text.split('event: ping').length - 1,
      6,
      'The stream ran past the 120 ms request timeout.',
    );
    const silent = await fetch(
      `${origin(edge)}/api/devices/events?silent=1`,
      guard(),
    );
    const quiet = Date.now();
    await assert.rejects(silent.text());
    assert.ok(Date.now() - quiet < 1000, 'The edge ended the silent stream.');
    // The Jobs stream carries the same event idle timeout.
    const jobs = await fetch(`${origin(edge)}/api/jobs/events`, guard());
    assert.equal(jobs.headers.get('content-type'), 'text/event-stream');
    assert.equal(
      (await jobs.text()).split('event: ping').length - 1,
      6,
      'The Jobs stream ran past the 120 ms request timeout.',
    );
    const silentJobs = await fetch(
      `${origin(edge)}/api/jobs/events?silent=1`,
      guard(),
    );
    const quietJobs = Date.now();
    await assert.rejects(silentJobs.text());
    assert.ok(
      Date.now() - quietJobs < 1000,
      'The edge ended the silent stream.',
    );
    // Every other request keeps the request timeout.
    assert.equal(
      (await fetch(`${origin(edge)}/api/devices/sync`, guard())).status,
      502,
    );
  } finally {
    for (const server of [edge, frontend, api])
      if (server) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
  }
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait for a condition and fail with the message when it stays false. */
async function until(condition, message, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (condition()) return;
    await delay(10);
  }
  assert.fail(message);
}

/**
 * Write a body of `bytes` bytes to the client request. The first `first` bytes arrive before the
 * callback runs, so a test reads the upstream while the body is still open.
 */
async function writeStream(
  request,
  bytes,
  { chunk = 65536, first = 0, between = async () => undefined },
) {
  const block = Buffer.alloc(chunk, 0x61);
  const write = (size) =>
    new Promise((resolve) => {
      if (request.write(size === chunk ? block : block.subarray(0, size)))
        resolve();
      else request.once('drain', resolve);
    });
  let sent = 0;
  const more = async (limit) => {
    while (sent < limit) {
      const size = Math.min(chunk, limit - sent);
      sent += size;
      await write(size);
    }
  };
  await more(Math.min(first, bytes));
  if (first > 0) await between();
  await more(bytes);
  request.end();
}

/** Post a body of `bytes` bytes to the edge and settle with its answer. */
function streamPost(origin, path, bytes, options = {}) {
  return new Promise((resolve) => {
    const request = http.request(
      `${origin}${path}`,
      {
        method: 'POST',
        headers: { 'content-type': 'text/csv', 'content-length': bytes },
        agent: false,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            body: Buffer.concat(chunks).toString('utf8'),
            headers: response.headers,
          }),
        );
        response.on('aborted', () =>
          resolve({ status: response.statusCode, aborted: true }),
        );
      },
    );
    request.on('error', (error) =>
      resolve({ error: error.code ?? error.message }),
    );
    // The refused upload closes the connection under the writer.
    writeStream(request, bytes, options).catch(() => undefined);
  });
}

test(
  'the import upload streams its body and answers 413 above 1 GiB',
  { timeout: 180000 },
  async () => {
    const listen = (server) =>
      new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = (server) => `http://127.0.0.1:${server.address().port}`;
    const received = [];
    const api = http.createServer((request, response) => {
      const entry = {
        url: request.url,
        headers: { ...request.headers },
        size: 0,
        complete: false,
      };
      received.push(entry);
      request.on('data', (chunk) => (entry.size += chunk.length));
      request.on('end', () => {
        entry.complete = true;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('api');
      });
    });
    const frontend = http.createServer((request, response) =>
      response.end('frontend'),
    );
    let edge;
    try {
      await listen(api);
      await listen(frontend);
      edge = http.createServer((request, response) =>
        proxyApplication(
          request,
          response,
          {
            frontend: { url: new URL(origin(frontend)) },
            api: { url: new URL(origin(api)) },
          },
          origin(edge),
          3,
        ),
      );
      await listen(edge);
      const query = '?mode=sync-changes&name=devices-2026-10-29.csv';
      // The accepted upload carries its query, and the API reads bytes before the body ends.
      const accepted = await streamPost(
        origin(edge),
        `/api/devices/imports${query}`,
        importUploadLimit,
        {
          first: 65536,
          between: () =>
            until(
              () => received.at(-1)?.size > 0,
              'The API received no byte before the upload ended.',
            ),
        },
      );
      assert.equal(accepted.status, 200);
      const upload = received.at(-1);
      assert.equal(upload.url, `/api/devices/imports${query}`);
      assert.equal(upload.headers['content-type'], 'text/csv');
      // The edge forwards the file as it arrives, so it never learns the length first.
      assert.equal(upload.headers['content-length'], undefined);
      assert.equal(upload.headers['transfer-encoding'], 'chunked');
      assert.equal(upload.complete, true);
      assert.equal(
        upload.size,
        importUploadLimit,
        'The API received every byte of the accepted file.',
      );
      // One more byte than the cap answers 413, and the API gets no byte past the cap.
      const refused = await streamPost(
        origin(edge),
        `/api/devices/imports${query}`,
        importUploadLimit + 1,
      );
      assert.equal(refused.status, 413);
      assert.equal(refused.body, 'The request exceeds the size limit.\n');
      const partial = received.at(-1);
      assert.ok(
        partial.size <= importUploadLimit,
        `The API received ${partial.size} bytes of the refused upload.`,
      );
      assert.equal(partial.complete, false);
    } finally {
      for (const server of [edge, api, frontend])
        if (server) {
          server.closeAllConnections();
          await new Promise((resolve) => server.close(resolve));
        }
    }
  },
);

test('the two file routes pass the attachment header and every other route drops it', async () => {
  const listen = (server) =>
    new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = (server) => `http://127.0.0.1:${server.address().port}`;
  const attachment = 'attachment; filename="devices-2026-10-29.csv"';
  const api = http.createServer((request, response) => {
    response.writeHead(200, {
      'content-type': 'text/csv',
      'content-disposition': attachment,
    });
    response.end('api');
  });
  const frontend = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('frontend');
  });
  let edge;
  try {
    await listen(api);
    await listen(frontend);
    edge = http.createServer((request, response) =>
      proxyApplication(
        request,
        response,
        {
          frontend: { url: new URL(origin(frontend)) },
          api: { url: new URL(origin(api)) },
        },
        origin(edge),
        3,
      ),
    );
    await listen(edge);
    for (const path of [
      '/api/devices/exports/EXP-001/file',
      '/api/devices/imports/IMP-001/rejected',
    ]) {
      const response = await fetch(`${origin(edge)}${path}`);
      assert.equal(response.status, 200, path);
      assert.equal(
        response.headers.get('content-disposition'),
        attachment,
        path,
      );
    }
    for (const [method, path] of [
      ['GET', '/api/jobs'],
      ['GET', '/api/devices/imports/IMP-001/report'],
      ['GET', '/api/jobs/IMP-001'],
      ['POST', '/api/devices/exports'],
      ['POST', '/api/devices/imports/IMP-001/cancel'],
      ['GET', '/api/devices/synthetic-device-1'],
      ['GET', '/devices'],
    ]) {
      const response = await fetch(`${origin(edge)}${path}`, { method });
      assert.equal(response.status, 200, `${method} ${path}`);
      assert.equal(
        response.headers.get('content-disposition'),
        null,
        `${method} ${path}`,
      );
    }
    // The edge keeps dropping the header on its own answers.
    const missing = await fetch(
      `${origin(edge)}/api/devices/exports/EXP-001/file/extra`,
    );
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get('content-disposition'), null);
  } finally {
    for (const server of [edge, api, frontend])
      if (server) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
  }
});

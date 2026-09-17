import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { proxyApplication } from './application-edge.mjs';

test('invitation routes require Phase 3 and exact methods and paths', async () => {
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
    const routes = [
      ['GET', '/invitations', 'frontend'],
      ['GET', '/invitation', 'frontend'],
      ['GET', '/api/auth/invitations', 'api'],
      ['GET', '/api/auth/invitations/status', 'api'],
      ['POST', '/api/auth/invitations', 'api'],
      ['POST', '/api/auth/invitations/redeem', 'api'],
      ['POST', `/api/auth/invitations/${id}/confirm`, 'api'],
      ['POST', `/api/auth/invitations/${id}/revoke`, 'api'],
    ];
    for (const [method, path, expected] of routes) {
      const response = await fetch(`${origin(edge)}${path}`, { method });
      assert.equal(response.status, 200, `${method} ${path}`);
      assert.equal(await response.text(), expected);
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    for (const [method, path, status] of [
      ['GET', `/api/auth/invitations/${id}/confirm`, 405],
      ['POST', '/api/auth/invitations/status', 405],
      ['DELETE', '/api/auth/invitations', 405],
      ['POST', '/api/auth/invitations/not-a-uuid/revoke', 404],
      ['POST', `/api/auth/invitations/${id}/arbitrary`, 404],
      ['GET', '/api/auth/invitations/private', 404],
    ]) {
      assert.equal(
        (await fetch(`${origin(edge)}${path}`, { method })).status,
        status,
        path,
      );
    }
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

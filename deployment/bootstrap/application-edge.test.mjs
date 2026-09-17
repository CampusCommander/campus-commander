import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { proxyApplication } from './application-edge.mjs';

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
      ['GET', '/api/schools/references', 'api'],
      ['POST', '/api/schools/references/refresh', 'api'],
      ['GET', '/api/customer', 'api'],
      ['GET', `/api/customer/receipts/${id}`, 'api'],
      ['POST', '/api/customer/settings', 'api'],
      ['GET', '/customer-settings', 'frontend'],
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
    ];
    for (const [method, path, expected] of routes) {
      const response = await fetch(`${origin(edge)}${path}`, { method });
      assert.equal(response.status, 200, `${method} ${path}`);
      assert.equal(await response.text(), expected);
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    for (const [method, path, status] of [
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

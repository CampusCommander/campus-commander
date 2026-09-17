import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

// Keep this inventory aligned with the route matrix in phase-3-security.md.
export const phase3ProtectedRoutes = [
  ['GET', '/api/customer'],
  ['GET', '/api/customer/receipts/:id'],
  ['POST', '/api/customer/settings'],
  ['GET', '/api/platform-users'],
  ['GET', '/api/platform-users/:id'],
  ['GET', '/api/platform-users/:id/receipts'],
  ['POST', '/api/platform-users/:id/review'],
  ['POST', '/api/platform-users/:id/access'],
  ['GET', '/api/auth/invitations'],
  ['POST', '/api/auth/invitations'],
  ['POST', '/api/auth/invitations/:id/confirm'],
  ['POST', '/api/auth/invitations/:id/revoke'],
  ['GET', '/api/google-connection'],
  ['GET', '/api/google-connection/health'],
  ['GET', '/api/google-connection/candidates/:id'],
  ['GET', '/api/google-connection/credentials'],
  ['POST', '/api/google-connection/check'],
  ['POST', '/api/google-connection/health/check'],
  ['POST', '/api/google-connection/candidates'],
  ['POST', '/api/google-connection/candidates/:id/confirm'],
  ['POST', '/api/google-connection/replacements'],
  ['POST', '/api/google-connection/replacements/:id/activate'],
  ['POST', '/api/google-connection/credentials/rotate-key'],
  ['POST', '/api/google-connection/credentials/disconnect'],
  ['GET', '/api/schools'],
  ['GET', '/api/schools/:id'],
  ['GET', '/api/schools/:id/audit'],
  ['GET', '/api/schools/reviews/:id'],
  ['POST', '/api/schools/reviews'],
  ['POST', '/api/schools/reviews/:id/confirm'],
  ['GET', '/api/schools/references'],
  ['POST', '/api/schools/references/refresh'],
];

export async function qualifyPhase3RouteSecurity({
  request,
  publicOrigin,
  ca,
  cookie,
  csrfToken,
  evidenceDirectory,
}) {
  const started = Date.now();
  const results = [];
  const verify = (response, status, route, boundary) => {
    assert.equal(response.status, status, `${boundary}: ${route}`);
    assert.equal(response.headers['cache-control'], 'no-store', route);
    assert.equal(
      response.headers['access-control-allow-origin'],
      undefined,
      route,
    );
    for (const secret of [cookie, cookie.split('=')[1], csrfToken]) {
      assert.ok(secret.length > 0);
      assert.equal(
        response.text.includes(secret),
        false,
        `Response redaction: ${route}`,
      );
    }
    results.push({ route, boundary, status: response.status });
  };
  for (const [method, template] of phase3ProtectedRoutes) {
    const route = `${method} ${template}`;
    const url =
      publicOrigin +
      template.replace(':id', '11111111-1111-4111-8111-111111111111');
    const body = method === 'POST' ? {} : undefined;
    verify(
      await request(url, { ca, method, body }),
      401,
      route,
      'missing-session',
    );
    if (method !== 'POST') continue;
    for (const [boundary, headers] of [
      ['missing-csrf', { origin: publicOrigin }],
      [
        'wrong-origin',
        { origin: 'https://wrong.example.invalid', 'x-csrf-token': csrfToken },
      ],
      [
        'wrong-content-type',
        {
          origin: publicOrigin,
          'x-csrf-token': csrfToken,
          'content-type': 'text/plain',
        },
      ],
    ]) {
      verify(
        await request(url, { ca, cookie, method, body, headers }),
        403,
        route,
        boundary,
      );
    }
  }
  await writeFile(
    `${evidenceDirectory}/phase3-route-security.json`,
    JSON.stringify(
      {
        schemaVersion: 1,
        sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], {
          encoding: 'utf8',
        }).trim(),
        recordedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
        environment:
          'public HTTPS edge, real API, PostgreSQL, Redis, synthetic identity provider',
        routes: phase3ProtectedRoutes.length,
        checks: results,
        limits: [
          'Guard checks do not establish action or resource authorization after valid browser checks.',
          'Per-feature fixtures retain grant, scope, audit rollback, and provider failure checks.',
          'This report does not establish complete release qualification.',
        ],
      },
      null,
      2,
    ),
  );
}

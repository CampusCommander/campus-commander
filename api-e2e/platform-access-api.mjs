import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

export async function qualifyPlatformAccessApi({
  admin,
  recipient,
  identity,
  publicOrigin,
  evidenceDirectory,
}) {
  const session = await (
    await admin.get(`${publicOrigin}/api/auth/session`)
  ).json();
  const headers = { origin: publicOrigin, 'x-csrf-token': session.csrfToken };
  const root = `${publicOrigin}/api/platform-users`;
  const target = `${root}/${identity.id}`;
  const grants = [
    { action: 'customer:read', scope: { kind: 'platform' } },
    { action: 'schools:read', scope: { kind: 'platform' } },
  ];
  const change = {
    expectedVersion: identity.permissionVersion,
    enabled: true,
    grants,
  };
  for (const path of [root, target, `${target}/receipts`])
    assert.equal((await recipient.get(path)).status(), 403);
  const forbiddenSession = await (
    await recipient.get(`${publicOrigin}/api/auth/session`)
  ).json();
  assert.equal(
    (
      await recipient.post(`${target}/review`, {
        headers: {
          origin: publicOrigin,
          'x-csrf-token': forbiddenSession.csrfToken,
        },
        data: change,
      })
    ).status(),
    403,
  );
  const page = await admin.get(`${root}?offset=0&limit=1`);
  assert.equal(page.status(), 200);
  const listed = await page.json();
  assert.equal(listed.items.length, 1);
  assert.ok(listed.total >= 2);
  assert.equal((await admin.get(`${root}?limit=101`)).status(), 400);
  assert.equal(
    (
      await admin.post(`${target}/review`, {
        headers: { origin: publicOrigin },
        data: change,
      })
    ).status(),
    403,
  );
  assert.equal(
    (
      await admin.post(`${target}/review`, {
        headers: { ...headers, origin: 'https://wrong.invalid' },
        data: change,
      })
    ).status(),
    403,
  );
  const unchanged = await admin.post(`${target}/review`, {
    headers,
    data: { ...change, grants: identity.grants },
  });
  assert.equal(unchanged.status(), 409);
  assert.deepEqual(await unchanged.json(), { reason: 'unchanged' });
  const reviewResponse = await admin.post(`${target}/review`, {
    headers,
    data: change,
  });
  assert.equal(reviewResponse.status(), 201);
  const review = await reviewResponse.json();
  assert.equal(review.current.id, identity.id);
  assert.deepEqual(review.current.grants, identity.grants);
  assert.deepEqual(review.proposed, { enabled: true, grants });
  assert.equal(
    (await (await admin.get(target)).json()).permissionVersion,
    identity.permissionVersion,
  );
  const confirmed = {
    ...change,
    actorVersion: review.actorVersion,
    invitationIds: review.invitationsToRevoke.map(
      (invitation) => invitation.id,
    ),
    confirmation: 'change-platform-access',
  };
  assert.equal(
    (await admin.post(`${target}/access`, { headers, data: change })).status(),
    400,
  );
  assert.equal(
    (
      await admin.post(`${target}/access`, {
        headers,
        data: { ...confirmed, actorVersion: review.actorVersion + 1 },
      })
    ).status(),
    409,
  );
  const accepted = await admin.post(`${target}/access`, {
    headers,
    data: confirmed,
  });
  assert.equal(accepted.status(), 201);
  const result = await accepted.json();
  assert.deepEqual(result.principal.grants, grants);
  assert.equal(
    result.principal.permissionVersion,
    identity.permissionVersion + 1,
  );
  assert.ok(result.receiptId && result.correlationId);
  const receipts = await (await admin.get(`${target}/receipts`)).json();
  assert.equal(receipts.total, 1);
  assert.equal(receipts.items[0].id, result.receiptId);
  assert.deepEqual(receipts.items[0].previous.grants, identity.grants);
  assert.deepEqual(receipts.items[0].applied.grants, grants);
  assert.equal((await admin.get(`${target}/receipts?offset=-1`)).status(), 400);
  assert.deepEqual(
    (await (await admin.get(`${target}/receipts?offset=20`)).json()).items,
    [],
  );
  assert.equal(
    (await recipient.get(`${publicOrigin}/api/auth/session`)).status(),
    401,
  );
  assert.equal(
    (
      await admin.post(`${target}/access`, { headers, data: confirmed })
    ).status(),
    409,
  );
  const self = `${root}/${session.identity.id}`;
  assert.equal(
    (
      await admin.post(`${self}/review`, {
        headers,
        data: {
          expectedVersion: session.identity.permissionVersion,
          enabled: false,
          grants: session.identity.grants,
        },
      })
    ).status(),
    403,
  );
  for (const [enabled, expectedVersion] of [
    [false, result.principal.permissionVersion],
    [true, result.principal.permissionVersion + 1],
  ]) {
    const response = await admin.post(`${target}/access`, {
      headers,
      data: { ...confirmed, expectedVersion, enabled },
    });
    assert.equal(response.status(), 201);
    assert.equal((await response.json()).principal.enabled, enabled);
  }
  await writeFile(
    `${evidenceDirectory}/platform-access-api.json`,
    JSON.stringify(
      {
        status: 'passed',
        sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], {
          encoding: 'utf8',
        }).trim(),
        recordedAt: new Date().toISOString(),
        checks: [
          'authorized principal list, count, detail, and bounded pagination',
          'direct invited-user read and grant-management denial',
          'origin and CSRF rejection',
          'review preserves state and exposes exact grant changes',
          'confirmation and actor revision required',
          'exact grants, permission version, and durable receipt returned',
          'previous recipient session rejected after grant change',
          'stale confirmation denied',
          'last platform administrator disable denied',
          'principal disable and enable preserve stable identity',
        ],
        limits: ['Verified district resource integration remains pending.'],
      },
      null,
      2,
    ),
  );
}

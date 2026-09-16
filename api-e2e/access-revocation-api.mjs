import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export async function qualifyAccessRevocation({
  login,
  setSubject,
  restartReplica,
  restartRedis,
  request,
  publicOrigin,
  replicaOrigin,
  ca,
  migrator,
  observer,
  redis,
  evidenceDirectory,
}) {
  setSubject('invited-platform-user');
  let unrelatedCookie;
  try {
    const result = await login();
    unrelatedCookie = result.finish.headers['set-cookie']
      .find((value) => value.startsWith('__Host-cc-session='))
      .split(';')[0];
  } finally {
    setSubject('administrator');
  }
  const unrelatedResponse = await request(`${publicOrigin}/api/auth/session`, {
    ca,
    cookie: unrelatedCookie,
  });
  assert.equal(unrelatedResponse.status, 200);
  const unrelated = JSON.parse(unrelatedResponse.text).identity;
  const sessions = [];
  for (let index = 0; index < 2; index++) {
    const result = await login();
    const cookie = result.finish.headers['set-cookie']
      .find((value) => value.startsWith('__Host-cc-session='))
      .split(';')[0];
    const response = await request(`${publicOrigin}/api/auth/session`, {
      ca,
      cookie,
    });
    assert.equal(response.status, 200);
    const session = JSON.parse(response.text);
    const key = `cc:auth:session:${createHash('sha256').update(cookie.split('=')[1]).digest('hex')}`;
    sessions.push({ cookie, session, key, stored: await redis.get(key) });
  }
  const { cookie, session } = sessions[0];
  const principalId = session.identity.id;
  const auditCount = async () =>
    Number(
      (
        await migrator.query(
          "SELECT count(*) FROM cc.security_events WHERE actor_id=$1 AND event='preferences-changed'",
          [principalId],
        )
      ).rows[0].count,
    );
  const beforeCount = await auditCount();
  const previous = (
    await migrator.query(
      'SELECT preferences FROM cc.application_principals WHERE id=$1',
      [principalId],
    )
  ).rows[0].preferences;
  const proposed = {
    theme: previous.theme === 'light' ? 'dark' : 'light',
    navigationCollapsed: !previous.navigationCollapsed,
  };
  let pending;
  await migrator.query('BEGIN');
  try {
    await migrator.query(
      'SELECT id FROM cc.application_principals WHERE id=$1 FOR UPDATE',
      [principalId],
    );
    pending = request(`${publicOrigin}/api/auth/preferences`, {
      ca,
      cookie,
      method: 'POST',
      body: proposed,
      headers: { origin: publicOrigin, 'x-csrf-token': session.csrfToken },
    });
    void pending.catch(() => undefined);
    // Observe the blocked write after authentication reads the previous version.
    let blocked = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await observer.query(
        "SELECT count(*) FROM pg_stat_activity WHERE datname='cc-app' AND wait_event_type='Lock' AND query LIKE 'UPDATE cc.application_principals SET preferences=%'",
      );
      if (Number(result.rows[0].count) > 0) {
        blocked = true;
        break;
      }
      await delay(10);
    }
    assert.equal(
      blocked,
      true,
      'The preference request must reach its database write before revocation.',
    );
    await migrator.query(
      'UPDATE cc.application_principals SET permission_version=permission_version+1 WHERE id=$1',
      [principalId],
    );
    await migrator.query('COMMIT');
  } catch (error) {
    await migrator.query('ROLLBACK');
    await pending?.catch(() => undefined);
    throw error;
  }
  const rejected = await pending;
  assert.equal(rejected.status, 401);
  assert.equal(JSON.parse(rejected.text).code, 'access-changed');
  assert.deepEqual(
    (
      await migrator.query(
        'SELECT preferences FROM cc.application_principals WHERE id=$1',
        [principalId],
      )
    ).rows[0].preferences,
    previous,
  );
  assert.equal(await auditCount(), beforeCount);
  for (const [index, origin] of [publicOrigin, replicaOrigin].entries()) {
    const stale = sessions[index];
    for (const restored of [false, true]) {
      if (restored) await redis.set(stale.key, stale.stored, { EX: 60 });
      const response = await request(`${origin}/api/auth/session`, {
        ca,
        cookie: stale.cookie,
      });
      assert.equal(response.status, 401);
      assert.equal(JSON.parse(response.text).code, 'access-changed');
      assert.equal(await redis.get(stale.key), null);
    }
  }
  for (const origin of [publicOrigin, replicaOrigin]) {
    const response = await request(`${origin}/api/auth/session`, {
      ca,
      cookie: unrelatedCookie,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.text).identity, unrelated);
    const denied = await request(
      `${origin}/api/platform-users/${unrelated.id}`,
      { ca, cookie },
    );
    assert.equal(denied.status, 401);
    assert.equal(denied.text.includes(unrelated.id), false);
  }
  await restartReplica();
  await redis.set(sessions[1].key, sessions[1].stored, { EX: 60 });
  const afterRestart = await request(`${replicaOrigin}/api/auth/session`, {
    ca,
    cookie: sessions[1].cookie,
  });
  assert.equal(afterRestart.status, 401);
  assert.equal(JSON.parse(afterRestart.text).code, 'access-changed');
  assert.equal(await redis.get(sessions[1].key), null);
  await restartRedis();
  for (const [index, origin] of [publicOrigin, replicaOrigin].entries()) {
    const stale = sessions[index];
    const missing = await request(`${origin}/api/auth/session`, {
      ca,
      cookie: stale.cookie,
    });
    assert.equal(missing.status, 401);
    await redis.set(stale.key, stale.stored, { EX: 60 });
    const restored = await request(`${origin}/api/auth/session`, {
      ca,
      cookie: stale.cookie,
    });
    assert.equal(restored.status, 401);
    assert.equal(JSON.parse(restored.text).code, 'access-changed');
    assert.equal(await redis.get(stale.key), null);
  }
  assert.equal(
    (
      await request(`${publicOrigin}/api/auth/session`, {
        ca,
        cookie: unrelatedCookie,
      })
    ).status,
    401,
  );
  setSubject('invited-platform-user');
  try {
    const result = await login();
    const freshCookie = result.finish.headers['set-cookie']
      .find((value) => value.startsWith('__Host-cc-session='))
      .split(';')[0];
    const response = await request(`${publicOrigin}/api/auth/session`, {
      ca,
      cookie: freshCookie,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.text).identity, unrelated);
  } finally {
    setSubject('administrator');
  }
  await writeFile(
    `${evidenceDirectory}/access-revocation-api.json`,
    JSON.stringify(
      {
        status: 'passed',
        sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], {
          encoding: 'utf8',
        }).trim(),
        recordedAt: new Date().toISOString(),
        checks: [
          'preference write waits behind a concurrent permission-version change',
          'stale preference update and success audit both rejected',
          'both API replicas reject previous sessions',
          'restored Redis sessions cannot restore revoked access',
          'direct requests with guessed principal IDs disclose no data',
          'API restart and Redis loss cannot restore revoked access',
          'unrelated users retain access and recover unchanged after Redis loss',
        ],
        limits: [
          'School integration and background Google credential independence require their remaining implementation.',
        ],
      },
      null,
      2,
    ),
  );
}

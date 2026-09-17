import {
  stageGoogleConnectionBrowser,
  confirmGoogleConnectionBrowser,
} from './google-connection-browser.mjs';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

export async function qualifyGoogleConnectionApi({
  admin,
  page,
  auditAccessibility,
  publicOrigin,
  migrator,
  evidenceDirectory,
}) {
  const session = await (
    await admin.get(`${publicOrigin}/api/auth/session`)
  ).json();
  const headers = { origin: publicOrigin, 'x-csrf-token': session.csrfToken };
  assert.deepEqual(
    await (await admin.get(`${publicOrigin}/api/customer`)).json(),
    { customer: null },
  );
  const root = `${publicOrigin}/api/google-connection`;
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
    publicKeyEncoding: { format: 'pem', type: 'spki' },
  });
  const input = {
    id: randomUUID(),
    clientId: '123456789',
    subject: 'administrator@fixture.invalid',
    serviceAccount: {
      type: 'service_account',
      client_id: '123456789',
      client_email: 'fixture@project.iam.gserviceaccount.com',
      private_key: privateKey,
      private_key_id: 'fixture-key',
      token_uri: 'https://oauth2.googleapis.com/token',
    },
  };
  assert.equal((await admin.get(root)).status(), 200);
  assert.deepEqual(await (await admin.get(root)).json(), { connection: null });
  for (const invalidHeaders of [
    { origin: publicOrigin },
    { ...headers, origin: 'https://wrong.invalid' },
  ]) {
    assert.equal(
      (
        await admin.post(`${root}/candidates`, {
          headers: invalidHeaders,
          data: input,
        })
      ).status(),
      403,
    );
  }
  const invalid = await admin.post(`${root}/candidates`, {
    headers,
    data: { ...input, clientId: '987654321' },
  });
  assert.equal(invalid.status(), 400);
  assert.deepEqual(await invalid.json(), {
    reason: 'invalid-service-account-file',
  });
  const candidate = await stageGoogleConnectionBrowser({
    page,
    publicOrigin,
    input,
    auditAccessibility,
    evidenceDirectory,
  });
  input.id = candidate.id;
  assert.equal(candidate.id, input.id);
  assert.equal(candidate.status, 'ready');
  assert.equal(candidate.observation.customerId, 'C0123456');
  assert.equal('envelope' in candidate, false);
  assert.equal('serviceAccount' in candidate, false);
  assert.equal(JSON.stringify(candidate).includes(privateKey), false);
  assert.deepEqual(
    await (await admin.get(`${root}/candidates/${input.id}`)).json(),
    candidate,
  );
  assert.equal(
    (await admin.post(`${root}/candidates`, { headers, data: input })).status(),
    409,
  );
  assert.equal(
    (
      await admin.post(`${root}/candidates/${input.id}/confirm`, {
        headers,
        data: { customerId: 'C0123456' },
      })
    ).status(),
    400,
  );
  assert.equal(
    (
      await admin.post(`${root}/candidates/${input.id}/confirm`, {
        headers,
        data: { customerId: 'C9999999', confirmed: true },
      })
    ).status(),
    409,
  );
  await confirmGoogleConnectionBrowser({
    page,
    candidate,
    evidenceDirectory,
    auditAccessibility,
  });
  const { connection } = await (await admin.get(root)).json();
  assert.equal(connection.customerId, 'C0123456');
  assert.equal(connection.generation, 1);
  assert.equal('envelope' in connection, false);
  assert.equal(
    (await (await admin.get(`${root}/candidates/${input.id}`)).json()).status,
    'consumed',
  );
  assert.equal(
    (
      await admin.post(`${root}/candidates/${input.id}/confirm`, {
        headers,
        data: { customerId: 'C0123456', confirmed: true },
      })
    ).status(),
    409,
  );
  const stored = (
    await migrator.query(
      'SELECT envelope FROM cc.google_credentials WHERE id=$1',
      [input.id],
    )
  ).rows[0].envelope;
  assert.equal(stored.keyId, 'synthetic-google-key');
  assert.equal(JSON.stringify(stored).includes('PRIVATE KEY'), false);

  assert.equal(
    (
      await admin.post(`${root}/check`, {
        data: { customerId: 'C0123456', generation: 1 },
      })
    ).status(),
    403,
  );
  assert.equal(
    (
      await admin.post(`${root}/check`, {
        headers,
        data: { customerId: 'C0123456', generation: 2 },
      })
    ).status(),
    409,
  );
  const checked = await admin.post(`${root}/check`, {
    headers,
    data: { customerId: 'C0123456', generation: 1 },
  });
  assert.equal(checked.status(), 201, await checked.text());
  assert.equal((await checked.json()).observation.customerId, 'C0123456');

  assert.equal(
    (
      await admin.post(`${root}/check`, {
        headers,
        data: { customerId: 'C0123456', generation: 1 },
      })
    ).status(),
    429,
  );
  await migrator.query(
    "UPDATE cc.google_health_checks SET retry_at=clock_timestamp()-interval '1 second'",
  );
  const actor = session.identity.id;
  const originalScopes = (
    await migrator.query(
      "SELECT scope FROM cc.application_grants WHERE principal_id=$1 AND action='connection:diagnose'",
      [actor],
    )
  ).rows;
  try {
    await migrator.query(
      "DELETE FROM cc.application_grants WHERE principal_id=$1 AND action='connection:diagnose'",
      [actor],
    );
    await migrator.query(
      "INSERT INTO cc.application_grants(principal_id,action,scope) VALUES($1,'connection:diagnose',$2)",
      [actor, JSON.stringify({ kind: 'district', customerId: 'C0123456' })],
    );
    assert.equal(
      (
        await admin.post(`${root}/check`, {
          headers,
          data: { customerId: 'C0123456', generation: 1, retry: true },
        })
      ).status(),
      201,
    );
    assert.equal(
      (
        await admin.post(`${root}/check`, {
          headers,
          data: { customerId: 'C9999999', generation: 1 },
        })
      ).status(),
      403,
    );
    await migrator.query(
      "UPDATE cc.application_grants SET scope=$2 WHERE principal_id=$1 AND action='connection:diagnose'",
      [actor, JSON.stringify({ kind: 'district', customerId: 'C9999999' })],
    );
    assert.equal(
      (
        await admin.post(`${root}/check`, {
          headers,
          data: { customerId: 'C0123456', generation: 1 },
        })
      ).status(),
      403,
    );
  } finally {
    await migrator.query(
      "DELETE FROM cc.application_grants WHERE principal_id=$1 AND action='connection:diagnose'",
      [actor],
    );
    for (const { scope } of originalScopes)
      await migrator.query(
        "INSERT INTO cc.application_grants(principal_id,action,scope) VALUES($1,'connection:diagnose',$2)",
        [actor, JSON.stringify(scope)],
      );
  }
  await writeFile(
    `${evidenceDirectory}/google-connection-api.json`,
    JSON.stringify(
      {
        schemaVersion: 1,
        fixture: 'synthetic-google-transport',
        checks: [
          'current browser authority and CSRF required',
          'invalid client ID rejected before staging',
          'candidate metadata supports response recovery without credentials',
          'explicit exact customer confirmation required',
          'confirmation stores encrypted generation one and rejects replay',
          'API checks require CSRF and the active credential generation',
          'platform and confirmed district grants permit checks while unrelated districts fail',
        ],
      },
      null,
      2,
    ),
  );
}

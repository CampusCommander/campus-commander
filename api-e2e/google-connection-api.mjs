import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

export async function qualifyGoogleConnectionApi({
  admin,
  publicOrigin,
  migrator,
  evidenceDirectory,
}) {
  const session = await (
    await admin.get(`${publicOrigin}/api/auth/session`)
  ).json();
  const headers = { origin: publicOrigin, 'x-csrf-token': session.csrfToken };
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
  const staged = await admin.post(`${root}/candidates`, {
    headers,
    data: input,
  });
  assert.equal(staged.status(), 201, await staged.text());
  const candidate = await staged.json();
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
  const confirmation = await admin.post(
    `${root}/candidates/${input.id}/confirm`,
    { headers, data: { customerId: 'C0123456', confirmed: true } },
  );
  assert.equal(confirmation.status(), 201, await confirmation.text());
  assert.equal((await confirmation.json()).customerId, 'C0123456');
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
        ],
      },
      null,
      2,
    ),
  );
}

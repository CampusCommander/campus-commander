import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from '@playwright/test';

export async function qualifyGoogleLifecycleApi({
  browser,
  publicOrigin,
  migrator,
  directory,
  evidenceDirectory,
  fixture,
  setSubject,
}) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const faultPath = join(directory, 'google-health-fault.json');
  try {
    setSubject('administrator');
    const page = await context.newPage();
    await page.goto(`${publicOrigin}/api/auth/login`);
    await expect(
      page.getByRole('heading', { name: 'Your account', exact: true }),
    ).toBeVisible({ timeout: 15000 });
    const api = context.request;
    const session = await (
      await api.get(`${publicOrigin}/api/auth/session`)
    ).json();
    const root = `${publicOrigin}/api/google-connection`;
    const headers = { origin: publicOrigin, 'x-csrf-token': session.csrfToken };
    const read = async () => {
      const response = await api.get(`${root}/credentials`);
      assert.equal(response.status(), 200, await response.text());
      const result = await response.json();
      assert.equal('envelope' in result.credential, false);
      assert.equal(JSON.stringify(result).includes('PRIVATE KEY'), false);
      return result;
    };
    const post = async (path, data, status = 201) => {
      const response = await api.post(`${root}/${path}`, { headers, data });
      assert.equal(response.status(), status, await response.text());
      return response.json();
    };
    const initial = (await read()).credential;
    const beforeSettings = await (
      await api.get(`${publicOrigin}/api/customer`)
    ).json();
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
      publicKeyEncoding: { format: 'pem', type: 'spki' },
    });
    const input = {
      customerId: initial.customerId,
      generation: initial.generation,
      clientId: '123456789',
      subject: 'replacement@fixture.invalid',
      serviceAccount: {
        type: 'service_account',
        client_id: '123456789',
        client_email: 'fixture@project.iam.gserviceaccount.com',
        private_key: privateKey,
        private_key_id: 'replacement',
        token_uri: 'https://oauth2.googleapis.com/token',
      },
    };
    const target = (current) => ({
      customerId: current.customerId,
      generation: current.generation,
      confirmed: true,
    });
    for (const path of [
      'replacements',
      'credentials/rotate-key',
      'credentials/disconnect',
    ])
      assert.equal(
        (
          await api.post(`${root}/${path}`, {
            data: { ...input, id: randomUUID() },
          })
        ).status(),
        403,
      );
    await post(
      'replacements',
      { ...input, id: randomUUID(), customerId: 'C9999999' },
      409,
    );
    await writeFile(
      faultPath,
      JSON.stringify({ mode: 'domain-privilege-denied' }),
    );
    const failed = await post('replacements', { ...input, id: randomUUID() });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.failure, 'permission-denied');
    assert.deepEqual((await read()).credential, initial);
    await writeFile(faultPath, JSON.stringify({ mode: 'wrong-customer' }));
    const wrong = await post('replacements', { ...input, id: randomUUID() });
    assert.equal(wrong.status, 'failed');
    assert.equal(wrong.failure, 'wrong-customer');
    assert.deepEqual((await read()).credential, initial);
    await rm(faultPath, { force: true });
    const replacement = await post('replacements', {
      ...input,
      id: randomUUID(),
    });
    assert.equal(replacement.status, 'ready');
    assert.equal(replacement.expectedCustomerId, initial.customerId);
    assert.equal('envelope' in replacement, false);
    await post(
      `replacements/${replacement.id}/activate`,
      { customerId: initial.customerId, generation: initial.generation },
      400,
    );
    let current = await post(`replacements/${replacement.id}/activate`, {
      ...target(initial),
      keyId: initial.keyId,
    });
    assert.equal(current.generation, initial.generation + 1);
    assert.equal(current.customerId, initial.customerId);
    await post(
      `replacements/${replacement.id}/activate`,
      { ...target(initial), keyId: initial.keyId },
      409,
    );
    await post(
      'credentials/rotate-key',
      { ...target(current), keyId: 'missing-key' },
      503,
    );
    assert.deepEqual((await read()).credential, current);
    const rotated = await post('credentials/rotate-key', {
      ...target(current),
      keyId: 'synthetic-google-key-2',
    });
    assert.equal(rotated.generation, current.generation + 1);
    assert.equal(rotated.keyId, 'synthetic-google-key-2');
    await post('credentials/disconnect', target(current), 409);
    current = rotated;
    const dispatch = await readFile(
      join(directory, 'secrets/worker-dispatch'),
      'utf8',
    );
    const workerRead = (generation) =>
      fetch(`${fixture.workerOrigin}/dispatch/google-customer`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${dispatch}`,
        },
        body: JSON.stringify({
          customerId: current.customerId,
          generation,
          correlationId: randomUUID(),
          executionId: randomUUID(),
        }),
        signal: AbortSignal.timeout(70000),
      });
    const result = await workerRead(current.generation);
    assert.equal(result.status, 200, await result.clone().text());
    assert.equal((await result.json()).generation, current.generation);
    assert.equal(
      (await migrator.query('SELECT envelope FROM cc.google_access_tokens'))
        .rows[0].envelope.keyId,
      'synthetic-google-key-2',
    );
    const oldKeyPath = join(directory, 'secrets/google-credential-key-2');
    const savedKey = await readFile(oldKeyPath);
    try {
      await rm(oldKeyPath);
      const recovery = await post('replacements', {
        ...input,
        generation: current.generation,
        id: randomUUID(),
      });
      assert.equal(recovery.status, 'ready');
      current = await post(`replacements/${recovery.id}/activate`, {
        ...target(current),
        keyId: 'synthetic-google-key',
      });
      assert.equal(current.keyId, 'synthetic-google-key');
      assert.equal((await workerRead(current.generation)).status, 200);
    } finally {
      await writeFile(oldKeyPath, savedKey);
      savedKey.fill(0);
    }
    const disconnected = await post('credentials/disconnect', target(current));
    assert.equal(disconnected.active, false);
    assert.equal((await workerRead(current.generation)).status, 503);
    current = disconnected;
    assert.equal((await workerRead(current.generation)).status, 503);
    assert.equal(
      (await api.get(`${publicOrigin}/api/auth/session`)).status(),
      200,
    );
    const savedSettings = await (
      await api.get(`${publicOrigin}/api/customer`)
    ).json();
    assert.equal(
      savedSettings.customer.customerId,
      beforeSettings.customer.customerId,
    );
    assert.equal(
      savedSettings.customer.revision,
      beforeSettings.customer.revision,
    );
    const reconnected = await post('replacements', {
      ...input,
      generation: current.generation,
      id: randomUUID(),
    });
    current = await post(`replacements/${reconnected.id}/activate`, {
      ...target(current),
      keyId: current.keyId,
    });
    assert.equal(current.active, true);
    assert.equal(current.keyId, 'synthetic-google-key');
    assert.equal((await workerRead(current.generation)).status, 200);
    const secrets = (
      await migrator.query('SELECT envelope FROM cc.google_credentials')
    ).rows;
    assert.equal(secrets.length, 1);
    assert.ok(
      secrets.every((row) => !JSON.stringify(row).includes(privateKey)),
    );
    await writeFile(
      join(evidenceDirectory, 'google-lifecycle-api.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          fixture: 'real-api-worker-postgres-synthetic-google',
          checks: [
            'management metadata excludes encrypted and plaintext secrets',
            'CSRF and exact current customer generation required',
            'failed and wrong-customer verification preserve the working credential',
            'reviewed replacement requires explicit confirmation and rejects replay',
            'unavailable target key preserves current credential',
            'fresh verified replacement recovers with the old active key absent',
            'atomic key rotation advances the generation and worker uses the new key',
            'local disconnect rejects retired and disconnected generation reads',
            'disconnect preserves sign-in and customer settings',
            'same-customer reconnect uses the committed key and restores worker reads',
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    await rm(faultPath, { force: true });
    await context.close();
  }
}

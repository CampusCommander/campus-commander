import assert from 'node:assert/strict';
import test from 'node:test';
import { connectionOptions, loadMigrations } from './index.mjs';

const service = {
  placement: { kind: 'external' },
  endpoint: {
    url: 'postgresql://db.example.test:5432',
    tls: { mode: 'system-ca' },
  },
  database: 'cc-app',
  role: 'cc-app',
  passwordSecretRef: { provider: 'file', path: '/run/secrets/app' },
};

test('external transport cannot disable certificate verification', async () => {
  await assert.rejects(
    connectionOptions(
      {
        ...service,
        endpoint: { ...service.endpoint, tls: { mode: 'disabled' } },
      },
      () => 'secret',
    ),
  );
  const options = await connectionOptions(service, () => Buffer.from('secret'));
  assert.equal(options.ssl.rejectUnauthorized, true);
  assert.equal(options.host, 'db.example.test');
  assert.equal(options.password, 'secret');
});

test('connection URLs cannot override TLS settings or carry credentials', async () => {
  for (const url of [
    'postgresql://db.example.test?sslmode=disable',
    'postgresql://user:secret@db.example.test',
    'postgresql://db.example.test/database',
  ]) {
    await assert.rejects(
      connectionOptions(
        { ...service, endpoint: { ...service.endpoint, url } },
        () => 'secret',
      ),
    );
  }
});

test('private CA comes from the configured secret reference', async () => {
  const ref = { provider: 'file', path: '/run/secrets/ca' };
  const options = await connectionOptions(
    {
      ...service,
      endpoint: {
        ...service.endpoint,
        tls: { mode: 'private-ca', caSecretRef: ref },
      },
    },
    (value) => (value === ref ? 'CA fixture' : 'password'),
  );
  assert.equal(options.ssl.ca, 'CA fixture');
  assert.equal(options.ssl.rejectUnauthorized, true);
});

test('the release identifies its SQL migration by content checksum', async () => {
  const migrations = await loadMigrations();
  assert.equal(migrations.length, 1);
  assert.match(migrations[0].checksum, /^[a-f0-9]{64}$/);
});

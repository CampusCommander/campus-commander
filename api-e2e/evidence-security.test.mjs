import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mkdtemp,
  writeFile,
  readFile,
  rm,
  access,
  mkdir,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvidenceSecurity } from './evidence-security.mjs';

const secret = 'fixture-private-value:alpha\nbeta';

test('redaction rejects raw, encoded, escaped, and binary secret values without exposing them', () => {
  const security = new EvidenceSecurity();
  security.register('fixture-secret', secret);
  for (const value of [
    secret,
    JSON.stringify(secret),
    encodeURIComponent(secret),
    Buffer.from(secret).toString('base64'),
  ]) {
    assert.throws(
      () => security.assertSafe(`prefix${value}suffix`, 'fixture report'),
      (error) =>
        error.message ===
          'fixture report contains a protected fixture-secret value.' &&
        !error.message.includes(secret),
    );
  }
  const key = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
  security.register('encryption-key', key);
  for (const value of [key, key.toString('hex'), key.toString('base64')]) {
    assert.throws(
      () => security.assertSafe(value, 'fixture report'),
      /protected encryption-key/,
    );
  }
  assert.throws(
    () => security.assertSafe('-----BEGIN PRIVATE KEY-----', 'report'),
    /private key material/,
  );
});

test('response registration covers cookies and nested tokens without treating normal error codes as secrets', () => {
  const security = new EvidenceSecurity();
  security.observeResponse(
    { 'set-cookie': ['__Host-session=opaque-cookie-value; Secure'] },
    JSON.stringify({
      csrfToken: 'fixture-csrf-value',
      nested: { access_token: 'fixture-access-value' },
      code: 'forbidden',
    }),
  );
  for (const value of [
    'opaque-cookie-value',
    'fixture-csrf-value',
    'fixture-access-value',
  ]) {
    assert.throws(() => security.assertSafe(value, 'response'), /protected/);
  }
  security.assertSafe('forbidden', 'safe response');
  const pairingCode = 'a'.repeat(64);
  security.observeResponse({}, JSON.stringify({ code: pairingCode }));
  assert.throws(
    () => security.assertSafe(pairingCode, 'pairing response'),
    /pairing-code/,
  );
});

test('artifact scan removes unsafe files, rejects unchecked images, and retains safe evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cc-evidence-security-'));
  try {
    const security = new EvidenceSecurity();
    security.register('fixture-secret', secret);
    await mkdir(join(directory, 'nested'));
    await writeFile(
      join(directory, 'nested', 'unsafe.json'),
      JSON.stringify({ value: secret }),
    );
    await writeFile(join(directory, 'safe.json'), '{"status":"passed"}');
    await writeFile(join(directory, 'unchecked.png'), 'image');
    await writeFile(join(directory, 'unchecked.jpg'), 'image');
    await assert.rejects(
      security.scan(directory),
      (error) =>
        error.message.includes('fixture-secret') &&
        error.message.includes('screenshot content check') &&
        error.message.includes('unsupported evidence format') &&
        !error.message.includes(secret),
    );
    await assert.rejects(access(join(directory, 'nested', 'unsafe.json')));
    await assert.rejects(access(join(directory, 'unchecked.png')));
    await assert.rejects(access(join(directory, 'unchecked.jpg')));
    const report = await security.scan(directory, {
      api: 'safe service output',
    });
    assert.equal(report.status, 'passed');
    assert.equal(report.files.length, 1);
    assert.equal(report.files[0].name, 'safe.json');
    assert.equal(report.secretCategories['fixture-secret'], 1);
    assert.equal(JSON.stringify(report).includes(secret), false);
    await assert.rejects(
      security.scan(directory, { api: secret }),
      /api contains a protected/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('screenshot checks reject content changes and bind passing checks to exact image bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cc-screenshot-security-'));
  try {
    const security = new EvidenceSecurity();
    security.register('fixture-secret', secret);
    const path = join(directory, 'screen.png');
    let content = 'safe document';
    let exposeAfterCapture = true;
    const page = {
      context: () => ({ cookies: async () => [] }),
      evaluate: async () => content,
      screenshot: async () => {
        const bytes = Buffer.from('synthetic screenshot');
        await writeFile(path, bytes);
        if (exposeAfterCapture) content = secret;
        return bytes;
      },
    };
    await assert.rejects(
      security.screenshot(page, { path }),
      /protected fixture-secret/,
    );
    await assert.rejects(access(path));
    content = 'safe document';
    exposeAfterCapture = false;
    await security.screenshot(page, { path });
    const report = await security.scan(directory);
    assert.equal(report.screenshotChecks, 1);
    assert.equal(report.files.length, 1);
    await writeFile(
      path,
      Buffer.concat([await readFile(path), Buffer.from('changed')]),
    );
    await assert.rejects(security.scan(directory), /matching screenshot/);
    await symlink('/tmp', join(directory, 'outside'));
    await assert.rejects(security.scan(directory), /regular files/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

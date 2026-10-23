import assert from 'node:assert/strict';
import test from 'node:test';
import { redactText, redactUrl } from './evidence-redaction.mjs';

test('a URL keeps its origin, path, and parameter names, and loses every value', () => {
  assert.equal(
    redactUrl(
      'https://user:pass@qualification.invalid/api/auth/callback?code=synthetic-code&state=synthetic-state#access_token=synthetic-token',
    ),
    'https://qualification.invalid/api/auth/callback?code=redacted&state=redacted#redacted',
  );
});

test('a relative callback path loses its query values and its fragment', () => {
  assert.equal(
    redactUrl('/api/auth/callback?code=synthetic-code&state=synthetic-state#x'),
    '/api/auth/callback?code=redacted&state=redacted#redacted',
  );
});

test('a console message keeps its words and loses the credentials inside it', () => {
  const credential = 'synthetic-bearer-value';
  const message =
    'Failed to load resource: https://qualification.invalid/api/auth/callback?code=synthetic-code&state=synthetic-state ' +
    `Authorization: Bearer ${credential} ` +
    'token eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMifQ.c2lnbmF0dXJlLXN5bnRoZXRpYw ' +
    'opaque ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop';
  const redacted = redactText(message);
  assert.ok(!redacted.includes('synthetic-code'));
  assert.ok(!redacted.includes('synthetic-state'));
  assert.ok(!redacted.includes(credential));
  assert.ok(!redacted.includes('eyJhbGciOiJSUzI1NiJ9'));
  assert.ok(!redacted.includes('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop'));
  assert.match(
    redacted,
    /^Failed to load resource: https:\/\/qualification\.invalid\/api\/auth\/callback\?code=redacted&state=redacted /,
  );
  assert.match(redacted, /Authorization: Bearer redacted/);
});

test('redaction runs before truncation, so a cut keeps no part of a value', () => {
  // The marker straddles the cutoff. Truncation before redaction would keep
  // its first characters in the record.
  const message =
    'The page failed after the sign-in redirect and the navigation error ' +
    '?code=SYNTHETIC-AUTH-CODE-0123456789';
  const redacted = redactText(message, 82);
  assert.equal(redacted.length, 82);
  assert.ok(!redacted.includes('SYNTHETIC'));
  assert.ok(!redacted.includes('SYN'));
  assert.ok(redacted.includes('code=redacted'));
});

test('a registered value is redacted whatever its length and delimiter', () => {
  const marker = 'synthetic-marker-0123456789';
  const message =
    `callback failed for ${marker} ` +
    `code=${marker} ` +
    `{"code":"${marker}"}`;
  assert.equal(
    redactText(message, Infinity, [marker]),
    'callback failed for redacted code=redacted {"code":"redacted"}',
  );
});

test('a longer registered value is redacted before a value that it contains', () => {
  assert.equal(
    redactText('value synthetic-marker-0123456789-extended', Infinity, [
      'synthetic-marker-0123456789',
      'synthetic-marker-0123456789-extended',
    ]),
    'value redacted',
  );
});

test('a value that is not text yields an empty string', () => {
  assert.equal(redactUrl(undefined), '');
  assert.equal(redactUrl(null), '');
  assert.equal(redactText(undefined), '');
  assert.equal(redactText(null), '');
});

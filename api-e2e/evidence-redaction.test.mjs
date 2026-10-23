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
  const message =
    'The page failed after the sign-in redirect and the navigation error ' +
    '?code=SYNTHETIC-AUTH-CODE-0123456789';
  const redacted = redactText(message, 64);
  assert.equal(redacted.length, 64);
  assert.ok(!redacted.includes('SYNTHETIC'));
  assert.ok(!redacted.includes('SYN'));
});

test('a value that is not text yields an empty string', () => {
  assert.equal(redactUrl(undefined), '');
  assert.equal(redactUrl(null), '');
  assert.equal(redactText(undefined), '');
  assert.equal(redactText(null), '');
});

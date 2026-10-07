import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BATCH_DEFAULTS,
  buildMultipartBody,
  headerValue,
  parseMultipartResponse,
  resolveOptions,
  validateRequests,
} from './batch.ts';

const get = (id, extra = {}) => ({
  id,
  method: 'GET',
  path: `/admin/directory/v1/things/${encodeURIComponent(id)}`,
  ...extra,
});

test('buildMultipartBody writes each request as one application/http part', () => {
  const body = buildMultipartBody(
    [
      {
        contentId: 'cc-1',
        request: get('a', { query: { projection: 'full', maxResults: 5 } }),
      },
      {
        contentId: 'cc-2',
        request: {
          id: 'b',
          method: 'PATCH',
          path: '/admin/directory/v1/users/b',
          headers: { 'If-Match': 'etag-1' },
          body: { suspended: true },
        },
      },
    ],
    'batch_x',
  );
  assert.equal(
    body,
    '--batch_x\r\nContent-Type: application/http\r\nContent-ID: <cc-1>\r\n\r\n' +
      'GET /admin/directory/v1/things/a?projection=full&maxResults=5\r\n\r\n' +
      '--batch_x\r\nContent-Type: application/http\r\nContent-ID: <cc-2>\r\n\r\n' +
      'PATCH /admin/directory/v1/users/b\r\nIf-Match: etag-1\r\n' +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n{"suspended":true}\r\n' +
      '--batch_x--\r\n',
  );
});

test('parseMultipartResponse reads the content id, status, headers, and body of each part', () => {
  const text = [
    '--batch_reply',
    'Content-Type: application/http',
    'Content-ID: <response-cc-2>',
    '',
    'HTTP/1.1 429 Too Many Requests',
    'Content-Type: application/json; charset=UTF-8',
    'Retry-After: 7',
    '',
    '{"error":{"code":429,"errors":[{"reason":"rateLimitExceeded"}]}}',
    '',
    '--batch_reply',
    'Content-Type: application/http',
    'Content-ID: <response-cc-1>',
    '',
    'HTTP/1.1 204 No Content',
    '',
    '',
    '--batch_reply--',
    '',
  ].join('\r\n');
  assert.deepEqual(
    parseMultipartResponse('multipart/mixed; boundary=batch_reply', text),
    [
      {
        contentId: 'cc-2',
        status: 429,
        headers: {
          'content-type': 'application/json; charset=UTF-8',
          'retry-after': '7',
        },
        body: {
          error: { code: 429, errors: [{ reason: 'rateLimitExceeded' }] },
        },
      },
      { contentId: 'cc-1', status: 204, headers: {}, body: null },
    ],
  );
});

test('parseMultipartResponse accepts a quoted boundary and keeps a non-JSON body as text', () => {
  const text = [
    '--reply',
    'Content-Type: application/http',
    'Content-ID: <response-cc-7>',
    '',
    'HTTP/1.1 503 Service Unavailable',
    'Content-Type: text/html',
    '',
    '<html>busy</html>',
    '',
    '--reply--',
    '',
  ].join('\r\n');
  assert.deepEqual(
    parseMultipartResponse('multipart/mixed; boundary="reply"', text),
    [
      {
        contentId: 'cc-7',
        status: 503,
        headers: { 'content-type': 'text/html' },
        body: '<html>busy</html>',
      },
    ],
  );
});

test('parseMultipartResponse rejects a reply that is not multipart or lacks a Content-ID or status', () => {
  assert.throws(() => parseMultipartResponse('application/json', '{}'), {
    name: 'BatchServiceError',
    code: 'malformed-response',
  });
  const noId = [
    '--b',
    'Content-Type: application/http',
    '',
    'HTTP/1.1 200 OK',
    '',
    '{}',
    '--b--',
    '',
  ].join('\r\n');
  assert.throws(
    () => parseMultipartResponse('multipart/mixed; boundary=b', noId),
    {
      name: 'BatchServiceError',
      code: 'malformed-response',
    },
  );
  const noStatus = [
    '--b',
    'Content-Type: application/http',
    'Content-ID: <response-cc-1>',
    '',
    'garbage',
    '',
    '{}',
    '--b--',
    '',
  ].join('\r\n');
  assert.throws(
    () => parseMultipartResponse('multipart/mixed; boundary=b', noStatus),
    {
      name: 'BatchServiceError',
      code: 'malformed-response',
    },
  );
});

test('headerValue reads gaxios Headers and plain objects without regard to case', () => {
  assert.equal(
    headerValue(
      new Headers({ 'Content-Type': 'multipart/mixed' }),
      'content-type',
    ),
    'multipart/mixed',
  );
  assert.equal(headerValue({ 'Retry-After': '7' }, 'retry-after'), '7');
  assert.equal(headerValue(undefined, 'retry-after'), undefined);
});

test('validateRequests rejects duplicate ids and fields that would break the multipart body', () => {
  const bad = [
    [get('a'), get('a')],
    [get('')],
    [get('a', { method: 'HEAD' })],
    [get('a', { path: '/things/a\r\nGET /other' })],
    [get('a', { path: '/things/a?x=1' })],
    [get('a', { path: 'things/a' })],
    [get('a', { path: '//evil.example/a' })],
    [get('a', { body: { x: 1 } })],
    [get('a', { query: { n: Number.NaN } })],
    [get('a', { headers: { 'Content-ID': 'x' } })],
    [get('a', { headers: { 'X-Note': 'a\r\nb' } })],
    [get('a', { headers: { 'Bad Name': 'x' } })],
  ];
  for (const requests of bad)
    assert.throws(
      () => validateRequests(requests),
      { name: 'BatchServiceError', code: 'invalid-request' },
      JSON.stringify(requests),
    );
  validateRequests([
    get('odd>id\r\n'),
    get('b', {
      method: 'POST',
      body: { ok: true },
      headers: { 'If-Match': 'etag' },
      query: { n: 1, flag: true },
    }),
  ]);
});

test('resolveOptions applies the agreed defaults and rejects values out of range', () => {
  assert.deepEqual(BATCH_DEFAULTS, {
    initialDelayMs: 1_000,
    multiplier: 2,
    maxDelayMs: 60_000,
    maxQuotaRetries: 25,
    maxTransientRetries: 10,
    honorRetryAfter: true,
    batchSize: 250,
    maxInFlight: 1,
    maxPages: 10_000,
    retryUnsafeWrites: false,
  });
  assert.deepEqual(resolveOptions(), BATCH_DEFAULTS);
  assert.equal(resolveOptions({ batchSize: 100 }).batchSize, 100);
  for (const bad of [
    { batchSize: 251 },
    { batchSize: 0 },
    { batchSize: 1.5 },
    { maxInFlight: 0 },
    { maxPages: 0 },
    { maxQuotaRetries: -1 },
    { maxDelayMs: -1 },
    { multiplier: 0.5 },
  ])
    assert.throws(
      () => resolveOptions(bad),
      { name: 'BatchServiceError', code: 'invalid-option' },
      JSON.stringify(bad),
    );
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { GoogleBatchService } from './batch.ts';
import { fakeGoogle, perKey, testClock, thing } from './batch-fake.mjs';

const batchUrl = 'https://www.googleapis.com/batch/admin/directory_v1';
const ok = (key) => ({ status: 200, body: { name: key } });
const reason = (status, why, headers) => ({
  status,
  body: { error: { code: status, errors: [{ reason: why }] } },
  ...(headers ? { headers } : {}),
});

function setup() {
  const clock = testClock();
  return {
    clock,
    batch: new GoogleBatchService({
      now: clock.now,
      sleep: clock.sleep,
      random: clock.random,
    }),
  };
}

function call(google, requests, extra = {}) {
  return {
    batchUrl,
    requests,
    parse: (body) => body,
    getClient: google.getClient,
    signal: AbortSignal.timeout(5_000),
    ...extra,
  };
}

const things = (...ids) => ids.map((id) => thing(id));
const sends = (google, key) =>
  google
    .keys()
    .flat()
    .filter((sent) => sent === key).length;

test('every part resolves on its own and results aggregate by caller id', async () => {
  const google = fakeGoogle(
    perKey({
      a: [ok('a')],
      b: [reason(404, 'notFound')],
      c: [reason(403, 'forbidden')],
      d: [reason(400, 'invalid')],
    }),
  );
  const result = await setup().batch.execute(
    call(google, things('a', 'b', 'c', 'd')),
  );
  assert.deepEqual([...result.succeeded], [['a', [{ name: 'a' }]]]);
  assert.deepEqual(
    Object.fromEntries(
      [...result.failed].map(([id, f]) => [id, [f.kind, f.status, f.reason]]),
    ),
    {
      b: ['not-found', 404, 'notFound'],
      c: ['auth', 403, 'forbidden'],
      d: ['rejected', 400, 'invalid'],
    },
  );
  assert.deepEqual(result.failed.get('c').attempts, { quota: 0, transient: 0 });
  assert.equal(google.sent.length, 1);
  assert.equal(google.requests[0].url, batchUrl);
  assert.equal(google.requests[0].method, 'POST');
  assert.ok(
    google.sent[0].every((part) => /^cc-\d+$/.test(part.contentId)),
    'Caller ids never enter a Content-ID header.',
  );
});

test('replies match by Content-ID, and odd caller ids resolve under the original id', async () => {
  const odd = 'odd>id with space\r\n';
  const google = fakeGoogle((part) => ok(part.key));
  const result = await setup().batch.execute(
    call(google, things('a', 'b', odd)),
  );
  assert.deepEqual(Object.fromEntries(result.succeeded), {
    a: [{ name: 'a' }],
    b: [{ name: 'b' }],
    [odd]: [{ name: odd }],
  });
});

test('a quota wave re-batches only the throttled parts', async () => {
  const google = fakeGoogle(
    perKey({
      a: [ok('a')],
      b: [reason(429, 'rateLimitExceeded'), ok('b')],
      c: [
        reason(403, 'userRateLimitExceeded'),
        reason(429, 'rateLimitExceeded'),
        ok('c'),
      ],
    }),
  );
  const { batch, clock } = setup();
  const result = await batch.execute(call(google, things('a', 'b', 'c')));
  assert.deepEqual(google.keys(), [['a', 'b', 'c'], ['b', 'c'], ['c']]);
  assert.deepEqual(clock.waits, [500, 1_000]);
  assert.deepEqual([...result.succeeded.keys()].sort(), ['a', 'b', 'c']);
});

test('default limits allow 25 quota retries and 10 transient retries per part', async () => {
  const google = fakeGoogle(
    perKey({
      q: [reason(429, 'rateLimitExceeded')],
      t: [{ status: 503, body: null }],
    }),
  );
  const result = await setup().batch.execute(call(google, things('q', 't')));
  assert.equal(sends(google, 'q'), 26);
  assert.equal(sends(google, 't'), 11);
  assert.deepEqual(result.failed.get('q'), {
    kind: 'quota',
    status: 429,
    reason: 'rateLimitExceeded',
    attempts: { quota: 25, transient: 0 },
    body: { error: { code: 429, errors: [{ reason: 'rateLimitExceeded' }] } },
  });
  assert.equal(result.failed.get('t').kind, 'transient');
  assert.deepEqual(result.failed.get('t').attempts, {
    quota: 0,
    transient: 10,
  });
});

test('a configured quota limit overrides the default', async () => {
  const google = fakeGoogle(() => reason(429, 'rateLimitExceeded'));
  const result = await setup().batch.execute(
    call(google, things('q'), { options: { maxQuotaRetries: 2 } }),
  );
  assert.equal(google.sent.length, 3);
  assert.deepEqual(result.failed.get('q').attempts, { quota: 2, transient: 0 });
});

test('Retry-After replaces the computed delay and stays under the maximum', async () => {
  const replies = () =>
    perKey({
      a: [
        reason(429, 'rateLimitExceeded', { 'Retry-After': '7' }),
        reason(429, 'rateLimitExceeded', { 'Retry-After': '120' }),
        ok('a'),
      ],
    });
  const honored = setup();
  await honored.batch.execute(call(fakeGoogle(replies()), things('a')));
  assert.deepEqual(honored.clock.waits, [7_000, 60_000]);
  const ignored = setup();
  await ignored.batch.execute(
    call(fakeGoogle(replies()), things('a'), {
      options: { honorRetryAfter: false },
    }),
  );
  assert.deepEqual(ignored.clock.waits, [500, 1_000]);
});

test('a POST does not retry a server error unless the caller allows it', async () => {
  const replies = () =>
    perKey({
      p: [
        { status: 503, body: null },
        { status: 200, body: { created: true } },
      ],
      q: [
        reason(429, 'rateLimitExceeded'),
        { status: 200, body: { created: true } },
      ],
    });
  const post = (id) => thing(id, { method: 'POST', body: { name: id } });
  let google = fakeGoogle(replies());
  let result = await setup().batch.execute(
    call(google, [post('p'), post('q')]),
  );
  assert.equal(result.failed.get('p').kind, 'transient');
  assert.deepEqual(result.failed.get('p').attempts, { quota: 0, transient: 0 });
  assert.deepEqual(result.succeeded.get('q'), [{ created: true }]);
  assert.deepEqual(google.sent[0][0].body, { name: 'p' });
  google = fakeGoogle(replies());
  result = await setup().batch.execute(
    call(google, [post('p')], { options: { retryUnsafeWrites: true } }),
  );
  assert.deepEqual(result.succeeded.get('p'), [{ created: true }]);
});

test('requests split into batches of at most 250, or the configured size', async () => {
  const ids = Array.from({ length: 600 }, (_, index) => `d${index}`);
  const google = fakeGoogle((part) => ok(part.key));
  const result = await setup().batch.execute(call(google, things(...ids)));
  assert.deepEqual(
    google.sent.map((round) => round.length),
    [250, 250, 100],
  );
  assert.equal(result.succeeded.size, 600);
  const smaller = fakeGoogle((part) => ok(part.key));
  await setup().batch.execute(
    call(smaller, things(...ids.slice(0, 10)), { options: { batchSize: 4 } }),
  );
  assert.deepEqual(
    smaller.sent.map((round) => round.length),
    [4, 4, 2],
  );
});

test('maxInFlight sends that many batches at once', async () => {
  const google = fakeGoogle((part) => ok(part.key), { delay: true });
  const result = await setup().batch.execute(
    call(google, things('a', 'b', 'c', 'd', 'e'), {
      options: { batchSize: 1, maxInFlight: 3 },
    }),
  );
  assert.equal(google.state.maxActive, 3);
  assert.equal(result.succeeded.size, 5);
});

test('an unanswered part retries as transient and an unknown Content-ID is ignored', async () => {
  const google = fakeGoogle(
    perKey({
      a: [ok('a')],
      b: [null, ok('b')],
      c: [{ ...ok('c'), contentId: 'cc-999' }, ok('c')],
    }),
  );
  const events = [];
  const result = await setup().batch.execute(
    call(google, things('a', 'b', 'c'), {
      onResponse: (event) => void events.push(event),
    }),
  );
  assert.deepEqual(google.keys(), [
    ['a', 'b', 'c'],
    ['b', 'c'],
  ]);
  assert.deepEqual(result.succeeded.get('b'), [{ name: 'b' }]);
  assert.deepEqual(result.succeeded.get('c'), [{ name: 'c' }]);
  const missing = events.find(
    (event) => event.id === 'b' && event.outcome.kind === 'retry',
  );
  assert.equal(missing.outcome.failure.reason, 'missing-part');
});

test('an HTML part body still classifies by status and siblings resolve', async () => {
  const google = fakeGoogle(
    perKey({
      a: [ok('a')],
      b: [{ status: 503, raw: '<html>Service Unavailable</html>' }, ok('b')],
    }),
  );
  const result = await setup().batch.execute(call(google, things('a', 'b')));
  assert.deepEqual(google.keys(), [['a', 'b'], ['b']]);
  assert.equal(result.succeeded.size, 2);
});

test('a 200 page the parser rejects fails as invalid-response', async () => {
  const google = fakeGoogle((part) => ok(part.key));
  const result = await setup().batch.execute(
    call(google, things('a', 'b'), {
      parse: (body) => {
        if (body.name === 'b') throw new Error('bad shape');
        return body;
      },
    }),
  );
  assert.deepEqual(result.failed.get('b'), {
    kind: 'invalid-response',
    status: 200,
    reason: 'parse-failed',
    attempts: { quota: 0, transient: 0 },
    body: { name: 'b' },
  });
  assert.equal(result.succeeded.size, 1);
});

test('a list request follows nextPageToken and keeps every page in order', async () => {
  const pages = {
    '': { items: [1], nextPageToken: 'p2' },
    p2: { items: [2], nextPageToken: 'p3' },
    p3: { items: [3] },
  };
  const google = fakeGoogle((part) => ({
    status: 200,
    body: pages[part.query.pageToken ?? ''],
  }));
  const result = await setup().batch.execute(
    call(google, [thing('list', { query: { maxResults: 1 } })], {
      parse: (body) => body.items,
    }),
  );
  assert.deepEqual(result.succeeded.get('list'), [[1], [2], [3]]);
  assert.deepEqual(
    google.sent.map(([part]) => part.query),
    [
      { maxResults: '1' },
      { maxResults: '1', pageToken: 'p2' },
      { maxResults: '1', pageToken: 'p3' },
    ],
  );
});

test('list requests page independently and share batches', async () => {
  const series = {
    long: {
      '': { items: ['l1'], nextPageToken: 't2' },
      t2: { items: ['l2'], nextPageToken: 't3' },
      t3: { items: ['l3'] },
    },
    short: { '': { items: ['s1'] } },
  };
  const google = fakeGoogle((part) => ({
    status: 200,
    body: series[part.key][part.query.pageToken ?? ''],
  }));
  const result = await setup().batch.execute(
    call(google, things('long', 'short'), { parse: (body) => body.items }),
  );
  assert.deepEqual(google.keys(), [['long', 'short'], ['long'], ['long']]);
  assert.deepEqual(result.succeeded.get('long'), [['l1'], ['l2'], ['l3']]);
  assert.deepEqual(result.succeeded.get('short'), [['s1']]);
});

test('a failure on a later page fails the whole request', async () => {
  const google = fakeGoogle((part) =>
    part.query.pageToken === 'p2'
      ? reason(403, 'forbidden')
      : { status: 200, body: { items: [1], nextPageToken: 'p2' } },
  );
  const result = await setup().batch.execute(call(google, things('list')));
  assert.equal(result.succeeded.has('list'), false);
  assert.equal(result.failed.get('list').kind, 'auth');
});

test('each page starts with fresh retry counters', async () => {
  const seen = new Map();
  const google = fakeGoogle((part) => {
    const token = part.query.pageToken ?? '';
    const count = (seen.get(token) ?? 0) + 1;
    seen.set(token, count);
    if (count === 1) return reason(429, 'rateLimitExceeded');
    return { status: 200, body: token === '' ? { nextPageToken: 'p2' } : {} };
  });
  const result = await setup().batch.execute(
    call(google, things('list'), { options: { maxQuotaRetries: 1 } }),
  );
  assert.equal(result.succeeded.get('list').length, 2);
  assert.equal(google.sent.length, 4);
});

test('the page cap stops a token that never ends', async () => {
  const google = fakeGoogle(() => ({
    status: 200,
    body: { nextPageToken: 'again' },
  }));
  const result = await setup().batch.execute(
    call(google, things('list'), { options: { maxPages: 3 } }),
  );
  assert.equal(google.sent.length, 3);
  assert.deepEqual(
    [result.failed.get('list').kind, result.failed.get('list').reason],
    ['invalid-response', 'page-limit'],
  );
});

test('onResponse reports every part outcome, including retries', async () => {
  const events = [];
  const google = fakeGoogle(
    perKey({
      a: [ok('a')],
      b: [reason(429, 'rateLimitExceeded'), reason(404, 'notFound')],
    }),
  );
  await setup().batch.execute(
    call(google, things('a', 'b'), {
      onResponse: (event) => void events.push(event),
    }),
  );
  assert.deepEqual(
    events.map((event) => [
      event.id,
      event.outcome.kind,
      event.status,
      event.attempts,
    ]),
    [
      ['b', 'retry', 429, { quota: 1, transient: 0 }],
      ['a', 'success', 200, { quota: 0, transient: 0 }],
      ['b', 'failed', 404, { quota: 1, transient: 0 }],
    ],
  );
  assert.equal(events[0].outcome.retryInMs, 500);
  assert.deepEqual(events[1].outcome, {
    kind: 'success',
    page: { name: 'a' },
    pageIndex: 0,
    hasNextPage: false,
  });
  assert.equal(events[1].request.path, '/admin/directory/v1/things/a');
  assert.equal(events[2].outcome.failure.kind, 'not-found');
});

test('a list request fires one success event per page with the page token it sent', async () => {
  const events = [];
  const google = fakeGoogle((part) => ({
    status: 200,
    body: part.query.pageToken
      ? { items: [2] }
      : { items: [1], nextPageToken: 'p2' },
  }));
  await setup().batch.execute(
    call(google, things('list'), {
      onResponse: (event) => void events.push(event),
    }),
  );
  assert.deepEqual(
    events.map((event) => [
      event.outcome.pageIndex,
      event.outcome.hasNextPage,
      event.request.query?.pageToken,
    ]),
    [
      [0, true, undefined],
      [1, false, 'p2'],
    ],
  );
});

test('onBatch fires once per round and is awaited before the next round', async () => {
  const order = [];
  const rounds = [];
  const google = fakeGoogle(
    (part, round) =>
      round === 0 && part.key === 'b'
        ? reason(429, 'rateLimitExceeded')
        : ok(part.key),
    { outer: (round) => void order.push(`send-${round}`) },
  );
  await setup().batch.execute(
    call(google, things('a', 'b'), {
      onBatch: async (event) => {
        order.push('hook-start');
        rounds.push(event);
        await new Promise((resolve) => setImmediate(resolve));
        order.push('hook-end');
      },
    }),
  );
  assert.deepEqual(rounds, [
    { round: 1, sentCount: 2, outerStatus: 200, durationMs: 0, pending: 1 },
    { round: 2, sentCount: 1, outerStatus: 200, durationMs: 0, pending: 0 },
  ]);
  assert.deepEqual(order, [
    'send-0',
    'hook-start',
    'hook-end',
    'send-1',
    'hook-start',
    'hook-end',
  ]);
});

test('a hook that throws rejects execute', async () => {
  const google = fakeGoogle((part) => ok(part.key));
  await assert.rejects(
    setup().batch.execute(
      call(google, things('a'), {
        onResponse: () => {
          throw new Error('sink down');
        },
      }),
    ),
    /sink down/,
  );
});

test(
  'an abort lets the batch in flight finish and fails what is still pending',
  { timeout: 5_000 },
  async () => {
    const stopping = new AbortController();
    const google = fakeGoogle((part) => {
      stopping.abort();
      return part.key === 'a' ? ok('a') : reason(429, 'rateLimitExceeded');
    });
    const result = await setup().batch.execute(
      call(google, [thing('a'), thing('b')], { signal: stopping.signal }),
    );
    assert.deepEqual(result.succeeded.get('a'), [{ name: 'a' }]);
    assert.deepEqual(result.failed.get('b'), {
      kind: 'aborted',
      status: 0,
      reason: null,
      attempts: { quota: 1, transient: 0 },
      body: null,
    });
    assert.equal(google.sent.length, 1);
  },
);

test(
  'an abort during a wait stops without another send',
  { timeout: 5_000 },
  async () => {
    const stopping = new AbortController();
    const google = fakeGoogle(() => reason(429, 'rateLimitExceeded'));
    const clock = testClock();
    const batch = new GoogleBatchService({
      now: clock.now,
      random: clock.random,
      sleep: async () => {
        stopping.abort();
        await new Promise((resolve) => setImmediate(resolve));
      },
    });
    const result = await batch.execute(
      call(google, [thing('a')], { signal: stopping.signal }),
    );
    assert.equal(google.sent.length, 1);
    assert.equal(result.failed.get('a').kind, 'aborted');
  },
);

test(
  'the default wait ends when the signal aborts',
  { timeout: 5_000 },
  async () => {
    const stopping = new AbortController();
    const google = fakeGoogle(() =>
      reason(429, 'rateLimitExceeded', { 'Retry-After': '60' }),
    );
    const started = Date.now();
    setTimeout(() => stopping.abort(), 20);
    const result = await new GoogleBatchService().execute(
      call(google, [thing('a')], { signal: stopping.signal }),
    );
    assert.equal(result.failed.get('a').kind, 'aborted');
    assert.ok(Date.now() - started < 5_000);
  },
);
test('bad input rejects before a token is minted, and no requests means no mint', async () => {
  const google = fakeGoogle((part) => ok(part.key));
  const { batch } = setup();
  await assert.rejects(batch.execute(call(google, things('a', 'a'))), {
    name: 'BatchServiceError',
    code: 'invalid-request',
  });
  await assert.rejects(
    batch.execute(call(google, things('a'), { options: { batchSize: 251 } })),
    {
      name: 'BatchServiceError',
      code: 'invalid-option',
    },
  );
  const empty = await batch.execute(call(google, []));
  assert.deepEqual([empty.succeeded.size, empty.failed.size], [0, 0]);
  assert.equal(google.state.mints, 0);
});

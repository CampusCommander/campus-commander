import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { reloadAfterNetworkChange } from './navigation-fixture.mjs';

const okResponse = () => ({
  status: () => 200,
  url: () => 'https://fixture.invalid/',
});

/** A fake page that scripts each reload result and emits page events. */
const fakePage = (reload) => {
  const page = new EventEmitter();
  page.reloads = 0;
  page.reload = async (options) => {
    page.reloads++;
    return reload(page.reloads, options);
  };
  return page;
};

const failRequest = (page, errorText) =>
  page.emit('requestfailed', {
    url: () => 'https://fixture.invalid/main.js',
    failure: () => ({ errorText }),
  });

const respond = (page, status, path = '/api/customer') =>
  page.emit('response', {
    url: () => `https://fixture.invalid${path}`,
    status: () => status,
    request: () => ({ isNavigationRequest: () => false }),
  });

/** A ready function that reports the missing heading after 200 ms. */
const delayedReadyFailure = async () => {
  await new Promise((settle) => setTimeout(settle, 200));
  throw new Error('The "Sign in" heading did not appear within 5 s');
};

/** A ready function that reports the missing heading on its first call. */
const failFirstReady = () => {
  let calls = 0;
  return async () => {
    if (++calls === 1) await delayedReadyFailure();
  };
};

test('a network change retries only the interrupted page reload', async () => {
  let attempts = 0;
  const page = {
    async reload() {
      if (++attempts === 1)
        throw Error('page.reload: net::ERR_NETWORK_CHANGED');
      return {};
    },
  };
  assert.deepEqual(await reloadAfterNetworkChange(page, { retryDelayMs: 0 }), {
    attempts: 2,
    networkChanges: 1,
  });
  assert.equal(attempts, 2);
});

test('other navigation errors fail without retry', async () => {
  let attempts = 0;
  await assert.rejects(
    reloadAfterNetworkChange({
      async reload() {
        attempts++;
        throw Error('page.reload: net::ERR_CERT_AUTHORITY_INVALID');
      },
    }),
    /ERR_CERT_AUTHORITY_INVALID/,
  );
  assert.equal(attempts, 1);
});

test('persistent network changes stop after three navigation attempts', async () => {
  let attempts = 0;
  await assert.rejects(
    reloadAfterNetworkChange(
      {
        async reload() {
          attempts++;
          throw Error('page.reload: net::ERR_NETWORK_CHANGED');
        },
      },
      { retryDelayMs: 0 },
    ),
    /ERR_NETWORK_CHANGED/,
  );
  assert.equal(attempts, 3);
});

test('replays the resume reload after a script request fails with a network change', async () => {
  // Occurrence A: the reload resolved, a script request aborted, and the
  // readiness check on the heading failed.
  const page = fakePage(async (reloads) => {
    if (reloads === 1)
      setImmediate(() => failRequest(page, 'net::ERR_NETWORK_CHANGED'));
    return okResponse();
  });
  const result = await reloadAfterNetworkChange(page, {
    retryDelayMs: 0,
    ready: failFirstReady(),
  });
  assert.deepEqual(result, { attempts: 2, networkChanges: 1 });
  assert.equal(page.reloads, 2);
});

test('a network change ends the ready wait before the readiness timeout', async () => {
  const rejections = [];
  const capture = (reason) => rejections.push(reason);
  process.on('unhandledRejection', capture);
  try {
    const page = fakePage(async (reloads) => {
      if (reloads === 1)
        setImmediate(() => failRequest(page, 'net::ERR_NETWORK_CHANGED'));
      return okResponse();
    });
    const started = Date.now();
    const result = await reloadAfterNetworkChange(page, {
      retryDelayMs: 0,
      ready: failFirstReady(),
    });
    const elapsed = Date.now() - started;
    assert.deepEqual(result, { attempts: 2, networkChanges: 1 });
    assert.ok(elapsed < 150, `the ready wait ended after ${elapsed} ms`);
    await new Promise((settle) => setTimeout(settle, 250));
    assert.deepEqual(rejections, []);
  } finally {
    process.off('unhandledRejection', capture);
  }
});

test('request recoveries stop after three reload attempts', async () => {
  const page = fakePage(async () => {
    setImmediate(() => failRequest(page, 'net::ERR_NETWORK_CHANGED'));
    return okResponse();
  });
  await assert.rejects(
    reloadAfterNetworkChange(page, {
      retryDelayMs: 0,
      ready: delayedReadyFailure,
    }),
    /ERR_NETWORK_CHANGED/,
  );
  assert.equal(page.reloads, 3);
});

test('no reload attempt starts after the deadline', async () => {
  const page = fakePage(async () => {
    await new Promise((settle) => setTimeout(settle, 40));
    throw Error('page.reload: net::ERR_NETWORK_CHANGED');
  });
  await assert.rejects(
    reloadAfterNetworkChange(page, { retryDelayMs: 0, timeoutMs: 20 }),
    /ERR_NETWORK_CHANGED/,
  );
  assert.equal(page.reloads, 1);
});

test('the first reload does not start after an expired deadline', async () => {
  const page = fakePage(async () => okResponse());
  await assert.rejects(
    reloadAfterNetworkChange(page, { timeoutMs: 0 }),
    /expired before a reload started/,
  );
  assert.equal(page.reloads, 0);
});

test('an invalid timeout rejects without a reload', async () => {
  const page = fakePage(async () => okResponse());
  await assert.rejects(
    reloadAfterNetworkChange(page, { timeoutMs: Number.NaN }),
    /invalid timeoutMs/,
  );
  assert.equal(page.reloads, 0);
});

test('the retry delay does not outlast the deadline', async () => {
  const page = fakePage(async () => {
    throw Error('page.reload: net::ERR_NETWORK_CHANGED');
  });
  const started = Date.now();
  await assert.rejects(
    reloadAfterNetworkChange(page, { retryDelayMs: 10000, timeoutMs: 200 }),
    /ERR_NETWORK_CHANGED/,
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1000, `the retry delay lasted ${elapsed} ms`);
  assert.ok(page.reloads <= 2, `the helper reloaded ${page.reloads} times`);
});

test('a request failure with another error code does not start another reload', async () => {
  const page = fakePage(async (reloads) => {
    if (reloads === 1)
      setImmediate(() => failRequest(page, 'net::ERR_CERT_AUTHORITY_INVALID'));
    return okResponse();
  });
  await assert.rejects(
    reloadAfterNetworkChange(page, {
      retryDelayMs: 0,
      ready: delayedReadyFailure,
    }),
    /did not appear within 5 s/,
  );
  assert.equal(page.reloads, 1);
});

test('an aborted in-flight request does not fail a ready page', async () => {
  // The restart phase restarts the containers while the page stays open. The
  // reload cancels the in-flight requests, and the page still becomes ready.
  const page = fakePage(async (reloads) => {
    if (reloads === 1) failRequest(page, 'net::ERR_ABORTED');
    return okResponse();
  });
  let readyCalls = 0;
  assert.deepEqual(
    await reloadAfterNetworkChange(page, {
      retryDelayMs: 0,
      ready: async () => {
        readyCalls++;
      },
    }),
    { attempts: 1, networkChanges: 0 },
  );
  assert.equal(page.reloads, 1);
  assert.equal(readyCalls, 1);
});

test('an HTTP error status from the reload fails at once', async () => {
  const page = fakePage(async () => ({
    status: () => 503,
    url: () => 'https://fixture.invalid/',
  }));
  let readyCalls = 0;
  await assert.rejects(
    reloadAfterNetworkChange(page, {
      retryDelayMs: 0,
      ready: async () => {
        readyCalls++;
      },
    }),
    /HTTP 503/,
  );
  assert.equal(page.reloads, 1);
  assert.equal(readyCalls, 0);
});

test('an HTTP error status fails the attempt when a request also reports a network change', async () => {
  const page = fakePage(async (reloads) => {
    if (reloads === 1) failRequest(page, 'net::ERR_NETWORK_CHANGED');
    return reloads === 1
      ? { status: () => 503, url: () => 'https://fixture.invalid/' }
      : okResponse();
  });
  let readyCalls = 0;
  await assert.rejects(
    reloadAfterNetworkChange(page, {
      retryDelayMs: 0,
      ready: async () => {
        readyCalls++;
      },
    }),
    /HTTP 503/,
  );
  assert.equal(page.reloads, 1);
  assert.equal(readyCalls, 0);
});

test('an HTTP error status during the ready wait ends the attempt at once', async () => {
  // The attempt observes every response of the page, the ready wait included.
  // The ready check fails, the page answered HTTP 503 for a customer request,
  // and a script request failed with a network change. The server failure
  // stays visible, and the helper does not reload again.
  const page = fakePage(async () => okResponse());
  let readyCalls = 0;
  await assert.rejects(
    reloadAfterNetworkChange(page, {
      retryDelayMs: 0,
      ready: async () => {
        readyCalls++;
        respond(page, 503);
        failRequest(page, 'net::ERR_NETWORK_CHANGED');
        throw new Error('The "Your account" heading did not appear');
      },
    }),
    /HTTP 503/,
  );
  assert.equal(page.reloads, 1);
  assert.equal(readyCalls, 1);
});

test('a passing ready keeps the attempt after an HTTP error status', async () => {
  // The HTTP rule decides the retry only. A passing ready passes, with a
  // recorded HTTP error, as on origin/main.
  const page = fakePage(async () => okResponse());
  let readyCalls = 0;
  assert.deepEqual(
    await reloadAfterNetworkChange(page, {
      retryDelayMs: 0,
      ready: async () => {
        readyCalls++;
        respond(page, 503);
      },
    }),
    { attempts: 1, networkChanges: 0 },
  );
  assert.equal(page.reloads, 1);
  assert.equal(readyCalls, 1);
});

test('a ready failure without a network change fails at once', async () => {
  const page = fakePage(async () => okResponse());
  let readyCalls = 0;
  await assert.rejects(
    reloadAfterNetworkChange(page, {
      retryDelayMs: 0,
      ready: async () => {
        readyCalls++;
        throw new Error('The "Sign in" heading did not appear within 5 s');
      },
    }),
    /did not appear within 5 s/,
  );
  assert.equal(page.reloads, 1);
  assert.equal(readyCalls, 1);
});

test('without ready, a resolved reload is ready', async () => {
  const page = fakePage(async () => okResponse());
  assert.deepEqual(await reloadAfterNetworkChange(page, { retryDelayMs: 0 }), {
    attempts: 1,
    networkChanges: 0,
  });
  assert.equal(page.reloads, 1);
});

test('without ready, a request failure during the reload reloads again', async () => {
  const page = fakePage(async (reloads) => {
    if (reloads === 1) failRequest(page, 'net::ERR_NETWORK_CHANGED');
    return okResponse();
  });
  assert.deepEqual(await reloadAfterNetworkChange(page, { retryDelayMs: 0 }), {
    attempts: 2,
    networkChanges: 1,
  });
  assert.equal(page.reloads, 2);
});

test('networkChanges counts document and request recoveries', async () => {
  const page = fakePage(async (reloads) => {
    if (reloads === 1) throw Error('page.reload: net::ERR_NETWORK_CHANGED');
    if (reloads === 2)
      setImmediate(() => failRequest(page, 'net::ERR_NETWORK_CHANGED'));
    return okResponse();
  });
  const result = await reloadAfterNetworkChange(page, {
    retryDelayMs: 0,
    ready: failFirstReady(),
  });
  assert.deepEqual(result, { attempts: 3, networkChanges: 2 });
  assert.equal(page.reloads, 3);
});

test('the helper removes its listeners when it returns or throws', async () => {
  const reloaded = fakePage(async () => okResponse());
  assert.deepEqual(
    await reloadAfterNetworkChange(reloaded, { retryDelayMs: 0 }),
    {
      attempts: 1,
      networkChanges: 0,
    },
  );
  assert.equal(reloaded.listenerCount('requestfailed'), 0);
  const failed = fakePage(async () => {
    throw Error('page.reload: net::ERR_CERT_AUTHORITY_INVALID');
  });
  await assert.rejects(
    reloadAfterNetworkChange(failed, { retryDelayMs: 0 }),
    /ERR_CERT_AUTHORITY_INVALID/,
  );
  assert.equal(failed.listenerCount('requestfailed'), 0);
});

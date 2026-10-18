import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { reloadAfterNetworkChange } from './navigation-fixture.mjs';
import {
  qualificationBrowserStep,
  qualificationLinkSignIn,
  qualificationSignIn,
} from './qualification-sign-in.mjs';

const publicOrigin = 'https://qualification.invalid';

/** A fake page that emits page events and answers the document probe. */
const fakePage = () => {
  const page = new EventEmitter();
  page.visited = [];
  page.url = () => `${publicOrigin}/account`;
  page.goto = async (url) => {
    page.visited.push(url);
    return { status: () => 200, url: () => url };
  };
  page.evaluate = async () => ({
    readyState: 'complete',
    applicationChildren: 0,
    headings: 0,
    busyRegions: 0,
    alerts: 0,
  });
  return page;
};

const failRequest = (page, path, errorText) =>
  page.emit('requestfailed', {
    url: () => `${publicOrigin}${path}`,
    failure: () => ({ errorText }),
  });

const respond = (page, path, status) =>
  page.emit('response', {
    url: () => `${publicOrigin}${path}`,
    status: () => status,
    request: () => ({ isNavigationRequest: () => true }),
  });

const createEvidenceDirectory = async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), 'qualification-sign-in-test-'),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
};

/**
 * A fake page that drives the sign-in link flow. `navigate` answers the
 * commit wait of an activation, `heading` answers the account heading wait
 * of an attempt, and `signedIn` answers the account view check of a retry.
 */
const fakeLinkPage = ({ navigate, heading, signedIn = false }) => {
  const page = new EventEmitter();
  page.clicks = 0;
  page.visited = [];
  page.url = () => `${publicOrigin}/`;
  page.goto = async (url) => {
    page.visited.push(url);
    return { status: () => 200, url: () => url };
  };
  page.evaluate = async () => ({
    readyState: 'complete',
    applicationChildren: 0,
    headings: 0,
    busyRegions: 0,
    alerts: 0,
  });
  // The commit wait of an activation starts before the activation, so the
  // fake answers it after the next click.
  const clickWaiters = [];
  page.getByRole = (role) => {
    if (role === 'link')
      return {
        click: async () => {
          page.clicks++;
          for (const waiter of clickWaiters.splice(0)) waiter();
        },
      };
    return {
      waitFor: ({ timeout }) =>
        timeout === 3000
          ? signedIn
            ? Promise.resolve()
            : Promise.reject(new Error('the account heading is absent'))
          : heading(page, timeout),
    };
  };
  page.waitForNavigation = ({ timeout }) => {
    if (timeout === 1000)
      return Promise.reject(new Error('no pending navigation'));
    return new Promise((done) => clickWaiters.push(done)).then(() =>
      navigate(page, timeout),
    );
  };
  return page;
};

test('replays the phase-3 sign-in after a script request fails with a network change', async (t) => {
  const directory = await createEvidenceDirectory(t);
  const page = fakePage();
  let runs = 0;
  // The action stands in for the sign-in navigation and its heading assertion.
  const result = await qualificationBrowserStep(
    page,
    publicOrigin,
    directory,
    'phase3-auth-sign-in',
    async () => {
      runs++;
      await page.goto(`${publicOrigin}/api/auth/login`);
      if (runs === 1) {
        failRequest(page, '/main.js', 'net::ERR_NETWORK_CHANGED');
        throw new Error('The "Your account" heading did not appear');
      }
    },
  );
  assert.equal(runs, 2);
  assert.equal(page.visited.length, 2);
  assert.deepEqual(result, {
    attempts: 2,
    recoveries: [{ attempt: 1, routes: ['script'] }],
  });
  assert.deepEqual(await readdir(directory), []);
});

test('a failed assertion without a network change fails at once', async (t) => {
  const directory = await createEvidenceDirectory(t);
  const page = fakePage();
  let runs = 0;
  await assert.rejects(
    qualificationBrowserStep(
      page,
      publicOrigin,
      directory,
      'no-network-change',
      async () => {
        runs++;
        throw new Error('The "Your account" heading did not appear');
      },
    ),
    /did not appear/,
  );
  assert.equal(runs, 1);
  assert.deepEqual(await readdir(directory), [
    'no-network-change-failure.json',
  ]);
});

test('a request failure with another error code fails at once', async (t) => {
  const directory = await createEvidenceDirectory(t);
  const page = fakePage();
  let runs = 0;
  await assert.rejects(
    qualificationBrowserStep(
      page,
      publicOrigin,
      directory,
      'certificate-error',
      async () => {
        runs++;
        failRequest(page, '/main.js', 'net::ERR_CERT_AUTHORITY_INVALID');
        throw new Error('The "Your account" heading did not appear');
      },
    ),
    /did not appear/,
  );
  assert.equal(runs, 1);
});

test('an HTTP error status without a network change fails at once', async (t) => {
  const directory = await createEvidenceDirectory(t);
  const page = fakePage();
  let runs = 0;
  await assert.rejects(
    qualificationBrowserStep(
      page,
      publicOrigin,
      directory,
      'http-error-status',
      async () => {
        runs++;
        respond(page, '/', 503);
        throw new Error('The "Your account" heading did not appear');
      },
    ),
    /did not appear/,
  );
  assert.equal(runs, 1);
  const failure = JSON.parse(
    await readFile(join(directory, 'http-error-status-failure.json'), 'utf8'),
  );
  assert.deepEqual(failure.events, [
    { kind: 'response', local: true, route: 'application-root', status: 503 },
  ]);
});

test('an HTTP error status fails the step when a request also reports a network change', async (t) => {
  const directory = await createEvidenceDirectory(t);
  const page = fakePage();
  let runs = 0;
  await assert.rejects(
    qualificationBrowserStep(
      page,
      publicOrigin,
      directory,
      'mixed-http-network-change',
      async () => {
        runs++;
        if (runs > 1) return;
        respond(page, '/', 503);
        failRequest(page, '/main.js', 'net::ERR_NETWORK_CHANGED');
        throw new Error('The "Your account" heading did not appear');
      },
    ),
    /HTTP 503/,
  );
  assert.equal(runs, 1);
  const failure = JSON.parse(
    await readFile(
      join(directory, 'mixed-http-network-change-failure.json'),
      'utf8',
    ),
  );
  assert.deepEqual(failure.events, [
    { kind: 'response', local: true, route: 'application-root', status: 503 },
    {
      kind: 'request-failed',
      local: true,
      route: 'script',
      error: 'ERR_NETWORK_CHANGED',
    },
  ]);
});

test('a passing action keeps the step after an HTTP error status', async (t) => {
  // The HTTP rule decides the retry only. A passing action passes, with a
  // recorded HTTP error, as on origin/main.
  const directory = await createEvidenceDirectory(t);
  const page = fakePage();
  const result = await qualificationBrowserStep(
    page,
    publicOrigin,
    directory,
    'passing-action-http-error',
    async () => {
      respond(page, '/', 503);
      await page.goto(`${publicOrigin}/api/auth/login`);
    },
  );
  assert.deepEqual(result, { attempts: 1, recoveries: [] });
  assert.deepEqual(await readdir(directory), []);
});

test('the step runs the action at most three times', async (t) => {
  const directory = await createEvidenceDirectory(t);
  const page = fakePage();
  let runs = 0;
  await assert.rejects(
    qualificationBrowserStep(
      page,
      publicOrigin,
      directory,
      'persistent-network-change',
      async () => {
        runs++;
        failRequest(page, '/main.js', 'net::ERR_NETWORK_CHANGED');
        throw new Error('The "Your account" heading did not appear');
      },
    ),
    /did not appear/,
  );
  assert.equal(runs, 3);
});

test('a recovered step records the attempt count and the failed request routes', async (t) => {
  const directory = await createEvidenceDirectory(t);
  const page = fakePage();
  const logged = t.mock.method(console, 'log');
  let runs = 0;
  const result = await qualificationBrowserStep(
    page,
    publicOrigin,
    directory,
    'recovered-sign-in',
    async () => {
      runs++;
      if (runs === 1) {
        failRequest(page, '/main.js', 'net::ERR_NETWORK_CHANGED');
        throw new Error('The "Your account" heading did not appear');
      }
    },
  );
  assert.equal(runs, 2);
  assert.deepEqual(result, {
    attempts: 2,
    recoveries: [{ attempt: 1, routes: ['script'] }],
  });
  assert.equal(logged.mock.callCount(), 1);
  assert.match(
    logged.mock.calls[0].arguments.join(' '),
    /recovered from a network change after 2 attempts, failed request routes: script/,
  );
});

test('a final failure records the events of every attempt', async (t) => {
  const directory = await createEvidenceDirectory(t);
  const page = fakePage();
  let runs = 0;
  await assert.rejects(
    qualificationBrowserStep(
      page,
      publicOrigin,
      directory,
      'attempt-events',
      async () => {
        runs++;
        respond(page, '/', 200);
        failRequest(page, '/main.js', 'net::ERR_NETWORK_CHANGED');
        throw new Error('The "Your account" heading did not appear');
      },
    ),
    /did not appear/,
  );
  assert.equal(runs, 3);
  const failure = JSON.parse(
    await readFile(join(directory, 'attempt-events-failure.json'), 'utf8'),
  );
  assert.deepEqual(
    failure.events.filter((event) => event.kind === 'network-change-retry'),
    [
      { kind: 'network-change-retry', attempt: 1, routes: ['script'] },
      { kind: 'network-change-retry', attempt: 2, routes: ['script'] },
    ],
  );
  assert.equal(
    failure.events.filter((event) => event.kind === 'request-failed').length,
    3,
  );
  assert.equal(
    failure.events.filter((event) => event.kind === 'response').length,
    3,
  );
});

test('the step does not retry an action that opts out of the step retry', async (t) => {
  const directory = await createEvidenceDirectory(t);
  const page = fakePage();
  let runs = 0;
  await assert.rejects(
    qualificationBrowserStep(
      page,
      publicOrigin,
      directory,
      'opted-out',
      async () => {
        runs++;
        failRequest(page, '/main.js', 'net::ERR_NETWORK_CHANGED');
        throw new Error('The "Your account" heading did not appear');
      },
      { retryOnNetworkChange: false },
    ),
    /did not appear/,
  );
  assert.equal(runs, 1);
});

test('an opted-out step reports the routes of a reload that recovered inside the action', async (t) => {
  // The all-Docker resume step recovers through reloadAfterNetworkChange and
  // opts out of the step retry. The step then reports the inner recovery.
  const directory = await createEvidenceDirectory(t);
  const page = fakePage();
  const logged = t.mock.method(console, 'log');
  let reloads = 0;
  page.reload = async () => {
    reloads++;
    if (reloads === 1)
      failRequest(page, '/main.js', 'net::ERR_NETWORK_CHANGED');
    return { status: () => 200, url: () => `${publicOrigin}/` };
  };
  let navigationRecovery;
  const result = await qualificationBrowserStep(
    page,
    publicOrigin,
    directory,
    'resume',
    async () => {
      navigationRecovery = await reloadAfterNetworkChange(page, {
        retryDelayMs: 0,
        ready: () => Promise.resolve(),
      });
    },
    { retryOnNetworkChange: false },
  );
  assert.deepEqual(navigationRecovery, { attempts: 2, networkChanges: 1 });
  assert.deepEqual(result, {
    attempts: 1,
    recoveries: [{ attempt: 1, routes: ['script'] }],
  });
  assert.equal(logged.mock.callCount(), 1);
  assert.match(
    logged.mock.calls[0].arguments.join(' '),
    /recovered from a network change after 1 attempts, failed request routes: script/,
  );
  assert.deepEqual(await readdir(directory), []);
});

test('the step removes its listeners when it returns or throws', async (t) => {
  const directory = await createEvidenceDirectory(t);
  const returned = fakePage();
  await qualificationBrowserStep(
    returned,
    publicOrigin,
    directory,
    'listeners-return',
    async () => {
      await returned.goto(`${publicOrigin}/api/auth/login`);
    },
  );
  for (const event of ['requestfailed', 'response', 'pageerror'])
    assert.equal(
      returned.listenerCount(event),
      0,
      `the ${event} listener stayed after the return`,
    );
  const thrown = fakePage();
  await assert.rejects(
    qualificationBrowserStep(
      thrown,
      publicOrigin,
      directory,
      'listeners-throw',
      async () => {
        throw new Error('The "Your account" heading did not appear');
      },
    ),
    /did not appear/,
  );
  for (const event of ['requestfailed', 'response', 'pageerror'])
    assert.equal(
      thrown.listenerCount(event),
      0,
      `the ${event} listener stayed after the throw`,
    );
});

test('recovers a step that the error page of a failed navigation interrupts', async (t) => {
  // The log of main run 39020551892 holds this error verbatim. The first
  // navigation failed with a network change. The error page of that navigation
  // then interrupted the navigation of the retry.
  const directory = await createEvidenceDirectory(t);
  const page = fakePage();
  const interruption = new Error(
    'page.goto: Navigation to "https://127.0.0.1:44995/api/auth/login" is interrupted by another navigation to "chrome-error://chromewebdata/"',
  );
  let runs = 0;
  const outcome = await qualificationBrowserStep(
    page,
    publicOrigin,
    directory,
    'error-page-interruption',
    async () => {
      runs++;
      if (runs === 1) {
        failRequest(page, '/api/auth/login', 'net::ERR_NETWORK_CHANGED');
        throw new Error(
          'page.goto: net::ERR_NETWORK_CHANGED at https://127.0.0.1:44995/api/auth/login',
        );
      }
      if (runs === 2) throw interruption;
      await page.goto(`${publicOrigin}/api/auth/login`);
    },
  ).then(
    (value) => ({ status: 'resolved', value }),
    (error) => ({ status: 'rejected', error }),
  );
  assert.equal(
    outcome.status,
    'resolved',
    `the step rejected with ${outcome.error?.message}`,
  );
  assert.equal(runs, 3);
  assert.deepEqual(outcome.value, {
    attempts: 3,
    recoveries: [
      { attempt: 1, routes: ['authentication'] },
      { attempt: 2, routes: [] },
    ],
  });
  assert.deepEqual(await readdir(directory), []);
});

test('an interrupted step waits for the pending navigation before the retry', async (t) => {
  const directory = await createEvidenceDirectory(t);
  const page = fakePage();
  const order = [];
  const settleOptions = [];
  page.waitForNavigation = async (options) => {
    settleOptions.push(options);
    order.push('settle');
    return { status: () => 200, url: () => `${publicOrigin}/api/auth/login` };
  };
  let runs = 0;
  const outcome = await qualificationBrowserStep(
    page,
    publicOrigin,
    directory,
    'error-page-settle',
    async () => {
      runs++;
      order.push(`action ${runs}`);
      if (runs === 1) {
        failRequest(page, '/api/auth/login', 'net::ERR_NETWORK_CHANGED');
        throw new Error(
          'page.goto: net::ERR_NETWORK_CHANGED at https://127.0.0.1:44995/api/auth/login',
        );
      }
      if (runs === 2)
        throw new Error(
          'page.goto: Navigation to "https://127.0.0.1:44995/api/auth/login" is interrupted by another navigation to "chrome-error://chromewebdata/"',
        );
    },
  ).then(
    (value) => ({ status: 'resolved', value }),
    (error) => ({ status: 'rejected', error }),
  );
  assert.equal(
    outcome.status,
    'resolved',
    `the step rejected with ${outcome.error?.message}`,
  );
  assert.deepEqual(order, [
    'action 1',
    'settle',
    'action 2',
    'settle',
    'action 3',
  ]);
  assert.deepEqual(settleOptions, [
    { waitUntil: 'commit', timeout: 1000 },
    { waitUntil: 'commit', timeout: 1000 },
  ]);
  assert.deepEqual(outcome.value, {
    attempts: 3,
    recoveries: [
      { attempt: 1, routes: ['authentication'] },
      { attempt: 2, routes: [] },
    ],
  });
});

test('an interruption that keeps failing after the retry limit fails the step', async (t) => {
  const directory = await createEvidenceDirectory(t);
  const page = fakePage();
  let runs = 0;
  await assert.rejects(
    qualificationBrowserStep(
      page,
      publicOrigin,
      directory,
      'error-page-limit',
      async () => {
        runs++;
        throw new Error(
          'page.goto: Navigation to "https://127.0.0.1:44995/api/auth/login" is interrupted by another navigation to "chrome-error://chromewebdata/"',
        );
      },
    ),
    /interrupted by another navigation/,
  );
  assert.equal(runs, 3);
  const failure = JSON.parse(
    await readFile(join(directory, 'error-page-limit-failure.json'), 'utf8'),
  );
  assert.deepEqual(
    failure.events
      .filter((event) => event.kind === 'error-page-interruption')
      .map((event) => event.attempt),
    [1, 2],
    'the record holds the interrupted attempts',
  );
});

test('recovers a sign-in link that the error page of a failed navigation interrupts', async (t) => {
  // A click of the sign-in link holds the failure classes of the navigation
  // itself. The run-145 race probe records the interruption verbatim on the
  // current wrapper: the error page of a failed navigation commits, and the
  // next navigation of the flow races that commit. The step recovers the
  // attempt in the same way as the entry flow recovers it.
  const directory = await createEvidenceDirectory(t);
  const page = fakeLinkPage({
    navigate: async () => ({
      status: () => 200,
      url: () => `${publicOrigin}/`,
    }),
    heading: async (page) => {
      if (page.clicks === 1) {
        failRequest(page, '/api/auth/login', 'net::ERR_NETWORK_CHANGED');
        throw new Error(
          'locator.waitFor: Navigation to "https://127.0.0.1:44995/api/auth/login" is interrupted by another navigation to "chrome-error://chromewebdata/"',
        );
      }
      return true;
    },
  });
  const outcome = await qualificationLinkSignIn(
    page,
    publicOrigin,
    directory,
    'link-interruption',
  ).then(
    (value) => ({ status: 'resolved', value }),
    (error) => ({ status: 'rejected', error }),
  );
  assert.equal(
    outcome.status,
    'resolved',
    `the flow rejected with ${outcome.error?.message}`,
  );
  assert.equal(page.clicks, 2);
  assert.deepEqual(page.visited, [publicOrigin]);
  assert.deepEqual(outcome.value, {
    attempts: 2,
    recoveries: [{ attempt: 1, routes: ['authentication'] }],
  });
  assert.deepEqual(await readdir(directory), []);
});

test('a sign-in link whose navigation does not commit runs the flow again', async (t) => {
  // The click returns while the sign-in navigation stays pending, as the call
  // log of the failed main run shows. The step bounds the commit wait, runs
  // the flow again, and the second navigation commits.
  const directory = await createEvidenceDirectory(t);
  const page = fakeLinkPage({
    navigate: async (page) =>
      page.clicks === 1
        ? Promise.reject(
            new Error('page.waitForNavigation: Timeout 10000ms exceeded.'),
          )
        : { status: () => 200, url: () => `${publicOrigin}/` },
    heading: async () => true,
  });
  const outcome = await qualificationLinkSignIn(
    page,
    publicOrigin,
    directory,
    'link-pending',
  ).then(
    (value) => ({ status: 'resolved', value }),
    (error) => ({ status: 'rejected', error }),
  );
  assert.equal(
    outcome.status,
    'resolved',
    `the flow rejected with ${outcome.error?.message}`,
  );
  assert.equal(page.clicks, 2);
  assert.deepEqual(page.visited, [publicOrigin]);
  assert.deepEqual(outcome.value, {
    attempts: 2,
    recoveries: [{ attempt: 1, routes: [] }],
  });
  assert.deepEqual(await readdir(directory), []);
});

test('a sign-in link that keeps failing after the retry limit fails the step', async (t) => {
  const directory = await createEvidenceDirectory(t);
  const page = fakeLinkPage({
    navigate: async () =>
      Promise.reject(
        new Error('page.waitForNavigation: Timeout 10000ms exceeded.'),
      ),
    heading: async () => {
      throw new Error('locator.waitFor: Timeout 15000ms exceeded.');
    },
  });
  const outcome = await qualificationLinkSignIn(
    page,
    publicOrigin,
    directory,
    'link-pending-limit',
  ).then(
    (value) => ({ status: 'resolved', value }),
    (error) => ({ status: 'rejected', error }),
  );
  assert.equal(outcome.status, 'rejected', 'the step resolved');
  assert.match(
    outcome.error.message,
    /the sign-in navigation did not commit/,
    'the failure reports the sign-in navigation that did not commit',
  );
  assert.equal(page.clicks, 3);
  const failure = JSON.parse(
    await readFile(
      join(directory, 'link-pending-limit-sign-in-failure.json'),
      'utf8',
    ),
  );
  assert.deepEqual(
    failure.events
      .filter((event) => event.kind === 'pending-sign-in-navigation')
      .map((event) => event.attempt),
    [1, 2],
    'the record holds the attempts without a commit',
  );
});

test('a failed sign-in link without a network change fails at once', async (t) => {
  const directory = await createEvidenceDirectory(t);
  const page = fakeLinkPage({
    navigate: async () => ({
      status: () => 200,
      url: () => `${publicOrigin}/`,
    }),
    heading: async () => {
      throw new Error('the "Your account" heading did not appear');
    },
  });
  const outcome = await qualificationLinkSignIn(
    page,
    publicOrigin,
    directory,
    'link-assertion',
  ).then(
    (value) => ({ status: 'resolved', value }),
    (error) => ({ status: 'rejected', error }),
  );
  assert.equal(outcome.status, 'rejected', 'the step resolved');
  assert.match(outcome.error.message, /did not appear/);
  assert.equal(page.clicks, 1);
});

test('retries a sign-in navigation that does not commit', async (t) => {
  // The sign-in navigation of a direct visit can stay pending after an
  // installation network change. The step bounds the navigation and runs the
  // action again.
  const directory = await createEvidenceDirectory(t);
  const page = fakePage();
  let runs = 0;
  page.goto = async () => {
    runs++;
    throw new Error('page.goto: Timeout 10000ms exceeded.');
  };
  const outcome = await qualificationSignIn(
    page,
    publicOrigin,
    directory,
    'goto-pending',
  ).then(
    (value) => ({ status: 'resolved', value }),
    (error) => ({ status: 'rejected', error }),
  );
  assert.equal(outcome.status, 'rejected', 'the step resolved');
  assert.match(
    outcome.error.message,
    /the sign-in navigation did not commit/,
    'the failure reports the sign-in navigation that did not commit',
  );
  assert.equal(runs, 3);
  const failure = JSON.parse(
    await readFile(
      join(directory, 'goto-pending-sign-in-failure.json'),
      'utf8',
    ),
  );
  assert.deepEqual(
    failure.events
      .filter((event) => event.kind === 'pending-sign-in-navigation')
      .map((event) => event.attempt),
    [1, 2],
    'the record holds the attempts without a commit',
  );
});

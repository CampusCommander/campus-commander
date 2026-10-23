import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { EvidenceSecurity } from './evidence-security.mjs';
import { reloadAfterNetworkChange } from './navigation-fixture.mjs';
import {
  qualificationBrowserStep,
  qualificationHeldSignIn,
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
 * `accountReadinessMs` is the time that the account view needs after the
 * retry origin commits. `click` selects the activation result, as a status
 * name or as a function of the page: `ok` clicks the link, `timeout` reports
 * a click that never finds the link, `inert` clicks a link that starts no
 * navigation, and `other` clicks a link that starts another navigation.
 * `goto` answers the origin navigation of a retry.
 */
const fakeLinkPage = ({
  navigate,
  heading,
  signedIn = false,
  accountReadinessMs = 0,
  click = 'ok',
  goto = async (url) => ({ status: () => 200, url: () => url }),
}) => {
  const page = new EventEmitter();
  page.clicks = 0;
  page.authenticationRequests = 0;
  page.visited = [];
  page.gotoCalls = [];
  page.locatorWaits = [];
  page.url = () => `${publicOrigin}/`;
  page.goto = async (url, options = {}) => {
    page.visited.push(url);
    page.gotoCalls.push({ url, options });
    // The retry origin can answer with the account view. The first account
    // heading wait after that navigation belongs to the view check.
    if (url === publicOrigin) page.retryView = true;
    return goto(url, options);
  };
  page.evaluate = async () => ({
    readyState: 'complete',
    applicationChildren: 0,
    headings: 0,
    busyRegions: 0,
    alerts: 0,
  });
  const navigationWaiters = [];
  const requestWaiters = [];
  // End the navigation waits of an attempt the way their own timeouts do.
  // An activation that never clicks the link leaves both waits pending.
  const endNavigationWaits = (error) => {
    for (const waiter of requestWaiters.splice(0)) waiter.reject(error);
    for (const waiter of navigationWaiters.splice(0)) waiter.reject(error);
  };
  page.endNavigationWaits = endNavigationWaits;
  // Model the end of the finite navigation watches, as a preparation that
  // outlasts their timeout does. A watch without a timeout stays pending.
  page.expireNavigationWaits = () => {
    for (const waiters of [requestWaiters, navigationWaiters]) {
      for (const waiter of waiters.splice(0)) {
        if (waiter.timeout === 0) waiters.push(waiter);
        else
          waiter.reject(
            new Error('page.waitForNavigation: Timeout 10000ms exceeded.'),
          );
      }
    }
  };
  // Answer the request watch with the request that the activation starts. A
  // predicate that does not match this request ends at the wait's own
  // timeout, so another navigation cannot stand in for the sign-in
  // navigation.
  const answerRequest = (request) => {
    for (const waiter of requestWaiters.splice(0)) {
      if (waiter.predicate?.(request)) waiter.resolve(request);
      else
        waiter.reject(
          new Error('page.waitForRequest: Timeout 10000ms exceeded.'),
        );
    }
  };
  const clickLink = async () => {
    const mode = typeof click === 'function' ? click(page) : click;
    page.clicks++;
    if (mode === 'timeout') {
      // The link is absent. The click waits for the element and ends at its
      // own timeout, and no navigation starts.
      const error = new Error('locator.click: Timeout 10000ms exceeded.');
      endNavigationWaits(error);
      throw error;
    }
    if (mode === 'inert') {
      // The link is not actionable. The click returns and no navigation
      // starts.
      endNavigationWaits(
        new Error('page.waitForNavigation: Timeout 10000ms exceeded.'),
      );
      return;
    }
    if (mode === 'other') {
      // The click starts a navigation that is not the sign-in route.
      answerRequest({
        isNavigationRequest: () => true,
        url: () => `${publicOrigin}/asset.js`,
      });
      endNavigationWaits(
        new Error('page.waitForNavigation: Timeout 10000ms exceeded.'),
      );
      return;
    }
    page.authenticationRequests++;
    answerRequest({
      isNavigationRequest: () => true,
      url: () => `${publicOrigin}/api/auth/login`,
    });
    for (const waiter of navigationWaiters.splice(0)) waiter.resolve();
  };
  page.getByRole = (role) => {
    if (role === 'link')
      return {
        click: clickLink,
        waitFor: ({ timeout } = {}) => {
          page.locatorWaits.push({ role, timeout });
          return Promise.reject(new Error('the sign-in link is absent'));
        },
      };
    return {
      waitFor: ({ timeout }) => {
        page.locatorWaits.push({ role, timeout });
        if (page.retryView) {
          page.retryView = false;
          return signedIn && timeout >= accountReadinessMs
            ? Promise.resolve()
            : Promise.reject(new Error('the account heading is absent'));
        }
        return heading(page, timeout);
      },
    };
  };
  // The request watch holds the evidence that a sign-in navigation started.
  page.waitForRequest = (predicate, options = {}) =>
    new Promise((resolve, reject) =>
      requestWaiters.push({
        resolve,
        reject,
        predicate,
        timeout: options.timeout,
      }),
    );
  page.waitForNavigation = ({ timeout } = {}) => {
    if (timeout === 1000)
      return Promise.reject(new Error('no pending navigation'));
    return new Promise((resolve, reject) =>
      navigationWaiters.push({ resolve, reject, timeout }),
    ).then(() => navigate(page, timeout));
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

test('a committed origin document whose asset exceeds the commit budget passes in one attempt', async (t) => {
  // The retry loads the origin document. The document commits, and one asset
  // needs longer than the sign-in bound. The bound covers the commit, so the
  // retry proceeds without another sign-in.
  const directory = await createEvidenceDirectory(t);
  const page = fakeLinkPage({
    navigate: async (page) =>
      page.clicks === 1
        ? Promise.reject(
            new Error('page.waitForNavigation: Timeout 10000ms exceeded.'),
          )
        : { status: () => 200, url: () => `${publicOrigin}/` },
    heading: async () => true,
    goto: async (url, options) => {
      if (options.waitUntil !== 'commit')
        throw new Error('page.goto: Timeout 10000ms exceeded.');
      return { status: () => 200, url: () => url };
    },
  });
  const outcome = await qualificationLinkSignIn(
    page,
    publicOrigin,
    directory,
    'origin-slow-asset',
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
  assert.deepEqual(page.gotoCalls, [
    { url: publicOrigin, options: { waitUntil: 'commit', timeout: 10000 } },
  ]);
  assert.deepEqual(outcome.value, {
    attempts: 2,
    recoveries: [{ attempt: 1, routes: [] }],
  });
});

test('a committed sign-in document whose asset exceeds the commit budget passes in one attempt', async (t) => {
  // The sign-in navigation commits at once. One script asset needs longer
  // than the sign-in bound. The bound covers the document commit, so the
  // account readiness assertion holds the committed document without another
  // authentication.
  const directory = await createEvidenceDirectory(t);
  const page = fakePage();
  page.gotoCalls = [];
  page.authNavigations = 0;
  page.goto = async (url, options = {}) => {
    page.visited.push(url);
    page.gotoCalls.push({ url, options });
    page.authNavigations++;
    if (options.waitUntil !== 'commit')
      throw new Error('page.goto: Timeout 10000ms exceeded.');
    return { status: () => 200, url: () => url };
  };
  // The account readiness assertion runs against a locator. The stub holds
  // the Playwright matcher protocol, so the assertion passes on the
  // committed document.
  page.getByRole = () => ({
    _apiName: 'Locator',
    _expect: async () => ({ matches: true }),
    toString: () => 'getByRole("heading", { name: "Your account" })',
  });
  const outcome = await qualificationSignIn(
    page,
    publicOrigin,
    directory,
    'direct-slow-asset',
  ).then(
    (value) => ({ status: 'resolved', value }),
    (error) => ({ status: 'rejected', error }),
  );
  assert.equal(
    outcome.status,
    'resolved',
    `the step rejected with ${outcome.error?.message}`,
  );
  assert.deepEqual(outcome.value, { attempts: 1, recoveries: [] });
  assert.equal(page.authNavigations, 1, 'the step restarted authentication');
  assert.deepEqual(page.gotoCalls, [
    {
      url: `${publicOrigin}/api/auth/login`,
      options: { waitUntil: 'commit', timeout: 10000 },
    },
  ]);
});

test('the direct sign-in bounds the document commit', async (t) => {
  // The sign-in navigation of a direct visit ends at the bound of its
  // document commit. The wait carries the commit bound of the step.
  const directory = await createEvidenceDirectory(t);
  const page = fakePage();
  page.gotoCalls = [];
  page.goto = async (url, options = {}) => {
    page.visited.push(url);
    page.gotoCalls.push({ url, options });
    throw new Error('page.goto: Timeout 10000ms exceeded.');
  };
  const outcome = await qualificationSignIn(
    page,
    publicOrigin,
    directory,
    'direct-commit-bound',
  ).then(
    (value) => ({ status: 'resolved', value }),
    (error) => ({ status: 'rejected', error }),
  );
  assert.equal(outcome.status, 'rejected', 'the step resolved');
  assert.deepEqual(page.gotoCalls, [
    {
      url: `${publicOrigin}/api/auth/login`,
      options: { waitUntil: 'commit', timeout: 10000 },
    },
    {
      url: `${publicOrigin}/api/auth/login`,
      options: { waitUntil: 'commit', timeout: 10000 },
    },
    {
      url: `${publicOrigin}/api/auth/login`,
      options: { waitUntil: 'commit', timeout: 10000 },
    },
  ]);
});

test('an activation error before the click fails the step at once', async (t) => {
  // The screen-reader flow reports its own failure before the activation. No
  // sign-in navigation starts, so the step keeps that failure and runs the
  // flow once.
  const directory = await createEvidenceDirectory(t);
  const page = fakeLinkPage({
    navigate: async () => ({
      status: () => 200,
      url: () => `${publicOrigin}/`,
    }),
    heading: async () => true,
  });
  const outcome = await qualificationLinkSignIn(
    page,
    publicOrigin,
    directory,
    'activation-error',
    {
      activate: async () => {
        page.endNavigationWaits(
          new Error('page.waitForNavigation: Timeout 10000ms exceeded.'),
        );
        throw new Error('the screen reader did not announce the sign-in link');
      },
    },
  ).then(
    (value) => ({ status: 'resolved', value }),
    (error) => ({ status: 'rejected', error }),
  );
  assert.equal(outcome.status, 'rejected', 'the step resolved');
  assert.match(outcome.error.message, /did not announce the sign-in link/);
  assert.equal(page.clicks, 0, 'the step ran the activation again');
  assert.deepEqual(page.visited, [], 'the step loaded the origin page again');
});

test('a sign-in link that is absent fails the step at once', async (t) => {
  // The link is not in the document. The click waits for the element and ends
  // at its own timeout, and no sign-in navigation starts.
  const directory = await createEvidenceDirectory(t);
  const page = fakeLinkPage({
    navigate: async () => ({
      status: () => 200,
      url: () => `${publicOrigin}/`,
    }),
    heading: async () => true,
    click: 'timeout',
  });
  const outcome = await qualificationLinkSignIn(
    page,
    publicOrigin,
    directory,
    'link-absent',
  ).then(
    (value) => ({ status: 'resolved', value }),
    (error) => ({ status: 'rejected', error }),
  );
  assert.equal(outcome.status, 'rejected', 'the step resolved');
  assert.match(
    outcome.error.message,
    /locator\.click: Timeout 10000ms exceeded/,
  );
  assert.equal(page.clicks, 1, 'the step ran the activation again');
  assert.deepEqual(page.visited, [], 'the step loaded the origin page again');
});

test('a sign-in link that starts no navigation fails the step at once', async (t) => {
  // The link is not actionable. The activation returns, the commit does not
  // arrive, and no sign-in navigation request starts.
  const directory = await createEvidenceDirectory(t);
  const page = fakeLinkPage({
    navigate: async () => ({
      status: () => 200,
      url: () => `${publicOrigin}/`,
    }),
    heading: async () => true,
    click: 'inert',
  });
  const outcome = await qualificationLinkSignIn(
    page,
    publicOrigin,
    directory,
    'link-inert',
  ).then(
    (value) => ({ status: 'resolved', value }),
    (error) => ({ status: 'rejected', error }),
  );
  assert.equal(outcome.status, 'rejected', 'the step resolved');
  assert.match(outcome.error.message, /the sign-in navigation did not start/);
  assert.equal(page.clicks, 1, 'the step ran the activation again');
  assert.deepEqual(page.visited, [], 'the step loaded the origin page again');
});

test('a sign-in link whose activation preparation outlasts the navigation bound passes once', async (t) => {
  // The screen-reader activation prepares accessibility controls before it
  // presses Enter, and that preparation can outlast the navigation bound. A
  // finite watch would expire during preparation and misread the completed
  // sign-in as a navigation that never started.
  const directory = await createEvidenceDirectory(t);
  const page = fakeLinkPage({
    navigate: async () => ({
      status: () => 200,
      url: () => `${publicOrigin}/`,
    }),
    heading: async () => true,
  });
  const outcome = await qualificationLinkSignIn(
    page,
    publicOrigin,
    directory,
    'link-delayed-activation',
    {
      activate: async (control) => {
        // The finite watches of the previous flow end here, before the click.
        page.expireNavigationWaits();
        await control.click();
      },
    },
  ).then(
    (value) => ({ status: 'resolved', value }),
    (error) => ({ status: 'rejected', error }),
  );
  assert.equal(
    outcome.status,
    'resolved',
    `the flow rejected with ${outcome.error?.message}`,
  );
  assert.equal(page.clicks, 1, 'the flow activated the link again');
  assert.equal(
    page.authenticationRequests,
    1,
    'the flow started another authentication request',
  );
  assert.deepEqual(page.visited, [], 'the flow loaded the origin page again');
  assert.deepEqual(outcome.value, { attempts: 1, recoveries: [] });
});

test('a committed retry account document becomes ready after the readiness budget', async (t) => {
  // The first sign-in navigation stays pending, so the flow runs again. The
  // retry origin answers with the account view, whose heading becomes
  // visible only after the slow asset loads. The flow must keep the account
  // readiness budget instead of clicking an absent sign-in link.
  const directory = await createEvidenceDirectory(t);
  const page = fakeLinkPage({
    navigate: async (page) =>
      page.clicks === 1
        ? Promise.reject(
            new Error('page.waitForNavigation: Timeout 10000ms exceeded.'),
          )
        : { status: () => 200, url: () => `${publicOrigin}/` },
    heading: async () => true,
    signedIn: true,
    accountReadinessMs: 11000,
    click: (page) => (page.clicks === 0 ? 'ok' : 'timeout'),
  });
  const outcome = await qualificationLinkSignIn(
    page,
    publicOrigin,
    directory,
    'retry-account-readiness',
  ).then(
    (value) => ({ status: 'resolved', value }),
    (error) => ({ status: 'rejected', error }),
  );
  assert.equal(
    outcome.status,
    'resolved',
    `the flow rejected with ${outcome.error?.message}`,
  );
  assert.equal(page.clicks, 1, 'the flow activated the link again');
  assert.equal(
    page.authenticationRequests,
    1,
    'the flow started another authentication request',
  );
  assert.deepEqual(
    page.visited,
    [publicOrigin],
    'the flow loaded the origin page more than once',
  );
  assert.deepEqual(outcome.value, {
    attempts: 2,
    recoveries: [{ attempt: 1, routes: [] }],
  });
});

test('a click that starts another navigation fails the step at once', async (t) => {
  // The click starts a navigation that is not the sign-in route. The request
  // watch holds the evidence that the sign-in navigation started, so this
  // attempt is not a pending sign-in navigation.
  const directory = await createEvidenceDirectory(t);
  const page = fakeLinkPage({
    navigate: async () => ({
      status: () => 200,
      url: () => `${publicOrigin}/`,
    }),
    heading: async () => true,
    click: 'other',
  });
  const outcome = await qualificationLinkSignIn(
    page,
    publicOrigin,
    directory,
    'link-other-navigation',
  ).then(
    (value) => ({ status: 'resolved', value }),
    (error) => ({ status: 'rejected', error }),
  );
  assert.equal(outcome.status, 'rejected', 'the step resolved');
  assert.match(outcome.error.message, /the sign-in navigation did not start/);
  assert.equal(page.clicks, 1, 'the step ran the activation again');
  assert.deepEqual(page.visited, [], 'the step loaded the origin page again');
});

test('retries the sign-in link after a network change aborts its navigation', async (t) => {
  // The F4 full run of 2026-10-22 failed this way: the commit watch of the
  // sign-in navigation rejected with
  // page.waitForNavigation: net::ERR_NETWORK_CHANGED. The page reported no
  // failed request for the document, so the request evidence of the step
  // stayed empty.
  const directory = await createEvidenceDirectory(t);
  const page = fakeLinkPage({
    navigate: async (page) =>
      page.clicks === 1
        ? Promise.reject(
            new Error(
              'page.waitForNavigation: net::ERR_NETWORK_CHANGED at https://127.0.0.1:44995/api/auth/login',
            ),
          )
        : { status: () => 200, url: () => `${publicOrigin}/` },
    heading: async () => true,
  });
  const outcome = await qualificationLinkSignIn(
    page,
    publicOrigin,
    directory,
    'link-network-change',
  ).then(
    (value) => ({ status: 'resolved', value }),
    (error) => ({ status: 'rejected', error }),
  );
  assert.equal(
    outcome.status,
    'resolved',
    `the flow rejected with ${outcome.error?.message}`,
  );
  assert.equal(page.clicks, 2, 'the flow did not run the sign-in again');
  assert.deepEqual(
    page.visited,
    [publicOrigin],
    'the retry did not load the origin page',
  );
  assert.deepEqual(outcome.value, {
    attempts: 2,
    recoveries: [{ attempt: 1, routes: [] }],
  });
  assert.deepEqual(await readdir(directory), []);
});

test('persistent sign-in navigation network changes stop after three attempts', async (t) => {
  const directory = await createEvidenceDirectory(t);
  const page = fakeLinkPage({
    navigate: async () =>
      Promise.reject(
        new Error(
          'page.waitForNavigation: net::ERR_NETWORK_CHANGED at https://127.0.0.1:44995/api/auth/login',
        ),
      ),
    heading: async () => true,
  });
  const outcome = await qualificationLinkSignIn(
    page,
    publicOrigin,
    directory,
    'link-network-change-limit',
  ).then(
    (value) => ({ status: 'resolved', value }),
    (error) => ({ status: 'rejected', error }),
  );
  assert.equal(outcome.status, 'rejected', 'the step resolved');
  assert.match(outcome.error.message, /ERR_NETWORK_CHANGED/);
  assert.equal(page.clicks, 3, `the step ran the flow ${page.clicks} times`);
  const failure = JSON.parse(
    await readFile(
      join(directory, 'link-network-change-limit-sign-in-failure.json'),
      'utf8',
    ),
  );
  assert.deepEqual(
    failure.events
      .filter((event) => event.kind === 'network-change-retry')
      .map((event) => event.attempt),
    [1, 2],
    'the record holds the attempts that a network change ended',
  );
});

test('a sign-in navigation error that is not a network change fails at once', async (t) => {
  const directory = await createEvidenceDirectory(t);
  const page = fakeLinkPage({
    navigate: async () =>
      Promise.reject(
        new Error(
          'page.waitForNavigation: net::ERR_CERT_AUTHORITY_INVALID at https://127.0.0.1:44995/api/auth/login',
        ),
      ),
    heading: async () => true,
  });
  const outcome = await qualificationLinkSignIn(
    page,
    publicOrigin,
    directory,
    'link-navigation-failure',
  ).then(
    (value) => ({ status: 'resolved', value }),
    (error) => ({ status: 'rejected', error }),
  );
  assert.equal(outcome.status, 'rejected', 'the step resolved');
  assert.match(outcome.error.message, /ERR_CERT_AUTHORITY_INVALID/);
  assert.equal(page.clicks, 1, 'the step ran the flow again');
  assert.deepEqual(page.visited, [], 'the step loaded the origin page again');
});

test('retries a direct sign-in navigation that a network change aborts', async (t) => {
  const directory = await createEvidenceDirectory(t);
  const page = fakePage();
  let navigations = 0;
  page.goto = async (url) => {
    page.visited.push(url);
    navigations++;
    if (navigations === 1)
      throw new Error(`page.goto: net::ERR_NETWORK_CHANGED at ${url}`);
    return { status: () => 200, url: () => url };
  };
  // The account readiness assertion runs against a locator. The stub holds
  // the Playwright matcher protocol, so the assertion passes on the
  // committed document.
  page.getByRole = () => ({
    _apiName: 'Locator',
    _expect: async () => ({ matches: true }),
    toString: () => 'getByRole("heading", { name: "Your account" })',
  });
  const outcome = await qualificationSignIn(
    page,
    publicOrigin,
    directory,
    'direct-network-change',
  ).then(
    (value) => ({ status: 'resolved', value }),
    (error) => ({ status: 'rejected', error }),
  );
  assert.equal(
    outcome.status,
    'resolved',
    `the step rejected with ${outcome.error?.message}`,
  );
  assert.equal(navigations, 2, 'the step did not run the sign-in again');
  assert.deepEqual(outcome.value, {
    attempts: 2,
    recoveries: [{ attempt: 1, routes: [] }],
  });
  assert.deepEqual(page.visited, [
    `${publicOrigin}/api/auth/login`,
    `${publicOrigin}/api/auth/login`,
  ]);
});

/**
 * A fake page that drives the held-response sign-in flow. `commit` answers
 * the navigation outcome of a click: `ok` commits, `network-change` reports a
 * navigation that a network change aborts, and `stall` reports a commit that
 * does not arrive. `heading` answers the account view after the commit.
 * `responseStatus` adds a response after the release, for the
 * genuine-failure control.
 */
const fakeHeldPage = ({
  commit = () => 'ok',
  heading = 'ok',
  responseStatus = null,
} = {}) => {
  const page = new EventEmitter();
  page.clicks = 0;
  page.observations = 0;
  page.visited = [];
  page.gotoCalls = [];
  page.url = () => `${publicOrigin}/`;
  page.goto = async (url, options = {}) => {
    page.visited.push(url);
    page.gotoCalls.push({ url, options });
    // The retry origin answers with the sign-in view.
    if (url === publicOrigin) page.viewCheck = true;
    return { status: () => 200, url: () => url };
  };
  page.evaluate = async () => ({
    readyState: 'complete',
    applicationChildren: 0,
    headings: 0,
    busyRegions: 0,
    alerts: 0,
  });
  const requestWaiters = [];
  const navigationWaiters = [];
  const heldRoutes = new Set();
  let routeHandler = null;
  let routePattern = null;
  page.routeFailures = [];
  page.unrouteSawInFlight = false;
  page.route = async (pattern, handler) => {
    routePattern = pattern;
    routeHandler = handler;
  };
  page.unroute = async (pattern) => {
    if (pattern !== routePattern) return;
    // Playwright removes the interceptor without waiting for in-flight
    // handlers. Its server continues a paused route as a fallback and marks
    // the route handled, so a later continue of the same route fails.
    if (heldRoutes.size > 0) page.unrouteSawInFlight = true;
    for (const route of heldRoutes) route.handled = true;
    routeHandler = null;
  };
  // Answer the request watch with the request that the activation starts. A
  // predicate that does not match this request ends at the wait's own
  // timeout.
  const answerRequest = (request) => {
    for (const waiter of requestWaiters.splice(0)) {
      if (waiter.predicate?.(request)) waiter.resolve(request);
      else
        waiter.reject(
          new Error('page.waitForRequest: Timeout 10000ms exceeded.'),
        );
    }
  };
  // Continue the held navigation. The commit arrives, or the wait reports
  // the commit that does not arrive.
  const continueNavigation = async () => {
    if (responseStatus)
      page.emit('response', {
        url: () => `${publicOrigin}/api/auth/callback`,
        status: () => responseStatus,
        request: () => ({ isNavigationRequest: () => true }),
      });
    const outcome = commit(page.clicks);
    if (outcome === 'ok')
      for (const waiter of navigationWaiters.splice(0)) waiter.resolve();
    else
      for (const waiter of navigationWaiters.splice(0))
        waiter.reject(
          new Error(
            outcome === 'network-change'
              ? 'page.waitForNavigation: net::ERR_NETWORK_CHANGED at https://127.0.0.1:44995/api/auth/login'
              : 'page.waitForNavigation: Timeout 10000ms exceeded.',
          ),
        );
  };
  const click = async () => {
    page.clicks++;
    // The activation leaves the origin view check behind.
    page.viewCheck = false;
    answerRequest({
      isNavigationRequest: () => true,
      url: () => `${publicOrigin}/api/auth/login`,
    });
    if (!routeHandler) throw new Error('the held sign-in route is absent');
    const continued = Promise.withResolvers();
    const route = {
      handled: false,
      continue: async () => {
        if (route.handled)
          throw new Error('route.continue: Route is already handled!');
        await continueNavigation();
        continued.resolve();
      },
    };
    heldRoutes.add(route);
    // Playwright reports a route handler rejection through the unhandled
    // rejection path. The fake records the rejection for the control.
    routeHandler(route)
      .catch((error) => page.routeFailures.push(error))
      .finally(() => heldRoutes.delete(route));
    await continued.promise;
  };
  page.getByRole = (role) => ({
    click,
    waitFor: () => {
      // The retry origin shows the sign-in view, not the account view.
      if (role === 'link')
        return page.viewCheck
          ? Promise.resolve()
          : Promise.reject(new Error('the sign-in link is absent'));
      if (page.viewCheck)
        return Promise.reject(new Error('the account heading is absent'));
      return heading === 'ok'
        ? Promise.resolve()
        : Promise.reject(new Error('the account heading is absent'));
    },
  });
  page.waitForRequest = (predicate, options = {}) =>
    new Promise((resolve, reject) =>
      requestWaiters.push({
        resolve,
        reject,
        predicate,
        timeout: options.timeout,
      }),
    );
  page.waitForNavigation = ({ timeout } = {}) => {
    // The step uses the short wait to settle a pending navigation.
    if (timeout === 1000)
      return Promise.reject(new Error('no pending navigation'));
    return new Promise((resolve, reject) =>
      navigationWaiters.push({ resolve, reject, timeout }),
    );
  };
  return page;
};

test('recovers a held sign-in whose navigation does not commit after the release', async (t) => {
  // The reproduction stalls the navigation commit after the release, as the
  // main run 39207328567 attempt 1 log records for this site. The retry
  // loads the origin page, observes the progress again, and commits.
  const directory = await createEvidenceDirectory(t);
  const page = fakeHeldPage({
    commit: (click) => (click === 1 ? 'stall' : 'ok'),
  });
  const outcome = await qualificationHeldSignIn(
    page,
    publicOrigin,
    directory,
    'held-stall',
    {
      prepare: async () => undefined,
      observe: async () => {
        page.observations++;
      },
    },
  ).then(
    (value) => ({ status: 'resolved', value }),
    (error) => ({ status: 'rejected', error }),
  );
  assert.equal(
    outcome.status,
    'resolved',
    `the flow rejected with ${outcome.error?.message}`,
  );
  assert.equal(page.clicks, 2, 'the flow did not retry the sign-in');
  assert.equal(page.observations, 2, 'the flow skipped a progress check');
  assert.deepEqual(
    page.visited,
    [publicOrigin],
    'the retry did not load the origin page',
  );
  assert.deepEqual(outcome.value, {
    attempts: 2,
    recoveries: [{ attempt: 1, routes: [] }],
  });
  assert.deepEqual(await readdir(directory), []);
});

test('a failed progress check rejects without a rejected held route', async (t) => {
  // The progress check fails while the login response is held. The step must
  // keep that assertion, release the held route, and remove the route only
  // after the route settles. Playwright continues an in-flight route when
  // page.unroute removes its handler, so a continue that races the removal
  // reports a handled route.
  const directory = await createEvidenceDirectory(t);
  const page = fakeHeldPage();
  const outcome = await qualificationHeldSignIn(
    page,
    publicOrigin,
    directory,
    'held-progress-failure',
    {
      prepare: async () => undefined,
      observe: async () => {
        page.observations++;
        throw new Error('the progress text stayed absent');
      },
    },
  ).then(
    (value) => ({ status: 'resolved', value }),
    (error) => ({ status: 'rejected', error }),
  );
  assert.equal(outcome.status, 'rejected', 'the flow resolved');
  assert.match(outcome.error.message, /the progress text stayed absent/);
  assert.equal(page.clicks, 1, 'the flow retried a failed progress check');
  assert.equal(page.observations, 1, 'the flow repeated the progress check');
  assert.equal(
    page.unrouteSawInFlight,
    false,
    'the flow removed the route before the held route settled',
  );
  assert.deepEqual(
    page.routeFailures,
    [],
    'the failed progress check left a rejected route handler',
  );
});

test('a held sign-in that answers an HTTP error fails at once', async (t) => {
  // The control keeps a genuine sign-in failure visible. The callback
  // answers HTTP 500 after the release, so the recovery must not run the
  // flow again.
  const directory = await createEvidenceDirectory(t);
  const page = fakeHeldPage({ heading: 'absent', responseStatus: 500 });
  const outcome = await qualificationHeldSignIn(
    page,
    publicOrigin,
    directory,
    'held-http-error',
    {
      prepare: async () => undefined,
      observe: async () => {
        page.observations++;
      },
    },
  ).then(
    (value) => ({ status: 'resolved', value }),
    (error) => ({ status: 'rejected', error }),
  );
  assert.equal(outcome.status, 'rejected', 'the flow resolved');
  assert.match(outcome.error.message, /HTTP 500/);
  assert.equal(page.clicks, 1, 'the flow retried a genuine failure');
  assert.equal(page.observations, 1, 'the flow ran the progress check again');
});

test('recovers a held sign-in whose navigation a network change aborts', async (t) => {
  // The held flow reports the commit watch error through the same step. A
  // network change after the release must run the flow again.
  const directory = await createEvidenceDirectory(t);
  const page = fakeHeldPage({
    commit: (click) => (click === 1 ? 'network-change' : 'ok'),
  });
  const outcome = await qualificationHeldSignIn(
    page,
    publicOrigin,
    directory,
    'held-network-change',
    {
      prepare: async () => undefined,
      observe: async () => {
        page.observations++;
      },
    },
  ).then(
    (value) => ({ status: 'resolved', value }),
    (error) => ({ status: 'rejected', error }),
  );
  assert.equal(
    outcome.status,
    'resolved',
    `the flow rejected with ${outcome.error?.message}`,
  );
  assert.equal(page.clicks, 2, 'the flow did not retry the sign-in');
  assert.equal(page.observations, 2, 'the flow skipped a progress check');
  assert.deepEqual(
    page.visited,
    [publicOrigin],
    'the retry did not load the origin page',
  );
  assert.deepEqual(outcome.value, {
    attempts: 2,
    recoveries: [{ attempt: 1, routes: [] }],
  });
  assert.deepEqual(await readdir(directory), []);
});

test('a failed step records the page URL, the console errors, and the failed requests', async (t) => {
  const directory = await createEvidenceDirectory(t);
  const page = fakePage();
  await assert.rejects(
    qualificationBrowserStep(
      page,
      publicOrigin,
      directory,
      'diagnostics',
      async () => {
        page.emit('console', {
          type: () => 'error',
          text: () => 'Failed to load resource: net::ERR_CONNECTION_CLOSED',
        });
        // A console message that is not an error stays out of the record.
        page.emit('console', { type: () => 'log', text: () => 'ignored' });
        page.emit('requestfailed', {
          url: () => `${publicOrigin}/api/platform-users?page=2`,
          method: () => 'GET',
          failure: () => ({ errorText: 'net::ERR_CONNECTION_CLOSED' }),
        });
        throw new Error('The customer settings field did not appear');
      },
    ),
    /did not appear/,
  );
  const failure = JSON.parse(
    await readFile(join(directory, 'diagnostics-failure.json'), 'utf8'),
  );
  assert.equal(failure.url, `${publicOrigin}/account`);
  assert.deepEqual(failure.documentState, {
    readyState: 'complete',
    applicationChildren: 0,
    headings: 0,
    busyRegions: 0,
    alerts: 0,
  });
  assert.deepEqual(failure.consoleErrors, [
    'Failed to load resource: net::ERR_CONNECTION_CLOSED',
  ]);
  assert.deepEqual(failure.failedRequests, [
    {
      route: 'other',
      path: '/api/platform-users',
      method: 'GET',
      error: 'ERR_CONNECTION_CLOSED',
    },
  ]);
});

test('a failed step writes no registered authentication value', async (t) => {
  const directory = await createEvidenceDirectory(t);
  const page = fakePage();
  const authorizationCode = 'synthetic-authorization-code-0123456789';
  const state = 'synthetic-state-value-0123456789';
  const callback =
    `${publicOrigin}/api/auth/callback?code=${authorizationCode}` +
    `&state=${state}#access_token=${authorizationCode}`;
  page.url = () => callback;
  const security = new EvidenceSecurity();
  security.register('synthetic-authorization-code', authorizationCode);
  security.register('synthetic-state', state);

  await assert.rejects(
    qualificationBrowserStep(
      page,
      publicOrigin,
      directory,
      'redaction',
      async () => {
        page.emit('console', {
          type: () => 'error',
          text: () =>
            `Failed to load resource: ${callback} Authorization: Bearer ${authorizationCode}`,
        });
        throw new Error('locator.click: Timeout 30000ms exceeded.');
      },
    ),
    /Timeout 30000ms exceeded/,
  );

  const record = await readFile(
    join(directory, 'redaction-failure.json'),
    'utf8',
  );
  security.assertSafe(record, 'failure record');
  const failure = JSON.parse(record);
  assert.equal(
    failure.url,
    `${publicOrigin}/api/auth/callback?code=redacted&state=redacted#redacted`,
  );
  assert.deepEqual(failure.consoleErrors, [
    `Failed to load resource: ${publicOrigin}/api/auth/callback?code=redacted&state=redacted#redacted Authorization: Bearer redacted`,
  ]);
});

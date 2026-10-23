import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import {
  navigateToSignInPage,
  openPlatformUsers,
  openSignInPage,
  reloadCustomerSettings,
  reloadDiagnosticsPage,
  reloadSignInView,
} from './browser-recovery.mjs';

const publicOrigin = 'https://qualification.invalid';
const principalId = '00000000-0000-4000-8000-000000000001';

const okResponse = (path = '/customer-settings') => ({
  status: () => 200,
  url: () => `${publicOrigin}${path}`,
});

const createEvidenceDirectory = async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'browser-recovery-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
};

const failRequest = (page, path, errorText) =>
  page.emit('requestfailed', {
    url: () => `${publicOrigin}${path}`,
    failure: () => ({ errorText }),
  });

/** A fake customer settings page. `waitFor` scripts the ready check. */
const fakeSettingsPage = (reload, waitFor) => {
  const page = new EventEmitter();
  page.reloads = 0;
  page.reloadOptions = [];
  page.readyOptions = [];
  page.reload = async (options) => {
    page.reloads++;
    page.reloadOptions.push(options);
    return reload(page.reloads, options);
  };
  page.getByLabel = () => ({
    waitFor: async (options) => {
      page.readyOptions.push(options);
      return waitFor(page.reloads, options);
    },
  });
  return page;
};

/** A fake page that a reload helper drives. `waitFor` scripts the ready check. */
const fakeReloadPage = (reload, waitFor) => {
  const page = new EventEmitter();
  page.reloads = 0;
  page.reloadOptions = [];
  page.readyOptions = [];
  page.headingQueries = [];
  page.reload = async (options) => {
    page.reloads++;
    page.reloadOptions.push(options);
    return reload(page.reloads, options);
  };
  page.getByRole = (role, options) => {
    page.headingQueries.push({ role, ...options });
    return {
      waitFor: async (readyOptions) => {
        page.readyOptions.push(readyOptions);
        return waitFor(page.reloads, readyOptions);
      },
    };
  };
  return page;
};

/** A fake sign-in page. `goto` and `waitFor` script it. */
const fakeSignInPage = ({ goto, waitFor = async () => undefined }) => {
  const page = new EventEmitter();
  page.navigations = [];
  page.navigationOptions = [];
  page.readyOptions = [];
  page.url = () => `${publicOrigin}/login`;
  page.goto = async (url, options) => {
    page.navigations.push(url);
    page.navigationOptions.push(options);
    return goto(page.navigations.length, options);
  };
  page.evaluate = async () => ({
    readyState: 'complete',
    applicationChildren: 0,
    headings: 0,
    busyRegions: 0,
    alerts: 0,
  });
  page.getByRole = () => ({
    waitFor: async (options) => {
      page.readyOptions.push(options);
      return waitFor(page.navigations.length, options);
    },
  });
  return page;
};

/** A fake platform users page. `goto`, `waitFor`, and `click` script it. */
const fakePlatformUsersPage = ({
  goto,
  click,
  waitFor = async () => undefined,
}) => {
  const page = new EventEmitter();
  page.navigations = [];
  page.navigationOptions = [];
  page.readyOptions = [];
  page.clickOptions = [];
  page.clicks = 0;
  page.url = () => `${publicOrigin}/platform-users`;
  page.goto = async (url, options) => {
    page.navigations.push(url);
    page.navigationOptions.push(options);
    return goto(page.navigations.length, options);
  };
  page.evaluate = async () => ({
    readyState: 'complete',
    applicationChildren: 0,
    headings: 0,
    busyRegions: 0,
    alerts: 0,
  });
  page.locator = () => ({
    getByRole: () => ({
      waitFor: async (options) => {
        page.readyOptions.push(options);
        return waitFor(options);
      },
      click: async (options) => {
        page.clicks++;
        page.clickOptions.push(options);
        return click(page.clicks);
      },
    }),
  });
  return page;
};

test('a network change during the settings ready wait reloads the page again', async () => {
  const page = fakeSettingsPage(
    async (reloads) => {
      if (reloads === 1)
        setImmediate(() =>
          failRequest(page, '/main.js', 'net::ERR_NETWORK_CHANGED'),
        );
      return okResponse();
    },
    async (reloads) => {
      if (reloads !== 1) return;
      await new Promise((settle) => setTimeout(settle, 200));
      throw new Error('The customer settings field did not appear');
    },
  );
  assert.deepEqual(await reloadCustomerSettings(page, { retryDelayMs: 0 }), {
    attempts: 2,
    networkChanges: 1,
  });
  assert.equal(page.reloads, 2);
});

test('a settings reload without a network change fails the ready wait at once', async () => {
  const page = fakeSettingsPage(
    async () => okResponse(),
    async () => {
      throw new Error('The customer settings field did not appear');
    },
  );
  await assert.rejects(
    reloadCustomerSettings(page, { retryDelayMs: 0 }),
    /did not appear/,
  );
  assert.equal(page.reloads, 1);
});

test('a network change during the platform users navigation navigates again', async (t) => {
  const directory = await createEvidenceDirectory(t);
  const page = fakePlatformUsersPage({
    goto: async (navigations) => {
      if (navigations === 1) {
        failRequest(page, '/main.js', 'net::ERR_NETWORK_CHANGED');
        throw Error('page.goto: net::ERR_NETWORK_CHANGED');
      }
      return okResponse('/platform-users');
    },
    click: async () => undefined,
  });
  const result = await openPlatformUsers(page, {
    publicOrigin,
    principalId,
    evidenceDirectory: directory,
    label: 'access-revocation-platform-users',
  });
  assert.deepEqual(result, {
    attempts: 1,
    recoveries: [{ attempt: 1, routes: ['script'] }],
  });
  assert.deepEqual(page.navigations, [
    `${publicOrigin}/platform-users`,
    `${publicOrigin}/platform-users`,
  ]);
  assert.equal(page.clicks, 1);
});

test('a failed platform users click writes the page URL, the console errors, and the failed requests', async (t) => {
  const directory = await createEvidenceDirectory(t);
  const page = fakePlatformUsersPage({
    goto: async () => okResponse('/platform-users'),
    click: async () => {
      page.emit('console', {
        type: () => 'error',
        text: () => 'Failed to load resource: net::ERR_CONNECTION_RESET',
      });
      page.emit('requestfailed', {
        url: () => `${publicOrigin}/api/platform-users?page=1`,
        method: () => 'GET',
        failure: () => ({ errorText: 'net::ERR_CONNECTION_RESET' }),
      });
      throw new Error('locator.click: Timeout 30000ms exceeded.');
    },
  });
  await assert.rejects(
    openPlatformUsers(page, {
      publicOrigin,
      principalId,
      evidenceDirectory: directory,
      label: 'access-revocation-platform-users',
    }),
    /Timeout 30000ms exceeded/,
  );
  const failure = JSON.parse(
    await readFile(
      join(directory, 'access-revocation-platform-users-failure.json'),
      'utf8',
    ),
  );
  assert.equal(failure.url, `${publicOrigin}/platform-users`);
  assert.deepEqual(failure.documentState, {
    readyState: 'complete',
    applicationChildren: 0,
    headings: 0,
    busyRegions: 0,
    alerts: 0,
  });
  assert.deepEqual(failure.consoleErrors, [
    'Failed to load resource: net::ERR_CONNECTION_RESET',
  ]);
  assert.deepEqual(failure.failedRequests, [
    {
      route: 'other',
      path: '/api/platform-users',
      method: 'GET',
      error: 'ERR_CONNECTION_RESET',
    },
  ]);
});

test('the platform users navigation, ready wait, and click keep the Playwright budgets', async (t) => {
  const directory = await createEvidenceDirectory(t);
  const page = fakePlatformUsersPage({
    goto: async () => okResponse('/platform-users'),
    click: async () => undefined,
  });
  await openPlatformUsers(page, {
    publicOrigin,
    principalId,
    evidenceDirectory: directory,
    label: 'access-revocation-platform-users',
  });
  assert.equal(page.navigationOptions[0].timeout, 30000);
  assert.equal(page.readyOptions[0].timeout, 30000);
  assert.equal(page.clickOptions[0].timeout, 30000);
});

test('a settings reload keeps the Playwright navigation budget', async () => {
  const page = fakeSettingsPage(
    async () => okResponse(),
    async () => undefined,
  );
  await reloadCustomerSettings(page);
  assert.equal(page.reloadOptions[0].timeout, 30000);
  assert.equal(page.readyOptions[0].timeout, 15000);
});

test('a network change during the sign-in ready wait navigates again', async (t) => {
  const directory = await createEvidenceDirectory(t);
  const page = fakeSignInPage({
    goto: async (navigations) => {
      // The document commits, the page reads the session and records 401, then
      // the bundle request fails while the ready wait runs. The page never
      // reaches the sign-in view.
      if (navigations === 1)
        setTimeout(() => {
          page.emit('response', {
            status: () => 401,
            url: () => `${publicOrigin}/api/auth/session`,
            request: () => ({ isNavigationRequest: () => false }),
          });
          failRequest(page, '/main.js', 'net::ERR_NETWORK_CHANGED');
        }, 20);
      return okResponse('/login');
    },
    waitFor: async (navigations) => {
      if (navigations === 1) await delay(200);
    },
  });
  const result = await openSignInPage(page, {
    publicOrigin,
    evidenceDirectory: directory,
    label: 'sign-in-page',
  });
  // The navigation helper recovered the attempt. The step ran the action
  // once and reports the routes of the nested recovery.
  assert.deepEqual(result, {
    attempts: 1,
    recoveries: [{ attempt: 1, routes: ['script'] }],
  });
  assert.deepEqual(page.navigations, [publicOrigin, publicOrigin]);
});

test('a sign-in heading without a network change fails at once', async (t) => {
  const directory = await createEvidenceDirectory(t);
  const page = fakeSignInPage({
    goto: async () => okResponse('/login'),
    waitFor: async () => {
      throw new Error('The sign-in heading did not appear');
    },
  });
  await assert.rejects(
    openSignInPage(page, {
      publicOrigin,
      evidenceDirectory: directory,
      label: 'sign-in-page',
    }),
    /did not appear/,
  );
  assert.equal(page.navigations.length, 1);
});

test('the sign-in page navigation and ready wait keep the recovery budgets', async (t) => {
  const directory = await createEvidenceDirectory(t);
  const page = fakeSignInPage({ goto: async () => okResponse('/login') });
  await openSignInPage(page, {
    publicOrigin,
    evidenceDirectory: directory,
    label: 'sign-in-page',
  });
  assert.equal(page.navigationOptions[0].timeout, 30000);
  assert.equal(page.readyOptions[0].timeout, 15000);
});

test('a failed sign-in page load writes the page URL and the failed requests', async (t) => {
  const directory = await createEvidenceDirectory(t);
  const page = fakeSignInPage({
    goto: async () => {
      page.emit('requestfailed', {
        url: () => `${publicOrigin}/api/auth/session?ticket=synthetic-value`,
        method: () => 'GET',
        failure: () => ({ errorText: 'net::ERR_CONNECTION_RESET' }),
      });
      return okResponse('/login');
    },
    waitFor: async () => {
      throw new Error('The sign-in heading did not appear');
    },
  });
  page.url = () => `${publicOrigin}/login?ticket=synthetic-value`;
  await assert.rejects(
    openSignInPage(page, {
      publicOrigin,
      evidenceDirectory: directory,
      label: 'sign-in-page',
    }),
    /did not appear/,
  );
  const failure = JSON.parse(
    await readFile(join(directory, 'sign-in-page-failure.json'), 'utf8'),
  );
  assert.equal(failure.url, `${publicOrigin}/login?ticket=redacted`);
  assert.deepEqual(failure.failedRequests, [
    {
      route: 'authentication',
      path: '/api/auth/session',
      method: 'GET',
      error: 'ERR_CONNECTION_RESET',
    },
  ]);
  assert.equal(
    JSON.stringify(failure).includes('synthetic-value'),
    false,
    'the record retains a parameter value',
  );
});

test(
  'a row that renders after 16 seconds still passes the ready gate',
  { timeout: 40000 },
  async (t) => {
    const directory = await createEvidenceDirectory(t);
    const renderDelayMs = 16000;
    // The fake page enforces the timeout of the wait, as Playwright does.
    const page = fakePlatformUsersPage({
      goto: async () => okResponse('/platform-users'),
      click: async () => undefined,
      waitFor: async ({ timeout }) => {
        await delay(renderDelayMs);
        if (renderDelayMs > timeout)
          throw new Error(`locator.waitFor: Timeout ${timeout}ms exceeded.`);
      },
    });
    const result = await openPlatformUsers(page, {
      publicOrigin,
      principalId,
      evidenceDirectory: directory,
      label: 'access-revocation-platform-users',
    });
    assert.deepEqual(result, { attempts: 1, recoveries: [] });
    assert.equal(page.clicks, 1);
  },
);

test('a network change during the diagnostics ready wait reloads the page again', async () => {
  const page = fakeReloadPage(
    async (reloads) => {
      if (reloads === 1)
        setImmediate(() =>
          failRequest(page, '/main.js', 'net::ERR_NETWORK_CHANGED'),
        );
      return okResponse();
    },
    async (reloads) => {
      if (reloads !== 1) return;
      await delay(50);
      throw new Error('The Diagnostics heading did not appear');
    },
  );
  assert.deepEqual(await reloadDiagnosticsPage(page, { retryDelayMs: 0 }), {
    attempts: 2,
    networkChanges: 1,
  });
  assert.equal(page.reloads, 2);
});

test('a diagnostics reload without a network change fails the heading wait at once', async () => {
  const page = fakeReloadPage(
    async () => okResponse(),
    async () => {
      throw new Error('The Diagnostics heading did not appear');
    },
  );
  await assert.rejects(
    reloadDiagnosticsPage(page, { retryDelayMs: 0 }),
    /did not appear/,
  );
  assert.equal(page.reloads, 1);
});

test('the diagnostics reload waits for the Diagnostics heading with the 30 s and 15 s budgets', async () => {
  const page = fakeReloadPage(
    async () => okResponse(),
    async () => undefined,
  );
  assert.deepEqual(await reloadDiagnosticsPage(page), {
    attempts: 1,
    networkChanges: 0,
  });
  assert.deepEqual(page.headingQueries, [
    { role: 'heading', name: 'Diagnostics', exact: true },
  ]);
  assert.equal(page.reloadOptions[0].timeout, 30000);
  assert.equal(page.readyOptions[0].state, 'visible');
  assert.equal(page.readyOptions[0].timeout, 15000);
});

test('a server error during the diagnostics ready wait fails the reload at once', async () => {
  const page = fakeReloadPage(
    async () => okResponse(),
    async () => {
      page.emit('response', {
        status: () => 503,
        url: () => `${publicOrigin}/api/application`,
      });
      failRequest(page, '/main.js', 'net::ERR_NETWORK_CHANGED');
      throw new Error('The Diagnostics heading did not appear');
    },
  );
  await assert.rejects(
    reloadDiagnosticsPage(page, { retryDelayMs: 0 }),
    /HTTP 503/,
  );
  assert.equal(page.reloads, 1);
});

test('an expected session 401 does not suppress a network-change retry of the sign-in navigation', async () => {
  const page = fakeSignInPage({
    goto: async (navigations) => {
      if (navigations === 1) {
        // The page commits, reads the session, records 401, and the bundle
        // request fails before the load settles.
        page.emit('response', {
          status: () => 401,
          url: () => `${publicOrigin}/api/auth/session`,
        });
        failRequest(page, '/main.js', 'net::ERR_NETWORK_CHANGED');
        throw new Error('page.goto: net::ERR_NETWORK_CHANGED');
      }
      return okResponse('/login');
    },
  });
  assert.deepEqual(
    await navigateToSignInPage(page, `${publicOrigin}/login`, {
      retryDelayMs: 0,
    }),
    { attempts: 2, networkChanges: 1 },
  );
  assert.deepEqual(page.navigations, [
    `${publicOrigin}/login`,
    `${publicOrigin}/login`,
  ]);
});

test('a server error during the sign-in navigation fails at once without a retry', async () => {
  const page = fakeSignInPage({
    goto: async (navigations) => {
      if (navigations === 1) {
        page.emit('response', {
          status: () => 500,
          url: () => `${publicOrigin}/api/auth/session`,
        });
        failRequest(page, '/main.js', 'net::ERR_NETWORK_CHANGED');
        throw new Error('page.goto: net::ERR_NETWORK_CHANGED');
      }
      return okResponse('/login');
    },
  });
  await assert.rejects(
    navigateToSignInPage(page, `${publicOrigin}/login`, { retryDelayMs: 0 }),
    /HTTP 500/,
  );
  assert.equal(page.navigations.length, 1);
});

test('the sign-in navigation keeps the Playwright load budget and runs the ready check', async () => {
  const page = fakeSignInPage({ goto: async () => okResponse('/login') });
  const ready = { calls: 0 };
  assert.deepEqual(
    await navigateToSignInPage(page, `${publicOrigin}/login`, {
      ready: async () => {
        ready.calls++;
      },
    }),
    { attempts: 1, networkChanges: 0 },
  );
  assert.equal(page.navigationOptions[0].timeout, 30000);
  assert.equal(ready.calls, 1);
});

test('an expected session 401 does not suppress a network-change retry of the resume reload', async () => {
  const page = fakeReloadPage(
    async (reloads) => {
      if (reloads === 1) {
        page.emit('response', {
          status: () => 401,
          url: () => `${publicOrigin}/api/auth/session`,
        });
        failRequest(page, '/main.js', 'net::ERR_NETWORK_CHANGED');
      }
      return okResponse('/login');
    },
    async (reloads) => {
      if (reloads !== 1) return;
      await delay(50);
      throw new Error('The sign-in heading did not appear');
    },
  );
  assert.deepEqual(await reloadSignInView(page, { retryDelayMs: 0 }), {
    attempts: 2,
    networkChanges: 1,
  });
  assert.equal(page.reloads, 2);
  assert.deepEqual(page.headingQueries, [
    { role: 'heading', name: 'Sign in', exact: true },
  ]);
});

test('a sign-in ready failure with a network change navigates again', async () => {
  const page = fakeSignInPage({
    goto: async (navigations) => {
      if (navigations === 1)
        setImmediate(() =>
          failRequest(page, '/main.js', 'net::ERR_NETWORK_CHANGED'),
        );
      return okResponse('/login');
    },
    waitFor: async (navigations) => {
      if (navigations !== 1) return;
      await delay(50);
      throw new Error('The login or account view did not appear');
    },
  });
  assert.deepEqual(
    await navigateToSignInPage(page, `${publicOrigin}/login`, {
      retryDelayMs: 0,
      ready: () =>
        page
          .getByRole('heading', { name: 'Sign in', exact: true })
          .waitFor({ timeout: 15000 }),
    }),
    { attempts: 2, networkChanges: 1 },
  );
  assert.equal(page.navigations.length, 2);
});

test('a sign-in ready failure without a network change fails once', async () => {
  const page = fakeSignInPage({
    goto: async () => okResponse('/login'),
    waitFor: async () => {
      throw new Error('The login or account view did not appear');
    },
  });
  await assert.rejects(
    navigateToSignInPage(page, `${publicOrigin}/login`, {
      retryDelayMs: 0,
      ready: () =>
        page
          .getByRole('heading', { name: 'Sign in', exact: true })
          .waitFor({ timeout: 15000 }),
    }),
    /did not appear/,
  );
  assert.equal(page.navigations.length, 1);
});

test('the resume reload keeps the Playwright load budget and the 15 s sign-in wait', async () => {
  const page = fakeReloadPage(
    async () => okResponse('/login'),
    async () => undefined,
  );
  assert.deepEqual(await reloadSignInView(page), {
    attempts: 1,
    networkChanges: 0,
  });
  assert.equal(page.reloadOptions[0].timeout, 30000);
  assert.equal(page.readyOptions[0].state, 'visible');
  assert.equal(page.readyOptions[0].timeout, 15000);
});

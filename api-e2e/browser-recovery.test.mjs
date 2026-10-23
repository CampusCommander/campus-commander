import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import {
  openPlatformUsers,
  reloadCustomerSettings,
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

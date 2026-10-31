import AxeBuilder from '@axe-core/playwright';
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import {
  GOOGLE_CAPABILITIES,
  GOOGLE_SETUP_SCOPES,
  delegationLinkScopes,
  googleHealthCheckSchema,
  type GoogleHealth,
  type GoogleHealthFailure,
} from '@campus/application-contracts';
import { installLiveStreams } from './live-streams';

/**
 * States 14 to 16 of the Google Drive slice: the Drive card of the Google connection
 * page and the Drive check of Diagnostics. Every answer comes from a mocked API, and the
 * production Google path is never called.
 */
test.use({
  viewport: { width: 1440, height: 900 },
  timezoneId: 'America/New_York',
});

/** The mockup scenario time, Friday Oct 30, 2026, 11:05 AM US Eastern. */
const now = new Date('2026-10-30T11:05:00-04:00');
const at = (seconds: number) =>
  new Date(now.getTime() + seconds * 1000).toISOString();
const customerId = 'C03ex4mpl';
const clientId = '100000000000000000001';
const pickerKey = 'synthetic-picker-api-key-00000000000000';
const projectNumber = '123456789012';
const subject = 'admin@example.org';
const credentialId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const person = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  displayName: 'Review administrator',
};

const connection = {
  customerId,
  generation: 1,
  observation: {
    customerId,
    primaryDomain: 'example.org',
    domains: [
      {
        name: 'example.org',
        primary: true,
        verified: true,
        aliases: [{ name: 'k12.example.org', verified: true }],
      },
    ],
  },
  observedAt: at(-3140),
  confirmedAt: '2026-10-20T18:48:11-04:00',
  clientId,
  subject,
};
const customer = {
  customerId,
  primaryDomain: 'example.org',
  settings: { displayName: 'example.org' },
  revision: 1,
  lastRequestId: null,
  onboarding: {
    customerConfirmedAt: connection.confirmedAt,
    settingsConfirmedAt: null,
    lastGoogleObservationAt: connection.observedAt,
  },
};
const credential = {
  customerId,
  generation: 1,
  credentialId,
  active: true,
  keyId: 'synthetic-google-key',
};
const scopes = delegationLinkScopes(
  GOOGLE_SETUP_SCOPES,
  GOOGLE_CAPABILITIES.map((capability) => capability.scope),
);

function health(driveFailure: GoogleHealthFailure | null): GoogleHealth {
  return {
    customerId,
    generation: 1,
    observedAt: at(0),
    backgroundFailure: null,
    check: null,
    capabilities: GOOGLE_CAPABILITIES.map((capability) => {
      const failed = capability.id === 'drive-files' && !!driveFailure;
      return {
        capability: capability.id,
        scopeVerified: !failed,
        failure: failed ? driveFailure : null,
        checkedAt: at(-40),
        lastSucceededAt: failed ? null : at(-40),
        correlationId: null,
      };
    }),
  };
}

interface State {
  drive: { pickerApiKey: string; projectNumber: string } | null;
  health: GoogleHealth;
  theme: 'light' | 'dark';
  saveStatus: number;
  saveLost: boolean;
  /** The number of Drive settings reads that answer with a 503. */
  readFailures: number;
}

/** Answers every read of the shell, the connection page, and Diagnostics. */
async function fixture(page: Page, overrides: Partial<State> = {}) {
  const state: State = {
    drive: null,
    health: health('delegation-not-authorized'),
    theme: 'light',
    saveStatus: 201,
    saveLost: false,
    readFailures: 0,
    ...overrides,
  };
  const preferences = () => ({
    theme: state.theme,
    navigationCollapsed: false,
  });
  const grants = [
    ...[
      'devices:read',
      'jobs:read',
      'schools:read',
      'connection:read',
      'connection:diagnose',
    ].map((action) => ({ action, scope: { kind: 'district', customerId } })),
    ...[
      'connection:read',
      'connection:manage',
      'customer:read',
      'platform-users:read',
    ].map((action) => ({ action, scope: { kind: 'platform' } })),
  ];
  await page.clock.setFixedTime(now);
  await installLiveStreams(page);
  await page.route('**/api/application', (route) =>
    route.fulfill({
      json: {
        phase: 3,
        authenticationConfigured: true,
        version: 'development',
        build: 'client-review',
      },
    }),
  );
  await page.route('**/api/auth/session', (route) =>
    route.fulfill({
      json: {
        identity: {
          id: person.id,
          displayName: person.displayName,
          permissionVersion: 1,
          permissions: ['identity:read', 'diagnostics:read', 'diagnostics:run'],
          grants,
          preferences: preferences(),
        },
        csrfToken: 'a'.repeat(64),
        expiresAt: at(3600),
      },
    }),
  );
  await page.route('**/api/auth/preferences', (route) => {
    const body = route.request().postDataJSON();
    state.theme = body.theme;
    return route.fulfill({ json: {} });
  });
  await page.route('**/api/customer', (route) =>
    route.fulfill({ json: { customer } }),
  );
  await page.route('**/api/jobs/activity', (route) =>
    route.fulfill({
      json: {
        running: { count: 0, jobs: [] },
        waiting: { count: 0, jobs: [] },
        recent: { count: 0, jobs: [], nextExpiryAt: null },
        attention: false,
        seenAt: null,
        observedAt: at(-10),
      },
    }),
  );
  await page.route('**/api/diagnostics', (route) =>
    route.fulfill({
      json: {
        status: 'ready',
        observedAt: at(-10),
        checks: ['PostgreSQL', 'Redis', 'Kestra', 'Artifact storage'].map(
          (name) => ({ name, status: 'ready' }),
        ),
      },
    }),
  );
  await page.route('**/api/google-connection', (route) =>
    route.fulfill({ json: { connection } }),
  );
  await page.route('**/api/google-connection/credentials', (route) =>
    route.fulfill({
      json: { credential, configuredKeyIds: [credential.keyId] },
    }),
  );
  await page.route('**/api/google-connection/health', (route) =>
    route.fulfill({ json: { health: state.health } }),
  );
  await page.route('**/api/google-connection/drive', async (route) => {
    if (route.request().method() === 'POST') {
      if (state.saveLost) return route.abort('failed');
      if (state.saveStatus >= 400)
        return route.fulfill({
          status: state.saveStatus,
          json: { reason: 'unavailable' },
        });
      const input = route.request().postDataJSON();
      state.drive = input;
      return route.fulfill({ status: 201, json: { drive: input } });
    }
    if (state.readFailures > 0) {
      state.readFailures -= 1;
      return route.fulfill({
        status: 503,
        json: { reason: 'unavailable' },
      });
    }
    return route.fulfill({ json: { drive: state.drive } });
  });
  await page.route('**/api/google-connection/health/check', async (route) => {
    const input = googleHealthCheckSchema.parse(route.request().postDataJSON());
    expect(input.capabilities).toEqual(['drive-files']);
    state.health = health(null);
    return route.fulfill({ status: 201, json: { health: state.health } });
  });
  return state;
}

/** Two frames and the webfonts settle before a capture. */
async function settle(page: Page) {
  await page.evaluate(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    await document.fonts.ready;
    await Promise.all(
      document
        .getAnimations()
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
}
async function capture(
  page: Page,
  testInfo: TestInfo,
  name: string,
  target?: { selector: string; offset: number },
) {
  await settle(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await settle(page);
  await page.screenshot({
    path: testInfo.outputPath(`${name}-full.png`),
    fullPage: true,
  });
  if (target) await scrollTo(page, target.selector, target.offset);
  else await page.evaluate(() => window.scrollTo(0, 0));
  await settle(page);
  await page.screenshot({
    path: testInfo.outputPath(`${name}.png`),
  });
}
async function scrollTo(page: Page, selector: string, offset: number) {
  await page.evaluate(
    ({ selector, offset }) => {
      const target = document.querySelector(selector);
      if (!target) throw new Error(`No element for ${selector}`);
      window.scrollTo(
        0,
        target.getBoundingClientRect().top + window.scrollY - offset,
      );
    },
    { selector, offset },
  );
}

test('the Drive card before setup matches state 14 in both themes', async ({
  page,
}, testInfo) => {
  await fixture(page);
  await page.goto('/google-connection');
  const card = page.locator('app-drive-settings');
  await expect(
    card.getByRole('heading', { name: 'Google Drive' }),
  ).toBeVisible();
  await expect(card).toContainText(
    'Google Sheet export and Google Drive import use these settings.',
  );
  await expect(card).toContainText(
    'https://www.googleapis.com/auth/drive.file',
  );
  await expect(card.locator('dd.error')).toHaveText(
    'Delegation not authorized',
  );
  await expect(card).toContainText(
    'Verify the service-account numeric client ID and this capability scope in domain-wide delegation. Recheck after approval propagates.',
  );
  const link = card.getByRole('link', {
    name: 'Open domain-wide delegation in the Google Admin console',
  });
  const url = new URL((await link.getAttribute('href'))!);
  expect(url.origin + url.pathname).toBe(
    'https://admin.google.com/ac/owl/domainwidedelegation',
  );
  expect(url.searchParams.get('clientIdToAdd')).toBe(clientId);
  expect(url.searchParams.get('clientScopeToAdd')!.split(',')).toEqual(scopes);
  expect(url.searchParams.get('dn')).toBe('example.org');
  await expect(card.getByLabel('Picker API key')).toHaveValue('');
  await expect(card.getByLabel('Project number')).toHaveValue('');
  await expect(card).toContainText(
    'A browser API key of the service-account project. Restrict it to the Google Picker API.',
  );
  await expect(card).toContainText(
    'The Picker uses this number as its App ID. Google Cloud shows it on the project dashboard.',
  );
  await expect(
    card.getByRole('button', { name: 'Save Drive settings' }),
  ).toBeDisabled();
  await expect(
    card.getByRole('link', { name: 'Check Google access' }),
  ).toBeVisible();
  // The five setup steps stay open until the first save (choice 13).
  await expect(card.locator('details')).toHaveAttribute('open', '');
  for (const step of [
    'Enable the Google Drive API, the Google Sheets API, and the Google Picker API in the service-account project.',
    'Create an API key. Restrict it to the Google Picker API.',
    'Add no website restriction to the key. Campus Commander sends no referrer, so a website restriction blocks the Picker.',
    'Copy the project number from the project dashboard. The key file holds only the project ID.',
    'Add the Drive scope to domain-wide delegation, then check Google access.',
  ])
    await expect(card).toContainText(step);
  await expect(page.locator('footer')).toContainText(
    'Google: 1 of 7 capabilities need attention',
  );
  await capture(page, testInfo, 'state-14-light', {
    selector: 'app-drive-settings',
    offset: 20,
  });

  await page.getByRole('button', { name: 'Choose theme' }).click();
  await page.getByRole('menuitem', { name: 'Use dark theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await capture(page, testInfo, 'state-14-dark', {
    selector: 'app-drive-settings',
    offset: 20,
  });
});

test('a save fills the card and shows the ready line of state 15', async ({
  page,
}, testInfo) => {
  const state = await fixture(page);
  await page.goto('/google-connection');
  const card = page.locator('app-drive-settings');
  await expect(card.getByLabel('Picker API key')).toHaveValue('');
  await card.getByLabel('Picker API key').fill(pickerKey);
  await card.getByLabel('Project number').fill(projectNumber);
  const save = card.getByRole('button', { name: 'Save Drive settings' });
  await expect(save).toBeEnabled();
  await save.click();
  await expect(card).toContainText(
    'Google Drive is ready for Google Sheet export and Google Drive import.',
  );
  expect(state.drive).toEqual({
    pickerApiKey: pickerKey,
    projectNumber: projectNumber,
  });
  await expect(card.getByLabel('Picker API key')).toHaveValue(pickerKey);
  await expect(card.getByLabel('Project number')).toHaveValue(projectNumber);
  await expect(card.locator('dd.error')).toHaveCount(0);
  await expect(card).toContainText('Last check passed');
  await expect(save).toBeDisabled();
  await expect(card.locator('details')).not.toHaveAttribute('open', '');
  await expect(page.locator('footer')).toContainText('7 last checks passed');
  await capture(page, testInfo, 'state-15-light', {
    selector: 'app-drive-settings',
    offset: 20,
  });

  await page.getByRole('button', { name: 'Choose theme' }).click();
  await page.getByRole('menuitem', { name: 'Use dark theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await capture(page, testInfo, 'state-15-dark', {
    selector: 'app-drive-settings',
    offset: 20,
  });
});

test('a refused save reports the drafted failure and offers the save again', async ({
  page,
}, testInfo) => {
  const state = await fixture(page, { saveStatus: 503 });
  await page.goto('/google-connection');
  const card = page.locator('app-drive-settings');
  await card.getByLabel('Picker API key').fill(pickerKey);
  await card.getByLabel('Project number').fill(projectNumber);
  const save = card.getByRole('button', { name: 'Save Drive settings' });
  await save.click();
  await expect(card.locator('[role=status]').first()).toContainText(
    'Campus Commander did not save the Drive settings. Try again.',
  );
  await expect(card.getByLabel('Picker API key')).toHaveValue(pickerKey);
  await expect(card.getByLabel('Project number')).toHaveValue(projectNumber);
  // The refused save wrote nothing, so the same control offers the retry (UI-05, UI-08).
  await expect(
    card.getByRole('button', { name: 'Refresh Drive settings' }),
  ).toHaveCount(0);
  await expect(save).toBeEnabled();
  await capture(page, testInfo, 'refused-save-light', {
    selector: 'app-drive-settings',
    offset: 20,
  });
  state.saveStatus = 201;
  await save.click();
  await expect(card).toContainText(
    'Google Drive is ready for Google Sheet export and Google Drive import.',
  );
});

test('a lost save answer offers a refresh that reads the saved settings', async ({
  page,
}, testInfo) => {
  const state = await fixture(page, { saveLost: true });
  await page.goto('/google-connection');
  const card = page.locator('app-drive-settings');
  await card.getByLabel('Picker API key').fill(pickerKey);
  await card.getByLabel('Project number').fill(projectNumber);
  // The save reaches the mock, and its answer is lost on the way back.
  state.drive = { pickerApiKey: pickerKey, projectNumber };
  const save = card.getByRole('button', { name: 'Save Drive settings' });
  await save.click();
  await expect(card.locator('[role=status]').first()).toContainText(
    'The Drive settings save result is unknown. Refresh Drive settings to read the saved settings.',
  );
  await expect(save).toBeDisabled();
  await expect(card.getByLabel('Picker API key')).toHaveValue(pickerKey);
  const refresh = card.getByRole('button', { name: 'Refresh Drive settings' });
  await expect(refresh).toBeVisible();
  await capture(page, testInfo, 'lost-save-light', {
    selector: 'app-drive-settings',
    offset: 20,
  });
  state.saveLost = false;
  await refresh.click();
  await expect(refresh).toHaveCount(0);
  await expect(card).toContainText('Drive settings saved.');
  await expect(card.getByLabel('Picker API key')).toHaveValue(pickerKey);
  await expect(save).toBeDisabled();
});

test('a failed recovery read keeps the draft for the next read', async ({
  page,
}, testInfo) => {
  const earlierKey = 'previous-picker-api-key-000000000000000';
  const earlierNumber = '987654321098';
  const state = await fixture(page, {
    drive: { pickerApiKey: earlierKey, projectNumber: earlierNumber },
    saveLost: true,
  });
  await page.goto('/google-connection');
  const card = page.locator('app-drive-settings');
  await expect(card.getByLabel('Picker API key')).toHaveValue(earlierKey);
  await expect(card.getByLabel('Project number')).toHaveValue(earlierNumber);
  await card.getByLabel('Picker API key').fill(pickerKey);
  await card.getByLabel('Project number').fill(projectNumber);
  // The save never reaches the mock, so the earlier stored values remain.
  const save = card.getByRole('button', { name: 'Save Drive settings' });
  await save.click();
  await expect(card.locator('[role=status]').first()).toContainText(
    'The Drive settings save result is unknown. Refresh Drive settings to read the saved settings.',
  );
  await expect(save).toBeDisabled();
  // The first recovery read fails, so the card closes the form and offers another read.
  state.readFailures = 1;
  await card.getByRole('button', { name: 'Refresh Drive settings' }).click();
  await expect(card.locator('[role=status]').first()).toContainText(
    'Campus Commander did not read the Drive settings. Try again.',
  );
  await expect(card.getByLabel('Picker API key')).toHaveCount(0);
  await capture(page, testInfo, 'recovery-read-failed-light', {
    selector: 'app-drive-settings',
    offset: 20,
  });
  // The next read returns the earlier saved values. The draft must survive it.
  await card.getByRole('button', { name: 'Refresh Drive settings' }).click();
  await expect(card.getByLabel('Picker API key')).toHaveValue(pickerKey);
  await expect(card.getByLabel('Project number')).toHaveValue(projectNumber);
  expect(state.drive).toEqual({
    pickerApiKey: earlierKey,
    projectNumber: earlierNumber,
  });
  await expect(save).toBeEnabled();
  await expect(card).not.toContainText('Drive settings saved.');
  await capture(page, testInfo, 'recovered-draft-light', {
    selector: 'app-drive-settings',
    offset: 20,
  });
});

test('the fields refuse a short key and a project number that is not digits', async ({
  page,
}) => {
  await fixture(page);
  await page.goto('/google-connection');
  const card = page.locator('app-drive-settings');
  const key = card.getByLabel('Picker API key');
  await key.fill('a'.repeat(38));
  await card.getByLabel('Project number').fill('12ab');
  await card.getByLabel('Project number').blur();
  await expect(card).toContainText('Enter the 39-character API key.');
  await expect(card).toContainText(
    'Enter the project number. It holds digits only.',
  );
  await expect(
    card.getByRole('button', { name: 'Save Drive settings' }),
  ).toBeDisabled();
  // A keyboard path reaches every control of the card in page order.
  await key.focus();
  await page.keyboard.press('Tab');
  await expect(card.getByLabel('Project number')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(
    card.getByRole('link', { name: 'Check Google access' }),
  ).toBeFocused();
});

test('the Drive card and its states meet automated accessibility checks in both themes', async ({
  page,
}) => {
  await fixture(page);
  await page.goto('/google-connection');
  for (const theme of ['light', 'dark']) {
    await page.getByRole('button', { name: 'Choose theme' }).click();
    await page.getByRole('menuitem', { name: `Use ${theme} theme` }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await settle(page);
    const result = await new AxeBuilder({ page }).analyze();
    expect(result.violations).toEqual([]);
  }
  await page.setViewportSize({ width: 320, height: 900 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test('Diagnostics matches state 16 and lists the seven setup scopes', async ({
  page,
}, testInfo) => {
  await fixture(page);
  await page.goto('/diagnostics');
  const article = page.getByRole('article', { name: 'Google Drive files' });
  await expect(article).toBeVisible();
  await expect(article).toContainText('Delegation not authorized');
  await expect(article).toContainText('Checked 40 seconds ago');
  await expect(article).toContainText(
    'Required scope: Not verified in the last check.',
  );
  await expect(article).toContainText(
    'Verify the service-account numeric client ID and this capability scope in domain-wide delegation. Recheck after approval propagates.',
  );
  await expect(
    article.getByRole('button', { name: 'Recheck Google Drive files' }),
  ).toBeVisible();
  await expect(
    article.getByText('Google Drive files setup details', { exact: true }),
  ).toBeVisible();
  const details = page.locator('details.authorization');
  await details.locator('summary').click();
  await expect(details).toContainText(
    'Add these 7 scopes to allow the checks on this page.',
  );
  await expect(details).toContainText(
    'Enable the Admin SDK API, the Google Drive API, the Google Sheets API, and the Google Picker API in the service-account project.',
  );
  await expect(
    details.getByLabel('Required Google capability scopes'),
  ).toHaveText(scopes.join(',\n'));
  await expect(details).toContainText(`Service account client ID: ${clientId}`);
  await capture(page, testInfo, 'state-16-light', {
    selector: 'article[aria-labelledby="drive-files-title"]',
    offset: 36,
  });
});

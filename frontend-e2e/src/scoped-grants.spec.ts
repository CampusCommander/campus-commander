import AxeBuilder from '@axe-core/playwright';
import { test, expect, type Page } from '@playwright/test';
import {
  actionSchema,
  grantsForPreset,
  platformAccessChangeSchema,
  type Grant,
  type PlatformPrincipal,
  type SchoolDefinition,
} from '@campus/application-contracts';

const customerId = 'C0123456';
const schoolA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const schoolB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const targetId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const actorId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const receiptId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const district = { kind: 'district' as const, customerId };
const scopeA = { kind: 'school' as const, customerId, schoolId: schoolA };
const scopeB = { kind: 'school' as const, customerId, schoolId: schoolB };
const initial: Grant[] = [
  { action: 'customer:read', scope: { kind: 'platform' } },
  { action: 'connection:read', scope: district },
  { action: 'schools:read', scope: scopeB },
];

async function fixture(
  page: Page,
  stale = false,
  limited = false,
  grants = initial,
) {
  let principal: PlatformPrincipal = {
    id: targetId,
    issuer: 'https://identity.fixture.invalid',
    subject: 'operator',
    displayName: 'School operator',
    enabled: true,
    permissionVersion: 1,
    permissions: ['identity:read'],
    grants: structuredClone(grants),
  };
  const schools: SchoolDefinition[] = [schoolA, schoolB].map((id, index) => ({
    id,
    customerId,
    name: index ? 'School B' : 'School A',
    revision: index + 2,
    rules: { include: [{ id: 'root', descendants: true }], exclude: [] },
    approvedIds: ['root'],
    effectiveIds: stale ? null : ['root'],
    referenceRevision: receiptId,
    updatedAt: new Date().toISOString(),
  }));
  let proposed: { enabled: boolean; grants: Grant[] } | null = null;
  let schoolRevisions: {
    schoolId: string;
    customerId: string;
    revision: number;
  }[] = [];
  let conflict = false;
  let confirmations = 0;
  let preferences = { theme: 'light', navigationCollapsed: false };
  await page.route('**/api/application', (route) =>
    route.fulfill({
      json: {
        phase: 3,
        authenticationConfigured: true,
        version: 'development',
        build: 'unreleased',
      },
    }),
  );
  await page.route('**/api/auth/session', (route) =>
    route.fulfill({
      json: {
        identity: {
          id: actorId,
          displayName: 'Grant manager',
          permissionVersion: 1,
          permissions: ['identity:read'],
          preferences,
          grants: actionSchema.options
            .filter((action) => !limited || action !== 'security-events:read')
            .map((action) => ({ action, scope: { kind: 'platform' } })),
        },
        csrfToken: 'a'.repeat(64),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      },
    }),
  );
  await page.route('**/api/auth/preferences', (route) => {
    preferences = route.request().postDataJSON();
    return route.fulfill({ json: {} });
  });
  await page.route('**/api/customer', (route) =>
    route.fulfill({
      json: {
        customer: {
          customerId,
          primaryDomain: 'fixture.invalid',
          settings: { displayName: 'Fixture district' },
          revision: 1,
          lastRequestId: null,
          onboarding: {
            customerConfirmedAt: new Date().toISOString(),
            settingsConfirmedAt: null,
            lastGoogleObservationAt: new Date().toISOString(),
          },
        },
      },
    }),
  );
  await page.route('**/api/google-connection**', (route) =>
    route.fulfill({ status: 503, json: {} }),
  );
  await page.route('**/api/schools**', (route) => {
    const path = new URL(route.request().url()).pathname;
    const school = schools.find((school) => path.endsWith(school.id));
    return route.fulfill({
      json: school ?? {
        total: schools.length,
        items: schools,
        limit: 20,
        offset: 0,
      },
    });
  });
  await page.route('**/api/platform-users**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/review')) {
      const input = platformAccessChangeSchema.parse(
        route.request().postDataJSON(),
      );
      proposed = { enabled: input.enabled, grants: input.grants };
      schoolRevisions = schools
        .filter((school) =>
          input.grants.some(
            (grant) =>
              grant.scope.kind === 'school' &&
              grant.scope.schoolId === school.id,
          ),
        )
        .map(({ id, customerId, revision }) => ({
          schoolId: id,
          customerId,
          revision,
        }));
      return route.fulfill({
        json: {
          current: principal,
          proposed,
          actorVersion: 1,
          targetVersion: principal.permissionVersion,
          schoolRevisions,
          invitationsToRevoke: [],
        },
      });
    }
    if (path.endsWith('/access')) {
      const input = route.request().postDataJSON();
      expect(input.grants).toEqual(proposed?.grants);
      expect(input.schoolRevisions).toEqual(schoolRevisions);
      if (conflict) {
        conflict = false;
        schools[0].revision += 1;
        return route.fulfill({
          status: 409,
          json: { reason: 'school-changed' },
        });
      }
      confirmations += 1;
      principal = {
        ...principal,
        enabled: input.enabled,
        grants: input.grants,
        permissionVersion: principal.permissionVersion + 1,
      };
      return route.fulfill({
        json: { principal, receiptId, correlationId: receiptId },
      });
    }
    if (path.endsWith('/receipts'))
      return route.fulfill({ json: { total: 0, offset: 0, items: [] } });
    return route.fulfill({
      json: path.endsWith(targetId)
        ? principal
        : { items: [principal], total: 1, offset: 0, limit: 50 },
    });
  });
  await page.goto('/platform-users');
  await page
    .getByRole('button', { name: 'Review access for School operator' })
    .click();
  return {
    proposed: () => proposed,
    principal: () => principal,
    confirmations: () => confirmations,
    conflict: () => {
      conflict = true;
    },
  };
}

test('assigns district and school presets while preserving other scopes and exact reviewed revisions', async ({
  page,
}) => {
  const state = await fixture(page);
  await page.getByRole('button', { name: 'Load permitted scopes' }).click();
  await page
    .getByRole('button', { name: 'Select school School A', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Use school administrator preset' })
    .click();
  await page
    .getByRole('button', { name: 'Select district Fixture district' })
    .click();
  await page
    .getByRole('button', { name: 'Use district viewer preset' })
    .click();
  await page
    .getByRole('button', { name: 'Review access changes', exact: true })
    .click();
  const expected = [
    initial[0],
    initial[2],
    ...grantsForPreset('school-administrator', scopeA),
    ...grantsForPreset('viewer', district),
  ];
  expect(state.proposed()?.grants).toEqual(expect.arrayContaining(expected));
  expect(state.proposed()?.grants).toHaveLength(expected.length);
  await expect(
    page.getByRole('heading', { name: 'Reviewed school revisions' }),
  ).toBeVisible();
  await page
    .getByLabel('I reviewed this identity and its exact access changes.')
    .check();
  await page
    .getByRole('button', { name: 'Confirm access changes', exact: true })
    .click();
  expect(state.confirmations()).toBe(1);
  expect(state.principal().grants).toHaveLength(expected.length);
  await expect(
    page.getByRole('status', { name: 'Platform access status' }),
  ).toContainText(
    'Access changed. Previous sessions require sign-in. Receipt:',
  );
});

test('keeps removal available for an unavailable school and prevents new grants', async ({
  page,
}) => {
  const state = await fixture(page, true);
  await page.getByRole('button', { name: 'Load permitted scopes' }).click();
  await page
    .getByRole('button', { name: 'Select school School B', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Use school administrator preset' }),
  ).toBeDisabled();
  await page
    .getByRole('button', {
      name: `Remove Read school scopes for School ${schoolB} in ${customerId}`,
    })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Proposed district and school access' }),
  ).toBeFocused();
  await page
    .getByRole('button', { name: 'Review access changes', exact: true })
    .click();
  expect(state.proposed()?.grants).toEqual(
    expect.arrayContaining(initial.slice(0, 2)),
  );
  expect(state.proposed()?.grants).toHaveLength(2);
  await page
    .getByLabel('I reviewed this identity and its exact access changes.')
    .check();
  await page
    .getByRole('button', { name: 'Confirm access changes', exact: true })
    .click();
  expect(
    state.principal().grants.some((grant) => grant.scope.kind === 'school'),
  ).toBe(false);
});

test('requires another review after a school revision conflict and invalidates previews after scoped edits', async ({
  page,
}) => {
  const state = await fixture(page);
  await page.getByRole('button', { name: 'Load permitted scopes' }).click();
  await page
    .getByRole('button', { name: 'Select school School A', exact: true })
    .click();
  await page.getByRole('button', { name: 'Use school viewer preset' }).click();
  await page
    .getByRole('button', { name: 'Review access changes', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Use school administrator preset' })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Confirm access changes' }),
  ).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Review access changes', exact: true })
    .click();
  state.conflict();
  await page
    .getByLabel('I reviewed this identity and its exact access changes.')
    .check();
  await page
    .getByRole('button', { name: 'Confirm access changes', exact: true })
    .click();
  await expect(
    page.getByText(
      'The school definition changed. Review access again before confirmation.',
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Confirm access changes' }),
  ).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Review access changes', exact: true })
    .click();
  await page
    .getByLabel('I reviewed this identity and its exact access changes.')
    .check();
  await page
    .getByRole('button', { name: 'Confirm access changes', exact: true })
    .click();
  expect(state.confirmations()).toBe(1);
});

test('enforces delegation limits and qualifies scoped controls in both themes and narrow layout', async ({
  page,
}) => {
  await fixture(page, false, true);
  await page.getByRole('button', { name: 'Load permitted scopes' }).click();
  await page
    .getByRole('button', { name: 'Select school School A', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Use school administrator preset' }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Use school viewer preset' }),
  ).toBeEnabled();
  const actions = page.getByRole('group', {
    name: 'Actions for this resource',
  });
  await expect(
    actions.getByLabel('Read security events', { exact: true }),
  ).toBeDisabled();
  for (const theme of ['light', 'dark']) {
    await page.evaluate(
      (theme) => (document.documentElement.dataset['theme'] = theme),
      theme,
    );
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({
      path: test.info().outputPath(`scoped-grants-${theme}.png`),
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 320, height: 900 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test('keeps unchecked actions disabled at capacity and submits only displayed grants', async ({
  page,
}) => {
  const grants: Grant[] = [
    ...initial,
    ...Array.from(
      { length: 253 },
      (_, index): Grant => ({
        action: 'schools:read',
        scope: {
          kind: 'school',
          customerId,
          schoolId: `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
        },
      }),
    ),
  ];
  const state = await fixture(page, false, false, grants);
  await page.getByRole('button', { name: 'Load permitted scopes' }).click();
  await page
    .getByRole('button', { name: 'Select school School A', exact: true })
    .click();
  const action = page
    .getByRole('group', { name: 'Actions for this resource' })
    .getByLabel('Read security events', { exact: true });
  await expect(action).toBeDisabled();
  await expect(action).not.toBeChecked();
  await page
    .getByRole('button', { name: 'Review access changes', exact: true })
    .click();
  expect(state.proposed()?.grants).toHaveLength(256);
  expect(state.proposed()?.grants).toEqual(expect.arrayContaining(grants));
  await page
    .getByRole('button', {
      name: `Remove Read school scopes for School ${schoolB} in ${customerId}`,
    })
    .click();
  await expect(action).toBeEnabled();
  await action.check();
  await expect(action).toBeChecked();
  await page
    .getByRole('button', { name: 'Review access changes', exact: true })
    .click();
  expect(state.proposed()?.grants).toHaveLength(256);
  expect(state.proposed()?.grants).toContainEqual({
    action: 'security-events:read',
    scope: scopeA,
  });
  expect(state.proposed()?.grants).not.toContainEqual(initial[2]);
});

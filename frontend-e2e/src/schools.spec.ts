import AxeBuilder from '@axe-core/playwright';
import { test, expect, type Page } from '@playwright/test';
import {
  resolveSchoolScope,
  schoolPreviewSchema,
  type SchoolDefinition,
  type SchoolReview,
} from '@campus/application-contracts';

const customerId = 'C0123456';
const schoolId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const referenceRevision = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const principal = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const initialSchool = (): SchoolDefinition => ({
  id: schoolId,
  customerId,
  name: 'School A',
  revision: 1,
  rules: { include: [{ id: 'a', descendants: true }], exclude: [] },
  approvedIds: ['a'],
  effectiveIds: ['a'],
  referenceRevision,
  updatedAt: new Date().toISOString(),
});

async function fixture(page: Page, manager = true, phase = 3) {
  let school = initialSchool();
  let review: SchoolReview | null = null;
  let loseConfirmation = false;
  let referenceFailure = false;
  let confirmationConflict = false;
  let confirmations = 0;
  let csrf = 'a'.repeat(64);
  let permissionVersion = 1;
  let interrupted = false;
  let preferences = { theme: 'light', navigationCollapsed: false };
  const observation = {
    customerId,
    generation: 1,
    revision: referenceRevision,
    observedAt: new Date().toISOString(),
    verified: true as const,
    complete: true as const,
    units: [
      { id: 'root', parentId: null, name: 'Customer', path: '/' },
      { id: 'a', parentId: 'root', name: 'School A', path: '/School A' },
      { id: 'b', parentId: 'root', name: 'School B', path: '/School B' },
    ],
  };
  await page.route('**/api/application', (route) =>
    route.fulfill({
      json: {
        phase,
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
          id: principal,
          displayName: 'School fixture',
          permissionVersion,
          permissions: ['identity:read'],
          grants: (manager
            ? ['schools:read', 'schools:manage', 'security-events:read']
            : ['schools:read', 'security-events:read']
          ).map((action) => ({
            action,
            scope: manager
              ? { kind: 'platform' }
              : { kind: 'school', customerId, schoolId },
          })),
          preferences,
        },
        csrfToken: csrf,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      },
    }),
  );
  await page.route('**/api/auth/preferences', (route) => {
    preferences = route.request().postDataJSON();
    return route.fulfill({ json: {} });
  });
  await page.route('**/api/schools**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (interrupted)
      return route.fulfill({ status: 401, json: { code: 'access-changed' } });
    if (path.endsWith('/references') || path.endsWith('/references/refresh')) {
      if (!manager) return route.fulfill({ status: 403, json: {} });
      return route.fulfill({
        json: {
          references: {
            customerId,
            generation: 1,
            observation,
            failure: referenceFailure ? 'permission-denied' : null,
            fresh: !referenceFailure,
            checkedAt: new Date().toISOString(),
            checking: false,
            retryAt: null,
          },
        },
      });
    }
    if (path === '/api/schools')
      return route.fulfill({
        json: { total: 1, offset: 0, limit: 20, items: [school] },
      });
    if (path === `/api/schools/${school.id}`)
      return route.fulfill({ json: school });
    if (path === `/api/schools/${school.id}/audit`)
      return route.fulfill({ json: { total: 0, offset: 0, items: [] } });
    if (
      path === '/api/schools/reviews' &&
      route.request().method() === 'POST'
    ) {
      const input = schoolPreviewSchema.parse(route.request().postDataJSON());
      const scope = resolveSchoolScope({
        observation,
        rules: input.rules,
        customerId,
        generation: 1,
        now: Date.now(),
      });
      if (!scope.valid) return route.fulfill({ status: 400, json: {} });
      review = {
        ...input,
        approvedIds: scope.ids,
        affectedPrincipalCount: 2,
        invitationIds: ['dddddddd-dddd-4ddd-8ddd-dddddddddddd'],
        expiresAt: new Date(Date.now() + 600000).toISOString(),
        appliedAt: null,
        revision: null,
      };
      return route.fulfill({ json: review });
    }
    if (review && path === `/api/schools/reviews/${review.id}/confirm`) {
      if (confirmationConflict) {
        confirmationConflict = false;
        observation.revision = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
        return route.fulfill({
          status: 409,
          json: { reason: 'references-changed' },
        });
      }
      expect(route.request().postDataJSON()).toEqual({ confirmed: true });
      confirmations += 1;
      review = {
        ...review,
        appliedAt: new Date().toISOString(),
        revision: review.expectedRevision + 1,
      };
      school = {
        id: review.schoolId,
        customerId,
        name: review.name,
        revision: review.revision!,
        rules: review.rules,
        approvedIds: review.approvedIds,
        effectiveIds: review.approvedIds,
        referenceRevision,
        updatedAt: review.appliedAt!,
      };
      if (loseConfirmation) {
        loseConfirmation = false;
        return route.abort('failed');
      }
      return route.fulfill({ json: review });
    }
    if (review && path === `/api/schools/reviews/${review.id}`)
      return route.fulfill({ json: review });
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto('/schools');
  if (phase === 3)
    await expect(
      page.getByRole('button', { name: 'School A', exact: true }),
    ).toBeVisible();
  return {
    loseConfirmation: () => {
      loseConfirmation = true;
    },
    failReferences: () => {
      referenceFailure = true;
    },
    conflictOnConfirmation: () => {
      confirmationConflict = true;
    },
    confirmations: () => confirmations,
    review: () => review,
    interrupt: () => {
      interrupted = true;
    },
    resume: () => {
      interrupted = false;
      permissionVersion += 1;
      csrf = 'b'.repeat(64);
    },
  };
}

async function createDraft(page: Page) {
  await page
    .getByRole('button', { name: 'Create school', exact: true })
    .click();
  await page.getByLabel('School name', { exact: true }).fill('New school');
  await page
    .getByRole('treeitem', { name: 'Root organizational unit' })
    .click();
  await page.getByRole('button', { name: 'Include unit' }).click();
  await page.getByRole('treeitem', { name: 'School B', exact: true }).click();
  await page.getByRole('button', { name: 'Exclude unit' }).click();
}

test('recovers a lost school confirmation after reload without another write', async ({
  page,
}) => {
  const state = await fixture(page);
  await createDraft(page);
  await page
    .getByRole('button', { name: 'Review school scope', exact: true })
    .click();
  await expect(
    page.getByText('New school — 2 approved organizational units.'),
  ).toBeVisible();
  expect(state.review()?.approvedIds).toEqual(['a', 'root']);
  await expect(
    page.getByRole('button', { name: 'Save school' }),
  ).toBeDisabled();
  await page
    .getByLabel('I reviewed the units and access changes for this school')
    .check();
  state.loseConfirmation();
  await page.getByRole('button', { name: 'Save school' }).click();
  await expect(
    page.getByText('We have not received a save confirmation.', {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Return to draft' }),
  ).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: 'Check school save status' }).click();
  await expect(
    page.getByRole('heading', { name: 'School saved' }),
  ).toBeFocused();
  expect(state.confirmations()).toBe(1);
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'School saved' }),
  ).toBeVisible();
  expect(state.confirmations()).toBe(1);
});

test('preserves school drafts while stale references and access changes prevent confirmation', async ({
  page,
}) => {
  const state = await fixture(page);
  await createDraft(page);
  await page
    .getByRole('button', { name: 'Review school scope', exact: true })
    .click();
  await page
    .getByLabel('I reviewed the units and access changes for this school')
    .check();
  state.failReferences();
  await page
    .getByRole('button', { name: 'Refresh Google units', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Save school' }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Return to draft' }).click();
  await expect(page.getByLabel('School name', { exact: true })).toHaveValue(
    'New school',
  );
  state.interrupt();
  await page
    .getByRole('button', { name: 'Refresh schools', exact: true })
    .click();
  await expect(page.getByLabel('School name', { exact: true })).toHaveValue(
    'New school',
  );
  await expect(
    page.getByRole('button', { name: 'Review school scope', exact: true }),
  ).toBeDisabled();
  state.resume();
  await page
    .getByRole('button', { name: 'Recheck access', exact: true })
    .click();
  await expect(page.getByLabel('School name', { exact: true })).toHaveValue(
    'New school',
  );
  await page.getByRole('button', { name: 'Check refresh status' }).click();
  await expect(
    page.getByRole('button', { name: 'Review school scope', exact: true }),
  ).toBeDisabled();
  expect(state.confirmations()).toBe(0);
});

test('shows only permitted school data and keeps manager controls unavailable to a school viewer', async ({
  page,
}) => {
  await fixture(page, false);
  await expect(
    page.getByText('Schools available to you: 1.', { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Create school', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'Google organizational units' }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'School A', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'School A', exact: true }),
  ).toBeFocused();
  await expect(
    page.getByRole('button', { name: 'Edit school', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Read school audit' }).click();
  await expect(page.getByText('No school audit events.')).toBeVisible();
  await expect(page.getByText('School B', { exact: true })).toHaveCount(0);
});

test('qualifies the school draft and review in both themes, keyboard navigation, and narrow layout', async ({
  page,
}) => {
  await fixture(page);
  await page
    .getByRole('button', { name: 'Create school', exact: true })
    .click();
  await expect(page.getByLabel('School name', { exact: true })).toBeFocused();
  await page.getByLabel('School name', { exact: true }).fill('Keyboard school');
  const root = page.getByRole('treeitem', { name: 'Root organizational unit' });
  await root.focus();
  await page.keyboard.press('ArrowDown');
  const unit = page.getByRole('treeitem', { name: 'School A', exact: true });
  await expect(unit).toBeFocused();
  await expect(unit).toHaveAttribute('aria-selected', 'false');
  await page.keyboard.press('Enter');
  await expect(unit).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'Include unit' }).click();
  for (const theme of ['light', 'dark']) {
    await page.evaluate(
      (theme) => (document.documentElement.dataset['theme'] = theme),
      theme,
    );

    await expect(page.locator('mat-label')).toHaveCSS(
      'color',
      theme === 'dark' ? 'rgb(154, 160, 166)' : 'rgb(95, 99, 104)',
    );
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({
      path: test.info().outputPath(`school-draft-${theme}.png`),
      fullPage: true,
    });
  }
  await page
    .getByRole('button', { name: 'Review school scope', exact: true })
    .click();
  for (const theme of ['light', 'dark']) {
    await page.evaluate(
      (theme) => (document.documentElement.dataset['theme'] = theme),
      theme,
    );

    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({
      path: test.info().outputPath(`school-review-${theme}.png`),
      fullPage: true,
    });
  }
  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(
      (zoom) => (document.documentElement.style.zoom = zoom),
      width === 1280 ? '2' : '1',
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  }
});

test('keeps schools unavailable in Phase 2', async ({ page }) => {
  await fixture(page, true, 2);
  await expect(page).toHaveURL(/\/account$/);
  await expect(
    page.getByRole('link', { name: 'Schools', exact: true }),
  ).toHaveCount(0);
});

test('recovers a new school reference conflict without discarding its name or scope', async ({
  page,
}) => {
  const state = await fixture(page);
  await createDraft(page);
  await page
    .getByRole('button', { name: 'Review school scope', exact: true })
    .click();
  const original = state.review();
  state.conflictOnConfirmation();
  await page
    .getByLabel('I reviewed the units and access changes for this school')
    .check();
  await page.getByRole('button', { name: 'Save school' }).click();
  await expect(page.getByLabel('School name', { exact: true })).toHaveValue(
    'New school',
  );
  await expect(
    page.getByRole('button', { name: 'Review school scope', exact: true }),
  ).toBeEnabled();
  await page
    .getByRole('button', { name: 'Review school scope', exact: true })
    .click();
  expect(state.review()?.schoolId).toBe(original?.schoolId);
  expect(state.review()?.rules).toEqual(original?.rules);
  expect(state.review()?.referenceRevision).not.toBe(
    original?.referenceRevision,
  );
  await page
    .getByLabel('I reviewed the units and access changes for this school')
    .check();
  await page.getByRole('button', { name: 'Save school' }).click();
  await expect(
    page.getByRole('heading', { name: 'School saved' }),
  ).toBeVisible();
});

test('associates invalid-name feedback and restores focus after discarding a draft', async ({
  page,
}) => {
  await fixture(page);
  await page
    .getByRole('button', { name: 'Create school', exact: true })
    .click();
  const name = page.getByLabel('School name', { exact: true });
  await name.fill('   ');
  await name.press('Tab');
  await expect(name).toHaveAttribute('aria-invalid', 'true');
  await expect(
    page.getByText(
      'Enter a name with at least one non-space character and no control characters.',
    ),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Discard draft' }).click();
  await expect(
    page.getByRole('heading', { name: 'Your schools' }),
  ).toBeFocused();
});

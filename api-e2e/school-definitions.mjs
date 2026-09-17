import { qualificationSignIn } from './qualification-sign-in.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { expect } from '@playwright/test';

export async function qualifySchoolDefinitionsApi({
  api,
  adminPage,
  auditAccessibility,
  headers,
  references,
  browser,
  publicOrigin,
  migrator,
  actor,
  setSubject,
  evidenceDirectory,
}) {
  const root = `${publicOrigin}/api/schools`;
  const a = randomUUID(),
    b = randomUUID();
  const body = (schoolId, ouId, expectedRevision = 0) => ({
    id: randomUUID(),
    schoolId,
    customerId: references.customerId,
    expectedRevision,
    referenceRevision: references.observation.revision,
    name: schoolId === a ? 'School A' : 'School B',
    rules: { include: [{ id: ouId, descendants: true }], exclude: [] },
  });
  const post = async (path, data, status = 201) => {
    const response = await api.post(`${root}/${path}`, { headers, data });
    assert.equal(response.status(), status, await response.text());
    return response.json();
  };
  const read = async (client, path, status = 200) => {
    const response = await client.get(`${root}${path}`);
    assert.equal(response.status(), status, await response.text());
    return response.json();
  };
  assert.equal(
    (await api.post(`${root}/reviews`, { data: body(a, 'school-a') })).status(),
    403,
  );
  await post('reviews', { ...body(a, 'school-a'), approvedIds: ['root'] }, 400);
  const review = await post('reviews', body(a, 'school-a'));
  assert.deepEqual(review.approvedIds, ['school-a']);
  assert.equal(review.appliedAt, null);
  await post(`reviews/${review.id}/confirm`, {}, 400);
  const saved = await post(`reviews/${review.id}/confirm`, { confirmed: true });
  assert.equal(saved.revision, 1);
  assert.deepEqual(
    await post(`reviews/${review.id}/confirm`, { confirmed: true }),
    saved,
  );
  assert.deepEqual(await read(api, `/reviews/${review.id}`), saved);
  const other = await post('reviews', body(b, 'school-b'));
  await post(`reviews/${other.id}/confirm`, { confirmed: true });
  await adminPage.goto(`${publicOrigin}/schools`);
  await expect(
    adminPage.getByRole('heading', { name: 'Schools', exact: true }),
  ).toBeVisible();
  await adminPage
    .getByRole('button', { name: 'Create school', exact: true })
    .click();
  await adminPage
    .getByLabel('School name', { exact: true })
    .fill('Browser school');
  await adminPage
    .getByRole('treeitem', { name: 'Root organizational unit' })
    .click();
  await adminPage.getByRole('button', { name: 'Add inclusion' }).click();
  await adminPage
    .getByRole('treeitem', { name: 'School B', exact: true })
    .click();
  await adminPage.getByRole('button', { name: 'Add exclusion' }).click();
  for (const theme of ['light', 'dark']) {
    await adminPage.evaluate(
      (value) => (document.documentElement.dataset['theme'] = value),
      theme,
    );

    await expect(adminPage.locator('app-school-editor mat-label')).toHaveCSS(
      'color',
      theme === 'dark' ? 'rgb(154, 160, 166)' : 'rgb(95, 99, 104)',
    );
    await auditAccessibility(adminPage, `school-draft-${theme}`);
    await adminPage.screenshot({
      path: `${evidenceDirectory}/school-draft-${theme}.png`,
      fullPage: true,
    });
  }
  await adminPage
    .getByRole('button', { name: 'Review school scope', exact: true })
    .click();
  await expect(
    adminPage.getByText('Browser school — 2 approved organizational units.'),
  ).toBeVisible();
  for (const theme of ['light', 'dark']) {
    await adminPage.evaluate(
      (value) => (document.documentElement.dataset['theme'] = value),
      theme,
    );

    await auditAccessibility(adminPage, `school-review-${theme}`);
  }
  let browserReceipt;
  await adminPage.route('**/api/schools/reviews/*/confirm', async (route) => {
    const response = await route.fetch();
    assert.equal(response.status(), 201, await response.text());
    browserReceipt = await response.json();
    await route.abort('failed');
  });
  await adminPage
    .getByLabel('I confirm this school scope and its access consequences')
    .check();
  await adminPage
    .getByRole('button', { name: 'Confirm school definition' })
    .click();
  await expect(
    adminPage.getByText('The school result is unknown.', { exact: false }),
  ).toBeVisible();
  await adminPage.unroute('**/api/schools/reviews/*/confirm');
  assert.deepEqual(browserReceipt.approvedIds, ['root', 'school-a']);
  await adminPage.reload();
  await adminPage.getByRole('button', { name: 'Check school receipt' }).click();
  await expect(
    adminPage.getByRole('heading', { name: 'Confirmed school receipt' }),
  ).toBeFocused();
  assert.equal((await read(api, `/${browserReceipt.schoolId}`)).revision, 1);
  assert.equal((await read(api, `/${browserReceipt.schoolId}/audit`)).total, 1);
  const issuer = (
    await migrator.query(
      'SELECT issuer FROM cc.application_principals WHERE id=$1',
      [actor],
    )
  ).rows[0].issuer;
  const operator = randomUUID(),
    subject = `school-operator-${operator}`;
  await migrator.query(
    'INSERT INTO cc.application_principals(id,issuer,subject,display_name) VALUES($1,$2,$3,$3)',
    [operator, issuer, subject],
  );
  const grants = ['schools:read', 'security-events:read'].map((action) => ({
    action,
    scope: { kind: 'school', customerId: references.customerId, schoolId: a },
  }));
  const grantRoot = `${publicOrigin}/api/platform-users/${operator}`;
  const accessReview = await api.post(`${grantRoot}/review`, {
    headers,
    data: { expectedVersion: 1, enabled: true, grants },
  });
  assert.equal(accessReview.status(), 201, await accessReview.text());
  const access = await accessReview.json();
  assert.deepEqual(access.schoolRevisions, [
    { schoolId: a, customerId: references.customerId, revision: 1 },
  ]);
  await adminPage.goto(`${publicOrigin}/platform-users`);
  await adminPage
    .getByRole('button', { name: `Review access for ${subject}`, exact: true })
    .click();
  await adminPage
    .getByRole('button', { name: 'Load permitted scopes' })
    .click();
  await adminPage.getByRole('button', { name: /^Select district / }).click();
  await adminPage
    .getByRole('button', { name: 'Use district viewer preset' })
    .click();
  const confirmAccess = async () => {
    await adminPage
      .getByRole('button', { name: 'Review access changes', exact: true })
      .click();
    await adminPage
      .getByLabel('I reviewed this identity and its exact access changes.')
      .check();
    await adminPage
      .getByRole('button', { name: 'Confirm access changes', exact: true })
      .click();
    await expect(
      adminPage.getByText(
        'Access changed. Previous sessions require sign-in.',
        { exact: false },
      ),
    ).toBeVisible();
  };
  await confirmAccess();
  const districtAssignment = await (await api.get(grantRoot)).json();
  assert.equal(districtAssignment.grants.length, 3);
  assert.ok(
    districtAssignment.grants.every(
      (grant) =>
        grant.scope.kind === 'district' &&
        grant.scope.customerId === references.customerId,
    ),
  );
  await adminPage
    .getByRole('button', { name: 'Select school School A', exact: true })
    .click();
  await adminPage
    .getByRole('button', { name: 'Use school administrator preset' })
    .click();
  const districtRemovals = adminPage.getByRole('button', {
    name: new RegExp(`^Remove .* for District ${references.customerId}$`),
  });
  for (let index = 0; index < 3; index += 1)
    await districtRemovals.first().click();
  await expect(districtRemovals).toHaveCount(0);
  for (const theme of ['light', 'dark']) {
    await adminPage.evaluate(
      (value) => (document.documentElement.dataset['theme'] = value),
      theme,
    );
    await auditAccessibility(adminPage, `scoped-grants-${theme}`);
    await adminPage.screenshot({
      path: `${evidenceDirectory}/scoped-grants-${theme}.png`,
      fullPage: true,
    });
  }
  await confirmAccess();
  const assigned = await api.get(grantRoot);
  assert.equal(assigned.status(), 200, await assigned.text());
  assert.deepEqual((await assigned.json()).grants, grants);
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    setSubject(subject);
    const page = await context.newPage();
    await qualificationSignIn(
      page,
      publicOrigin,
      evidenceDirectory,
      'school-definitions',
    );
    const scoped = context.request;
    const session = await (
      await scoped.get(`${publicOrigin}/api/auth/session`)
    ).json();
    const scopedHeaders = {
      origin: publicOrigin,
      'x-csrf-token': session.csrfToken,
    };
    const list = await read(scoped, '');
    assert.equal(list.total, 1);
    assert.deepEqual(
      list.items.map((item) => item.id),
      [a],
    );
    assert.equal((await read(scoped, `/${a}`)).name, 'School A');
    assert.equal((await read(scoped, `/${b}`, 404)).reason, 'school-not-found');
    assert.equal(
      (await read(scoped, `/${randomUUID()}`, 404)).reason,
      'school-not-found',
    );
    assert.equal(
      (await read(scoped, `/${b}/audit`, 404)).reason,
      'school-not-found',
    );
    const history = await read(scoped, `/${a}/audit`);
    assert.equal(history.total, 2);
    assert.deepEqual(history.items.map((item) => item.event).sort(), [
      'grants-changed',
      'school-scope-changed',
    ]);
    await page.goto(`${publicOrigin}/schools`);
    await expect(
      page.getByText('1 permitted school definitions.', { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'School B', exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Browser school', exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Create school', exact: true }),
    ).toHaveCount(0);
    await page.getByRole('button', { name: 'School A', exact: true }).click();
    await page.getByRole('button', { name: 'Read school audit' }).click();
    await expect(
      page.getByText('2 permitted events.', { exact: false }),
    ).toBeVisible();
    assert.equal((await scoped.get(`${root}/references`)).status(), 403);
    assert.equal(
      (
        await scoped.post(`${root}/reviews`, {
          headers: scopedHeaders,
          data: body(a, 'school-a', 1),
        })
      ).status(),
      403,
    );
    assert.equal(
      (await scoped.get(`${root}/reviews/${review.id}`)).status(),
      403,
    );
    await migrator.query(
      "UPDATE cc.school_reference_state SET failure='permission-denied'",
    );
    const stale = await read(scoped, `/${a}`);
    assert.equal(stale.effectiveIds, null);
    assert.deepEqual(stale.approvedIds, ['school-a']);
    await page.getByRole('button', { name: 'Refresh definition' }).click();
    await expect(
      page.getByText('Unavailable. The saved definition remains intact.'),
    ).toBeVisible();
    await post('reviews', body(a, 'school-a', 1), 409);
    await migrator.query('UPDATE cc.school_reference_state SET failure=NULL');
    const change = await post('reviews', {
      ...body(a, 'school-a', 1),
      name: 'Renamed school',
    });
    assert.equal(change.affectedPrincipalCount, 1);
    await post(`reviews/${change.id}/confirm`, { confirmed: true });
    const revoked = await scoped.get(`${root}/${a}`);
    assert.equal(revoked.status(), 401, await revoked.text());
    assert.equal((await revoked.json()).code, 'access-changed');
    await page.getByRole('button', { name: 'Refresh definition' }).click();
    await expect(
      page.getByRole('button', { name: 'Recheck access', exact: true }),
    ).toBeVisible();
  } finally {
    setSubject('administrator');
    await migrator.query('UPDATE cc.school_reference_state SET failure=NULL');
    await context.close();
  }
  await writeFile(
    `${evidenceDirectory}/school-definitions-api.json`,
    JSON.stringify(
      {
        schemaVersion: 1,
        fixture: 'real-api-postgres-school-grants-synthetic-google',
        checks: [
          'strict preview input, CSRF, explicit confirmation, and durable receipt recovery',
          'scoped lists, totals, details, and audit deny another school',
          'scoped operator cannot manage references, previews, or receipts',
          'failed reference health preserves saved definitions without effective resource access',
          'definition confirmation invalidates an affected operator session',
          'browser inclusion and exclusion preview, lost confirmation response, reload, and durable receipt recovery',
          'school viewer browser list, audit, stale definition, and access interruption',
          'school draft and review accessibility in both themes',
          'district viewer and school administrator assignment through browser presets and exact reviewed revisions',
        ],
        limits: [
          'Human screen-reader qualification and acceptance remain pending.',
        ],
      },
      null,
      2,
    ),
  );
}

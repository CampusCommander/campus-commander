import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { expect } from '@playwright/test';

export async function qualifySchoolDefinitionsApi({
  api,
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
  for (const action of ['schools:read', 'security-events:read'])
    await migrator.query(
      'INSERT INTO cc.application_grants(principal_id,action,scope) VALUES($1,$2,$3)',
      [
        operator,
        action,
        JSON.stringify({
          kind: 'school',
          customerId: references.customerId,
          schoolId: a,
        }),
      ],
    );
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    setSubject(subject);
    const page = await context.newPage();
    await page.goto(`${publicOrigin}/api/auth/login`);
    await expect(
      page.getByRole('heading', { name: 'Your account', exact: true }),
    ).toBeVisible({ timeout: 15000 });
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
    assert.equal((await read(scoped, `/${a}/audit`)).total, 1);
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
        fixture: 'real-api-postgres-synthetic-school-grants',
        checks: [
          'strict preview input, CSRF, explicit confirmation, and durable receipt recovery',
          'scoped lists, totals, details, and audit deny another school',
          'scoped operator cannot manage references, previews, or receipts',
          'failed reference health preserves saved definitions without effective resource access',
          'definition confirmation invalidates an affected operator session',
        ],
        limits: [
          'School grants are seeded by the fixture. Production grant assignment and browser forms remain pending.',
        ],
      },
      null,
      2,
    ),
  );
}

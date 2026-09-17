import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';

/** Keep invitation fragments and authorization codes out of fixture errors. */
export async function withInstalledAdmission(action) {
  let stage;
  const stages = new Set([
    'open invitation',
    'redeem invitation',
    'read pending identity',
    'confirm identity',
    'check confirmed invitation',
    'sign in recipient',
    'check initial access',
    'assign scoped grant',
    'renew recipient session',
    'check school boundaries',
    'revoke access',
    'check revoked access',
    'check access receipts',
  ]);
  try {
    return await action((value) => {
      if (!stages.has(value)) throw new Error();
      stage = value;
    });
  } catch {
    throw new Error(
      stage
        ? `Installed invitation and access qualification failed at ${stage}.`
        : 'Installed invitation and access qualification failed.',
    );
  }
}

/** Exercise delivered Phase 3 workflows through browser sessions and public APIs. */
export async function qualifyInstalledPhase3({
  page,
  publicOrigin,
  provider,
  verifyRecipientAccess,
}) {
  const startedAt = Date.now();
  const observations = [];
  const request = async (
    browserPage,
    path,
    data,
    expectedStatus = data === undefined ? 200 : 201,
  ) => {
    const response = await browserPage.evaluate(
      async ({ path, data }) => {
        let options;
        if (data !== undefined) {
          const session = await (await fetch('/api/auth/session')).json();
          options = {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-csrf-token': session.csrfToken,
            },
            body: JSON.stringify(data),
          };
        }
        const response = await fetch(path, options);
        return { status: response.status, body: await response.json() };
      },
      { path, data },
    );
    assert.equal(
      response.status,
      expectedStatus,
      `Installed workflow ${path} returned an unexpected status.`,
    );
    observations.push({
      path,
      method: data === undefined ? 'GET' : 'POST',
      status: response.status,
    });
    return response.body;
  };
  const read = (path, status) => request(page, path, undefined, status);
  const post = (path, data, status) => request(page, path, data, status);
  const connectionRoot = '/api/google-connection';
  assert.equal((await read('/api/customer')).customer, null);
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
    publicKeyEncoding: { format: 'pem', type: 'spki' },
  });
  const credential = {
    clientId: '123456789',
    subject: 'administrator@fixture.invalid',
    serviceAccount: {
      type: 'service_account',
      client_id: '123456789',
      client_email: 'fixture@project.iam.gserviceaccount.com',
      private_key: privateKey,
      private_key_id: 'installed-fixture',
      token_uri: 'https://oauth2.googleapis.com/token',
    },
  };
  const candidate = await post(`${connectionRoot}/candidates`, {
    ...credential,
    id: randomUUID(),
  });
  assert.equal(candidate.status, 'ready');
  assert.equal(candidate.observation.customerId, 'C0123456');
  await post(
    `${connectionRoot}/candidates/${candidate.id}/confirm`,
    { customerId: 'C9999999', confirmed: true },
    409,
  );
  await post(`${connectionRoot}/candidates/${candidate.id}/confirm`, {
    customerId: 'C0123456',
    confirmed: true,
  });
  const customerId = 'C0123456';
  const connection = (await read(connectionRoot)).connection;
  assert.equal(connection.customerId, customerId);
  assert.equal(connection.generation, 1);
  const settingsInput = {
    customerId,
    expectedRevision: 0,
    requestId: randomUUID(),
    settings: { displayName: 'Installed Phase 3 district' },
  };
  await post('/api/customer/settings', settingsInput);
  const customer = (await read('/api/customer')).customer;
  assert.equal(
    customer.settings.displayName,
    settingsInput.settings.displayName,
  );
  assert.equal(customer.revision, 1);
  assert.ok(customer.onboarding.settingsConfirmedAt);
  await page.goto(`${publicOrigin}/customer-settings`);
  await expect(
    page.getByRole('heading', { name: 'Customer settings', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(settingsInput.settings.displayName, { exact: true }).first(),
  ).toBeVisible();
  const refreshed = await post('/api/schools/references/refresh', {
    customerId,
    generation: 1,
  });
  const references = refreshed.references;
  assert.equal(references.fresh, true);
  const schools = [];
  for (const [name, ouId] of [
    ['Installed school A', 'school-a'],
    ['Installed school B', 'school-b'],
  ]) {
    const review = await post('/api/schools/reviews', {
      id: randomUUID(),
      schoolId: randomUUID(),
      customerId,
      expectedRevision: 0,
      referenceRevision: references.observation.revision,
      name,
      rules: { include: [{ id: ouId, descendants: true }], exclude: [] },
    });
    assert.deepEqual(review.approvedIds, [ouId]);
    const receipt = await post(`/api/schools/reviews/${review.id}/confirm`, {
      confirmed: true,
    });
    const school = await read(`/api/schools/${receipt.schoolId}`);
    assert.equal(school.name, name);
    assert.deepEqual(school.approvedIds, [ouId]);
    schools.push(school);
  }
  await page.goto(`${publicOrigin}/schools`);
  await expect(
    page.getByRole('button', { name: schools[0].name, exact: true }),
  ).toBeVisible();
  const subject = 'installed-school-reader';
  const invitation = await post('/api/auth/invitations', {
    label: 'Installed school reader',
    expectedSubject: subject,
    expiresInHours: 1,
    grants: [{ action: 'customer:read', scope: { kind: 'platform' } }],
  });
  const recipient = await page
    .context()
    .browser()
    .newContext({ ignoreHTTPSErrors: true });
  let receiptIds;
  let principalId;
  try {
    await withInstalledAdmission(async (checkpoint) => {
      checkpoint('open invitation');
      const recipientPage = await recipient.newPage();
      provider.setSubject(subject);
      await recipientPage.goto(invitation.url);
      await expect(
        recipientPage.getByRole('heading', {
          name: 'Accept a platform invitation',
          exact: true,
        }),
      ).toBeVisible();
      checkpoint('redeem invitation');
      await recipientPage
        .getByRole('button', {
          name: 'Sign in to accept invitation',
          exact: true,
        })
        .click();
      await expect(
        recipientPage.getByText(
          'Your identity is verified. Ask your inviter to review and confirm your access.',
          { exact: true },
        ),
      ).toBeVisible();
      checkpoint('read pending identity');
      await request(recipientPage, '/api/auth/session', undefined, 401);
      const pending = (await read('/api/auth/invitations')).find(
        (item) => item.id === invitation.id,
      );
      assert.equal(pending.status, 'pending');
      assert.equal(pending.candidateSubject, subject);
      checkpoint('confirm identity');
      await post(`/api/auth/invitations/${pending.id}/confirm`, {
        version: pending.version,
        subject,
      });
      checkpoint('check confirmed invitation');
      await recipientPage
        .getByRole('button', { name: 'Check invitation status', exact: true })
        .click();
      await expect(
        recipientPage.getByText(
          'Your inviter confirmed your access. Sign in to continue.',
          { exact: true },
        ),
      ).toBeVisible();
      checkpoint('sign in recipient');
      await recipientPage
        .getByRole('link', { name: 'Sign in to Campus Commander', exact: true })
        .click();
      await expect(
        recipientPage.getByRole('heading', {
          name: 'Your account',
          exact: true,
        }),
      ).toBeVisible({ timeout: 15000 });
      checkpoint('check initial access');
      let identity = (await request(recipientPage, '/api/auth/session'))
        .identity;
      principalId = identity.id;
      assert.equal(
        (await request(recipientPage, '/api/customer')).customer.customerId,
        customerId,
      );
      await request(recipientPage, '/api/platform-users', undefined, 403);
      const changeAccess = async (enabled, grants) => {
        const path = `/api/platform-users/${principalId}`;
        const change = {
          expectedVersion: identity.permissionVersion,
          enabled,
          grants,
        };
        const review = await post(`${path}/review`, change);
        const result = await post(`${path}/access`, {
          ...change,
          actorVersion: review.actorVersion,
          schoolRevisions: review.schoolRevisions,
          invitationIds: review.invitationsToRevoke.map((item) => item.id),
          confirmation: 'change-platform-access',
        });
        identity = result.principal;
        assert.ok(result.receiptId);
        return result.receiptId;
      };
      const grants = [
        { action: 'customer:read', scope: { kind: 'platform' } },
        {
          action: 'schools:read',
          scope: { kind: 'school', customerId, schoolId: schools[0].id },
        },
      ];
      checkpoint('assign scoped grant');
      const previousGrantCookies = verifyRecipientAccess
        ? await recipient.cookies(publicOrigin)
        : undefined;
      const grantReceipt = await changeAccess(true, grants);
      await verifyRecipientAccess?.({
        cookies: previousGrantCookies,
        principalId,
        schoolId: schools[0].id,
        hiddenSchoolId: schools[1].id,
        expectedStatus: 401,
        stage: 'grants-changed',
      });
      await request(recipientPage, '/api/auth/session', undefined, 401);
      checkpoint('renew recipient session');
      await recipientPage.goto(`${publicOrigin}/api/auth/login`);
      await expect(
        recipientPage.getByRole('heading', {
          name: 'Your account',
          exact: true,
        }),
      ).toBeVisible({ timeout: 15000 });
      checkpoint('check school boundaries');
      assert.equal(
        (await request(recipientPage, `/api/schools/${schools[0].id}`)).id,
        schools[0].id,
      );
      const hiddenSchool = await request(
        recipientPage,
        `/api/schools/${schools[1].id}`,
        undefined,
        404,
      );
      assert.deepEqual(hiddenSchool, { reason: 'school-not-found' });
      assert.deepEqual(
        await request(
          recipientPage,
          `/api/schools/${randomUUID()}`,
          undefined,
          404,
        ),
        hiddenSchool,
      );
      await verifyRecipientAccess?.({
        cookies: await recipient.cookies(publicOrigin),
        principalId,
        schoolId: schools[0].id,
        hiddenSchoolId: schools[1].id,
        expectedStatus: 200,
        stage: 'scoped-access',
      });
      checkpoint('revoke access');
      const previousRevokeCookies = verifyRecipientAccess
        ? await recipient.cookies(publicOrigin)
        : undefined;
      const revokeReceipt = await changeAccess(false, grants);
      checkpoint('check revoked access');
      await verifyRecipientAccess?.({
        cookies: previousRevokeCookies,
        principalId,
        schoolId: schools[0].id,
        hiddenSchoolId: schools[1].id,
        expectedStatus: 401,
        stage: 'revoked',
      });
      await request(recipientPage, '/api/auth/session', undefined, 401);
      await request(
        recipientPage,
        `/api/schools/${schools[0].id}`,
        undefined,
        401,
      );
      checkpoint('check access receipts');
      receiptIds = [grantReceipt, revokeReceipt];
      const receipts = await read(
        `/api/platform-users/${principalId}/receipts`,
      );
      assert.deepEqual(
        receipts.items.map((item) => item.id).sort(),
        receiptIds.toSorted(),
      );
      assert.equal(
        (await read(`/api/platform-users/${principalId}`)).enabled,
        false,
      );
    });
  } finally {
    provider.setSubject('administrator');
    await recipient.close();
  }
  const originalCredential = (await read(`${connectionRoot}/credentials`))
    .credential;
  const replacement = await post(`${connectionRoot}/replacements`, {
    ...credential,
    id: randomUUID(),
    customerId,
    generation: originalCredential.generation,
    subject: 'replacement@fixture.invalid',
  });
  assert.equal(replacement.status, 'ready');
  const active = await post(
    `${connectionRoot}/replacements/${replacement.id}/activate`,
    {
      customerId,
      generation: originalCredential.generation,
      keyId: originalCredential.keyId,
      confirmed: true,
    },
  );
  assert.equal(active.generation, originalCredential.generation + 1);
  assert.equal(active.customerId, customerId);
  assert.deepEqual(
    (await read('/api/customer')).customer.settings,
    customer.settings,
  );
  const report = {
    status: 'passed',
    durationMs: Date.now() - startedAt,
    checks: {
      customerConfirmation: true,
      settingsConfirmation: true,
      schoolScopeConfirmation: true,
      invitationRedemption: true,
      explicitIdentityConfirmation: true,
      scopedGrantAssignment: true,
      crossSchoolDenial: true,
      revocation: true,
      credentialReplacement: true,
      restartPersistence: false,
    },
    observations,
    limits: [
      'The installed application uses synthetic Google and OIDC providers.',
      'This report covers public API workflows and selected browser steps. It does not establish complete accessibility or district acceptance.',
    ],
  };
  return {
    report,
    async verifyAfterRestart() {
      assert.deepEqual(
        (await read('/api/customer')).customer.settings,
        customer.settings,
      );
      assert.equal(
        (await read(`${connectionRoot}/credentials`)).credential.generation,
        active.generation,
      );
      for (const school of schools)
        assert.deepEqual(
          (await read(`/api/schools/${school.id}`)).approvedIds,
          school.approvedIds,
        );
      assert.equal(
        (await read(`/api/platform-users/${principalId}`)).enabled,
        false,
      );
      assert.deepEqual(
        (await read(`/api/platform-users/${principalId}/receipts`)).items
          .map((item) => item.id)
          .sort(),
        receiptIds.toSorted(),
      );
      report.checks.restartPersistence = true;
      report.durationMs = Date.now() - startedAt;
      report.durationScope =
        'Public workflows and restart persistence, including intervening installer diagnostics.';
    },
  };
}

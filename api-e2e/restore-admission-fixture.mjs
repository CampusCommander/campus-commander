import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

const callbackRoute = '**/api/auth/callback?**';

async function navigate(page, url) {
  try {
    await page.goto(url);
  } catch {
    throw new Error('Restore admission navigation failed.');
  }
}

async function request(page, path, data) {
  return page.evaluate(
    async ({ path, data }) => {
      const response = await fetch(
        path,
        data === undefined
          ? {}
          : {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(data),
            },
      );
      return { status: response.status, body: await response.json() };
    },
    { path, data },
  );
}

/** Keep issued invitations and authorization callbacks pending in the source. */
export async function prepareRestoreAdmissions(adminPage, publicOrigin) {
  const contexts = [];
  const createdAt = Date.now();
  const newPage = async () => {
    const context = await adminPage
      .context()
      .browser()
      .newContext({ ignoreHTTPSErrors: true });
    contexts.push(context);
    const page = await context.newPage();
    await page.route('**/restore-fixture-hold', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<p>Restore fixture</p>',
      }),
    );
    await navigate(page, `${publicOrigin}/restore-fixture-hold`);
    return page;
  };
  const holdCallback = async (page, url) => {
    let callback;
    await page.route(callbackRoute, async (route) => {
      callback = route.request().url();
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<p>Pending authorization</p>',
      });
    });
    await navigate(page, url);
    assert.ok(
      callback,
      'The fixture must intercept an authorization callback.',
    );
    const cookies = await page.context().cookies();
    assert.ok(cookies.some((cookie) => cookie.name === '__Host-cc-login'));
    return { page, callback, cookies };
  };
  const invitations = [];
  try {
    for (const state of ['issued', 'redeeming', 'pending']) {
      const result = await adminPage.evaluate(async (label) => {
        const session = await (await fetch('/api/auth/session')).json();
        const response = await fetch('/api/auth/invitations', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-csrf-token': session.csrfToken,
          },
          body: JSON.stringify({
            label,
            expiresInHours: 1,
            grants: [{ action: 'customer:read', scope: { kind: 'platform' } }],
          }),
        });
        return { status: response.status, body: await response.json() };
      }, `Restore ${state} invitation`);
      assert.equal(result.status, 201);
      let token;
      try {
        token = new URL(result.body.url).hash.slice(1);
      } catch {
        throw new Error(
          'The restore fixture received an invalid invitation link.',
        );
      }
      assert.ok(/^[a-f0-9]{64}$/.test(token));
      const page = await newPage();
      const invitation = { id: result.body.id, state, token, page };
      if (state !== 'issued') {
        if (state === 'pending') await delay(2100);
        const redeemed = await request(page, '/api/auth/invitations/redeem', {
          token,
        });
        assert.equal(redeemed.status, 201);
        if (state === 'redeeming')
          invitation.authorization = await holdCallback(
            page,
            redeemed.body.url,
          );
        else {
          await navigate(page, redeemed.body.url);
          const status = await request(page, '/api/auth/invitations/status');
          assert.equal(status.status, 200);
          assert.equal(status.body.status, 'pending');
          await navigate(page, `${publicOrigin}/restore-fixture-hold`);
        }
      }
      invitations.push(invitation);
    }
    const login = await holdCallback(
      await newPage(),
      `${publicOrigin}/api/auth/login`,
    );
    const listed = await request(adminPage, '/api/auth/invitations');
    assert.equal(listed.status, 200);
    for (const invitation of invitations)
      assert.equal(
        listed.body.find((row) => row.id === invitation.id)?.status,
        invitation.state,
      );
    const rejectCallback = async (authorization, expectedPath) => {
      await authorization.page.unroute(callbackRoute);
      await navigate(authorization.page, authorization.callback);
      const final = new URL(authorization.page.url());
      assert.equal(final.pathname, expectedPath);
      assert.equal(final.searchParams.get('error'), 'sign-in-failed');
      assert.equal(
        (await request(authorization.page, '/api/auth/session')).status,
        401,
      );
    };
    return {
      invitationIds: invitations.map(({ id }) => id),
      async verifyTarget() {
        const transactionAgeMilliseconds = Date.now() - createdAt;
        assert.ok(
          transactionAgeMilliseconds < 300000,
          'Authorization must remain inside its source lifetime.',
        );
        const issued = invitations.find(({ state }) => state === 'issued');
        assert.equal(
          (
            await request(issued.page, '/api/auth/invitations/redeem', {
              token: issued.token,
            })
          ).status,
          403,
        );
        for (const invitation of invitations.filter(
          ({ state }) => state !== 'issued',
        ))
          assert.equal(
            (await request(invitation.page, '/api/auth/invitations/status'))
              .status,
            401,
          );
        await rejectCallback(login, '/login');
        await rejectCallback(
          invitations.find(({ state }) => state === 'redeeming').authorization,
          '/invitation',
        );
        return {
          status: 'passed',
          issuedInvitationRejected: true,
          recipientBindingsRejected: 2,
          pendingLoginRejected: true,
          pendingInvitationCallbackRejected: true,
          transactionAgeMilliseconds,
        };
      },
      async verifySourceControl(principalId) {
        assert.ok(
          Date.now() - createdAt < 300000,
          'The source control must remain inside its authorization lifetime.',
        );
        await login.page.context().addCookies(login.cookies);
        await navigate(login.page, login.callback);
        const session = await request(login.page, '/api/auth/session');
        assert.equal(session.status, 200);
        assert.equal(session.body.identity.id, principalId);
        return true;
      },
      async close() {
        await Promise.all(contexts.map((context) => context.close()));
      },
    };
  } catch (error) {
    await Promise.all(contexts.map((context) => context.close()));
    throw error;
  }
}

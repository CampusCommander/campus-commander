import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { expect } from '@playwright/test';

export async function qualificationSignIn(
  page,
  publicOrigin,
  evidenceDirectory,
  label,
) {
  return qualificationBrowserStep(
    page,
    publicOrigin,
    evidenceDirectory,
    `${label}-sign-in`,
    async () => {
      await page.goto(`${publicOrigin}/api/auth/login`);
      await expect(
        page.getByRole('heading', { name: 'Your account', exact: true }),
      ).toBeVisible({ timeout: 15000 });
    },
  );
}

export async function qualificationBrowserStep(
  page,
  publicOrigin,
  evidenceDirectory,
  label,
  action,
) {
  const events = [];
  const record = (event) => {
    if (events.length < 100) events.push(event);
  };
  const resource = (url) => {
    const parsed = new URL(url);
    return {
      local: parsed.origin === publicOrigin,
      route: parsed.pathname.startsWith('/api/auth/')
        ? 'authentication'
        : parsed.pathname.endsWith('.js')
          ? 'script'
          : parsed.pathname.startsWith('/api/google-connection')
            ? 'connection-api'
            : parsed.pathname.startsWith('/api/customer')
              ? 'customer-api'
              : parsed.pathname === '/google-connection'
                ? 'connection-page'
                : parsed.pathname === '/invitations'
                  ? 'invitations-page'
                  : parsed.pathname === '/'
                    ? 'application-root'
                    : parsed.pathname === '/account'
                      ? 'account'
                      : 'other',
    };
  };
  const failed = (request) =>
    record({
      kind: 'request-failed',
      ...resource(request.url()),
      error:
        request.failure()?.errorText.match(/ERR_[A-Z_]+/)?.[0] ??
        'unclassified',
    });
  const response = (value) => {
    if (
      value.request().isNavigationRequest() ||
      value.status() >= 400 ||
      new URL(value.url()).pathname.startsWith('/api/')
    )
      record({
        kind: 'response',
        ...resource(value.url()),
        status: value.status(),
      });
  };
  const pageError = (error) =>
    record({
      kind: 'page-error',
      codes: error.message
        .match(
          /\b(?:NG[0-9]{4}|TypeError|ReferenceError|SyntaxError|RangeError|URIError|EvalError|AggregateError|Error)\b/g,
        )
        ?.slice(0, 10) ?? ['unclassified'],
    });
  page.on('requestfailed', failed);
  page.on('response', response);
  page.on('pageerror', pageError);
  try {
    await action();
  } catch (error) {
    const documentState = await Promise.race([
      page
        .evaluate(() => ({
          readyState: document.readyState,
          applicationChildren:
            document.querySelector('app-root')?.childElementCount ?? 0,
          headings: document.querySelectorAll('h1').length,
          busyRegions: document.querySelectorAll('[aria-busy="true"]').length,
          alerts: document.querySelectorAll('[role="alert"]').length,
        }))
        .catch(() => null),
      delay(1000, null, { ref: false }),
    ]);
    await writeFile(
      `${evidenceDirectory}/${label}-failure.json`,
      JSON.stringify(
        {
          schemaVersion: 1,
          finalLocation: resource(page.url()),
          documentState,
          events,
        },
        null,
        2,
      ),
    );
    throw error;
  } finally {
    page.off('requestfailed', failed);
    page.off('response', response);
    page.off('pageerror', pageError);
  }
}

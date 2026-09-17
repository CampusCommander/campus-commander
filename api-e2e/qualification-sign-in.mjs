import { writeFile } from 'node:fs/promises';
import { expect } from '@playwright/test';

export async function qualificationSignIn(
  page,
  publicOrigin,
  evidenceDirectory,
  label,
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
    if (value.request().isNavigationRequest() || value.status() >= 400)
      record({
        kind: 'response',
        ...resource(value.url()),
        status: value.status(),
      });
  };
  const pageError = (error) =>
    record({
      kind: 'page-error',
      codes: error.message.match(/NG[0-9]+|[A-Za-z]+Error/g)?.slice(0, 10) ?? [
        'unclassified',
      ],
    });
  page.on('requestfailed', failed);
  page.on('response', response);
  page.on('pageerror', pageError);
  try {
    await page.goto(`${publicOrigin}/api/auth/login`);
    await expect(
      page.getByRole('heading', { name: 'Your account', exact: true }),
    ).toBeVisible({ timeout: 15000 });
  } catch (error) {
    await writeFile(
      `${evidenceDirectory}/${label}-sign-in-failure.json`,
      JSON.stringify(
        {
          schemaVersion: 1,
          finalLocation: resource(page.url()),
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

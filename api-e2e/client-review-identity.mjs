import { readFile } from 'node:fs/promises';

export const reviewIdentities = new Map([
  ['administrator', 'Review administrator'],
  ['review-recipient', 'Review recipient'],
]);

export async function reviewIdentityPage(parameters) {
  const escape = (value) =>
    value.replace(/[&<>"']/g, (character) => {
      return {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      }[character];
    });
  const fields = [...parameters]
    .filter(([name]) => name !== 'review_identity')
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escape(name)}" value="${escape(value)}">`,
    )
    .join('');
  const tokens = await readFile(
    new URL('../frontend/src/theme/tokens.css', import.meta.url),
    'utf8',
  );
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Choose a review identity</title>
  <style>
    ${tokens}
    body { margin: var(--cc-page-padding); background: var(--cc-surface-app); color: var(--cc-text-primary); font-family: sans-serif; }
    main { max-width: var(--cc-content-max-width); margin: auto; }
    form { display: flex; flex-wrap: wrap; gap: var(--cc-space-lg); }
    button { padding: var(--cc-space-md); color: var(--cc-text-primary); background: var(--cc-surface-card); border: 1px solid var(--cc-border-control); border-radius: var(--cc-radius-control); font: inherit; }
    button:hover { background: var(--cc-surface-hover); }
    button:focus-visible { outline: 2px solid var(--cc-text-link); outline-offset: var(--cc-space-xs); }
  </style>
</head>
<body><main>
  <h1>Choose a review identity</h1>
  <p>This simulated sign-in provider serves the disposable development environment. It does not access Google accounts.</p>
  <p>Use the review administrator to manage access. Use the review recipient in a separate browser profile to accept an invitation.</p>
  <p>The review recipient starts without application access. An administrator must confirm the invitation before the recipient can sign in.</p>
  <form action="/authorize" method="get">
    ${fields}
    ${[...reviewIdentities].map(([subject, label]) => `<button type="submit" name="review_identity" value="${subject}">Sign in as ${label.toLowerCase()}</button>`).join('')}
  </form>
</main></body></html>`;
}

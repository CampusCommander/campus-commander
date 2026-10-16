import { execFileSync } from 'node:child_process';
import https from 'node:https';

/**
 * Stop the mock container while one selected request is in flight.
 *
 * The mock exit regression needs the container to stop after a request left the
 * harness and before its response returns. The hook wraps `https.request`, so
 * the harness source carries no fault-injection code.
 *
 * Usage:
 *
 *   CC_MOCK_FAULT_REQUEST='POST /api/google-connection/candidates' \
 *     node --import ./api-e2e/admin-sdk-mock-fault-hook.mjs api-e2e/auth.test.mjs
 *
 * The hook waits until the request with that method and path flushes, then
 * stops the owned mock container and writes one marker line to stderr.
 * Without CC_MOCK_FAULT_REQUEST the hook arms nothing.
 */
const selection = process.env.CC_MOCK_FAULT_REQUEST ?? '';
const separator = selection.indexOf(' ');
const method = separator < 0 ? '' : selection.slice(0, separator).toUpperCase();
const path =
  separator < 0
    ? ''
    : selection
        .slice(separator + 1)
        .split('?')[0]
        .trim();
if (selection && (!method || !path))
  throw new Error('CC_MOCK_FAULT_REQUEST must hold "<METHOD> <path>".');

/** The method and the path of one request call, in either request signature. */
function requestSummary(args) {
  const [first, second] = args;
  const settings = second && typeof second === 'object' ? second : {};
  const address =
    first && typeof first === 'object' && !(first instanceof URL) ? first : {};
  const requestMethod = String(
    settings.method ?? address.method ?? 'GET',
  ).toUpperCase();
  let pathname = '';
  if (first instanceof URL) pathname = first.pathname;
  else if (typeof first === 'string') {
    try {
      pathname = new URL(first).pathname;
    } catch {
      pathname = first.split('?')[0];
    }
  } else pathname = String(address.path ?? '').split('?')[0];
  return { method: requestMethod, pathname };
}

/** Stop the one mock container of the review environment under test. */
function stopMock() {
  const name = execFileSync('docker', ['ps', '--format', '{{.Names}}'], {
    encoding: 'utf8',
  })
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith('cc-phase2-') && entry.endsWith('-mock'));
  if (!name) throw new Error('The fault hook found no owned mock container.');
  execFileSync('docker', ['kill', name]);
  process.stderr.write(`The fault hook stopped ${name}.\n`);
}

if (selection) {
  const capture = https.request;
  https.request = function faultHook(...args) {
    const call = capture.apply(this, args);
    const summary = requestSummary(args);
    if (summary.method === method && summary.pathname === path)
      call.once('finish', stopMock);
    return call;
  };
}

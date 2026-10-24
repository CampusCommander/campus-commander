import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
// The fixture is the code under test: its preview and its confirm answer must agree on one
// digest, and that digest must name the request of every eligible row.
import { mockApi } from '../src/device-update-mock.ts';

/** The digest of a preview with no eligible target. The old caller hashed exactly this. */
const emptyTargetDigest = createHash('sha256')
  .update(JSON.stringify({ actionVersion: 3, targets: [] }))
  .digest('hex');

const notesFirst = [{ field: 'notes', mode: 'replace', value: 'First' }];
const notesSecond = [{ field: 'notes', mode: 'replace', value: 'Second' }];

const device = {
  serialNumber: 'CB-0001',
  annotatedLocation: null,
  annotatedUser: null,
  notes: 'Old',
};

/**
 * A Page stand-in that captures the route handlers of `mockApi`. The fixture registers one
 * `**\/api/**` handler, and this helper invokes it with a request as Playwright would, so the
 * test drives the fixture confirm handler and not a copy of it.
 */
function capturePage() {
  const routes = [];
  return {
    routes,
    addInitScript: async () => undefined,
    route: async (pattern, handler) => {
      routes.push({ pattern, handler });
    },
  };
}

/** Invoke the fixture handler for one method and path. */
async function callFixture(page, method, path, body) {
  const route = page.routes.find(
    (candidate) => candidate.pattern === '**/api/**',
  );
  assert.ok(route, 'the fixture registers an API route');
  let answer = null;
  await route.handler({
    request: () => ({
      method: () => method,
      url: () => `http://localhost:4200${path}`,
      postDataJSON: () => body,
    }),
    fulfill: async (value) => {
      answer = value;
    },
  });
  assert.ok(answer, `${method} ${path} is answered`);
  return answer;
}

function preview(page, changes) {
  return callFixture(page, 'POST', '/api/devices/updates/previews', {
    changes,
  });
}

function confirm(page, manifestDigest) {
  return callFixture(
    page,
    'POST',
    '/api/devices/updates/previews/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/confirm',
    { manifestDigest, acknowledged: true },
  );
}

test('the preview digest names the request of every eligible row', async () => {
  const page = capturePage();
  await mockApi(page, [device]);

  const first = await preview(page, notesFirst);
  assert.equal(first.status, 201);
  assert.equal(first.json.eligible, 1);
  assert.equal(first.json.changes.length, 1);

  const second = await preview(page, notesSecond);
  assert.equal(second.status, 201);
  assert.equal(second.json.eligible, 1);

  // Two eligible requests on one device must hash two different documents.
  assert.notEqual(first.json.manifestDigest, second.json.manifestDigest);
  // The old caller passed the change list as the target list, so both hashed no target.
  assert.notEqual(first.json.manifestDigest, emptyTargetDigest);
  assert.notEqual(second.json.manifestDigest, emptyTargetDigest);
});

test('the fixture refuses a digest of a superseded preview', async () => {
  const page = capturePage();
  await mockApi(page, [device]);

  const first = await preview(page, notesFirst);
  const second = await preview(page, notesSecond);

  const stale = await confirm(page, first.json.manifestDigest);
  assert.equal(stale.status, 409);
  assert.deepEqual(stale.json, { reason: 'preview-changed' });

  const current = await confirm(page, second.json.manifestDigest);
  assert.equal(current.status, 201);
  assert.equal(current.json.status, 'accepted');
  assert.equal(current.json.deviceCount, 1);
});

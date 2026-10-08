import assert from 'node:assert/strict';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertApplicationEvidence } from './application-evidence.mjs';
import { sha256 } from './integrity.mjs';
import { phase3ProtectedRoutes } from '../qualification/phase3-routes.mjs';
import { phase3BrowserEvidence } from './phase3-browser-evidence.mjs';

const requiredReports = [
  'packaged-integration.json',
  'phase3-route-security.json',
  'google-connection-api.json',
  'google-connection-browser.json',
  'google-connection-worker.json',
  'customer-settings.json',
  'google-health-api.json',
  'google-lifecycle-api.json',
  'invitations-browser.json',
  'platform-access-api.json',
  'platform-access-browser.json',
  'access-revocation-api.json',
  'access-revocation-browser.json',
  'school-references-api.json',
  'school-definitions-api.json',
];

/** Bind packaged Phase 3 reports to the completed scanner inventory. */
export async function inspectPhase3Evidence(
  directory,
  { sourceRevision, images },
) {
  const read = async (name) => {
    assert.match(name, /^[A-Za-z0-9_-]+\.(?:json|png)$/);
    const source = join(directory, name);
    const stat = await lstat(source);
    assert.ok(stat.isFile() && !stat.isSymbolicLink());
    assert.ok(stat.size <= 64 * 1024 * 1024);
    return readFile(source);
  };
  const scannerName = 'evidence-redaction.json';
  const scannerBytes = await read(scannerName);
  const scanner = JSON.parse(scannerBytes);
  assert.equal(scanner.schemaVersion, 1);
  assert.equal(scanner.status, 'passed');
  assert.equal(scanner.sourceRevision, sourceRevision);
  for (const category of [
    'service-account-key',
    'browser-cookie',
    'response-secret',
    'authorization-code',
    'provider-secret',
    'deployment-secret',
    'invitation-token',
    'redis-operator-password',
    'tls-private-key',
    'operator-credential',
    'operator-authorization',
    'authorization-state',
    'identity-nonce',
    'pkce-challenge',
    'identity-token',
    'pairing-code',
    'worker-dispatch',
    'service-authorization',
  ])
    assert.ok(
      Number.isInteger(scanner.secretCategories?.[category]) &&
        scanner.secretCategories[category] > 0,
    );
  for (const source of ['api', 'worker', 'kestra', 'audit', 'support'])
    assert.ok(scanner.scannedSources?.includes(source));
  assert.ok(
    Array.isArray(scanner.files) &&
      scanner.files.length > 0 &&
      scanner.files.length <= 10000,
  );
  const files = new Map();
  const reports = new Map();
  let screenshots = 0;
  for (const entry of scanner.files) {
    assert.notEqual(entry.name, scannerName);
    assert.ok(!files.has(entry.name));
    assert.match(entry.sha256, /^[a-f0-9]{64}$/);
    const bytes = await read(entry.name);
    assert.equal(sha256(bytes), entry.sha256);
    files.set(entry.name, { name: entry.name, sha256: entry.sha256 });
    if (entry.name.endsWith('.png')) screenshots++;
    else reports.set(entry.name, JSON.parse(bytes));
  }
  assert.ok(screenshots > 0);
  assert.equal(scanner.screenshotChecks, screenshots);
  for (const name of phase3BrowserEvidence) {
    assert.ok(files.has(name), `Phase 3 browser evidence requires ${name}.`);
    if (name.endsWith('-accessibility.json')) {
      const report = reports.get(name);
      assert.equal(report.name, name.replace('-accessibility.json', ''));
      assert.equal(report.engine?.name, 'axe-core');
      assert.deepEqual(report.violations, []);
      assert.ok(
        Array.isArray(report.passedRuleIds) && report.passedRuleIds.length > 0,
      );
      assert.ok(
        typeof report.accessibilityTree === 'string' &&
          report.accessibilityTree.length > 0,
      );
    }
  }
  for (const name of requiredReports) {
    const report = reports.get(name);
    assert.ok(report, `Phase 3 evidence requires ${name}.`);
    assert.ok(Array.isArray(report.checks) && report.checks.length > 0);
    if (report.status !== undefined) assert.equal(report.status, 'passed');
    if (report.sourceRevision !== undefined)
      assert.equal(report.sourceRevision, sourceRevision);
  }
  const primary = reports.get('packaged-integration.json');
  assert.equal(primary.phase, 3);
  assert.equal(primary.sourceRevision, sourceRevision);
  assertApplicationEvidence('auth-image-integration', primary, {
    sourceRevision,
    images,
  });
  const routes = reports.get('phase3-route-security.json');
  assert.equal(routes.schemaVersion, 1);
  assert.equal(routes.sourceRevision, sourceRevision);
  assert.equal(routes.routes, phase3ProtectedRoutes.length);
  const checks = new Map();
  for (const check of routes.checks) {
    const key = `${check.route}:${check.boundary}`;
    assert.ok(!checks.has(key));
    checks.set(key, check.status);
  }
  for (const [method, path] of phase3ProtectedRoutes) {
    const expected = [
      ['missing-session', [401]],
      ...(method === 'POST'
        ? [
            ['missing-csrf', [403]],
            ['wrong-origin', [403]],
            ['wrong-content-type', [403]],
            ['valid-browser-checks-invalid-input-or-action', [400, 403]],
          ]
        : []),
    ];
    for (const [boundary, statuses] of expected) {
      const key = `${method} ${path}:${boundary}`;
      assert.ok(statuses.includes(checks.get(key)));
      checks.delete(key);
    }
  }
  assert.equal(checks.size, 0);
  files.set(scannerName, { name: scannerName, sha256: sha256(scannerBytes) });
  return [...files.values()];
}

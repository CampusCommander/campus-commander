import assert from 'node:assert/strict';
import test from 'node:test';
import { describeHybridFailure } from './hybrid-evidence-fixture.mjs';

test('hybrid failure evidence excludes arbitrary exception data', () => {
  const secret = 'private-fixture-credential';
  for (const [detail, category] of [
    ['permission denied', 'permission-denied'],
    ['unauthorized', 'registry-authorization'],
    ['pull access denied', 'registry-authorization'],
    ['ENOENT', 'missing-resource'],
    ['x509 certificate rejected', 'tls-failure'],
    ['request timeout', 'timeout'],
    ['unexpected failure', 'unclassified'],
  ]) {
    const report = describeHybridFailure({
      code: 1,
      message: `docker exec ${secret}: ${detail}`,
      stderr: Buffer.from(secret),
      cause: new Error(secret),
    });
    assert.deepEqual(report, { category, exitCode: 1 });
    assert.equal(JSON.stringify(report).includes(secret), false);
  }
  assert.deepEqual(describeHybridFailure({ code: secret, message: secret }), {
    category: 'unclassified',
    exitCode: null,
  });
});

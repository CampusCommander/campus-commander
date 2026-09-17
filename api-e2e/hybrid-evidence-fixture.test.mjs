import assert from 'node:assert/strict';
import test from 'node:test';
import { stageRuntimeFiles } from '../deployment/profiles/all-docker/render.mjs';
import {
  describeHybridFailure,
  assertHybridKeyMount,
} from './hybrid-evidence-fixture.mjs';

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

test('hybrid key inspection accepts the delivered staged volume contract', () => {
  const compose = {
    services: {
      'runtime-files': { command: ['/bin/sh', '-ec', 'true'], volumes: [] },
      api: {
        secrets: [
          {
            source: 'google-qualification-key',
            target: 'google-qualification-key',
          },
        ],
      },
    },
    volumes: {},
    secrets: {
      'google-qualification-key': {
        file: './private/google-qualification-key',
      },
    },
  };
  stageRuntimeFiles(compose, { initializerName: 'runtime-files' });
  assert.deepEqual(compose.services.api.volumes, [
    'api-secrets:/run/secrets:ro',
  ]);
  const container = {
    Mounts: [
      {
        Type: 'volume',
        Name: 'fixture_api-secrets',
        Destination: '/run/secrets',
        RW: false,
      },
    ],
  };
  assertHybridKeyMount(container, {
    authorized: true,
    volumeName: 'fixture_api-secrets',
  });
  for (const changed of [
    { RW: true },
    { Name: 'unrelated-volume' },
    { Type: 'bind' },
    { Destination: '/unexpected' },
  ]) {
    assert.throws(() =>
      assertHybridKeyMount(
        { Mounts: [{ ...container.Mounts[0], ...changed }] },
        { authorized: true, volumeName: 'fixture_api-secrets' },
      ),
    );
  }
  assert.throws(() =>
    assertHybridKeyMount(container, {
      authorized: false,
      volumeName: 'fixture_api-secrets',
    }),
  );
  assertHybridKeyMount(
    { Mounts: [] },
    { authorized: false, volumeName: 'fixture_api-secrets' },
  );
});

test('hybrid evidence exposes only fixed operator reasons through bounded cleanup errors', () => {
  const privateMarker = 'private-credential-marker';
  const error = new Error(privateMarker);
  error.stderr = `Private detail: ${privateMarker}\nReason: FILESYSTEM_PATH_MISSING.\n`;
  const report = describeHybridFailure(
    new AggregateError([error], 'Restore failed.'),
  );
  assert.equal(report.operatorReason, 'FILESYSTEM_PATH_MISSING');
  assert.equal(JSON.stringify(report).includes(privateMarker), false);
  error.stderr = 'Reason: PRIVATE_CREDENTIAL_MARKER.';
  assert.equal(describeHybridFailure(error).operatorReason, undefined);
  error.stderr = 'Reason: FILESYSTEM_PATH_MISSING. private-credential-marker';
  assert.equal(describeHybridFailure(error).operatorReason, undefined);
  error.cause = error;
  assert.equal(describeHybridFailure(error).operatorReason, undefined);
});

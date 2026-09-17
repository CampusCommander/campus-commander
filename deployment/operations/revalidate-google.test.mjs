import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { revalidateRestoredGoogle } from './revalidate-google.mjs';

const config = JSON.parse(
  await readFile(
    new URL('../examples/all-docker.json', import.meta.url),
    'utf8',
  ),
);

test('revalidation rejects missing, linked, public, or mismatched restore evidence before database access', async () => {
  const root = await mkdtemp('/tmp/cc-revalidation-');
  const marker = join(root, 'RESTORE_DISABLED');
  const saved = join(root, 'target-configuration.json');
  const report = join(root, 'restore-report.json');
  const options = {
    targetDirectory: root,
    targetConfig: config,
    resolveSecret() {
      assert.fail('Invalid evidence must not resolve database credentials.');
    },
  };
  try {
    await assert.rejects(revalidateRestoredGoogle(options), { code: 'ENOENT' });
    await writeFile(saved, JSON.stringify(config), { mode: 0o600 });
    await symlink(saved, marker);
    await assert.rejects(revalidateRestoredGoogle(options), { code: 'ELOOP' });
    await rm(marker);
    await writeFile(marker, 'Keep services stopped.\n', { mode: 0o644 });
    await assert.rejects(
      revalidateRestoredGoogle(options),
      /target evidence is invalid/,
    );
    await chmod(marker, 0o600);
    const evidence = {
      schemaVersion: 1,
      profile: config.profile,
      status: 'verified-services-disabled',
      accessRecovery: {
        googleConnection: {
          status: 'revalidation-required',
          recoveryId: 'b6e73539-c84e-4f37-88cc-098f2bc6a0ae',
        },
      },
    };
    await writeFile(report, JSON.stringify(evidence), { mode: 0o600 });
    await writeFile(
      saved,
      JSON.stringify({
        ...config,
        services: {
          ...config.services,
          applicationDatabase: {
            ...config.services.applicationDatabase,
            database: 'different-target',
          },
        },
      }),
    );
    await assert.rejects(
      revalidateRestoredGoogle(options),
      /target evidence is invalid/,
    );
    await writeFile(saved, JSON.stringify(config));
    await assert.rejects(
      revalidateRestoredGoogle({
        ...options,
        applicationCredentials: { database: 'other-database' },
      }),
      /must not change the target database/,
    );
    await writeFile(
      report,
      JSON.stringify({ ...evidence, status: 'incomplete' }),
    );
    await assert.rejects(
      revalidateRestoredGoogle(options),
      /target evidence is invalid/,
    );
    assert.equal(await readFile(marker, 'utf8'), 'Keep services stopped.\n');
    await assert.rejects(readFile(join(root, 'google-revalidation.json')), {
      code: 'ENOENT',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the revalidation CLI reports fixed failures without private configuration or path details', async () => {
  const root = await mkdtemp('/tmp/cc-revalidation-cli-');
  try {
    const configurationPath = join(root, 'config.json');
    const input = join(root, 'operator.json');
    await writeFile(configurationPath, JSON.stringify(config), { mode: 0o600 });
    await writeFile(
      input,
      JSON.stringify({
        configurationPath,
        targetDirectory: root,
        privateMarker: 'PRIVATE-RESTORE-FIXTURE',
      }),
      { mode: 0o600 },
    );
    await assert.rejects(
      promisify(execFile)(process.execPath, [
        'deployment/operations/cli.mjs',
        'revalidate-google',
        input,
      ]),
      (error) => {
        assert.equal(error.code, 1);
        assert.equal(error.stdout, '');
        assert.match(error.stderr, /Reason: FILESYSTEM_PATH_MISSING\./);
        assert.ok(!error.stderr.includes(root));
        assert.ok(!error.stderr.includes('PRIVATE-RESTORE-FIXTURE'));
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

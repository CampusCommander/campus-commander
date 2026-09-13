import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  updateInstallation,
  pendingUpdate,
  updateOperator,
} from './maintenance.mjs';
import { createQuestions } from './setup.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
async function fixture(t, profile = 'all-docker') {
  const root = await mkdtemp(join(tmpdir(), 'cc-update-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const save = async (path, value) =>
    writeFile(path, JSON.stringify(value), { mode: 0o600 });
  const load = async (path) => JSON.parse(await readFile(path, 'utf8'));
  const releaseRoot = join(root, 'new-release');
  const backupDirectory = join(root, 'backup');
  await mkdir(releaseRoot);
  await mkdir(backupDirectory);
  const config = JSON.parse(
    await readFile(new URL(`../examples/${profile}.json`, import.meta.url)),
  );
  const original = { sourceRevision: 'a'.repeat(40), images: config.images };
  const target = {
    ...original,
    sourceRevision: 'b'.repeat(40),
    images: {
      ...config.images,
      api: 'registry.example.org/api@sha256:' + 'c'.repeat(64),
    },
  };
  const operator = {
    installationRoot: root,
    configurationPath: join(root, 'deployment.json'),
    releasePath: join(root, 'old-release.json'),
    releaseRoot: root,
    project: 'cc-test',
  };
  await save(operator.configurationPath, config);
  await save(join(root, 'operator.json'), operator);
  await save(operator.releasePath, original);
  await save(join(releaseRoot, 'release-manifest.json'), target);
  const oldHash = sha(await readFile(operator.releasePath));
  const targetHash = sha(
    await readFile(join(releaseRoot, 'release-manifest.json')),
  );
  await save(join(root, 'installer-state.json'), {
    phase: 'ready',
    releaseHash: oldHash,
  });
  const backup = {
    profile,
    release: original,
    keyRecovery: {
      id: 'backup',
      version: 1,
      reference: { provider: 'file', path: '/run/secrets/backup-key' },
    },
  };
  await save(join(backupDirectory, 'manifest.json'), backup);
  const calls = [],
    output = [];
  const options = {
    root,
    releaseRoot,
    config,
    operator,
    qualification: true,
    q: createQuestions({
      'update.backupDirectory': backupDirectory,
      confirmUpdate: 'update',
      ...(profile === 'hybrid' ? { workersReady: 'yes' } : {}),
    }),
    output: (line) => output.push(line),
    verify: async () => backup,
    installer: async (input) => {
      calls.push(input);
      await save(join(root, 'installer-state.json'), {
        phase: input.command === 'upgrade' ? 'prepared' : 'ready',
        releaseHash: targetHash,
      });
      return { status: input.command === 'upgrade' ? 'prepared' : 'ready' };
    },
  };
  return {
    root,
    save,
    load,
    oldHash,
    targetHash,
    target,
    calls,
    options,
    output,
  };
}

for (const profile of ['all-docker', 'hybrid', 'kubernetes'])
  test(`guided ${profile} update preserves configuration and uses backup-gated preparation`, async (t) => {
    const f = await fixture(t, profile);
    assert.equal((await updateInstallation(f.options)).status, 'ready');
    assert.deepEqual(
      f.calls.map(({ command, prepareOnly }) => [command, prepareOnly]),
      [
        ['upgrade', true],
        ['resume', undefined],
      ],
    );
    const after = await f.load(join(f.root, 'deployment.json'));
    assert.deepEqual(after, { ...f.options.config, images: f.target.images });
    const operator = await f.load(join(f.root, 'operator.json'));
    assert.equal(operator.configurationPath, join(f.root, 'deployment.json'));
    assert.equal(operator.upgradeFromReleaseHash, f.oldHash);
    assert.equal(await pendingUpdate(f.root), undefined);
  });

test('cancel and invalid backup leave installed configuration untouched', async (t) => {
  for (const failure of ['cancel', 'backup']) {
    const f = await fixture(t);
    if (failure === 'cancel')
      f.options.q = createQuestions({
        'update.backupDirectory': join(f.root, 'backup'),
        confirmUpdate: 'cancel',
      });
    else
      f.options.verify = () => {
        throw new Error('Backup authentication failed');
      };
    if (failure === 'cancel')
      assert.equal((await updateInstallation(f.options)).status, 'cancelled');
    else await assert.rejects(updateInstallation(f.options));
    assert.equal(f.calls.length, 0);
    assert.deepEqual(
      await f.load(join(f.root, 'deployment.json')),
      f.options.config,
    );
    assert.equal(await pendingUpdate(f.root), undefined);
  }
});

test('resume retries preparation before admission and uses resume after admission', async (t) => {
  for (const admitted of [false, true]) {
    const f = await fixture(t);
    const installer = f.options.installer;
    f.options.installer = async (input) => {
      if (admitted) await installer(input);
      throw new Error('Interrupted update');
    };
    await assert.rejects(updateInstallation(f.options));
    const journal = await pendingUpdate(f.root);
    assert.equal(
      (await updateOperator(f.root, journal)).releasePath,
      admitted
        ? journal.targetOperator.releasePath
        : f.options.operator.releasePath,
    );
    f.calls.length = 0;
    f.options.installer = installer;
    f.options.q = createQuestions();
    assert.equal((await updateInstallation(f.options)).status, 'ready');
    assert.equal(f.calls[0].command, admitted ? 'resume' : 'upgrade');
  }
});

test('resume completes interrupted configuration publication without repeating the upgrade', async (t) => {
  const f = await fixture(t);
  f.options.publish = async (path, value) => {
    if (path.endsWith('/operator.json')) throw new Error('Disk full');
    await f.save(path, value);
  };
  await assert.rejects(updateInstallation(f.options), /Disk full/);
  f.options.publish = undefined;
  f.options.q = createQuestions();
  f.options.installer = () =>
    assert.fail('The update already reached readiness.');
  assert.equal((await updateInstallation(f.options)).status, 'ready');
  assert.equal(await pendingUpdate(f.root), undefined);
});

test('hybrid update pauses for remote workers and resumes the fixed target', async (t) => {
  const f = await fixture(t, 'hybrid');
  f.options.q = createQuestions({
    'update.backupDirectory': join(f.root, 'backup'),
    confirmUpdate: 'update',
    workersReady: 'no',
  });
  assert.equal(
    (await updateInstallation(f.options)).status,
    'prepared-workers-pending',
  );
  assert.deepEqual(
    f.calls.map((call) => call.command),
    ['upgrade'],
  );
  f.options.q = createQuestions({ workersReady: 'yes' });
  assert.equal((await updateInstallation(f.options)).status, 'ready');
});

test('resume rejects changed staged configuration before changing services', async (t) => {
  const f = await fixture(t);
  f.options.installer = async () => {
    throw new Error('Interrupted update');
  };
  await assert.rejects(updateInstallation(f.options), /Interrupted update/);
  const journal = await pendingUpdate(f.root);
  await f.save(journal.targetOperator.configurationPath, f.options.config);
  f.options.q = createQuestions();
  f.options.installer = () => assert.fail('Do not change services.');
  await assert.rejects(
    updateInstallation(f.options),
    /staged configuration changed/,
  );
  assert.deepEqual(
    await f.load(join(f.root, 'operator.json')),
    f.options.operator,
  );
});

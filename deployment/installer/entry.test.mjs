import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const script = resolve('install.sh');
const revision = 'a'.repeat(40);
const tag = `phase-1-candidate-${revision.slice(0, 12)}`;
async function fixture(
  t,
  {
    link = false,
    tamper = false,
    phase = 1,
    wrongPhase = false,
    qualified = false,
    wrongQualification = false,
  } = {},
) {
  const candidate = `phase-${phase}-${qualified ? 'qualified' : 'candidate'}`;
  const tag = `${candidate}-${revision.slice(0, 12)}`;
  const root = await mkdtemp(join(tmpdir(), 'cc-entry-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundle = join(root, 'bundle'),
    assets = join(root, 'assets'),
    bin = join(root, 'bin');
  await Promise.all([bundle, assets, bin].map((p) => mkdir(p)));
  await mkdir(join(bundle, 'deployment/installer'), { recursive: true });
  const content = {
    'LICENSE.md': 'Test license.\n',
    'deployment/installer/setup.mjs': 'require-not-supported\n',
    'deployment/installer/platforms.mjs': await readFile(
      resolve('deployment/installer/platforms.mjs'),
      'utf8',
    ),
  };
  content['deployment/installer/setup.mjs'] =
    'import fs from "node:fs";fs.writeFileSync(process.env.CC_ENTRY_EXECUTED,JSON.stringify(process.argv.slice(2)));\n';
  const manifest = {
    schemaVersion: 1,
    ...(phase === 2 ? { phase: wrongPhase ? 1 : 2 } : {}),
    ...(qualified
      ? {
          qualification: wrongQualification
            ? 'candidate-only'
            : 'profile-qualified',
          districtInfrastructureAcceptance: 'not-qualified',
        }
      : {}),
    sourceRevision: revision,
    architectures: ['linux/amd64'],
    images: Object.fromEntries(
      [
        ['frontend', 'frontend'],
        ['api', 'api'],
        ['workers', 'worker'],
      ].map(([key, name]) => [
        key,
        `ghcr.io/campuscommander/campus-commander-${name}@sha256:${'b'.repeat(64)}`,
      ]),
    ),
    files: Object.entries(content).map(([path, bytes]) => ({
      path,
      sizeBytes: Buffer.byteLength(bytes),
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })),
  };
  for (const [path, bytes] of Object.entries(content))
    await writeFile(join(bundle, path), bytes);
  const manifestBytes = JSON.stringify(manifest);
  await writeFile(join(bundle, 'release-manifest.json'), manifestBytes);
  if (link) await symlink('/tmp', join(bundle, 'unsafe-link'));
  assert.equal(
    spawnSync('tar', [
      '-czf',
      join(assets, `${candidate}.tar.gz`),
      '-C',
      bundle,
      '.',
    ]).status,
    0,
  );
  await writeFile(
    join(assets, 'release-manifest.json'),
    tamper ? manifestBytes + ' ' : manifestBytes,
  );
  for (const name of [
    `${candidate}.sigstore.json`,
    'release-manifest.sigstore.json',
  ])
    await writeFile(join(assets, name), '{}');
  await writeFile(
    join(bin, 'curl'),
    `#!/usr/bin/env node
const fs=require('fs'),path=require('path');const args=process.argv.slice(2);const url=args.find(x=>x.startsWith('https://'));const out=args[args.indexOf('--output')+1];
fs.appendFileSync(process.env.CC_ENTRY_TRACE,'download '+url+'\\n');
if(url.includes('/releases?'))fs.writeFileSync(out,JSON.stringify([{tag_name:'${tag}',draft:false,published_at:'2026-09-08T00:00:00Z'}]));
else fs.copyFileSync(path.join(process.env.CC_ENTRY_ASSETS,url.split('/').at(-1)),out);
`,
    { mode: 0o700 },
  );
  await writeFile(
    join(bin, 'cosign'),
    `#!/usr/bin/env node
const fs=require('fs'),a=process.argv.slice(2);
if(a[0]==='version'){console.log(JSON.stringify({gitVersion:'v3.1.3'}));process.exit(0);}
fs.appendFileSync(process.env.CC_ENTRY_TRACE,'cosign '+JSON.stringify(a)+'\\n');
if(process.env.CC_ENTRY_FAIL===a[0] || (process.env.CC_ENTRY_FAIL==='manifest' && a.at(-1).endsWith('/release-manifest.json')))process.exit(1);
`,
    { mode: 0o700 },
  );
  await writeFile(
    join(bin, 'docker'),
    '#!/bin/sh\nif [ "$1" = compose ]; then printf "5.5.1\\n"; else printf "29.8.0\\n"; fi\n',
    { mode: 0o700 },
  );
  const answers = join(root, 'answers.json');
  await writeFile(answers, '{}', { mode: 0o600 });
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    CC_ENTRY_ASSETS: assets,
    CC_ENTRY_TRACE: join(root, 'trace'),
    CC_ENTRY_EXECUTED: join(root, 'executed'),
  };
  const run = (args = [], extra = {}) =>
    spawnSync('sh', [script, '--cache-dir', join(root, 'cache'), ...args], {
      env: { ...env, ...extra },
      encoding: 'utf8',
      timeout: 30000,
    });
  const trace = () => readFile(env.CC_ENTRY_TRACE, 'utf8').catch(() => '');
  const executed = () =>
    readFile(env.CC_ENTRY_EXECUTED, 'utf8').catch(() => null);
  return { root, run, trace, executed, answers };
}

test('entry verifies both blobs and three images without executing during verify-only', async (t) => {
  const f = await fixture(t);
  const r = f.run(['--verify-only']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(await f.executed(), null);
  const trace = await f.trace();
  assert.equal((trace.match(/cosign \["verify-blob"/g) || []).length, 2);
  assert.equal((trace.match(/cosign \["verify"/g) || []).length, 3);
  assert.match(
    trace,
    /candidate-images.yml@refs\/heads\/implementation\/cc-5-through-cc-20/,
  );
});
test('Phase 2 entry binds the manifest and every signature to the fixed Phase 2 publisher', async (t) => {
  const f = await fixture(t, { phase: 2 });
  const result = f.run(['--verify-only']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await f.executed(), null);
  const trace = await f.trace();
  assert.match(
    trace,
    /phase-2-candidate\.yml@refs\/heads\/implementation\/phase-2-cc-22/,
  );
  assert.equal((trace.match(/cosign \["verify-blob"/g) || []).length, 2);
  assert.equal((trace.match(/cosign \["verify"/g) || []).length, 3);
});
test('Phase 2 entry rejects a manifest for a different phase', async (t) => {
  const f = await fixture(t, { phase: 2, wrongPhase: true });
  assert.notEqual(f.run(['--verify-only']).status, 0);
  assert.equal(await f.executed(), null);
});
test('Phase 2 profile-qualified entry selects matching assets and the fixed publisher', async (t) => {
  const f = await fixture(t, { phase: 2, qualified: true });
  for (const args of [
    ['--verify-only'],
    [
      '--verify-only',
      '--release',
      `phase-2-qualified-${revision.slice(0, 12)}`,
    ],
  ]) {
    const result = f.run(args);
    assert.equal(result.status, 0, result.stderr);
  }
  assert.equal(await f.executed(), null);
  const trace = await f.trace();
  assert.match(trace, /phase-2-qualified\.tar\.gz/);
  assert.doesNotMatch(trace, /phase-1-candidate|candidate-images\.yml/);
  assert.equal((trace.match(/cosign \["verify-blob"/g) || []).length, 4);
  assert.equal((trace.match(/cosign \["verify"/g) || []).length, 6);
  assert.match(
    trace,
    /phase-2-candidate\.yml@refs\/heads\/implementation\/phase-2-cc-22/,
  );
});
test('Phase 2 profile-qualified tag rejects candidate-only manifest claims', async (t) => {
  const f = await fixture(t, {
    phase: 2,
    qualified: true,
    wrongQualification: true,
  });
  const result = f.run(['--verify-only']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Release identity differs/);
  assert.equal(await f.executed(), null);
});
for (const failure of ['verify-blob', 'manifest', 'verify']) {
  test(`entry fails closed on ${failure} signature failure`, async (t) => {
    const f = await fixture(t);
    const r = f.run(['--verify-only'], { CC_ENTRY_FAIL: failure });
    assert.notEqual(r.status, 0);
    assert.equal(await f.executed(), null);
    assert.match(r.stderr, /signature verification failed/i);
    if (failure !== 'verify')
      assert.doesNotMatch(await f.trace(), /cosign \["verify"/);
  });
}
test('entry rejects mismatched archive and external manifest', async (t) => {
  const f = await fixture(t, { tamper: true });
  const r = f.run(['--verify-only']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /manifests differ/);
  assert.equal(await f.executed(), null);
});
test('entry rejects archive symlinks before extraction', async (t) => {
  const f = await fixture(t, { link: true });
  const r = f.run(['--verify-only']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unsafe paths or links/);
  assert.equal(await f.executed(), null);
});
test('entry forwards paths literally after verification', async (t) => {
  const f = await fixture(t);
  const literal = join(f.root, 'install;$(touch injected)');
  const r = f.run([
    '--release',
    tag,
    '--profile',
    'all-docker',
    '--root',
    literal,
    '--answers',
    f.answers,
    '--accept-license',
    '--qualification',
  ]);
  assert.equal(r.status, 0, r.stderr);
  const args = JSON.parse(await f.executed());
  assert.equal(args[args.indexOf('--root') + 1], literal);
  assert.equal(args[args.indexOf('--answers') + 1], f.answers);
  assert.ok(args.includes('--qualification'));
});
test('entry rejects invalid release tags before downloading', async (t) => {
  const f = await fixture(t);
  const r = f.run(['--release', '../other;echo injected']);
  assert.notEqual(r.status, 0);
  assert.equal(await f.trace(), '');
});
test('entry refuses a symlink download directory', async (t) => {
  const f = await fixture(t);
  await symlink(join(f.root, 'assets'), join(f.root, 'cache'));
  const r = f.run(['--verify-only']);
  assert.notEqual(r.status, 0);
  assert.equal(await f.trace(), '');
});

for (const variant of [
  { phase: 1 },
  { phase: 2 },
  { phase: 2, qualified: true },
]) {
  test(`entry reuses original assets for status: ${JSON.stringify(variant)}`, async (t) => {
    const f = await fixture(t, variant);
    const tag = `phase-${variant.phase}-${variant.qualified ? 'qualified' : 'candidate'}-${revision.slice(0, 12)}`;
    const root = join(f.root, 'installation');
    const first = f.run([
      '--release',
      tag,
      '--profile',
      'all-docker',
      '--root',
      root,
      '--answers',
      f.answers,
      '--accept-license',
    ]);
    assert.equal(first.status, 0, first.stderr);
    const args = JSON.parse(await f.executed());
    const releaseRoot = args[args.indexOf('--release-root') + 1];
    await mkdir(root, { mode: 0o700 });
    await writeFile(
      join(root, 'deployment.json'),
      JSON.stringify({ profile: 'all-docker' }),
      { mode: 0o600 },
    );
    await writeFile(
      join(root, 'operator.json'),
      JSON.stringify({
        installationRoot: root,
        configurationPath: join(root, 'deployment.json'),
        releaseRoot,
      }),
      { mode: 0o600 },
    );
    const before = (await f.trace())
      .split('\n')
      .filter((x) => x.startsWith('download'));
    const second = f.run([
      '--profile',
      'all-docker',
      '--root',
      root,
      '--answers',
      f.answers,
      '--accept-license',
      '--command',
      'status',
    ]);
    assert.equal(second.status, 0, second.stderr);
    const after = (await f.trace())
      .split('\n')
      .filter((x) => x.startsWith('download'));
    assert.deepEqual(after, before);
    assert.match(second.stderr, /Using the original verified release/);
    const switched = f.run([
      '--release',
      `phase-1-candidate-${'c'.repeat(12)}`,
      '--profile',
      'all-docker',
      '--root',
      root,
      '--answers',
      f.answers,
      '--accept-license',
    ]);
    assert.notEqual(switched.status, 0);
    assert.match(switched.stderr, /documented upgrade procedure/);
  });
}

import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  applicationReports,
  assertApplicationEvidence,
} from './application-evidence.mjs';
import {
  bundleTargets,
  inspectBundleQualification,
} from './bundle-qualification.mjs';
import {
  sha256,
  verifyReleaseEvidence,
  verifyReleaseFiles,
} from './integrity.mjs';
import { loadQualificationBundle } from './qualification.mjs';

export const profileWorkflows = {
  'all-docker': {
    install: 'all-docker-integration',
    resume: 'all-docker-integration',
    upgrade: 'upgrade-integration',
    restore: 'restore-integration',
    faults: 'all-docker-process-fault-integration',
  },
  hybrid: {
    install: 'hybrid-cli-integration',
    resume: 'hybrid-cli-integration',
    upgrade: 'hybrid-cli-upgrade-integration',
    restore: 'hybrid-restore-integration',
    faults: 'hybrid-cli-process-fault-integration',
  },
  kubernetes: {
    install: 'kubernetes-integration',
    resume: 'kubernetes-integration',
    upgrade: 'kubernetes-upgrade-integration',
    restore: 'kubernetes-restore-integration',
    faults: 'kubernetes-process-fault-integration',
  },
};

function verifyWorkflowCheck(profile, check, report) {
  if (check === 'install' || check === 'resume') {
    const commands =
      profile === 'hybrid' ? report.commands : report.installer?.commands;
    assert.ok(Array.isArray(commands));
    const names = commands.map((item) =>
      typeof item === 'string' ? item : item.command,
    );
    assert.ok(names.includes('prepare'));
    assert.ok(names.includes('resume'));
    if (check === 'resume') {
      assert.ok(names.filter((name) => name === 'resume').length >= 2);
      assert.ok(names.includes('stop') && names.includes('uninstall'));
    }
    for (const command of commands) {
      if (typeof command === 'object')
        assert.equal(
          command.status,
          { prepare: 'prepared', stop: 'stopped', uninstall: 'uninstalled' }[
            command.command
          ] ?? 'ready',
        );
    }
  }
  if (check === 'upgrade' && profile === 'all-docker') {
    assert.ok(
      report.checks.includes('encrypted backup verified before upgrade'),
    );
    assert.ok(
      report.checks.includes(
        'different image digests upgrade with artifact and ledger preservation',
      ),
    );
    assert.equal(report.releaseInventories.length, 2);
    assert.notDeepEqual(
      report.releaseInventories[0].images,
      report.releaseInventories[1].images,
    );
  }
  if (check === 'restore') {
    assert.equal(
      profile === 'hybrid'
        ? report.application.oldSessionRejected
        : report.oldSessionRejected,
      true,
    );
    if (profile === 'all-docker') {
      assert.ok(
        report.preserved.principals > 0 && report.preserved.securityEvents > 0,
      );
      assert.match(report.preserved.artifactSha256, /^[a-f0-9]{64}$/);
    } else {
      const state =
        profile === 'hybrid'
          ? report.verification.application
          : report.applicationState;
      assert.equal(state.exactIdentityAndPreferences, true);
      assert.equal(state.exactSecurityEvents, true);
      assert.ok(state.principals > 0 && state.securityEvents > 0);
    }
  }
}

/** Assemble profile-qualified evidence after independent candidate signature verification. */
export async function assembleQualifiedRelease({
  candidateRoot,
  qualifications,
  output,
  sourceRevision,
}) {
  const candidatePath = resolve(candidateRoot);
  const evidenceRoot = resolve(qualifications);
  const destination = resolve(output);
  for (const input of [candidatePath, evidenceRoot])
    assert.ok(
      destination !== input &&
        !destination.startsWith(input + sep) &&
        !input.startsWith(destination + sep),
    );
  const candidateBytes = await readFile(
    join(candidatePath, 'release-manifest.json'),
  );
  const candidateInput = JSON.parse(candidateBytes);
  const { manifest: candidate, manifestSha256 } = await loadQualificationBundle(
    candidatePath,
    {
      sourceRevision,
      images: candidateInput.images,
    },
  );
  assert.equal(manifestSha256, sha256(candidateBytes));
  assert.equal(candidate.qualification, 'candidate-only');
  const images = candidate.images;
  const inventory = new Map(candidate.files.map((file) => [file.path, file]));
  const candidateReports = new Map();
  for (const [target, filename] of Object.entries(applicationReports)) {
    const reference = candidate.applicationEvidence?.[target];
    assert.equal(reference?.reportPath, `qualification/${target}/${filename}`);
    assert.equal(
      reference.reportSha256,
      inventory.get(reference.reportPath)?.sha256,
    );
    const report = JSON.parse(
      await readFile(join(candidatePath, reference.reportPath)),
    );
    assertApplicationEvidence(target, report, { sourceRevision, images });
    candidateReports.set(target, reference);
  }
  const records = new Map();
  for (const target of bundleTargets) {
    const root = join(evidenceRoot, `bundle-qualification-${target}`);
    const contextBytes = await readFile(
      join(root, 'bundle-qualification.json'),
    );
    assert.ok(contextBytes.length <= 1024 * 1024);
    const context = JSON.parse(contextBytes);
    assert.ok(
      Array.isArray(context.reports) &&
        context.reports.length > 0 &&
        context.reports.length <= 4,
    );
    await verifyReleaseFiles(root, { files: context.reports });
    const expected = await inspectBundleQualification({
      reportRoot: root,
      target,
      sourceRevision,
      images,
      bundleManifestSha256: manifestSha256,
    });
    assert.deepEqual(context, expected);
    const primary = JSON.parse(
      await readFile(join(root, applicationReports[target])),
    );
    records.set(target, { root, context, contextBytes, primary });
  }
  const workerHosts = {};
  for (const [profile, mapping] of Object.entries(profileWorkflows)) {
    for (const [check, target] of Object.entries(mapping))
      verifyWorkflowCheck(profile, check, records.get(target).primary);
    if (profile !== 'all-docker') {
      const report = records.get(mapping.install).primary;
      const hosts =
        profile === 'hybrid'
          ? report.hosts
              .filter((host) => host.role.startsWith('worker-'))
              .map((host) => host.daemonId)
          : report.installer.workerHosts;
      assert.ok(
        Array.isArray(hosts) &&
          hosts.length >= 2 &&
          hosts.every((host) => typeof host === 'string' && host.length > 0),
      );
      assert.equal(new Set(hosts).size, hosts.length);
      workerHosts[profile] = hosts;
    }
  }
  await mkdir(destination, { recursive: false, mode: 0o700 });
  const readExpected = async (root, file) => {
    const bytes = await readFile(join(root, file.path));
    assert.equal(bytes.length, file.sizeBytes);
    assert.equal(sha256(bytes), file.sha256);
    return bytes;
  };
  const files = [];
  const paths = new Set();
  const add = async (path, bytes) => {
    assert.ok(!paths.has(path));
    paths.add(path);
    await mkdir(dirname(join(destination, path)), { recursive: true });
    await writeFile(join(destination, path), bytes, { flag: 'wx' });
    const file = { path, sizeBytes: bytes.length, sha256: sha256(bytes) };
    files.push(file);
    return { path, sha256: file.sha256 };
  };
  for (const file of candidate.files) {
    const from = join(candidatePath, file.path);
    await add(file.path, await readExpected(candidatePath, file));
    await chmod(join(destination, file.path), (await stat(from)).mode & 0o777);
  }
  const candidateReference = await add(
    'provenance/candidate-manifest.json',
    candidateBytes,
  );
  const references = new Map();
  for (const [target, record] of records) {
    const prefix = `bundle-qualification/${target}`;
    const refs = [
      await add(`${prefix}/bundle-qualification.json`, record.contextBytes),
    ];
    for (const file of record.context.reports)
      refs.push(
        await add(
          `${prefix}/${file.path}`,
          await readExpected(record.root, file),
        ),
      );
    references.set(target, refs);
  }
  const evidence = {};
  for (const [profile, mapping] of Object.entries(profileWorkflows)) {
    evidence[profile] = workerHosts[profile]
      ? { workerHosts: workerHosts[profile] }
      : {};
    for (const [check, target] of Object.entries(mapping)) {
      const supportingEvidence = [...references.get(target)];
      if (check === 'faults') {
        for (const suffix of ['capacity', 'certificate']) {
          const supportingTarget = `${profile === 'hybrid' ? 'hybrid-cli' : profile}-${suffix}-integration`;
          const reference = candidateReports.get(supportingTarget);
          supportingEvidence.push({
            path: reference.reportPath,
            sha256: reference.reportSha256,
          });
        }
      }
      const report = {
        schemaVersion: 1,
        status: 'passed',
        profile,
        check,
        sourceRevision,
        images,
        workflowTarget: target,
        bundleManifestSha256: manifestSha256,
        evidence: supportingEvidence,
        limits: [
          'Synthetic profile qualification does not establish district infrastructure acceptance.',
        ],
      };
      const reference = await add(
        `release-evidence/${profile}/${check}.json`,
        Buffer.from(JSON.stringify(report, null, 2) + '\n'),
      );
      evidence[profile][check] = {
        status: 'passed',
        sourceRevision,
        images,
        reportPath: reference.path,
        reportSha256: reference.sha256,
      };
    }
  }
  const manifest = {
    ...candidate,
    qualification: 'profile-qualified',
    candidateManifest: candidateReference,
    districtInfrastructureAcceptance: 'not-qualified',
    evidence,
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    limits: [
      'Qualification uses synthetic identity-provider credentials and browser trust.',
      'Docker daemons and Kind nodes share one physical host.',
      'Kind does not enforce NetworkPolicy or qualify district storage.',
      'District infrastructure and Phase 1 acceptance require separate records.',
    ],
  };
  await verifyReleaseEvidence(destination, manifest);
  await verifyReleaseFiles(destination, manifest);
  await writeFile(
    join(destination, 'release-manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    { flag: 'wx' },
  );
  await writeFile(
    join(destination, 'SHA256SUMS'),
    manifest.files.map((file) => `${file.sha256}  ${file.path}`).join('\n') +
      '\n',
    { flag: 'wx' },
  );
  return manifest;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [candidateRoot, qualifications, output, sourceRevision] =
    process.argv.slice(2);
  const result = await assembleQualifiedRelease({
    candidateRoot,
    qualifications,
    output,
    sourceRevision,
  });
  console.log(
    JSON.stringify({
      qualification: result.qualification,
      sourceRevision: result.sourceRevision,
      profileChecks: 15,
      districtInfrastructureAcceptance: result.districtInfrastructureAcceptance,
    }),
  );
}

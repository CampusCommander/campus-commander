import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAllDockerDurableProbe } from './all-docker-faults-fixture.mjs';

/** Track durable state through installer commands and erase only the owned installation. */
export async function createInstalledLifecycleProof({
  root,
  project,
  config,
  release,
  compose,
  id,
  cli,
  operatorPath,
  evidenceDirectory,
  evidenceIdentity,
  installerInvocations,
}) {
  const startedAt = Date.now();
  const docker = (...args) =>
    execFileSync('docker', args, {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 60000,
    }).trim();
  const report = {
    ...evidenceIdentity,
    schemaVersion: 1,
    phase: 3,
    profile: 'all-docker',
    sourceRevision: release.sourceRevision,
    images: release.images,
    recordedAt: new Date().toISOString(),
    status: 'in-progress',
    stages: [],
    limits: [
      'The fixture uses synthetic Google and application sign-in providers.',
      'Erasure removes owned Docker volumes. The existing contract retains operator files.',
      'A different-release guided update requires separate evidence.',
    ],
  };
  const save = async () => {
    report.durationMs = Date.now() - startedAt;
    report.durationScope =
      'Durable-state setup, restart, stop, uninstall, resume, and explicit erasure qualification.';
    await writeFile(
      join(evidenceDirectory, 'all-docker-lifecycle.json'),
      JSON.stringify(report, null, 2) + '\n',
      { mode: 0o600 },
    );
  };
  await save();
  let verifyDurable;
  try {
    assert.equal(config.phase, 3);
    verifyDurable = await createAllDockerDurableProbe({
      root,
      project,
      config,
      release,
      compose,
      id,
    });
  } catch (error) {
    report.status = 'failed';
    await save();
    throw error;
  }
  return {
    async verify(stage) {
      assert.ok(['restart', 'stop-resume', 'uninstall-resume'].includes(stage));
      try {
        report.stages.push({
          stage,
          status: 'passed',
          durableState: verifyDurable(),
        });
        await save();
      } catch (error) {
        report.status = 'failed';
        await save();
        throw error;
      }
    },
    async erase() {
      const controlVolume = `${project}_erasure-control`;
      let controlCreated = false;
      const removeControl = () => {
        if (!controlCreated) return;
        const control = JSON.parse(
          docker('volume', 'inspect', controlVolume),
        )[0];
        assert.equal(
          control.Labels['campus-commander.qualification-owner'],
          project,
        );
        docker('volume', 'rm', controlVolume);
        controlCreated = false;
      };
      const marker = 'CC57 unrelated volume: École 学校';
      const controlHash = (write = false) =>
        docker(
          'run',
          '--rm',
          '--network',
          'none',
          '--user',
          write ? '0:0' : '1000:1000',
          '--entrypoint',
          'node',
          '--mount',
          `type=volume,source=${controlVolume},target=/control${write ? '' : ',readonly'}`,
          release.images.api,
          '--input-type=module',
          '-e',
          `import fs from 'node:fs';import crypto from 'node:crypto';${write ? `fs.writeFileSync('/control/marker',${JSON.stringify(marker)},{flag:'wx'});` : ''}console.log(crypto.createHash('sha256').update(fs.readFileSync('/control/marker')).digest('hex'));`,
        );
      const volumes = () =>
        docker(
          'volume',
          'ls',
          '--filter',
          `label=com.docker.compose.project=${project}`,
          '--format',
          '{{.Name}}',
        )
          .split('\n')
          .filter(Boolean)
          .sort();
      try {
        assert.deepEqual(
          report.stages.map((item) => item.stage),
          ['restart', 'stop-resume', 'uninstall-resume'],
        );
        const before = volumes();
        assert.ok(before.length > 0);
        let rejected = false;
        try {
          await cli('erase');
        } catch (error) {
          const safe = JSON.parse(error.stderr);
          assert.equal(safe.code, 'ERASURE');
          rejected = true;
        }
        assert.equal(rejected, true, 'Erasure without confirmation must fail.');
        assert.deepEqual(volumes(), before);
        verifyDurable();
        report.unconfirmedErasureRejected = true;
        assert.equal(
          docker(
            'volume',
            'ls',
            '--filter',
            `name=^${controlVolume}$`,
            '--format',
            '{{.Name}}',
          ),
          '',
          'The erasure control volume must not exist before this test.',
        );
        docker(
          'volume',
          'create',
          '--label',
          `campus-commander.qualification-owner=${project}`,
          controlVolume,
        );
        const createdControl = JSON.parse(
          docker('volume', 'inspect', controlVolume),
        )[0];
        assert.equal(createdControl.Name, controlVolume);
        assert.equal(
          createdControl.Labels['campus-commander.qualification-owner'],
          project,
        );
        controlCreated = true;
        const expectedControlHash = createHash('sha256')
          .update(marker)
          .digest('hex');
        assert.equal(controlHash(true), expectedControlHash);
        const operator = JSON.parse(await readFile(operatorPath));
        await writeFile(
          operatorPath,
          JSON.stringify({ ...operator, confirmErase: project }),
          { mode: 0o600 },
        );
        const erased = await cli('erase');
        assert.equal(erased.status, 'erased');
        assert.equal(erased.dataPreserved, false);
        assert.deepEqual(volumes(), []);
        assert.equal(
          JSON.parse(await readFile(join(root, 'installer-state.json'))).phase,
          'erased',
        );
        assert.equal(controlHash(), expectedControlHash);
        report.erasure = {
          status: 'passed',
          ownedVolumesRemoved: before,
          unrelatedVolumePreserved: true,
          controlSha256: expectedControlHash,
        };
        removeControl();
        report.installerInvocations = installerInvocations;
        report.status = 'passed';
        await save();
        const prepare = installerInvocations.filter(
          (item) => item.command === 'prepare',
        );
        const resumes = installerInvocations.filter(
          (item) => item.command === 'resume',
        );
        assert.equal(prepare.length, 1);
        assert.equal(resumes.length, 4);
        assert.ok(resumes.every((item) => item.status === 'ready'));
        const common = {
          ...evidenceIdentity,
          schemaVersion: 1,
          phase: 3,
          profile: 'all-docker',
          sourceRevision: release.sourceRevision,
          images: release.images,
          recordedAt: new Date().toISOString(),
          status: 'passed',
          limits: report.limits,
        };
        for (const [name, commands, checks, scope] of [
          [
            'installation',
            [...prepare, resumes[0]],
            { cleanInstallation: true, installedWorkflows: true },
            'Delivered CLI prepare and first resume. Subsequent workflow checks appear in phase3-workflows.json.',
          ],
          [
            'resume',
            resumes,
            {
              repeatedResume: true,
              stopPreservedState: true,
              uninstallPreservedState: true,
              freshSessionAfterRedisLoss: true,
            },
            'All four delivered CLI resume calls. Browser and preservation probes appear in all-docker-lifecycle.json.',
          ],
        ])
          await writeFile(
            join(evidenceDirectory, `all-docker-${name}.json`),
            JSON.stringify(
              {
                ...common,
                commands,
                checks,
                durationMs: commands.reduce(
                  (total, item) => total + item.durationMs,
                  0,
                ),
                durationScope: scope,
              },
              null,
              2,
            ) + '\n',
          );
        return report;
      } catch (error) {
        report.status = 'failed';
        await save();
        throw error;
      } finally {
        removeControl();
      }
    },
  };
}

import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import {
  runProcessFaults,
  httpsStartup,
  dockerDiagnostics,
} from './faults.mjs';

const run = promisify(execFile);
const [fixturePath, reportPath] = process.argv.slice(2);
if (!fixturePath || !reportPath)
  throw new Error(
    'Usage: cli.mjs <qualification-fixture.json> <new-report.json>',
  );
try {
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
  const options = {
    qualificationOnly: fixture.qualificationOnly,
    project: fixture.project,
    composeFile: fixture.composeFile,
    recoveryTimeoutSeconds: fixture.recoveryTimeoutSeconds,
  };
  const code = await readFile(
    new URL('./fixture-probe.mjs', import.meta.url),
    'utf8',
  );
  const composeArgs = [
    'compose',
    '--project-name',
    options.project,
    '--file',
    options.composeFile,
  ];
  let baseline;
  let fixtureChecks = 0;
  const result = await runProcessFaults(options, {
    observe: () => httpsStartup(fixture.edge),
    diagnose: () => dockerDiagnostics(options),
    verifyFixtures: async () => {
      const output = await run(
        'docker',
        [
          ...composeArgs,
          'exec',
          '-T',
          'api',
          'node',
          '--input-type=module',
          '-e',
          code,
        ],
        { timeout: 15000, maxBuffer: 16384 },
      );
      const observed = JSON.parse(output.stdout);
      baseline ??= observed;
      assert.deepEqual(observed, baseline);
      process.stdout.write(
        `Durable fixture verification ${++fixtureChecks} passed.\n`,
      );
    },
  });
  const topology = JSON.parse(
    (await run('docker', [...composeArgs, 'config', '--format', 'json']))
      .stdout,
  );
  const measurements = (
    await run(
      'docker',
      [...composeArgs, 'stats', '--no-stream', '--format', 'json'],
      { timeout: 15000 },
    )
  ).stdout.trim();
  const head = (await run('git', ['rev-parse', 'HEAD'])).stdout.trim();
  const dirty = Boolean(
    (await run('git', ['status', '--porcelain'])).stdout.trim(),
  );
  const report = {
    ...result,
    recordedAt: new Date().toISOString(),
    fixtures: baseline,
    fixtureChecks,
    ...(dirty
      ? { baseGitRevision: head, workingTree: 'uncommitted-candidate' }
      : { sourceRevision: head }),
    images: Object.fromEntries(
      ['frontend', 'api', 'workers'].map((name) => [
        name,
        topology.services[name].image,
      ]),
    ),
    resourceObservation: measurements.startsWith('[')
      ? JSON.parse(measurements)
      : measurements
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  process.stdout.write(
    'Component interruption qualification completed. The complete profile fault matrix remains separate.\n',
  );
} catch (error) {
  if (error.qualification) {
    await writeFile(
      reportPath,
      `${JSON.stringify(error.qualification, null, 2)}\n`,
      { flag: 'wx', mode: 0o600 },
    ).catch(() => undefined);
  }
  process.stderr.write(
    'Fault qualification failed. Inspect the dedicated fixture and preserve failure evidence before retrying.\n',
  );
  process.exitCode = 1;
}

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import https from 'node:https';
import { performance } from 'node:perf_hooks';

const execute = promisify(execFile);
const componentServices = {
  api: 'api',
  workers: 'workers',
  redis: 'redis',
  'application-database': 'application-postgres',
  'kestra-database': 'kestra-postgres',
  kestra: 'kestra',
};

/** Inject faults only into a dedicated, explicitly named qualification project. */
export async function runProcessFaults(
  options,
  { command = execute, observe, diagnose = observe, verifyFixtures } = {},
) {
  if (
    options.qualificationOnly !== true ||
    !/^cc-fault-[a-z0-9-]+$/.test(options.project)
  ) {
    throw new Error('Fault injection requires a dedicated cc-fault project.');
  }
  if (typeof observe !== 'function' || typeof verifyFixtures !== 'function')
    throw new Error(
      'Fault qualification requires readiness and durable fixture probes.',
    );
  const args = [
    'compose',
    '--project-name',
    options.project,
    '--file',
    options.composeFile,
  ];
  const run = (...tail) =>
    command('docker', [...args, ...tail], {
      timeout: 120000,
      maxBuffer: 1024 * 1024,
    });
  const topology = JSON.parse((await run('config', '--format', 'json')).stdout);
  if (
    topology.name !== options.project ||
    Object.values(topology.services).some(
      (service) =>
        service.container_name ||
        Object.values(service.volumes ?? []).some(
          (volume) => volume.type === 'bind' && volume.read_only !== true,
        ),
    )
  ) {
    throw new Error(
      'Fault qualification rejects fixed containers and writable host mounts.',
    );
  }
  if (
    Object.values(topology.volumes ?? {}).some(
      (volume) =>
        volume.external ||
        (volume.name && !volume.name.startsWith(`${options.project}_`)),
    )
  )
    throw new Error('Fault qualification rejects volumes outside its project.');
  const records = [];
  const cases = Object.entries(componentServices)
    .filter(([, service]) => topology.services[service])
    .map(([component, service]) => ({
      component,
      interrupt: () => run('stop', '--timeout', '5', service),
      recover: () => run('start', service),
    }));
  const artifactMount = topology.services.workers?.volumes?.find(
    (volume) => volume.type === 'volume' && volume.source === 'artifacts',
  );
  if (artifactMount && topology.volumes?.artifacts) {
    const storageCommand = (mode) =>
      run(
        'exec',
        '-T',
        'workers',
        'node',
        '-e',
        `const fs=require('node:fs');const c=JSON.parse(fs.readFileSync(process.env.CC_CONFIG_FILE));const p=c.artifacts.location;const stat=fs.lstatSync(p);if(p!==process.argv[1]||!stat.isDirectory()||![0,448].includes(stat.mode&511))process.exit(1);fs.chmodSync(p,${mode});`,
        artifactMount.target,
      );
    cases.push({
      component: 'artifacts',
      interrupt: () => storageCommand(0),
      recover: () => storageCommand(448),
    });
  }
  for (const { component, interrupt, recover } of cases) {
    try {
      if ((await observe()).status !== 'ready')
        throw new Error('Fault baseline is not ready.');
      await verifyFixtures();
      const started = performance.now();
      let observed;
      try {
        await interrupt();
        observed = await observe();
        if (observed.status === 'ready')
          throw new Error('Faulted installation reported readiness.');
        const diagnostics = component === 'api' ? observed : await diagnose();
        if (
          component !== 'api' &&
          !diagnostics.checks?.some(
            (check) => check.name === component && check.status === 'not-ready',
          )
        ) {
          throw new Error('Startup diagnostics omitted the failed component.');
        }
        observed = { status: observed.status, checks: diagnostics.checks };
      } finally {
        await recover();
      }
      const deadline =
        performance.now() + (options.recoveryTimeoutSeconds ?? 180) * 1000;
      let recovered = false;
      while (performance.now() < deadline) {
        if ((await observe()).status === 'ready') {
          recovered = true;
          break;
        }
        await new Promise((done) => setTimeout(done, 1000));
      }
      if (!recovered) throw new Error('Fault recovery exceeded its deadline.');
      await verifyFixtures();
      const output = (await run('ps', '--format', 'json')).stdout.trim();
      const containers = output.startsWith('[')
        ? JSON.parse(output)
        : output
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line));
      const measurements = containers.map(({ Service, State, Health }) => ({
        service: Service,
        state: State,
        health: Health,
      }));
      records.push({
        component,
        status: 'passed',
        elapsedMilliseconds: Math.round(performance.now() - started),
        observed,
        containers: measurements,
      });
    } catch (error) {
      error.qualification = {
        schemaVersion: 1,
        profile: 'all-docker',
        scope: 'component-interruption-only',
        qualifiesProfile: false,
        status: 'failed',
        failedComponent: component,
        records,
      };
      throw error;
    }
  }
  return {
    schemaVersion: 1,
    profile: 'all-docker',
    scope: 'component-interruption-only',
    qualifiesProfile: false,
    status: records.length === 7 ? 'passed' : 'incomplete',
    records,
  };
}

export async function httpsStartup({
  url,
  caFile,
  bootstrapFile,
  connectAddress,
}) {
  const ca = caFile ? await readFile(caFile) : undefined;
  const token = (await readFile(bootstrapFile, 'utf8')).trim();
  const endpoint = new URL('/api/startup', url);
  return new Promise((done) => {
    const request = https.get(
      endpoint,
      {
        ca,
        rejectUnauthorized: true,
        ...(connectAddress
          ? { hostname: connectAddress, servername: endpoint.hostname }
          : {}),
        headers: {
          host: endpoint.host,
          authorization: `Basic ${Buffer.from(`operator:${token}`).toString('base64')}`,
        },
      },
      (response) => {
        let body = '';
        response.on('data', (chunk) => {
          body += chunk;
          if (body.length > 16384) response.destroy();
        });
        response.on('end', () => {
          try {
            done(JSON.parse(body));
          } catch {
            done({ status: 'unavailable', checks: [] });
          }
        });
        response.on('error', () => done({ status: 'unavailable', checks: [] }));
      },
    );
    request.setTimeout(10000, () => request.destroy());
    request.on('error', () => done({ status: 'unavailable', checks: [] }));
  });
}

export async function writeFaultEvidence(path, result, release) {
  if (!/^[a-f0-9]{40}$/.test(release.sourceRevision))
    throw new Error('Fault evidence requires a source revision.');
  await writeFile(
    path,
    `${JSON.stringify({ ...result, sourceRevision: release.sourceRevision, images: release.images, recordedAt: new Date().toISOString() }, null, 2)}\n`,
    { flag: 'wx', mode: 0o600 },
  );
}

/** Use the operator's container access when database loss prevents bootstrap authentication. */
export async function dockerDiagnostics({ project, composeFile }) {
  if (!/^cc-fault-[a-z0-9-]+$/.test(project))
    throw new Error('Diagnostics require a dedicated qualification project.');
  try {
    const result = await execute(
      'docker',
      [
        'compose',
        '--project-name',
        project,
        '--file',
        composeFile,
        'exec',
        '-T',
        'api',
        'node',
        '-e',
        "fetch('http://127.0.0.1:3000/health').then(r=>r.json()).then(v=>process.stdout.write(JSON.stringify(v))).catch(()=>process.exit(1))",
      ],
      { timeout: 15000, maxBuffer: 16384 },
    );
    const response = JSON.parse(result.stdout);
    return { status: response.status, checks: response.checks };
  } catch {
    return { status: 'unavailable', checks: [] };
  }
}

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import https from 'node:https';
import { renderKubernetes } from './render.mjs';
import {
  seedCode,
  probeCode,
  fillCode,
  failedPublicationCode,
  recoverCode,
  verifyBoundedFilesystem,
} from '../qualification/profile-capacity-integration.mjs';

const execute = promisify(execFile);
const reportPath = process.argv[2];
assert.ok(
  reportPath && isAbsolute(reportPath),
  'Provide a new absolute result path.',
);
assert.ok(process.env.CC_QUALIFICATION_RELEASE, 'Provide a release inventory.');
const release = JSON.parse(
  await readFile(process.env.CC_QUALIFICATION_RELEASE, 'utf8'),
);
const kind = process.env.CC_KIND_BINARY ?? 'kind';
const project = `cc-capacity-kube-${randomBytes(6).toString('hex')}`;
const root = await mkdtemp(`/tmp/${project}-`);
const kubeconfig = join(root, 'kubeconfig');
const volume = `${project}-artifacts`;
const holder = `${project}-holder`;
const run = async (file, args, input) => {
  try {
    const child = execute(file, args, {
      encoding: 'utf8',
      timeout: 900000,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (input !== undefined) child.child.stdin.end(input);
    return (await child).stdout.trim();
  } catch (error) {
    throw new Error(
      `${file} ${args[0]} failed: ${String(error.stderr ?? '').slice(-2000)}`,
    );
  }
};
const docker = (args, input) => run('docker', args, input);
const kube = (args, input) =>
  run(
    'kubectl',
    [
      '--kubeconfig',
      kubeconfig,
      '--context',
      `kind-${project}`,
      '-n',
      project,
      ...args,
    ],
    input,
  );
const api = async (code, args = []) =>
  JSON.parse(
    await kube(
      [
        'exec',
        '-i',
        'deployment/api',
        '--',
        'node',
        '--input-type=module',
        '-',
        ...args,
      ],
      code,
    ),
  );
// Existing publication helpers expect arguments after the Node executable.
const publication = (code, args) =>
  api(code.replace('process.argv.slice(1)', 'process.argv.slice(2)'), args);
const wait = async (check, label, seconds = 180) => {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch {
      /* Retry transient pod readiness. */
    }
    await new Promise((done) => setTimeout(done, 1000));
  }
  throw new Error(`${label} exceeded its recovery deadline.`);
};
const observe = async () => {
  const config = JSON.parse(
    await readFile(join(root, 'runtime/config.json'), 'utf8'),
  );
  const secret = JSON.parse(
    await kube(['get', 'secret', 'campus-installation', '-o', 'json']),
  ).data;
  const ca = Buffer.from(
    secret[config.services.edge.endpoint.tls.caSecretRef.key],
    'base64',
  );
  const token = Buffer.from(secret.bootstrap, 'base64').toString('utf8').trim();
  const hostname = new URL(config.services.edge.endpoint.url).hostname;
  const forward = spawn(
    'kubectl',
    [
      '--kubeconfig',
      kubeconfig,
      '--context',
      `kind-${project}`,
      '-n',
      project,
      'port-forward',
      'service/edge',
      ':443',
      '--address=127.0.0.1',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  try {
    const port = await new Promise((done, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Edge port forwarding timed out.')),
        10000,
      );
      forward.stdout.on('data', (bytes) => {
        const match = bytes.toString().match(/127\.0\.0\.1:(\d+)/);
        if (match) {
          clearTimeout(timer);
          done(Number(match[1]));
        }
      });
      forward.stderr.resume();
      forward.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      forward.once('exit', () => {
        clearTimeout(timer);
        reject(new Error('Edge port forwarding stopped.'));
      });
    });
    return await new Promise((done, reject) => {
      const request = https.get(
        {
          hostname: '127.0.0.1',
          port,
          servername: hostname,
          path: '/api/startup',
          ca,
          rejectUnauthorized: true,
          headers: {
            host: hostname,
            authorization: `Basic ${Buffer.from(`operator:${token}`).toString('base64')}`,
          },
        },
        (response) => {
          let body = '';
          response.on('data', (bytes) => {
            body += bytes;
            if (body.length > 16384) response.destroy();
          });
          response.on('error', reject);
          response.on('end', () => {
            try {
              const value = JSON.parse(body);
              const report =
                typeof value.message === 'object' ? value.message : value;
              done({
                statusCode: response.statusCode,
                status: report.status,
                checks: report.checks,
              });
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      request.on('error', reject);
      request.setTimeout(10000, () =>
        request.destroy(new Error('Startup probe timed out.')),
      );
    });
  } finally {
    forward.kill('SIGTERM');
  }
};
const ready = () =>
  wait(async () => {
    const state = await observe();
    return (
      state.statusCode === 200 &&
      state.status === 'ready' &&
      state.checks?.length === 8 &&
      state.checks.every((check) => check.status === 'ready') &&
      state
    );
  }, 'Complete startup readiness');
const durableCode = `
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import https from 'node:https';
import pg from 'pg';
import {connectionOptions} from '/app/deployment/postgres/index.mjs';
import {secretPath} from '/app/deployment/redis/runtime.mjs';
const c=JSON.parse(await fs.readFile(process.env.CC_CONFIG_FILE));
const secret=(r)=>fs.readFile(secretPath(r));
const pool=new pg.Pool(await connectionOptions(c.services.applicationDatabase,secret));
const auth=JSON.parse(await secret(c.services.kestra.authSecretRef));
const ca=await secret(c.services.kestra.endpoint.tls.caSecretRef);
const request=(path,method='GET',body,type)=>new Promise((done,reject)=>{
const q=https.request(new URL(path,c.services.kestra.endpoint.url),{method,ca,headers:{
authorization:'Basic '+Buffer.from(auth.username+':'+auth.password).toString('base64'),
...(type?{'content-type':type}:{}),...(body?{'content-length':body.length}:{})}},r=>{
const chunks=[];r.on('data',b=>chunks.push(b));r.on('end',()=>r.statusCode<300?done(Buffer.concat(chunks)):reject(new Error('Kestra fixture request failed.')));});
q.on('error',reject);q.setTimeout(10000,()=>q.destroy());q.end(body);});
try {
if(process.argv[2]==='seed'){
await request('/api/v1/main/flows','POST',Buffer.from('id: cc18_capacity\\nnamespace: campus.validation\\ntasks:\\n  - id: log\\n    type: io.kestra.plugin.core.log.Log\\n    message: capacity\\n'),'application/x-yaml');
const body=Buffer.from('--cc18\\r\\nContent-Disposition: form-data; name="fileContent"; filename="cc18.txt"\\r\\nContent-Type: text/plain\\r\\n\\r\\nCC18 durable marker\\r\\n--cc18--\\r\\n');
await request('/api/v1/main/namespaces/campus.validation/files?path=/cc18.txt','POST',body,'multipart/form-data; boundary=cc18');
}
const ledger=(await pool.query('SELECT id,checksum FROM cc.schema_migrations ORDER BY id')).rows;
const bootstrap=(await pool.query('SELECT id,generation,expires_at,revoked_at FROM cc.bootstrap_access ORDER BY id')).rows;
const artifacts=(await pool.query("SELECT to_jsonb(a) AS value FROM cc.artifacts a WHERE publication_state='ready' ORDER BY id")).rows;
const flow=JSON.parse(await request('/api/v1/main/flows/campus.validation/cc18_capacity'));
const marker=await request('/api/v1/main/namespaces/campus.validation/files?path=/cc18.txt');
console.log(JSON.stringify({ledger,bootstrap,artifacts,kestra:{revision:flow.revision,markerSha256:crypto.createHash('sha256').update(marker).digest('hex')}}));
}finally{await pool.end();}
`;
const startedAt = Date.now();
let result;
let failure;
let clusterCreated = false;
let volumeCreated = false;
let holderCreated = false;
let stage = 'prerequisites';
const progress = (name) => {
  stage = name;
  process.stdout.write(`${name}\n`);
};
try {
  await writeFile(reportPath, '', { flag: 'wx', mode: 0o600 });
  const versions = {
    docker: await docker(['version', '--format', '{{.Server.Version}}']),
    kind: await run(kind, ['version']),
  };
  for (const image of Object.values(release.images))
    await docker(['image', 'inspect', image, '--format', '{{.Id}}']);
  progress('bounded-volume');
  await docker([
    'volume',
    'create',
    '--label',
    `cc18.owner=${project}`,
    '--driver',
    'local',
    '--opt',
    'type=tmpfs',
    '--opt',
    'device=tmpfs',
    '--opt',
    'o=size=16m,uid=1000,gid=1000,mode=0700',
    volume,
  ]);
  volumeCreated = true;
  await docker([
    'run',
    '-d',
    '--name',
    holder,
    '--label',
    `cc18.owner=${project}`,
    '--network',
    'none',
    '--mount',
    `type=volume,source=${volume},target=/data`,
    '--entrypoint',
    'node',
    release.images.api,
    '-e',
    "require('fs').mkdirSync('/data/artifacts',{mode:0o700});setInterval(()=>{},1000)",
  ]);
  holderCreated = true;
  const mountedFilesystem = JSON.parse(
    await docker([
      'run',
      '--rm',
      '--network',
      'none',
      '--label',
      `cc18.owner=${project}`,
      '--mount',
      `type=volume,source=${volume},target=/check,readonly`,
      '--entrypoint',
      'node',
      release.images.api,
      '-e',
      "const s=require('fs').statfsSync('/check');console.log(JSON.stringify({type:Number(s.type),bytes:Number(s.blocks)*Number(s.bsize)}))",
    ]),
  );
  assert.equal(mountedFilesystem.type, 0x01021994);
  assert.equal(mountedFilesystem.bytes, 16 * 1024 * 1024);
  const realDocker = await run('which', ['docker']);
  assert.ok(isAbsolute(realDocker));
  const wrapperDirectory = join(root, 'bin');
  await mkdir(wrapperDirectory, { mode: 0o700 });
  // Kind exposes bind mounts only. Add the owned named volume to its node commands.
  await writeFile(
    join(wrapperDirectory, 'docker'),
    `#!${process.execPath}
import {spawnSync} from 'node:child_process';
const args=process.argv.slice(2);
if(args[0]==='run' && args.includes(${JSON.stringify(`io.x-k8s.kind.cluster=${project}`)}) && args.at(-1)==='kindest/node:v1.35.8') {
  args.splice(1,0,'--mount',${JSON.stringify(`type=volume,source=${volume},target=/var/local/cc-synthetic-shared/campus-artifacts`)});
}
const result=spawnSync(${JSON.stringify(realDocker)},args,{stdio:'inherit'});
process.exit(result.status??1);
`,
    { mode: 0o700, flag: 'wx' },
  );
  process.env.PATH = `${wrapperDirectory}:${process.env.PATH}`;
  await mkdir(join(root, 'shared'), { mode: 0o700 });
  const kindConfig = {
    kind: 'Cluster',
    apiVersion: 'kind.x-k8s.io/v1alpha4',
    nodes: ['control-plane', 'worker', 'worker'].map((role) => ({
      role,
      extraMounts: [
        {
          hostPath: join(root, 'shared'),
          containerPath: '/var/local/cc-synthetic-shared',
        },
      ],
    })),
  };
  await writeFile(join(root, 'kind.json'), JSON.stringify(kindConfig), {
    mode: 0o600,
  });
  progress('create-cluster');
  clusterCreated = true;
  await run(kind, [
    'create',
    'cluster',
    '--name',
    project,
    '--image',
    'kindest/node:v1.35.8',
    '--config',
    join(root, 'kind.json'),
    '--kubeconfig',
    kubeconfig,
    '--wait',
    '180s',
  ]);
  progress('load-images');
  const config = JSON.parse(
    await readFile('deployment/examples/kubernetes.json', 'utf8'),
  );
  config.services.api.placement.replicas = 2;
  config.images = release.images;
  const operator = JSON.parse(
    await readFile('deployment/kubernetes/operator.example.json', 'utf8'),
  );
  operator.release = release;
  const resources = renderKubernetes(config, operator);
  const images = new Set();
  for (const item of resources.items) {
    const spec = item.spec?.template?.spec;
    for (const container of [
      ...(spec?.containers ?? []),
      ...(spec?.initContainers ?? []),
    ])
      images.add(container.image);
  }
  const archive = join(root, 'images.tar');
  await docker(['save', '--output', archive, ...images]);
  const nodeNames = (
    await run(kind, ['get', 'nodes', '--name', project])
  ).split('\n');
  for (const node of nodeNames) {
    const ctr = (args) =>
      docker(['exec', node, 'ctr', '--namespace=k8s.io', 'images', ...args]);
    const previousNames = new Set((await ctr(['list', '-q'])).split('\n'));
    const child = spawn(
      'docker',
      [
        'exec',
        '-i',
        node,
        'ctr',
        '--namespace=k8s.io',
        'images',
        'import',
        '--platform',
        'linux/amd64',
        '--digests',
        '-',
      ],
      { stdio: ['pipe', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (bytes) => {
      stderr += bytes;
    });
    const completion = new Promise((done, reject) => {
      child.once('error', reject);
      child.once('exit', (code) =>
        code === 0
          ? done()
          : reject(new Error(`Image import failed: ${stderr.slice(-2000)}`)),
      );
    });
    await Promise.all([
      pipeline(createReadStream(archive), child.stdin),
      completion,
    ]);
    const importedNames = (await ctr(['list', '-q'])).split('\n');
    for (const image of images) {
      const repository = image.split('@')[0];
      const canonical = !repository.includes('/')
        ? `docker.io/library/${image}`
        : image;
      if (importedNames.includes(canonical)) continue;
      const source = importedNames.find(
        (name) =>
          name.startsWith('import-') &&
          name.endsWith(`@${image.split('@')[1]}`),
      );
      assert.ok(
        source,
        'The requested image digest is absent from the archive.',
      );
      await ctr(['tag', source, canonical]);
    }
    for (const name of importedNames) {
      if (name.startsWith('import-') && !previousNames.has(name))
        await ctr(['rm', name]);
    }
    await docker(['exec', node, 'systemctl', 'restart', 'containerd']);
  }
  await rm(archive);
  const descriptor = join(root, 'fixture.json');
  await writeFile(
    descriptor,
    JSON.stringify({ qualificationOnly: true, root, project }),
    { mode: 0o600 },
  );
  progress('prepare-workloads');
  const prepare = execute(
    process.execPath,
    ['deployment/kubernetes/integration.mjs'],
    {
      env: { ...process.env, CC_KUBERNETES_CAPACITY_FIXTURE: descriptor },
      timeout: 900000,
    },
  );
  await prepare;
  for (const name of [
    'application-postgres',
    'kestra-postgres',
    'redis',
    'api',
    'workers',
    'kestra',
    'frontend',
    'edge',
  ]) {
    progress(`wait-${name}`);
    await kube(['rollout', 'status', `deployment/${name}`, '--timeout=300s']);
  }
  const before = await ready();
  const filesystem = await api(`import fs from 'node:fs';
const c=JSON.parse(fs.readFileSync(process.env.CC_CONFIG_FILE));
const s=fs.statfsSync(c.artifacts.location);
console.log(JSON.stringify({type:Number(s.type),totalBytes:Number(s.blocks)*Number(s.bsize)}));`);
  assert.equal(filesystem.type, 0x01021994);
  assert.equal(filesystem.totalBytes, 16 * 1024 * 1024);
  await api(seedCode);
  const artifact = await api(probeCode);
  const durable = await api(durableCode, ['seed']);
  const consumerPods = JSON.parse(await kube(['get', 'pods', '-o', 'json']))
    .items.filter((pod) =>
      ['api', 'workers'].includes(
        pod.metadata.labels['app.kubernetes.io/name'],
      ),
    )
    .map((pod) => pod.metadata.name);
  assert.equal(consumerPods.length, 4);
  const verifyConsumers = async () => {
    for (const pod of consumerPods) {
      const value = JSON.parse(
        await kube(
          ['exec', '-i', pod, '--', 'node', '--input-type=module'],
          probeCode,
        ),
      );
      assert.deepEqual(value, artifact);
    }
  };
  await verifyConsumers();
  const resourceBaseline = (
    await docker([
      'stats',
      '--no-stream',
      '--format',
      '{{json .}}',
      ...nodeNames,
    ])
  )
    .split('\n')
    .map((line) => {
      const value = JSON.parse(line);
      return {
        node: value.Name.replace(project, 'fixture'),
        cpuPercent: value.CPUPerc,
        memory: value.MemUsage,
        memoryPercent: value.MemPerc,
        blockIO: value.BlockIO,
        pids: value.PIDs,
      };
    });
  const topology = JSON.parse(
    await kube(['get', 'pods', '-o', 'json']),
  ).items.map((pod) => ({
    component: pod.metadata.labels['app.kubernetes.io/name'],
    nodeIndex: pod.spec.nodeName.replace(project, 'fixture'),
    containers: pod.spec.containers.map((c) => ({
      name: c.name,
      image: c.image,
      resources: c.resources,
    })),
    statuses: pod.status.containerStatuses?.map((c) => ({
      imageID: c.imageID,
      restartCount: c.restartCount,
    })),
  }));
  progress('inject-capacity');
  const faultStartedAt = Date.now();
  const capacity = verifyBoundedFilesystem(await api(fillCode));
  const fault = await wait(async () => {
    const state = await observe();
    return (
      state.statusCode === 503 &&
      state.status === 'not-ready' &&
      state.checks?.find(
        (check) =>
          check.component === 'artifacts' || check.name === 'artifacts',
      )?.status === 'not-ready' &&
      state
    );
  }, 'Artifact capacity diagnostics');
  const artifactId = randomUUID(),
    attemptId = randomUUID();
  assert.deepEqual(
    fault.checks
      .filter((check) => check.status !== 'ready')
      .map((check) => check.name),
    ['artifacts'],
  );
  const rejected = await publication(failedPublicationCode, [
    artifactId,
    attemptId,
  ]);
  assert.equal(rejected.rejected, true);
  assert.equal(rejected.row.publication_state, 'staging');
  assert.equal(rejected.row.active, false);
  assert.equal(rejected.readyRows, artifact.readyRows);
  progress('recover-capacity');
  const recoveryStartedAt = Date.now();
  const removed = await publication(recoverCode, [artifactId, attemptId]);
  assert.equal(removed.rowCount, 0);
  const after = await ready();
  assert.deepEqual(await api(probeCode), artifact);
  assert.deepEqual(await api(durableCode), durable);
  await verifyConsumers();
  const recoveryMs = Date.now() - recoveryStartedAt;
  assert.ok(recoveryMs < 180000);
  result = {
    schemaVersion: 1,
    ticket: 'CC-18',
    status: 'passed',
    scope: 'kubernetes-artifact-capacity',
    checkedAt: new Date().toISOString(),
    sourceRevision: await run('git', ['rev-parse', 'HEAD']),
    sourceState: (await run('git', ['status', '--porcelain']))
      ? 'uncommitted-candidate'
      : 'clean',
    harnessSha256: createHash('sha256')
      .update(await readFile(new URL(import.meta.url)))
      .digest('hex'),
    testedReleaseSourceRevision: release.sourceRevision,
    images: release.images,
    versions: {
      ...versions,
      kubernetes: JSON.parse(await kube(['version', '-o', 'json']))
        .serverVersion.gitVersion,
    },
    topology,
    resourceBaseline,
    before,
    fault,
    after,
    capacity,
    rejected,
    artifact,
    durableFixtureSha256: createHash('sha256')
      .update(JSON.stringify(durable))
      .digest('hex'),
    faultDurationMs: Date.now() - faultStartedAt,
    recoveryMs,
    assertions: {
      durableFixturesPreserved: true,
      partialPublicationPrevented: true,
      failedAttemptRemoved: true,
      artifactConsumersVerified: consumerPods.length,
    },
    boundaries: [
      'Three Kind nodes share one Docker host.',
      'The 16 MiB tmpfs does not qualify district CSI storage or persistence.',
      'The default Kind CNI does not enforce NetworkPolicy.',
      'This result qualifies only the synthetic Kubernetes capacity cell.',
    ],
  };
} catch (error) {
  failure = new Error(
    `Kubernetes capacity failed during ${stage}: ${error.message}`,
  );
} finally {
  process.stdout.write('cleanup\n');
  try {
    if (clusterCreated)
      await run(kind, ['delete', 'cluster', '--name', project]);
    if (holderCreated) {
      assert.equal(
        await docker([
          'inspect',
          holder,
          '--format',
          '{{index .Config.Labels "cc18.owner"}}',
        ]),
        project,
      );
      await docker(['rm', '-f', holder]);
    }
    if (volumeCreated) {
      assert.equal(
        await docker([
          'volume',
          'inspect',
          volume,
          '--format',
          '{{index .Labels "cc18.owner"}}',
        ]),
        project,
      );
      await docker(['volume', 'rm', volume]);
    }
    const containers = await docker([
      'ps',
      '-a',
      '--filter',
      `label=cc18.owner=${project}`,
      '-q',
    ]);
    const volumes = await docker([
      'volume',
      'ls',
      '--filter',
      `label=cc18.owner=${project}`,
      '-q',
    ]);
    assert.equal(containers, '');
    assert.equal(volumes, '');
    assert.equal(
      (await run(kind, ['get', 'clusters'])).split('\n').includes(project),
      false,
    );
    if (result)
      result.cleanup = {
        clusterRemoved: true,
        holderRemoved: true,
        boundedVolumeRemoved: true,
      };
  } catch (error) {
    failure = new AggregateError(
      [...(failure ? [failure] : []), error],
      'Kubernetes capacity cleanup failed.',
    );
  }
}
if (failure) {
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        status: 'failed',
        stage,
        error: failure.message,
        privateFixtureRoot: root,
      },
      null,
      2,
    ),
  );
  throw failure;
}
result.durationMs = Date.now() - startedAt;
await writeFile(resolve(reportPath), `${JSON.stringify(result, null, 2)}\n`, {
  mode: 0o600,
});
process.stdout.write('Kubernetes capacity qualification passed.\n');

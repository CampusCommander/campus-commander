import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';
import {
  backupFoundation,
  postgresToolArguments,
} from '../operations/index.mjs';
import { installationSecretPath } from './secrets.mjs';

// The caller owns this disposable cluster until every lifecycle check completes.
const fixture = JSON.parse(await readFile(process.argv[2], 'utf8'));
assert.equal(fixture.qualificationOnly, true);
const operatorPath = resolve(fixture.operatorPath);
const operator = JSON.parse(await readFile(operatorPath, 'utf8'));
const root = operator.installationRoot;
assert.match(root, /^\/tmp\/cc-closeout-kube[^/]*\/install$/);
assert.match(operator.project, /^cc-closeout-kube[a-z0-9-]*$/);
assert.equal(operator.cluster.context, `kind-${operator.project}`);
const namespace = operator.project;
const config = JSON.parse(await readFile(operator.configurationPath, 'utf8'));
assert.equal(config.profile, 'kubernetes');
const releaseA = JSON.parse(await readFile(operator.releasePath, 'utf8'));
const releaseBPath = join(
  resolve(fixture.releaseBRoot),
  'release-manifest.json',
);
const releaseB = JSON.parse(await readFile(releaseBPath, 'utf8'));
assert.notDeepEqual(releaseA.images, releaseB.images);
assert.equal(releaseA.sourceRevision.length, 40);
assert.equal(releaseB.sourceRevision.length, 40);
const env = { ...process.env, KUBECONFIG: resolve(fixture.kubeconfig) };
const run = (file, args, input) =>
  execFileSync(file, args, {
    env,
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 900_000,
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
const kubeArgs = ['--context', operator.cluster.context, '-n', namespace];
const kube = (args, input) => run('kubectl', [...kubeArgs, ...args], input);
const json = (args) => JSON.parse(kube(args));
const cli = (command) =>
  JSON.parse(
    run(process.execPath, [
      resolve('deployment/installer/cli.mjs'),
      command,
      operatorPath,
      '--qualification',
    ]),
  );
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const records = [];
const forwards = [];
const wait = async (check, label, seconds = 180) => {
  let error;
  for (let attempt = 0; attempt < seconds; attempt++) {
    try {
      const result = await check();
      if (result) return result;
    } catch (caught) {
      error = caught;
    }
    await new Promise((done) => setTimeout(done, 1000));
  }
  throw new Error(`${label} exceeded its recovery deadline.`, { cause: error });
};
const api = (code) =>
  JSON.parse(
    kube(
      ['exec', '-i', 'deployment/api', '--', 'node', '--input-type=module'],
      code,
    ),
  );
const common = `
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import https from 'node:https';
import pg from 'pg';
import {connectionOptions} from '/app/deployment/postgres/index.mjs';
import {createArtifactStore} from '/app/deployment/storage/index.mjs';
import {secretPath} from '/app/deployment/redis/runtime.mjs';
const config=JSON.parse(await fs.readFile(process.env.CC_CONFIG_FILE));
const secret=(ref)=>fs.readFile(secretPath(ref));
const pool=new pg.Pool(await connectionOptions(config.services.applicationDatabase,secret));
const store=await createArtifactStore({pool,root:config.artifacts.location,backend:'shared-filesystem'});
const auth=JSON.parse(await secret(config.services.kestra.authSecretRef));
const ca=await secret(config.services.kestra.endpoint.tls.caSecretRef);
const request=(path,method='GET',body,contentType)=>new Promise((done,reject)=>{
 const q=https.request(new URL(path,config.services.kestra.endpoint.url),{method,ca,
 headers:{authorization:'Basic '+Buffer.from(auth.username+':'+auth.password).toString('base64'),
 ...(contentType?{'content-type':contentType}:{}),...(body?{'content-length':body.length}:{})}},r=>{
 const chunks=[];r.on('data',b=>chunks.push(b));r.on('end',()=>r.statusCode<300?done(Buffer.concat(chunks)):reject(new Error('Kestra fixture request failed.')));
 });q.on('error',reject);q.setTimeout(5000,()=>q.destroy());q.end(body);
});
`;
const seed =
  common +
  `
try {
 const bytes=Buffer.from('CC16 Kubernetes lifecycle École 学校');
 const artifact=await store.stage({schemaVersion:1,expectedSizeBytes:bytes.length,expectedSha256:crypto.createHash('sha256').update(bytes).digest('hex')},[bytes]);
 await store.publish(artifact);
 await fs.writeFile(config.artifacts.location+'/.cc16-kube-fixture.json',JSON.stringify(artifact),{mode:0o600,flag:'wx'});
 const flow=Buffer.from('id: cc16_lifecycle\\nnamespace: campus.validation\\ntasks:\\n  - id: log\\n    type: io.kestra.plugin.core.log.Log\\n    message: lifecycle\\n');
 await request('/api/v1/main/flows','POST',flow,'application/x-yaml');
 const boundary='cc16fixture', marker=Buffer.from('CC16 preserved Kestra internal file');
 const body=Buffer.concat([Buffer.from('--'+boundary+'\\r\\nContent-Disposition: form-data; name="fileContent"; filename="cc16-marker.txt"\\r\\nContent-Type: text/plain\\r\\n\\r\\n'),marker,Buffer.from('\\r\\n--'+boundary+'--\\r\\n')]);
 await request('/api/v1/main/namespaces/campus.validation/files?path=/cc16-marker.txt','POST',body,'multipart/form-data; boundary='+boundary);
 process.stdout.write(JSON.stringify({artifactId:artifact.artifactId}));
} finally {await store.close();await pool.end();}
`;
const probe =
  common +
  `
try {
 const descriptor=JSON.parse(await fs.readFile(config.artifacts.location+'/.cc16-kube-fixture.json'));
 const h=crypto.createHash('sha256');let size=0;
 for await(const bytes of await store.openRead(descriptor.artifactId)){h.update(bytes);size+=bytes.length;}
 const ledger=(await pool.query('SELECT id,checksum FROM cc.schema_migrations ORDER BY id')).rows;
 const bootstrap=(await pool.query('SELECT id,generation,expires_at,revoked_at FROM cc.bootstrap_access ORDER BY id')).rows;
 const metadata=(await pool.query('SELECT to_jsonb(a) AS value FROM cc.artifacts a WHERE id=$1',[descriptor.artifactId])).rows;
 const marker=await request('/api/v1/main/namespaces/campus.validation/files?path=/cc16-marker.txt');
 const flow=JSON.parse(await request('/api/v1/main/flows/campus.validation/cc16_lifecycle'));
 process.stdout.write(JSON.stringify({artifactId:descriptor.artifactId,sizeBytes:size,sha256:h.digest('hex'),ledger,bootstrap,metadata,kestra:{id:flow.id,revision:flow.revision,markerSha256:crypto.createHash('sha256').update(marker).digest('hex')}}));
} finally {await store.close();await pool.end();}
`;
const claimNames = () =>
  json(['get', 'pvc', '-o', 'json'])
    .items.map((x) => x.metadata.name)
    .sort();
const deployments = () => json(['get', 'deployments', '-o', 'json']).items;
const ownedDeployment = (item) =>
  item.metadata.labels?.['app.kubernetes.io/part-of'] === 'campus-commander';
const externalDeployments = () =>
  deployments()
    .filter((item) => !ownedDeployment(item))
    .map(({ metadata, spec }) => ({ name: metadata.name, spec }))
    .sort((a, b) => a.name.localeCompare(b.name));
const ownedRuntimeResources = () =>
  json([
    'get',
    'deployments,services,jobs,configmaps,networkpolicies,serviceaccounts',
    '-l',
    'app.kubernetes.io/part-of=campus-commander',
    '-o',
    'json',
  ]).items;
const waitForRollouts = () => {
  for (const item of deployments())
    kube([
      'rollout',
      'status',
      `deployment/${item.metadata.name}`,
      '--timeout=300s',
    ]);
};
const externalSecrets = () =>
  json(['get', 'secrets', '-o', 'json'])
    .items.map(({ metadata, data }) => ({ name: metadata.name, data }))
    .sort((a, b) => a.name.localeCompare(b.name));
const retainedVolumes = () =>
  json(['get', 'pv', '-o', 'json'])
    .items.filter(
      ({ spec }) =>
        spec.claimRef?.namespace === namespace &&
        spec.persistentVolumeReclaimPolicy === 'Retain',
    )
    .map(({ metadata }) => metadata.name)
    .sort();
const verify = async (baseline) => {
  const after = await wait(() => api(probe), 'Durable fixture verification');
  assert.deepEqual(after, baseline);
  return digest(JSON.stringify(after));
};
async function forward(service) {
  const child = spawn(
    'kubectl',
    [
      ...kubeArgs,
      'port-forward',
      `service/${service}`,
      ':5432',
      '--address=127.0.0.1',
    ],
    {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  forwards.push(child);
  return new Promise((done, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Database port forward timed out.'));
    }, 30_000);
    child.stdout.on('data', (bytes) => {
      output += bytes.toString();
      const match = output.match(/Forwarding from 127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timer);
        done(Number(match[1]));
      }
    });
    child.stderr.resume();
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('Database port forward stopped.'));
    });
  });
}
async function createBackup() {
  const desired = deployments().filter((x) =>
    ['api', 'workers', 'kestra'].includes(x.metadata.name),
  );
  for (const item of desired)
    kube(['scale', `deployment/${item.metadata.name}`, '--replicas=0']);
  await wait(
    () =>
      json(['get', 'pods', '-o', 'json']).items.every(
        (x) =>
          !['api', 'workers', 'kestra'].includes(
            x.metadata.labels?.['app.kubernetes.io/name'],
          ),
      ),
    'Writer shutdown',
  );
  const sourceRoots = {
    artifacts: resolve(fixture.artifactSnapshot),
    kestraInternal: resolve(fixture.kestraSnapshot),
  };
  // The fixture provider copies these private snapshots only after writer shutdown.
  assert.ok(fixture.snapshotCommand?.length);
  run(fixture.snapshotCommand[0], fixture.snapshotCommand.slice(1));
  const backupConfig = structuredClone(config);
  const targets = new Map();
  for (const [key, service] of [
    ['applicationDatabase', 'application-postgres'],
    ['kestraDatabase', 'kestra-postgres'],
  ]) {
    backupConfig.services[key].endpoint.url =
      `postgresql://localhost:${await forward(service)}`;
    targets.set(backupConfig.services[key].database, service);
  }
  backupConfig.artifacts.location = sourceRoots.artifacts;
  backupConfig.services.kestra.internalStorage.location =
    sourceRoots.kestraInternal;
  const secretValues = new Map();
  for (const item of json(['get', 'secrets', '-o', 'json']).items)
    for (const [key, value] of Object.entries(item.data ?? {}))
      secretValues.set(
        `${item.metadata.name}/${key}`,
        Buffer.from(value, 'base64'),
      );
  const keyRecovery = {
    id: 'cc16-kubernetes-upgrade',
    version: 1,
    reference: { provider: 'file', path: '/run/secrets/upgrade-backup-key' },
  };
  const backupKey = randomBytes(32);
  const keyPath = installationSecretPath(
    join(root, 'private'),
    keyRecovery.reference,
  );
  await mkdir(dirname(keyPath), { recursive: true, mode: 0o700 });
  await writeFile(keyPath, backupKey, { mode: 0o600, flag: 'wx' });
  const resolveSecret = async (ref) => {
    if (ref.provider === 'file' && ref.path === keyRecovery.reference.path)
      return backupKey;
    const value = secretValues.get(`${ref.name}/${ref.key}`);
    assert.ok(value, 'A required fixture secret is absent.');
    return value;
  };
  const runTool = async (tool, { service, output }) => {
    assert.equal(tool, 'pg_dump');
    const child = spawn(
      'kubectl',
      [
        ...kubeArgs,
        'exec',
        `deployment/${targets.get(service.database)}`,
        '--',
        tool,
        '--username',
        service.role,
        '--dbname',
        service.database,
        ...postgresToolArguments(tool, service),
      ],
      { env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    child.stderr.resume();
    const completion = new Promise((done, reject) => {
      child.once('error', reject);
      child.once('exit', (code) =>
        code === 0
          ? done()
          : reject(new Error('Kubernetes backup command failed.')),
      );
    });
    await Promise.all([
      completion,
      pipeline(
        child.stdout,
        output ??
          new Writable({
            write(_bytes, _encoding, done) {
              done();
            },
          }),
      ),
    ]);
  };
  const backupDirectory = join(root, 'upgrade-backup');
  await backupFoundation({
    config: backupConfig,
    release: releaseA,
    backupDirectory,
    sourceRoots,
    keyRecovery,
    quiesce: {
      operator: 'synthetic-kubernetes-lifecycle',
      stoppedAt: new Date().toISOString(),
      stoppedServices: ['api', 'workers', 'kestra'],
    },
    resolveSecret,
    applicationCredentials: {
      role: operator.kubernetes.migrationRole,
      passwordSecretRef: operator.kubernetes.migrationPasswordSecretRef,
    },
    runTool,
  });
  operator.upgradeBackup = { backupDirectory, keyRecovery };
  operator.backupManifestSha256 = digest(
    await readFile(join(backupDirectory, 'manifest.json')),
  );
  return desired;
}
let stage = 'baseline';
try {
  assert.equal(cli('status').readiness.status, 'ready');
  api(seed);
  const baseline = api(probe);
  const claims = claimNames();
  const originalSecrets = externalSecrets();
  const originalExternalDeployments = externalDeployments();
  const originalRetainedVolumes = retainedVolumes();
  assert.ok(claims.length);
  assert.ok(originalSecrets.length);
  assert.ok(originalRetainedVolumes.length);
  for (const command of ['stop', 'uninstall']) {
    stage = command;
    const result = cli(command);
    assert.equal(result.dataPreserved, true);
    assert.equal(result.externalResourcesPreserved, true);
    assert.deepEqual(claimNames(), claims);
    assert.deepEqual(externalSecrets(), originalSecrets);
    assert.deepEqual(externalDeployments(), originalExternalDeployments);
    if (command === 'stop')
      assert.ok(
        deployments()
          .filter(ownedDeployment)
          .every((x) => x.spec.replicas === 0),
      );
    else assert.equal(ownedRuntimeResources().length, 0);
    assert.equal(cli('resume').status, 'ready');
    waitForRollouts();
    records.push({
      command,
      resumed: true,
      claimsPreserved: true,
      fixtureSha256: await verify(baseline),
    });
  }
  stage = 'backup';
  const state = JSON.parse(
    await readFile(join(root, 'installer-state.json'), 'utf8'),
  );
  await createBackup();
  operator.upgradeFromReleaseHash = state.releaseHash;
  operator.releasePath = releaseBPath;
  operator.releaseRoot = resolve(fixture.releaseBRoot);
  operator.trust.bundlePath = join(
    operator.releaseRoot,
    'release-manifest.sigstore.json',
  );
  config.images = releaseB.images;
  await writeFile(operator.configurationPath, JSON.stringify(config), {
    mode: 0o600,
  });
  await writeFile(operatorPath, JSON.stringify(operator), { mode: 0o600 });
  stage = 'upgrade';
  assert.equal(cli('upgrade').status, 'ready');
  waitForRollouts();
  for (const [name, image] of Object.entries({
    ...releaseB.images,
    edge: releaseB.images.api,
  })) {
    const deployment = json(['get', 'deployment', name, '-o', 'json']);
    assert.equal(deployment.spec.template.spec.containers[0].image, image);
    await wait(() => {
      const pods = json([
        'get',
        'pods',
        '-l',
        `app.kubernetes.io/name=${name}`,
        '-o',
        'json',
      ]).items;
      return (
        pods.length > 0 &&
        pods.every(
          (pod) =>
            !pod.metadata.deletionTimestamp &&
            pod.spec.containers[0].image === image &&
            pod.status.conditions?.some(
              (condition) =>
                condition.type === 'Ready' && condition.status === 'True',
            ),
        )
      );
    }, 'Replacement image readiness');
  }
  records.push({
    command: 'upgrade',
    encryptedBackupVerified: true,
    differentImageInventories: true,
    fixtureSha256: await verify(baseline),
  });
  stage = 'erase';
  assert.equal(cli('uninstall').dataPreserved, true);
  assert.equal(ownedRuntimeResources().length, 0);
  operator.confirmErase = namespace;
  await writeFile(operatorPath, JSON.stringify(operator), { mode: 0o600 });
  assert.equal(cli('erase').dataPreserved, false);
  assert.equal(deployments().filter(ownedDeployment).length, 0);
  assert.deepEqual(externalDeployments(), originalExternalDeployments);
  assert.deepEqual(claimNames(), []);
  assert.deepEqual(externalSecrets(), originalSecrets);
  assert.deepEqual(retainedVolumes(), originalRetainedVolumes);
  const report = {
    schemaVersion: 1,
    status: 'passed',
    profile: 'kubernetes',
    checkedAt: new Date().toISOString(),
    sourceRevision: run('git', ['rev-parse', 'HEAD']),
    sourceState: run('git', ['status', '--porcelain'])
      ? 'uncommitted-candidate'
      : 'clean',
    harnessSha256: digest(await readFile(new URL(import.meta.url))),
    releaseSourceRevisions: [releaseA.sourceRevision, releaseB.sourceRevision],
    imageInventories: [releaseA.images, releaseB.images],
    operations: records,
    erase: {
      ownedDeploymentsRemoved: true,
      ownedClaimsRemoved: true,
      externalSecretsPreserved: true,
      retainedStorageVolumesPreserved: true,
    },
    limitations: [
      'Synthetic Kind cluster on one physical host',
      'Shared fixture storage does not qualify a district CSI driver',
    ],
  };
  await writeFile(
    resolve(fixture.reportPath),
    JSON.stringify(report, null, 2) + '\n',
    { mode: 0o600, flag: 'wx' },
  );
  process.stdout.write(
    JSON.stringify({ status: 'passed', profile: 'kubernetes' }) + '\n',
  );
} catch (error) {
  process.stderr.write(
    `Kubernetes lifecycle failed during ${stage}: ${error.message}\n`,
  );
  process.exitCode = 1;
} finally {
  for (const child of forwards) child.kill('SIGTERM');
}

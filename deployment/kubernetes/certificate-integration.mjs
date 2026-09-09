import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { httpsStartup } from '../qualification/faults.mjs';

const fixturePath = process.argv[2];
if (!fixturePath || !isAbsolute(fixturePath)) {
  throw new Error('Provide an absolute certificate fixture path.');
}
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
assert.equal(fixture.qualificationOnly, true);
for (const field of [
  'operatorPath',
  'kubeconfig',
  'resultPath',
  'durableProbePath',
]) {
  if (!isAbsolute(fixture[field])) {
    throw new Error(`Provide an absolute ${field}.`);
  }
}
const operatorPath = resolve(fixture.operatorPath);
const operator = JSON.parse(await readFile(operatorPath, 'utf8'));
const root = dirname(operator.installationRoot);
assert.match(root, /^\/tmp\/cc-closeout-kube[a-z0-9-]*$/);
assert.equal(operator.installationRoot, join(root, 'install'));
assert.match(operator.project, /^cc-closeout-kube[a-z0-9-]*$/);
assert.equal(operator.cluster.context, `kind-${operator.project}`);
const kubeconfig = resolve(fixture.kubeconfig);
const context = operator.cluster.context;
const namespace = operator.project;
const resultPath = resolve(fixture.resultPath);
const durableProbePath = resolve(fixture.durableProbePath);
for (const path of [kubeconfig, resultPath, durableProbePath]) {
  if (!path.startsWith(`${root}/`)) {
    throw new Error('Certificate fixture paths must remain inside its root.');
  }
}
const release = JSON.parse(await readFile(operator.releasePath));
const config = JSON.parse(await readFile(operator.configurationPath, 'utf8'));
const edgeUrl = config.services.edge.endpoint.url;
assert.equal(new URL(edgeUrl).hostname, 'localhost');
assert.equal(fixture.connectAddress, '127.0.0.1');
const redact = (value) =>
  value
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, '[redacted]')
    .replace(/[A-Za-z0-9+/]{64,}={0,2}/g, '[redacted]');
const kube = (args, input) => {
  try {
    return execFileSync(
      'kubectl',
      [
        '--kubeconfig',
        kubeconfig,
        '--context',
        context,
        '--namespace',
        namespace,
        ...args,
      ],
      {
        encoding: 'utf8',
        input,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 120000,
      },
    ).trim();
  } catch (error) {
    const stderr =
      typeof error.stderr === 'string'
        ? error.stderr.trim()
        : Buffer.isBuffer(error.stderr)
          ? error.stderr.toString('utf8').trim()
          : '';
    const detail = stderr ? `: ${redact(stderr)}` : '';
    throw new Error(`kubectl ${args[0] ?? 'command'} failed${detail}`);
  }
};
const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
const waitFor = async (check, message, attempts = 120) => {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await sleep(1000);
  }
  throw new Error(message, { cause: lastError });
};
const secret = JSON.parse(
  kube(['get', 'secret', 'campus-installation', '-o', 'json']),
);
const original = {
  ca: secret.data['edge-ca'],
  certificate: secret.data['edge-certificate'],
  privateKey: secret.data['edge-private-key'],
};
const bootstrap = join(
  operator.installationRoot,
  'private/campus-installation/bootstrap',
);
const temporary = await mkdtemp(join(root, 'certificate-fault-'));
await chmod(temporary, 0o700);
const recoveryDirectory = join(temporary, 'recovery');
await mkdir(recoveryDirectory, { mode: 0o700 });
const originalCaPath = join(recoveryDirectory, 'edge-ca');
const originalCertificatePath = join(recoveryDirectory, 'edge-certificate');
const originalPrivateKeyPath = join(recoveryDirectory, 'edge-private-key');
await writeFile(originalCaPath, Buffer.from(original.ca, 'base64'), {
  mode: 0o600,
});
await writeFile(
  originalCertificatePath,
  Buffer.from(original.certificate, 'base64'),
  { mode: 0o600 },
);
await writeFile(
  originalPrivateKeyPath,
  Buffer.from(original.privateKey, 'base64'),
  { mode: 0o600 },
);
const openssl = (...args) =>
  execFileSync('openssl', args, { cwd: temporary, stdio: 'ignore' });
await mkdir(join(temporary, 'certs'));
await writeFile(join(temporary, 'index'), '');
await writeFile(join(temporary, 'serial'), '1000\n');
openssl(
  'req',
  '-x509',
  '-newkey',
  'rsa:2048',
  '-nodes',
  '-keyout',
  'ca.key',
  '-out',
  'ca.pem',
  '-days',
  '1',
  '-subj',
  '/CN=Disposable Kubernetes edge fault CA',
);
openssl(
  'req',
  '-new',
  '-newkey',
  'rsa:2048',
  '-nodes',
  '-keyout',
  'server.key',
  '-out',
  'server.csr',
  '-subj',
  '/CN=localhost',
);
await writeFile(
  join(temporary, 'ca.conf'),
  `[ca]\ndefault_ca=fixture\n[fixture]\ndatabase=index\nserial=serial\nnew_certs_dir=certs\ncertificate=ca.pem\nprivate_key=ca.key\ndefault_md=sha256\ndefault_days=1\npolicy=names\nunique_subject=no\n[names]\ncommonName=supplied\n[server]\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost\n[wrong]\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:wrong.invalid\n`,
);
for (const [name, args] of [
  ['valid', ['-extensions', 'server']],
  [
    'expired',
    [
      '-extensions',
      'server',
      '-startdate',
      '20200101000000Z',
      '-enddate',
      '20200102000000Z',
    ],
  ],
  ['wrong-host', ['-extensions', 'wrong']],
])
  openssl(
    'ca',
    '-batch',
    '-notext',
    '-config',
    'ca.conf',
    '-in',
    'server.csr',
    '-out',
    `${name}.pem`,
    ...args,
  );

const podNames = () =>
  JSON.parse(
    kube(['get', 'pods', '-l', 'app.kubernetes.io/name=edge', '-o', 'json']),
  ).items.map((item) => item.metadata.name);
const replace = async (ca, certificate, privateKey, expectReady) => {
  const before = new Set(podNames());
  kube(
    [
      'patch',
      'secret',
      'campus-installation',
      '--type=merge',
      '--patch-file=/dev/stdin',
    ],
    JSON.stringify({
      data: {
        'edge-ca': ca.toString('base64'),
        'edge-certificate': certificate.toString('base64'),
        'edge-private-key': privateKey.toString('base64'),
      },
    }),
  );
  kube([
    'delete',
    'pod',
    '-l',
    'app.kubernetes.io/name=edge',
    '--grace-period=1',
    '--wait=true',
  ]);
  const pod = await waitFor(() => {
    const items = JSON.parse(
      kube(['get', 'pods', '-l', 'app.kubernetes.io/name=edge', '-o', 'json']),
    ).items;
    return items.find(
      (item) =>
        !before.has(item.metadata.name) && item.status.phase === 'Running',
    )?.metadata.name;
  }, 'Replacement edge pod did not start.');
  if (expectReady)
    kube(['wait', '--for=condition=Ready', `pod/${pod}`, '--timeout=120s']);
  return pod;
};
const certificateProbe = String.raw`const https=require('node:https'),fs=require('node:fs');const request=https.get({hostname:'127.0.0.1',port:8443,servername:'localhost',path:'/health/live',ca:fs.readFileSync('/run/secrets/campus-installation/edge-ca'),rejectUnauthorized:true,headers:{host:'localhost'}},response=>{response.resume();console.log(response.statusCode===200?'TLS_ACCEPTED':'HTTP_'+response.statusCode)});request.setTimeout(10000,()=>request.destroy());request.on('error',error=>console.log(error.code||'TLS_UNAVAILABLE'));`;
const certificateThrough = (pod) =>
  kube([
    'exec',
    pod,
    '--container',
    'edge',
    '--',
    'node',
    '-e',
    certificateProbe,
  ]);
const durableProbeSource = await readFile(durableProbePath, 'utf8');
const durable = () =>
  JSON.parse(
    kube(
      ['exec', '-i', 'deployment/api', '--', 'node', '--input-type=module'],
      durableProbeSource,
    ),
  );
const digest = (value) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const externalReady = async (caFile) =>
  waitFor(async () => {
    const state = await httpsStartup({
      url: edgeUrl,
      caFile,
      bootstrapFile: bootstrap,
      connectAddress: fixture.connectAddress,
    });
    return (
      state.status === 'ready' &&
      state.checks?.length === 8 &&
      state.checks.every((check) => check.status === 'ready')
    );
  }, 'Edge recovery did not restore eight ready checks.');

const startedAt = Date.now();
const ca = await readFile(join(temporary, 'ca.pem'));
const key = await readFile(join(temporary, 'server.key'));
const valid = await readFile(join(temporary, 'valid.pem'));
let primaryError;
const records = [];
let baseline;
let baselineDigest;
try {
  baseline = durable();
  assert.equal(baseline.artifact?.metadata?.length, 1);
  assert.equal(baseline.artifact.metadata[0].value.publication_state, 'ready');
  assert.equal(
    baseline.artifact.metadata[0].value.size_bytes,
    baseline.artifact.sizeBytes,
  );
  assert.equal(
    baseline.artifact.metadata[0].value.sha256,
    baseline.artifact.sha256,
  );
  assert.equal(Number.isSafeInteger(baseline.kestra?.revision), true);
  assert.ok(baseline.kestra.markerSha256);
  baselineDigest = digest(baseline);
  const originalPod = podNames()[0];
  assert.ok(originalPod);
  await externalReady(originalCaPath);
  let pod = await replace(ca, valid, key, true);
  assert.equal(certificateThrough(pod), 'TLS_ACCEPTED');
  await externalReady(join(temporary, 'ca.pem'));
  assert.deepEqual(durable(), baseline);
  for (const [name, expected] of [
    ['expired', 'CERT_HAS_EXPIRED'],
    ['wrong-host', 'ERR_TLS_CERT_ALTNAME_INVALID'],
  ]) {
    const faultStartedAt = Date.now();
    pod = await replace(
      ca,
      await readFile(join(temporary, `${name}.pem`)),
      key,
      false,
    );
    const observed = certificateThrough(pod);
    assert.equal(observed, expected);
    pod = await replace(ca, valid, key, true);
    assert.equal(certificateThrough(pod), 'TLS_ACCEPTED');
    await externalReady(join(temporary, 'ca.pem'));
    assert.deepEqual(durable(), baseline);
    records.push({
      fault: name,
      expected,
      observed,
      recovery: 'ready',
      durableFixtureSha256: baselineDigest,
      elapsedMilliseconds: Date.now() - faultStartedAt,
    });
  }
} catch (error) {
  primaryError = error;
}
let cleanupError;
try {
  const restoredPod = await replace(
    Buffer.from(original.ca, 'base64'),
    Buffer.from(original.certificate, 'base64'),
    Buffer.from(original.privateKey, 'base64'),
    true,
  );
  assert.equal(certificateThrough(restoredPod), 'TLS_ACCEPTED');
  await externalReady(originalCaPath);
  const finalDurable = durable();
  const restored = JSON.parse(
    kube(['get', 'secret', 'campus-installation', '-o', 'json']),
  );
  assert.equal(restored.data['edge-ca'], original.ca);
  assert.equal(restored.data['edge-certificate'], original.certificate);
  assert.equal(restored.data['edge-private-key'], original.privateKey);
  if (baseline) assert.deepEqual(finalDurable, baseline);
} catch (error) {
  cleanupError = error;
}
if (cleanupError) {
  process.stderr.write(
    `${JSON.stringify({ status: 'recovery-failed', retainedRecoveryPath: recoveryDirectory })}\n`,
  );
} else {
  await rm(temporary, { recursive: true, force: true });
}
if (primaryError && cleanupError)
  throw new AggregateError(
    [primaryError, cleanupError],
    'Certificate fault and recovery failed.',
  );
if (primaryError) throw primaryError;
if (cleanupError) throw cleanupError;
const result = {
  schemaVersion: 1,
  ticket: 'CC-18',
  status: 'passed',
  checkedAt: new Date().toISOString(),
  durationMs: Date.now() - startedAt,
  scope: 'kubernetes-edge-certificate-faults',
  testedReleaseSourceRevision: release.sourceRevision,
  images: release.images,
  platform: {
    kubernetesVersion: JSON.parse(kube(['version', '-o', 'json'])).serverVersion
      .gitVersion,
  },
  assertions: {
    baselineReadyChecks: 8,
    matchingKeyTlsAccepted: true,
    faultsPassed: records.length,
    durableProbeCalls: records.length + 3,
    durableComparisonsPassed: records.length + 2,
    originalSecretBytesRestored: true,
    finalReadyChecks: 8,
  },
  durableFixtures: {
    artifact: {
      sizeBytes: baseline.artifact.sizeBytes,
      sha256: baseline.artifact.sha256,
      publicationState: baseline.artifact.metadata[0].value.publication_state,
    },
    kestra: {
      revision: baseline.kestra.revision,
      markerSha256: baseline.kestra.markerSha256,
    },
  },
  records,
  boundaries: [
    'The fixture runs on one Docker host.',
    'The fault replaces only the edge listener trust and key material in an isolated namespace.',
  ],
};
await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, {
  flag: 'wx',
  mode: 0o600,
});
process.stdout.write(
  `${JSON.stringify({ status: result.status, faults: records.length })}\n`,
);

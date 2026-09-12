import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect } from '@playwright/test';
import { createKubernetesDurableProbe } from './kubernetes-durable-fixture.mjs';
import { faultRecoveryTimeoutSeconds } from '../deployment/qualification/faults.mjs';
const execute = promisify(execFile);

/** Replace only the edge certificates in an owned synthetic Kubernetes installation. */
export async function faultKubernetesCertificates({
  root,
  project,
  kube,
  release,
  upgrade,
  page,
  checks,
  startForward,
}) {
  assert.match(project, /^cc-capacity-kube-[a-f0-9]{12}$/);
  assert.ok(root.startsWith(`/tmp/${project}-`));
  assert.equal(upgrade.status, 'passed');
  const config = JSON.parse(
    await readFile(join(root, 'runtime/config.json'), 'utf8'),
  );
  assert.equal(config.profile, 'kubernetes');
  assert.equal(config.phase, 2);
  const hostname = new URL(config.applicationAuth.publicOrigin).hostname;
  assert.equal(hostname, 'campus.example.org');
  const readSecret = async () =>
    JSON.parse(
      await kube(['get', 'secret', 'campus-installation', '-o', 'json']),
    );
  const secret = await readSecret();
  assert.equal(secret.metadata.namespace, project);
  const caRef = config.services.edge.endpoint.tls.caSecretRef;
  const certRef = config.services.edge.serverTls.certificateSecretRef;
  const keyRef = config.services.edge.serverTls.privateKeySecretRef;
  for (const reference of [caRef, certRef, keyRef]) {
    assert.equal(reference.provider, 'kubernetes');
    assert.equal(reference.name, 'campus-installation');
    assert.match(reference.key, /^[a-z0-9-]+$/);
  }
  const keys = [certRef.key, keyRef.key];
  const caBytes = await readFile(join(root, 'runtime/ca.pem'));
  assert.deepEqual(caBytes, Buffer.from(secret.data[caRef.key], 'base64'));
  const original = Object.fromEntries(
    keys.map((key) => {
      assert.ok(secret.data[key]);
      return [key, secret.data[key]];
    }),
  );
  const verifyDurable = await createKubernetesDurableProbe({
    root,
    kube,
    config,
    upgrade,
  });
  const directory = await mkdtemp(join(root, 'application-tls-fault-'));
  const openssl = (...args) =>
    execute('openssl', args, { cwd: directory, timeout: 30000 });
  const pods = async () =>
    JSON.parse(
      await kube([
        'get',
        'pods',
        '-l',
        'app.kubernetes.io/name=edge',
        '-o',
        'json',
      ]),
    ).items;
  const replace = async (data) => {
    const before = new Set((await pods()).map((pod) => pod.metadata.name));
    const patchPath = join(directory, 'edge-secret-patch.json');
    await writeFile(patchPath, JSON.stringify({ data }), { mode: 0o600 });
    try {
      await kube([
        'patch',
        'secret',
        'campus-installation',
        '--type=merge',
        '--patch-file',
        patchPath,
      ]);
    } finally {
      await rm(patchPath, { force: true });
    }
    await kube([
      'delete',
      'pod',
      '-l',
      'app.kubernetes.io/name=edge',
      '--grace-period=1',
      '--wait=true',
    ]);
    let replacement;
    await expect
      .poll(
        async () => {
          replacement = (await pods()).find(
            (pod) =>
              !before.has(pod.metadata.name) &&
              !pod.metadata.deletionTimestamp &&
              pod.status.phase === 'Running',
          );
          return Boolean(replacement);
        },
        { timeout: 120000 },
      )
      .toBe(true);
    return replacement.metadata.name;
  };
  const tlsResult = async (pod) =>
    (
      await kube([
        'exec',
        pod,
        '--container',
        'edge',
        '--',
        'node',
        '-e',
        `const https=require('node:https'),fs=require('node:fs');const request=https.get({hostname:'127.0.0.1',port:8443,servername:${JSON.stringify(hostname)},path:'/health/live',ca:fs.readFileSync(${JSON.stringify('/run/secrets/campus-installation/' + caRef.key)}),rejectUnauthorized:true,headers:{host:${JSON.stringify(hostname)}}},response=>{response.resume();console.log(response.statusCode===200?'TLS_ACCEPTED':'HTTP_'+response.statusCode)});request.setTimeout(5000,()=>request.destroy());request.on('error',error=>console.log(error.code||'TLS_UNAVAILABLE'));`,
      ])
    ).trim();
  const recoverApplication = async () => {
    await startForward();
    await page.reload();
    await expect(
      page.getByRole('heading', { name: 'Diagnostics', exact: true }),
    ).toBeVisible({ timeout: 15000 });
    await checks({ recoverySeconds: faultRecoveryTimeoutSeconds });
    return verifyDurable();
  };
  const report = {
    status: 'in-progress',
    profile: 'kubernetes',
    sourceRevision: release.sourceRevision,
    images: release.images,
    recoveryBoundSeconds: faultRecoveryTimeoutSeconds,
    cases: [],
    originalSecretBytesRestored: false,
    limits: [
      'The fixture replaces the edge listener certificates in a dedicated Kind cluster.',
      'Synthetic trust and storage do not establish district certificate lifecycle or NetworkPolicy enforcement.',
    ],
  };
  const save = () =>
    writeFile(
      join(root, 'application-certificate-progress.json'),
      JSON.stringify(report, null, 2),
      { mode: 0o600 },
    );
  let failure;
  try {
    await checks();
    await verifyDurable();
    await mkdir(join(directory, 'certs'));
    await writeFile(join(directory, 'index'), '');
    await writeFile(join(directory, 'serial'), '1000\n');
    await writeFile(join(directory, 'ca.pem'), caBytes, { mode: 0o600 });
    await writeFile(
      join(directory, 'ca.key'),
      await readFile(join(root, 'runtime/ca.key')),
      { mode: 0o600 },
    );
    await openssl(
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
      `/CN=${hostname}`,
    );
    await writeFile(
      join(directory, 'ca.conf'),
      `[ca]\ndefault_ca=fixture\n[fixture]\ndatabase=index\nserial=serial\nnew_certs_dir=certs\ncertificate=ca.pem\nprivate_key=ca.key\ndefault_md=sha256\ndefault_days=1\npolicy=names\nunique_subject=no\n[names]\ncommonName=supplied\n[server]\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:${hostname}\n[wrong]\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:wrong.invalid\n`,
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
      await openssl(
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
    const encoded = async (name) =>
      (await readFile(join(directory, name))).toString('base64');
    const valid = {
      [certRef.key]: await encoded('valid.pem'),
      [keyRef.key]: await encoded('server.key'),
    };
    let pod = await replace(valid);
    await expect
      .poll(() => tlsResult(pod), { timeout: 30000 })
      .toBe('TLS_ACCEPTED');
    await recoverApplication();
    for (const [name, expected] of [
      ['expired', 'CERT_HAS_EXPIRED'],
      ['wrong-host', 'ERR_TLS_CERT_ALTNAME_INVALID'],
    ]) {
      console.log('Kubernetes application certificate fault:', name);
      const record = {
        name,
        status: 'in-progress',
        startedAt: new Date().toISOString(),
      };
      report.cases.push(record);
      await save();
      pod = await replace({
        ...valid,
        [certRef.key]: await encoded(`${name}.pem`),
      });
      await expect
        .poll(() => tlsResult(pod), { timeout: 30000 })
        .toBe(expected);
      record.tlsError = expected;
      const recoveryStarted = Date.now();
      pod = await replace(valid);
      await expect
        .poll(() => tlsResult(pod), { timeout: 30000 })
        .toBe('TLS_ACCEPTED');
      record.durableState = await recoverApplication();
      record.recoveryMs = Date.now() - recoveryStarted;
      assert.ok(record.recoveryMs <= faultRecoveryTimeoutSeconds * 1000);
      record.status = 'passed';
      await save();
    }
  } catch (error) {
    failure = error;
  }
  try {
    const pod = await replace(original);
    await expect
      .poll(() => tlsResult(pod), { timeout: 30000 })
      .toBe('TLS_ACCEPTED');
    await recoverApplication();
    const restored = await readSecret();
    assert.deepEqual(restored.data, secret.data);
    report.originalSecretBytesRestored = true;
  } catch (error) {
    failure = failure
      ? new AggregateError(
          [failure, error],
          'Certificate fault and recovery failed.',
        )
      : error;
  }
  report.status = failure ? 'failed' : 'passed';
  await save();
  await rm(directory, { recursive: true, force: true });
  if (failure) throw failure;
  return report;
}

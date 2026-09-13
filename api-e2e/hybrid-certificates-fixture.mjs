import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { expect } from '@playwright/test';
import { outerDocker } from './hybrid-hosts-fixture.mjs';
import { faultRecoveryTimeoutSeconds } from '../deployment/qualification/faults.mjs';
const execute = promisify(execFile);

/** Refresh only edge certificate files in the installer-owned runtime volume. */
export async function refreshHybridEdgeCertificates(compose, controller) {
  await compose(controller, [
    'run',
    '--rm',
    '--no-deps',
    '--entrypoint',
    'node',
    'runtime-files',
    '-e',
    "const fs=require('node:fs');for(const name of ['edge-certificate','edge-private-key']){const target='/staged/edge-secrets/'+name;fs.copyFileSync('/run/secrets/'+name,target);fs.chmodSync(target,0o600);fs.chownSync(target,1000,1000);}",
  ]);
}

/** Verify edge certificate rejection and authenticated recovery on the owned hybrid installation. */
export async function qualifyHybridCertificates({
  hosts,
  services,
  compose,
  config,
  upgrade,
  page,
  checks,
  verifyReplicas,
  context,
}) {
  const controller = hosts.hosts[0];
  assert.match(controller.name, /^cc-phase2-hybrid-[a-f0-9]{12}-controller$/);
  assert.equal(new Set(hosts.hosts.map((host) => host.daemonId)).size, 3);
  assert.equal(upgrade.status, 'passed');
  assert.equal(config.profile, 'hybrid');
  assert.equal(config.phase, 2);
  const hostname = new URL(config.applicationAuth.publicOrigin).hostname;
  assert.equal(hostname, 'campus.example.org');
  const privateRoot = services.privateRoot;
  assert.equal(privateRoot, join(controller.root, 'private'));
  const referenceNames = [
    config.services.edge.endpoint.tls.caSecretRef,
    config.services.edge.serverTls.certificateSecretRef,
    config.services.edge.serverTls.privateKeySecretRef,
  ].map((reference) => {
    assert.equal(reference.provider, 'file');
    assert.equal(reference.path, '/run/secrets/' + basename(reference.path));
    return basename(reference.path);
  });
  const [caName, certificateName, keyName] = referenceNames;
  assert.deepEqual(referenceNames, [
    'district-ca',
    'edge-certificate',
    'edge-private-key',
  ]);
  const original = new Map();
  for (const name of await readdir(privateRoot))
    original.set(name, await readFile(join(privateRoot, name)));
  const directory = await mkdtemp(
    join(controller.root, 'application-tls-fault-'),
  );
  const openssl = (...args) =>
    execute('openssl', args, { cwd: directory, timeout: 30000 });
  const replace = async (certificate, key) => {
    await writeFile(join(privateRoot, certificateName), certificate, {
      mode: 0o600,
    });
    await writeFile(join(privateRoot, keyName), key, { mode: 0o600 });
    await refreshHybridEdgeCertificates(compose, controller);
    const expected = Object.fromEntries(
      [
        [certificateName, certificate],
        [keyName, key],
        [caName, original.get(caName)],
      ].map(([name, bytes]) => [
        name,
        createHash('sha256').update(bytes).digest('hex'),
      ]),
    );
    const edge = await compose(controller, ['ps', '--quiet', 'edge']);
    const verified = await hosts.run(controller, [
      'docker',
      'exec',
      edge,
      'node',
      '-e',
      `const fs=require('node:fs'),crypto=require('node:crypto'),expected=${JSON.stringify(expected)};for(const [name,hash] of Object.entries(expected)){if(crypto.createHash('sha256').update(fs.readFileSync('/run/secrets/'+name)).digest('hex')!==hash)throw Error('Mounted edge certificate bytes differ.');}console.log('verified');`,
    ]);
    assert.equal(verified.trim(), 'verified');
    await compose(controller, ['restart', 'edge']);
  };
  const tlsResult = async () => {
    const id = await compose(controller, ['ps', '--quiet', 'edge']);
    return (
      await hosts.run(controller, [
        'docker',
        'exec',
        id,
        'node',
        '-e',
        `const https=require('node:https'),fs=require('node:fs');const request=https.get({hostname:'127.0.0.1',port:8443,servername:${JSON.stringify(hostname)},path:'/health/live',ca:fs.readFileSync('/run/secrets/${caName}'),rejectUnauthorized:true,headers:{host:${JSON.stringify(hostname)}}},response=>{response.resume();console.log(response.statusCode===200?'TLS_ACCEPTED':'HTTP_'+response.statusCode)});request.setTimeout(5000,()=>request.destroy());request.on('error',error=>console.log(error.code||'TLS_UNAVAILABLE'));`,
      ])
    ).trim();
  };
  const durable = async () => {
    const api = (await compose(controller, ['ps', '--quiet', 'api'])).split(
      '\n',
    )[0];
    const script = `import fs from 'node:fs/promises';import crypto from 'node:crypto';import pg from 'pg';
import {connectionOptions} from '/app/deployment/postgres/index.mjs';import {createArtifactStore} from '/app/deployment/storage/index.mjs';import {secretPath} from '/app/deployment/redis/runtime.mjs';
const config=JSON.parse(await fs.readFile(process.env.CC_CONFIG_FILE));
const pool=new pg.Pool(await connectionOptions(config.services.applicationDatabase,ref=>fs.readFile(secretPath(ref))));
const principals=(await pool.query('SELECT * FROM cc.application_principals ORDER BY id')).rows;
const events=(await pool.query('SELECT * FROM cc.security_events ORDER BY id')).rows;
const migrations=(await pool.query('SELECT id,checksum FROM cc.schema_migrations ORDER BY id')).rows;
const store=await createArtifactStore({pool,root:config.artifacts.location});const hash=crypto.createHash('sha256');
for await(const bytes of await store.openRead(${JSON.stringify(upgrade.artifact.artifactId)}))hash.update(bytes);
await store.close();await pool.end();console.log(JSON.stringify({principals,events,migrations,artifactSha256:hash.digest('hex')}));`;
    return JSON.parse(
      await hosts.run(
        controller,
        ['docker', 'exec', '-i', api, 'node', '--input-type=module'],
        { input: script },
      ),
    );
  };
  const executions = async () =>
    JSON.parse(
      await outerDocker([
        'exec',
        services.database,
        'psql',
        '-U',
        'postgres',
        '-d',
        config.services.kestraDatabase.database,
        '-At',
        '-c',
        "SELECT coalesce(json_agg(json_build_object('key',key,'sha256',encode(sha256(convert_to(value::text,'UTF8')),'hex')) ORDER BY key),'[]'::json) FROM public.executions WHERE state_current='SUCCESS';",
      ]),
    );
  const baseline = await durable();
  const baselineExecutions = await executions();
  assert.equal(baseline.principals.length, 1);
  assert.ok(baseline.events.length > 0);
  assert.ok(baselineExecutions.length > 0);
  assert.ok(upgrade.internalStorageFiles.length > 0);
  assert.equal(baseline.artifactSha256, upgrade.artifact.sha256);
  const verifyDurable = async () => {
    const after = await durable();
    assert.deepEqual(after.principals, baseline.principals);
    assert.deepEqual(after.migrations, baseline.migrations);
    assert.equal(after.artifactSha256, baseline.artifactSha256);
    const events = new Map(after.events.map((event) => [event.id, event]));
    for (const event of baseline.events)
      assert.deepEqual(events.get(event.id), event);
    for (const file of upgrade.internalStorageFiles)
      assert.equal(
        createHash('sha256')
          .update(
            await readFile(
              join(config.services.kestra.internalStorage.location, file.path),
            ),
          )
          .digest('hex'),
        file.sha256,
      );
    const currentExecutions = new Map(
      (await executions()).map((item) => [item.key, item.sha256]),
    );
    for (const item of baselineExecutions)
      assert.equal(currentExecutions.get(item.key), item.sha256);
    return {
      identityAndPreferencesPreserved: true,
      migrationsPreserved: true,
      preservedKestraExecutions: baselineExecutions.length,
      principalCount: after.principals.length,
      preservedSecurityEvents: baseline.events.length,
      artifactSha256: after.artifactSha256,
      internalStorageFiles: upgrade.internalStorageFiles.length,
    };
  };
  const recoverApplication = async (deadline) => {
    await page.reload();
    await expect(
      page.getByRole('heading', { name: 'Diagnostics', exact: true }),
    ).toBeVisible({ timeout: 15000 });
    await checks({
      recoverySeconds: faultRecoveryTimeoutSeconds,
      recoveryDeadline: deadline,
    });
    await verifyReplicas(context);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    return verifyDurable();
  };
  const report = {
    status: 'in-progress',
    recoveryBoundSeconds: faultRecoveryTimeoutSeconds,
    cases: [],
    originalSecretBytesRestored: false,
    limits: [
      'The fixture replaces only edge certificates in an owned distributed hybrid installation.',
      'Three Docker daemons share one physical host and synthetic district services. District certificate lifecycle requires separate qualification.',
    ],
  };
  const save = () =>
    writeFile(
      join(controller.root, 'certificate-progress.json'),
      JSON.stringify(report, null, 2),
      { mode: 0o600 },
    );
  let failure;
  try {
    await checks();
    await verifyReplicas(context);
    await verifyDurable();
    await mkdir(join(directory, 'certs'));
    await writeFile(join(directory, 'index'), '');
    await writeFile(join(directory, 'serial'), '1000\n');
    await writeFile(join(directory, 'ca.pem'), original.get(caName), {
      mode: 0o600,
    });
    await writeFile(
      join(directory, 'ca.key'),
      original.get('district-ca-private-key'),
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

    const valid = await readFile(join(directory, 'valid.pem'));
    const key = await readFile(join(directory, 'server.key'));
    await replace(valid, key);
    await expect.poll(tlsResult, { timeout: 30000 }).toBe('TLS_ACCEPTED');
    await recoverApplication(Date.now() + faultRecoveryTimeoutSeconds * 1000);
    for (const [name, expected] of [
      ['expired', 'CERT_HAS_EXPIRED'],
      ['wrong-host', 'ERR_TLS_CERT_ALTNAME_INVALID'],
    ]) {
      console.log('Distributed hybrid certificate fault:', name);
      const record = {
        name,
        status: 'in-progress',
        startedAt: new Date().toISOString(),
      };
      report.cases.push(record);
      await save();
      await replace(await readFile(join(directory, `${name}.pem`)), key);
      await expect.poll(tlsResult, { timeout: 30000 }).toBe(expected);
      record.tlsError = expected;
      const recoveryStarted = Date.now();
      await replace(valid, key);
      await expect.poll(tlsResult, { timeout: 30000 }).toBe('TLS_ACCEPTED');
      record.durableState = await recoverApplication(
        recoveryStarted + faultRecoveryTimeoutSeconds * 1000,
      );
      record.recoveryMs = Date.now() - recoveryStarted;
      assert.ok(record.recoveryMs <= faultRecoveryTimeoutSeconds * 1000);
      record.status = 'passed';
      await save();
    }
  } catch (error) {
    failure = error;
  }
  try {
    await replace(original.get(certificateName), original.get(keyName));
    await expect.poll(tlsResult, { timeout: 30000 }).toBe('TLS_ACCEPTED');
    await recoverApplication(Date.now() + faultRecoveryTimeoutSeconds * 1000);
    assert.deepEqual(
      (await readdir(privateRoot)).sort(),
      [...original.keys()].sort(),
    );
    for (const [name, bytes] of original)
      assert.deepEqual(await readFile(join(privateRoot, name)), bytes);
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

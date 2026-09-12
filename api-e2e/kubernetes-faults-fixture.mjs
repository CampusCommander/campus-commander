import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from '@playwright/test';
import { faultRecoveryTimeoutSeconds } from '../deployment/qualification/faults.mjs';

/** Verify authenticated faults inside the caller's owned Kind installation. */
export async function faultKubernetes({
  root,
  project,
  kube,
  release,
  upgrade,
  page,
  checks,
}) {
  assert.match(project, /^cc-capacity-kube-[a-f0-9]{12}$/);
  assert.ok(root.startsWith(`/tmp/${project}-`));
  assert.equal(upgrade.status, 'passed');
  const config = JSON.parse(
    await readFile(join(root, 'runtime/config.json'), 'utf8'),
  );
  assert.equal(config.profile, 'kubernetes');
  assert.equal(config.phase, 2);
  const deployments = JSON.parse(
    await kube(['get', 'deployments', '-o', 'json']),
  ).items;
  const counts = new Map(
    deployments.map((item) => {
      assert.equal(item.metadata.namespace, project);
      return [item.metadata.name, item.spec.replicas];
    }),
  );
  assert.equal(counts.get('api'), 2);
  assert.equal(counts.get('workers'), 2);
  const runApi = async (script) =>
    JSON.parse(
      await kube(
        ['exec', '-i', 'deployment/api', '--', 'node', '--input-type=module'],
        script,
      ),
    );
  const durable = () =>
    runApi(`import fs from 'node:fs/promises';import crypto from 'node:crypto';import pg from 'pg';
import {connectionOptions} from '/app/deployment/postgres/index.mjs';
import {createArtifactStore} from '/app/deployment/storage/index.mjs';
import {secretPath} from '/app/deployment/redis/runtime.mjs';
const c=JSON.parse(await fs.readFile(process.env.CC_CONFIG_FILE));
const pool=new pg.Pool(await connectionOptions(c.services.applicationDatabase,r=>fs.readFile(secretPath(r))));
const principals=(await pool.query('SELECT * FROM cc.application_principals ORDER BY id')).rows;
const events=(await pool.query('SELECT * FROM cc.security_events ORDER BY id')).rows;
const migrations=(await pool.query('SELECT id,checksum FROM cc.schema_migrations ORDER BY id')).rows;
const store=await createArtifactStore({pool,root:c.artifacts.location}),hash=crypto.createHash('sha256');
for await(const bytes of await store.openRead(${JSON.stringify(upgrade.preserved.artifactId)}))hash.update(bytes);
await store.close();await pool.end();
console.log(JSON.stringify({principals,events,migrations,artifactSha256:hash.digest('hex')}));`);
  const executions = async () =>
    JSON.parse(
      await kube([
        'exec',
        'deployment/kestra-postgres',
        '--',
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
  const internalFiles = async (
    path = join(root, 'shared/kestra-internal/kestra'),
    prefix = '',
  ) => {
    const files = [];
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (entry.isDirectory())
        files.push(
          ...(await internalFiles(join(path, entry.name), relative + '/')),
        );
      else {
        assert.ok(entry.isFile());
        files.push({
          path: relative,
          sha256: createHash('sha256')
            .update(await readFile(join(path, entry.name)))
            .digest('hex'),
        });
      }
    }
    return files.sort((a, b) => a.path.localeCompare(b.path));
  };
  const baseline = await durable(),
    baselineExecutions = await executions(),
    baselineFiles = await internalFiles();
  assert.equal(baseline.principals.length, 1);
  assert.ok(baseline.events.length > 0);
  assert.ok(baselineExecutions.length > 0);
  assert.ok(baselineFiles.length > 0);
  assert.equal(baseline.artifactSha256, upgrade.preserved.artifactSha256);
  const verifyDurable = async () => {
    const after = await durable();
    assert.deepEqual(after.principals, baseline.principals);
    assert.deepEqual(after.migrations, baseline.migrations);
    assert.equal(after.artifactSha256, baseline.artifactSha256);
    const events = new Map(after.events.map((item) => [item.id, item]));
    for (const event of baseline.events)
      assert.deepEqual(events.get(event.id), event);
    const current = new Map(
      (await executions()).map((item) => [item.key, item.sha256]),
    );
    for (const item of baselineExecutions)
      assert.equal(current.get(item.key), item.sha256);
    const files = new Map(
      (await internalFiles()).map((item) => [item.path, item.sha256]),
    );
    for (const item of baselineFiles)
      assert.equal(files.get(item.path), item.sha256);
    return {
      principalCount: after.principals.length,
      preservedSecurityEvents: baseline.events.length,
      artifactSha256: after.artifactSha256,
      preservedKestraExecutions: baselineExecutions.length,
      preservedInternalFiles: baselineFiles.length,
    };
  };
  const request = (operation) => observeKubernetesFaultRequest(page, operation);
  const permissions = (mode) =>
    kube([
      'exec',
      'deployment/workers',
      '--',
      'chmod',
      mode,
      config.artifacts.location,
    ]);
  const cases = [
    { name: 'api-interruption', service: 'api', denied: true },
    { name: 'worker-interruption', service: 'workers', operation: 'kestra' },
    {
      name: 'redis-interruption',
      service: 'redis',
      denied: true,
      freshSession: true,
    },
    {
      name: 'application-postgresql-interruption',
      service: 'application-postgres',
      denied: true,
    },
    {
      name: 'kestra-postgresql-interruption',
      service: 'kestra-postgres',
      operation: 'kestra',
    },
    { name: 'kestra-interruption', service: 'kestra', operation: 'kestra' },
    { name: 'artifact-access-loss', operation: 'artifacts' },
  ];
  const report = {
    status: 'in-progress',
    profile: 'kubernetes',
    sourceRevision: release.sourceRevision,
    images: release.images,
    recoveryBoundSeconds: faultRecoveryTimeoutSeconds,
    cases: [],
    limits: [
      'Three Kind nodes share one Docker host and synthetic storage.',
      'NetworkPolicy enforcement, capacity, and certificate faults require separate evidence.',
    ],
  };
  const save = () =>
    writeFile(
      join(root, 'application-fault-progress.json'),
      JSON.stringify(report, null, 2),
      { mode: 0o600 },
    );
  try {
    for (const fault of cases) {
      console.log('Kubernetes application fault:', fault.name);
      await checks({ recoverySeconds: faultRecoveryTimeoutSeconds });
      await verifyDurable();
      const record = {
        name: fault.name,
        status: 'in-progress',
        startedAt: new Date().toISOString(),
      };
      report.cases.push(record);
      await save();
      const started = Date.now();
      try {
        if (fault.service) {
          assert.ok(counts.get(fault.service) > 0);
          await kube(['scale', `deployment/${fault.service}`, '--replicas=0']);
          await expect
            .poll(
              async () =>
                JSON.parse(
                  await kube([
                    'get',
                    'pods',
                    '-l',
                    `app.kubernetes.io/name=${fault.service}`,
                    '-o',
                    'json',
                  ]),
                ).items.length,
              { timeout: 90000 },
            )
            .toBe(0);
        } else await permissions('000');
        record.observed = await request(fault.operation);
        if (fault.denied)
          assert.ok(
            record.observed.httpStatus >= 500 ||
              record.observed.status === 'transport-timeout',
          );
        else {
          assert.equal(record.observed.httpStatus, 201);
          assert.ok(['failed', 'timed-out'].includes(record.observed.status));
          assert.match(record.observed.correlationId, /^[a-f0-9-]{36}$/);
        }
      } finally {
        if (fault.service)
          await kube([
            'scale',
            `deployment/${fault.service}`,
            `--replicas=${counts.get(fault.service)}`,
          ]);
        else await permissions('700');
      }
      record.interruptionMs = Date.now() - started;
      const recoveryStarted = Date.now();
      if (fault.service)
        await kube([
          'rollout',
          'status',
          `deployment/${fault.service}`,
          `--timeout=${faultRecoveryTimeoutSeconds}s`,
        ]);
      if (fault.freshSession) {
        await expect
          .poll(async () => (await request()).httpStatus, { timeout: 15000 })
          .toBe(401);
        record.sourceSessionRejected = true;
        await page.goto(config.applicationAuth.publicOrigin + '/login');
        await page
          .getByRole('link', { name: 'Sign in to Campus Commander' })
          .click();
        await expect(
          page.getByRole('heading', { name: 'Your account', exact: true }),
        ).toBeVisible({ timeout: 15000 });
      } else
        await expect
          .poll(async () => (await request()).httpStatus, { timeout: 30000 })
          .toBe(200);
      await checks({
        recoverySeconds: faultRecoveryTimeoutSeconds,
        recoveryDeadline: recoveryStarted + faultRecoveryTimeoutSeconds * 1000,
      });
      record.recoveryMs = Date.now() - recoveryStarted;
      assert.ok(record.recoveryMs <= faultRecoveryTimeoutSeconds * 1000);
      record.durableState = await verifyDurable();
      record.status = 'passed';
      await save();
    }
    report.status = 'passed';
    await save();
    return report;
  } catch (error) {
    report.status = 'failed';
    await save();
    throw error;
  }
}

export const observeKubernetesFaultRequest = (
  page,
  operation,
  timeoutMs = 45000,
) =>
  page.evaluate(
    async ({ operation, timeoutMs }) => {
      let session;
      try {
        session = await fetch('/api/auth/session', {
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        if (error.name === 'TimeoutError')
          return { httpStatus: null, status: 'transport-timeout' };
        throw error;
      }
      if (!session.ok || !operation) return { httpStatus: session.status };
      const response = await fetch('/api/diagnostics/' + operation, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': (await session.json()).csrfToken,
        },
        body: '{}',
        signal: AbortSignal.timeout(timeoutMs),
      });
      const result = await response.json();
      return {
        httpStatus: response.status,
        status: result.status,
        correlationId: result.correlationId,
      };
    },
    { operation, timeoutMs },
  );

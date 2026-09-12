import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from '@playwright/test';
import { outerDocker } from './hybrid-hosts-fixture.mjs';

/** Verify process recovery against the installed distributed application. */
export async function faultDistributedHybrid({
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
  const workers = hosts.hosts.slice(1);
  assert.match(controller.name, /^cc-phase2-hybrid-[a-f0-9]{12}-controller$/);
  assert.equal(new Set(hosts.hosts.map((host) => host.daemonId)).size, 3);
  for (const name of [services.database, services.redis])
    assert.ok(name.startsWith(controller.name.replace(/controller$/, '')));
  assert.equal(
    await realpath(config.artifacts.location),
    config.artifacts.location,
  );
  assert.ok(config.artifacts.location.startsWith(hosts.shared + '/'));
  assert.equal(upgrade.status, 'passed');

  const request = (path, operation) =>
    page.evaluate(
      async ({ path, operation }) => {
        let headers;
        if (operation) {
          const session = await fetch('/api/auth/session');
          if (!session.ok) return { httpStatus: session.status };
          headers = {
            'content-type': 'application/json',
            'x-csrf-token': (await session.json()).csrfToken,
          };
        }
        const response = await fetch(path, {
          method: operation ? 'POST' : 'GET',
          headers,
          ...(operation ? { body: '{}' } : {}),
          signal: AbortSignal.timeout(45000),
        });
        let body;
        try {
          body = await response.json();
        } catch {
          /* The edge can return an empty failure response. */
        }
        return {
          httpStatus: response.status,
          status: body?.status,
          correlationId: body?.correlationId,
        };
      },
      { path, operation },
    );
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
  const baseline = await durable();
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
    return {
      principalCount: after.principals.length,
      preservedSecurityEvents: baseline.events.length,
      artifactSha256: after.artifactSha256,
      internalStorageFiles: upgrade.internalStorageFiles.length,
    };
  };
  const cases = [
    {
      name: 'api-interruption',
      interrupt: () => compose(controller, ['stop', 'api']),
      recover: () => compose(controller, ['start', 'api']),
      path: '/api/auth/session',
      denied: true,
    },
    {
      name: 'worker-host-interruption',
      interrupt: async () => {
        for (const worker of workers)
          await compose(worker, ['stop', 'workers']);
      },
      recover: async () => {
        for (const worker of workers)
          await compose(worker, ['start', 'workers']);
      },
      operation: 'kestra',
    },
    {
      name: 'external-redis-interruption',
      interrupt: () => outerDocker(['stop', services.redis]),
      recover: () => outerDocker(['start', services.redis]),
      path: '/api/auth/session',
      denied: true,
      freshSession: true,
    },
    {
      name: 'external-postgresql-interruption',
      interrupt: () => outerDocker(['stop', services.database]),
      recover: () => outerDocker(['start', services.database]),
      path: '/api/auth/session',
      denied: true,
    },
    {
      name: 'kestra-interruption',
      interrupt: () => compose(controller, ['stop', 'kestra']),
      recover: () => compose(controller, ['start', 'kestra']),
      operation: 'kestra',
    },
    {
      name: 'shared-artifact-access-loss',
      interrupt: () => chmod(config.artifacts.location, 0o000),
      recover: () => chmod(config.artifacts.location, 0o700),
      operation: 'artifacts',
    },
  ];
  const report = {
    status: 'in-progress',
    cases: [],
    limits: [
      'Process and shared-artifact access faults only. Capacity and certificate faults require separate evidence.',
    ],
  };
  const save = () =>
    writeFile(
      join(controller.root, 'fault-progress.json'),
      JSON.stringify(report, null, 2),
      { mode: 0o600 },
    );
  try {
    for (const fault of cases) {
      console.log('Distributed hybrid fault:', fault.name);
      await checks({ recoverySeconds: 120 });
      await verifyDurable();
      const record = {
        name: fault.name,
        startedAt: new Date().toISOString(),
        status: 'in-progress',
      };
      report.cases.push(record);
      await save();
      const started = Date.now();
      try {
        await fault.interrupt();
        record.observed = await request(
          fault.path ?? `/api/diagnostics/${fault.operation}`,
          fault.operation,
        );
        if (fault.denied)
          assert.ok(
            record.observed.httpStatus >= 500,
            'Dependency loss must deny protected access.',
          );
        else {
          assert.equal(record.observed.httpStatus, 201);
          assert.ok(['failed', 'timed-out'].includes(record.observed.status));
          assert.match(record.observed.correlationId, /^[a-f0-9-]{36}$/);
        }
      } finally {
        await fault.recover();
      }
      record.interruptionMs = Date.now() - started;
      await save();
      const recoveryStarted = Date.now();
      if (fault.freshSession) {
        await expect
          .poll(async () => (await request('/api/auth/session')).httpStatus, {
            timeout: 15000,
          })
          .toBe(401);
        record.sourceSessionRejected = true;
        await page.goto(config.applicationAuth.publicOrigin + '/login');
        await page
          .getByRole('link', { name: 'Sign in to Campus Commander' })
          .click();
        await expect(
          page.getByRole('heading', { name: 'Your account', exact: true }),
        ).toBeVisible({ timeout: 15000 });
      } else {
        await expect
          .poll(async () => (await request('/api/auth/session')).httpStatus, {
            timeout: 30000,
          })
          .toBe(200);
      }
      await checks({ recoverySeconds: 120 });
      record.recoveryMs = Date.now() - recoveryStarted;
      record.durableState = await verifyDurable();
      await verifyReplicas(context);
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

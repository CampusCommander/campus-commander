import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { outerDocker } from './hybrid-hosts-fixture.mjs';
import {
  assertHybridFaultOwnership,
  createHybridFaultStateProbe,
} from './phase3-hybrid-fault-state.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const tables = [
  'application_principals',
  'application_grants',
  'application_access_changes',
  'security_events',
  'schema_migrations',
  'artifacts',
  'google_connection',
  'google_credentials',
  'customer_settings_revisions',
  'school_definitions',
];

async function tree(root, relative = '') {
  assert.equal(await realpath(root), root);
  const files = [];
  for (const entry of await readdir(join(root, relative), {
    withFileTypes: true,
  })) {
    const path = join(relative, entry.name);
    if (entry.isDirectory()) files.push(...(await tree(root, path)));
    else {
      assert.ok(
        entry.isFile(),
        'Lifecycle storage samples require regular files.',
      );
      files.push({ path, sha256: hash(await readFile(join(root, path))) });
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** Require nonempty external state and exact preservation after local erasure. */
export function assertHybridExternalRetention(before, after) {
  for (const table of tables) assert.ok(before.tables[table].count > 0);
  assert.equal(before.services.length, 2);
  assert.ok(before.services.every((service) => service.running));
  assert.ok(before.artifacts.length > 0);
  assert.ok(before.kestraFiles.length > 0);
  assert.ok(before.executions.count > 0);
  assert.deepEqual(after, before);
}

/** Verify delivered lifecycle commands and the external-resource erasure boundary. */
export async function createHybridLifecycleProof(input) {
  assertHybridFaultOwnership(input);
  const {
    hosts,
    services,
    config,
    project,
    compose,
    cli,
    operatorPath,
    evidencePath,
    evidenceIdentity,
  } = input;
  const [controller, ...workers] = hosts.hosts;
  assert.equal(operatorPath, join(controller.root, 'operator.json'));
  const startedAt = Date.now();
  const report = {
    ...evidenceIdentity,
    schemaVersion: 1,
    phase: 3,
    profile: 'hybrid',
    status: 'in-progress',
    recordedAt: new Date().toISOString(),
    stages: [],
    durationScope:
      'Durable-state setup, restart, stop, uninstall, resume, and explicit erasure checks.',
    limits: [
      'Three Docker daemons share one physical host and synthetic district services.',
      'Delivered erasure removes controller-owned volumes and requires separate worker-host action.',
      'External databases, Redis, shared storage, and private operator files remain outside local volume erasure.',
      'Different-release guided update and district acceptance require separate evidence.',
    ],
  };
  const save = async () => {
    report.durationMs = Date.now() - startedAt;
    await writeFile(evidencePath, JSON.stringify(report, null, 2) + '\n', {
      mode: 0o600,
    });
  };
  let verifyDurable;
  try {
    await save();
    verifyDurable = await createHybridFaultStateProbe(input);
  } catch (error) {
    report.status = 'failed';
    await save();
    throw error;
  }
  const sqlHash = async (database, table, filter = '') =>
    JSON.parse(
      await outerDocker([
        'exec',
        services.database,
        'psql',
        '-U',
        'postgres',
        '-d',
        database,
        '-At',
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        `SELECT json_build_object('count',count(*),'sha256',encode(sha256(convert_to(coalesce(json_agg(value ORDER BY value::text)::text,'[]'),'UTF8')),'hex')) FROM (SELECT row_to_json(t) AS value FROM ${table} t ${filter}) rows;`,
      ]),
    );
  const external = async () => ({
    services: JSON.parse(
      await outerDocker(['inspect', services.database, services.redis]),
    ).map((service) => ({
      id: service.Id,
      name: service.Name,
      running: service.State.Running,
    })),
    tables: Object.fromEntries(
      await Promise.all(
        tables.map(async (table) => [
          table,
          await sqlHash(
            config.services.applicationDatabase.database,
            `cc.${table}`,
          ),
        ]),
      ),
    ),
    executions: await sqlHash(
      config.services.kestraDatabase.database,
      'public.executions',
      "WHERE state_current='SUCCESS'",
    ),
    artifacts: await tree(config.artifacts.location),
    kestraFiles: await tree(config.services.kestra.internalStorage.location),
  });
  const volumes = async (host) =>
    (
      await hosts.run(host, [
        'docker',
        'volume',
        'ls',
        '--quiet',
        '--filter',
        `label=com.docker.compose.project=${host === controller ? project : `${project}-${host.role}`}`,
      ])
    )
      .split('\n')
      .filter(Boolean)
      .sort();
  const privateFiles = async () =>
    Promise.all(hosts.hosts.map((host) => tree(join(host.root, 'private'))));
  const redisMarker = async (write = false) =>
    hosts.run(
      controller,
      [
        'docker',
        'run',
        '--rm',
        '--interactive',
        '--network',
        'host',
        '--user',
        '1000:1000',
        '--read-only',
        '--mount',
        `type=bind,source=${join(controller.root, 'deployment.json')},target=/run/config/profile.json,readonly`,
        '--mount',
        `type=bind,source=${join(controller.root, 'private')},target=/run/secrets,readonly`,
        '--entrypoint',
        'node',
        config.images.api,
        '--input-type=module',
      ],
      {
        input: `
import fs from 'node:fs/promises';import {createClient} from 'redis';import {secretPath} from '/app/deployment/redis/runtime.mjs';
const c=JSON.parse(await fs.readFile('/run/config/profile.json'));const s=c.services.redis;const u=new URL(s.endpoint.url);
const client=createClient({username:'default',password:await fs.readFile(secretPath(s.passwordSecretRef),'utf8'),disableOfflineQueue:true,socket:{host:u.hostname,port:Number(u.port||6379),connectTimeout:3000,reconnectStrategy:false,tls:true,servername:u.hostname,rejectUnauthorized:true,ca:await fs.readFile(secretPath(s.endpoint.tls.caSecretRef))}});
client.on('error',()=>{});const timeout=setTimeout(()=>process.exit(1),10000);
try {await client.connect();${write ? `await client.set('cc:qualification:${project}:retained','CC58 external Redis marker');` : ''}if(await client.get('cc:qualification:${project}:retained')!=='CC58 external Redis marker')throw new Error('Redis retention check failed.');console.log('retained');}finally{if(client.isOpen)client.destroy();clearTimeout(timeout);}
`,
      },
    );
  return {
    report,
    async verify(stage) {
      const record = { stage, status: 'in-progress' };
      report.stages.push(record);
      try {
        assert.ok(
          ['restart', 'stop-resume', 'uninstall-resume'].includes(stage),
        );
        record.durableState = await verifyDurable();
        record.status = 'passed';
        await save();
      } catch (error) {
        record.status = 'failed';
        report.status = 'failed';
        await save();
        throw error;
      }
    },
    async erase() {
      const controlVolume = `${project}-erasure-control`;
      let controlCreated = false;
      let originalOperator;
      let failure;
      const controlHash = async (write = false) =>
        hosts.run(controller, [
          'docker',
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
          config.images.api,
          '--input-type=module',
          '-e',
          `import fs from 'node:fs';import crypto from 'node:crypto';${write ? "fs.writeFileSync('/control/marker','CC58 unrelated volume: École 学校',{flag:'wx'});" : ''}console.log(crypto.createHash('sha256').update(fs.readFileSync('/control/marker')).digest('hex'));`,
        ]);
      try {
        assert.deepEqual(
          report.stages.map(({ stage, status }) => ({ stage, status })),
          ['restart', 'stop-resume', 'uninstall-resume'].map((stage) => ({
            stage,
            status: 'passed',
          })),
        );
        report.stage = 'unconfirmed-erasure';
        await save();
        const beforeUnconfirmed = await external();
        assertHybridExternalRetention(beforeUnconfirmed, beforeUnconfirmed);
        const beforeVolumes = await Promise.all(hosts.hosts.map(volumes));
        assert.ok(beforeVolumes.every((items) => items.length > 0));
        await assert.rejects(
          cli('erase'),
          (error) => JSON.parse(error.stderr).code === 'ERASURE',
        );
        assert.deepEqual(
          await Promise.all(hosts.hosts.map(volumes)),
          beforeVolumes,
        );
        assertHybridExternalRetention(beforeUnconfirmed, await external());
        report.unconfirmedErasureRejected = true;
        for (const host of workers) await compose(host, ['stop']);
        const stopped = await cli('stop');
        assert.equal(stopped.externalResourcesPreserved, true);
        assert.equal(stopped.remoteWorkerActionRequired, true);
        const workerContainers = await Promise.all(
          workers.map(async (host) =>
            (await compose(host, ['ps', '--all', '--quiet']))
              .split('\n')
              .filter(Boolean),
          ),
        );
        assert.ok(workerContainers.every((items) => items.length > 0));
        const before = await external();
        assertHybridExternalRetention(before, before);
        const secrets = await privateFiles();
        assert.equal(await redisMarker(true), 'retained');
        assert.equal(
          await hosts.run(controller, [
            'docker',
            'volume',
            'ls',
            '--quiet',
            '--filter',
            `name=^${controlVolume}$`,
          ]),
          '',
        );
        await hosts.run(controller, [
          'docker',
          'volume',
          'create',
          '--label',
          `campus-commander.qualification-owner=${project}`,
          controlVolume,
        ]);
        controlCreated = true;
        const expectedControlHash = hash('CC58 unrelated volume: École 学校');
        assert.equal(await controlHash(true), expectedControlHash);
        originalOperator = await readFile(operatorPath);
        await writeFile(
          operatorPath,
          JSON.stringify({
            ...JSON.parse(originalOperator),
            confirmErase: project,
          }),
          { mode: 0o600 },
        );
        report.stage = 'confirmed-erasure';
        await save();
        const erased = await cli('erase');
        assert.equal(erased.status, 'erased');
        assert.equal(erased.dataPreserved, false);
        assert.equal(erased.externalResourcesPreserved, true);
        assert.equal(erased.remoteWorkerActionRequired, true);
        assert.deepEqual(await volumes(controller), []);
        assert.equal(
          JSON.parse(
            await readFile(join(controller.root, 'installer-state.json')),
          ).phase,
          'erased',
        );
        assert.deepEqual(
          await Promise.all(
            workers.map(async (host) =>
              (await compose(host, ['ps', '--all', '--quiet']))
                .split('\n')
                .filter(Boolean),
            ),
          ),
          workerContainers,
        );
        assertHybridExternalRetention(before, await external());
        assert.equal(await redisMarker(), 'retained');
        assert.equal(await controlHash(), expectedControlHash);
        assert.deepEqual(await privateFiles(), secrets);
        report.stage = 'remote-worker-erasure';
        await save();
        for (const host of workers) await compose(host, ['down', '--volumes']);
        assert.ok(
          (await Promise.all(hosts.hosts.map(volumes))).every(
            (items) => items.length === 0,
          ),
        );
        assertHybridExternalRetention(before, await external());
        assert.equal(await redisMarker(), 'retained');
        assert.equal(await controlHash(), expectedControlHash);
        assert.deepEqual(await privateFiles(), secrets);
        report.erasure = {
          status: 'passed',
          controllerStatus: erased.status,
          remoteWorkerActionRequired: true,
          remoteWorkerAction:
            'Explicit fixture Compose down --volumes on each worker host.',
          ownedVolumesRemoved: hosts.hosts.map((host, index) => ({
            daemonId: host.daemonId,
            volumes: beforeVolumes[index],
          })),
          externalState: before,
          redisMarkerPreserved: true,
          privateFilesPreserved: true,
          unrelatedVolumePreserved: true,
          controlSha256: expectedControlHash,
        };
      } catch (error) {
        failure = error;
        report.status = 'failed';
      } finally {
        try {
          if (originalOperator)
            await writeFile(operatorPath, originalOperator, { mode: 0o600 });
          if (controlCreated) {
            const control = JSON.parse(
              await hosts.run(controller, [
                'docker',
                'volume',
                'inspect',
                controlVolume,
              ]),
            )[0];
            assert.equal(control.Name, controlVolume);
            assert.equal(
              control.Labels['campus-commander.qualification-owner'],
              project,
            );
            await hosts.run(controller, [
              'docker',
              'volume',
              'rm',
              controlVolume,
            ]);
          }
        } catch (error) {
          report.stage = 'cleanup';
          report.status = 'failed';
          failure ??= error;
        }
      }
      if (!failure) {
        report.stage = 'complete';
        report.status = 'passed';
      }
      await save();
      if (failure) throw failure;
      return report;
    },
  };
}

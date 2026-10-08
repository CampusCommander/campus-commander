import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { expect } from '@playwright/test';
import { createAllDockerDurableProbe } from './all-docker-faults-fixture.mjs';

const capacityOptions = 'size=16m,uid=1000,gid=1000,mode=0700';

/** Reject shared, unbounded, or incorrectly labeled artifact volumes before fault injection. */
export function assertCapacityVolume(volume, project) {
  assert.match(project, /^cc-phase3-[a-f0-9-]{12}$/);
  assert.equal(volume.Name, `${project}_artifacts`);
  assert.equal(volume.Labels?.['com.docker.compose.project'], project);
  assert.equal(volume.Labels?.['com.docker.compose.volume'], 'artifacts');
  assert.equal(volume.Driver, 'local');
  assert.deepEqual(volume.Options, {
    type: 'tmpfs',
    device: 'tmpfs',
    o: capacityOptions,
  });
}

/** Exhaust only the installed fixture's bounded artifact filesystem and verify authenticated recovery. */
export async function qualifyInstalledCapacity({
  root,
  project,
  config,
  release,
  compose,
  id,
  page,
  checks,
  evidencePath,
  evidenceIdentity,
}) {
  const startedAt = Date.now();
  const report = {
    ...evidenceIdentity,
    schemaVersion: 1,
    phase: 3,
    profile: 'all-docker',
    sourceRevision: release.sourceRevision,
    images: release.images,
    recordedAt: new Date().toISOString(),
    status: 'in-progress',
    environment: {
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
      browser: page.context().browser().version(),
    },
    durationScope:
      'Capacity setup, bounded ENOSPC, authenticated artifact failure, recovery, and preservation probes.',
    recoveryBoundSeconds: 60,
    limits: [
      'The fixture uses a disposable 16 MiB tmpfs artifact volume.',
      'This test models ENOSPC. It does not establish physical disk or power-loss durability.',
      'Preservation probes cover the capacity fault and recovery before subsequent installer lifecycle checks.',
      'Complete profile acceptance requires the other distinct lifecycle reports.',
    ],
  };
  const save = async () => {
    report.durationMs = Date.now() - startedAt;
    await writeFile(evidencePath, JSON.stringify(report, null, 2) + '\n', {
      mode: 0o600,
    });
  };
  const docker = (args, input) =>
    execFileSync('docker', args, {
      input,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
    }).trim();
  const execute = (code) =>
    docker(['exec', '-i', id('api'), 'node', '--input-type=module'], code);
  const artifacts = () =>
    JSON.parse(
      execute(`
import fs from 'node:fs/promises';import pg from 'pg';
import {connectionOptions} from '/app/deployment/postgres/index.mjs';
import {secretPath} from '/app/deployment/redis/runtime.mjs';
const c=JSON.parse(await fs.readFile(process.env.CC_CONFIG_FILE));
const pool=new pg.Pool(await connectionOptions(c.services.applicationDatabase,r=>fs.readFile(secretPath(r))));
const rows=(await pool.query('SELECT id,attempt_id,publication_state,active FROM cc.artifacts ORDER BY id')).rows;
const files=(await fs.readdir(c.artifacts.location)).filter(name=>/^[a-f0-9-]{36}\\.[a-f0-9-]{36}$/.test(name)).sort();
await pool.end();console.log(JSON.stringify({rows,files}));`),
    );
  let filled = false;
  const releaseCapacity = () =>
    execute(
      `import fs from 'node:fs/promises';const c=JSON.parse(await fs.readFile(process.env.CC_CONFIG_FILE));await fs.unlink(c.artifacts.location+'/.cc57-capacity-filler');`,
    );
  try {
    await save();
    assert.equal(config.phase, 3);
    const verifyDurable = await createAllDockerDurableProbe({
      root,
      project,
      config,
      release,
      compose,
      id,
    });
    const volume = JSON.parse(
      docker(['volume', 'inspect', `${project}_artifacts`]),
    )[0];
    assertCapacityVolume(volume, project);
    for (const service of ['api', 'workers']) {
      const container = JSON.parse(docker(['inspect', id(service)]))[0];
      const mount = container.Mounts.find(
        (item) => item.Destination === config.artifacts.location,
      );
      assert.equal(mount?.Type, 'volume');
      assert.equal(mount.Name, volume.Name);
    }
    await checks();
    const before = artifacts();
    report.capacity = JSON.parse(
      execute(`
import fs from 'node:fs';
const c=JSON.parse(fs.readFileSync(process.env.CC_CONFIG_FILE));
const before=fs.statfsSync(c.artifacts.location);
const totalBytes=Number(before.blocks)*Number(before.bsize);
if(Number(before.type)!==0x01021994 || totalBytes<1 || totalBytes>16777216)throw Error('The artifact filesystem is not the bounded fixture tmpfs.');
const file=fs.openSync(c.artifacts.location+'/.cc57-capacity-filler','wx',0o600);
const bytes=Buffer.alloc(65536,42);let writtenBytes=0,enospc=false;
try {for(let i=0;i<300;i++)writtenBytes+=fs.writeSync(file,bytes)}catch(error){if(error.code!=='ENOSPC')throw error;enospc=true}finally{fs.closeSync(file)}
if(!enospc)throw Error('The bounded artifact filesystem did not reach ENOSPC.');
const after=fs.statfsSync(c.artifacts.location);
console.log(JSON.stringify({filesystemType:Number(before.type),totalBytes,writtenBytes,availableBytesAfter:Number(after.bavail)*Number(after.bsize),enospc}));`),
    );
    filled = true;
    assert.equal(report.capacity.filesystemType, 0x01021994);
    assert.ok(report.capacity.totalBytes <= 16 * 1024 * 1024);
    assert.equal(report.capacity.enospc, true);
    assert.equal(report.capacity.availableBytesAfter, 0);
    await save();
    const card = page.getByRole('article').filter({
      has: page.getByRole('heading', {
        name: 'Artifact storage',
        exact: true,
      }),
    });
    const response = page.waitForResponse(
      (result) =>
        new URL(result.url()).pathname === '/api/diagnostics/artifacts' &&
        result.request().method() === 'POST',
    );
    await card
      .getByRole('button', { name: 'Check Artifact storage', exact: true })
      .click();
    const result = await response;
    assert.equal(result.status(), 201);
    const body = await result.json();
    assert.equal(body.status, 'failed');
    assert.match(body.correlationId, /^[a-f0-9-]{36}$/);
    report.observed = {
      httpStatus: result.status(),
      status: body.status,
      correlationId: body.correlationId,
    };
    await expect(
      card.getByText(
        'The check failed. Inspect the service configuration and retry.',
      ),
    ).toBeVisible();
    report.durableState = verifyDurable();
    const recoveryStartedAt = Date.now();
    releaseCapacity();
    filled = false;
    await checks({
      recoverySeconds: report.recoveryBoundSeconds,
      recoveryDeadline: recoveryStartedAt + report.recoveryBoundSeconds * 1000,
    });
    report.recoveryMs = Date.now() - recoveryStartedAt;
    assert.ok(report.recoveryMs <= report.recoveryBoundSeconds * 1000);
    assert.deepEqual(
      artifacts(),
      before,
      'Capacity recovery must preserve artifacts and remove failed staging records.',
    );
    report.failedDiagnosticArtifactsRemoved = true;
    report.durableState = verifyDurable();
    report.status = 'passed';
    await save();
    return report;
  } catch (error) {
    report.status = 'failed';
    await save();
    throw error;
  } finally {
    if (filled) releaseCapacity();
  }
}

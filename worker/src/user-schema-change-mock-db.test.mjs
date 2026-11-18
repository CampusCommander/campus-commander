/**
 * K16: the two Unknown insert cases of design section 7, against admin-sdk-mock and a synthetic
 * PostgreSQL (document B section 7.3).
 *
 * A transient `status` fault answers before the handler runs, so nothing applies. A `hang` past the
 * worker write timeout delays the handler, so the insert applies after the timeout. Each test checks
 * the stored schema apart from the outcome.
 *
 * Docker and the qualified image in deployment/postgres/qualification.json are required.
 * Run the file inside `nx run worker:test`.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { startMock } from '@campuscommander/admin-sdk-mock';
import { GOOGLE_CAPABILITIES } from '@campus/application-contracts';
import {
  GoogleUserReader,
  validateServiceAccount,
} from '@campus/google-connection';
import {
  loadMigrations,
  migrate,
  provision,
} from '../../deployment/postgres/index.mjs';
import { UserSchemaChangeJobs } from './user-schema-change.ts';

const qualification = JSON.parse(
  await readFile(
    new URL('../../deployment/postgres/qualification.json', import.meta.url),
    'utf8',
  ),
);
const timeout = 120_000;
const scopeOf = (id) =>
  GOOGLE_CAPABILITIES.find((capability) => capability.id === id).scope;
// The one sealed credential serves the guard read and the write (K13 scopes).
const scopes = [scopeOf('user-schemas'), scopeOf('user-schema-changes')];
const issuer = 'https://k16.example.test';
const subject = 'k16-category-jobs@example.test';

let mock;
let domain;
let credential;
let container;
let fixtureVolumes = [];
let port;
let migrator;
let runtime;
let actor;
let credentialId;

const docker = (...args) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

/** True when the named container or volume exists. */
const dockerHas = (object, name) => {
  try {
    return docker(object, 'inspect', name) !== '';
  } catch {
    return false;
  }
};

/**
 * The anonymous volume names the named container mounts.
 * A removal of the container alone keeps them, so teardown removes them by name.
 */
const mountedVolumes = (name) =>
  docker(
    'inspect',
    '--format',
    '{{range .Mounts}}{{if eq .Type "volume"}}{{println .Name}}{{end}}{{end}}',
    name,
  )
    .split('\n')
    .filter(Boolean);

async function pool(userName, database) {
  const value = new pg.Pool({
    host: '127.0.0.1',
    port,
    user: userName,
    database,
    ['password']: secret,
    max: 4,
    connectionTimeoutMillis: 2_000,
  });
  await value.query('SELECT 1');
  return value;
}

const secret = randomUUID() + randomUUID();

async function connectAdmin() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const client = new pg.Client({
      host: '127.0.0.1',
      port,
      user: 'postgres',
      database: 'postgres',
      ['password']: secret,
      connectionTimeoutMillis: 1_000,
    });
    try {
      await client.connect();
      return client;
    } catch {
      await client.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error('The synthetic PostgreSQL did not start.');
}

const cipher = { open: () => credential };

/** One accepted category job with its plan, as `cc.confirm_user_category_plan` writes them. */
async function categoryJob(schemaName) {
  const planId = randomUUID();
  await migrator.query(
    `INSERT INTO cc.user_category_plans(plan_id,customer_id,created_by,permission_version,
      generation,action,schema_id,schema_name,base_etag,body,changes,limits,phrase,digest,expires_at)
     VALUES($1,$2,$3,1,$4,'create-category',NULL,$5,NULL,$6,'[]','{}',NULL,$7,
       clock_timestamp()+interval '15 minutes')`,
    [
      planId,
      domain.customerId,
      actor,
      generation,
      schemaName,
      JSON.stringify({
        schemaName,
        displayName: `${schemaName} display`,
        fields: [
          {
            fieldName: 'Code',
            displayName: 'Code',
            fieldType: 'STRING',
            multiValued: false,
            indexed: true,
            readAccessType: 'ALL_DOMAIN_USERS',
            numericIndexingSpec: null,
          },
        ],
      }),
      'a'.repeat(64),
    ],
  );
  const jobId = randomUUID();
  const number = (
    await migrator.query("SELECT nextval('cc.job_number_cat') AS number")
  ).rows[0].number;
  await migrator.query(
    `INSERT INTO cc.jobs(job_id,display_id,customer_id,kind,scope_kind,entity_type,status,
      requested_by,generation,target_count,correlation_id)
     VALUES($1,cc.job_display_id('CAT',$2),$3,'user-schema-change','devices','user','accepted',$4,$5,1,$6)`,
    [jobId, number, domain.customerId, actor, generation, randomUUID()],
  );
  await migrator.query(
    `INSERT INTO cc.user_schema_change_jobs(job_id,plan_id,confirmed_by,confirmer_permission_version)
     VALUES($1,$2,$3,1)`,
    [jobId, planId, actor],
  );
  const admitted = (
    await runtime.query(
      'SELECT cc.admit_device_update_job($1,false) AS result',
      [domain.customerId],
    )
  ).rows[0].result;
  assert.equal(admitted.jobId, jobId);
  return { jobId, dispatchToken: admitted.dispatchToken };
}

/** The stored schema each case checks, apart from the job outcome. */
async function storedSchemas() {
  const reader = new GoogleUserReader();
  const categories = await reader.categories(
    credential,
    domain.customerId,
    AbortSignal.timeout(10_000),
  );
  return categories.map((category) => category.schemaName);
}

const jobRow = async (jobId) =>
  (
    await migrator.query('SELECT status,failure FROM cc.jobs WHERE job_id=$1', [
      jobId,
    ])
  ).rows[0];

const cachedCategories = async () =>
  (
    await migrator.query(
      'SELECT schema_name FROM cc.user_attribute_categories WHERE customer_id=$1',
      [domain.customerId],
    )
  ).rows.map((row) => row.schema_name);

let generation;

before(async () => {
  container = `cc-k16-category-${randomUUID().slice(0, 8)}`;
  docker(
    'run',
    '-d',
    '--name',
    container,
    '--label',
    'campus-commander.test=CC-K16',
    '-e',
    ['POSTGRES_PASSWORD', secret].join('='),
    '-p',
    '127.0.0.1::5432',
    qualification.image,
  );
  fixtureVolumes = mountedVolumes(container);
  port = Number(docker('port', container, '5432/tcp').split(':').at(-1));
  const admin = await connectAdmin();
  const credentials = Object.fromEntries([
    ['password', secret],
    ['migrationPassword', secret],
  ]);
  await provision(admin, {
    application: {
      database: 'cc-app',
      role: 'cc-app',
      migrationRole: 'cc-migrator',
      ...credentials,
    },
    kestra: { database: 'cc-kestra', role: 'cc-kestra', ...credentials },
  });
  await admin.end();
  migrator = await pool('cc-migrator', 'cc-app');
  await migrate(migrator, {
    runtimeRole: 'cc-app',
    migrations: await loadMigrations(),
  });
  runtime = await pool('cc-app', 'cc-app');

  mock = await startMock();
  mock.useInProcess();
  domain = await mock.createDomain({
    tier: 'small',
    seed: 'k16-category-jobs',
    customSchemas: true,
  });
  const key = mock.credential(domain.customerId, scopes);
  credential = {
    serviceAccount: validateServiceAccount(key, key.client_id),
    subject: domain.adminEmail,
  };

  actor = randomUUID();
  await migrator.query(
    `INSERT INTO cc.application_principals(id,issuer,subject,display_name)
     VALUES($1,$2,$3,'K16 category fixture')`,
    [actor, issuer, subject],
  );
  await migrator.query(
    `INSERT INTO cc.application_grants(principal_id,action,scope)
     VALUES($1,'users:schema-manage',$2)`,
    [
      actor,
      JSON.stringify({ kind: 'district', customerId: domain.customerId }),
    ],
  );
  credentialId = randomUUID();
  await migrator.query(
    `INSERT INTO cc.google_credentials(id,generation,customer_id,envelope,client_id,delegated_subject)
     VALUES($1,1,$2,$3,$4,$5)`,
    [
      credentialId,
      domain.customerId,
      JSON.stringify({
        format: 1,
        keyId: 'fixture',
        iv: 'abcdefghijklmnop',
        tag: 'abcdefghijklmnopqrstuv',
        ciphertext: 'Zml4dHVyZQ',
      }),
      key.client_id,
      domain.adminEmail,
    ],
  );
  await migrator.query(
    `INSERT INTO cc.google_connection(customer_id,credential_id,generation,observation,observed_at,
      confirmed_by,encryption_key_id)
     VALUES($1,$2,1,$3,clock_timestamp(),$4,'fixture')`,
    [
      domain.customerId,
      credentialId,
      JSON.stringify({
        customerId: domain.customerId,
        primaryDomain: domain.primaryDomain,
        domains: [
          {
            name: domain.primaryDomain,
            primary: true,
            verified: true,
            aliases: [],
          },
        ],
      }),
      actor,
    ],
  );
  generation = 1;
});

after(async () => {
  await runtime?.end().catch(() => undefined);
  await migrator?.end().catch(() => undefined);
  await mock?.close().catch(() => undefined);
  removeFixture();
});

/**
 * Remove the fixture container and the anonymous volumes the image gave it.
 * The assertions fail this file when a teardown leaves either one behind.
 */
function removeFixture() {
  if (!container) return;
  if (dockerHas('container', container)) docker('rm', '--force', container);
  for (const volume of fixtureVolumes) {
    if (dockerHas('volume', volume)) docker('volume', 'rm', volume);
  }
  assert.deepEqual(
    fixtureVolumes.filter((volume) => dockerHas('volume', volume)),
    [],
    'the fixture leaves no anonymous volume behind',
  );
  assert.equal(
    dockerHas('container', container),
    false,
    'the fixture leaves no container behind',
  );
}

test(
  'a transient insert answer applies nothing and the read-back leaves needs-review',
  { timeout },
  async () => {
    const schemaName = 'K16UnknownStatus';
    const { jobId, dispatchToken } = await categoryJob(schemaName);
    // The fault answers before the handler runs, so the insert never applies.
    await mock.control('POST', `/domains/${domain.customerId}/faults`, {
      kind: 'status',
      method: 'directory.schemas.insert',
      status: 503,
      reason: 'backendError',
      count: 1,
    });
    const jobs = new UserSchemaChangeJobs(runtime, cipher, {
      readTimeoutMilliseconds: 1_500,
    });
    const answer = await jobs.run(
      {
        customerId: domain.customerId,
        jobId,
        dispatchToken,
        correlationId: randomUUID(),
      },
      new AbortController().signal,
    );
    assert.equal(answer.outcome, 'settled');
    const job = await jobRow(jobId);
    assert.equal(job.status, 'needs-review');
    assert.equal(job.failure, 'provider-unavailable');
    // The stored schema stays absent, apart from the outcome.
    assert.equal((await storedSchemas()).includes(schemaName), false);
    assert.equal((await cachedCategories()).includes(schemaName), false);
  },
);

test(
  'a hang past the write timeout applies the insert and the read-back finds it',
  { timeout },
  async () => {
    const schemaName = 'K16UnknownHang';
    const { jobId, dispatchToken } = await categoryJob(schemaName);
    // The handler runs after the sleep, so the insert applies after the worker gave up.
    await mock.control('POST', `/domains/${domain.customerId}/faults`, {
      kind: 'hang',
      method: 'directory.schemas.insert',
      ms: 1_200,
      count: 1,
    });
    const jobs = new UserSchemaChangeJobs(runtime, cipher, {
      writeTimeoutMilliseconds: 400,
      readTimeoutMilliseconds: 6_000,
    });
    const answer = await jobs.run(
      {
        customerId: domain.customerId,
        jobId,
        dispatchToken,
        correlationId: randomUUID(),
      },
      new AbortController().signal,
    );
    assert.equal(answer.outcome, 'settled');
    const job = await jobRow(jobId);
    assert.equal(job.status, 'completed');
    // The stored schema holds the insert, apart from the outcome.
    assert.equal((await storedSchemas()).includes(schemaName), true);
    assert.equal((await cachedCategories()).includes(schemaName), true);
  },
);

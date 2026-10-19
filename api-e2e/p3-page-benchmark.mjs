import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

// The entity key of `entityKey('device', customer, id)` in application-contracts.
const entityKey = (customerId, id) => `cc:entity:device:${customerId}:${id}`;

// The page budget of design section 5.11: a 1,000-row page of full hits, measured on the
// mock stack through the API request path, with and without the reader version check.
// The caller runs this on the head revision and on the parent production files, so the
// difference is the cost of the check.
const PAGE_LIMIT = 1000;
const SAMPLES = 40;
const WARMUPS = 5;
const ENTRY_TTL_SECONDS = 3600;
const PREFIX = 'p3bench-';

const ids = () =>
  Array.from(
    { length: PAGE_LIMIT },
    (_, index) => `${PREFIX}${String(index).padStart(4, '0')}`,
  );

/** Sign in as the review administrator through the simulated provider. */
async function reviewSignIn({ request, ca, publicOrigin }) {
  const start = await request(`${publicOrigin}/api/auth/login`, { ca });
  assert.equal(start.status, 303, start.text);
  const cookie = start.headers['set-cookie'][0].split(';')[0];
  const authorize = new URL(start.headers.location);
  authorize.searchParams.set('review_identity', 'administrator');
  const granted = await request(authorize, { ca });
  assert.equal(granted.status, 303, granted.text);
  const finish = await request(new URL(granted.headers.location), {
    ca,
    cookie,
  });
  assert.equal(finish.status, 303, finish.text);
  const sessionCookie = finish.headers['set-cookie']
    ?.find((entry) => entry.startsWith('__Host-cc-session='))
    ?.split(';')[0];
  assert.ok(sessionCookie, 'The review sign-in returned no session.');
  return sessionCookie;
}

/**
 * Seed 1,000 devices and their entity values directly, then time the page request.
 *
 * The Postgres row carries serial number `DB-<id>`. The Redis value carries
 * `ENTRY-<id>`. The response must name `ENTRY-<id>` for every row, so each
 * measured row proves that its entry hit and served the record. Without the
 * version check the reader parses the bare record; with it the reader parses the
 * `{version, record}` entry. The seeder reads `cc.read_device_records` and
 * stores what it returns, so each revision stores the format its reader parses.
 */
export async function measureP3PageLatency({
  request,
  ca,
  publicOrigin,
  migrator,
  redis,
}) {
  const customer = (
    await migrator.query(
      'SELECT customer_id FROM cc.google_connection ORDER BY customer_id LIMIT 1',
    )
  ).rows[0]?.customer_id;
  assert.ok(customer, 'The mock stack holds a Google connection.');
  const deviceIds = ids();
  await migrator.query(
    'DELETE FROM cc.devices WHERE customer_id=$1 AND device_id LIKE $2',
    [customer, `${PREFIX}%`],
  );
  await migrator.query(
    `INSERT INTO cc.devices(customer_id,device_id,serial_number,model,org_unit_path,last_entity_sync,status)
     SELECT $1,id,'DB-'||id,'p3bench page','/',clock_timestamp(),'ACTIVE'
       FROM unnest($2::text[]) AS id`,
    [customer, deviceIds],
  );
  const elements = (
    await migrator.query('SELECT cc.read_device_records($1,$2) AS result', [
      customer,
      JSON.stringify(deviceIds),
    ])
  ).rows[0].result;
  assert.equal(
    elements.length,
    PAGE_LIMIT,
    'The fixture stored one element per benchmark device.',
  );
  // The head revision returns {version, record}. The parent revision returns a bare record.
  const entryFormat =
    elements[0] && typeof elements[0] === 'object' && 'record' in elements[0];
  for (const element of elements) {
    const record = entryFormat ? element.record : element;
    record.serialNumber = `ENTRY-${record.deviceId}`;
    delete record['removedAt'];
    const value = entryFormat
      ? JSON.stringify({ version: element.version, record })
      : JSON.stringify(record);
    await redis.set(entityKey(customer, record.deviceId), value, {
      EX: ENTRY_TTL_SECONDS,
    });
  }

  const cookie = await reviewSignIn({ request, ca, publicOrigin });
  const session = JSON.parse(
    (await request(`${publicOrigin}/api/auth/session`, { ca, cookie })).text,
  );
  const page = async () => {
    const response = await request(`${publicOrigin}/api/devices/query`, {
      ca,
      cookie,
      method: 'POST',
      headers: {
        origin: publicOrigin,
        'x-csrf-token': session.csrfToken,
      },
      body: {
        predicates: [
          { field: 'model', operator: 'contains', value: 'p3bench' },
        ],
        limit: PAGE_LIMIT,
      },
    });
    assert.equal(response.status, 200, response.text);
    return JSON.parse(response.text).page;
  };
  const verify = (value) => {
    assert.equal(value.rows.length, PAGE_LIMIT, 'The page returns 1,000 rows.');
    assert.equal(value.matching, PAGE_LIMIT);
    assert.equal(
      value.rows.filter((row) => row.serialNumber.startsWith('ENTRY-')).length,
      PAGE_LIMIT,
      'Every row came from its Redis value, not from its Postgres row.',
    );
  };
  for (let round = 0; round < WARMUPS; round++) verify(await page());
  const samples = [];
  for (let round = 0; round < SAMPLES; round++) {
    const started = process.hrtime.bigint();
    const value = await page();
    samples.push(Number(process.hrtime.bigint() - started) / 1e6);
    verify(value);
  }
  samples.sort((left, right) => left - right);
  const p95 = samples[Math.ceil(samples.length * 0.95) - 1];
  const record = {
    path: 'POST /api/devices/query',
    predicate: 'model contains p3bench',
    limit: PAGE_LIMIT,
    valueFormat: entryFormat ? 'entry' : 'record',
    samples: SAMPLES,
    warmups: WARMUPS,
    p95Ms: Number(p95.toFixed(2)),
    minMs: Number(samples[0].toFixed(2)),
    maxMs: Number(samples.at(-1).toFixed(2)),
  };
  await mkdir('dist/client-review', { recursive: true });
  await writeFile(
    'dist/client-review/p3-page-benchmark.json',
    `${JSON.stringify(record, null, 2)}\n`,
    { mode: 0o600 },
  );
  process.stdout.write(
    `p3 page benchmark: path=${record.path} limit=${PAGE_LIMIT} format=${record.valueFormat} samples=${SAMPLES} p95=${record.p95Ms}ms\n`,
  );
  return record;
}

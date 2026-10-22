import assert from 'node:assert/strict';
import test from 'node:test';
import { createDb, createSeeder } from './device-write-attacks.mjs';

const customer = 'C0123456';

/** A stand-in migrator: records every query and answers the scripted rows. */
const fakeMigrator = (rows = () => []) => {
  const queries = [];
  return {
    queries,
    async query(text, values = []) {
      queries.push({ text, values });
      return { rows: rows(text, values) };
    },
  };
};

test('the fixture database API exposes every helper the attacks call', () => {
  const db = createDb({ migrator: fakeMigrator(), customer });
  assert.deepEqual(Object.keys(db).sort(), [
    'appointment',
    'batches',
    'device',
    'job',
    'jobByDisplay',
    'operationFields',
    'operations',
    'overlay',
    'publications',
    'query',
    'row',
    'syncState',
    'writeJobCount',
  ]);
});

test('the operation-field helper reads the field rows of one job', async () => {
  const fieldRow = {
    operation_number: 1,
    field: 'notes',
    baseline_value: null,
    requested_value: 'Room 12',
    observed_value: 'Room 12',
  };
  const migrator = fakeMigrator(() => [fieldRow]);
  const db = createDb({ migrator, customer });
  assert.deepEqual(await db.operationFields('job-1'), [fieldRow]);
  assert.equal(migrator.queries.length, 1);
  assert.match(
    migrator.queries[0].text,
    /FROM cc\.device_update_operation_fields/,
  );
  assert.match(migrator.queries[0].text, /job_id=\$1/);
  assert.deepEqual(migrator.queries[0].values, ['job-1']);
});

/** A database stand-in for the seeder: records writes and answers its three reads. */
const seedDb = () => {
  const queries = [];
  return {
    queries,
    async query(text, values = []) {
      queries.push({ text, values });
      return { rows: [] };
    },
    async row(text, values) {
      if (text.includes('cc.application_principals'))
        return {
          id: '00000000-0000-4000-8000-000000000001',
          permission_version: 3,
        };
      if (text.includes('cc.google_connection'))
        return { customer_id: customer, generation: 1 };
      if (text.includes('FROM cc.devices'))
        return {
          serial_number: `SERIAL-${values[1]}`,
          org_unit_path: '/Schools',
        };
      return undefined;
    },
  };
};

const operationsWritten = (queries) =>
  queries.filter(({ text }) =>
    /INSERT INTO cc\.device_update_operations\b/.test(text),
  );
const fieldsWritten = (queries) =>
  queries.filter(({ text }) =>
    /INSERT INTO cc\.device_update_operation_fields\b/.test(text),
  );

test('the seeder writes one annotated location field row per operation', async () => {
  const db = seedDb();
  const seedJob = createSeeder({
    db,
    mock: { adminEmail: 'admin@example.org' },
    customer,
  });
  const seeded = await seedJob({
    devices: ['device-1', 'device-2'],
    value: 'Room 12',
    waitForStart: false,
  });

  const operations = operationsWritten(db.queries);
  const fields = fieldsWritten(db.queries);
  assert.equal(operations.length, 2);
  assert.equal(fields.length, 2);
  for (const [index, field] of fields.entries()) {
    assert.equal(field.values[0], seeded.jobId);
    assert.equal(operations[index].values[0], seeded.jobId);
    assert.equal(field.values[1], index + 1);
    assert.equal(field.values[2], 'Room 12');
    assert.equal(operations[index].values[5], 'Room 12');
    assert.match(field.text, /'annotatedLocation',NULL/);
  }
});

test('a clear seed leaves the operation and its field row without a value', async () => {
  const db = seedDb();
  const seedJob = createSeeder({
    db,
    mock: { adminEmail: 'admin@example.org' },
    customer,
  });
  await seedJob({
    devices: ['device-1'],
    value: 'ignored',
    mode: 'clear',
    waitForStart: false,
  });

  const [operation] = operationsWritten(db.queries);
  const [field] = fieldsWritten(db.queries);
  assert.equal(operation.values[5], null);
  assert.equal(field.values[2], null);
});

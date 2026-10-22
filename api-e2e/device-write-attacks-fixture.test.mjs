import assert from 'node:assert/strict';
import test from 'node:test';
import { createDb } from './device-write-attacks.mjs';

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

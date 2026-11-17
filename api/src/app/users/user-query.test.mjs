import assert from 'node:assert/strict';
import test from 'node:test';
import { userQuerySchema } from '@campus/application-contracts';
import {
  escapeLike,
  matchingAmongSql,
  refreshingSql,
  selectionCountSql,
  selectionIdsSql,
  staleCountSql,
  staleIdsSql,
  userDetailSql,
  userIdsSql,
  userOrgUnitsSql,
  userPageSql,
  userRow,
  userRowsByIdSql,
} from './user-query.ts';

const customer = 'C0123456';
const query = (value) => userPageSql(customer, userQuerySchema.parse(value));

test('the default page sorts by full name with a stable tie-break', () => {
  const { rows, count } = query({});
  assert.match(
    rows.text,
    /WHERE s\.customer_id=\$1 AND u\.removed_at IS NULL ORDER BY u\.full_name ASC NULLS LAST,u\.user_id ASC OFFSET \$2 LIMIT \$3$/,
  );
  assert.deepEqual(rows.values, [customer, 0, 100]);
  assert.deepEqual(count.values, [customer]);
});

test('paging and sorting travel as parameters and as fixed columns', () => {
  const { rows } = query({
    sort: { field: 'status', direction: 'desc' },
    offset: 200,
    limit: 250,
  });
  assert.match(
    rows.text,
    /ORDER BY CASE WHEN u\.archived THEN 'archived' WHEN u\.suspended THEN 'suspended' ELSE 'active' END DESC NULLS LAST,u\.user_id DESC OFFSET \$2 LIMIT \$3$/,
  );
  assert.deepEqual(rows.values, [customer, 200, 250]);
});

test('like wildcards in filter text match literally', () => {
  assert.equal(escapeLike('HS_04%\\'), 'HS\\_04\\%\\\\');
  const { rows } = query({
    predicates: [{ field: 'fullName', operator: 'contains', value: 'a_b' }],
  });
  assert.match(rows.text, /u\.full_name ILIKE \$2/);
  assert.equal(rows.values[1], '%a\\_b%');
});

test('filter values never enter the SQL text', () => {
  const hostile = "x'; DROP TABLE cc.users; --";
  const { rows, count } = query({
    predicates: [
      { field: 'primaryEmail', operator: 'equals', value: hostile },
      { field: 'orgUnitPath', operator: 'in', values: [`/${hostile}`] },
      {
        field: 'attribute',
        schemaName: 'StudentInfo',
        fieldName: 'Homeroom',
        operator: 'contains',
        value: hostile,
      },
    ],
  });
  assert.equal(rows.text.includes('DROP'), false);
  assert.equal(count.text.includes('DROP'), false);
});

test('each text operator answers its own clause', () => {
  const contains = query({
    predicates: [{ field: 'department', operator: 'contains', value: 'Math' }],
  });
  assert.match(contains.rows.text, /u\.department ILIKE \$2/);
  assert.equal(contains.rows.values[1], '%Math%');
  const starts = query({
    predicates: [{ field: 'title', operator: 'startsWith', value: 'Coun' }],
  });
  assert.equal(starts.rows.values[1], 'Coun%');
  const equals = query({
    predicates: [
      { field: 'primaryEmail', operator: 'equals', value: 'a@example.org' },
    ],
  });
  assert.match(equals.rows.text, /lower\(u\.primary_email\)=lower\(\$2\)/);
  const empty = query({
    predicates: [{ field: 'title', operator: 'isEmpty' }],
  });
  assert.match(empty.rows.text, /\(u\.title IS NULL OR u\.title=''\)/);
});

test('the alias filter reads each value of the list', () => {
  const contains = query({
    predicates: [{ field: 'aliases', operator: 'contains', value: 'avery' }],
  });
  assert.match(
    contains.rows.text,
    /EXISTS\(SELECT 1 FROM jsonb_array_elements_text\(u\.aliases\) a WHERE a ILIKE \$2\)/,
  );
  assert.equal(contains.rows.values[1], '%avery%');
  const equals = query({
    predicates: [
      { field: 'aliases', operator: 'equals', value: 'a@example.org' },
    ],
  });
  assert.match(equals.rows.text, /lower\(a\)=lower\(\$2\)/);
  const empty = query({
    predicates: [{ field: 'aliases', operator: 'isEmpty' }],
  });
  assert.match(empty.rows.text, /jsonb_array_length\(u\.aliases\)=0/);
});

test('organization unit, status, and two-step filters match exact sets', () => {
  const orgUnit = query({
    predicates: [
      { field: 'orgUnitPath', operator: 'in', values: ['/Students', '/'] },
    ],
  });
  assert.match(orgUnit.rows.text, /u\.org_unit_path=ANY\(\$2::text\[\]\)/);
  assert.deepEqual(orgUnit.rows.values[1], ['/Students', '/']);
  const status = query({
    predicates: [
      { field: 'status', operator: 'is', values: ['active', 'archived'] },
    ],
  });
  assert.match(
    status.rows.text,
    /CASE WHEN u\.archived THEN 'archived' WHEN u\.suspended THEN 'suspended' ELSE 'active' END=ANY\(\$2::text\[\]\)/,
  );
  const twoStep = query({
    predicates: [
      { field: 'twoStep', operator: 'is', values: ['not-enrolled'] },
    ],
  });
  assert.match(
    twoStep.rows.text,
    /CASE WHEN u\.two_step_enrolled THEN 'enrolled' ELSE 'not-enrolled' END=ANY\(\$2::text\[\]\)/,
  );
});

test('each date operator reads its own time column', () => {
  const before = query({
    predicates: [
      {
        field: 'lastLoginTime',
        operator: 'before',
        value: '2026-01-01T00:00:00.000Z',
      },
    ],
  });
  assert.match(before.rows.text, /u\.last_login_time < \$2::timestamptz/);
  assert.equal(before.rows.values[1], '2026-01-01T00:00:00.000Z');
  const after = query({
    predicates: [
      {
        field: 'creationTime',
        operator: 'after',
        value: '2026-01-01T00:00:00.000Z',
      },
    ],
  });
  assert.match(after.rows.text, /u\.creation_time >= \$2::timestamptz/);
});

test('an attribute text predicate uses the C1 ID and any entry of a list', () => {
  const { rows } = query({
    predicates: [
      {
        field: 'attribute',
        schemaName: 'StudentInfo',
        fieldName: 'Homeroom',
        operator: 'contains',
        value: 'B12',
      },
    ],
  });
  assert.match(rows.text, /u\.custom_schemas #> \$2::text\[\]/);
  assert.deepEqual(rows.values[1], ['StudentInfo', 'Homeroom']);
  assert.equal(rows.values[2], '%B12%');
  assert.match(
    rows.text,
    /EXISTS\(SELECT 1 FROM unnest\(cc\.user_attribute_values\(u\.custom_schemas #> \$2::text\[\]\)\) v WHERE v ILIKE \$3\)/,
  );
});

test('an attribute number range matches a JSON number and a numeric string', () => {
  const { rows } = query({
    predicates: [
      {
        field: 'attribute',
        schemaName: 'StudentInfo',
        fieldName: 'GradeLevel',
        operator: 'numberRange',
        from: 6,
        to: 8,
      },
    ],
  });
  assert.match(
    rows.text,
    /EXISTS\(SELECT 1 FROM unnest\(cc\.user_attribute_numbers\(u\.custom_schemas #> \$2::text\[\]\)\) n WHERE n BETWEEN cc\.user_attribute_number\(\$3\) AND cc\.user_attribute_number\(\$4\)\)/,
  );
  assert.equal(rows.values[2], '6');
  assert.equal(rows.values[3], '8');
});

test('an attribute date range compares calendar dates only', () => {
  const { rows } = query({
    predicates: [
      {
        field: 'attribute',
        schemaName: 'StaffInfo',
        fieldName: 'HireDate',
        operator: 'dateRange',
        from: '2024-01-01',
        to: '2024-12-31',
      },
    ],
  });
  assert.match(rows.text, /v ~ '\^\[0-9\]\{4\}-\[0-9\]\{2\}-\[0-9\]\{2\}\$'/);
  assert.match(rows.text, /AND v BETWEEN \$3 AND \$4\)/);
});

test('an attribute yes or no predicate compares the canonical text', () => {
  const { rows } = query({
    predicates: [
      {
        field: 'attribute',
        schemaName: 'DeviceProgram',
        fieldName: 'TakeHomeApproved',
        operator: 'is',
        value: false,
      },
    ],
  });
  assert.match(rows.text, /WHERE lower\(v\)=\$3\)/);
  assert.equal(rows.values[2], 'false');
});

test('an attribute has-a-value predicate keeps a No answer and an empty list out', () => {
  const { rows } = query({
    predicates: [
      {
        field: 'attribute',
        schemaName: 'StudentInfo',
        fieldName: 'Programs',
        operator: 'hasValue',
      },
    ],
  });
  assert.match(
    rows.text,
    /cc\.user_attribute_has_value\(u\.custom_schemas #> \$2::text\[\]\)/,
  );
  assert.deepEqual(rows.values[1], ['StudentInfo', 'Programs']);
});

test('the contract refuses an attribute name that is not a C1 name', () => {
  const refused = userQuerySchema.safeParse({
    predicates: [
      {
        field: 'attribute',
        schemaName: 'Student Info',
        fieldName: 'Homeroom',
        operator: 'hasValue',
      },
    ],
  });
  assert.equal(refused.success, false);
});

test('the stale set and the stale count use the freshness cutoff', () => {
  const cutoff = new Date('2026-11-16T00:00:00.000Z');
  const stale = staleIdsSql(customer, userQuerySchema.parse({}), null, cutoff);
  assert.match(
    stale.text,
    /AND u\.last_entity_sync<\$2::timestamptz ORDER BY u\.user_id LIMIT 100000$/,
  );
  assert.equal(stale.values[1], cutoff.toISOString());
  const count = staleCountSql(
    customer,
    userQuerySchema.parse({}),
    null,
    cutoff,
  );
  assert.match(count.text, /count\(\*\)::integer AS stale/);
});

test('the cached ID list carries the grid order and the cutoff', () => {
  const statement = userIdsSql(customer, userQuerySchema.parse({}), 100_000);
  assert.match(
    statement.text,
    /ORDER BY u\.full_name ASC NULLS LAST,u\.user_id ASC LIMIT \$2$/,
  );
  assert.equal(statement.values[1], 100_000);
});

test('the refresh state reads only a user job', () => {
  const statement = refreshingSql(customer);
  assert.match(statement.text, /entity_type='user'/);
  assert.deepEqual(statement.values, [customer]);
});

test('the selection clause joins terms, additions, and exceptions', () => {
  const selection = {
    terms: [[{ field: 'status', operator: 'is', values: ['active'] }]],
    additions: ['u2'],
    exceptions: ['u3'],
  };
  const statement = selectionCountSql(customer, selection);
  assert.match(
    statement.text,
    /\(CASE WHEN u\.archived THEN 'archived' WHEN u\.suspended THEN 'suspended' ELSE 'active' END=ANY\(\$2::text\[\]\)\)/,
  );
  assert.match(statement.text, /u\.user_id=ANY\(\$3::text\[\]\)/);
  assert.match(statement.text, /NOT u\.user_id=ANY\(\$4::text\[\]\)/);
  const ids = selectionIdsSql(customer, selection);
  assert.match(ids.text, /ORDER BY u\.user_id LIMIT \$5$/);
});

test('the selected refresh leaves a removed user in the result', () => {
  const statement = selectionIdsSql(customer, {
    terms: [],
    additions: ['u1'],
    exceptions: [],
  });
  assert.match(statement.text, /u\.user_id=ANY\(\$2::text\[\]\)/);
  assert.equal(
    statement.text.includes('u.removed_at IS NULL AND u.user_id'),
    false,
  );
});

test('matching among IDs reads the same filter clauses', () => {
  const statement = matchingAmongSql(
    customer,
    [{ field: 'title', operator: 'equals', value: 'Teacher' }],
    ['u1', 'u2'],
  );
  assert.match(statement.text, /AND u\.user_id=ANY\(\$2::text\[\]\)$/);
  assert.deepEqual(statement.values, [customer, ['u1', 'u2'], 'Teacher']);
});

test('the detail statement reads one scoped user', () => {
  const statement = userDetailSql(customer, 'u1');
  assert.match(statement.text, /WHERE s\.customer_id=\$1 AND u\.user_id=\$2$/);
  assert.deepEqual(statement.values, [customer, 'u1']);
});

test('the organization unit list counts the present users', () => {
  const statement = userOrgUnitsSql(customer);
  assert.match(
    statement.text,
    /WHERE s\.customer_id=\$1 AND u\.removed_at IS NULL GROUP BY u\.org_unit_path/,
  );
});

test('by-ids serves a record only when its entry version is current', () => {
  const statement = userRowsByIdSql(customer, [
    { userId: 'u1', version: 3 },
    { userId: 'u2', version: null },
  ]);
  assert.match(
    statement.text,
    /CASE WHEN requested\.version IS NULL OR requested\.version IS DISTINCT FROM u\.record_version THEN u\.primary_email END AS primary_email/,
  );
  assert.deepEqual(statement.values, [customer, ['u1', 'u2'], [3, null]]);
  // The fallback maps the current version, so a missing or outdated entry never becomes NaN (R1).
  assert.match(
    statement.text,
    /u\.record_version AS entry_version,u\.record_version AS record_version/,
  );
});

test('one row maps the stored user and its staleness', () => {
  const synced = '2026-11-16T00:00:00.000Z';
  const row = userRow(
    {
      user_id: 'u1',
      primary_email: 'avery@example.org',
      org_unit_path: '/Students',
      given_name: 'Robin',
      family_name: 'Avery',
      full_name: 'Robin Avery',
      suspended: false,
      suspension_reason: null,
      archived: false,
      last_login_time: null,
      creation_time: new Date(synced),
      two_step_enrolled: true,
      department: null,
      title: null,
      aliases: ['r.avery@example.org'],
      custom_schemas: { StudentInfo: { Homeroom: 'B12' } },
      last_entity_sync: new Date(synced),
      removed_at: null,
      record_version: '4',
    },
    Date.parse('2026-11-17T00:00:00.000Z'),
  );
  assert.equal(row.userId, 'u1');
  assert.equal(row.recordVersion, 4);
  assert.equal(row.stale, true);
  assert.equal(row.lastLoginTime, null);
  assert.deepEqual(row.customSchemas, { StudentInfo: { Homeroom: 'B12' } });
});

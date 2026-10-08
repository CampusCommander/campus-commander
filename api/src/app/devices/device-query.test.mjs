import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deviceGroupQuerySchema,
  deviceQuerySchema,
} from '@campus/application-contracts';
import {
  deviceDetail,
  devicePageSql,
  staleIdsSql,
  deviceRow,
  escapeLike,
  deviceGroupsSql,
  groupSelectionSql,
  deviceOrgUnitsSql,
  matchingAmongSql,
  selectedAmongSql,
  selectionCountSql,
  selectedInSql,
  deviceIdsSql,
  deviceRowsByIdSql,
  refreshingSql,
  staleCountSql,
} from './device-query.ts';

const query = (value) =>
  devicePageSql('C0123456', deviceQuerySchema.parse(value));

const batteryKey =
  "CASE WHEN s.telemetry_failure IS NOT NULL THEN 'unavailable' WHEN d.battery_status='reported' THEN d.battery_health ELSE d.battery_status END";

const hs04Selection = [
  { field: 'assetTag', operator: 'startsWith', value: 'HS-04' },
];

test('the default page sorts by serial number with a stable tie-break', () => {
  const { rows, count } = query({});
  assert.match(
    rows.text,
    /WHERE s\.customer_id=\$1 AND d\.removed_at IS NULL ORDER BY d\.serial_number ASC NULLS LAST,d\.device_id ASC OFFSET \$2 LIMIT \$3$/,
  );
  assert.deepEqual(rows.values, ['C0123456', 0, 100]);
  assert.deepEqual(count.values, ['C0123456']);
});

test('like wildcards in filter text match literally', () => {
  assert.equal(escapeLike('HS_04%\\'), 'HS\\_04\\%\\\\');
  const { rows } = query({
    predicates: [
      { field: 'assetTag', operator: 'startsWith', value: 'HS_04%' },
    ],
  });
  assert.match(rows.text, /d\.asset_tag ILIKE \$2/);
  assert.equal(rows.values[1], 'HS\\_04\\%%');
  const contains = query({
    predicates: [{ field: 'notes', operator: 'contains', value: 'a_b' }],
  });
  assert.equal(contains.rows.values[1], '%a\\_b%');
});

test('filter values never enter the SQL text', () => {
  const hostile = "x'; DROP TABLE cc.devices; --";
  const { rows, count } = query({
    predicates: [
      { field: 'serialNumber', operator: 'equals', value: hostile },
      { field: 'orgUnitPath', operator: 'in', values: [`/${hostile}`] },
    ],
  });
  assert.equal(rows.text.includes('DROP'), false);
  assert.equal(count.text.includes('DROP'), false);
});

test('organization unit filters match the chosen paths exactly', () => {
  const { rows } = query({
    predicates: [
      { field: 'orgUnitPath', operator: 'in', values: ['/School A', '/'] },
    ],
  });
  assert.match(rows.text, /AND d\.org_unit_path=ANY\(\$2::text\[\]\) ORDER BY/);
  assert.deepEqual(rows.values[1], ['/School A', '/']);
});

test('an empty set filter matches no devices', () => {
  const battery = query({
    predicates: [{ field: 'battery', operator: 'is', values: [] }],
  });
  assert.match(
    battery.rows.text,
    /WHERE s\.customer_id=\$1 AND d\.removed_at IS NULL AND FALSE ORDER BY/,
  );
  const units = query({
    predicates: [{ field: 'orgUnitPath', operator: 'in', values: [] }],
  });
  assert.deepEqual(units.rows.values[1], []);
});

test('battery filters combine Google classes and missing data with OR', () => {
  const { rows } = query({
    predicates: [
      {
        field: 'battery',
        operator: 'is',
        values: ['replace-soon', 'no-report'],
      },
    ],
  });
  assert.ok(
    rows.text.includes(
      "((s.telemetry_failure IS NULL AND d.battery_status='reported' AND d.battery_health=ANY($2::text[])) OR CASE WHEN s.telemetry_failure IS NOT NULL THEN 'unavailable' ELSE d.battery_status END=ANY($3::text[]))",
    ),
  );
  assert.deepEqual(rows.values.slice(1, 3), [['replace-soon'], ['no-report']]);
});

test('empty, date, and battery sorts use fixed expressions', () => {
  const empty = query({
    predicates: [{ field: 'assetTag', operator: 'isEmpty' }],
  });
  assert.match(empty.rows.text, /\(d\.asset_tag IS NULL OR d\.asset_tag=''\)/);
  const date = query({
    predicates: [
      {
        field: 'lastContact',
        operator: 'before',
        value: '2026-10-01T00:00:00Z',
      },
    ],
  });
  assert.match(date.rows.text, /d\.last_contact < \$2::timestamptz/);
  const battery = query({ sort: { field: 'battery', direction: 'desc' } });
  assert.match(
    battery.rows.text,
    /ORDER BY CASE WHEN s\.telemetry_failure .* END DESC NULLS LAST,d\.device_id DESC/,
  );
});

test('rows map database values to the device contract', () => {
  const base = {
    device_id: 'd1',
    serial_number: 'C0A1-7F2D',
    model: 'Lenovo 100e Gen 4',
    asset_tag: 'HS-0417',
    org_unit_path: '/School A',
    last_contact: new Date('2026-10-05T12:00:00Z'),
    annotated_location: null,
    notes: null,
    battery_status: 'reported',
    battery_health: 'replace-soon',
    battery_capacity_percent: 78,
    battery_reported_at: new Date('2026-10-05T11:00:00Z'),
    last_entity_sync: new Date('2026-10-05T12:00:00Z'),
  };
  const cutoff = Date.parse('2026-10-05T00:00:00Z');
  assert.deepEqual(deviceRow(base, cutoff).battery, {
    status: 'reported',
    health: 'replace-soon',
    capacityPercent: 78,
    reportedAt: '2026-10-05T11:00:00.000Z',
  });
  assert.equal(deviceRow(base, cutoff).lastContact, '2026-10-05T12:00:00.000Z');
  assert.deepEqual(
    deviceRow(
      { ...base, battery_status: 'unavailable', battery_health: null },
      cutoff,
    ).battery,
    {
      status: 'unavailable',
    },
  );
  const detail = deviceDetail(
    {
      ...base,
      removed_at: null,
      battery_reports: [
        {
          reportedAt: '2026-10-05T11:00:00.000Z',
          health: 'replace-soon',
          capacityPercent: 78,
        },
      ],
    },
    cutoff,
  );
  assert.equal(detail.removedAt, null);
  assert.equal(detail.batteryReports.length, 1);
});

test('a failed telemetry read makes every battery unavailable at read time', () => {
  const effective =
    "CASE WHEN s.telemetry_failure IS NOT NULL THEN 'unavailable' ELSE d.battery_status END";
  const { rows } = query({});
  assert.ok(rows.text.includes(`${effective} AS battery_status`));
  const filtered = query({
    predicates: [
      {
        field: 'battery',
        operator: 'is',
        values: ['replace-soon', 'unavailable'],
      },
    ],
  });
  assert.ok(
    filtered.rows.text.includes(
      `((s.telemetry_failure IS NULL AND d.battery_status='reported' AND d.battery_health=ANY($2::text[])) OR ${effective}=ANY($3::text[]))`,
    ),
  );
  const sorted = query({ sort: { field: 'battery', direction: 'asc' } });
  assert.match(
    sorted.rows.text,
    /ORDER BY CASE WHEN s\.telemetry_failure IS NOT NULL THEN 4 /,
  );
});

test('organization units come from the published inventory in path order', () => {
  const sql = deviceOrgUnitsSql('C0123456');
  assert.match(
    sql.text,
    /FROM cc\.device_sync_state s JOIN cc\.devices d ON d\.customer_id=s\.customer_id/,
  );
  assert.match(
    sql.text,
    /GROUP BY d\.org_unit_path ORDER BY d\.org_unit_path LIMIT 10000$/,
  );
  assert.deepEqual(sql.values, ['C0123456']);
});

const selection = {
  terms: [[{ field: 'assetTag', operator: 'startsWith', value: 'HS-04' }]],
  groups: [],
  additions: ['d9'],
  exceptions: ['d1'],
};

test('a selection holds its filter terms and additions minus exceptions', () => {
  const sql = selectionCountSql('C0123456', selection);
  assert.ok(sql.text.startsWith('SELECT count(*)::integer AS selected FROM'));
  assert.ok(
    sql.text.endsWith(
      'WHERE s.customer_id=$1 AND d.removed_at IS NULL AND (((d.asset_tag ILIKE $2) OR d.device_id=ANY($3::text[])) AND NOT d.device_id=ANY($4::text[]))',
    ),
  );
  assert.deepEqual(sql.values, ['C0123456', 'HS-04%', ['d9'], ['d1']]);
});

test('an empty selection holds nothing and an unfiltered term holds everything', () => {
  const empty = { terms: [], groups: [], additions: [], exceptions: [] };
  assert.match(selectionCountSql('C0123456', empty).text, /AND FALSE$/);
  assert.match(
    selectionCountSql('C0123456', { ...empty, terms: [[]] }).text,
    /AND \(TRUE\)$/,
  );
});

test('the selected view intersects the selection with the active filters', () => {
  const { count } = devicePageSql(
    'C0123456',
    deviceQuerySchema.parse({
      predicates: [{ field: 'model', operator: 'contains', value: 'Lenovo' }],
    }),
    selection,
  );
  assert.ok(
    count.text.endsWith(
      'WHERE s.customer_id=$1 AND d.removed_at IS NULL AND d.model ILIKE $2 AND (((d.asset_tag ILIKE $3) OR d.device_id=ANY($4::text[])) AND NOT d.device_id=ANY($5::text[]))',
    ),
  );
  assert.deepEqual(count.values, [
    'C0123456',
    '%Lenovo%',
    'HS-04%',
    ['d9'],
    ['d1'],
  ]);
});

test('membership checks bind the device IDs after the customer', () => {
  const among = selectedAmongSql('C0123456', selection, ['d1', 'd2']);
  assert.ok(
    among.text.startsWith('SELECT d.device_id FROM cc.device_sync_state s'),
  );
  assert.ok(among.text.endsWith('AND d.device_id=ANY($2::text[])'));
  assert.deepEqual(among.values.slice(0, 2), ['C0123456', ['d1', 'd2']]);
  const matching = matchingAmongSql(
    'C0123456',
    [{ field: 'model', operator: 'contains', value: 'Lenovo' }],
    ['d1'],
  );
  assert.ok(
    matching.text.endsWith(
      'WHERE s.customer_id=$1 AND d.removed_at IS NULL AND d.model ILIKE $3 AND d.device_id=ANY($2::text[])',
    ),
  );
  assert.deepEqual(matching.values, ['C0123456', ['d1'], '%Lenovo%']);
});

test('open groups narrow the device rows with exact keys', () => {
  const { rows, count } = query({
    group: { by: ['battery', 'model'], keys: ['replace-soon', ''] },
  });
  assert.ok(
    rows.text.includes(
      `WHERE s.customer_id=$1 AND d.removed_at IS NULL AND ${batteryKey}=$2 AND coalesce(d.model,'')=$3 ORDER BY`,
    ),
  );
  assert.deepEqual(rows.values, ['C0123456', 'replace-soon', '', 0, 100]);
  assert.deepEqual(count.values, ['C0123456', 'replace-soon', '']);
});

test('a group level lists its keys with device counts', () => {
  const { groups, count } = deviceGroupsSql(
    'C0123456',
    deviceGroupQuerySchema.parse({
      predicates: [{ field: 'notes', operator: 'isEmpty' }],
      group: { by: ['orgUnitPath', 'model'], keys: ['/School A'] },
      limit: 1000,
    }),
  );
  assert.equal(
    groups.text,
    "SELECT coalesce(d.model,'') AS key,count(*)::integer AS devices FROM cc.device_sync_state s JOIN cc.devices d ON d.customer_id=s.customer_id WHERE s.customer_id=$1 AND d.removed_at IS NULL AND (d.notes IS NULL OR d.notes='') AND d.org_unit_path=$2 GROUP BY 1 ORDER BY key ASC OFFSET $3 LIMIT $4",
  );
  assert.deepEqual(groups.values, ['C0123456', '/School A', 0, 1000]);
  assert.ok(
    count.text.startsWith(
      "SELECT count(DISTINCT coalesce(d.model,''))::integer AS groups,count(*)::integer AS matching FROM",
    ),
  );
  assert.deepEqual(count.values, ['C0123456', '/School A']);
});

test('battery groups follow the battery filter order', () => {
  const { groups } = deviceGroupsSql(
    'C0123456',
    deviceGroupQuerySchema.parse({ group: { by: ['battery'], keys: [] } }),
  );
  assert.ok(
    groups.text.includes(
      `GROUP BY 1 ORDER BY array_position(ARRAY['normal','replace-soon','replace-now','no-report','unavailable']::text[],${batteryKey}) OFFSET`,
    ),
  );
});

test('a selected group holds its filtered devices inside the group', () => {
  const sql = selectionCountSql('C0123456', {
    terms: [],
    groups: [
      { predicates: hs04Selection, by: ['battery'], route: ['replace-soon'] },
    ],
    additions: [],
    exceptions: [],
  });
  assert.ok(
    sql.text.endsWith(
      `WHERE s.customer_id=$1 AND d.removed_at IS NULL AND ((d.asset_tag ILIKE $2 AND ${batteryKey}=$3))`,
    ),
  );
  assert.deepEqual(sql.values, ['C0123456', 'HS-04%', 'replace-soon']);
});

test('group lookups bind the group after the filters', () => {
  const matching = matchingAmongSql('C0123456', [], ['d1'], {
    by: ['orgUnitPath'],
    keys: ['/School A'],
  });
  assert.ok(
    matching.text.endsWith(
      'WHERE s.customer_id=$1 AND d.removed_at IS NULL AND d.org_unit_path=$3 AND d.device_id=ANY($2::text[])',
    ),
  );
  const selected = selectedInSql(
    'C0123456',
    { terms: [[]], groups: [], additions: [], exceptions: ['d1'] },
    [],
    { by: ['orgUnitPath'], keys: ['/School A'] },
  );
  assert.ok(
    selected.text.endsWith(
      'WHERE s.customer_id=$1 AND d.removed_at IS NULL AND d.org_unit_path=$2 AND ((TRUE) AND NOT d.device_id=ANY($3::text[]))',
    ),
  );
});

test('group selection matches the joined route text instead of splitting it', () => {
  const sql = groupSelectionSql(
    'C0123456',
    { terms: [], groups: [], additions: ['d9'], exceptions: [] },
    [],
    ['battery', 'model'],
    ['replace-soon|Lenovo | 100e'],
  );
  const route = `concat_ws('|',${batteryKey},coalesce(d.model,''))`;
  assert.equal(
    sql.text,
    `SELECT ${route} AS route,bool_and((d.device_id=ANY($3::text[]))) AS selected FROM cc.device_sync_state s JOIN cc.devices d ON d.customer_id=s.customer_id WHERE s.customer_id=$1 AND d.removed_at IS NULL GROUP BY ${batteryKey},coalesce(d.model,'') HAVING ${route}=ANY($2::text[])`,
  );
  assert.deepEqual(sql.values, [
    'C0123456',
    ['replace-soon|Lenovo | 100e'],
    ['d9'],
  ]);
});

test('stale IDs cover the whole result set below the cutoff', () => {
  const cutoff = new Date('2026-10-05T12:00:00.000Z');
  const sql = staleIdsSql(
    'C0123456',
    deviceQuerySchema.parse({
      predicates: hs04Selection,
      offset: 300,
      limit: 100,
    }),
    null,
    cutoff,
  );
  assert.match(
    sql.text,
    /^SELECT d\.device_id FROM cc\.device_sync_state s JOIN cc\.devices d ON d\.customer_id=s\.customer_id WHERE s\.customer_id=\$1 AND d\.removed_at IS NULL AND d\.asset_tag ILIKE \$2 AND d\.last_entity_sync<\$3::timestamptz ORDER BY d\.device_id LIMIT 100000$/,
  );
  assert.deepEqual(sql.values, ['C0123456', 'HS-04%', cutoff.toISOString()]);
});

test('rows report freshness against the cutoff and details report removal', () => {
  const cutoff = Date.parse('2026-10-05T12:00:00.000Z');
  const base = {
    device_id: 'd1',
    serial_number: 'S',
    model: null,
    asset_tag: null,
    org_unit_path: '/',
    last_contact: null,
    annotated_location: null,
    notes: null,
    battery_status: 'no-report',
    battery_health: null,
    battery_capacity_percent: null,
    battery_reported_at: null,
  };
  const fresh = deviceRow(
    { ...base, last_entity_sync: new Date('2026-10-05T12:00:00.000Z') },
    cutoff,
  );
  assert.equal(fresh.stale, false);
  assert.equal(fresh.lastEntitySync, '2026-10-05T12:00:00.000Z');
  assert.equal(
    deviceRow(
      { ...base, last_entity_sync: new Date('2026-10-05T11:00:00.000Z') },
      cutoff,
    ).stale,
    true,
  );
  const detail = deviceDetail(
    {
      ...base,
      last_entity_sync: new Date('2026-10-06T00:00:00.000Z'),
      removed_at: new Date('2026-10-06T01:00:00.000Z'),
      battery_reports: [],
    },
    cutoff,
  );
  assert.equal(detail.removedAt, '2026-10-06T01:00:00.000Z');
  assert.equal('observedAt' in detail, false);
});

test('the cached ID list follows the grid order and binds the limit last', () => {
  const sql = deviceIdsSql(
    'C0123456',
    deviceQuerySchema.parse({
      predicates: hs04Selection,
      sort: { field: 'battery', direction: 'desc' },
      offset: 300,
      limit: 100,
    }),
    100000,
  );
  assert.match(
    sql.text,
    /^SELECT d\.device_id FROM cc\.device_sync_state s JOIN cc\.devices d ON d\.customer_id=s\.customer_id WHERE s\.customer_id=\$1 AND d\.removed_at IS NULL AND d\.asset_tag ILIKE \$2 ORDER BY CASE .* END DESC NULLS LAST,d\.device_id DESC LIMIT \$3$/,
  );
  assert.deepEqual(sql.values, ['C0123456', 'HS-04%', 100000]);
  assert.doesNotMatch(sql.text, /OFFSET/);
});

test('an open group narrows the cached ID list', () => {
  const sql = deviceIdsSql(
    'C0123456',
    deviceQuerySchema.parse({
      group: { by: ['model'], keys: ['Lenovo 100e'] },
    }),
    10,
  );
  assert.match(
    sql.text,
    /AND coalesce\(d\.model,''\)=\$2 ORDER BY d\.serial_number ASC NULLS LAST,d\.device_id ASC LIMIT \$3$/,
  );
  assert.deepEqual(sql.values, ['C0123456', 'Lenovo 100e', 10]);
});

test('rows by ID include removed devices and bind the IDs as one array', () => {
  const sql = deviceRowsByIdSql('C0123456', ['d2', 'd1']);
  assert.match(
    sql.text,
    /,d\.removed_at FROM cc\.device_sync_state s JOIN cc\.devices d ON d\.customer_id=s\.customer_id WHERE s\.customer_id=\$1 AND d\.device_id=ANY\(\$2::text\[\]\)$/,
  );
  assert.doesNotMatch(sql.text, /removed_at IS NULL/);
  assert.deepEqual(sql.values, ['C0123456', ['d2', 'd1']]);
});

test('the stale count covers the whole result set below the cutoff', () => {
  const cutoff = new Date('2026-10-05T12:00:00.000Z');
  const sql = staleCountSql(
    'C0123456',
    deviceQuerySchema.parse({ predicates: hs04Selection, offset: 300 }),
    null,
    cutoff,
  );
  assert.match(
    sql.text,
    /^SELECT count\(\*\)::integer AS stale FROM cc\.device_sync_state s JOIN cc\.devices d ON d\.customer_id=s\.customer_id WHERE s\.customer_id=\$1 AND d\.removed_at IS NULL AND d\.asset_tag ILIKE \$2 AND d\.last_entity_sync<\$3::timestamptz$/,
  );
  assert.deepEqual(sql.values, ['C0123456', 'HS-04%', cutoff.toISOString()]);
});

test('a refresh counts as running until it finishes or turns two hours old', () => {
  const sql = refreshingSql('C0123456');
  assert.match(
    sql.text,
    /^SELECT EXISTS\(SELECT 1 FROM cc\.entity_sync_jobs WHERE customer_id=\$1 AND finished_at IS NULL AND created_at>clock_timestamp\(\)-interval '2 hours'\) AS refreshing$/,
  );
  assert.deepEqual(sql.values, ['C0123456']);
});

test('removed devices never read as stale', () => {
  const cutoff = Date.parse('2026-10-05T12:00:00.000Z');
  const old = {
    device_id: 'd1',
    serial_number: 'S',
    model: null,
    asset_tag: null,
    org_unit_path: '/',
    last_contact: null,
    annotated_location: null,
    notes: null,
    battery_status: 'no-report',
    battery_health: null,
    battery_capacity_percent: null,
    battery_reported_at: null,
    last_entity_sync: new Date('2026-10-01T00:00:00.000Z'),
  };
  const removed = deviceRow(
    { ...old, removed_at: new Date('2026-10-04T00:00:00.000Z') },
    cutoff,
  );
  assert.equal(removed.stale, false);
  assert.equal('removedAt' in removed, false);
  assert.equal(deviceRow({ ...old, removed_at: null }, cutoff).stale, true);
});

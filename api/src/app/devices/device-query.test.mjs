import assert from 'node:assert/strict';
import test from 'node:test';
import { deviceQuerySchema } from '@campus/application-contracts';
import {
  deviceDetail,
  devicePageSql,
  deviceRow,
  escapeLike,
  deviceOrgUnitsSql,
  matchingAmongSql,
  selectedAmongSql,
  selectionCountSql,
} from './device-query.ts';

const query = (value) =>
  devicePageSql('C0123456', deviceQuerySchema.parse(value));

test('the default page sorts by serial number with a stable tie-break', () => {
  const { rows, count } = query({});
  assert.match(
    rows.text,
    /WHERE s\.customer_id=\$1 ORDER BY d\.serial_number ASC NULLS LAST,d\.device_id ASC OFFSET \$2 LIMIT \$3$/,
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
  assert.match(battery.rows.text, /WHERE s\.customer_id=\$1 AND FALSE ORDER BY/);
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
  };
  assert.deepEqual(deviceRow(base).battery, {
    status: 'reported',
    health: 'replace-soon',
    capacityPercent: 78,
    reportedAt: '2026-10-05T11:00:00.000Z',
  });
  assert.equal(deviceRow(base).lastContact, '2026-10-05T12:00:00.000Z');
  assert.deepEqual(
    deviceRow({ ...base, battery_status: 'unavailable', battery_health: null })
      .battery,
    {
      status: 'unavailable',
    },
  );
  const detail = deviceDetail({
    ...base,
    observed_at: new Date('2026-10-05T12:05:00Z'),
    battery_reports: [
      {
        reportedAt: '2026-10-05T11:00:00.000Z',
        health: 'replace-soon',
        capacityPercent: 78,
      },
    ],
  });
  assert.equal(detail.observedAt, '2026-10-05T12:05:00.000Z');
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
    /FROM cc\.device_sync_state s JOIN cc\.devices d ON d\.sync_id=s\.current_sync_id/,
  );
  assert.match(
    sql.text,
    /GROUP BY d\.org_unit_path ORDER BY d\.org_unit_path LIMIT 10000$/,
  );
  assert.deepEqual(sql.values, ['C0123456']);
});

const selection = {
  terms: [[{ field: 'assetTag', operator: 'startsWith', value: 'HS-04' }]],
  additions: ['d9'],
  exceptions: ['d1'],
};

test('a selection holds its filter terms and additions minus exceptions', () => {
  const sql = selectionCountSql('C0123456', selection);
  assert.ok(sql.text.startsWith('SELECT count(*)::integer AS selected FROM'));
  assert.ok(
    sql.text.endsWith(
      'WHERE s.customer_id=$1 AND (((d.asset_tag ILIKE $2) OR d.device_id=ANY($3::text[])) AND NOT d.device_id=ANY($4::text[]))',
    ),
  );
  assert.deepEqual(sql.values, ['C0123456', 'HS-04%', ['d9'], ['d1']]);
});

test('an empty selection holds nothing and an unfiltered term holds everything', () => {
  const empty = { terms: [], additions: [], exceptions: [] };
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
      'WHERE s.customer_id=$1 AND d.model ILIKE $2 AND (((d.asset_tag ILIKE $3) OR d.device_id=ANY($4::text[])) AND NOT d.device_id=ANY($5::text[]))',
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
  assert.ok(among.text.startsWith('SELECT d.device_id FROM cc.device_sync_state s'));
  assert.ok(among.text.endsWith('AND d.device_id=ANY($2::text[])'));
  assert.deepEqual(among.values.slice(0, 2), ['C0123456', ['d1', 'd2']]);
  const matching = matchingAmongSql(
    'C0123456',
    [{ field: 'model', operator: 'contains', value: 'Lenovo' }],
    ['d1'],
  );
  assert.ok(
    matching.text.endsWith(
      'WHERE s.customer_id=$1 AND d.model ILIKE $3 AND d.device_id=ANY($2::text[])',
    ),
  );
  assert.deepEqual(matching.values, ['C0123456', ['d1'], '%Lenovo%']);
});

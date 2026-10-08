import assert from 'node:assert/strict';
import test from 'node:test';
import { reserveHybridNetworks } from './hybrid-network-fixture.mjs';

test('daemon networks exclude outer bridges, broader private networks, and individual provider addresses', () => {
  const result = reserveHybridNetworks([
    '172.17.0.0/16',
    '10.200.0.0/15',
    '10.202.30.40/32',
    'fd00::/64',
  ]);
  assert.deepEqual(
    result.map((network) => network.pool),
    ['10.203.0.0/16', '10.204.0.0/16', '10.205.0.0/16'],
  );
  assert.equal(new Set(result.map((network) => network.bridge)).size, 3);
});

test('daemon networks use another private range when the district occupies 10/8', () => {
  assert.deepEqual(
    reserveHybridNetworks(['10.0.0.0/8', '172.16.0.0/14']).map(
      (network) => network.pool,
    ),
    ['172.20.0.0/16', '172.21.0.0/16', '172.22.0.0/16'],
  );
});

test('daemon networks reject exhausted or invalid input instead of sharing a route', () => {
  assert.throws(
    () =>
      reserveHybridNetworks(['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']),
    /unused private address ranges/,
  );
  assert.throws(() => reserveHybridNetworks(['999.0.0.0/16']));
});

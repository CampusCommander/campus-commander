import assert from 'node:assert/strict';

function range(cidr) {
  const [address, prefix] = cidr.split('/');
  const octets = address.split('.').map(Number);
  assert.equal(octets.length, 4);
  assert.ok(
    octets.every(
      (value) => Number.isInteger(value) && value >= 0 && value <= 255,
    ),
  );
  const bits = Number(prefix);
  assert.ok(Number.isInteger(bits) && bits >= 0 && bits <= 32);
  const value = octets.reduce((total, octet) => total * 256 + octet, 0);
  const size = 2 ** (32 - bits);
  const first = Math.floor(value / size) * size;
  return { first, last: first + size - 1 };
}

/** Reserve private daemon ranges outside the outer Docker networks. */
export function reserveHybridNetworks(outerSubnets, count = 3) {
  const occupied = outerSubnets
    .filter((cidr) => !cidr.includes(':'))
    .map(range);
  const candidates = [
    ...Array.from({ length: 256 }, (_, index) => `10.${(200 + index) % 256}`),
    ...Array.from({ length: 16 }, (_, index) => `172.${16 + index}`),
    '192.168',
  ];
  const result = [];
  for (const prefix of candidates) {
    const pool = `${prefix}.0.0/16`;
    const candidate = range(pool);
    if (
      occupied.some(
        (used) => candidate.first <= used.last && used.first <= candidate.last,
      )
    )
      continue;
    occupied.push(candidate);
    result.push({ bridge: `${prefix}.0.1/24`, pool });
    if (result.length === count) return result;
  }
  throw new Error(
    'The fixture requires unused private address ranges for its Docker daemons.',
  );
}

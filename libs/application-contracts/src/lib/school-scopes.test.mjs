import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveSchoolScope,
  effectiveSchoolScope,
  SCHOOL_REFERENCE_MAX_AGE_MS,
} from './school-scopes.ts';

const now = Date.now();
const unit = (id, name, parentId, path) => ({ id, name, parentId, path });
const observation = {
  customerId: 'C0123456',
  generation: 1,
  revision: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  observedAt: new Date(now).toISOString(),
  verified: true,
  complete: true,
  units: [
    unit('root', 'Root', null, '/'),
    unit('a', 'A', 'root', '/A'),
    unit('b', 'B', 'root', '/B'),
    unit('staff', 'Staff', 'a', '/A/Staff'),
    unit('students', 'Students', 'a', '/A/Students'),
    unit('shared', 'Shared', 'b', '/B/Shared'),
  ],
};
const rules = {
  include: [
    { id: 'a', descendants: true },
    { id: 'shared', descendants: false },
  ],
  exclude: [{ id: 'staff', descendants: true }],
};
const input = {
  observation,
  rules,
  customerId: observation.customerId,
  generation: 1,
  now,
};

test('multiple explicit inclusions union while exclusions take precedence', () => {
  assert.deepEqual(resolveSchoolScope(input), {
    valid: true,
    ids: ['a', 'shared', 'students'],
  });
  assert.deepEqual(
    resolveSchoolScope({
      ...input,
      rules: { include: [{ id: 'a', descendants: false }], exclude: [] },
    }),
    { valid: true, ids: ['a'] },
  );
});
test('scope evaluation rejects stale, future, incomplete, retired, and cross-customer observations', () => {
  for (const [patch, reason] of [
    [{ customerId: 'Cother' }, 'wrong-customer'],
    [{ generation: 2 }, 'retired-generation'],
    [
      { observedAt: new Date(now - SCHOOL_REFERENCE_MAX_AGE_MS).toISOString() },
      'stale-reference',
    ],
    [{ observedAt: new Date(now + 1).toISOString() }, 'stale-reference'],
    [{ complete: false }, 'invalid-reference'],
    [{ verified: false }, 'invalid-reference'],
  ])
    assert.deepEqual(
      resolveSchoolScope({
        ...input,
        observation: { ...observation, ...patch },
      }),
      { valid: false, reason },
    );
});
test('missing references, duplicate rules, empty results, cycles and malformed paths deny', () => {
  for (const altered of [
    [...observation.units, observation.units[0]],
    observation.units.map((u) =>
      u.id === 'a' ? { ...u, parentId: 'missing' } : u,
    ),
    observation.units.map((u) =>
      u.id === 'a' ? { ...u, parentId: 'staff' } : u,
    ),
    observation.units.map((u) =>
      u.id === 'staff' ? { ...u, path: '/wrong' } : u,
    ),
    observation.units.filter((u) => u.id !== 'root'),
  ])
    assert.deepEqual(
      resolveSchoolScope({
        ...input,
        observation: { ...observation, units: altered },
      }),
      { valid: false, reason: 'invalid-reference' },
    );
  assert.deepEqual(
    resolveSchoolScope({
      ...input,
      rules: { include: [{ id: 'missing', descendants: true }], exclude: [] },
    }),
    { valid: false, reason: 'missing-reference' },
  );
  assert.deepEqual(
    resolveSchoolScope({
      ...input,
      rules: { ...rules, exclude: [rules.include[0]] },
    }),
    { valid: false, reason: 'invalid-rules' },
  );
  assert.deepEqual(
    resolveSchoolScope({
      ...input,
      rules: {
        include: [{ id: 'staff', descendants: false }],
        exclude: [{ id: 'a', descendants: true }],
      },
    }),
    { valid: false, reason: 'empty-scope' },
  );
});
test('path renames preserve identities and new descendants cannot expand the approved set', () => {
  const approvedIds = resolveSchoolScope(input).ids;
  const renamed = observation.units.map((u) =>
    u.id === 'a'
      ? { ...u, name: 'Renamed', path: '/Renamed' }
      : u.parentId === 'a'
        ? { ...u, path: u.path.replace('/A/', '/Renamed/') }
        : u,
  );
  const changed = {
    ...observation,
    units: [...renamed, unit('new', 'New', 'a', '/Renamed/New')],
  };
  assert.deepEqual(
    effectiveSchoolScope({ ...input, observation: changed, approvedIds }),
    { valid: true, ids: approvedIds },
  );
  assert.deepEqual(resolveSchoolScope({ ...input, observation: changed }), {
    valid: true,
    ids: ['a', 'new', 'shared', 'students'],
  });
});
test('reparented references leave the effective set and stale failures preserve caller-owned definitions', () => {
  const approvedIds = resolveSchoolScope(input).ids;
  const original = structuredClone({ rules, approvedIds });
  const units = observation.units.map((u) =>
    u.id === 'students' ? { ...u, parentId: 'b', path: '/B/Students' } : u,
  );
  assert.deepEqual(
    effectiveSchoolScope({
      ...input,
      observation: { ...observation, units },
      approvedIds,
    }),
    { valid: true, ids: ['a', 'shared'] },
  );
  assert.equal(
    effectiveSchoolScope({
      ...input,
      now: now + SCHOOL_REFERENCE_MAX_AGE_MS,
      approvedIds,
    }).valid,
    false,
  );
  assert.deepEqual({ rules, approvedIds }, original);
});

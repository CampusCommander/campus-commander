import assert from 'node:assert/strict';
import test from 'node:test';
import { sessionResponseSchema } from './application-contracts.ts';
import {
  actionSchema,
  grantsForPreset,
  grantSchema,
  isAuthorized,
} from './authorization.ts';

const platform = { kind: 'platform' };
const district = { kind: 'district', customerId: 'C012345' };
const school = {
  kind: 'school',
  customerId: district.customerId,
  schoolId: '00000000-0000-4000-8000-000000000001',
};

test('existing users and unknown actions receive no implicit Phase 3 access', () => {
  for (const action of actionSchema.options)
    assert.equal(isAuthorized([], action, platform), false);
  const grants = grantsForPreset('platform-administrator', platform);
  assert.equal(isAuthorized(grants, 'inventory:write', platform), false);
  assert.equal(
    isAuthorized(grants, 'customer:read', { kind: 'district' }),
    false,
  );
  assert.equal(
    isAuthorized([{ action: '*', scope: platform }], 'customer:read', district),
    false,
  );
});

test('platform grants cover supported resources without wildcard actions', () => {
  const grants = grantsForPreset('platform-administrator', platform);
  for (const action of actionSchema.options)
    assert.equal(isAuthorized(grants, action, platform), true);
  assert.equal(isAuthorized(grants, 'schools:read', school), true);
  assert.equal(isAuthorized(grants, 'connection:manage', district), false);
});

test('district grants cannot cross customer or platform boundaries', () => {
  const grants = grantsForPreset('district-administrator', district);
  assert.equal(isAuthorized(grants, 'customer:write', district), true);
  assert.equal(isAuthorized(grants, 'schools:read', school), true);
  assert.equal(
    isAuthorized(grants, 'schools:read', { ...school, customerId: 'Cother' }),
    false,
  );
  for (const action of [
    'connection:manage',
    'platform-users:invite',
    'platform-users:manage',
  ])
    assert.equal(isAuthorized(grants, action, platform), false);
  assert.equal(
    grantSchema.safeParse({ action: 'connection:manage', scope: district })
      .success,
    false,
  );
});

test('school grants require the exact school and customer without path inference', () => {
  const grants = grantsForPreset('school-administrator', school);
  assert.equal(isAuthorized(grants, 'schools:read', school), true);
  assert.equal(isAuthorized(grants, 'schools:read', district), false);
  assert.equal(
    isAuthorized(grants, 'schools:read', {
      ...school,
      schoolId: '00000000-0000-4000-8000-000000000002',
    }),
    false,
  );
  assert.equal(
    isAuthorized(grants, 'schools:read', { ...school, customerId: 'Cother' }),
    false,
  );
  assert.equal(isAuthorized(grants, 'schools:manage', school), false);
});

test('the device write actions take platform and district scopes', () => {
  for (const action of [
    'devices:write',
    'devices:commands',
    'devices:status',
    'devices:bulk-actions',
    'jobs:read',
  ]) {
    assert.ok(
      actionSchema.options.includes(action),
      `${action} is a declared action`,
    );
    for (const scope of [platform, district])
      assert.equal(grantSchema.safeParse({ action, scope }).success, true);
    assert.equal(
      grantSchema.safeParse({ action, scope: school }).success,
      false,
    );
  }
});

test('jobs:manage takes the scopes of jobs:read', () => {
  // None of the actions above, so it must parse at the platform and district scopes.
  for (const scope of [platform, district])
    assert.equal(
      grantSchema.safeParse({ action: 'jobs:manage', scope }).success,
      true,
    );
  assert.equal(
    grantSchema.safeParse({ action: 'jobs:manage', scope: school }).success,
    false,
  );
  const districtManage = [{ action: 'jobs:manage', scope: district }];
  assert.equal(isAuthorized(districtManage, 'jobs:manage', district), true);
  assert.equal(
    isAuthorized(districtManage, 'jobs:manage', {
      ...district,
      customerId: 'Cother',
    }),
    false,
  );
  assert.equal(isAuthorized(districtManage, 'jobs:read', district), false);
  // The platform administrator preset holds every action (design section 1).
  assert.equal(
    isAuthorized(
      grantsForPreset('platform-administrator', platform),
      'jobs:manage',
      district,
    ),
    true,
  );
  assert.equal(
    isAuthorized(
      grantsForPreset('district-administrator', district),
      'jobs:manage',
      district,
    ),
    false,
  );
});

test('a session with a jobs:manage grant parses', () => {
  const session = sessionResponseSchema.parse({
    identity: {
      id: '00000000-0000-4000-8000-000000000010',
      displayName: 'Alex Rivera',
      permissions: ['identity:read'],
      permissionVersion: 1,
      grants: [{ action: 'jobs:manage', scope: district }],
      preferences: { theme: 'system', navigationCollapsed: false },
    },
    expiresAt: '2026-10-17T12:00:00.000Z',
    csrfToken: 'a'.repeat(64),
  });
  assert.deepEqual(session.identity.grants, [
    { action: 'jobs:manage', scope: district },
  ]);
});

test('wipe and deprovision take platform and district scopes but not the district preset', () => {
  for (const action of ['devices:wipe', 'devices:deprovision']) {
    assert.ok(
      actionSchema.options.includes(action),
      `${action} is a declared action`,
    );
    for (const scope of [platform, district])
      assert.equal(grantSchema.safeParse({ action, scope }).success, true);
    assert.equal(
      grantSchema.safeParse({ action, scope: school }).success,
      false,
    );
    assert.equal(
      isAuthorized(
        grantsForPreset('platform-administrator', platform),
        action,
        platform,
      ),
      true,
      `The platform preset holds ${action}.`,
    );
    assert.equal(
      isAuthorized(
        grantsForPreset('district-administrator', district),
        action,
        district,
      ),
      false,
      `The district preset holds no ${action}.`,
    );
  }
});

test('viewers have only explicit read grants and presets reject broader scopes', () => {
  for (const scope of [district, school]) {
    const grants = grantsForPreset('viewer', scope);
    assert.equal(isAuthorized(grants, 'schools:read', scope), true);
    for (const action of [
      'customer:write',
      'schools:manage',
      'connection:diagnose',
      'security-events:read',
    ])
      assert.equal(isAuthorized(grants, action, scope), false);
  }
  assert.throws(() => grantsForPreset('viewer', platform));
  assert.throws(() => grantsForPreset('district-administrator', platform));
  assert.throws(() => grantsForPreset('platform-administrator', district));
  assert.throws(() => grantsForPreset('school-administrator', district));
});

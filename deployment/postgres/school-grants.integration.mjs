import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export async function qualifySchoolGrants({
  runtime,
  migrator,
  actor,
  issuer,
  customer,
  school,
}) {
  const target = randomUUID();
  await migrator.query(
    'INSERT INTO cc.application_principals(id,issuer,subject,display_name) VALUES($1,$2,$3,$3)',
    [target, issuer, target],
  );
  for (const [action, scope] of [
    ['platform-users:manage', { kind: 'platform' }],
    ['security-events:read', { kind: 'district', customerId: customer }],
  ])
    await migrator.query(
      'INSERT INTO cc.application_grants(principal_id,action,scope) VALUES($1,$2,$3)',
      [actor, action, JSON.stringify(scope)],
    );
  const grants = [
    {
      action: 'schools:read',
      scope: { kind: 'school', customerId: customer, schoolId: school },
    },
  ];
  const query = async (sql, values) =>
    (await runtime.query(sql, values)).rows[0].result;
  const review = (version, value = grants, enabled = true) =>
    query('SELECT cc.review_platform_access($1,1,$2,$3,$4,$5) AS result', [
      actor,
      target,
      version,
      enabled,
      JSON.stringify(value),
    ]);
  const apply = (proposal, schoolRevisions = proposal.schoolRevisions) =>
    query(
      'SELECT cc.change_platform_access($1,1,$2,$3,$4,$5,$6,$7,$8) AS result',
      [
        actor,
        target,
        proposal.targetVersion,
        proposal.proposed.enabled,
        JSON.stringify(proposal.proposed.grants),
        randomUUID(),
        JSON.stringify(proposal.invitationsToRevoke.map((i) => i.id)),
        JSON.stringify(schoolRevisions),
      ],
    );
  const first = await review(1);
  assert.deepEqual(first.schoolRevisions, [
    { schoolId: school, customerId: customer, revision: 2 },
  ]);
  await assert.rejects(
    apply(first, []),
    (error) => error.detail === 'school-changed',
  );
  const ref = await query('SELECT cc.read_school_references($1,1) AS result', [
    actor,
  ]);
  const preview = await query(
    'SELECT cc.preview_school_definition($1,1,$2,$3,2,$4,$5,$6,$7,$8) AS result',
    [
      actor,
      school,
      customer,
      ref.observation.revision,
      'Revised before grant',
      JSON.stringify({
        include: [{ id: 'school-a', descendants: true }],
        exclude: [],
      }),
      randomUUID(),
      randomUUID(),
    ],
  );
  await query('SELECT cc.confirm_school_definition($1,1,$2) AS result', [
    actor,
    preview.id,
  ]);
  await assert.rejects(
    apply(first),
    (error) => error.detail === 'school-changed',
  );
  const current = await review(1);
  assert.equal((await apply(current)).principal.permissionVersion, 2);
  const stored = (
    await migrator.query(
      'SELECT school_revisions FROM cc.application_access_changes WHERE principal_id=$1',
      [target],
    )
  ).rows[0].school_revisions;
  assert.deepEqual(stored, current.schoolRevisions);
  await migrator.query(
    "UPDATE cc.school_reference_state SET failure='permission-denied'",
  );
  try {
    await assert.rejects(
      review(2, [
        ...grants,
        { action: 'security-events:read', scope: grants[0].scope },
      ]),
      (error) => error.detail === 'school-unavailable',
    );
    const disable = await review(2, grants, false);
    assert.equal((await apply(disable)).principal.enabled, false);
    await assert.rejects(
      review(3, grants, true),
      (error) => error.detail === 'school-unavailable',
    );
    const revoke = await review(3, [], false);
    assert.deepEqual((await apply(revoke)).principal.grants, []);
  } finally {
    await migrator.query('UPDATE cc.school_reference_state SET failure=NULL');
  }
  await assert.rejects(
    review(4, [
      { ...grants[0], scope: { ...grants[0].scope, customerId: 'C9999999' } },
    ]),
    (error) => error.code === '42501',
  );
  return [
    'school grants require exact reviewed school revisions before first assignment: pass',
    'new and reenabled school grants require fresh verified scope: pass',
    'stale reference failures still permit local disabling and grant removal: pass',
    'grant receipts retain school revisions and reject cross-customer scopes: pass',
  ];
}

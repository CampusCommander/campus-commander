import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const issuer = z.url().refine((value) => value.startsWith('https://'));
const identity = {
  issuer,
  subject: z.string().min(1).max(512),
  displayName: z.string().min(1).max(200),
};
export const accessRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('inspect') }),
  z.strictObject({ action: z.literal('initialize'), ...identity }),
  z.strictObject({
    action: z.literal('revoke'),
    principalId: z.uuid(),
    expectedVersion: z.number().int().positive(),
  }),
  z.strictObject({
    action: z.literal('replace'),
    principalId: z.uuid(),
    expectedVersion: z.number().int().positive(),
    ...identity,
  }),
]);

/** Require the migration role and serialize changes to installation access. */
export async function changeApplicationAccess(client, input, configuredIssuer) {
  const request = accessRequestSchema.parse(input);
  if (request.action === 'inspect') {
    const result = await client.query(
      'SELECT id,issuer,subject,display_name,enabled,permission_version FROM cc.application_principals ORDER BY created_at LIMIT 100',
    );
    return { principals: result.rows };
  }
  if ('issuer' in request && request.issuer !== configuredIssuer)
    throw new Error(
      'The identity issuer differs from the application configuration.',
    );
  const correlationId = randomUUID();
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock(7240173008::bigint)');
    let principalId;
    if (request.action === 'initialize') {
      const existing = await client.query(
        'SELECT id FROM cc.application_principals LIMIT 1',
      );
      if (existing.rowCount)
        throw new Error(
          'Application access already exists. Use identity replacement for recovery.',
        );
      principalId = randomUUID();
      await client.query(
        'INSERT INTO cc.application_principals(id,issuer,subject,display_name,permissions) VALUES($1,$2,$3,$4,$5)',
        [
          principalId,
          request.issuer,
          request.subject,
          request.displayName,
          ['identity:read', 'diagnostics:read', 'diagnostics:run'],
        ],
      );
    } else {
      principalId = request.principalId;
      const result =
        request.action === 'revoke'
          ? await client.query(
              'UPDATE cc.application_principals SET enabled=false,permission_version=permission_version+1 WHERE id=$1 AND permission_version=$2 RETURNING id',
              [principalId, request.expectedVersion],
            )
          : await client.query(
              'UPDATE cc.application_principals SET issuer=$1,subject=$2,display_name=$3,enabled=true,permission_version=permission_version+1 WHERE id=$4 AND permission_version=$5 RETURNING id',
              [
                request.issuer,
                request.subject,
                request.displayName,
                principalId,
                request.expectedVersion,
              ],
            );
      if (!result.rowCount)
        throw new Error(
          'The principal or permission version changed. Inspect current access before recovery.',
        );
    }
    const event =
      request.action === 'initialize'
        ? 'access-granted'
        : request.action === 'revoke'
          ? 'access-revoked'
          : 'identity-replaced';
    await client.query(
      "INSERT INTO cc.security_events(id,actor_id,event,correlation_id,detail) VALUES($1,$2,$3,$4,'installation-operator')",
      [randomUUID(), principalId, event, correlationId],
    );
    await client.query('COMMIT');
    return { principalId, correlationId };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

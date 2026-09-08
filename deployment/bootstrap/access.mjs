import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const generateBootstrapCredential = () =>
  randomBytes(32).toString('base64url');
const digest = (credential) =>
  createHash('sha256').update(credential).digest('hex');

function validateCredential(credential) {
  if (
    typeof credential !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(credential)
  ) {
    throw new Error('Use a generated installation credential.');
  }
}

function expiry(seconds) {
  if (!Number.isInteger(seconds) || seconds < 60 || seconds > 86400) {
    throw new Error('Bootstrap expiry requires 60 through 86400 seconds.');
  }
  return seconds;
}

/** Preserve existing credentials and expiry when interrupted installation resumes. */
export async function initializeBootstrap(
  client,
  credential,
  lifetimeSeconds = 3600,
) {
  validateCredential(credential);
  const result = await client.query(
    `INSERT INTO cc.bootstrap_access (id, generation, credential_hash, expires_at)
     VALUES (1, 1, $1, clock_timestamp() + $2 * interval '1 second')
     ON CONFLICT (id) DO NOTHING RETURNING generation`,
    [digest(credential), expiry(lifetimeSeconds)],
  );
  if (result.rowCount === 1) return { generation: '1', created: true };
  const existing = await client.query(
    'SELECT generation, credential_hash FROM cc.bootstrap_access WHERE id = 1',
  );
  if (existing.rows[0]?.credential_hash !== digest(credential)) {
    throw new Error(
      'The installation already has another bootstrap credential. Use controlled recovery.',
    );
  }
  return { generation: existing.rows[0].generation, created: false };
}

/** Require operator database access and a matching generation for credential replacement. */
export async function replaceBootstrap(
  client,
  credential,
  expectedGeneration,
  lifetimeSeconds = 3600,
) {
  validateCredential(credential);
  if (!/^[1-9][0-9]*$/.test(String(expectedGeneration)))
    throw new Error('Provide the current bootstrap generation.');
  const result = await client.query(
    `UPDATE cc.bootstrap_access SET generation = generation + 1, credential_hash = $1,
       expires_at = clock_timestamp() + $2 * interval '1 second', revoked_at = NULL, updated_at = clock_timestamp()
     WHERE id = 1 AND generation = $3 RETURNING generation`,
    [digest(credential), expiry(lifetimeSeconds), expectedGeneration],
  );
  if (result.rowCount !== 1)
    throw new Error(
      'Bootstrap generation changed. Inspect the current state before recovery.',
    );
  return { generation: result.rows[0].generation };
}

export async function revokeBootstrap(client, expectedGeneration) {
  const result = await client.query(
    'UPDATE cc.bootstrap_access SET revoked_at = clock_timestamp(), updated_at = clock_timestamp() WHERE id = 1 AND generation = $1',
    [expectedGeneration],
  );
  return result.rowCount === 1;
}

/** Fail closed without returning credential or database error details. */
export async function verifyBootstrap(client, credential) {
  try {
    validateCredential(credential);
    const result = await client.query(
      'SELECT credential_hash FROM cc.bootstrap_access WHERE id = 1 AND revoked_at IS NULL AND expires_at > clock_timestamp()',
    );
    if (!result.rows[0]) return false;
    const stored = Buffer.from(result.rows[0].credential_hash, 'hex');
    const actual = Buffer.from(digest(credential), 'hex');
    return stored.length === actual.length && timingSafeEqual(stored, actual);
  } catch {
    return false;
  }
}

export function credentialFromAuthorization(header) {
  if (
    typeof header !== 'string' ||
    header.length > 256 ||
    !header.startsWith('Basic ')
  )
    return undefined;
  const value = Buffer.from(header.slice(6), 'base64').toString('utf8');
  if (!value.startsWith('operator:')) return undefined;
  return value.slice('operator:'.length);
}

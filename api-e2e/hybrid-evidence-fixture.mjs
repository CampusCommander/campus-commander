import assert from 'node:assert/strict';

const operatorReasons = new Set([
  'FILESYSTEM_PATH_MISSING',
  'FILESYSTEM_ACCESS_DENIED',
  'FILESYSTEM_FULL',
  'FILESYSTEM_PATH_EXISTS',
  'RECOVERY_MATERIAL_MISSING',
  'RECOVERY_KEY_REQUIRED',
  'RESTORE_DATABASE_NOT_EMPTY',
  'RESTORE_INVENTORY_MISMATCH',
  'RESTORE_EVIDENCE_INVALID',
  'RESTORE_TARGET_CHANGED',
  'RESTORE_GOOGLE_STATE_CHANGED',
  'RESTORE_GOOGLE_KEY_MISSING',
  'RESTORE_GOOGLE_KEY_INVALID',
  'RESTORE_GOOGLE_CUSTOMER_MISMATCH',
  'POSTGRES_TOOL_FAILED',
  'POSTGRES_TOOL_UNAVAILABLE',
  'POSTGRES_VERSION_MISMATCH',
  'DATABASE_CONNECTIONS_ACTIVE',
  'DATABASE_PERMISSION_DENIED',
  'DATABASE_AUTHENTICATION_FAILED',
  'BACKUP_AUTHENTICATION_FAILED',
  'BACKUP_INCOMPLETE',
  'ARTIFACT_INTEGRITY_FAILED',
  'INVALID_CONFIGURATION',
  'UNCLASSIFIED_FAILURE',
]);

function operatorReason(error, depth = 0) {
  if (!error || depth >= 4) return undefined;
  const stderr =
    typeof error.stderr === 'string' || Buffer.isBuffer(error.stderr)
      ? String(error.stderr)
      : '';
  const reason = /^Reason: ([A-Z_]+)\.$/m.exec(stderr)?.[1];
  if (operatorReasons.has(reason)) return reason;
  for (const nested of [
    error.cause,
    ...(Array.isArray(error.errors) ? error.errors.slice(0, 8) : []),
  ]) {
    const found = operatorReason(nested, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/** Classify host failures without retaining commands, paths, or secret values. */
export function describeHybridFailure(error) {
  const detail = [error?.message, error?.stderr]
    .filter((value) => typeof value === 'string' || Buffer.isBuffer(value))
    .join('\n');
  const category =
    /unauthorized|authentication required|pull access denied/i.test(detail)
      ? 'registry-authorization'
      : /permission denied|access denied|EACCES|EPERM/i.test(detail)
        ? 'permission-denied'
        : /no such file|not found|ENOENT/i.test(detail)
          ? 'missing-resource'
          : /certificate|x509|TLS/i.test(detail)
            ? 'tls-failure'
            : /timed out|timeout|ETIMEDOUT/i.test(detail)
              ? 'timeout'
              : 'unclassified';
  const reason = operatorReason(error);
  return {
    category,
    ...(reason ? { operatorReason: reason } : {}),
    exitCode: Number.isInteger(error?.code) ? error.code : null,
  };
}

/** Verify the delivered credential projection for a running consumer. */
export function assertHybridKeyMount(container, { authorized, volumeName }) {
  assert.equal(
    container.Mounts.some(
      (mount) => mount.Destination === '/run/secrets/google-qualification-key',
    ),
    false,
  );
  const mounts = container.Mounts.filter((mount) => mount.Name === volumeName);
  assert.equal(mounts.length, authorized ? 1 : 0);
  if (authorized) {
    assert.equal(mounts[0].Type, 'volume');
    assert.equal(mounts[0].Destination, '/run/secrets');
    assert.equal(mounts[0].RW, false);
    assert.equal(
      container.Mounts.filter((mount) => mount.Destination === '/run/secrets')
        .length,
      1,
    );
  }
}

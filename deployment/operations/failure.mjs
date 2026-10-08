const messages = new Map([
  ['Restored target evidence is invalid.', 'RESTORE_EVIDENCE_INVALID'],
  [
    'Restore migration credentials must not change the target database.',
    'RESTORE_TARGET_CHANGED',
  ],
  ['Restored Google credential state changed.', 'RESTORE_GOOGLE_STATE_CHANGED'],
  [
    'Restored Google encryption key is unavailable.',
    'RESTORE_GOOGLE_KEY_MISSING',
  ],
  [
    'Restored Google encryption key verification failed.',
    'RESTORE_GOOGLE_KEY_INVALID',
  ],
  [
    'Restored Google customer verification failed.',
    'RESTORE_GOOGLE_CUSTOMER_MISMATCH',
  ],
  ['Invalid backup command.', 'INVALID_COMMAND'],
  [
    'Provide a recent operator record that stops API, workers, and Kestra.',
    'QUIESCENCE_REQUIRED',
  ],
  [
    'Stop every application and Kestra database connection before backup or restore.',
    'DATABASE_CONNECTIONS_ACTIVE',
  ],
  [
    'Resolve active artifact attempts before backup.',
    'ARTIFACT_ATTEMPTS_ACTIVE',
  ],
  ['Storage changed during backup.', 'STORAGE_CHANGED'],
  ['Database inventory changed during backup.', 'DATABASE_CHANGED'],
  ['A ready artifact is absent or corrupt.', 'ARTIFACT_INTEGRITY_FAILED'],
  ['Backup tools must match PostgreSQL 18.6.', 'POSTGRES_VERSION_MISMATCH'],
  ['PostgreSQL backup tooling is unavailable.', 'POSTGRES_TOOL_UNAVAILABLE'],
  ['PostgreSQL backup command failed.', 'POSTGRES_TOOL_FAILED'],
  ['Recovery key identity is required.', 'RECOVERY_KEY_REQUIRED'],
  [
    'Required runtime recovery material is absent.',
    'RECOVERY_MATERIAL_MISSING',
  ],
  ['Backup is incomplete.', 'BACKUP_INCOMPLETE'],
  ['Backup authentication failed.', 'BACKUP_AUTHENTICATION_FAILED'],
  ['Restore databases must be empty.', 'RESTORE_DATABASE_NOT_EMPTY'],
  ['Restored database inventory differs.', 'RESTORE_INVENTORY_MISMATCH'],
]);
const codes = new Map([
  ['delegation-not-authorized', 'GOOGLE_DELEGATION_DENIED'],
  ['permission-denied', 'GOOGLE_PERMISSION_DENIED'],
  ['credential-rejected', 'GOOGLE_CREDENTIAL_REJECTED'],
  ['scope-mismatch', 'GOOGLE_SCOPE_MISMATCH'],
  ['api-not-enabled', 'GOOGLE_API_DISABLED'],
  ['network-failure', 'GOOGLE_NETWORK_FAILURE'],
  ['provider-unavailable', 'GOOGLE_UNAVAILABLE'],
  ['ENOENT', 'FILESYSTEM_PATH_MISSING'],
  ['EACCES', 'FILESYSTEM_ACCESS_DENIED'],
  ['ENOSPC', 'FILESYSTEM_FULL'],
  ['EEXIST', 'FILESYSTEM_PATH_EXISTS'],
  ['ECONNREFUSED', 'CONNECTION_REFUSED'],
  ['ECONNRESET', 'CONNECTION_RESET'],
  ['ETIMEDOUT', 'CONNECTION_TIMEOUT'],
  ['CERT_HAS_EXPIRED', 'TLS_CERTIFICATE_EXPIRED'],
  ['ERR_TLS_CERT_ALTNAME_INVALID', 'TLS_HOSTNAME_MISMATCH'],
  ['28P01', 'DATABASE_AUTHENTICATION_FAILED'],
  ['42501', 'DATABASE_PERMISSION_DENIED'],
  ['55P03', 'DATABASE_LOCK_UNAVAILABLE'],
  ['57014', 'DATABASE_QUERY_CANCELED'],
  ['57P01', 'DATABASE_SHUTDOWN'],
  ['53300', 'DATABASE_CONNECTION_LIMIT'],
]);

/** Return only fixed failure codes. Never disclose exception messages or connection material. */
export function operationFailureReason(error) {
  for (
    let current = error, depth = 0;
    current && depth < 4;
    current = current.cause, depth++
  ) {
    if (messages.has(current.message)) return messages.get(current.message);
    if (codes.has(current.code)) return codes.get(current.code);
    if (current.name === 'ZodError') return 'INVALID_CONFIGURATION';
  }
  return 'UNCLASSIFIED_FAILURE';
}

/** Decode one secret-file line without changing spaces inside the password. */
export function normalizePostgresSecret(value) {
  const invalid = () =>
    new Error('Invalid PostgreSQL secret. Use one non-empty UTF-8 line.');
  let decoded;
  try {
    if (typeof value === 'string') {
      if (!value.isWellFormed()) throw invalid();
      decoded = value;
    } else if (value instanceof Uint8Array) {
      decoded = new TextDecoder('utf-8', {
        fatal: true,
        ignoreBOM: true,
      }).decode(value);
    } else throw invalid();
  } catch {
    throw invalid();
  }
  const normalized = decoded.replace(/\r?\n$/, '');
  if (!normalized || /[\r\n\0]/.test(normalized)) throw invalid();
  return normalized;
}

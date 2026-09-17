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
  return {
    category,
    exitCode: Number.isInteger(error?.code) ? error.code : null,
  };
}

import assert from 'node:assert/strict';

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

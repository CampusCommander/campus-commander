import { isDeepStrictEqual } from 'node:util';
import { parseDeploymentConfig } from '../../dist/deployment/lib/deployment.js';

/** Preserve deployment topology and durable locations during a phase upgrade. */
export function supportedUpgrade(previous, next) {
  const before = parseDeploymentConfig(previous);
  const after = parseDeploymentConfig(next);
  after.images = before.images;
  if (before.phase === 1 && after.phase === 2) {
    if (
      after.applicationAuth.publicOrigin !==
      new URL(before.services.edge.endpoint.url).origin
    )
      return false;
    after.phase = 1;
    delete after.applicationAuth;
    after.services.edge.access = before.services.edge.access;
  }
  return isDeepStrictEqual(before, after);
}

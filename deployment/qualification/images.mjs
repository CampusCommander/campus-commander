import { readFileSync } from 'node:fs';

/** Resolve immutable application images for a synthetic qualification run. */
export function qualificationImages(
  fallback,
  releasePath = process.env.CC_QUALIFICATION_RELEASE,
) {
  let images = fallback;
  if (releasePath) {
    let release;
    try {
      release = JSON.parse(readFileSync(releasePath, 'utf8'));
    } catch {
      throw new Error('Cannot read the qualification release inventory.');
    }
    images = {
      frontend: release?.images?.frontend,
      api: release?.images?.api,
      worker: release?.images?.workers,
    };
  }
  for (const service of ['frontend', 'api', 'worker']) {
    if (
      typeof images?.[service] !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(
        images[service],
      )
    ) {
      throw new Error(
        'Qualification requires immutable frontend, API, and worker image references.',
      );
    }
  }
  return {
    frontend: images.frontend,
    api: images.api,
    worker: images.worker,
  };
}

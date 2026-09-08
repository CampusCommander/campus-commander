import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { parseDeploymentConfig } from '../../dist/deployment/lib/deployment.js';
import { connectionOptions } from '../postgres/index.mjs';
import { secretPath } from '../redis/runtime.mjs';
import { createArtifactStore } from '../storage/index.mjs';
import { verifyBootstrap } from './access.mjs';
import { installationStatus, probeHttp } from './status.mjs';

/** Keep component credentials and bootstrap verification inside the API. */
export async function createStartupRuntime(configPath) {
  const resolveSecret = (reference) => readFile(secretPath(reference));
  const config = parseDeploymentConfig(
    JSON.parse(await readFile(configPath, 'utf8')),
  );
  const pool = new pg.Pool({
    ...(await connectionOptions(
      config.services.applicationDatabase,
      resolveSecret,
    )),
    max: 4,
    statement_timeout: 5000,
  });
  let kestraPool;
  try {
    kestraPool = new pg.Pool({
      ...(await connectionOptions(
        config.services.kestraDatabase,
        resolveSecret,
      )),
      max: 2,
      statement_timeout: 5000,
    });
  } catch (error) {
    await pool.end();
    throw error;
  }
  pool.on('error', () => {
    /* Readiness checks report database outages. */
  });
  kestraPool.on('error', () => {
    /* Readiness checks report database outages. */
  });
  let store;
  let storageInitialization;
  const getStatus = () =>
    installationStatus({
      config,
      applicationPool: pool,
      kestraPool,
      resolveSecret,
      apiHealth: async () => true,
      storageHealth: async () => {
        storageInitialization ??= createArtifactStore({
          pool,
          root: config.artifacts.location,
          backend:
            config.artifacts.kind === 'shared-filesystem'
              ? 'shared-filesystem'
              : 'local',
        })
          .then((value) => {
            store = value;
            return value;
          })
          .catch((error) => {
            storageInitialization = undefined;
            throw error;
          });
        await storageInitialization;
        return store.checkHealth();
      },
      kestraHealth: async () => {
        const credential = JSON.parse(
          (await resolveSecret(config.services.kestra.authSecretRef)).toString(
            'utf8',
          ),
        );
        if (
          typeof credential.username !== 'string' ||
          typeof credential.password !== 'string'
        )
          return false;
        return probeHttp(config.services.kestra, resolveSecret, {
          path: '/api/v1/main/flows/search?size=1',
          authorization: `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString('base64')}`,
        });
      },
    });
  return {
    verify: (credential) => verifyBootstrap(pool, credential),
    getStatus,
    close: async () => {
      await store?.close();
      await Promise.all([pool.end(), kestraPool.end()]);
    },
  };
}

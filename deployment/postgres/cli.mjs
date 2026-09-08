import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { normalizePostgresSecret } from './secrets.mjs';
import { parseDeploymentConfig } from '../../dist/deployment/index.js';
import {
  checkReadiness,
  connectDatabase,
  connectionOptions,
  migrate,
  provision,
} from './index.mjs';

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
async function resolveSecret(reference) {
  const path =
    reference.provider === 'kubernetes'
      ? `/run/secrets/${reference.name}/${reference.key}`
      : reference.path;
  if (
    !/^\/run\/secrets\/[a-z][a-z0-9-]{0,62}(\/[a-z][a-z0-9-]{0,62})?$/.test(
      path,
    )
  ) {
    throw new Error('Mount database secrets as files under /run/secrets.');
  }
  return readFile(path);
}

let client;
try {
  const [command, configPath, operatorPath] = process.argv.slice(2);
  if (!['provision', 'migrate', 'ready'].includes(command) || !configPath)
    throw new Error('Invalid database command.');
  const config = parseDeploymentConfig(await readJson(configPath));
  const app = config.services.applicationDatabase;
  if (command === 'ready') {
    client = await connectDatabase(app, resolveSecret);
    if (!(await checkReadiness(client)))
      throw new Error('Application migrations are not ready.');
  } else {
    const operator = await readJson(operatorPath);
    if (command === 'migrate') {
      client = await connectDatabase(
        {
          ...app,
          role: operator.migrationRole,
          passwordSecretRef: operator.migrationPasswordSecretRef,
        },
        resolveSecret,
      );
      await migrate(client, { runtimeRole: app.role });
    } else {
      const kestra = config.services.kestraDatabase;
      const settings = {
        application: {
          database: app.database,
          role: app.role,
          password: normalizePostgresSecret(
            await resolveSecret(app.passwordSecretRef),
          ),
          migrationRole: operator.migrationRole,
          migrationPassword: normalizePostgresSecret(
            await resolveSecret(operator.migrationPasswordSecretRef),
          ),
        },
        kestra: {
          database: kestra.database,
          role: kestra.role,
          password: normalizePostgresSecret(
            await resolveSecret(kestra.passwordSecretRef),
          ),
        },
      };
      const scopes =
        app.endpoint.url === kestra.endpoint.url
          ? [['both', app]]
          : [
              ['application', app],
              ['kestra', kestra],
            ];
      for (const [only, service] of scopes) {
        const admin =
          only === 'kestra' ? (operator.kestraAdmin ?? operator) : operator;
        client = new pg.Client(
          await connectionOptions(
            {
              ...service,
              database: admin.adminDatabase,
              role: admin.adminRole,
              passwordSecretRef: admin.adminPasswordSecretRef,
            },
            resolveSecret,
          ),
        );
        await client.connect();
        await provision(client, { ...settings, only });
        await client.end();
        client = undefined;
      }
    }
  }
  console.log('PostgreSQL command succeeded.');
} catch {
  console.error(
    'PostgreSQL command failed. Check configuration, operator privileges, certificates, and migration state.',
  );
  process.exitCode = 1;
} finally {
  await client?.end().catch(() => undefined);
}

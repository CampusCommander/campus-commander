import { readFile } from 'node:fs/promises';
import {
  parseDeploymentConfig,
  secretReferenceSchema,
} from '../../dist/deployment/lib/deployment.js';
import { connectDatabase } from '../postgres/index.mjs';
import { secretPath } from '../redis/runtime.mjs';
import { changeApplicationAccess } from './application-access.mjs';

let client;
try {
  const [configPath, operatorPath, requestPath] = process.argv.slice(2);
  if (!configPath || !operatorPath || !requestPath)
    throw new Error('Provide the profile, operator file, and access request.');
  const config = parseDeploymentConfig(
    JSON.parse(await readFile(configPath, 'utf8')),
  );
  if (!config.applicationAuth)
    throw new Error(
      'Configure application authentication before granting access.',
    );
  const operator = JSON.parse(await readFile(operatorPath, 'utf8'));
  if (
    !/^[a-z][a-z0-9_-]{0,62}$/.test(operator.migrationRole) ||
    operator.migrationRole === config.services.applicationDatabase.role
  )
    throw new Error('Use the separate application migration role.');
  const reference = secretReferenceSchema.parse(
    operator.migrationPasswordSecretRef,
  );
  client = await connectDatabase(
    {
      ...config.services.applicationDatabase,
      role: operator.migrationRole,
      passwordSecretRef: reference,
    },
    (ref) => readFile(secretPath(ref)),
  );
  const result = await changeApplicationAccess(
    client,
    JSON.parse(await readFile(requestPath, 'utf8')),
    config.applicationAuth.issuer,
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch {
  process.stderr.write(
    'Application access change failed. Check operator privileges, identity, issuer, and the current permission version.\n',
  );
  process.exitCode = 1;
} finally {
  await client?.end().catch(() => undefined);
}

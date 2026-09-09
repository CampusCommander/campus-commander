import { open, readFile } from 'node:fs/promises';
import { parseDeploymentConfig } from '../../dist/deployment/lib/deployment.js';
import { connectDatabase } from '../postgres/index.mjs';
import { secretPath } from '../redis/runtime.mjs';
import {
  generateBootstrapCredential,
  initializeBootstrap,
  replaceBootstrap,
  revokeBootstrap,
} from './access.mjs';

let client;
try {
  const [command, path, generation] = process.argv.slice(2);
  if (command === 'generate') {
    const file = await open(path, 'wx', 0o600);
    try {
      await file.writeFile(generateBootstrapCredential());
      await file.sync();
    } finally {
      await file.close();
    }
    process.stdout.write('A new installation credential file was created.\n');
  } else {
    if (!['initialize', 'replace', 'revoke'].includes(command))
      throw new Error('Invalid bootstrap command.');
    const config = parseDeploymentConfig(
      JSON.parse(await readFile(path, 'utf8')),
    );
    const resolver = (reference) => readFile(secretPath(reference));
    client = await connectDatabase(
      config.services.applicationDatabase,
      resolver,
    );
    if (command === 'revoke') {
      if (!(await revokeBootstrap(client, generation)))
        throw new Error('Bootstrap generation differs.');
    } else {
      const credential = (
        await resolver(config.services.edge.bootstrapSecretRef)
      ).toString('utf8');
      if (command === 'initialize')
        await initializeBootstrap(client, credential);
      else await replaceBootstrap(client, credential, generation);
    }
    process.stdout.write('Bootstrap lifecycle command succeeded.\n');
  }
} catch {
  process.stderr.write(
    'Bootstrap command failed. Check the profile, private credential file, database, and expected generation.\n',
  );
  process.exitCode = 1;
} finally {
  await client?.end().catch(() => undefined);
}

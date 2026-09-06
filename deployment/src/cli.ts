import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DeploymentConfigurationError,
  parseDeploymentConfig,
  validateProfileSet,
} from './lib/deployment';

try {
  const args = process.argv.slice(2);
  if (args.length !== 1) throw new Error('usage');
  const examples = args[0] === '--examples';
  const files = examples
    ? ['all-docker', 'hybrid', 'kubernetes'].map((profile) =>
        resolve('deployment/examples', `${profile}.json`),
      )
    : [resolve(args[0])];
  const configs = files.map((file) =>
    parseDeploymentConfig(JSON.parse(readFileSync(file, 'utf8'))),
  );
  if (examples) validateProfileSet(configs);
  for (const config of configs) {
    console.log(`VALID ${config.profile}`);
    for (const [key, service] of Object.entries(config.services)) {
      console.log(`  ${key}: ${service.placement.kind}`);
    }
    console.log(`  artifacts: ${config.artifacts.kind}`);
    console.log(
      `  kestraInternalStorage: ${config.services.kestra.internalStorage.kind}`,
    );
  }
  if (examples)
    console.log('PASS identical application images across all three profiles');
} catch (error) {
  console.error(
    error instanceof DeploymentConfigurationError
      ? error.message
      : 'Configuration read failed. Supply one JSON file path or --examples.',
  );
  process.exitCode = 1;
}

import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import {
  parseDeploymentConfig,
  type DeploymentConfig,
  type SecretReference,
} from 'deployment';
import { readFileSync } from 'node:fs';

@Injectable()
export class ConfigurationService {
  readonly deployment: DeploymentConfig | undefined;

  constructor() {
    const path = process.env['CC_CONFIG_FILE'];
    this.deployment = path
      ? parseDeploymentConfig(JSON.parse(readFileSync(path, 'utf8')))
      : undefined;
  }

  get auth() {
    const auth = this.deployment?.applicationAuth;
    if (!auth)
      throw new ServiceUnavailableException(
        'Application sign-in is not configured.',
      );
    return auth;
  }

  secret(reference: SecretReference): Buffer {
    const path =
      reference.provider === 'file'
        ? reference.path
        : `/run/secrets/${reference.name}/${reference.key}`;
    const value = readFileSync(path);
    if (!value.length || value.length > 65536)
      throw new Error('Invalid secret file size.');
    return value;
  }
}

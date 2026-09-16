import { Controller, Get } from '@nestjs/common';
import { ConfigurationService } from './configuration.service';
import { applicationMetadataSchema } from '@campus/application-contracts';

@Controller('api/application')
export class ApplicationController {
  constructor(private readonly configuration: ConfigurationService) {}

  @Get()
  metadata() {
    return applicationMetadataSchema.parse({
      phase: this.configuration.deployment?.phase ?? 1,
      authenticationConfigured: Boolean(
        this.configuration.deployment?.applicationAuth,
      ),
      version: process.env['CC_VERSION'] ?? 'development',
      build: process.env['CC_BUILD_ID'] ?? 'unreleased',
    });
  }
}

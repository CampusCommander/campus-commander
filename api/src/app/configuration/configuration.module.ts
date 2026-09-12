import { Module } from '@nestjs/common';
import { ConfigurationService } from './configuration.service';
import { ApplicationController } from './application.controller';

@Module({
  controllers: [ApplicationController],
  providers: [ConfigurationService],
  exports: [ConfigurationService],
})
export class ConfigurationModule {}

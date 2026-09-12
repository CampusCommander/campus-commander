import { Module } from '@nestjs/common';
import { ConfigurationModule } from '../configuration/configuration.module';
import { OrchestrationService } from './orchestration.service';

@Module({
  imports: [ConfigurationModule],
  providers: [OrchestrationService],
  exports: [OrchestrationService],
})
export class OrchestrationModule {}

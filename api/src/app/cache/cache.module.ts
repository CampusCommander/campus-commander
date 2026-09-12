import { Module } from '@nestjs/common';
import { ConfigurationModule } from '../configuration/configuration.module';
import { CacheService } from './cache.service';

@Module({
  imports: [ConfigurationModule],
  providers: [CacheService],
  exports: [CacheService],
})
export class CacheModule {}

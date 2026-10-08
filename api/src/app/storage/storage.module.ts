import { Module } from '@nestjs/common';
import { ConfigurationModule } from '../configuration/configuration.module';
import { DatabaseModule } from '../database/database.module';
import { StorageService } from './storage.service';

@Module({
  imports: [ConfigurationModule, DatabaseModule],
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}

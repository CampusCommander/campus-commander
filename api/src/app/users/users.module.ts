import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CacheModule } from '../cache/cache.module';
import { ConfigurationModule } from '../configuration/configuration.module';
import { DatabaseModule } from '../database/database.module';
import { OrchestrationModule } from '../orchestration/orchestration.module';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [
    AuthModule,
    CacheModule,
    ConfigurationModule,
    DatabaseModule,
    OrchestrationModule,
  ],
  controllers: [UsersController],
  providers: [UsersService],
  // Card K9 builds the users feed on this service.
  exports: [UsersService],
})
export class UsersModule {}

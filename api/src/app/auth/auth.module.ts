import { Module } from '@nestjs/common';
import { ConfigurationModule } from '../configuration/configuration.module';
import { DatabaseModule } from '../database/database.module';
import { CacheModule } from '../cache/cache.module';
import { AuthService } from './auth.service';
import { AuthGuard } from './auth.guard';
import { AuthController } from './auth.controller';
import { EnrollmentService } from './enrollment.service';

@Module({
  imports: [ConfigurationModule, DatabaseModule, CacheModule],
  controllers: [AuthController],
  providers: [AuthService, AuthGuard, EnrollmentService],
  exports: [AuthService, AuthGuard, EnrollmentService],
})
export class AuthModule {}

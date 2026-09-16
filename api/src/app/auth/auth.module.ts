import { Module } from '@nestjs/common';
import { ConfigurationModule } from '../configuration/configuration.module';
import { DatabaseModule } from '../database/database.module';
import { CacheModule } from '../cache/cache.module';
import { AuthService } from './auth.service';
import { AuthGuard } from './auth.guard';
import { AuthController } from './auth.controller';
import { EnrollmentService } from './enrollment.service';
import { InvitationService } from './invitation.service';
import { InvitationController } from './invitation.controller';
import { PlatformAccessController } from './platform-access.controller';
import { PlatformAccessService } from './platform-access.service';

@Module({
  imports: [ConfigurationModule, DatabaseModule, CacheModule],
  controllers: [AuthController, InvitationController, PlatformAccessController],
  providers: [
    AuthService,
    AuthGuard,
    EnrollmentService,
    InvitationService,
    PlatformAccessService,
  ],
  exports: [AuthService, AuthGuard, EnrollmentService],
})
export class AuthModule {}

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

@Module({
  imports: [ConfigurationModule, DatabaseModule, CacheModule],
  controllers: [AuthController, InvitationController],
  providers: [AuthService, AuthGuard, EnrollmentService, InvitationService],
  exports: [AuthService, AuthGuard, EnrollmentService],
})
export class AuthModule {}

import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CacheModule } from '../cache/cache.module';
import { ConfigurationModule } from '../configuration/configuration.module';
import { DevicesModule } from '../devices/devices.module';
import { DriveController } from './drive.controller';
import { DriveService } from './drive.service';

/**
 * The Drive routes of the devices dialog (design section 1). The module imports the Google
 * connection service, the device read that resolves the connected customer, and the session cache
 * that holds the cause of a refused exchange.
 *
 * ConfigurationModule provides the ConfigurationService that AuthGuard resolves. The guard is an
 * injectable of this module, because `@UseGuards(AuthGuard)` registers it here.
 */
@Module({
  imports: [AuthModule, CacheModule, ConfigurationModule, DevicesModule],
  controllers: [DriveController],
  providers: [DriveService],
})
export class DriveModule {}

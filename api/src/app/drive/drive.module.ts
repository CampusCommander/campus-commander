import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ConfigurationModule } from '../configuration/configuration.module';
import { DevicesModule } from '../devices/devices.module';
import { DriveController } from './drive.controller';

/**
 * The Drive routes of the devices dialog (design section 1). The module imports the device module,
 * which provides the Drive service: the export and import routes of that module run the same
 * exchange, so one provider serves both. The service resolves the Google connection service, the
 * connected customer read, and the session cache inside that module.
 *
 * ConfigurationModule provides the ConfigurationService that AuthGuard resolves. The guard is an
 * injectable of this module, because `@UseGuards(AuthGuard)` registers it here.
 */
@Module({
  imports: [AuthModule, ConfigurationModule, DevicesModule],
  controllers: [DriveController],
})
export class DriveModule {}

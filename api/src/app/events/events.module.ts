import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ConfigurationModule } from '../configuration/configuration.module';
import { DevicesModule } from '../devices/devices.module';
import { JobsModule } from '../jobs/jobs.module';
import { UsersModule } from '../users/users.module';
import { EventsController } from './events.controller';

@Module({
  // DevicesModule exports the one DeviceEventsService subscriber connection of the API instance.
  // UsersModule exports the users service that the users feed reads its sync state through.
  imports: [
    AuthModule,
    ConfigurationModule,
    DevicesModule,
    JobsModule,
    UsersModule,
  ],
  controllers: [EventsController],
})
export class EventsModule {}

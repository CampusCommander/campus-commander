import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { customerSettingsWriteSchema } from '@campus/application-contracts';
import { AuthGuard, type AuthenticatedRequest } from './auth.guard';
import { AuthService } from './auth.service';
import { CustomerSettingsService } from './customer-settings.service';

@Controller('api/customer')
@UseGuards(AuthGuard)
export class CustomerSettingsController {
  constructor(
    private readonly settings: CustomerSettingsService,
    private readonly auth: AuthService,
  ) {}

  @Get()
  async read(@Req() request: AuthenticatedRequest) {
    return { customer: await this.settings.read(request.session) };
  }

  @Get('receipts/:id')
  receipt(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.settings.receipt(request.session, z.uuid().parse(id));
  }

  @Post('settings')
  async save(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = customerSettingsWriteSchema.parse(body);
    await this.auth.authorize(
      request.session,
      'customer:write',
      { kind: 'district', customerId: input.customerId },
      request.correlationId,
    );
    return this.settings.save(request.session, input, request.correlationId);
  }
}

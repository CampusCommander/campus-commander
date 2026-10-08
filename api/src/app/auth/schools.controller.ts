import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import {
  schoolPreviewSchema,
  schoolConfirmationSchema,
} from '@campus/application-contracts';
import { AuthGuard, type AuthenticatedRequest } from './auth.guard';
import { AuthService } from './auth.service';
import { SchoolsService } from './schools.service';

const offsetSchema = z.coerce.number().int().min(0).max(1000000).default(0);
@Controller('api/schools')
@UseGuards(AuthGuard)
export class SchoolsController {
  constructor(
    private readonly schools: SchoolsService,
    private readonly auth: AuthService,
  ) {}
  @Get()
  list(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    const input = z
      .strictObject({
        offset: offsetSchema,
        limit: z.coerce.number().int().min(1).max(100).default(20),
      })
      .parse(query);
    return this.schools.list(request.session, input.offset, input.limit);
  }
  @Get('reviews/:id')
  review(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.schools.review(request.session, z.uuid().parse(id));
  }
  @Post('reviews')
  async preview(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = schoolPreviewSchema.parse(body);
    await this.auth.authorize(
      request.session,
      'schools:manage',
      { kind: 'district', customerId: input.customerId },
      request.correlationId,
    );
    return this.schools.preview(request.session, input, request.correlationId);
  }
  @Post('reviews/:id/confirm')
  confirm(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    schoolConfirmationSchema.parse(body);
    return this.schools.confirm(request.session, z.uuid().parse(id));
  }
  @Get(':id/audit')
  audit(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Query() query: unknown,
  ) {
    const input = z.strictObject({ offset: offsetSchema }).parse(query);
    return this.schools.audit(
      request.session,
      z.uuid().parse(id),
      input.offset,
    );
  }
  @Get(':id')
  read(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.schools.read(request.session, z.uuid().parse(id));
  }
}

import { Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { diagnosticOperationSchema } from '@campus/application-contracts';
import {
  AuthGuard,
  RequirePermission,
  type AuthenticatedRequest,
} from '../auth/auth.guard';
import { DiagnosticsService } from './diagnostics.service';

@Controller('api/diagnostics')
@UseGuards(AuthGuard)
export class DiagnosticsController {
  constructor(private readonly diagnostics: DiagnosticsService) {}

  @Get()
  @RequirePermission('diagnostics:read')
  health() {
    return this.diagnostics.health();
  }

  @Post(':operation')
  @RequirePermission('diagnostics:run')
  run(
    @Param('operation') operation: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.diagnostics.run(
      diagnosticOperationSchema.parse(operation),
      request.session.identity.id,
      request.correlationId,
    );
  }
}

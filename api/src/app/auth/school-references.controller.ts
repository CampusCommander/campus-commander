import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { schoolReferenceRefreshSchema } from '@campus/application-contracts';
import { AuthGuard, type AuthenticatedRequest } from './auth.guard';
import { AuthService } from './auth.service';
import { GoogleConnectionService } from './google-connection.service';

@Controller('api/schools/references')
@UseGuards(AuthGuard)
export class SchoolReferencesController {
  constructor(
    private readonly connection: GoogleConnectionService,
    private readonly auth: AuthService,
  ) {}

  @Get()
  async read(@Req() request: AuthenticatedRequest) {
    return {
      references: await this.connection.schoolReferences(request.session),
    };
  }

  @Post('refresh')
  async refresh(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = schoolReferenceRefreshSchema.parse(body);
    const authorize = (session = request.session) =>
      this.auth.authorize(
        session,
        'schools:manage',
        { kind: 'district', customerId: input.customerId },
        request.correlationId,
      );
    await authorize();
    try {
      return {
        references: await this.connection.refreshSchoolReferences(
          request.session,
          input,
          request.correlationId,
        ),
      };
    } finally {
      await authorize(
        await this.auth.authenticate(
          request.headers.cookie,
          'identity:read',
          request.correlationId,
        ),
      );
    }
  }
}

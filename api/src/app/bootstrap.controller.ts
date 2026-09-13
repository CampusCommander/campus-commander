import {
  Controller,
  Get,
  Headers,
  Inject,
  ServiceUnavailableException,
  UnauthorizedException,
  Post,
  Body,
  Req,
} from '@nestjs/common';
import { STARTUP_RUNTIME } from './startup-runtime';
import type { StartupRuntime } from './startup-runtime.contract';
import { EnrollmentService } from './auth/enrollment.service';
import type { Request } from 'express';

@Controller('api')
export class BootstrapController {
  constructor(
    @Inject(STARTUP_RUNTIME)
    private readonly runtime: StartupRuntime | undefined,
    private readonly enrollment: EnrollmentService,
  ) {}

  @Post('auth/enrollment/operator')
  async enroll(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
    @Req() request: Request,
  ) {
    if (
      request.headers.origin ||
      !request.is('application/json') ||
      !(await this.runtime?.verify(credentialFromAuthorization(authorization)))
    )
      throw new UnauthorizedException();
    return this.enrollment.operator(body);
  }

  @Get('bootstrap/verify')
  async verify(@Headers('authorization') authorization?: string) {
    const verified = await this.runtime?.verify(
      credentialFromAuthorization(authorization),
    );
    if (!verified) throw new UnauthorizedException();
    return { status: 'verified' } as const;
  }

  @Get('startup')
  async status(@Headers('authorization') authorization?: string) {
    const verified = await this.runtime?.verify(
      credentialFromAuthorization(authorization),
    );
    if (!verified || !this.runtime) throw new UnauthorizedException();
    const status = await this.runtime.getStatus();
    if (status.status !== 'ready') {
      throw new ServiceUnavailableException(status);
    }
    return status;
  }
}

function credentialFromAuthorization(header?: string) {
  if (!header || header.length > 256 || !header.startsWith('Basic ')) {
    return undefined;
  }
  const value = Buffer.from(header.slice(6), 'base64').toString('utf8');
  if (!value.startsWith('operator:')) return undefined;
  return value.slice('operator:'.length);
}

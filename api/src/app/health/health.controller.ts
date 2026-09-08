import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ReadinessService } from './readiness';

@Controller('health')
export class HealthController {
  constructor(private readonly readinessService: ReadinessService) {}

  @Get()
  readiness() {
    return this.getReadiness();
  }

  @Get('live')
  liveness() {
    return { service: 'api', status: 'live' } as const;
  }

  @Get('ready')
  async readinessCheck() {
    return this.getReadiness();
  }

  private async getReadiness() {
    const response = await this.readinessService.check();
    if (response.status !== 'ready') {
      throw new ServiceUnavailableException(response);
    }
    return response;
  }
}

import { Controller, Get, Module } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

@ApiTags('health')
@Controller('health')
class HealthController {
  @Get()
  check() {
    return {
      status: 'ok',
      service: 'aitp-api',
      version: process.env.npm_package_version ?? '0.1.0',
      environment: process.env.TEST_ENV ?? 'qa',
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}

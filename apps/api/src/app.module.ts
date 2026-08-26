import path from 'node:path';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { findRepoRoot } from '@aitp/shared';
import { HealthModule } from './modules/health/health.module';
import { RunsModule } from './modules/runs/runs.module';
import { EventsModule } from './modules/events/events.module';
import { CommandModule } from './modules/command/command.module';

@Module({
  imports: [
    // Absolute paths: the API runs from apps/api in dev, /app in Docker and the
    // repo root under Jenkins — relative env paths would resolve differently in each.
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [
        path.join(findRepoRoot(__dirname), '.env.local'),
        path.join(findRepoRoot(__dirname), '.env'),
      ],
    }),
    HealthModule,
    EventsModule,
    RunsModule,
    CommandModule,
  ],
})
export class AppModule {}

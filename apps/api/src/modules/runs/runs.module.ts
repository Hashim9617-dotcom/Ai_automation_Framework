import {
  Body,
  Controller,
  Get,
  Module,
  Param,
  Post,
  Query,
  UsePipes,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { runRequestSchema, type RunRequest } from '@aitp/shared';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { EventsModule } from '../events/events.module';
import { InMemoryRunRepository, RunRepository } from './run.repository';
import { RunnerService } from './runner.service';
import { RunsService } from './runs.service';

@ApiTags('runs')
@Controller('runs')
class RunsController {
  constructor(private readonly runs: RunsService) {}

  /** Schedule a suite. Returns immediately with a queued run. */
  @Post()
  @UsePipes(new ZodValidationPipe(runRequestSchema))
  create(@Body() request: RunRequest) {
    return this.runs.enqueue(request);
  }

  @Get()
  list(@Query('limit') limit?: string) {
    return this.runs.list(limit ? Number(limit) : 25);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.runs.get(id);
  }

  @Post(':id/cancel')
  cancel(@Param('id') id: string) {
    return this.runs.cancel(id);
  }
}

@Module({
  imports: [EventsModule],
  controllers: [RunsController],
  providers: [
    RunsService,
    RunnerService,
    { provide: RunRepository, useClass: InMemoryRunRepository },
  ],
  exports: [RunsService],
})
export class RunsModule {}

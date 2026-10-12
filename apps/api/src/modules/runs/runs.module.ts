import { Body, Controller, Get, Module, Param, Post, Query, UsePipes } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { type RunRequest } from '@aitp/shared';
import { runRequestApiSchema } from '../../common/request-schemas';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { EventsModule } from '../events/events.module';
import { InMemoryRunRepository, RunRepository } from './run.repository';
import { RunnerService } from './runner.service';
import { RunsService } from './runs.service';

@ApiTags('runs')
@Controller('runs')
class RunsController {
  constructor(private readonly runs: RunsService) {}

  /**
   * Schedule a suite. Returns immediately with a queued run.
   *
   * `runRequestApiSchema`, not the bare `runRequestSchema`: this boundary adds
   * the bounds an HTTP request needs (string and array caps) and the one check
   * that matters most — `environment` must name a file under `config/env/`,
   * because that field is what decides which system a run drives and it was
   * free text.
   */
  @Post()
  @UsePipes(new ZodValidationPipe(runRequestApiSchema))
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

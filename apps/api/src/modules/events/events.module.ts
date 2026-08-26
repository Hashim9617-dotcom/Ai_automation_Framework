import { Body, Controller, Get, HttpCode, Module, Param, Post, Sse } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { map, type Observable } from 'rxjs';
import { EventsService, type LiveEvent } from './events.service';

@ApiTags('events')
@Controller('events')
class EventsController {
  constructor(private readonly events: EventsService) {}

  /** Ingest endpoint for the AitpReporter's live events. */
  @Post()
  @HttpCode(202)
  ingest(@Body() event: LiveEvent) {
    this.events.publish({ ...event, at: event.at ?? new Date().toISOString() });
    return { accepted: true };
  }

  /** Server-sent events — what the Phase 3 dashboard subscribes to. */
  @Sse('stream/:runId')
  stream(@Param('runId') runId: string): Observable<{ data: string }> {
    return this.events
      .subscribe(runId)
      .pipe(map((event) => ({ data: JSON.stringify(event) })));
  }

  @Get('history/:runId')
  history(@Param('runId') runId: string) {
    return this.events.history(runId);
  }
}

@Module({
  controllers: [EventsController],
  providers: [EventsService],
  exports: [EventsService],
})
export class EventsModule {}

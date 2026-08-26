import { Injectable } from '@nestjs/common';
import { Subject, filter, type Observable } from 'rxjs';

export interface LiveEvent {
  event: string;
  payload: unknown;
  at: string;
  runId?: string;
}

/**
 * In-process event bus fed by the Playwright reporter (which POSTs to
 * /api/events) and consumed by the dashboard over SSE. Phase 3 swaps the Subject
 * for Redis pub/sub so multiple API replicas can serve the same stream.
 */
@Injectable()
export class EventsService {
  private readonly stream$ = new Subject<LiveEvent>();
  private readonly buffer = new Map<string, LiveEvent[]>();
  private static readonly BUFFER_LIMIT = 500;

  publish(event: LiveEvent): void {
    const runId = event.runId ?? (event.payload as { runId?: string })?.runId;
    const enriched = { ...event, runId };

    if (runId) {
      const existing = this.buffer.get(runId) ?? [];
      existing.push(enriched);
      if (existing.length > EventsService.BUFFER_LIMIT) existing.shift();
      this.buffer.set(runId, existing);
    }
    this.stream$.next(enriched);
  }

  /** Replayable stream: late subscribers still see what already happened. */
  history(runId: string): LiveEvent[] {
    return this.buffer.get(runId) ?? [];
  }

  subscribe(runId?: string): Observable<LiveEvent> {
    return runId ? this.stream$.pipe(filter((event) => event.runId === runId)) : this.stream$;
  }
}

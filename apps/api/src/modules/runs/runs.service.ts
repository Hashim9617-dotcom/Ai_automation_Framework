import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { RunStatus, newId, type Run, type RunRequest } from '@aitp/shared';
import { EventsService } from '../events/events.service';
import { RunRepository } from './run.repository';
import { RunnerService } from './runner.service';

@Injectable()
export class RunsService {
  private readonly logger = new Logger(RunsService.name);
  /** Simple FIFO so two runs never fight over artifacts/. Redis/BullMQ replaces it in Phase 3. */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly cancelled = new Set<string>();

  constructor(
    private readonly repository: RunRepository,
    private readonly runner: RunnerService,
    private readonly events: EventsService,
  ) {}

  async enqueue(request: RunRequest): Promise<Run> {
    const run: Run = {
      id: newId('run'),
      status: RunStatus.Queued,
      request,
      createdAt: new Date().toISOString(),
      results: [],
      artifacts: {},
    };

    await this.repository.save(run);
    this.events.publish({
      event: 'run:queued',
      payload: { runId: run.id, request },
      at: run.createdAt,
      runId: run.id,
    });

    // Returns immediately; the caller polls GET /runs/:id or subscribes to SSE.
    this.queue = this.queue.then(() => this.process(run.id)).catch((error: Error) => {
      this.logger.error(`Run ${run.id} crashed: ${error.message}`);
    });

    return run;
  }

  private async process(runId: string): Promise<void> {
    const run = await this.repository.findById(runId);
    if (!run) return;

    const started: Run = {
      ...run,
      status: RunStatus.Running,
      startedAt: new Date().toISOString(),
    };
    await this.repository.save(started);

    const finished = await this.runner.execute(started);

    // A killed child produces no report, so hydrateFromReport returns `error`.
    // Preserve the cancellation the caller already saw instead of overwriting it.
    const resolved = this.cancelled.has(runId)
      ? { ...started, status: RunStatus.Cancelled, finishedAt: new Date().toISOString() }
      : finished;
    this.cancelled.delete(runId);

    await this.repository.save(resolved);
    this.logger.log(`Run ${runId} finished: ${resolved.status}`);
  }

  async get(id: string): Promise<Run> {
    const run = await this.repository.findById(id);
    if (!run) throw new NotFoundException(`Run ${id} not found`);
    return run;
  }

  list(limit = 25): Promise<Run[]> {
    return this.repository.list(limit);
  }

  async cancel(id: string): Promise<Run> {
    const run = await this.get(id);
    this.cancelled.add(id);
    const cancelled = this.runner.cancel(id);
    if (!cancelled) {
      this.cancelled.delete(id);
      return run;
    }

    const updated: Run = {
      ...run,
      status: RunStatus.Cancelled,
      finishedAt: new Date().toISOString(),
    };
    return this.repository.save(updated);
  }
}

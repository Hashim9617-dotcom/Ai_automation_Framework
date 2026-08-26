import { Injectable } from '@nestjs/common';
import type { Run } from '@aitp/shared';

export abstract class RunRepository {
  abstract save(run: Run): Promise<Run>;
  abstract findById(id: string): Promise<Run | undefined>;
  abstract list(limit: number): Promise<Run[]>;
}

/**
 * Phase 1 storage. The interface is what the rest of the API depends on, so
 * swapping in the PostgreSQL implementation (infra/prisma/schema.prisma is
 * already checked in) touches this file only.
 */
@Injectable()
export class InMemoryRunRepository extends RunRepository {
  private readonly runs = new Map<string, Run>();

  async save(run: Run): Promise<Run> {
    this.runs.set(run.id, run);
    return run;
  }

  async findById(id: string): Promise<Run | undefined> {
    return this.runs.get(id);
  }

  async list(limit: number): Promise<Run[]> {
    return Array.from(this.runs.values())
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }
}

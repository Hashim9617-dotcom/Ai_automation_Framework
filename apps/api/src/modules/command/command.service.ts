import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { findRepoRoot } from '@aitp/shared';
import { RunsService } from '../runs/runs.service';
import {
  flattenSuites,
  rank,
  tokenize,
  escapeRegex,
  type InventoryEntry,
} from '@aitp/shared';

const execFileAsync = promisify(execFile);

export const commandRequestSchema = z.object({
  /** e.g. "test complete employee registration flow" */
  command: z.string().min(3),
  environment: z.string().default('qa'),
  browsers: z.array(z.enum(['chromium', 'firefox', 'webkit'])).default(['chromium']),
  /** Resolve the command and return the plan without executing it. */
  dryRun: z.boolean().default(false),
});
export type CommandRequest = z.infer<typeof commandRequestSchema>;



/**
 * AI Command Box — Phase 1 implementation.
 *
 * It resolves an instruction against the *existing* test inventory using keyword
 * scoring, and returns an explicit plan. This is deliberately deterministic: it
 * gives the platform a working command box today, and it becomes the fallback
 * path in Phase 2 when the LLM generator is added on top (match first, generate
 * only when nothing relevant exists — which is also the cheapest strategy).
 */
@Injectable()
export class CommandService {
  private readonly logger = new Logger(CommandService.name);
  private readonly repoRoot = findRepoRoot(__dirname);
  private inventory?: InventoryEntry[];

  constructor(private readonly runs: RunsService) {}

  async interpret(request: CommandRequest) {
    const inventory = await this.loadInventory();
    const keywords = tokenize(request.command);
    const matches = rank(inventory, keywords);

    if (!matches.length) {
      return {
        resolved: false,
        command: request.command,
        keywords,
        message:
          'No existing test matched this instruction. Phase 2 (AI test-case + script generation) is what will handle this case; for now, add a test or rephrase using words from an existing test title or tag.',
        availableTags: [...new Set(inventory.flatMap((entry) => entry.tags))].sort(),
      };
    }

    // Grep matches the leaf test title; the describe-joined path does not match.
    const grep = matches.map((match) => escapeRegex(match.entry.leafTitle)).join('|');
    const plan = {
      resolved: true,
      command: request.command,
      keywords,
      matchedTests: matches.map((match) => ({
        title: match.entry.title,
        file: match.entry.file,
        tags: match.entry.tags,
        score: match.score,
      })),
      grep,
    };

    if (request.dryRun) return { ...plan, run: null };

    const run = await this.runs.enqueue({
      command: request.command,
      grep,
      environment: request.environment,
      browsers: request.browsers,
      headed: false,
      metadata: { source: 'command-box' },
    });

    return { ...plan, run };
  }

  /** `playwright test --list` is the cheapest reliable inventory source. */
  private async loadInventory(): Promise<InventoryEntry[]> {
    if (this.inventory) return this.inventory;

    try {
      const { stdout } = await execFileAsync(
        'npx',
        ['playwright', 'test', '--list', '--reporter=json'],
        { cwd: this.repoRoot, maxBuffer: 20 * 1024 * 1024, shell: process.platform === 'win32' },
      );

      const parsed = JSON.parse(stdout) as {
        suites?: Array<Record<string, unknown>>;
      };
      // --list emits one entry per project, so the same test appears N times.
      const deduped = new Map<string, InventoryEntry>();
      for (const entry of flattenSuites(parsed.suites ?? [])) {
        deduped.set(`${entry.file}::${entry.title}`, entry);
      }
      const inventory = [...deduped.values()];

      // Only cache on success — caching an empty list after a transient spawn
      // failure would disable the command box for the process lifetime.
      this.inventory = inventory;
      this.logger.log(`Loaded ${inventory.length} tests into the command inventory`);
      return inventory;
    } catch (error) {
      this.logger.error(`Could not list tests: ${(error as Error).message}`);
      return [];
    }
  }
}

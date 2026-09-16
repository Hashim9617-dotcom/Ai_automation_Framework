import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { loadEnvironment } from '@aitp/execution-engine';
import {
  describeTarget,
  escapeRegex,
  findRepoRoot,
  flattenSuites,
  planCommand,
  readFinalTestCases,
  readSheetGrid,
  type CommandPlan,
  type InventoryEntry,
  type RunTarget,
  type SheetRowRef,
} from '@aitp/shared';
import { RunsService } from '../runs/runs.service';

const execFileAsync = promisify(execFile);

export const commandRequestSchema = z.object({
  /** e.g. "test complete employee registration flow" */
  command: z.string().min(3).max(500),
  /**
   * Which door to use. `auto` walks the precedence in
   * `docs/phase-2-command-box.md` §1: existing tests, then authored sheet rows,
   * then generation. Pinning one is a deliberate choice a caller can express.
   */
  source: z.enum(['auto', 'existing', 'sheet', 'generate']).default('auto'),
  environment: z.string().default('qa'),
  browsers: z.array(z.enum(['chromium', 'firefox', 'webkit'])).default(['chromium']),
  /** Resolve the command and return the plan without executing it. */
  dryRun: z.boolean().default(false),
});
export type CommandRequest = z.infer<typeof commandRequestSchema>;

/**
 * The AI Command Box.
 *
 * Specified in `docs/phase-2-command-box.md` before being built. The decisions
 * that shape this file:
 *
 * 1. **One endpoint, one precedence** — existing tests, then authored sheet
 *    rows, then generation. The sheet beats generation because a sheet row is an
 *    EXTERNAL source of truth (rule 4) and a generated case's expectations come
 *    from the system under test.
 * 2. **A nothing-answer says what it looked in** — the plan carries `searched`
 *    and a `why` for every door that declined.
 * 3. **Nothing blocks** — a run id comes back immediately; status is polled from
 *    `/api/runs/:id` and streamed from `/api/events/stream/:runId`.
 * 4. **The command string is untrusted input from over the network.** It reaches
 *    `tokenize()` and is stored for display. It is never a file path, never a
 *    shell argument, and the only thing built from it — the `--grep` — is
 *    assembled from ESCAPED test titles this repo already owns, never from the
 *    command text itself.
 * 5. **Every answer states its target**, resolved and computed, so a demo run
 *    can never read as one against a customer system.
 *
 * The precedence itself lives in `planCommand()` in `@aitp/shared` — a pure
 * function, so the load-bearing decision is testable without Nest, a browser or
 * a model.
 */
@Injectable()
export class CommandService {
  private readonly logger = new Logger(CommandService.name);
  private readonly repoRoot = findRepoRoot(__dirname);
  /** Keyed by environment: the config lists different tests per TEST_ENV. */
  private readonly inventory = new Map<string, InventoryEntry[]>();

  constructor(private readonly runs: RunsService) {}

  async interpret(request: CommandRequest) {
    const inventory = await this.loadInventory(request.environment);
    const capture = this.loadCaptureStates();
    const sheetRows = this.loadSheetRows();

    const plan = planCommand({
      command: request.command,
      source: request.source,
      inventory,
      sheetRows,
      captureStates: capture?.states ?? null,
      capturedAt: capture?.capturedAt ?? null,
    });

    const target = this.resolveTarget(request.environment);
    this.logger.log(
      `Command "${request.command}" -> door=${plan.door} target=${target.baseUrl} (demo=${target.isDemoApp})`,
    );

    const base = {
      command: request.command,
      door: plan.door,
      searched: plan.searched,
      skipped: plan.skipped,
      reason: plan.reason,
      target,
      // `null` inventory means it could not be loaded, so there are no tags to
      // suggest — an empty list here is honest, because `skipped` already says
      // the inventory was never searched.
      availableTags: [...new Set((inventory ?? []).flatMap((entry) => entry.tags))].sort(),
    };

    if (plan.door === 'existing') return this.runExisting(plan, request, base);
    if (plan.door === 'sheet') return this.planSheet(plan, base);
    if (plan.door === 'generate') return this.planGeneration(plan, base);

    return { ...base, resolved: false, run: null };
  }

  /** Door 1 — the finished path: matched tests become a grep and a run. */
  private async runExisting(
    plan: CommandPlan,
    request: CommandRequest,
    base: Record<string, unknown>,
  ) {
    // Built from test titles this repo owns, each ESCAPED — never from the
    // command text. The command string never reaches an argument vector.
    const grep = plan.matched
      .map((match) => escapeRegex(match.title.split(' › ').at(-1) ?? match.title))
      .join('|');

    const resolved = {
      ...base,
      resolved: true,
      matchedTests: plan.matched,
      grep,
    };

    if (request.dryRun) return { ...resolved, run: null };

    const run = await this.runs.enqueue({
      command: request.command,
      grep,
      environment: request.environment,
      browsers: request.browsers,
      headed: false,
      // The target travels ON the run record, so a result read later states what
      // it ran against without anyone re-deriving it.
      metadata: {
        source: 'command-box',
        door: 'existing',
        targetBaseUrl: (base.target as RunTarget).baseUrl,
        targetIsDemoApp: String((base.target as RunTarget).isDemoApp),
      },
    });

    return { ...resolved, run };
  }

  /**
   * Door 2 — authored sheet rows.
   *
   * Reports the matching rows and stops. Executing them is `executeAuthoredRows`
   * in-process against a browser this API drives — a second execution strategy
   * that `RunnerService` does not have yet (§3). Reporting the match honestly
   * beats pretending to run it.
   */
  private planSheet(plan: CommandPlan, base: Record<string, unknown>) {
    return {
      ...base,
      resolved: true,
      sheetMatches: plan.sheetMatches,
      run: null,
      note:
        `${plan.sheetMatches.length} authored row(s) match. Executing authored rows needs the ` +
        'in-process runner described in docs/phase-2-command-box.md §3, which is not built yet — ' +
        'so these rows are reported, not run.',
    };
  }

  /**
   * Door 3 — generation.
   *
   * Produces PROPOSALS, never a run. Generated expectations come from the system
   * under test, so every assertion is reviewed and approved by a human before
   * anything is emitted — `pnpm generate:review`. A Command Box that ran
   * generated tests directly would bypass the approval this platform is built
   * around, which is the one shortcut not on offer.
   */
  private planGeneration(plan: CommandPlan, base: Record<string, unknown>) {
    return {
      ...base,
      resolved: true,
      run: null,
      note:
        'Nothing existing or authored matched, so this command is a candidate for generation. ' +
        'Generated cases are PROPOSALS: they are reviewed per assertion with `pnpm generate:review` ' +
        'and only approved, grounded assertions are ever emitted. Nothing runs from this response.',
    };
  }

  /** What this environment key ACTUALLY resolves to — computed, never declared. */
  private resolveTarget(environment: string): RunTarget {
    try {
      return describeTarget(environment, loadEnvironment(environment).baseUrl);
    } catch (error) {
      this.logger.warn(`Could not resolve environment "${environment}": ${String(error)}`);
      return { environment, baseUrl: '(unresolved)', isDemoApp: false };
    }
  }

  /**
   * The newest capture on disk, or `null` when there is none.
   *
   * `null` and "a capture with no states" are different answers with different
   * next steps, so they are kept distinct all the way to the response.
   */
  private loadCaptureStates(): { states: string[]; capturedAt: string | null } | null {
    const dir = path.join(this.repoRoot, 'artifacts', 'inspect');
    if (!existsSync(dir)) return null;

    let best: { states: string[]; capturedAt: string | null } | null = null;
    for (const session of readdirSync(dir)) {
      const file = path.join(dir, session, 'capture.json');
      if (!existsSync(file)) continue;
      try {
        const capture = JSON.parse(readFileSync(file, 'utf8')) as {
          states?: Array<{ id: string }>;
          capturedAt?: string;
        };
        const states = (capture.states ?? []).map((state) => state.id);
        if (!best || states.length > best.states.length) {
          best = { states, capturedAt: capture.capturedAt ?? null };
        }
      } catch {
        // A malformed capture is not a configured one.
      }
    }
    return best;
  }

  /**
   * Authored rows, when a workbook is configured.
   *
   * `AITP_SHEET_PATH` names it. Absent means `null` — NOT CONFIGURED, which the
   * response reports differently from an empty sheet. The workbook itself never
   * enters the repo: it carries live credentials (§the sheet is read-only input).
   */
  private loadSheetRows(): SheetRowRef[] | null {
    const configured = process.env.AITP_SHEET_PATH;
    if (!configured || !existsSync(configured)) return null;
    try {
      // Statically imported. An earlier draft required this lazily "so a
      // missing workbook cannot stop the API booting" — which was wrong about
      // what the risk was: the FILE may be absent, the MODULE never is. The
      // `existsSync` above and this `catch` handle the file; the import is an
      // ordinary dependency.
      const grid = readSheetGrid(readFileSync(configured), 'Final Test cases');
      return readFinalTestCases(grid).rows.map((row) => ({
        rowId: row.rowId,
        text: [row.module, row.feature, row.scenarioName, row.objective].filter(Boolean).join(' '),
      }));
    } catch (error) {
      this.logger.warn(`Could not read the workbook at ${configured}: ${String(error)}`);
      return null;
    }
  }

  /**
   * `playwright test --list` is the cheapest reliable inventory source.
   *
   * Returns `null` when it could not be loaded — NOT an empty array. An empty
   * array is a claim that the suite has no tests, and the planner reports it as
   * "nothing matched". On 2026-09-16 this returned `[]` because the JSON was
   * unparseable, and every command fell through to generation while 446 tests
   * sat unsearched. A failed search must never look like an empty result.
   */
  private async loadInventory(environment: string): Promise<InventoryEntry[] | null> {
    const cached = this.inventory.get(environment);
    if (cached) return cached;

    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        [require.resolve('@playwright/test/cli'), 'test', '--list', '--reporter=json'],
        {
          cwd: this.repoRoot,
          maxBuffer: 20 * 1024 * 1024,
          // LIST FOR THE ENVIRONMENT THE CALLER ASKED FOR.
          //
          // `playwright.config.ts` chooses which tests exist from TEST_ENV:
          // `local` ignores `tests/app/**`, anything else ignores
          // `tests/demo/**`. Inheriting the API's own TEST_ENV therefore
          // answered a request for `local` with the DMS suite — and had a
          // match been found, a test written for a customer system would have
          // been run against the demo app.
          //
          // The inventory is a function of the environment, so it is cached per
          // environment rather than once per process.
          env: { ...process.env, TEST_ENV: environment },
        },
      );

      const parsed = JSON.parse(extractJsonObject(stdout)) as {
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
      this.inventory.set(environment, inventory);
      this.logger.log(`Loaded ${inventory.length} tests for environment "${environment}"`);
      return inventory;
    } catch (error) {
      this.logger.error(`Could not list tests: ${(error as Error).message}`);
      return null;
    }
  }
}

/**
 * Playwright's JSON, out of a stdout that also carries our own log lines.
 *
 * `playwright.config.ts` calls `loadEnvironment()` while the config loads, and
 * the repo's logger writes "Resolved environment {...}" to STDOUT — so
 * `--reporter=json` is preceded by a log line that is not JSON, and
 * `JSON.parse` fails at position 4 every time.
 *
 * Slicing from the first `{` is not enough: that log line contains a `{` of its
 * own, inside its payload. Playwright's document begins on a line that is
 * exactly `{`, so that is what this looks for — and it THROWS rather than
 * returning something unparseable, because the caller distinguishes "could not
 * load" from "loaded nothing" and needs the failure to be real.
 */
export function extractJsonObject(stdout: string): string {
  const lines = stdout.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === '{');
  if (start === -1) {
    throw new Error(
      'no JSON document found in the reporter output — its first line was: ' +
        `${JSON.stringify(lines[0]?.slice(0, 120) ?? '')}`,
    );
  }
  return lines.slice(start).join('\n');
}

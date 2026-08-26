import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import {
  LlmRootCauseAnalyzer,
  MockLlmGateway,
  createLlmGateway,
  enrichRunWithRca,
} from '@aitp/ai-engine';
import { renderRunSummaryHtml } from '@aitp/reporting-engine';
import { RunStatus, findRepoRoot, type Run, type RunRequest } from '@aitp/shared';
import { EventsService } from '../events/events.service';

/**
 * Executes a Playwright suite as a child process.
 *
 * Kept behind this one class deliberately: Phase 4 replaces the local spawn with
 * a Docker-per-job runner (the architecture doc's isolation decision) and nothing
 * upstream has to change.
 */
@Injectable()
export class RunnerService {
  private readonly logger = new Logger(RunnerService.name);
  private readonly repoRoot = findRepoRoot(__dirname);
  private readonly active = new Map<string, ReturnType<typeof spawn>>();

  constructor(private readonly events: EventsService) {}

  async execute(run: Run): Promise<Run> {
    const args = this.buildArgs(run.request);
    const apiPort = process.env.API_PORT ?? 3001;

    this.logger.log(`Starting run ${run.id}: npx playwright ${args.join(' ')}`);

    const child = spawn('npx', ['playwright', ...args], {
      cwd: this.repoRoot,
      env: {
        ...process.env,
        TEST_ENV: run.request.environment,
        AITP_RUN_ID: run.id,
        AITP_LIVE_ENDPOINT: `http://127.0.0.1:${apiPort}/api/events`,
        CI: 'true',
        FORCE_COLOR: '0',
      },
      shell: process.platform === 'win32',
    });
    this.active.set(run.id, child);

    child.stdout?.on('data', (chunk: Buffer) => this.forwardLog(run.id, chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => this.forwardLog(run.id, chunk.toString(), true));

    const exitCode = await new Promise<number>((resolve) => {
      child.on('close', (code) => resolve(code ?? 1));
      child.on('error', (error) => {
        this.logger.error(`Run ${run.id} failed to start: ${error.message}`);
        resolve(1);
      });
    });
    this.active.delete(run.id);

    const hydrated = this.hydrateFromReport(run, exitCode);
    return this.analyzeFailures(hydrated);
  }

  /**
   * Triage runs after execution, never during it: a slow or unavailable model
   * must not delay results. A failure here is logged and swallowed — the run's
   * own verdict is already decided.
   */
  private async analyzeFailures(run: Run): Promise<Run> {
    if (process.env.RCA_AUTO === 'false') return run;
    if (!run.results.some((result) => result.error)) return run;

    try {
      const gateway = createLlmGateway();
      if (gateway instanceof MockLlmGateway) {
        this.logger.warn(`Run ${run.id} has failures but no LLM key is configured — skipping analysis.`);
        return run;
      }

      const analyzer = new LlmRootCauseAnalyzer(gateway);
      const { analyzed, reused } = await enrichRunWithRca(run, analyzer);

      // Both artifacts, or the HTML report silently keeps showing the
      // pre-analysis state while run.json says otherwise.
      const reportsDir = path.join(this.repoRoot, 'artifacts', 'reports');
      writeFileSync(path.join(reportsDir, 'run.json'), JSON.stringify(run, null, 2), 'utf8');
      writeFileSync(path.join(reportsDir, 'summary.html'), renderRunSummaryHtml(run), 'utf8');
      this.logger.log(`Run ${run.id}: analyzed ${analyzed} failure(s), reused ${reused}`);
      this.events.publish({
        event: 'run:analyzed',
        payload: { runId: run.id, analyzed, reused },
        at: new Date().toISOString(),
        runId: run.id,
      });
    } catch (error) {
      this.logger.warn(`Root cause analysis skipped for ${run.id}: ${(error as Error).message}`);
    }
    return run;
  }

  cancel(runId: string): boolean {
    const child = this.active.get(runId);
    if (!child) return false;
    child.kill('SIGTERM');
    this.active.delete(runId);
    return true;
  }

  private buildArgs(request: RunRequest): string[] {
    const args = ['test'];
    for (const browser of request.browsers) args.push(`--project=${browser}`);
    if (request.grep) args.push(`--grep=${request.grep}`);
    if (request.headed) args.push('--headed');
    if (request.workers) args.push(`--workers=${request.workers}`);
    if (request.retries !== undefined) args.push(`--retries=${request.retries}`);
    return args;
  }

  private forwardLog(runId: string, text: string, isError = false): void {
    for (const line of text.split('\n').filter((entry) => entry.trim())) {
      this.events.publish({
        event: isError ? 'run:stderr' : 'run:stdout',
        payload: { runId, line },
        at: new Date().toISOString(),
        runId,
      });
    }
  }

  /** The reporter writes artifacts/reports/run.json; that file is the source of truth. */
  private hydrateFromReport(run: Run, exitCode: number): Run {
    const reportPath = path.join(this.repoRoot, 'artifacts', 'reports', 'run.json');

    if (!existsSync(reportPath)) {
      return {
        ...run,
        status: RunStatus.Error,
        finishedAt: new Date().toISOString(),
        error: `No run.json produced (playwright exited with ${exitCode}). Check the run log.`,
      };
    }

    try {
      const report = JSON.parse(readFileSync(reportPath, 'utf8')) as Run;

      // The child gets AITP_RUN_ID and the reporter honours it. A mismatch means
      // Playwright died before writing (bad npx, missing browsers, config error)
      // and we are looking at the PREVIOUS run — reporting that as this run's
      // result would turn a failed launch into a green run.
      if (report.id !== run.id) {
        return {
          ...run,
          status: RunStatus.Error,
          finishedAt: new Date().toISOString(),
          error: `Playwright exited with ${exitCode} without writing a report for this run. Check the run log.`,
        };
      }

      return { ...report, id: run.id, request: run.request, createdAt: run.createdAt };
    } catch (error) {
      return {
        ...run,
        status: RunStatus.Error,
        finishedAt: new Date().toISOString(),
        error: `Could not parse run.json: ${(error as Error).message}`,
      };
    }
  }
}


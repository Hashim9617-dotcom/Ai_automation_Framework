import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase as PwTestCase,
  TestResult as PwTestResult,
} from '@playwright/test/reporter';
import {
  RunStatus,
  TestOutcome,
  newId,
  rootLogger,
  summarize,
  type FailureContext,
  type Run,
  type TestResult,
} from '@aitp/shared';
import { renderRunSummaryHtml } from '../html/summary';

export interface AitpReporterOptions {
  /** Directory for run.json / summary.html. Defaults to artifacts/reports. */
  outputDir?: string;
  /** POST live events here so the Phase 3 dashboard can stream them. */
  liveEndpoint?: string;
}

/**
 * Emits the platform's own canonical Run document alongside Playwright's HTML
 * report. Everything downstream — dashboard, email, Jira, Slack — reads this one
 * shape instead of parsing Playwright internals, so those integrations never
 * break when Playwright changes its report format.
 */
export default class AitpReporter implements Reporter {
  private readonly log = rootLogger.child('reporter');
  private readonly outputDir: string;
  private readonly liveEndpoint?: string;
  private readonly results: TestResult[] = [];
  private run: Run;
  private startedAt = Date.now();

  constructor(options: AitpReporterOptions = {}) {
    this.outputDir = options.outputDir ?? path.join(process.cwd(), 'artifacts', 'reports');
    this.liveEndpoint = options.liveEndpoint ?? process.env.AITP_LIVE_ENDPOINT;
    this.run = {
      id: process.env.AITP_RUN_ID ?? newId('run'),
      status: RunStatus.Queued,
      request: {
        environment: process.env.TEST_ENV ?? 'qa',
        browsers: ['chromium'],
        headed: false,
        metadata: {},
      },
      createdAt: new Date().toISOString(),
      results: [],
      artifacts: {},
    };
  }

  onBegin(_config: FullConfig, suite: Suite): void {
    this.startedAt = Date.now();
    this.run.status = RunStatus.Running;
    this.run.startedAt = new Date().toISOString();
    this.log.info('Run started', { runId: this.run.id, tests: suite.allTests().length });
    void this.emit('run:started', { runId: this.run.id, total: suite.allTests().length });
  }

  onTestBegin(test: PwTestCase): void {
    void this.emit('test:started', { runId: this.run.id, title: test.title });
  }

  onTestEnd(test: PwTestCase, result: PwTestResult): void {
    const outcomeMap: Record<string, TestOutcome> = {
      passed: TestOutcome.Passed,
      failed: TestOutcome.Failed,
      timedOut: TestOutcome.TimedOut,
      skipped: TestOutcome.Skipped,
      interrupted: TestOutcome.Failed,
    };

    const outcome =
      test.outcome() === 'flaky' ? TestOutcome.Flaky : (outcomeMap[result.status] ?? TestOutcome.Failed);

    const entry: TestResult = {
      id: test.id,
      title: test.titlePath().slice(1).join(' › '),
      file: path.relative(process.cwd(), test.location.file),
      project: test.parent.project()?.name ?? 'default',
      tags: test.tags ?? [],
      outcome,
      durationMs: result.duration,
      retry: result.retry,
      steps: result.steps.map((step) => ({
        title: step.title,
        durationMs: step.duration,
        error: step.error?.message,
      })),
      // Includes both file-backed attachments (screenshots, video, trace) and
      // in-memory ones (locator telemetry, diagnostics) — the AI layer needs the
      // latter, so filtering on `path` alone would silently drop them.
      attachments: result.attachments.map((attachment) => ({
        name: attachment.name,
        path: attachment.path ? path.relative(process.cwd(), attachment.path) : 'inline',
        contentType: attachment.contentType,
      })),
    };

    if (result.error) {
      entry.error = {
        message: stripAnsi(result.error.message ?? 'Unknown error'),
        stack: stripAnsi(result.error.stack ?? ''),
        // error.rca is filled in afterwards by the root cause analyzer.
      };
      const context = readFailureContext(result);
      if (context) entry.context = context;
    }

    this.results.push(entry);
    void this.emit('test:finished', { runId: this.run.id, result: entry });
  }

  async onEnd(result: FullResult): Promise<void> {
    // A retried test fires onTestEnd once per attempt, so `this.results` holds
    // one entry per attempt — kept in full below, because which attempt failed
    // and why is exactly the evidence RCA and manual triage need. But counting
    // straight from that list double-, triple- (or worse-) counts every
    // retried test: a suite of 45 tests with 18 retried failures reported a
    // total of 63. `total`/`failed`/`passRate` must reflect one row per
    // distinct test — its final attempt, the one that actually decided
    // pass/fail — not one row per attempt.
    this.run.results = this.results;
    this.run.summary = summarize(finalAttemptPerTest(this.results));
    this.run.finishedAt = new Date().toISOString();
    this.run.summary.durationMs = Date.now() - this.startedAt;
    this.run.status =
      result.status === 'passed'
        ? RunStatus.Passed
        : result.status === 'interrupted'
          ? RunStatus.Cancelled
          : RunStatus.Failed;

    mkdirSync(this.outputDir, { recursive: true });
    const jsonPath = path.join(this.outputDir, 'run.json');
    const htmlPath = path.join(this.outputDir, 'summary.html');

    // Artifact paths must be set BEFORE serialising — run.json is the source of
    // truth the API hydrates from, so anything assigned after the write is lost.
    this.run.artifacts = {
      runJson: path.relative(process.cwd(), jsonPath),
      summaryHtml: path.relative(process.cwd(), htmlPath),
      playwrightHtml: path.join('artifacts', 'reports', 'html', 'index.html'),
    };

    writeFileSync(jsonPath, JSON.stringify(this.run, null, 2), 'utf8');
    writeFileSync(htmlPath, renderRunSummaryHtml(this.run), 'utf8');

    this.log.info('Run finished', {
      runId: this.run.id,
      status: this.run.status,
      ...this.run.summary,
    });
    await this.emit('run:finished', { runId: this.run.id, run: this.run });
  }

  printsToStdio(): boolean {
    return false;
  }

  /** Fire-and-forget live event; never fails a run because the dashboard is down. */
  private async emit(event: string, payload: unknown): Promise<void> {
    if (!this.liveEndpoint) return;
    try {
      await fetch(this.liveEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ event, payload, at: new Date().toISOString() }),
      });
    } catch (error) {
      this.log.debug('Live event delivery failed', { event, error: (error as Error).message });
    }
  }
}

/**
 * Collapses per-attempt results down to one entry per distinct test id,
 * keeping the highest `retry` — the attempt that actually determined the
 * test's final outcome (Playwright retries in increasing order, and a test
 * that eventually passes after failing is reported as `flaky` only on that
 * last attempt). Exported so the counting rule has direct unit coverage
 * separate from a full reporter run.
 */
export function finalAttemptPerTest(results: TestResult[]): TestResult[] {
  const byId = new Map<string, TestResult>();
  for (const result of results) {
    const existing = byId.get(result.id);
    if (!existing || result.retry > existing.retry) byId.set(result.id, result);
  }
  return [...byId.values()];
}

function stripAnsi(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/\u001b\[[0-9;]*m/g, '');
}

/**
 * Lifts the JSON attachments the execution engine produced into structured
 * fields on the result, so run.json is self-contained: the analyzer, the
 * dashboard and the Jira integration never have to go hunting for side files.
 */
function readFailureContext(result: PwTestResult): FailureContext | undefined {
  const read = <T>(name: string): T | undefined => {
    const attachment = result.attachments.find((entry) => entry.name === name);
    if (!attachment?.body) return undefined;
    try {
      return JSON.parse(attachment.body.toString('utf8')) as T;
    } catch {
      return undefined;
    }
  };

  const diagnostics = read<{
    consoleErrors: string[];
    pageErrors: string[];
    failedRequests: string[];
  }>('diagnostics.json');
  const domSnapshot = read<FailureContext['domSnapshot']>('dom-snapshot.json');
  const locatorTelemetry = read<FailureContext['locatorTelemetry']>('locator-telemetry.json');
  const healingGate = read<FailureContext['healingGate']>('healing-gate.json');
  const healingContext = read<FailureContext['healingContext']>('healing-context.json');

  const context: FailureContext = {
    ...(diagnostics ?? {}),
    ...(domSnapshot ? { domSnapshot } : {}),
    ...(locatorTelemetry ? { locatorTelemetry } : {}),
    ...(healingGate ? { healingGate } : {}),
    ...(healingContext ? { healingContext } : {}),
  };

  return Object.keys(context).length > 0 ? context : undefined;
}

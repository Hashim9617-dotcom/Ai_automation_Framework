import { z } from 'zod';
import type { AccessibilityTreeSnapshot, DomSnapshot, HealingGateVerdict, HealingProposal } from './ai';
import type { LocatorResolution } from './locator';

/** Lifecycle of a single execution request (one "run" = one suite invocation). */
export const RunStatus = {
  Queued: 'queued',
  Running: 'running',
  Passed: 'passed',
  Failed: 'failed',
  Cancelled: 'cancelled',
  Error: 'error',
} as const;
export type RunStatus = (typeof RunStatus)[keyof typeof RunStatus];

export const TestOutcome = {
  Passed: 'passed',
  Failed: 'failed',
  Skipped: 'skipped',
  TimedOut: 'timedOut',
  Flaky: 'flaky',
} as const;
export type TestOutcome = (typeof TestOutcome)[keyof typeof TestOutcome];

export const runRequestSchema = z.object({
  /** Human intent, e.g. "test complete employee registration flow". Optional for grep-based runs. */
  command: z.string().min(3).optional(),
  /** Playwright --grep expression, e.g. "@smoke". */
  grep: z.string().optional(),
  /** Target environment key resolved against config/env/*.json. */
  environment: z.string().default('qa'),
  browsers: z.array(z.enum(['chromium', 'firefox', 'webkit'])).default(['chromium']),
  headed: z.boolean().default(false),
  workers: z.number().int().min(1).max(32).optional(),
  retries: z.number().int().min(0).max(5).optional(),
  /** Free-form metadata forwarded to reports and integrations (Jira key, build number...). */
  metadata: z.record(z.string()).default({}),
});
export type RunRequest = z.infer<typeof runRequestSchema>;

/**
 * How a failure is classified. This is the field that makes failure analytics
 * worth anything in Phase 4 — "37% of last month's failures were environment,
 * not product" is only answerable if every failure carries a category.
 */
export const FailureCategory = {
  ApplicationBug: 'application-bug',
  TestBug: 'test-bug',
  Environment: 'environment',
  TestData: 'test-data',
  Selector: 'selector',
  Flaky: 'flaky',
  Unknown: 'unknown',
} as const;
export type FailureCategory = (typeof FailureCategory)[keyof typeof FailureCategory];

export interface RootCauseAnalysis {
  /** One or two sentences a developer can act on. */
  rootCause: string;
  category: FailureCategory;
  /** 0..1. Below ~0.5 the report presents it as a guess, not a finding. */
  confidence: number;
  suggestedFix?: string;
  /** Exact lines from the evidence that led to the conclusion — keeps it checkable. */
  evidence: string[];
  analyzedBy: string;
  analyzedAt: string;
}

/**
 * Everything captured at the moment of failure. Collected by the execution
 * engine while the page is still alive, then carried in run.json so analysis can
 * happen later, out of band, without re-running anything.
 */
export interface FailureContext {
  consoleErrors?: string[];
  pageErrors?: string[];
  failedRequests?: string[];
  domSnapshot?: DomSnapshot;
  locatorTelemetry?: LocatorResolution[];
  /** One entry per exhausted-chain locator failure in this test — see docs/phase-2-healing.md. */
  healingGate?: HealingGateVerdict[];
  /** Present only if at least one entry above was eligible — the shared evidence `propose()` needs. */
  healingContext?: AccessibilityTreeSnapshot;
}

export interface TestStepResult {
  title: string;
  durationMs: number;
  error?: string;
}

export interface TestResult {
  id: string;
  title: string;
  file: string;
  project: string;
  tags: string[];
  outcome: TestOutcome;
  durationMs: number;
  retry: number;
  error?: {
    message: string;
    stack?: string;
    /** Filled by the AI root cause analyzer after the run. */
    rca?: RootCauseAnalysis;
  };
  /** Present on failures only — the evidence the analyzer consumes. */
  context?: FailureContext;
  steps: TestStepResult[];
  attachments: Array<{ name: string; path: string; contentType: string }>;
}

export interface RunSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  flaky: number;
  durationMs: number;
  passRate: number;
}

export interface Run {
  id: string;
  status: RunStatus;
  request: RunRequest;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  summary?: RunSummary;
  results: TestResult[];
  /** Relative paths under artifacts/ for html report, trace, video, log. */
  artifacts: Record<string, string>;
  error?: string;
  /**
   * Filled by an out-of-band pass (`pnpm heal`, docs/phase-2-healing.md),
   * never by the run itself — a failing test's outcome never depends on
   * this. `pnpm heal:review` reads and mutates this in place, same pattern
   * `pnpm rca` already uses for `TestResult.error.rca`.
   */
  healingProposals?: HealingProposal[];
}

export function emptySummary(): RunSummary {
  return { total: 0, passed: 0, failed: 0, skipped: 0, flaky: 0, durationMs: 0, passRate: 0 };
}

export function summarize(results: TestResult[]): RunSummary {
  const summary = emptySummary();
  for (const result of results) {
    summary.total += 1;
    summary.durationMs += result.durationMs;
    switch (result.outcome) {
      case TestOutcome.Passed:
        summary.passed += 1;
        break;
      case TestOutcome.Flaky:
        summary.passed += 1;
        summary.flaky += 1;
        break;
      case TestOutcome.Skipped:
        summary.skipped += 1;
        break;
      default:
        summary.failed += 1;
    }
  }
  const executed = summary.total - summary.skipped;
  summary.passRate = executed === 0 ? 0 : Number(((summary.passed / executed) * 100).toFixed(2));
  return summary;
}

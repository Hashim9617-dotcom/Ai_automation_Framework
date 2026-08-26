import {
  TestOutcome,
  positiveIntFromEnv,
  rootLogger,
  type Run,
  type RootCauseAnalysis,
  type RootCauseAnalyzer,
  type TestResult,
} from '@aitp/shared';
import { fingerprint } from './analyzer';

const log = rootLogger.child('rca-enrich');

export interface EnrichOptions {
  /** Hard cap on distinct failures analyzed per run — cost control. */
  maxFailures?: number;
  /** How many analyses run at once. Keep low; providers rate-limit. */
  concurrency?: number;
}

export interface EnrichResult {
  run: Run;
  analyzed: number;
  reused: number;
  skipped: number;
}

function isFailure(result: TestResult): boolean {
  return result.outcome === TestOutcome.Failed || result.outcome === TestOutcome.TimedOut;
}

/**
 * Adds root cause analysis to every failure in a completed Run.
 *
 * Deliberately a separate pass over `run.json` rather than something that
 * happens during execution: triage must never slow a run down, must be
 * re-runnable against an archived report, and must be skippable entirely.
 *
 * Identical failures share one analysis — the same test failing on chromium,
 * firefox, webkit and mobile-chrome is one bug, so it costs one call.
 */
export async function enrichRunWithRca(
  run: Run,
  analyzer: RootCauseAnalyzer,
  options: EnrichOptions = {},
): Promise<EnrichResult> {
  const maxFailures =
    options.maxFailures ?? positiveIntFromEnv(process.env.RCA_MAX_FAILURES, 20);
  const concurrency = Math.max(1, options.concurrency ?? 3);

  const failures = run.results.filter(isFailure);
  if (failures.length === 0) return { run, analyzed: 0, reused: 0, skipped: 0 };

  // Group by fingerprint so cross-browser duplicates collapse into one job.
  const groups = new Map<string, TestResult[]>();
  for (const failure of failures) {
    const key = fingerprint({
      testTitle: failure.title,
      testFile: failure.file,
      error: failure.error?.message ?? 'unknown error',
    });
    groups.set(key, [...(groups.get(key) ?? []), failure]);
  }

  const jobs = [...groups.values()];
  const skipped = Math.max(0, jobs.length - maxFailures);
  const selected = jobs.slice(0, maxFailures);

  if (skipped > 0) {
    log.warn('Analyzing only the first distinct failures in this run', {
      analyzing: selected.length,
      skipped,
      maxFailures,
    });
  }

  let analyzed = 0;
  let reused = 0;

  for (let index = 0; index < selected.length; index += concurrency) {
    const batch = selected.slice(index, index + concurrency);

    await Promise.all(
      batch.map(async (group) => {
        const [first] = group;
        if (!first?.error) return;

        const analysis: RootCauseAnalysis = await analyzer.analyze({
          testTitle: first.title,
          testFile: first.file,
          error: first.error.message,
          stack: first.error.stack,
          steps: first.steps.map((step) => step.title),
          context: first.context,
        });

        for (const result of group) {
          if (result.error) result.error.rca = analysis;
        }
        analyzed += 1;
        reused += group.length - 1;
      }),
    );
  }

  log.info('Root cause analysis complete', {
    distinctFailures: jobs.length,
    analyzed,
    reusedAcrossProjects: reused,
    skipped,
  });

  return { run, analyzed, reused, skipped };
}

#!/usr/bin/env node
/**
 * Root cause analysis over the last run.
 *
 *   pnpm rca
 *
 * Reads artifacts/reports/run.json, analyzes every distinct failure, writes the
 * verdicts back into run.json and regenerates summary.html.
 *
 * Safe to run on a green report (does nothing) and safe to run twice (identical
 * failures hit the LLM cache). With no API key configured it says so and exits
 * without touching the report, rather than failing the pipeline.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  LlmRootCauseAnalyzer,
  MockLlmGateway,
  createLlmGateway,
  enrichRunWithRca,
} from '@aitp/ai-engine';
import { renderRunSummaryHtml } from '@aitp/reporting-engine';
import { findRepoRoot, rootLogger, type Run } from '@aitp/shared';

const log = rootLogger.child('rca-cli');

async function main(): Promise<void> {
  const reportsDir = path.join(findRepoRoot(__dirname), 'artifacts', 'reports');
  const runJson = path.join(reportsDir, 'run.json');

  if (!existsSync(runJson)) {
    log.error('No artifacts/reports/run.json found. Run the suite first.');
    process.exitCode = 1;
    return;
  }

  const run = JSON.parse(readFileSync(runJson, 'utf8')) as Run;
  const failures = run.results.filter((result) => result.error).length;

  if (failures === 0) {
    log.info('No failures in the last run — nothing to analyze.', { runId: run.id });
    return;
  }

  const gateway = createLlmGateway();

  // Better to say nothing than to fill the report with "analysis unavailable"
  // verdicts that look like findings.
  if (gateway instanceof MockLlmGateway) {
    log.warn(
      'No LLM API key configured — skipping analysis. Set ANTHROPIC_API_KEY in .env and run `pnpm rca` again.',
      { failures },
    );
    return;
  }

  const analyzer = new LlmRootCauseAnalyzer(gateway);

  const { analyzed, reused, skipped } = await enrichRunWithRca(run, analyzer);

  writeFileSync(runJson, JSON.stringify(run, null, 2), 'utf8');
  writeFileSync(path.join(reportsDir, 'summary.html'), renderRunSummaryHtml(run), 'utf8');

  log.info('Report updated with root cause analysis', {
    runId: run.id,
    failures,
    analyzed,
    reused,
    skipped,
    summary: path.relative(process.cwd(), path.join(reportsDir, 'summary.html')),
  });
}

main().catch((error: Error) => {
  log.error('Root cause analysis failed', { error: error.message });
  process.exitCode = 1;
});

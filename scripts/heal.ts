#!/usr/bin/env node
/**
 * Self-healing proposal pass over the last run (docs/phase-2-healing.md).
 *
 *   pnpm heal
 *
 * Reads artifacts/reports/run.json, proposes a verified candidate for every
 * eligible locator failure, writes the proposals back into run.json. Never
 * touches a page object — that only happens if a human runs
 * `pnpm heal:review` afterward and explicitly approves one.
 *
 * Mirrors `pnpm rca` (scripts/analyze-failures.ts) deliberately: same
 * fingerprint/dedup, same disk cache (via the LLM gateway), same budget cap,
 * same "say nothing rather than fake a result" behavior with no API key.
 * Safe to run on a run with nothing eligible (does nothing) and safe to run
 * twice (a proposal already recorded for a given key+description is not
 * duplicated).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  LlmSelfHealingEngine,
  MockLlmGateway,
  createLlmGateway,
  enrichRunWithHealing,
} from '@aitp/ai-engine';
import { loadEnvironment } from '@aitp/execution-engine';
import { findRepoRoot, rootLogger, type Run } from '@aitp/shared';

const log = rootLogger.child('heal-cli');

async function main(): Promise<void> {
  // createLlmGateway() reads process.env directly — nothing loads .env into
  // it unless something calls loadEnvironment() first. See the identical
  // fix in scripts/analyze-failures.ts and scripts/eval-healing.ts for why
  // this line is load-bearing, not decorative.
  const env = loadEnvironment();

  if (!env.features.selfHealing) {
    log.error(
      `env.features.selfHealing is false for "${env.name}" — refusing to run. ` +
        `Set it to true in config/env/${env.name}.json to enable proposal generation.`,
    );
    process.exitCode = 1;
    return;
  }

  const reportsDir = path.join(findRepoRoot(__dirname), 'artifacts', 'reports');
  const runJson = path.join(reportsDir, 'run.json');

  if (!existsSync(runJson)) {
    log.error('No artifacts/reports/run.json found. Run the suite first.');
    process.exitCode = 1;
    return;
  }

  const run = JSON.parse(readFileSync(runJson, 'utf8')) as Run;
  const eligibleCount = run.results.filter((r) => r.context?.healingGate?.some((v) => v.eligible)).length;

  if (eligibleCount === 0) {
    log.info('No gate-eligible locator failures in the last run — nothing to propose.', {
      runId: run.id,
    });
    return;
  }

  const gateway = createLlmGateway();

  // Better to say nothing than to fill the report with proposals generated
  // against a mock's canned nonsense.
  if (gateway instanceof MockLlmGateway) {
    log.warn(
      'No LLM API key configured — skipping proposal generation. Set ANTHROPIC_API_KEY in .env and run `pnpm heal` again.',
      { eligibleCount },
    );
    return;
  }

  const engine = new LlmSelfHealingEngine(gateway);

  const { proposed, declined, reused, skipped, ineligible } = await enrichRunWithHealing(run, engine);

  writeFileSync(runJson, JSON.stringify(run, null, 2), 'utf8');

  log.info('Report updated with self-healing proposals', {
    runId: run.id,
    proposed,
    declined,
    reused,
    skipped,
    ineligible,
    nextStep: proposed > 0 ? 'run `pnpm heal:review` to review and approve' : undefined,
  });
}

main().catch((error: Error) => {
  log.error('Self-healing proposal pass failed', { error: error.message });
  process.exitCode = 1;
});

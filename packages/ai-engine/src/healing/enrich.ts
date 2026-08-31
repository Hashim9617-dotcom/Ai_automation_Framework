import { createHash } from 'node:crypto';
import {
  positiveIntFromEnv,
  rootLogger,
  type AccessibilityTreeSnapshot,
  type HealingGateVerdict,
  type HealingProposal,
  type LocatorSpec,
  type Run,
  type SelfHealingEngine,
} from '@aitp/shared';

const log = rootLogger.child('heal-enrich');

export interface HealingEnrichOptions {
  /** Hard cap on distinct proposals generated per run — cost control, mirrors RCA_MAX_FAILURES. */
  maxProposals?: number;
  /** How many `propose()` calls run at once. Keep low; providers rate-limit. */
  concurrency?: number;
}

export interface HealingEnrichResult {
  run: Run;
  proposed: number;
  reused: number;
  skipped: number;
  /** Eligible-but-declined (propose() returned null) — not an error, a real outcome. */
  declined: number;
  ineligible: number;
}

interface EligibleGroup {
  spec: LocatorSpec;
  axSnapshot: AccessibilityTreeSnapshot;
  testId: string;
  duplicates: number;
}

/** Same (key, description) pair collapses to one job — one heal per distinct failure per run. */
function fingerprint(verdict: HealingGateVerdict): string {
  return createHash('sha256')
    .update(`${verdict.key}::${verdict.spec?.description ?? ''}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * Adds self-healing proposals to a completed Run — the out-of-band pass
 * `pnpm heal` runs, mirroring `enrichRunWithRca` exactly on purpose (same
 * dedup-by-fingerprint, same concurrency-batched loop, same cap pattern).
 * Deliberately a separate pass, never something that happens during
 * execution — docs/phase-2-healing.md's core decision: this never resolves
 * a locator live, and calling an LLM from inside a running test is exactly
 * the thing RCA already avoids for the same reason (never slow a run down).
 */
export async function enrichRunWithHealing(
  run: Run,
  engine: SelfHealingEngine,
  options: HealingEnrichOptions = {},
): Promise<HealingEnrichResult> {
  const maxProposals = options.maxProposals ?? positiveIntFromEnv(process.env.HEAL_MAX_PROPOSALS, 20);
  const concurrency = Math.max(1, options.concurrency ?? 3);

  const existingKeys = new Set(
    (run.healingProposals ?? []).map((p) => `${p.key}::${p.description}`),
  );

  const groups = new Map<string, EligibleGroup>();
  let ineligible = 0;

  for (const result of run.results) {
    const verdicts = result.context?.healingGate;
    const axSnapshot = result.context?.healingContext;
    if (!verdicts) continue;

    for (const verdict of verdicts) {
      if (!verdict.eligible) {
        ineligible += 1;
        continue;
      }
      if (!verdict.spec || !axSnapshot) continue; // eligible but the rich capture didn't survive — nothing to propose from

      const already = existingKeys.has(`${verdict.key}::${verdict.spec.description}`);
      if (already) continue; // idempotent: re-running `pnpm heal` on the same run.json doesn't duplicate proposals

      const fp = fingerprint(verdict);
      const existingGroup = groups.get(fp);
      if (existingGroup) {
        existingGroup.duplicates += 1;
        continue;
      }
      groups.set(fp, { spec: verdict.spec, axSnapshot, testId: result.id, duplicates: 0 });
    }
  }

  const jobs = [...groups.values()];
  const skipped = Math.max(0, jobs.length - maxProposals);
  const selected = jobs.slice(0, maxProposals);

  if (skipped > 0) {
    log.warn('Proposing for only the first eligible failures in this run', {
      proposing: selected.length,
      skipped,
      maxProposals,
    });
  }

  let proposed = 0;
  let declined = 0;
  let reused = 0;
  const newProposals: HealingProposal[] = [];

  for (let index = 0; index < selected.length; index += concurrency) {
    const batch = selected.slice(index, index + concurrency);

    await Promise.all(
      batch.map(async (group) => {
        const proposal = await engine.propose({
          spec: group.spec,
          axSnapshot: group.axSnapshot,
          runId: run.id,
          testId: group.testId,
        });
        if (proposal) {
          newProposals.push(proposal);
          proposed += 1;
          reused += group.duplicates;
        } else {
          declined += 1;
          reused += group.duplicates;
        }
      }),
    );
  }

  run.healingProposals = [...(run.healingProposals ?? []), ...newProposals];

  log.info('Self-healing proposal pass complete', {
    runId: run.id,
    eligibleFailures: jobs.length,
    proposed,
    declined,
    reused,
    skipped,
    ineligible,
  });

  return { run, proposed, reused, skipped, declined, ineligible };
}

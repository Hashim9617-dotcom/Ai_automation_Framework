import { BudgetExceededError, positiveIntFromEnv, rootLogger, type LlmUsage } from '@aitp/shared';

/**
 * Per-run cost cap. The architecture doc calls for "aggressive caching + a per-run
 * LLM budget cap" — this is the enforcement point. Every gateway call goes through it,
 * so a runaway self-healing loop can never quietly burn the month's budget.
 */
export class BudgetGuard {
  private readonly log = rootLogger.child('budget');
  private spentUsd = 0;
  private calls = 0;

  constructor(
    private readonly capUsd = positiveIntFromEnv(process.env.LLM_BUDGET_USD, 2),
    private readonly maxCalls = positiveIntFromEnv(process.env.LLM_MAX_CALLS, 200),
  ) {}

  assertAllowed(): void {
    if (this.spentUsd >= this.capUsd) throw new BudgetExceededError(this.spentUsd, this.capUsd);
    if (this.calls >= this.maxCalls) {
      throw new BudgetExceededError(this.spentUsd, this.capUsd);
    }
  }

  record(usage: LlmUsage): void {
    // Cache hits cost nothing and must not consume the call quota, or a
    // well-cached run could fail with BudgetExceededError at $0 spent.
    if (usage.cached) return;
    this.calls += 1;
    this.spentUsd += usage.costUsd;
    if (this.spentUsd > this.capUsd * 0.8) {
      this.log.warn('LLM budget above 80% for this run', {
        spentUsd: Number(this.spentUsd.toFixed(4)),
        capUsd: this.capUsd,
      });
    }
  }

  snapshot(): { spentUsd: number; calls: number; capUsd: number } {
    return { spentUsd: Number(this.spentUsd.toFixed(4)), calls: this.calls, capUsd: this.capUsd };
  }
}

import type { LocatorResolutionError } from '../errors';
import type { DomSnapshot, HealingEligibility } from '../types/ai';
import type { LocatorResolution, LocatorSpec } from '../types/locator';

/**
 * Deliberately generous — this is slack over the chain's OWN declared
 * budget, not a substitute for one. `waitFor({ state: 'attached' })` polls
 * until its deadline rather than detecting "this will never happen" early,
 * so a candidate that never attaches normally costs close to its full
 * timeout on its own — landing at or near `expectedBudgetMs` is the
 * ordinary case, not a red flag. What this margin catches is `durationMs`
 * *exceeding* what the chain's own timeouts predict: latency the
 * candidates themselves don't explain (a page still settling, a stacked
 * earlier resolution against the same key) — the specific pattern that
 * made Finding 5 look like session instability before the per-candidate
 * timeout split existed (docs/dms-findings.md).
 */
const LATENCY_SLACK = 1.25;

export interface HealingGateInput {
  spec: LocatorSpec;
  error: LocatorResolutionError;
  /** This test's resolution history so far — from the `locatorTelemetry` fixture. */
  telemetry: LocatorResolution[];
  snapshot: DomSnapshot;
  /** Carried for logging/attachment context — no rule below matches on it. See rule 2's comment for why. */
  pageUrl: string;
}

/**
 * Pure, synchronous, zero I/O — every rule here is documented in
 * docs/phase-2-healing.md ("The gate"). Safe to call from live test
 * teardown: it never touches the network and never blocks the run.
 *
 * Every rule contributes a reason string whether it passes or fails — the
 * full list is the useful output, not just the final boolean.
 */
export function checkHealingEligibility(input: HealingGateInput): HealingEligibility {
  const reasons: string[] = [];
  let eligible = true;

  // Rule 1 — every candidate exhausted. Not a runtime check: checkEligibility
  // is only ever called with a LocatorResolutionError, which SmartLocator only
  // throws after every candidate in the chain has already failed. Recorded
  // here so the reason list is a complete audit trail, not just the failures.
  reasons.push(
    `chain exhausted: all ${input.spec.candidates.length} candidate(s) failed to attach`,
  );

  // Rule 2 — page confirmed authenticated. NOT implemented as a URL check
  // here — a self-healing eval run against the bundled demo app caught
  // exactly why: a locator failing on a login page's OWN elements (its own
  // username/submit fields — every login-flow test does this) would
  // otherwise be refused for looking like a session-expiry redirect, which
  // it structurally cannot be. The real guarantee is upstream and
  // architectural, not a pattern match here: `AppPage.find()`
  // (packages/execution-engine, used by every DmsSynergy page except
  // `LoginPage` itself) throws the distinct `SessionExpiredError` the
  // instant it sees `/login` — *before* `SmartLocator.resolve()` is ever
  // entered. `checkEligibility` is only ever invoked via `onResolutionFailed`,
  // which only fires from inside `resolve()`'s own throw path — so a
  // session-expiry failure never reaches this function at all on an
  // AppPage-based page. Preserving that guarantee is the app's
  // responsibility (classify session death before calling into
  // SmartLocator), not something a generic, app-agnostic gate can safely
  // infer from a URL substring.
  reasons.push(
    `page: ${input.pageUrl} (session-expiry is filtered upstream by error class, not checked here — see comment)`,
  );

  // Rule 3 — key never resolved successfully earlier in this test.
  const resolvedEarlier = input.telemetry.some((entry) => entry.key === input.spec.key);
  if (resolvedEarlier) {
    eligible = false;
    reasons.push(
      `not eligible: "${input.spec.key}" resolved successfully earlier in this test — a state or timing problem, not a naming one`,
    );
  } else {
    reasons.push(`"${input.spec.key}" never resolved successfully in this test`);
  }

  // Rule 4 — DOM snapshot captured and not truncated.
  if (input.snapshot.truncated) {
    eligible = false;
    reasons.push(
      `not eligible: DOM snapshot was truncated (hit its element cap) — absence proves nothing in a truncated view`,
    );
  } else {
    reasons.push('DOM snapshot captured and not truncated');
  }

  // Rule 5 — not explained by latency.
  const { durationMs, expectedBudgetMs } = input.error.details ?? {};
  if (typeof durationMs !== 'number' || typeof expectedBudgetMs !== 'number') {
    eligible = false;
    reasons.push(
      'not eligible: resolution timing unavailable on the error (durationMs/expectedBudgetMs missing) — cannot rule out a latency confound',
    );
  } else {
    const budgetWithSlack = expectedBudgetMs * LATENCY_SLACK;
    if (durationMs > budgetWithSlack) {
      eligible = false;
      reasons.push(
        `not eligible: resolution took ${durationMs}ms against an expected chain budget of ${expectedBudgetMs}ms (${LATENCY_SLACK}x slack = ${Math.round(budgetWithSlack)}ms) — latency the chain's own timeouts don't explain`,
      );
    } else {
      reasons.push(
        `resolution took ${durationMs}ms against an expected chain budget of ${expectedBudgetMs}ms — within the ordinary exhaustion window, not a latency confound`,
      );
    }
  }

  return { eligible, reasons };
}

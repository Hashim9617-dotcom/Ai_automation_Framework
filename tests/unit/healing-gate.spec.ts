import { test, expect } from '@playwright/test';
import {
  checkHealingEligibility,
  LocatorResolutionError,
  type DomSnapshot,
  type LocatorResolution,
  type LocatorSpec,
} from '@aitp/shared';

/**
 * Coverage for the self-healing gate (docs/phase-2-healing.md, "The gate") —
 * the most safety-critical file in this feature, since a wrong "eligible"
 * verdict is what could eventually let a bad candidate reach a human
 * reviewer. Table-driven: every rule gets a case that passes and, where the
 * rule can actually refuse anything, a case refused BY THAT RULE specifically
 * (asserted via the reason text, not just the boolean), so a rule that starts
 * matching on the wrong condition fails here even if the final `eligible`
 * boolean would have looked the same by coincidence.
 *
 * Rules 1 and 2 cannot produce a "refused" case in the current implementation
 * — see their sections below for why. Documenting that structurally (a test
 * that asserts they never disqualify anything) is the honest equivalent of a
 * pass/refuse pair for a rule that only ever passes.
 */

function makeSpec(candidateCount = 1): LocatorSpec {
  return {
    key: 'test.target',
    description: 'Test target element',
    candidates: Array.from({ length: candidateCount }, (_, i) => ({
      strategy: 'role' as const,
      value: 'button',
      options: { name: `Candidate ${i}` },
      confidence: 1,
    })),
  };
}

function makeError(details?: { durationMs?: number; expectedBudgetMs?: number }): LocatorResolutionError {
  return new LocatorResolutionError('test.target', 1, {
    description: 'Test target element',
    url: 'https://app.example.com/dashboard',
    ...details,
  });
}

function makeSnapshot(truncated = false): DomSnapshot {
  return {
    url: 'https://app.example.com/dashboard',
    title: 'Dashboard',
    capturedAt: new Date().toISOString(),
    truncated,
    elements: [],
  };
}

function makeTelemetry(keys: string[] = []): LocatorResolution[] {
  return keys.map((key) => ({
    key,
    usedCandidateIndex: 0,
    candidate: { strategy: 'role', value: 'button', options: { name: 'X' } },
    healed: false,
    attempts: 1,
    durationMs: 50,
  }));
}

test.describe('checkHealingEligibility — rule 1: chain exhausted', () => {
  // Not a runtime check — checkHealingEligibility is only ever called with a
  // LocatorResolutionError, which SmartLocator only throws after every
  // candidate has already failed to attach. There is no code path that
  // reaches this function with an unexhausted chain, so there is no
  // "refused by rule 1" case to write — asserting one would test a
  // scenario the type system and call graph both already rule out.
  test('always contributes a passing reason, reflecting the real candidate count', () => {
    const result = checkHealingEligibility({
      spec: makeSpec(3),
      error: makeError({ durationMs: 100, expectedBudgetMs: 6000 }),
      telemetry: [],
      snapshot: makeSnapshot(),
      pageUrl: 'https://app.example.com/dashboard',
    });
    expect(result.eligible).toBe(true);
    expect(result.reasons.some((r) => r.includes('chain exhausted: all 3 candidate(s)'))).toBe(true);
  });
});

test.describe('checkHealingEligibility — rule 2: session-expiry filtering', () => {
  // Deliberately NOT a URL pattern match — see the long comment on rule 2 in
  // gate.ts for the full history (a self-healing eval run against the demo
  // app caught this rule wrongly disqualifying every locator failure on a
  // login page's own elements). The actual guarantee is architectural:
  // AppPage.find() throws the distinct SessionExpiredError before
  // SmartLocator.resolve() is ever entered, so a real session-expiry
  // failure never reaches this function's `error` parameter as a
  // LocatorResolutionError in the first place. There is therefore no
  // "refused by rule 2" case in this implementation — this test locks in
  // the regression fix: a /login pageUrl must NOT disqualify on its own.
  test('a pageUrl on /login does not disqualify — regression test for the fixed bug', () => {
    const result = checkHealingEligibility({
      spec: makeSpec(),
      error: makeError({ durationMs: 100, expectedBudgetMs: 2000 }),
      telemetry: [],
      snapshot: makeSnapshot(),
      pageUrl: 'https://app.example.com/login',
    });
    expect(result.eligible).toBe(true);
    expect(result.reasons.some((r) => r.includes('page: https://app.example.com/login'))).toBe(true);
  });
});

test.describe('checkHealingEligibility — rule 3: key not resolved earlier in this test', () => {
  test('PASS: the key never resolved successfully in this test', () => {
    const result = checkHealingEligibility({
      spec: makeSpec(),
      error: makeError({ durationMs: 100, expectedBudgetMs: 2000 }),
      telemetry: makeTelemetry(['some.other.key']),
      snapshot: makeSnapshot(),
      pageUrl: 'https://app.example.com/dashboard',
    });
    expect(result.eligible).toBe(true);
    expect(result.reasons.some((r) => r === '"test.target" never resolved successfully in this test')).toBe(
      true,
    );
  });

  test('REFUSED by rule 3: the same key already resolved earlier in this test', () => {
    const result = checkHealingEligibility({
      spec: makeSpec(),
      error: makeError({ durationMs: 100, expectedBudgetMs: 2000 }),
      telemetry: makeTelemetry(['test.target']),
      snapshot: makeSnapshot(),
      pageUrl: 'https://app.example.com/dashboard',
    });
    expect(result.eligible).toBe(false);
    expect(
      result.reasons.some((r) => r.includes('resolved successfully earlier in this test') && r.includes('not eligible')),
    ).toBe(true);
  });
});

test.describe('checkHealingEligibility — rule 4: DOM snapshot not truncated', () => {
  test('PASS: snapshot did not hit its element cap', () => {
    const result = checkHealingEligibility({
      spec: makeSpec(),
      error: makeError({ durationMs: 100, expectedBudgetMs: 2000 }),
      telemetry: [],
      snapshot: makeSnapshot(false),
      pageUrl: 'https://app.example.com/dashboard',
    });
    expect(result.eligible).toBe(true);
    expect(result.reasons.some((r) => r === 'DOM snapshot captured and not truncated')).toBe(true);
  });

  test('REFUSED by rule 4: snapshot was truncated', () => {
    const result = checkHealingEligibility({
      spec: makeSpec(),
      error: makeError({ durationMs: 100, expectedBudgetMs: 2000 }),
      telemetry: [],
      snapshot: makeSnapshot(true),
      pageUrl: 'https://app.example.com/dashboard',
    });
    expect(result.eligible).toBe(false);
    expect(result.reasons.some((r) => r.includes('not eligible') && r.includes('truncated'))).toBe(true);
  });
});

test.describe('checkHealingEligibility — rule 5: not explained by latency', () => {
  test('PASS: duration lands within the chain\'s own predicted budget', () => {
    const result = checkHealingEligibility({
      spec: makeSpec(),
      error: makeError({ durationMs: 2000, expectedBudgetMs: 2000 }),
      telemetry: [],
      snapshot: makeSnapshot(),
      pageUrl: 'https://app.example.com/dashboard',
    });
    expect(result.eligible).toBe(true);
    expect(result.reasons.some((r) => r.includes('within the ordinary exhaustion window'))).toBe(true);
  });

  test('PASS: duration within the 1.25x slack margin over budget', () => {
    // 2000 * 1.25 = 2500 — right at the edge, still not exceeding it.
    const result = checkHealingEligibility({
      spec: makeSpec(),
      error: makeError({ durationMs: 2500, expectedBudgetMs: 2000 }),
      telemetry: [],
      snapshot: makeSnapshot(),
      pageUrl: 'https://app.example.com/dashboard',
    });
    expect(result.eligible).toBe(true);
  });

  test('REFUSED by rule 5: duration exceeds the chain budget plus slack', () => {
    // 2000 * 1.25 = 2500 — 2501 is just over it.
    const result = checkHealingEligibility({
      spec: makeSpec(),
      error: makeError({ durationMs: 2501, expectedBudgetMs: 2000 }),
      telemetry: [],
      snapshot: makeSnapshot(),
      pageUrl: 'https://app.example.com/dashboard',
    });
    expect(result.eligible).toBe(false);
    expect(
      result.reasons.some((r) => r.includes('not eligible') && r.includes("latency the chain's own timeouts don't explain")),
    ).toBe(true);
  });

  test('REFUSED by rule 5: a genuinely slow, multi-candidate chain still exceeds its own (larger) budget', () => {
    // Realistic multi-candidate case: primary + fallback + last, e.g.
    // 2000 + 750 + 2000 = 4750ms budget. Something adding real extra
    // latency on top of that — not just "the chain is long" — is what
    // this rule exists to catch.
    const result = checkHealingEligibility({
      spec: makeSpec(3),
      error: makeError({ durationMs: 7000, expectedBudgetMs: 4750 }),
      telemetry: [],
      snapshot: makeSnapshot(),
      pageUrl: 'https://app.example.com/dashboard',
    });
    expect(result.eligible).toBe(false);
  });

  test('REFUSED by rule 5: timing data missing from the error entirely', () => {
    const result = checkHealingEligibility({
      spec: makeSpec(),
      error: makeError(), // no durationMs/expectedBudgetMs at all
      telemetry: [],
      snapshot: makeSnapshot(),
      pageUrl: 'https://app.example.com/dashboard',
    });
    expect(result.eligible).toBe(false);
    expect(result.reasons.some((r) => r.includes('timing unavailable'))).toBe(true);
  });
});

test.describe('checkHealingEligibility — combined', () => {
  test('a failure that clears every rule is eligible, with every reason recorded', () => {
    const result = checkHealingEligibility({
      spec: makeSpec(2),
      error: makeError({ durationMs: 900, expectedBudgetMs: 2750 }),
      telemetry: makeTelemetry(['unrelated.key']),
      snapshot: makeSnapshot(false),
      pageUrl: 'https://app.example.com/admin/users',
    });
    expect(result.eligible).toBe(true);
    expect(result.reasons).toHaveLength(5);
  });

  test('failing multiple rules at once still reports every failing reason, not just the first', () => {
    const result = checkHealingEligibility({
      spec: makeSpec(),
      error: makeError({ durationMs: 9000, expectedBudgetMs: 2000 }), // rule 5
      telemetry: makeTelemetry(['test.target']), // rule 3
      snapshot: makeSnapshot(true), // rule 4
      pageUrl: 'https://app.example.com/dashboard',
    });
    expect(result.eligible).toBe(false);
    const failing = result.reasons.filter((r) => r.includes('not eligible'));
    expect(failing).toHaveLength(3);
  });
});

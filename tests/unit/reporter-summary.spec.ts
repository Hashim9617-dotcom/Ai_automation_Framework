import { test, expect } from '@playwright/test';
import { TestOutcome, summarize, type TestResult } from '@aitp/shared';
import { finalAttemptPerTest } from '@aitp/reporting-engine';

/**
 * Regression coverage for a run.json that reported total 63 / failed 36 for a
 * 45-test suite with 18 distinct failures (each retried once: 18 × 2 = 36).
 * Playwright's reporter API calls onTestEnd once per ATTEMPT, so the raw
 * results list has one row per attempt, not per test — summing it directly
 * counts every retried failure twice.
 */
function attempt(overrides: Partial<TestResult> = {}): TestResult {
  return {
    id: 'test-1',
    title: 'Admin create forms › the create-user form will not submit while empty',
    file: 'tests/app/admin.spec.ts',
    project: 'chromium',
    tags: [],
    outcome: TestOutcome.Failed,
    durationMs: 500,
    retry: 0,
    steps: [],
    attachments: [],
    ...overrides,
  };
}

test.describe('finalAttemptPerTest', () => {
  test('a retried failure counts once, not once per attempt', () => {
    const results: TestResult[] = [
      attempt({ id: 'a', retry: 0, outcome: TestOutcome.Passed }),
      attempt({ id: 'b', retry: 0, outcome: TestOutcome.Failed }),
      attempt({ id: 'b', retry: 1, outcome: TestOutcome.Failed }), // retry of b, still failing
      attempt({ id: 'c', retry: 0, outcome: TestOutcome.Skipped }),
    ];

    const deduped = finalAttemptPerTest(results);
    expect(deduped).toHaveLength(3); // one row per distinct test id, not 4

    const summary = summarize(deduped);
    expect(summary.total).toBe(3);
    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.skipped).toBe(1);
  });

  test('a test that fails then passes on retry counts as one flaky pass', () => {
    const results: TestResult[] = [
      attempt({ id: 'a', retry: 0, outcome: TestOutcome.Failed }),
      attempt({ id: 'a', retry: 1, outcome: TestOutcome.Flaky }),
    ];

    const summary = summarize(finalAttemptPerTest(results));
    expect(summary.total).toBe(1);
    expect(summary.passed).toBe(1);
    expect(summary.flaky).toBe(1);
    expect(summary.failed).toBe(0);
  });

  test('matches the exact regression: 45 tests, 18 failures each retried once', () => {
    const results: TestResult[] = [];
    for (let i = 0; i < 27; i += 1) {
      results.push(attempt({ id: `pass-${i}`, retry: 0, outcome: TestOutcome.Passed }));
    }
    for (let i = 0; i < 18; i += 1) {
      results.push(attempt({ id: `fail-${i}`, retry: 0, outcome: TestOutcome.Failed }));
      results.push(attempt({ id: `fail-${i}`, retry: 1, outcome: TestOutcome.Failed }));
    }

    expect(results).toHaveLength(63); // the raw, attempt-counted total we actually saw

    const summary = summarize(finalAttemptPerTest(results));
    expect(summary.total).toBe(45);
    expect(summary.passed).toBe(27);
    expect(summary.failed).toBe(18);
    expect(summary.passRate).toBe(60);
  });
});

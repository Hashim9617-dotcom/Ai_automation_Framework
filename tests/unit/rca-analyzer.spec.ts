import { test, expect } from '@playwright/test';
import { LlmRootCauseAnalyzer, MockLlmGateway, enrichRunWithRca, fingerprint } from '@aitp/ai-engine';
import { RunStatus, TestOutcome, type Run, type TestResult } from '@aitp/shared';

const GOOD_RESPONSE = JSON.stringify({
  rootCause: 'The Save button stayed disabled because GET /departments returned 500.',
  category: 'application-bug',
  confidence: 0.86,
  suggestedFix: 'Fix the departments endpoint, then re-run.',
  evidence: ['500 http://app/api/departments'],
});

function failure(overrides: Partial<TestResult> = {}): TestResult {
  return {
    id: 'test-1',
    title: 'Employee registration › registers a new employee',
    file: 'tests/e2e/employee-registration.spec.ts',
    project: 'chromium',
    tags: ['@regression'],
    outcome: TestOutcome.Failed,
    durationMs: 1200,
    retry: 0,
    steps: [{ title: 'click Save employee', durationMs: 300 }],
    attachments: [],
    error: { message: 'expect(locator).toBeEnabled() failed', stack: 'at foo.ts:1' },
    ...overrides,
  };
}

function runWith(results: TestResult[]): Run {
  return {
    id: 'run_test',
    status: RunStatus.Failed,
    request: { environment: 'local', browsers: ['chromium'], headed: false, metadata: {} },
    createdAt: new Date().toISOString(),
    results,
    artifacts: {},
  };
}

test.describe('Root cause analyzer', { tag: '@unit' }, () => {
  test('turns a model verdict into a structured analysis', async () => {
    const gateway = new MockLlmGateway().when('registers a new employee', GOOD_RESPONSE);
    const analysis = await new LlmRootCauseAnalyzer(gateway).analyze({
      testTitle: 'Employee registration › registers a new employee',
      testFile: 'tests/e2e/employee-registration.spec.ts',
      error: 'expect(locator).toBeEnabled() failed',
      context: { failedRequests: ['500 http://app/api/departments'] },
    });

    expect(analysis.category).toBe('application-bug');
    expect(analysis.confidence).toBe(0.86);
    expect(analysis.rootCause).toContain('/departments');
    expect(analysis.evidence).toHaveLength(1);
    expect(analysis.analyzedBy).toContain('mock');
  });

  test('sends the collected evidence to the model', async () => {
    const gateway = new MockLlmGateway().when('registers a new employee', GOOD_RESPONSE);
    await new LlmRootCauseAnalyzer(gateway).analyze({
      testTitle: 'Employee registration › registers a new employee',
      testFile: 'tests/e2e/employee-registration.spec.ts',
      error: 'boom',
      steps: ['click Save employee'],
      context: {
        consoleErrors: ['TypeError: cannot read x'],
        failedRequests: ['500 http://app/api/departments'],
      },
    });

    const prompt = gateway.calls[0]!.messages.map((message) => message.content).join('\n');
    expect(prompt).toContain('TypeError: cannot read x');
    expect(prompt).toContain('500 http://app/api/departments');
    expect(prompt).toContain('click Save employee');
  });

  test('falls back to unknown instead of throwing when the model misbehaves', async () => {
    const gateway = new MockLlmGateway().when('registers a new employee', 'not json at all');
    const analysis = await new LlmRootCauseAnalyzer(gateway).analyze({
      testTitle: 'Employee registration › registers a new employee',
      testFile: 'f.spec.ts',
      error: 'boom',
    });

    expect(analysis.category).toBe('unknown');
    expect(analysis.confidence).toBe(0);
  });

  test('rejects a category outside the allowed set', async () => {
    const gateway = new MockLlmGateway().when(
      'registers a new employee',
      JSON.stringify({ rootCause: 'x', category: 'cosmic-rays', confidence: 0.9, evidence: [] }),
    );
    const analysis = await new LlmRootCauseAnalyzer(gateway).analyze({
      testTitle: 'Employee registration › registers a new employee',
      testFile: 'f.spec.ts',
      error: 'boom',
    });

    expect(analysis.category).toBe('unknown');
    expect(analysis.confidence).toBe(0.9);
  });

  test('clamps a confidence the model exaggerated', async () => {
    const gateway = new MockLlmGateway().when(
      'registers a new employee',
      JSON.stringify({ rootCause: 'x', category: 'flaky', confidence: 4.2, evidence: [] }),
    );
    const analysis = await new LlmRootCauseAnalyzer(gateway).analyze({
      testTitle: 'Employee registration › registers a new employee',
      testFile: 'f.spec.ts',
      error: 'boom',
    });

    expect(analysis.confidence).toBe(1);
  });
});

test.describe('Failure fingerprinting', { tag: '@unit' }, () => {
  test('ignores generated ids so the same bug caches across runs', () => {
    const a = fingerprint({
      testTitle: 't',
      testFile: 'f.spec.ts',
      error: 'Employee ID EMP48213 already exists',
    });
    const b = fingerprint({
      testTitle: 't',
      testFile: 'f.spec.ts',
      error: 'Employee ID EMP99001 already exists',
    });
    expect(a).toBe(b);
  });

  test('separates genuinely different failures', () => {
    const a = fingerprint({ testTitle: 't', testFile: 'f.spec.ts', error: 'timeout waiting' });
    const b = fingerprint({ testTitle: 't', testFile: 'f.spec.ts', error: 'element not found' });
    expect(a).not.toBe(b);
  });
});

test.describe('Run enrichment', { tag: '@unit' }, () => {
  test('analyzes one bug once and applies it to every browser', async () => {
    const gateway = new MockLlmGateway().when('registers a new employee', GOOD_RESPONSE);
    const analyzer = new LlmRootCauseAnalyzer(gateway);

    const run = runWith([
      failure({ id: '1', project: 'chromium' }),
      failure({ id: '2', project: 'firefox' }),
      failure({ id: '3', project: 'webkit' }),
      failure({ id: '4', project: 'mobile-chrome' }),
    ]);

    const result = await enrichRunWithRca(run, analyzer);

    expect(result.analyzed).toBe(1);
    expect(result.reused).toBe(3);
    expect(gateway.calls).toHaveLength(1);
    for (const entry of run.results) {
      expect(entry.error?.rca?.category).toBe('application-bug');
    }
  });

  test('leaves a green run untouched', async () => {
    const gateway = new MockLlmGateway();
    const run = runWith([failure({ outcome: TestOutcome.Passed, error: undefined })]);

    const result = await enrichRunWithRca(run, new LlmRootCauseAnalyzer(gateway));

    expect(result.analyzed).toBe(0);
    expect(gateway.calls).toHaveLength(0);
  });

  test('honours the per-run failure cap', async () => {
    const gateway = new MockLlmGateway().when('', GOOD_RESPONSE);
    const run = runWith([
      failure({ id: '1', error: { message: 'error one' } }),
      failure({ id: '2', error: { message: 'error two' } }),
      failure({ id: '3', error: { message: 'error three' } }),
    ]);

    const result = await enrichRunWithRca(run, new LlmRootCauseAnalyzer(gateway), {
      maxFailures: 2,
    });

    expect(result.analyzed).toBe(2);
    expect(result.skipped).toBe(1);
  });
});

import { test, expect } from '@playwright/test';
import { LlmRootCauseAnalyzer, MockLlmGateway, buildRcaPrompt } from '@aitp/ai-engine';
import { positiveIntFromEnv, sanitizeUrl } from '@aitp/shared';

const VERDICT = JSON.stringify({
  rootCause: 'x',
  category: 'environment',
  confidence: 0.7,
  evidence: [],
});

test.describe('RCA prompt construction', { tag: '@unit' }, () => {
  test('stays bounded when the page floods the console', () => {
    const noisy = Array.from({ length: 5_000 }, (_, i) => `Error ${i}: request failed`);

    const prompt = buildRcaPrompt({
      testTitle: 't',
      testFile: 'f.spec.ts',
      error: 'boom',
      context: { consoleErrors: noisy, failedRequests: noisy, pageErrors: noisy },
    });

    // Without bounding this is ~270k characters, which blows the context window
    // and makes analysis fail on exactly the runs that need it most.
    expect(prompt.length).toBeLessThan(12_000);
    expect(prompt).toContain('earlier entries omitted');
    // The entries nearest the failure are the ones kept.
    expect(prompt).toContain('Error 4999');
  });

  test('keeps the evidence that was actually collected', () => {
    const prompt = buildRcaPrompt({
      testTitle: 'Employee registration',
      testFile: 'tests/e2e/x.spec.ts',
      error: 'expect(locator).toBeVisible() failed',
      steps: ['click Save'],
      context: {
        consoleErrors: ['GET /api/departments 500'],
        locatorTelemetry: [
          {
            key: 'employee.save',
            usedCandidateIndex: 1,
            candidate: { strategy: 'label', value: 'Save employee' },
            healed: false,
            attempts: 2,
            durationMs: 30,
          },
        ],
      },
    });

    expect(prompt).toContain('GET /api/departments 500');
    expect(prompt).toContain('FELL BACK');
    expect(prompt).toContain('click Save');
  });
});

test.describe('RCA caching', { tag: '@unit' }, () => {
  test('a different cause under the same error text is not served from cache', async () => {
    const gateway = new MockLlmGateway().when('', VERDICT);
    const analyzer = new LlmRootCauseAnalyzer(gateway);
    const base = { testTitle: 't', testFile: 'f.spec.ts', error: 'element not visible' };

    await analyzer.analyze({ ...base, context: { failedRequests: ['500 /api/departments'] } });
    await analyzer.analyze({ ...base, context: { consoleErrors: ['TypeError: x is null'] } });

    expect(gateway.calls[0]!.cacheKey).not.toBe(gateway.calls[1]!.cacheKey);
  });

  test('the identical failure reuses one cache key', async () => {
    const gateway = new MockLlmGateway().when('', VERDICT);
    const analyzer = new LlmRootCauseAnalyzer(gateway);
    const input = {
      testTitle: 't',
      testFile: 'f.spec.ts',
      error: 'element not visible',
      context: { failedRequests: ['500 /api/departments'] },
    };

    await analyzer.analyze(input);
    await analyzer.analyze(input);

    expect(gateway.calls[0]!.cacheKey).toBe(gateway.calls[1]!.cacheKey);
  });
});

test.describe('Secret handling', { tag: '@unit' }, () => {
  test('strips credentials and token query params from a URL', () => {
    expect(sanitizeUrl('https://user:hunter2@app.test/employees')).toBe(
      'https://app.test/employees',
    );
    expect(sanitizeUrl('https://app.test/x?access_token=abc123&page=2')).toContain('page=2');
    expect(sanitizeUrl('https://app.test/x?access_token=abc123&page=2')).not.toContain('abc123');
    // Not a URL at all — returned untouched rather than throwing.
    expect(sanitizeUrl('not a url')).toBe('not a url');
  });

  test('a broken cap value falls back instead of silently disabling the limit', () => {
    expect(positiveIntFromEnv('twenty', 20)).toBe(20);
    expect(positiveIntFromEnv('', 20)).toBe(20);
    expect(positiveIntFromEnv(undefined, 20)).toBe(20);
    expect(positiveIntFromEnv('0', 20)).toBe(20);
    expect(positiveIntFromEnv('-5', 20)).toBe(20);
    expect(positiveIntFromEnv('5', 20)).toBe(5);
  });
});

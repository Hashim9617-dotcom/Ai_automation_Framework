import { test, expect } from '@playwright/test';
import { estimateCostUsd, resolveModelRate } from '@aitp/ai-engine';

/**
 * Pricing was fixed at one blanket rate for every model until 2026-09-05, so a
 * Haiku call and a Sonnet call reported identical `costUsd` for identical
 * token counts. Cosmetic while a human just read the number; not cosmetic once
 * a projected ~$1.30 run had to fit inside `LLM_BUDGET_USD=2`, where an
 * over-estimate can trip the guard mid-run and present as an eval failure.
 */
test.describe('LLM pricing is model-aware @unit', () => {
  const PROMPT = 1_000_000;
  const COMPLETION = 100_000;

  test('Haiku and Sonnet cost differently for identical token counts', () => {
    const haiku = estimateCostUsd('claude-haiku-4-5', PROMPT, COMPLETION);
    const sonnet = estimateCostUsd('claude-sonnet-4-5', PROMPT, COMPLETION);

    expect(haiku).toBeGreaterThan(0);
    expect(sonnet).toBeGreaterThan(0);
    // The regression this file exists for: these were once equal.
    expect(haiku).not.toBe(sonnet);
    expect(haiku).toBeLessThan(sonnet);
  });

  test('the three families are ordered haiku < sonnet < opus', () => {
    const haiku = estimateCostUsd('claude-haiku-4-5', PROMPT, COMPLETION);
    const sonnet = estimateCostUsd('claude-sonnet-4-5', PROMPT, COMPLETION);
    const opus = estimateCostUsd('claude-opus-5', PROMPT, COMPLETION);

    expect(haiku).toBeLessThan(sonnet);
    expect(sonnet).toBeLessThan(opus);
  });

  test('the arithmetic is per-million-token, not per-token', () => {
    // Sonnet: $3 per Mtok in, $15 per Mtok out.
    expect(estimateCostUsd('claude-sonnet-4-5', 1_000_000, 0)).toBeCloseTo(3, 6);
    expect(estimateCostUsd('claude-sonnet-4-5', 0, 1_000_000)).toBeCloseTo(15, 6);
    expect(estimateCostUsd('claude-sonnet-4-5', 500_000, 200_000)).toBeCloseTo(1.5 + 3, 6);
  });

  test('a model id variant still resolves to its family', () => {
    for (const id of ['claude-sonnet-4-5', 'claude-sonnet-5', 'claude-sonnet-4-5-20260101']) {
      expect(resolveModelRate(id).family, id).toBe('sonnet');
    }
    expect(resolveModelRate('claude-haiku-4-5-20251001').family).toBe('haiku');
  });

  test('an unknown model falls back to the MOST expensive rate, not the cheapest', () => {
    const unknown = resolveModelRate('some-model-we-have-never-seen');
    expect(unknown.known).toBe(false);

    const opus = resolveModelRate('claude-opus-5');
    // Over-estimating trips the budget guard early. Under-estimating lets a
    // run overspend silently, which is the failure that actually costs money.
    expect(unknown.inputPerMTok).toBe(opus.inputPerMTok);
    expect(unknown.outputPerMTok).toBe(opus.outputPerMTok);
  });

  test('an explicit override wins over the table', () => {
    const rate = { inputPerMTok: 2, outputPerMTok: 4 };
    expect(resolveModelRate('claude-haiku-4-5', rate).family).toBe('override');
    expect(estimateCostUsd('claude-haiku-4-5', 1_000_000, 1_000_000, rate)).toBeCloseTo(6, 6);
  });

  test('zero tokens cost nothing for every family', () => {
    for (const model of ['claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-opus-5', 'mystery']) {
      expect(estimateCostUsd(model, 0, 0), model).toBe(0);
    }
  });
});

import { test, expect } from '@playwright/test';
import { estimateCostUsd, modelKey, resolveModelRate } from '@aitp/ai-engine';

/**
 * Two bugs are pinned here, and the second one matters more.
 *
 * 1. Pricing was once a single blanket rate for every model, so Haiku and
 *    Sonnet reported identical `costUsd` for identical tokens.
 *
 * 2. The fix for (1) matched the family by SUBSTRING, so `claude-sonnet-4-5`
 *    ($3/$15) and `claude-sonnet-5` ($2/$10) resolved to the same rate and one
 *    of them was 50% wrong. The original test suite did not catch this — it
 *    asserted that both ids resolve to family `sonnet`, which *enshrined* the
 *    bug as intended behaviour. A test that pins the wrong answer is worse
 *    than no test, so that assertion is gone and its inverse is below.
 *
 * Rates verified against Anthropic's official pricing page, 2026-09-05.
 */
test.describe('LLM pricing is model-aware @unit', () => {
  const PROMPT = 1_000_000;
  const COMPLETION = 100_000;

  test('Haiku and Sonnet cost differently for identical token counts', () => {
    const haiku = estimateCostUsd('claude-haiku-4-5', PROMPT, COMPLETION);
    const sonnet = estimateCostUsd('claude-sonnet-4-5', PROMPT, COMPLETION);

    expect(haiku).toBeGreaterThan(0);
    expect(haiku).not.toBe(sonnet);
    expect(haiku).toBeLessThan(sonnet);
  });

  test('Sonnet 4.5 and Sonnet 5 cost differently — same family, different model', () => {
    const sonnet45 = estimateCostUsd('claude-sonnet-4-5', PROMPT, COMPLETION);
    const sonnet5 = estimateCostUsd('claude-sonnet-5', PROMPT, COMPLETION);

    // The regression: a substring match on "sonnet" made these equal.
    expect(sonnet45).not.toBe(sonnet5);
    expect(sonnet5).toBeLessThan(sonnet45); // $2/$10 against $3/$15
    expect(resolveModelRate('claude-sonnet-4-5').key).toBe('sonnet-4-5');
    expect(resolveModelRate('claude-sonnet-5').key).toBe('sonnet-5');
  });

  test('every known model has its own published rate', () => {
    const cases: Array<[string, number, number]> = [
      ['claude-sonnet-4-5', 3, 15],
      ['claude-sonnet-5', 2, 10],
      ['claude-haiku-4-5', 1, 5],
      ['claude-opus-5', 5, 25],
    ];
    for (const [model, input, output] of cases) {
      const rate = resolveModelRate(model);
      expect(rate.known, model).toBe(true);
      expect(rate.inputPerMTok, model).toBe(input);
      expect(rate.outputPerMTok, model).toBe(output);
    }
  });

  test('the arithmetic is per-million-token, not per-token', () => {
    expect(estimateCostUsd('claude-sonnet-4-5', 1_000_000, 0)).toBeCloseTo(3, 6);
    expect(estimateCostUsd('claude-sonnet-4-5', 0, 1_000_000)).toBeCloseTo(15, 6);
    expect(estimateCostUsd('claude-sonnet-4-5', 500_000, 200_000)).toBeCloseTo(1.5 + 3, 6);
    // The real measured healing eval, checked by hand.
    expect(estimateCostUsd('claude-sonnet-4-5', 4029, 533)).toBeCloseTo(0.0201, 4);
  });

  test('a dated variant resolves to its own version, not a neighbouring one', () => {
    expect(modelKey('claude-sonnet-4-5-20260101')).toBe('sonnet-4-5');
    expect(modelKey('claude-haiku-4-5-20251001')).toBe('haiku-4-5');
    expect(modelKey('claude-sonnet-5-20260101')).toBe('sonnet-5');

    // A date suffix must not change the price.
    expect(estimateCostUsd('claude-sonnet-4-5-20260101', PROMPT, COMPLETION)).toBe(
      estimateCostUsd('claude-sonnet-4-5', PROMPT, COMPLETION),
    );
  });

  test('an UNRECOGNISED VERSION does not inherit its family price', () => {
    // The heart of the fix: "it says sonnet, so charge Sonnet rates" is
    // exactly what mispriced Sonnet 5.
    const future = resolveModelRate('claude-sonnet-9');
    expect(future.known).toBe(false);
    expect(future.key).toBe('unknown');
    expect(future.inputPerMTok).not.toBe(resolveModelRate('claude-sonnet-4-5').inputPerMTok);
  });

  test('an unknown model falls back ABOVE every known rate, never below', () => {
    const unknown = resolveModelRate('some-model-we-have-never-seen');
    expect(unknown.known).toBe(false);

    for (const model of ['claude-sonnet-4-5', 'claude-sonnet-5', 'claude-haiku-4-5', 'claude-opus-5']) {
      // Over-estimating trips the budget guard early. Under-estimating lets a
      // run overspend silently, which is the failure that actually costs money.
      expect(unknown.inputPerMTok, model).toBeGreaterThan(resolveModelRate(model).inputPerMTok);
      expect(unknown.outputPerMTok, model).toBeGreaterThan(resolveModelRate(model).outputPerMTok);
    }
  });

  test('an explicit override wins over the table', () => {
    const rate = { inputPerMTok: 2, outputPerMTok: 4 };
    expect(resolveModelRate('claude-haiku-4-5', rate).key).toBe('override');
    expect(estimateCostUsd('claude-haiku-4-5', 1_000_000, 1_000_000, rate)).toBeCloseTo(6, 6);
  });

  test('zero tokens cost nothing for every family', () => {
    for (const model of ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-5', 'mystery']) {
      expect(estimateCostUsd(model, 0, 0), model).toBe(0);
    }
  });
});

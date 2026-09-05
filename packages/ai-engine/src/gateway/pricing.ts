/**
 * Model-aware token pricing.
 *
 * Until 2026-09-05 every completion was priced at one hardcoded rate ($3/$15
 * per million tokens) regardless of which model ran, so a Haiku call and a
 * Sonnet call reported identical `costUsd` for identical token counts. That
 * mattered once a projected ~$1.30 eval had to fit inside `LLM_BUDGET_USD`:
 * `BudgetGuard` throws mid-run, and a budget stop presents as an eval failure.
 *
 * The first fix matched the family by substring, which was wrong in a way the
 * first test suite actively enshrined: `claude-sonnet-4-5` and
 * `claude-sonnet-5` are DIFFERENT models at DIFFERENT prices ($3/$15 against
 * $2/$10), and a substring match on `sonnet` priced one of them 50% wrong.
 *
 * Hence the rule this module is built on:
 *
 *   **Rates are keyed by family AND version, and an unrecognised version
 *   never inherits a known version's price.**
 *
 * A new model is priced conservatively rather than optimistically, because
 * guessing "it's a Sonnet, so $3" for a model that costs something else is
 * exactly the failure this replaced.
 */
export interface TokenRate {
  /** US dollars per million input tokens. */
  inputPerMTok: number;
  /** US dollars per million output tokens. */
  outputPerMTok: number;
}

export interface ResolvedRate extends TokenRate {
  /** e.g. `sonnet-4-5`, or `unknown` when nothing matched. */
  key: string;
  /** False when the conservative fallback was used. */
  known: boolean;
}

/**
 * Published Anthropic list prices, US dollars per million tokens.
 *
 * HARDCODED AND THEREFORE PERISHABLE — nothing here reads live pricing, so
 * these WILL drift. Verified against Anthropic's official pricing page on
 * **2026-09-05**. Re-check when a figure matters; treat every `costUsd` in
 * this codebase as an estimate rather than an invoice.
 *
 * Keys are `<family>-<version>` exactly. Note that Sonnet 4.5 and Sonnet 5
 * are separate entries at separate prices — that is the whole point.
 */
const RATES: Record<string, TokenRate> = {
  'sonnet-4-5': { inputPerMTok: 3, outputPerMTok: 15 },
  'sonnet-5': { inputPerMTok: 2, outputPerMTok: 10 },
  'haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
  'opus-5': { inputPerMTok: 5, outputPerMTok: 25 },
};

/**
 * Used when the model is unrecognised — deliberately ABOVE every known rate,
 * and not a real price for anything.
 *
 * An unknown model then over-estimates, so `BudgetGuard` trips early rather
 * than late. A run that stops early is an annoyance; one that quietly
 * overspends is a bill. Being above the most expensive known model (rather
 * than equal to it) also means adding a cheaper model can never silently make
 * the fallback optimistic.
 */
const FALLBACK_RATE: TokenRate = { inputPerMTok: 15, outputPerMTok: 75 };

/**
 * `claude-sonnet-4-5-20260101` -> `sonnet-4-5`.
 *
 * The version is captured as one or two numeric segments, and an optional
 * 8-digit date suffix is discarded. The date group requires exactly 8 digits
 * so that the `-5` of `sonnet-4-5` can never be mistaken for one.
 */
// Version segments are capped at two digits so a greedy match cannot swallow
// the date suffix: without that cap, `claude-sonnet-5-20260101` parsed as
// version "5-20260101" rather than version "5" plus a date, and every dated
// model id fell through to the fallback rate. Caught by the dated-variant
// test, which is exactly what it is for.
const MODEL_ID = /^(?:claude-)?(opus|sonnet|haiku)-(\d{1,2}(?:-\d{1,2})?)(?:-\d{8})?$/;

export function modelKey(model: string): string | undefined {
  const match = MODEL_ID.exec(model.trim().toLowerCase());
  return match ? `${match[1]}-${match[2]}` : undefined;
}

export function resolveModelRate(model: string, override?: TokenRate): ResolvedRate {
  if (override) return { ...override, key: 'override', known: true };

  const key = modelKey(model);
  const rate = key === undefined ? undefined : RATES[key];
  // Deliberately no family-level fallback: an unrecognised VERSION must not
  // inherit a recognised version's price, or this is the substring bug again
  // wearing a parser.
  if (rate === undefined || key === undefined) {
    return { ...FALLBACK_RATE, key: 'unknown', known: false };
  }
  return { ...rate, key, known: true };
}

/** Cost in US dollars for one completion, at that model's own rate. */
export function estimateCostUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
  override?: TokenRate,
): number {
  const rate = resolveModelRate(model, override);
  return (promptTokens / 1e6) * rate.inputPerMTok + (completionTokens / 1e6) * rate.outputPerMTok;
}

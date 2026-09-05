/**
 * Model-aware token pricing.
 *
 * Until 2026-09-05 every completion was priced at one hardcoded rate ($3/$15
 * per million tokens) regardless of which model ran, so a Haiku call and a
 * Sonnet call reported identical `costUsd` for identical token counts. That
 * was documented as a known cosmetic issue for as long as the only consumer
 * was a report a human read. It stopped being cosmetic the moment a run was
 * projected to cost ~$1.30 against `LLM_BUDGET_USD=2`: an over-estimate that
 * large can trip the budget guard mid-run, and a budget stop presents as an
 * eval failure, which is time lost chasing the wrong thing.
 */
export interface TokenRate {
  /** US dollars per million input tokens. */
  inputPerMTok: number;
  /** US dollars per million output tokens. */
  outputPerMTok: number;
}

export interface ResolvedRate extends TokenRate {
  /** The family matched, or `unknown` when nothing did. */
  family: string;
  /** False when the fallback was used, so callers can flag an untrusted figure. */
  known: boolean;
}

/**
 * Published Anthropic list prices, US dollars per million tokens.
 *
 * HARDCODED AND THEREFORE PERISHABLE. Nothing here reads live pricing, so
 * these WILL drift as list prices change. Re-check against Anthropic's pricing
 * page when a figure matters, and treat every `costUsd` in this codebase as an
 * estimate rather than an invoice.
 *
 * Last checked: 2026-09-05.
 *
 * Matched by substring on the model id, so `claude-sonnet-4-5`,
 * `claude-sonnet-5` and a dated variant all resolve to the same family.
 */
const FAMILY_RATES: Array<{ family: string; match: string; rate: TokenRate }> = [
  { family: 'opus', match: 'opus', rate: { inputPerMTok: 15, outputPerMTok: 75 } },
  { family: 'sonnet', match: 'sonnet', rate: { inputPerMTok: 3, outputPerMTok: 15 } },
  { family: 'haiku', match: 'haiku', rate: { inputPerMTok: 1, outputPerMTok: 5 } },
];

/**
 * The rate used when no family matches — deliberately the most expensive one
 * known.
 *
 * An unknown model then OVER-estimates, so the budget guard trips early rather
 * than late. That is the same direction the guard already failed in when
 * pricing was fixed at Sonnet rates, and it is the right direction: a run that
 * stops early is an annoyance, a run that quietly overspends is a bill.
 */
const FALLBACK_RATE: TokenRate = { inputPerMTok: 15, outputPerMTok: 75 };

export function resolveModelRate(model: string, override?: TokenRate): ResolvedRate {
  if (override) return { ...override, family: 'override', known: true };

  const id = model.toLowerCase();
  const hit = FAMILY_RATES.find((entry) => id.includes(entry.match));
  return hit
    ? { ...hit.rate, family: hit.family, known: true }
    : { ...FALLBACK_RATE, family: 'unknown', known: false };
}

/** Cost in US dollars for one completion, at the model's own rate. */
export function estimateCostUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
  override?: TokenRate,
): number {
  const rate = resolveModelRate(model, override);
  return (promptTokens / 1e6) * rate.inputPerMTok + (completionTokens / 1e6) * rate.outputPerMTok;
}

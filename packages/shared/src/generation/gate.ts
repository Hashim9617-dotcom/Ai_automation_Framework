import { rank, tokenize, type InventoryEntry } from '../matching/command-matcher';

/**
 * Should this command produce a generated case at all?
 *
 * Generation fires ONLY when the existing suite has nothing resembling the
 * command (`rank()` returns no matches). The most expensive generation is the
 * one that recreates a test we already have, so never paying for it beats
 * deduplicating afterwards — and the check is free, already built and already
 * unit-tested (docs/phase-2-generation.md, "Where generation fires").
 */
export interface GenerationGateVerdict {
  /** True when nothing in the suite matched and generation may proceed. */
  generate: boolean;
  /** The command's keywords after stop-word removal — what was actually matched on. */
  keywords: string[];
  /**
   * The existing tests that suppressed generation, best match first. Empty
   * when `generate` is true.
   */
  suppressedBy: Array<{ title: string; file: string; score: number }>;
  /** One line, ready to log. Never empty. */
  reason: string;
}

/**
 * This gate fails silently in the SAFE direction, which is also the INVISIBLE
 * one, and that is the whole reason `suppressedBy` and `reason` exist.
 *
 * `rank()` is keyword matching, so it will sometimes match a test that shares
 * vocabulary but not intent — "download" appears in both "bulk download" and
 * "download template". When that happens the gate suppresses generation for a
 * genuinely new flow, and the only symptom is that nothing was produced. That
 * is indistinguishable, from the outside, from "there was no gap to fill".
 *
 * Two very different states, one identical observation. So the gate always
 * names what it matched and with what score: "the generator produced nothing"
 * must never be ambiguous. A caller that logs `reason` turns an hour of
 * confusion into one line of output.
 */
export function checkGenerationGate(
  command: string,
  inventory: InventoryEntry[],
): GenerationGateVerdict {
  const keywords = tokenize(command);

  if (keywords.length === 0) {
    return {
      generate: false,
      keywords,
      suppressedBy: [],
      reason: `no searchable keywords in "${command}" — every word was a stop word, so nothing could be matched or generated`,
    };
  }

  const matches = rank(inventory, keywords);

  if (matches.length === 0) {
    return {
      generate: true,
      keywords,
      suppressedBy: [],
      reason: `no existing test matched [${keywords.join(', ')}] — generating`,
    };
  }

  const suppressedBy = matches.map((match) => ({
    title: match.entry.title,
    file: match.entry.file,
    score: match.score,
  }));

  const top = suppressedBy
    .slice(0, 3)
    .map((entry) => `"${entry.title}" (score ${entry.score})`)
    .join(', ');

  return {
    generate: false,
    keywords,
    suppressedBy,
    reason:
      `not generating: [${keywords.join(', ')}] already matches ${suppressedBy.length} existing test(s) — ${top}` +
      (suppressedBy.length > 3 ? `, and ${suppressedBy.length - 3} more` : '') +
      '. If this command really is a new flow, the match is a vocabulary collision and generation can be forced.',
  };
}

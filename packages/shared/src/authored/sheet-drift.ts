/**
 * WHAT THE SHEET EXPECTS AGAINST WHAT THE PAGE HAS — in three buckets.
 *
 * ## The problem this is for
 *
 * The Ecom QA sheet was AI-generated from requirement documents and walkthrough
 * videos and has never been through a human run. A column it names that the page
 * does not have is therefore a fact about the SHEET at least as often as about the
 * application. The first smoke run reported drift on 16 of 29 modules, as one
 * undifferentiated list — which is useless to the person who has to act on it,
 * because the list mixes two completely different jobs:
 *
 * - `"Code"` where the page says `"CATEGORY CODE"`: the sheet is RIGHT and worded
 *   differently. Nobody needs to do anything except possibly tidy the sheet.
 * - `"GST"` where the page says `"VAT %"`: the sheet names something that is not
 *   there. Somebody has to decide whether the requirement moved or the sheet is
 *   wrong, and that is a conversation.
 *
 * Merging them is the same mistake as merging `failed` with `refused`: the combined
 * list is unactionable for everybody, because nobody can tell which rows are theirs.
 *
 * ## It must not LOOSEN anything
 *
 * The tempting shortcut is a fuzzy match that makes the drift number go down. That
 * would hide the second kind inside the first, which is worse than the original
 * undifferentiated list — an alarming number at least gets looked at. So:
 *
 * - the rules are STRICT and stated below, with the abbreviation case deliberately
 *   excluded because recognising it needs a dictionary and a dictionary is a list
 *   somebody wrote;
 * - a bucket is a RANKING, never a dismissal. Every row — match, phrasing and real
 *   alike — is written to `sheet-drift.csv` with the exact expected string, the exact
 *   found header it was paired with, and the rule that fired. A mis-pairing is
 *   therefore visible to the QA reading the file rather than absorbed by it.
 *
 * ## The rules, exactly
 *
 * Both sides are normalised the same way: non-text characters stripped (this
 * application's headers carry U+EB0B icon glyphs), lowercased, every non-alphanumeric
 * character turned into a space, split on whitespace. No stop-word list — a
 * hand-written set of words to ignore is the denylist shape this repo keeps finding
 * broken, and `of` carries meaning in `Date of Birth`.
 *
 * Then, first rule that fires:
 *
 * 1. **MATCH** — some found header has the identical token sequence.
 * 2. **PHRASING** — some found header `f` for which EVERY token of the expected name
 *    is either (a) one of `f`'s tokens, or (b) a prefix of one of `f`'s tokens at
 *    least three characters long. Both halves must be satisfied by the SAME `f`.
 * 3. **REAL** — neither.
 *
 * Worked, including the ones that must NOT pass:
 *
 * | expected | found | bucket | why |
 * | --- | --- | --- | --- |
 * | `Category Code` | `CATEGORY CODE` | match | identical tokens |
 * | `Code` | `CATEGORY CODE` | phrasing | (a) |
 * | `Contact` | `CONTACT PERSON` | phrasing | (a) |
 * | `Min` | `MINIMUM` | phrasing | (b), 3-char prefix |
 * | `Qty` | `QUANTITY` | **real** | `qty` is not a prefix of `quantity` |
 * | `GST` | `VAT %` | **real** | no shared token, prefixes nothing |
 * | `Symbol` | `Code`, `Name`… | **real** | not there |
 *
 * ## Containment is checked in ONE direction, and that is the point
 *
 * The expected name's tokens must be covered by the found header's. The reverse —
 * the sheet says `Category Code` and the page says `Code` — is NOT phrasing, because
 * `Supplier Name` against a page column `Name` reads identically to the rule and may
 * well be a different column. One direction is the half that cannot invent a
 * counterpart out of a generic word.
 */

/** Unicode's own definition of "not text": format, private-use, surrogate, control. */
const NON_TEXT = /[\p{Cf}\p{Co}\p{Cs}\p{Cc}]/gu;

/** The shortest prefix that may stand for a whole word. `min` for `minimum`. */
export const MIN_PREFIX = 3;

export type DriftBucket = 'match' | 'phrasing' | 'real';

/** Which rule produced the verdict. Recorded so a pairing can be argued with. */
export type DriftRule = 'exact' | 'token-containment' | 'prefix-abbreviation' | 'none';

export interface DriftRow {
  module: string;
  caseId: string;
  /** Exactly as the sheet wrote it. */
  expected: string;
  /** Exactly as the page wrote it, or `null` when nothing was paired with it. */
  found: string | null;
  bucket: DriftBucket;
  rule: DriftRule;
  /**
   * How many found headers satisfied the rule that fired.
   *
   * A 1-of-4 pairing and a 1-of-1 pairing are different things to a reader: the
   * first says the classifier chose, the second says there was nothing to choose.
   * Without it a deterministic choice looks like a certain one.
   */
  candidates: number;
}

export interface DriftCounts {
  match: number;
  phrasing: number;
  real: number;
}

/** Normalised tokens of a header or an expected column name. */
export function headerTokens(value: string): string[] {
  return value
    .replace(NON_TEXT, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((token) => token.length > 0);
}

/** Does every token of `expected` appear verbatim among `found`'s tokens? */
function containedIn(expected: readonly string[], found: readonly string[]): boolean {
  return expected.length > 0 && expected.every((token) => found.includes(token));
}

/** Is every token of `expected` a token of `found` OR a long-enough prefix of one? */
function abbreviates(expected: readonly string[], found: readonly string[]): boolean {
  return (
    expected.length > 0 &&
    expected.every(
      (token) =>
        found.includes(token) ||
        (token.length >= MIN_PREFIX && found.some((other) => other.startsWith(token))),
    )
  );
}

/**
 * Picks one counterpart from several, deterministically.
 *
 * Most shared tokens first, then the shortest header, then alphabetically. The order
 * is not clever and does not try to be: the pair is shown to a human who can see
 * both strings, so what matters is that the same inputs always give the same row
 * rather than that the choice is always the best one.
 */
function bestOf(candidates: readonly string[], expectedTokens: readonly string[]): string {
  return [...candidates].sort((a, b) => {
    const shared = (header: string): number =>
      headerTokens(header).filter((token) => expectedTokens.includes(token)).length;
    return shared(b) - shared(a) || a.length - b.length || a.localeCompare(b);
  })[0]!;
}

/**
 * Classifies every expected column against the headers a page actually rendered.
 *
 * An expected name that normalises to nothing — a blank cell, a stray separator — is
 * SKIPPED rather than classified. It is not drift; it is an empty cell, and counting
 * it as `real` would inflate the one number that must stay trustworthy.
 */
export function classifyColumns(
  expected: readonly string[],
  found: readonly string[],
  where: { module: string; caseId: string },
): DriftRow[] {
  const foundTokens = found.map((header) => ({ header, tokens: headerTokens(header) }));

  const rows: DriftRow[] = [];
  for (const column of expected) {
    const tokens = headerTokens(column);
    if (tokens.length === 0) continue;

    const row = (bucket: DriftBucket, rule: DriftRule, hits: string[]): DriftRow => ({
      module: where.module,
      caseId: where.caseId,
      expected: column,
      found: hits.length > 0 ? bestOf(hits, tokens) : null,
      bucket,
      rule,
      candidates: hits.length,
    });

    const exact = foundTokens
      .filter((entry) => entry.tokens.join(' ') === tokens.join(' '))
      .map((entry) => entry.header);
    if (exact.length > 0) {
      rows.push(row('match', 'exact', exact));
      continue;
    }

    const contained = foundTokens
      .filter((entry) => containedIn(tokens, entry.tokens))
      .map((entry) => entry.header);
    if (contained.length > 0) {
      rows.push(row('phrasing', 'token-containment', contained));
      continue;
    }

    const abbreviated = foundTokens
      .filter((entry) => abbreviates(tokens, entry.tokens))
      .map((entry) => entry.header);
    if (abbreviated.length > 0) {
      rows.push(row('phrasing', 'prefix-abbreviation', abbreviated));
      continue;
    }

    rows.push(row('real', 'none', []));
  }
  return rows;
}

export function countBuckets(rows: readonly DriftRow[]): DriftCounts {
  const counts: DriftCounts = { match: 0, phrasing: 0, real: 0 };
  for (const row of rows) counts[row.bucket] += 1;
  return counts;
}

/** One line per module for a run.json annotation. Counts, never the names. */
export function describeCounts(counts: DriftCounts): string {
  return `match ${counts.match}, phrasing ${counts.phrasing}, real ${counts.real}`;
}

export const DRIFT_CSV_HEADER = 'Module,Case ID,Expected (sheet),Found (app header),Bucket,Rule';

/** RFC 4180: quote everything, double any quote inside. A header could contain a comma. */
function cell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * The CSV a QA reviews, worst first.
 *
 * `real` before `phrasing` before `match`, because the file is read top-down by
 * somebody with limited time and the rows that need a decision are the ones that
 * must not be below the fold. Within a bucket, by module then case then column, so
 * two runs over the same sheet produce comparable files.
 *
 * HEADER NAMES ONLY. No cell value, no row content, no record identifier — the same
 * rule the smoke manifest is built under, and the reason this file can be attached
 * to a report that leaves the machine.
 */
export function driftCsv(rows: readonly DriftRow[]): string {
  const rank: Record<DriftBucket, number> = { real: 0, phrasing: 1, match: 2 };
  const sorted = [...rows].sort(
    (a, b) =>
      rank[a.bucket] - rank[b.bucket] ||
      a.module.localeCompare(b.module) ||
      a.caseId.localeCompare(b.caseId) ||
      a.expected.localeCompare(b.expected),
  );
  return [
    DRIFT_CSV_HEADER,
    ...sorted.map((row) =>
      [
        cell(row.module),
        cell(row.caseId),
        cell(row.expected),
        cell(row.found ?? ''),
        cell(row.bucket),
        cell(row.rule),
      ].join(','),
    ),
  ].join('\r\n');
}

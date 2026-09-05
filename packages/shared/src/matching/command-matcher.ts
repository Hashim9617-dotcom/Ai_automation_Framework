/**
 * Pure matching logic for the AI Command Box, deliberately free of NestJS and
 * of any I/O so it can be unit-tested and reasoned about on its own.
 */

export interface InventoryEntry {
  /** Full path including describe blocks — for display. */
  title: string;
  /** Leaf test title — Playwright's --grep matches this, NOT the ' > ' joined path. */
  leafTitle: string;
  file: string;
  tags: string[];
}

const STOP_WORDS = new Set([
  'test',
  'tests',
  'testing',
  'the',
  'a',
  'an',
  'for',
  'of',
  'and',
  'run',
  'check',
  'verify',
  'validate',
  'complete',
  'full',
  'flow',
  'please',
  'all',
]);

export function tokenize(command: string): string[] {
  return [
    ...new Set(
      command
        .toLowerCase()
        .split(/[^a-z0-9@]+/)
        .filter((word) => word.length > 2 && !STOP_WORDS.has(word)),
    ),
  ];
}

export function rank(
  inventory: InventoryEntry[],
  keywords: string[],
): Array<{ entry: InventoryEntry; score: number }> {
  const scored = inventory
    .map((entry) => {
      const haystack = `${entry.title} ${entry.file} ${entry.tags.join(' ')}`.toLowerCase();
      const score = keywords.reduce((total, keyword) => {
        if (haystack.includes(keyword)) return total + (entry.tags.includes(`@${keyword}`) ? 2 : 1);
        return total;
      }, 0);
      return { entry, score };
    })
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return [];
  // Keep only matches close to the best score, so one strong hit does not drag in noise.
  const best = scored[0]!.score;
  return scored.filter((match) => match.score >= Math.max(1, best - 1));
}

export function flattenSuites(
  suites: Array<Record<string, unknown>>,
  file = '',
  titles: string[] = [],
): InventoryEntry[] {
  const out: InventoryEntry[] = [];

  for (const suite of suites) {
    const suiteFile = (suite.file as string) || file;
    const suiteTitle = (suite.title as string) ?? '';
    const nextTitles = suiteTitle && suiteTitle !== suiteFile ? [...titles, suiteTitle] : titles;

    for (const spec of (suite.specs ?? []) as Array<Record<string, unknown>>) {
      const specTitle = (spec.title as string) ?? '';
      // Tags live on the SPEC in Playwright's JSON report (already merged from
      // any enclosing describe), and are emitted without the leading '@'.
      const specTags = ((spec.tags as string[]) ?? []).map((tag) =>
        tag.startsWith('@') ? tag : `@${tag}`,
      );
      out.push({
        title: [...nextTitles, specTitle].filter(Boolean).join(' › '),
        leafTitle: specTitle,
        file: suiteFile,
        tags: [...new Set(specTags)],
      });
    }

    if (suite.suites) {
      out.push(
        ...flattenSuites(suite.suites as Array<Record<string, unknown>>, suiteFile, nextTitles),
      );
    }
  }
  return out;
}

export function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}


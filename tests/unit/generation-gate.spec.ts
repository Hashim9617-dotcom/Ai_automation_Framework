import { test, expect } from '@playwright/test';
import { checkGenerationGate, type InventoryEntry } from '@aitp/shared';

/**
 * Expectations derive from `docs/phase-2-generation.md`, "Where generation
 * fires: only when we don't already have it" — not from reading `gate.ts`
 * (rule 4).
 *
 * The design's requirements on this gate:
 *   R1  generation fires ONLY when `rank()` matches nothing
 *   R2  an existing match suppresses generation
 *   R3  every suppression names the matched tests: title, file, score
 *   R4  matches are ordered best first
 *   R5  `reason` is never empty in ANY branch, and names the top matches
 *   R6  an all-stop-words command is its own branch, distinguishable from a
 *       genuine gap
 *
 * R3/R5 exist because this gate fails silently in the safe direction, which is
 * also the invisible one: over-matching suppresses a genuinely new flow, and
 * the only symptom is that nothing was produced — identical to "there was no
 * gap". The design makes naming the match a requirement on the verdict, not a
 * courtesy of the caller.
 */

const inventory: InventoryEntry[] = [
  {
    title: 'Global Search › selecting all results enables the bulk download',
    leafTitle: 'selecting all results enables the bulk download',
    file: 'tests/app/global-search.spec.ts',
    tags: ['@regression', '@search'],
  },
  {
    title: 'Bulk Upload wizard › the metadata template download is gated on a document type',
    leafTitle: 'the metadata template download is gated on a document type',
    file: 'tests/app/upload.spec.ts',
    tags: ['@regression', '@upload'],
  },
  {
    title: 'Admin lists › Users list loads and is searchable',
    leafTitle: 'Users list loads and is searchable',
    file: 'tests/app/admin.spec.ts',
    tags: ['@regression', '@admin'],
  },
];

test.describe('generation gate @unit', () => {
  test('R1: a command with no existing counterpart generates', () => {
    const verdict = checkGenerationGate('test the workspace archive restore flow', inventory);
    expect(verdict.generate).toBe(true);
    expect(verdict.suppressedBy).toEqual([]);
  });

  test('R2: a command the suite already covers does not generate', () => {
    const verdict = checkGenerationGate('bulk download of search results', inventory);
    expect(verdict.generate).toBe(false);
    expect(verdict.suppressedBy.length).toBeGreaterThan(0);
  });

  test('R3: a suppression names the matched test — title, file and score', () => {
    const verdict = checkGenerationGate('bulk download of search results', inventory);
    const top = verdict.suppressedBy[0]!;

    expect(top.title).toContain('bulk download');
    expect(top.file).toBe('tests/app/global-search.spec.ts');
    expect(top.score).toBeGreaterThan(0);
  });

  test('R3: the keywords actually matched on are reported', () => {
    // "the" and "of" are stop words; they must not appear as evidence.
    const verdict = checkGenerationGate('the bulk download of results', inventory);
    expect(verdict.keywords).toContain('bulk');
    expect(verdict.keywords).toContain('download');
    expect(verdict.keywords).not.toContain('the');
    expect(verdict.keywords).not.toContain('of');
  });

  test('R4: matches are ordered best first', () => {
    // Needs entries that score DIFFERENTLY, or the assertion is vacuous: a
    // reversed list of tied scores still equals its own sort, so the test
    // passes against a deliberately broken ordering. Found by mutation
    // testing, which is the only reason this fixture is hand-built.
    //
    // `rank()` scores +1 per keyword found in title/file/tags, +2 when the
    // keyword is also a tag. So with keywords [bulk, download, search]:
    //   tagged  -> bulk 1 + download 1 + search 2 (tag) = 4
    //   plain   -> bulk 1 + download 1 + search 1      = 3
    // and `rank()` keeps everything within 1 of the best, so both survive.
    const scored: InventoryEntry[] = [
      {
        title: 'plain bulk download of search results',
        leafTitle: 'plain bulk download of search results',
        file: 'tests/app/a.spec.ts',
        tags: [],
      },
      {
        title: 'tagged bulk download',
        leafTitle: 'tagged bulk download',
        file: 'tests/app/b.spec.ts',
        tags: ['@search'],
      },
    ];

    const verdict = checkGenerationGate('bulk download search', scored);
    const scores = verdict.suppressedBy.map((entry) => entry.score);

    expect(scores.length).toBe(2);
    expect(new Set(scores).size).toBe(2); // the scores really do differ
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(verdict.suppressedBy[0]!.title).toContain('tagged');
  });

  test('R5: reason is non-empty in every branch and names what matched', () => {
    const suppressed = checkGenerationGate('bulk download of search results', inventory);
    expect(suppressed.reason.length).toBeGreaterThan(0);
    // The anti-ambiguity requirement: a reader must be able to tell
    // "suppressed by an existing test" from "nothing to generate".
    expect(suppressed.reason).toContain('bulk download');

    const generating = checkGenerationGate('workspace archive restore', inventory);
    expect(generating.reason.length).toBeGreaterThan(0);
    expect(generating.reason).toContain('generating');
  });

  test('R6: an all-stop-words command is its own branch, not a generation attempt', () => {
    const verdict = checkGenerationGate('please run all the tests', inventory);
    expect(verdict.generate).toBe(false);
    expect(verdict.keywords).toEqual([]);
    // Must NOT look like "an existing test covers this".
    expect(verdict.suppressedBy).toEqual([]);
    expect(verdict.reason).toContain('stop word');
  });

  test('R6: the two non-generating branches are distinguishable from each other', () => {
    const stopWords = checkGenerationGate('please run all the tests', inventory);
    const covered = checkGenerationGate('bulk download of search results', inventory);

    expect(stopWords.generate).toBe(false);
    expect(covered.generate).toBe(false);
    // Same verdict, different explanation — which is the entire point.
    expect(stopWords.reason).not.toBe(covered.reason);
    expect(stopWords.suppressedBy.length).toBe(0);
    expect(covered.suppressedBy.length).toBeGreaterThan(0);
  });

  test('the known vocabulary collision is documented behaviour, not an accident', () => {
    // "download template" and "bulk download" share a word but not intent.
    // The design accepts this failure direction and requires the match be
    // named, so a human can see the collision and force generation.
    const verdict = checkGenerationGate('download the metadata template', inventory);
    expect(verdict.generate).toBe(false);
    expect(verdict.suppressedBy.some((e) => e.title.includes('metadata template'))).toBe(true);
    expect(verdict.reason).toContain('vocabulary collision');
  });

  test('an empty inventory always generates', () => {
    const verdict = checkGenerationGate('anything at all here', []);
    expect(verdict.generate).toBe(true);
    expect(verdict.reason).toContain('no existing test matched');
  });
});

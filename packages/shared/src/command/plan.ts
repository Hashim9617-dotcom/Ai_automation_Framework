import { checkGenerationGate, type GenerationGateVerdict } from '../generation/gate';
import { tokenize, type InventoryEntry } from '../matching/command-matcher';

/**
 * Which door answers a command, and why the earlier ones did not.
 *
 * `docs/phase-2-command-box.md` §1 and §2. This is a PURE function on purpose:
 * the precedence is the load-bearing decision of the whole feature, so it is
 * testable without booting Nest, launching a browser or calling a model.
 *
 * The order, and the reason for it:
 *
 *     existing tests  →  authored sheet rows  →  generation from a capture
 *
 * **The sheet beats generation because of rule 4.** A sheet row is an EXTERNAL
 * source of truth — a human wrote what the flow should do, before and
 * independently of anything the platform observed. A generated case's
 * expectations come from the system under test. Preferring generation while a
 * human's expectation sits unread is rule 4 violated by PREFERENCE ORDER rather
 * than by a bad test, which is much harder to see afterwards.
 *
 * Existing tests come first for the gate's own reason: the most expensive
 * generation is the one that recreates a test we already have.
 */

/** Which door was asked to answer. `auto` walks the precedence above. */
export type CommandSource = 'auto' | 'existing' | 'sheet' | 'generate';

/** Which door actually answered — or why none did. */
export type CommandDoor = 'existing' | 'sheet' | 'generate' | 'none';

/** A sheet row reduced to what matching needs. Keeps this module sheet-agnostic. */
export interface SheetRowRef {
  rowId: string;
  /** Module, scenario name and objective joined — what a command is matched against. */
  text: string;
}

/**
 * What each door had to search, named so a nothing-answer can say what it
 * looked in rather than only that it found nothing.
 *
 * `null` means the corpus is NOT CONFIGURED, which is a different statement
 * from `0` — "no workbook is set up" versus "the workbook has no rows". The
 * two have different next steps, so they get different values.
 */
export interface SearchedCorpora {
  /** The command's keywords after stop-word removal. Empty = nothing to search for. */
  keywords: string[];
  /**
   * `null` means the inventory could NOT BE LOADED — not that the suite is
   * empty. Found the hard way on 2026-09-16: `playwright test --list
   * --reporter=json` had its stdout corrupted by the repo's own logger, the
   * service caught the parse error and returned `[]`, and every command then
   * fell through to generation reporting "nothing existing matched" while 446
   * tests sat there unsearched. A failed search must never be reported as an
   * empty result.
   */
  existingTests: number | null;
  sheetRows: number | null;
  captureStates: string[] | null;
  capturedAt: string | null;
}

export interface CommandPlan {
  command: string;
  source: CommandSource;
  door: CommandDoor;
  searched: SearchedCorpora;
  /** The gate's verdict — `keywords`, `suppressedBy` with scores, and a reason. */
  gate: GenerationGateVerdict;
  /** Matching existing tests, best first. Empty unless the door is `existing`. */
  matched: Array<{ title: string; file: string; tags: string[]; score: number }>;
  /** Matching sheet rows. Empty unless the door is `sheet`. */
  sheetMatches: SheetRowRef[];
  /**
   * Why each door did not answer, in precedence order. The door that DID answer
   * is absent. This is what turns "nothing happened" into an account.
   */
  skipped: Array<{ door: Exclude<CommandDoor, 'none'>; why: string }>;
  /** One line a human can read. Never empty. */
  reason: string;
}

export interface PlanInput {
  command: string;
  source?: CommandSource;
  /** `null` when the inventory could not be loaded — distinct from an empty suite. */
  inventory: InventoryEntry[] | null;
  /** `null` when no workbook is configured — distinct from an empty sheet. */
  sheetRows?: SheetRowRef[] | null;
  /** `null` when no capture is on disk — distinct from a capture with no states. */
  captureStates?: string[] | null;
  capturedAt?: string | null;
}

/** Does this row's text contain every keyword? Deliberately strict — see below. */
function matchesAllKeywords(text: string, keywords: string[]): boolean {
  const haystack = text.toLowerCase();
  return keywords.every((keyword) => haystack.includes(keyword));
}

export function planCommand(input: PlanInput): CommandPlan {
  const source = input.source ?? 'auto';
  const sheetRows = input.sheetRows ?? null;
  const captureStates = input.captureStates ?? null;

  // The GATE, not bare `rank()`. It produces `keywords`, `suppressedBy` with
  // scores, and a reason — all already built and unit-tested, and until now
  // never surfaced to the API. §2.
  const inventory = input.inventory ?? [];
  const gate = checkGenerationGate(input.command, inventory);
  const keywords = tokenize(input.command);

  const searched: SearchedCorpora = {
    keywords,
    existingTests: input.inventory === null ? null : input.inventory.length,
    sheetRows: sheetRows === null ? null : sheetRows.length,
    captureStates,
    capturedAt: input.capturedAt ?? null,
  };

  const matched = gate.suppressedBy.map((entry) => ({
    title: entry.title,
    file: entry.file,
    tags: inventory.find((item) => item.title === entry.title)?.tags ?? [],
    score: entry.score,
  }));

  const sheetMatches =
    keywords.length === 0 || sheetRows === null
      ? []
      : sheetRows.filter((row) => matchesAllKeywords(row.text, keywords));

  const skipped: CommandPlan['skipped'] = [];
  const base = { command: input.command, source, searched, gate, matched, sheetMatches, skipped };

  // A command with no searchable words is its own answer, and must not be
  // reported as "nothing matched" — nothing was searched FOR. §2.
  if (keywords.length === 0) {
    return {
      ...base,
      door: 'none',
      matched: [],
      sheetMatches: [],
      reason: `every word in "${input.command}" is a stop word, so there was nothing to search for — rephrase with a word from a test title, a tag, or the flow you mean`,
    };
  }

  const wantsExisting = source === 'auto' || source === 'existing';
  const wantsSheet = source === 'auto' || source === 'sheet';
  const wantsGenerate = source === 'auto' || source === 'generate';

  // ---- door 1: existing tests ----------------------------------------------
  if (wantsExisting && matched.length > 0) {
    return {
      ...base,
      door: 'existing',
      sheetMatches: [],
      reason: `${matched.length} existing test(s) matched [${keywords.join(', ')}] — running them rather than generating, because the most expensive generation is one that recreates a test we already have`,
    };
  }
  if (wantsExisting) {
    skipped.push({
      door: 'existing',
      // A FAILED search and an EMPTY one are different answers. Reporting
      // "nothing matched" when the inventory never loaded sends the reader to
      // write a test that already exists.
      why:
        input.inventory === null
          ? 'the test inventory could not be loaded, so existing tests were never searched — this is NOT the same as finding nothing'
          : `no existing test matched [${keywords.join(', ')}] across ${searched.existingTests} test(s)`,
    });
  }

  // ---- door 2: authored sheet rows -----------------------------------------
  if (wantsSheet && sheetMatches.length > 0) {
    return {
      ...base,
      door: 'sheet',
      matched: [],
      reason: `${sheetMatches.length} sheet row(s) matched [${keywords.join(', ')}] — a QA already wrote what this flow should do, so their expectation is used rather than a generated one`,
    };
  }
  if (wantsSheet) {
    skipped.push({
      door: 'sheet',
      why:
        sheetRows === null
          ? 'no QA workbook is configured, so there are no authored rows to match'
          : `no authored row matched [${keywords.join(', ')}] across ${sheetRows.length} row(s)`,
    });
  }

  // ---- door 3: generation --------------------------------------------------
  // Deliberately last. It is the only door whose expectations come from the
  // system under test, so it answers "nobody has written this down anywhere".
  if (wantsGenerate && captureStates !== null && captureStates.length > 0) {
    // `gate.generate` is false when an existing test suppressed generation —
    // but reaching here means none did, OR the caller pinned `generate`.
    return {
      ...base,
      door: 'generate',
      matched: [],
      sheetMatches: [],
      reason: `nothing existing or authored matched [${keywords.join(', ')}] — generating proposals against ${captureStates.length} captured state(s) for human review`,
    };
  }
  if (wantsGenerate) {
    skipped.push({
      door: 'generate',
      why:
        captureStates === null
          ? 'no capture is on disk, so there is nothing to ground a generated case in — run `pnpm inspect`'
          : 'the capture on disk has no states, so there is nothing to ground a generated case in',
    });
  }

  return {
    ...base,
    door: 'none',
    matched: [],
    sheetMatches: [],
    reason:
      source === 'auto'
        ? `nothing answered [${keywords.join(', ')}]: ${skipped.map((entry) => entry.why).join('; ')}`
        : `the "${source}" door was pinned and did not answer: ${skipped.map((entry) => entry.why).join('; ')}`,
  };
}

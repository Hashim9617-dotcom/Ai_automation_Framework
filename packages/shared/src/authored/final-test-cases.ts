import { redactCredentialText } from '../utils/redact';
import type { SheetGrid } from './xlsx';

/**
 * The reader for the real QA sheet.
 *
 * Every constant here was MEASURED from the workbook and re-verified rather
 * than taken on trust — see `docs/phase-2-authored-cases.md` §0, which was
 * updated before this file was written.
 *
 * The provisional CSV reader in `sheet.ts` remains as a second adapter; this
 * one supersedes its schema.
 */

/** Which column holds what. 1-based, matching the spreadsheet's own numbering. */
export const FINAL_TEST_CASES_SCHEMA = {
  sheetName: 'Final Test cases',
  columns: {
    module: 1,
    feature: 2,
    scenarioId: 3,
    testCaseId: 4,
    scenarioName: 5,
    objective: 6,
    testType: 7,
    priority: 8,
    preconditions: 9,
    given: 10,
    when: 11,
    and: 12,
    then: 13,
    testData: 14,
    type: 18,
  },
  /**
   * Expected header text at each position, trimmed before comparison.
   *
   * **Validated by position, never keyed by name.** Measured: `"Issue No."`
   * appears at BOTH column 17 and column 20, so a name-keyed reader silently
   * takes whichever it finds first; and column 19 is `"SOC DMS "` with a
   * trailing space, so an exact-name lookup misses it entirely.
   */
  expectedHeaders: [
    'Module',
    'Feature',
    'Scenario ID',
    'Test Case ID',
    'Scenario Name',
    'Test Objective',
    'Test Type',
    'Priority',
    'Preconditions',
    'Given',
    'When',
    'And',
    'Then',
    'Test Data',
    'Actual Result',
    'Status',
    'Issue No.',
    'Type',
    'SOC DMS',
    'Issue No.',
    'Status 4',
    'Status 5',
  ],
  /**
   * The LAST MANUAL RUN's outcome, not input.
   *
   * Reading `Status` as an expectation would inherit a stale human verdict as a
   * requirement — rule 4 with extra steps, and worse than the generated case it
   * warns about, because a human's old pass/fail looks authoritative.
   */
  outputColumns: [15, 16, 17, 19, 20, 21, 22],
  /** Measured: 37 of 470 `And` cells join two clauses with this. */
  clauseSeparator: '&',
} as const;

/** Where a clause came from. The column decides the kind — see §2a. */
export type ClauseSource = 'given' | 'when' | 'and' | 'then';
export type ClauseKind = 'action' | 'assert' | 'unclassified';

export interface AuthoredClause {
  text: string;
  source: ClauseSource;
  kind: ClauseKind;
  /** Set when `kind` is `unclassified`: what stopped it being classified. */
  why?: string;
}

export interface AuthoredRow {
  /** `"SI_002 / TC_001"`. The composite — never the Test Case ID alone. */
  rowId: string;
  scenarioId: string;
  testCaseId: string;
  sheetRow: number;
  module: string;
  feature: string;
  scenarioName: string;
  objective: string;
  testType: string;
  priority: string;
  preconditions: string;
  /** Redacted. Carries live credentials in the real sheet. */
  testData: string;
  type: string;
  clauses: AuthoredClause[];
}

export interface UnreadableSheetRow {
  sheetRow: number;
  /**
   * Two rows in the real sheet have no identity, and they are NOT the same
   * problem — investigated 2026-09-08 rather than left as a count:
   *
   * - **row 15** holds one stray cell, `Test Type = "Functional"`, between two
   *   scenario blocks. Nothing of value is lost; it is sheet detritus.
   * - **row 208** holds `Feature = "3628"` plus a real `And` and a real `Then`
   *   (*"Page refresh (F5, hard refresh)…"*). **A genuine test case is being
   *   dropped here**, and the QA can recover it — but only if the report says
   *   so rather than lumping it in with the stray cell.
   *
   * Measured: those are the only two, and there is no partial-id shape at all
   * (0 rows missing just one of the pair). So this is malformed input rather
   * than a reader gap — but the two need different words, because one is worth
   * a QA's time and the other is not.
   */
  why: 'stray-cells' | 'content-without-identity' | 'empty-required-clause';
  reason: string;
  /** Set for `content-without-identity`: what would be lost. */
  orphanedContent?: string[];
  /**
   * Whatever identity the row DID carry. Optional, and the three are separate.
   *
   * A row is unreadable for three different reasons and they have three
   * different amounts of identity:
   *
   * - `empty-required-clause` has BOTH ids — the reader got that far and then
   *   found no clauses — so it can be named `"SI_004 / TC_001"` like any other
   *   row, and was not: it was reported as `"sheet row 7"`, which is the whole
   *   of finding F-UR-ID. A QA searching their sheet for the id they wrote
   *   found nothing.
   * - `content-without-identity` has AT MOST one, by definition.
   * - `stray-cells` (real row 15) usually has none.
   *
   * So these are filled from the cells that were actually there and left absent
   * otherwise. `module` is separate again: a row can name its module while
   * carrying no identity at all, and that is still worth telling a reader.
   */
  scenarioId?: string;
  testCaseId?: string;
  module?: string;
}

export interface FinalSheetReadResult {
  rows: AuthoredRow[];
  unreadable: UnreadableSheetRow[];
  /** Rows that were entirely empty: padding, accounted for but not reported. */
  blankRows: number;
  headerWarnings: string[];
}

/**
 * Verbs that classify a clause, and ONLY where they are unambiguous.
 *
 * Small on purpose. Widening it later is safe because an unrecognised clause
 * REFUSES; a heuristic that guesses at the margin is wrong silently and
 * forever. Getting this wrong turns an assertion into a click or a click into
 * an assertion, and neither fails loudly: an assertion mistaken for an action
 * is never checked, and the test goes green having verified nothing.
 */
const ASSERT_VERBS =
  /^(verify|verifies|expect|expects|check|checks|assert|asserts|ensure|ensures)\b/i;
const ACTION_VERBS =
  /^(click|clicks|press|presses|tap|taps|enter|enters|type|types|select|selects|navigate|navigates|open|opens|upload|uploads|search|searches)\b/i;
/** "X should be Y" is an assertion however it starts. */
const SHOULD_ASSERTION = /\bshould\b/i;

/**
 * An optional subject before the verb.
 *
 * Measured on the real sheet: clauses are written "User clicks on the sign-in
 * button", not "Click the sign-in button". Requiring the verb in position 0
 * left 217 of 513 And-clauses unclassified, most of them unambiguous.
 *
 * Narrow on purpose — a fixed, tiny list of subjects, so the VERB still does
 * the classifying and this only lets it be found. Anything else still refuses.
 */
const SUBJECT_PREFIX = /^(?:the\s+)?(?:user|users|system|admin|qa|tester|portal)\s+/i;

/**
 * Action verbs the platform can actually PERFORM. An ALLOWLIST.
 *
 * ## This was a denylist, and a denylist here is fail-OPEN
 *
 * It listed `upload|attach|browse` and let everything else through, on the
 * reasoning that those were the actions with nowhere to put a file. Measured
 * 2026-09-29 against a capture holding a node for every name these clauses
 * could slice out — the point being to see what happens when the target IS on
 * the page:
 *
 * | clause | became | executor |
 * | --- | --- | --- |
 * | `user enters 'Jane' in First name` | action, target **option "Jane"** | CLICK -> passed |
 * | `types 'Jane' into First name` | action, target **option "Jane"** | CLICK -> passed |
 * | `selects 'HR' from Department` | action, target **option "HR"** | CLICK -> passed |
 *
 * `enters`, `types` and `selects` are all in `ACTION_VERBS`, and
 * `extractTarget`'s quoted-name pattern — which is right to trust a name a human
 * put in quotes — grabs the **VALUE** as if it were an element. So the clause
 * becomes *"click the thing called Jane"*, and on any page where a value happens
 * to match a control name (an option, a row, a tag, a filter chip) it clicks it
 * and reports a pass with nothing typed.
 *
 * The usual case is barely better: when no control is named `Jane` the row is
 * refused `target-not-found` — *"nothing clickable named Jane"* — which blames
 * the QA's sentence for a gap in the platform, and sends them to rewrite a row
 * that is already correct.
 *
 * So the list is inverted. The executor does exactly one thing —
 * `locator.click()` — and this is that one thing's vocabulary. A new verb added
 * to `ACTION_VERBS` now REFUSES by default instead of silently becoming a click,
 * which is the only direction that fails safe.
 *
 * ## The three judgement calls, all resolved toward refusal
 *
 * `select`, `open` and `navigate` are genuinely ambiguous: *"selects the Roles
 * tab"* is a click and *"selects 'HR' from Department"* is not, and the verb
 * cannot tell them apart. They are OUT, because the two errors are not
 * symmetric — a refusal is recoverable (the QA writes "clicks the Roles tab" and
 * it runs), and a false pass is a row reported green having done nothing.
 *
 * `upload`/`attach`/`browse` need no entry of their own any more: they are
 * simply not on the list, which is the same answer reached by the general rule
 * instead of by three names someone had to think of.
 *
 * Kept beside `ACTION_VERBS` deliberately. A second verb list somewhere else
 * drifts from this one, and a drifted list reads exactly like a correct one.
 */
const PERFORMABLE_ACTION_VERBS =
  /\b(clicks?|clicked|clicking|presses?|pressed|pressing|taps?|tapped|tapping)\b/i;

/**
 * Unperformable verbs BY NAME — and this list cannot open a gate, only improve a
 * message, which is why a list is safe here and was not safe before.
 *
 * The gate is `PERFORMABLE_ACTION_VERBS` above: a clause with no click verb is
 * refused whether or not it appears below. This list only decides whether the
 * refusal can NAME the verb — `"selects" is not an action this platform can
 * perform`, which tells a QA to wait for a feature — or has to say the vaguer
 * *"no performable action could be read out of it"*, which tells them to rewrite
 * the sentence. Two different next moves, so the distinction is worth a list;
 * a word missing from it costs a good message, never a false pass.
 *
 * It is checked BEFORE the allowlist, not after. *"clicks Save and enters
 * Jane"* contains a click verb and is still not performable as written — only
 * half of it would happen, and the half that did would report a pass.
 */
const NAMED_UNPERFORMABLE_VERBS =
  /\b(uploads?|uploaded|uploading|attaches?|attached|attaching|browses?|browsed|browsing|enters?|entered|entering|types?|typed|typing|fills?|filled|filling|selects?|selected|selecting|chooses?|chose|choosing|navigates?|navigated|navigating|searches?|searched|searching|opens?|opened|opening|drags?|dragged|dragging|scrolls?|scrolled|scrolling|hovers?|hovered|hovering|toggles?|toggled|toggling|switches?|switched|switching)\b/i;

/** Whether the executor can carry out an action clause, and if not, which verb. */
export interface ActionCapability {
  performable: boolean;
  /**
   * The verb to NAME in a refusal. Absent when nothing recognisable was found,
   * which is a different sentence to a different person — see the list above.
   */
  verb?: string;
}

/**
 * Can the executor carry out this action clause?
 *
 * Position-independent, and QUOTED NAMES ARE EXCLUDED first — the same rule
 * `extractRole` learned the hard way, that an element's own name is not a
 * description of it. *"verify by clicking 'Sign in'"* is a performable action
 * whose leading word is an assert verb, and a leading-word test refused it,
 * which would have made this function override the COLUMN the QA wrote. The
 * column decides what a clause IS; this only decides whether we can do it.
 *
 * The cost, stated: an UNQUOTED control name containing one of the words above
 * — *"clicks the Select all checkbox"* — is refused. Quoting the name fixes it,
 * and a refusal a QA can undo in one edit is the cheap direction.
 */
/**
 * A bare check/tick verb: an ACTION wearing an assertion's clothes.
 *
 * `checks` is in `ASSERT_VERBS`, so `checks the "Active" box` classifies as an
 * assertion and resolved to `assert checkbox "Active" present=true` — green as
 * soon as the box exists, having ticked nothing. Measured 2026-09-29 in the `and`
 * and `then` columns both.
 *
 * The discriminator is NOT the target's role, which was the obvious guess: it is
 * whether the clause names a STATE at all. `checks that "Done" is visible` and
 * `checks the "Save" button is present` are ordinary verifications and must keep
 * working; `checks the "Active" box` names no state, so there is nothing to
 * verify and the only reading that does anything is the tick this platform cannot
 * perform.
 *
 * Role-free by design, and the reason is `triage`: it is handed row text and the
 * set of captured MODULES, never a capture, so a role-based rule could not be
 * asked there and triage would promise rows the run refuses.
 */
const CHECK_FAMILY_VERBS = /\b(checks?|checking|ticks?|ticking|unchecks?|unticks?)\b/i;

/** Any word that names a state a verification could be about. */
const STATE_CLAIM_WORDS =
  /\b(checked|ticked|unchecked|selected|enabled|disabled|visible|present|shown|displayed|hidden|absent|gone|empty|expanded|collapsed|read-?only|editable|required|equals?|contains?|matches)\b/i;

/**
 * Where the COLUMN and the TEXT contradict each other, named.
 *
 * The column is a human saying what a clause is, and it always wins — that is
 * §2b and it is not negotiable. This does not re-derive the kind; it refuses.
 * The verb gets a VETO, never a vote: a clause whose column and text disagree
 * produces nothing, and the kind the column declared is still what gets recorded.
 *
 * Shared with `triage` so the ceiling cannot count a row the run then refuses.
 */
export function columnVerbConflict(clause: {
  text: string;
  source: ClauseSource;
}): string | undefined {
  const outsideNames = clause.text.replace(/["'`][^"'`]*["'`]/g, ' ');
  const stem = outsideNames.trim().replace(SUBJECT_PREFIX, '');

  // 1. An ASSERT verb in the When column. The column says "do something".
  if (clause.source === 'when' && ASSERT_VERBS.test(stem)) {
    return `the When column says this is an action, and the clause starts with an assertion verb`;
  }

  // 2. An ACTION verb leading the Then column. The column says "check
  //    something", and doing something is not checking it.
  //
  // `ACTION_VERBS` rather than a new list, and LEADING rather than anywhere. Two
  // drafts were wrong before this one, each in a way worth keeping:
  //
  // - testing only `PERFORMABLE_ACTION_VERBS` missed `selects the "Yes" radio`,
  //   which then fell through to the assert path and became `present=true` — the
  //   exact false pass this function exists for;
  // - testing `NAMED_UNPERFORMABLE_VERBS` instead refuses `verify the "Yes" radio
  //   is selected`, because `selected` is in it as a state word. A list holding
  //   both a verb and its participle cannot tell an action from an assertion.
  //
  // `ACTION_VERBS` is the vocabulary `classifyClause` already uses to decide that
  // a clause IS an action, is anchored after the subject, and holds finite verb
  // forms only. Anchoring also means an unquoted control name later in the clause
  // cannot trigger this.
  if (clause.source === 'then' && ACTION_VERBS.test(stem)) {
    return (
      `the Then column says this is an assertion, and the clause starts with the action verb ` +
      `"${ACTION_VERBS.exec(stem)![1]!.toLowerCase()}"`
    );
  }

  // 3. A check/tick verb naming no state, in ANY column.
  if (CHECK_FAMILY_VERBS.test(stem) && !STATE_CLAIM_WORDS.test(outsideNames)) {
    return (
      `"${CHECK_FAMILY_VERBS.exec(stem)![1]!.toLowerCase()}" names no state to verify, so this ` +
      'reads as ticking a box rather than checking one — write `verify the "X" checkbox is ' +
      'checked` (or `is not checked`) to VERIFY it; there is no tick action yet'
    );
  }

  return undefined;
}

/**
 * Words that are ROLE NOUNS, not verbs, however much they look like one.
 *
 * `clicks the "Active" toggle` was refused `action-not-supported`, naming the verb
 * `toggle` — a NOUN, and the clause's leading verb was `clicks`, which is
 * performable. The refusal was right by luck (there is no `switch` role word, so it
 * would not have resolved) and the REASON was wrong, which sends the QA to wait for
 * a toggle action that has nothing to do with it.
 *
 * Third instance of one rule: an element's own name is not a description of it.
 * `extractRole` read "select" out of "Select department"; `actionCapability` read
 * `enter` out of `presses Enter`; this reads `toggle` out of a control called a
 * toggle. Quoting the name does not help here, because the ROLE NOUN sits outside
 * the quotes by construction.
 *
 * Stripped only AFTER the first word, which is the verb position. A clause that
 * genuinely says *"toggle the switch"* keeps its verb and is still refused; one
 * that says *"clicks the toggle"* does not lose its click. Position is the whole
 * discriminator, and it is the one thing a word list cannot supply.
 */
const ROLE_NOUNS =
  /\b(toggles?|switch(?:es)?|select(?:or)?s?|filters?|searche?s?|links?|checkboxe?s?|entry|entries|drop-?downs?)\b/gi;

export function actionCapability(text: string): ActionCapability {
  // THE SUBJECT PREFIX COMES OFF FIRST, and the order is a bug I made: with
  // `User uploads the document`, the leading word was `User`, so `uploads` sat in
  // the strippable region and was removed — turning a named refusal into an unnamed
  // one. Caught by `U1`, which had been asserting that exact verb for a week.
  const stem = text
    .replace(/["'`][^"'`]*["'`]/g, ' ')
    .trim()
    .replace(SUBJECT_PREFIX, '');
  // What is left of the FIRST word is the verb. Everything after it may hold role
  // nouns, and a role noun is not the action being performed.
  const leadingWord = /^\S+/.exec(stem)?.[0] ?? '';
  const outsideNames = leadingWord + stem.slice(leadingWord.length).replace(ROLE_NOUNS, ' ');
  const named = NAMED_UNPERFORMABLE_VERBS.exec(outsideNames)?.[1]?.toLowerCase();
  if (named) return { performable: false, verb: named };
  if (PERFORMABLE_ACTION_VERBS.test(outsideNames)) return { performable: true };
  return { performable: false };
}

export function classifyClause(text: string): { kind: ClauseKind; why?: string } {
  const trimmed = text.trim();
  if (!trimmed) return { kind: 'unclassified', why: 'the clause is empty' };
  const stem = trimmed.replace(SUBJECT_PREFIX, '');
  if (ASSERT_VERBS.test(stem)) return { kind: 'assert' };
  if (ACTION_VERBS.test(stem)) return { kind: 'action' };
  if (SHOULD_ASSERTION.test(trimmed)) return { kind: 'assert' };
  return {
    kind: 'unclassified',
    why: 'no leading action or assertion verb — a human must say which this is',
  };
}

const clean = (value: string | undefined): string => redactCredentialText((value ?? '').trim());

/**
 * Reads the `Final Test cases` sheet.
 *
 * **Refuses the whole sheet on a duplicate composite key.** A duplicate
 * identity means no row's result can be traced, so the run stops rather than
 * producing a report nobody can rely on.
 */
export function readFinalTestCases(grid: SheetGrid): FinalSheetReadResult {
  if (grid.name !== FINAL_TEST_CASES_SCHEMA.sheetName) {
    throw new Error(
      `readFinalTestCases was given the sheet "${grid.name}", but this reader is for ` +
        `"${FINAL_TEST_CASES_SCHEMA.sheetName}". The workbook holds several test-case sheets ` +
        "with different layouts; reading one with another's reader produces garbage that looks like data.",
    );
  }
  if (grid.rows.length < 2) throw new Error('the sheet has no data rows');

  const header = grid.rows[0]!;
  const headerWarnings: string[] = [];
  for (const [i, expected] of FINAL_TEST_CASES_SCHEMA.expectedHeaders.entries()) {
    const actual = (header[i] ?? '').trim();
    if (actual !== expected) {
      headerWarnings.push(
        `column ${i + 1}: expected "${expected}", found "${actual}" — the layout may have changed`,
      );
    }
  }

  const col = FINAL_TEST_CASES_SCHEMA.columns;
  const at = (row: string[], column: number): string => clean(row[column - 1]);

  const rows: AuthoredRow[] = [];
  const unreadable: UnreadableSheetRow[] = [];
  let blankRows = 0;

  for (const [offset, row] of grid.rows.slice(1).entries()) {
    const sheetRow = offset + 2;

    if (row.every((cell) => (cell ?? '').trim() === '')) {
      blankRows += 1;
      continue;
    }

    const scenarioId = at(row, col.scenarioId);
    const testCaseId = at(row, col.testCaseId);
    if (!scenarioId || !testCaseId) {
      // Non-blank without an identity is REPORTED, never skipped. But WHICH
      // kind matters: a stray cell wastes a QA's time to look at, and a row
      // carrying real Gherkin content is a test case they can recover.
      const orphaned = (
        [
          [col.given, 'Given'],
          [col.when, 'When'],
          [col.and, 'And'],
          [col.then, 'Then'],
        ] as const
      )
        .map(([column, label]) => [label, at(row, column)] as const)
        .filter(([, value]) => value !== '')
        .map(([label, value]) => `${label}: ${value}`);

      // Whatever identity the row DID carry travels with it. Spread rather than
      // assigned, so a cell that was empty stays ABSENT instead of arriving as
      // `''` — an empty string would read as "the reader looked and the sheet
      // said nothing", which is a different claim from "there was no cell".
      const partialIdentity = {
        ...(scenarioId ? { scenarioId } : {}),
        ...(testCaseId ? { testCaseId } : {}),
        ...(at(row, col.module) ? { module: at(row, col.module) } : {}),
      };

      unreadable.push(
        orphaned.length > 0
          ? {
              ...partialIdentity,
              sheetRow,
              why: 'content-without-identity',
              reason:
                `row ${sheetRow} carries ${orphaned.length} real clause(s) but no ` +
                `${scenarioId ? 'Test Case ID' : 'Scenario ID'} — a test case is being lost here, ` +
                'and it can be recovered by giving the row an identity',
              orphanedContent: orphaned,
            }
          : {
              ...partialIdentity,
              sheetRow,
              why: 'stray-cells',
              reason:
                `row ${sheetRow} has a few stray cells and no identity or clauses — ` +
                'sheet detritus rather than a test case',
            },
      );
      continue;
    }

    const clauses: AuthoredClause[] = [];
    const push = (text: string, source: ClauseSource, kind: ClauseKind, why?: string): void => {
      if (text.trim()) clauses.push({ text: text.trim(), source, kind, ...(why ? { why } : {}) });
    };

    // The COLUMN decides the kind for three of the four. Only `And` is mixed.
    push(at(row, col.given), 'given', 'action');
    push(at(row, col.when), 'when', 'action');

    const andCell = at(row, col.and);
    if (andCell) {
      const halves = andCell.includes(FINAL_TEST_CASES_SCHEMA.clauseSeparator)
        ? andCell.split(FINAL_TEST_CASES_SCHEMA.clauseSeparator)
        : [andCell];
      for (const half of halves) {
        const { kind, why } = classifyClause(half);
        push(half, 'and', kind, why);
      }
    }

    push(at(row, col.then), 'then', 'assert');

    if (clauses.length === 0) {
      // This one has BOTH ids — it got past the identity check and failed on
      // content — so it is the unreadable row a QA can find in their own sheet.
      unreadable.push({
        sheetRow,
        why: 'empty-required-clause',
        scenarioId,
        testCaseId,
        ...(at(row, col.module) ? { module: at(row, col.module) } : {}),
        reason: `row ${sheetRow} (${scenarioId} / ${testCaseId}) has no Given, When, And or Then content`,
      });
      continue;
    }

    rows.push({
      rowId: `${scenarioId} / ${testCaseId}`,
      scenarioId,
      testCaseId,
      sheetRow,
      module: at(row, col.module),
      feature: at(row, col.feature),
      scenarioName: at(row, col.scenarioName),
      objective: at(row, col.objective),
      testType: at(row, col.testType),
      priority: at(row, col.priority),
      preconditions: at(row, col.preconditions),
      testData: at(row, col.testData),
      type: at(row, col.type),
      clauses,
    });
  }

  // Asserts its own effect: every input row left in exactly one bucket.
  const accounted = rows.length + unreadable.length + blankRows;
  if (accounted !== grid.rows.length - 1) {
    throw new Error(
      `readFinalTestCases dropped rows: ${grid.rows.length - 1} data row(s) in, ${accounted} accounted for.`,
    );
  }

  // The composite key is the identity. Keying on Test Case ID alone would
  // collapse 470 measured rows into 56, silently.
  const ids = rows.map((row) => row.rowId);
  const duplicates = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  if (duplicates.length > 0) {
    throw new Error(
      `duplicate row identity: ${duplicates.map((d) => `"${d}"`).join(', ')}. ` +
        'The (Scenario ID, Test Case ID) pair is what every result is traced by, so a collision ' +
        'means no row can be trusted — the sheet is refused rather than partly read.',
    );
  }

  return { rows, unreadable, blankRows, headerWarnings };
}

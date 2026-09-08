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
const ASSERT_VERBS = /^(verify|verifies|expect|expects|check|checks|assert|asserts|ensure|ensures)\b/i;
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
        'with different layouts; reading one with another\'s reader produces garbage that looks like data.',
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
      const orphaned = ([
        [col.given, 'Given'],
        [col.when, 'When'],
        [col.and, 'And'],
        [col.then, 'Then'],
      ] as const)
        .map(([column, label]) => [label, at(row, column)] as const)
        .filter(([, value]) => value !== '')
        .map(([label, value]) => `${label}: ${value}`);

      unreadable.push(
        orphaned.length > 0
          ? {
              sheetRow,
              why: 'content-without-identity',
              reason:
                `row ${sheetRow} carries ${orphaned.length} real clause(s) but no ` +
                `${scenarioId ? 'Test Case ID' : 'Scenario ID'} — a test case is being lost here, ` +
                'and it can be recovered by giving the row an identity',
              orphanedContent: orphaned,
            }
          : {
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
      unreadable.push({
        sheetRow,
        why: 'empty-required-clause',
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

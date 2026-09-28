import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AuthoredRunResult, RowResult } from './execute';
import type { RunIdentity } from './run-identity';

/**
 * A CSV of the rows the APP TEAM has to look at, for a QA to paste into their
 * own issue sheet.
 *
 * ## Two rules this file exists under, and neither is negotiable
 *
 * **The QA's workbook is never written to (E5).** This writes one new file into a
 * directory the caller names, under `artifacts/`. It does not open, read or
 * modify any `.xls*`. It lives in its own module for the same reason: the E5
 * guard scans `execute.ts` and `report.ts` for spreadsheet vocabulary, and a
 * writer placed there would trip it — correctly, because that is where a
 * well-meaning "just update the Status column" would go.
 *
 * **A trace path is never written.** `RowEvidence.trace` points at a `trace.zip`
 * holding live session tokens and document titles from the customer instance. A
 * screenshot is a picture of one screen; a trace is a replayable session. The
 * screenshot is included, the trace is not, and `verifyAutomationSheet` below
 * re-reads the file and fails if one appears — because "I did not write it" is a
 * claim about intent and re-reading is a fact about the file.
 *
 * ## Only app-team rows
 *
 * Everything else in a run belongs to someone else: a refused row is the QA's or
 * ours, a held row is a policy decision, `given-not-reached` is the environment's,
 * and a passing row is nobody's problem. Pasting those into an issue sheet asks
 * the app team to triage work that is not theirs, which is the merged-list
 * failure the report's own sections are kept apart to avoid.
 */

/** The `Interpretation` cell, until RCA reaches authored rows. */
export const NOT_ANALYSED = 'not analysed — RCA does not run on authored rows yet';

/**
 * One column: its heading, and what it reads out of a row.
 *
 * DATA, not code — the order is this array's order, and a QA whose issue sheet
 * has different headings changes this list rather than the writer. Measured need:
 * the one real sheet seen so far has 22 columns in a fixed order with two
 * duplicate headings, so "the columns are configurable" is not speculative.
 */
export interface AutomationSheetColumn {
  heading: string;
  cell: (row: RowResult, context: AutomationSheetContext) => string;
}

export interface AutomationSheetContext {
  runId: string;
  identity: RunIdentity;
}

/** The evidence a non-passing row carries, minus anything that must not travel. */
const screenshotOf = (row: RowResult): string => row.evidence?.screenshot ?? '';

export const DEFAULT_AUTOMATION_SHEET_COLUMNS: readonly AutomationSheetColumn[] = [
  { heading: 'Reported By', cell: (_row, c) => `automation-${c.identity.runBy}` },
  { heading: 'Run ID', cell: (_row, c) => c.runId },
  { heading: 'Row ID', cell: (row) => row.rowId },
  // `module` is bound to `given-not-reached` alone, so it is absent here by
  // construction — an app-team row always ran. Left blank rather than faked.
  { heading: 'Module', cell: (row) => ('module' in row ? String(row.module) : '') },
  { heading: 'Scenario ID', cell: (row) => row.scenarioId },
  { heading: 'Test Case ID', cell: (row) => row.testCaseId },
  { heading: 'Status', cell: (row) => row.status },
  { heading: 'Failing clause', cell: (row) => row.evidence?.failingClause ?? '' },
  // WHAT WAS SEEN, kept apart from what it was taken to mean. The next column is
  // the interpretation, and merging them would let a guess read as an
  // observation — which is the whole reason `observed` exists.
  { heading: 'Observed', cell: (row) => (row.observed ?? []).join(' | ') },
  { heading: 'Screenshot', cell: screenshotOf },
  { heading: 'Interpretation', cell: () => NOT_ANALYSED },
];

/**
 * Cells a spreadsheet would EXECUTE rather than display.
 *
 * Excel and Sheets treat a leading `=`, `+`, `-` or `@` as a formula, so an
 * `observed` string of `=HYPERLINK("http://…")` pasted into an issue sheet
 * becomes a live link — and `observed` is text the APPLICATION UNDER TEST put on
 * a page. A tab or carriage return at the start does the same thing after the
 * client trims it.
 *
 * Prefixed with `'`, which every spreadsheet reads as "the rest is text". Not
 * stripped: the QA needs to see exactly what was on the page.
 */
const FORMULA_START = /^[=+\-@\t\r]/;

/** RFC 4180: quote when the cell holds a quote, comma, CR or LF; double quotes. */
function csvCell(value: string): string {
  const guarded = FORMULA_START.test(value) ? `'${value}` : value;
  return /["\n\r,]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/** CRLF, because RFC 4180 says so and Excel is the reader this is written for. */
const csvRow = (cells: string[]): string => cells.map(csvCell).join(',');

/**
 * A leading BOM, so Excel opens it as UTF-8 rather than the local code page.
 *
 * Without it, a name or a page string outside ASCII arrives mojibaked in the one
 * place a QA is going to copy it from.
 */
const BOM = '\uFEFF';

export interface AutomationSheetOptions {
  outputDir: string;
  fileName?: string;
  identity: RunIdentity;
  columns?: readonly AutomationSheetColumn[];
}

export interface WrittenAutomationSheet {
  file: string;
  /** App-team rows written. Not the run's row count — see the filter. */
  rowsWritten: number;
  csv: string;
}

/** The rows this sheet is for. One place, so the writer and its check agree. */
export function appTeamRows(run: AuthoredRunResult): RowResult[] {
  return run.results.filter((row) => row.owner === 'app-team');
}

export function renderAutomationSheet(
  run: AuthoredRunResult,
  options: AutomationSheetOptions,
): string {
  const columns = options.columns ?? DEFAULT_AUTOMATION_SHEET_COLUMNS;
  const context: AutomationSheetContext = { runId: run.runId, identity: options.identity };
  const lines = [
    csvRow(columns.map((column) => column.heading)),
    ...appTeamRows(run).map((row) => csvRow(columns.map((column) => column.cell(row, context)))),
  ];
  return BOM + lines.join('\r\n') + '\r\n';
}

/**
 * Re-reads what landed and fails if it is not what was meant (E6's rule).
 *
 * Checking the string in memory would check the renderer against itself. These
 * three questions are asked of the FILE:
 *
 * - it parses, and holds exactly one row per app-team row plus a heading;
 * - no trace path appears anywhere in it;
 * - every row carries an interpretation, so no cell is silently blank where a
 *   reader expects a sentence.
 *
 * The trace check is the one that matters most and is checked in the direction
 * that catches the bad case: not "did I omit it" but "is it absent".
 */
export function verifyAutomationSheet(file: string, run: AuthoredRunResult): string {
  const landed = readFileSync(file, 'utf8');
  if (!landed.startsWith(BOM)) {
    throw new Error(`${file}: the UTF-8 BOM is missing — Excel will misread non-ASCII cells.`);
  }

  const rows = landed
    .slice(BOM.length)
    .split('\r\n')
    .filter((line) => line.length > 0);
  const expected = appTeamRows(run).length;
  if (rows.length !== expected + 1) {
    throw new Error(
      `${file}: holds ${rows.length - 1} data row(s) but the run has ${expected} app-team row(s). ` +
        'Refusing to report success on a sheet that does not match the run.',
    );
  }

  const traces = run.results.map((row) => row.evidence?.trace).filter((t): t is string => !!t);
  const leaked = traces.filter((trace) => landed.includes(trace));
  if (leaked.length > 0) {
    throw new Error(
      `${file}: a trace path is in the sheet (${leaked.length}). A trace holds live session ` +
        'tokens; only the screenshot may travel. Refusing to report success.',
    );
  }
  // Belt for the case where a row's trace is absent from the run but a path of
  // that shape got in anyway — the check above can only look for paths it knows.
  if (/trace\.zip/i.test(landed)) {
    throw new Error(`${file}: something matching "trace.zip" is in the sheet. Refusing.`);
  }

  for (const [index, row] of rows.slice(1).entries()) {
    if (!row.includes(NOT_ANALYSED)) {
      throw new Error(
        `${file}: data row ${index + 1} carries no interpretation. A blank cell where a reader ` +
          'expects a sentence reads as "nothing to say" rather than "not analysed".',
      );
    }
  }

  return landed;
}

export function writeAutomationSheet(
  run: AuthoredRunResult,
  options: AutomationSheetOptions,
): WrittenAutomationSheet {
  const csv = renderAutomationSheet(run, options);
  mkdirSync(options.outputDir, { recursive: true });
  const file = path.join(options.outputDir, options.fileName ?? `automation-${run.runId}.csv`);
  writeFileSync(file, csv, 'utf8');

  const landed = verifyAutomationSheet(file, run);
  return { file, rowsWritten: appTeamRows(run).length, csv: landed };
}

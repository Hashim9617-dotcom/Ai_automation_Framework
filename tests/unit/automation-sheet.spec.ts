import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import {
  DEFAULT_AUTOMATION_SHEET_COLUMNS,
  NOT_ANALYSED,
  renderAutomationSheet,
  resolveRunIdentity,
  verifyAutomationSheet,
  writeAutomationSheet,
  type AuthoredRunResult,
  type RowResult,
  type RunIdentity,
} from '@aitp/shared';

/**
 * The generated automation sheet — a CSV of app-team rows for a QA to paste.
 *
 * Two rules it exists under, and both are checked here rather than trusted:
 * the QA's workbook is never touched (E5 covers the execution path; this writes
 * one new file into a caller-named directory under `artifacts/`), and a
 * `trace.zip` path never travels, because a trace is a replayable session
 * carrying live tokens while a screenshot is a picture of one screen.
 */

const IDENTITY: RunIdentity = { runBy: 'Hashim Khan', runBySource: 'git' };

const row = (over: Partial<RowResult> & Pick<RowResult, 'rowId' | 'status' | 'owner'>): RowResult =>
  ({
    scenarioId: over.rowId.split(' / ')[0],
    testCaseId: 'TC_1',
    sheetRow: 3,
    title: 'a row',
    detail: 'd',
    ...over,
  }) as RowResult;

const runOf = (results: RowResult[]): AuthoredRunResult => ({
  runId: 'run_fixture01',
  results,
  tally: {
    rowsRead: results.length,
    passed: 0,
    failed: 0,
    refused: 0,
    held: 0,
    unreadable: 0,
    staleCapture: 0,
    givenNotReached: 0,
  },
});

let dir: string;
test.beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'aitp-sheet-'));
});
test.afterEach(() => rmSync(dir, { recursive: true, force: true }));

test.describe('the automation sheet carries app-team rows only @unit', () => {
  test('C1: qa-owned, environment-owned and passing rows do NOT appear', () => {
    // wrong: every row is written, and the app team is handed a list to triage
    // that contains a row the QA must rewrite, a row held by policy and a row
    // that passed — the merged-list failure the report's sections avoid.
    const run = runOf([
      row({ rowId: 'APP_1 / TC_1', status: 'failed', owner: 'app-team' }),
      row({ rowId: 'QA_1 / TC_1', status: 'refused', owner: 'qa' }),
      row({ rowId: 'ENV_1 / TC_1', status: 'held', owner: 'environment' }),
      row({ rowId: 'OK_1 / TC_1', status: 'passed', owner: 'none' }),
    ]);

    const written = writeAutomationSheet(run, { outputDir: dir, identity: IDENTITY });
    const csv = readFileSync(written.file, 'utf8');

    expect(written.rowsWritten).toBe(1);
    expect(csv).toContain('APP_1 / TC_1');
    for (const absent of ['QA_1 / TC_1', 'ENV_1 / TC_1', 'OK_1 / TC_1']) {
      expect(csv, `${absent} should not be in a sheet for the app team`).not.toContain(absent);
    }
  });

  test('C2: a trace path is NOT in the file, even when the row carries one', () => {
    // wrong: the trace path rides along into a sheet a QA mails outside the
    // team, and a replayable session with live tokens leaves with it. The
    // screenshot is the one piece of evidence that may travel.
    const trace = path.join('artifacts', 'test-results', 'row', 'trace.zip');
    const shot = path.join('artifacts', 'test-results', 'row', 'shot.png');
    const run = runOf([
      row({
        rowId: 'APP_1 / TC_1',
        status: 'failed',
        owner: 'app-team',
        evidence: { failingClause: 'button "Save" enabled=true', screenshot: shot, trace },
      }),
    ]);

    const written = writeAutomationSheet(run, { outputDir: dir, identity: IDENTITY });
    const csv = readFileSync(written.file, 'utf8');

    // Discriminating: the screenshot IS there, so "not found" cannot be because
    // no evidence was written at all.
    expect(csv).toContain(shot);
    expect(csv).not.toContain(trace);
    expect(csv).not.toContain('trace.zip');
  });

  test('C3: a cell a spreadsheet would EXECUTE is prefixed, and a normal cell is not', () => {
    // wrong: `observed` is text the application under test put on a page, so
    // `=HYPERLINK("…")` pasted into an issue sheet becomes a live link the QA
    // did not write. Stripping it would be worse — they need to see what was
    // actually on the screen.
    const run = runOf([
      row({
        rowId: 'F_1 / TC_1',
        status: 'failed',
        owner: 'app-team',
        observed: ['=HYPERLINK("x")'],
      }),
      row({ rowId: 'F_2 / TC_1', status: 'failed', owner: 'app-team', observed: ['+1'] }),
      row({ rowId: 'F_3 / TC_1', status: 'failed', owner: 'app-team', observed: ['@SUM(A1)'] }),
      row({
        rowId: 'F_4 / TC_1',
        status: 'failed',
        owner: 'app-team',
        observed: ['heading "Done" present=true'],
      }),
    ]);

    const csv = renderAutomationSheet(run, { outputDir: dir, identity: IDENTITY });

    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain(`'+1`);
    expect(csv).toContain(`'@SUM(A1)`);
    // The other half: an ordinary cell is untouched — a guard that prefixed
    // everything would pass every check above and corrupt every real value.
    expect(csv).toContain('heading ""Done"" present=true');
    expect(csv).not.toContain(`'heading`);
  });

  test('C5: every data row carries an interpretation', () => {
    // wrong: the cell is blank, and a blank where a reader expects a sentence
    // reads as "nothing to say" rather than "not analysed yet" — the same
    // distinction as a failed search reported as an empty result.
    const run = runOf([
      row({ rowId: 'A_1 / TC_1', status: 'failed', owner: 'app-team' }),
      row({ rowId: 'A_2 / TC_1', status: 'stale-capture', owner: 'app-team' }),
    ]);

    const written = writeAutomationSheet(run, { outputDir: dir, identity: IDENTITY });
    const lines = readFileSync(written.file, 'utf8').trim().split('\r\n');

    expect(lines).toHaveLength(3);
    for (const line of lines.slice(1)) expect(line).toContain(NOT_ANALYSED);
  });

  test('the writer asserts its own effect: a tampered file is refused', () => {
    // wrong: the check reads the in-memory string, so it checks the renderer
    // against itself and a file that never landed — or landed wrong — still
    // reports success. E6's rule, applied to this writer.
    const run = runOf([row({ rowId: 'A_1 / TC_1', status: 'failed', owner: 'app-team' })]);
    const written = writeAutomationSheet(run, { outputDir: dir, identity: IDENTITY });

    // A row deleted behind the writer's back — the failure no renderer can cause.
    const lines = readFileSync(written.file, 'utf8').split('\r\n');
    writeFileSync(written.file, [lines[0], ''].join('\r\n'), 'utf8');
    expect(() => verifyAutomationSheet(written.file, run)).toThrow(/does not match the run/);
  });

  test('the file opens as UTF-8: a missing BOM is refused', () => {
    // wrong: Excel reads it in the local code page, and the one place a QA
    // copies a name or a page string from is where it arrives mojibaked.
    const run = runOf([row({ rowId: 'A_1 / TC_1', status: 'failed', owner: 'app-team' })]);
    const written = writeAutomationSheet(run, { outputDir: dir, identity: IDENTITY });

    const noBom = readFileSync(written.file, 'utf8').replace(/^\uFEFF/, '');
    writeFileSync(written.file, noBom, 'utf8');
    expect(() => verifyAutomationSheet(written.file, run)).toThrow(/BOM is missing/);
  });

  test('the column order is DATA: a caller-supplied list is honoured', () => {
    // wrong: the order is baked into the writer, so a QA whose issue sheet has
    // different headings needs a code change — and the one real sheet measured
    // has 22 columns in a fixed order with two duplicate headings.
    const run = runOf([row({ rowId: 'A_1 / TC_1', status: 'failed', owner: 'app-team' })]);
    const csv = renderAutomationSheet(run, {
      outputDir: dir,
      identity: IDENTITY,
      columns: [{ heading: 'Only', cell: (r) => r.rowId }, DEFAULT_AUTOMATION_SHEET_COLUMNS[0]!],
    });

    // The BOM leads the first line, which is the point of it — stripped here so
    // this assertion is about the ORDER rather than about the encoding.
    const lines = csv.replace(/^\uFEFF/, '').split('\r\n');
    expect(lines[0]).toBe('Only,Reported By');
    expect(lines[1]).toBe('A_1 / TC_1,automation-Hashim Khan');
  });
});

test.describe('who ran it, and where that answer came from @unit', () => {
  test('C4: a git name wins, and the source says so', () => {
    // wrong: the OS login is used even when a person has told git their name —
    // the sheet then says `automation-xtpl` for someone called Hashim Khan.
    expect(
      resolveRunIdentity({
        gitUserName: () => 'Hashim Khan',
        osUserName: () => 'xtpl',
      }),
    ).toEqual({ runBy: 'Hashim Khan', runBySource: 'git' });
  });

  test('C4: with no git name, the OS username is used and labelled `os`', () => {
    // wrong: it reports `git` regardless, so a reader cannot tell a chosen name
    // from a login — and both look identical in a spreadsheet cell.
    expect(resolveRunIdentity({ gitUserName: () => undefined, osUserName: () => 'xtpl' })).toEqual({
      runBy: 'xtpl',
      runBySource: 'os',
    });
    // Whitespace-only is not a name.
    expect(resolveRunIdentity({ gitUserName: () => '   ', osUserName: () => 'xtpl' })).toEqual({
      runBy: 'xtpl',
      runBySource: 'os',
    });
  });

  test('C4: a service account becomes `ci`, never a person’s name', () => {
    // wrong: the sheet says `automation-root` or `automation-SYSTEM`, which
    // reads like a person. Measured: the Jenkins agent runs the Playwright
    // image with `-u root:root`, and the Jenkinsfile exposes no BUILD_USER_ID,
    // so the human who clicked Build is genuinely not available to the run.
    for (const account of ['SYSTEM', 'root', 'Administrator', 'jenkins', 'runner']) {
      expect(
        resolveRunIdentity({ gitUserName: () => undefined, osUserName: () => account }),
        `${account} should not be reported as a person`,
      ).toEqual({ runBy: 'ci', runBySource: 'ci' });
    }
  });

  test('C4: a git name configured ON CI is still trusted', () => {
    // wrong: `ci` overrides everything, so a pipeline that deliberately set a
    // name has it thrown away — the fallback outranking the explicit answer.
    expect(
      resolveRunIdentity({ gitUserName: () => 'nightly-regression', osUserName: () => 'root' }),
    ).toEqual({ runBy: 'nightly-regression', runBySource: 'git' });
  });

  test('C4: with nothing available at all, it is `ci` rather than empty', () => {
    // wrong: `runBy` is '' and the sheet says `automation-`, which tells a
    // reader nothing and looks like a bug in the writer rather than an absence.
    expect(
      resolveRunIdentity({ gitUserName: () => undefined, osUserName: () => undefined }),
    ).toEqual({ runBy: 'ci', runBySource: 'ci' });
  });
});

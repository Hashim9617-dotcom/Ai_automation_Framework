import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import {
  FINAL_TEST_CASES_SCHEMA,
  findRepoRoot,
  loadSheetLayout,
  readFinalTestCases,
  readSheetGrid,
  type SheetLayout,
} from '@aitp/shared';
import { buildXlsx } from '../support/xlsx-fixture';

/**
 * THE SHEET LAYOUT IS PER-APPLICATION DATA, and the DMS copy is WELDED to the code.
 *
 * ## What moved and why it had to
 *
 * `FINAL_TEST_CASES_SCHEMA` is one QA team's 22-column workbook hard-coded in
 * `final-test-cases.ts`, with `'SOC DMS'` pinned at column 19. The reader validates
 * the header row and THROWS on any difference — correctly, because column positions
 * come from the layout and not from the header, so reading another sheet anyway
 * returns rows populated from the wrong columns. That is the bug that mis-attributed
 * ten of 22 columns for three weeks.
 *
 * Right failure, total blocker: Ecom's sheet is 16 columns with different headers and
 * no `Preconditions` or `Type` column at all. So the layout became
 * `config/apps/<slug>/sheet-layout.json` and the refusal keeps its full force —
 * against the right layout.
 *
 * ## The weld, which is the whole reason this file exists
 *
 * The DMS layout is now in TWO places: the constant in code (sixty-odd fixtures and
 * two callers read it, and `@aitp/shared` is compiled into the API's own `dist` where
 * reading a config file at module load would break every fresh clone) and
 * `config/apps/dms/sheet-layout.json`. That is the duplication §AE warns about, and a
 * drift here changes a VERDICT rather than a message.
 *
 * L1 asserts they are equal, field by field. With it, the duplication is a
 * performance decision; without it, it is a bug waiting for someone to edit one copy.
 * The JSON was EMITTED from the constant rather than typed, so the two cannot differ
 * by a transcription error today — and L1 is what keeps that true tomorrow.
 */

const ROOT = findRepoRoot();
const layoutPath = (slug: string): string =>
  path.join(ROOT, 'config', 'apps', slug, 'sheet-layout.json');

/** A layout file in a temp directory. Typed, not cast (§AD). */
function layoutFile(body: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'aitp-layout-'));
  const file = path.join(dir, 'sheet-layout.json');
  writeFileSync(file, JSON.stringify(body), 'utf8');
  return file;
}

/** A minimal valid layout, so each test varies ONE thing (§"discriminating fixture"). */
const VALID = {
  sheetName: 'Test Cases',
  columns: {
    module: 1,
    feature: 2,
    scenarioId: 3,
    testCaseId: 4,
    scenarioName: 5,
    objective: 6,
    testType: 7,
    priority: 8,
    given: 9,
    when: 10,
    and: 11,
    then: 12,
    testData: 13,
  },
  expectedHeaders: [
    'Module',
    'Feature',
    'Scenario ID',
    'Test Case ID',
    'Scenario Name',
    'Test Objective',
    'Test Type',
    'Priority',
    'Given',
    'When',
    'And',
    'Then',
    'Test Data',
    'Actual Result',
  ],
  outputColumns: [14],
  clauseSeparator: '&',
} satisfies Record<string, unknown>;

/** One row of a sheet matching a layout, with each named column filled. */
function rowFor(layout: SheetLayout, overrides: Record<number, string> = {}): string[] {
  const row = new Array<string>(layout.expectedHeaders.length).fill('');
  const c = layout.columns;
  row[c.scenarioId - 1] = 'SCN-001';
  row[c.testCaseId - 1] = 'TC-001';
  row[c.module - 1] = 'Departments';
  row[c.given - 1] = 'I am on the Departments page';
  row[c.when - 1] = 'the page finishes loading';
  row[c.then - 1] = 'the grid should show six columns';
  for (const [column, value] of Object.entries(overrides)) row[Number(column) - 1] = value;
  return row;
}

test.describe('every application brings its own sheet layout @unit', () => {
  test('L1: config/apps/dms/sheet-layout.json IS FINAL_TEST_CASES_SCHEMA', () => {
    // wrong: any difference at all, and the CLI and the sixty-odd in-code fixtures
    // are reading one QA sheet with two different layouts — the reader takes every
    // value from a position, so a single changed number returns rows populated from
    // the wrong columns and they look exactly like data. This is the whole reason
    // the duplication is tolerable; without this assertion it is a latent bug.
    const fromDisk = loadSheetLayout(layoutPath('dms'));
    expect(fromDisk.sheetName).toBe(FINAL_TEST_CASES_SCHEMA.sheetName);
    expect(fromDisk.columns).toEqual(FINAL_TEST_CASES_SCHEMA.columns);
    expect(fromDisk.expectedHeaders).toEqual([...FINAL_TEST_CASES_SCHEMA.expectedHeaders]);
    expect(fromDisk.outputColumns).toEqual([...FINAL_TEST_CASES_SCHEMA.outputColumns]);
    expect(fromDisk.clauseSeparator).toBe(FINAL_TEST_CASES_SCHEMA.clauseSeparator);
  });

  test('L2: the Ecom layout is the 16 columns measured from its workbook', () => {
    // wrong: a 22-column layout copied from DMS and edited, which is what "add the
    // second application" invites. Then every Ecom row would be read from a DMS
    // position — `Given` from column 10 where Ecom's column 10 is `When` — and the
    // rows would come back populated and wrong. The header row is pinned because it
    // is what makes a position mean anything.
    const ecom = loadSheetLayout(layoutPath('ecom'));
    expect(ecom.sheetName).toBe('Test Cases');
    expect(ecom.expectedHeaders).toHaveLength(16);
    expect(ecom.expectedHeaders[0]).toBe('Module');
    expect(ecom.expectedHeaders.at(-1)).toBe('Issue No.');
    // `Given` is column 9 here and column 10 in DMS. That one difference is the
    // reason this file exists, so it is asserted rather than assumed.
    expect(ecom.columns.given).toBe(9);
    expect(FINAL_TEST_CASES_SCHEMA.columns.given).toBe(10);
    // ABSENT, not blank: Ecom's sheet has no such columns at all.
    expect(ecom.columns.preconditions).toBeUndefined();
    expect(ecom.columns.type).toBeUndefined();
  });

  test('L3: an absent column is reported as ABSENT, not as an empty cell', () => {
    // wrong: `preconditions: ''` with nothing to distinguish it from a DMS row whose
    // Preconditions cell a QA left blank — merging "the sheet said nothing here"
    // with "the sheet has no such field". Only the first is a gap somebody could
    // fill, and a worklist that cannot tell them apart sends a QA to fill in a
    // column that does not exist.
    const ecom = loadSheetLayout(layoutPath('ecom'));
    const grid = readSheetGrid(
      buildXlsx([{ name: ecom.sheetName, rows: [[...ecom.expectedHeaders], rowFor(ecom)] }]),
      ecom.sheetName,
    );
    const read = readFinalTestCases(grid, ecom);
    expect(read.absentColumns).toEqual(['preconditions', 'type']);
    expect(read.rows[0]!.preconditions).toBe('');

    // THE OTHER HALF (§W): DMS declares both columns, so for it the list is EMPTY
    // even though the fixture leaves those cells blank. A `absentColumns` that
    // simply reported every empty cell would pass the assertion above and fail here.
    const dmsGrid = readSheetGrid(
      buildXlsx([
        {
          name: FINAL_TEST_CASES_SCHEMA.sheetName,
          rows: [
            [...FINAL_TEST_CASES_SCHEMA.expectedHeaders],
            rowFor(FINAL_TEST_CASES_SCHEMA as SheetLayout),
          ],
        },
      ]),
      FINAL_TEST_CASES_SCHEMA.sheetName,
    );
    expect(readFinalTestCases(dmsGrid).absentColumns).toEqual([]);
  });

  test('L4: each layout REFUSES the other application’s sheet', () => {
    // wrong: a read that succeeded. This is the property the whole batch rests on,
    // and it has to hold in BOTH directions — the DMS layout refusing an Ecom sheet
    // is what stopped the wrong read before this change existed, and the Ecom layout
    // refusing a DMS sheet is what stops the new config being a way around it. A
    // reader that only checked one direction would let a DMS workbook be read with
    // Ecom's 16 columns and silently drop six.
    const ecom = loadSheetLayout(layoutPath('ecom'));

    const ecomBook = readSheetGrid(
      buildXlsx([{ name: ecom.sheetName, rows: [[...ecom.expectedHeaders], rowFor(ecom)] }]),
      ecom.sheetName,
    );
    // The DMS layout is for a differently NAMED tab, so it refuses on the name — and
    // names the mismatch rather than reading the first sheet it finds.
    expect(() => readFinalTestCases(ecomBook, FINAL_TEST_CASES_SCHEMA)).toThrow(
      /this layout is for "Final Test cases"/,
    );

    // The reverse, on the HEADER row rather than the name: an Ecom-named tab whose
    // headers are DMS's. This is the case that used to be read to completion.
    const dmsHeadersUnderEcomName = readSheetGrid(
      buildXlsx([
        {
          name: ecom.sheetName,
          rows: [
            [...FINAL_TEST_CASES_SCHEMA.expectedHeaders],
            rowFor(FINAL_TEST_CASES_SCHEMA as SheetLayout),
          ],
        },
      ]),
      ecom.sheetName,
    );
    expect(() => readFinalTestCases(dmsHeadersUnderEcomName, ecom)).toThrow(
      /is not the "Test Cases" layout/,
    );
  });

  test('L5: two fields on ONE column are refused', () => {
    // wrong: the read succeeds and returns the same cell under two names. No header
    // check can see this — each position's header is correct — and nothing
    // downstream can either, because both fields are populated with plausible text.
    // It is the exact shape of fault a layout file invites, so it is refused at load.
    const file = layoutFile({ ...VALID, columns: { ...VALID.columns, objective: 5 } });
    expect(() => loadSheetLayout(file)).toThrow(/both point at column 5/);
  });

  test('L6: a column past the headers, or at a blank header, is refused', () => {
    // wrong: a column number past the header row is never validated, so every value
    // read from it is unchecked — the one thing the header gate exists to prevent.
    // A column at a BLANK header is the subtler half: it is within range, so a bounds
    // check alone accepts it, and a position means something only because a header
    // names it.
    const past = layoutFile({ ...VALID, columns: { ...VALID.columns, testData: 99 } });
    expect(() => loadSheetLayout(past)).toThrow(/describes only 14 column\(s\)/);

    const blank = layoutFile({
      ...VALID,
      expectedHeaders: [...VALID.expectedHeaders, '  '],
      columns: { ...VALID.columns, testData: 15 },
    });
    expect(() => loadSheetLayout(blank)).toThrow(/whose expected header is blank/);
  });

  test('L7: a column declared as BOTH input and output is refused', () => {
    // wrong: the run reads a column a human writes AFTER a previous run, turning
    // their stale pass/fail into this run's expectation — rule 4 with extra steps,
    // and worse than a generated case because an old human verdict looks
    // authoritative. The two lists are written by different hands in a config file,
    // so nothing but this check connects them.
    const file = layoutFile({ ...VALID, outputColumns: [13, 14] });
    expect(() => loadSheetLayout(file)).toThrow(/both as an output column and as columns.testData/);
  });

  test('L8: a field nothing reads is refused rather than ignored', () => {
    // wrong: silence. A QA writes `"precondition": 9` — singular, a plausible typo —
    // the loader accepts it, the reader never looks at it, and the column is simply
    // never read. An unread field is a mistake that changes nothing, which is worse
    // than an error because nothing will ever point at it.
    const file = layoutFile({ ...VALID, columns: { ...VALID.columns, precondition: 9 } });
    expect(() => loadSheetLayout(file)).toThrow(/nothing reads/);
  });

  test('L9: a required field left out is refused by name', () => {
    // wrong: `columns.then` undefined reads `row[-1]`, which is `undefined`, which
    // `clean()` makes `''` — so every row arrives with no Then clause and the sheet
    // reads as 987 rows with nothing to assert. A silent empty column is the worst
    // outcome available here, because the rows still look like rows.
    const { then: _removed, ...withoutThen } = VALID.columns;
    const file = layoutFile({ ...VALID, columns: withoutThen });
    expect(() => loadSheetLayout(file)).toThrow(/columns.then is required/);
  });

  test('L10: a missing layout file says there is NO DEFAULT, and why', () => {
    // wrong: falling back to the DMS layout, which is the one thing that must not
    // happen — it is how an Ecom sheet would be read with DMS positions. The
    // `readFinalTestCases` parameter does default, and that default is safe only
    // because the header gate refuses anything it does not describe; the LOADER has
    // no such protection and so has no default at all.
    const dir = mkdtempSync(path.join(tmpdir(), 'aitp-layout-missing-'));
    expect(() => loadSheetLayout(path.join(dir, 'sheet-layout.json'))).toThrow(
      /there is no sheet layout at/,
    );
    expect(() => loadSheetLayout(path.join(dir, 'sheet-layout.json'))).toThrow(
      /there is no default/,
    );
  });
});

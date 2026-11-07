import { readFileSync } from 'node:fs';

/**
 * WHICH COLUMN HOLDS WHAT, per application — `config/apps/<slug>/sheet-layout.json`.
 *
 * ## Why this had to stop being a constant
 *
 * `FINAL_TEST_CASES_SCHEMA` is one QA team's 22-column workbook, hard-coded in
 * `final-test-cases.ts`, with `'SOC DMS'` pinned at column 19. The reader validates
 * the header row and THROWS on any difference — correctly, because column positions
 * come from the layout and not from the header, so reading another sheet anyway
 * returns rows populated from the wrong columns. That is the bug that mis-attributed
 * ten of 22 columns for three weeks.
 *
 * The consequence is that a second application's workbook is a HARD REFUSAL rather
 * than a wrong read, which is the right failure and still a total blocker: Ecom's
 * sheet has 16 columns, different headers, and no `Preconditions` or `Type` column at
 * all. So the layout becomes per-application data, beside the module map, and the
 * refusal keeps its full force — against the right layout.
 *
 * ## An ABSENT column is not an empty one
 *
 * `preconditions` and `type` are optional here, and that is the three-states rule
 * applied to a column: DMS has a `Preconditions` column that may be blank on a given
 * row; Ecom has no such column at all and writes the precondition inside the `Given`
 * cell as `(Precondition: …)`. Collapsing those to `''` would tell a reader "the
 * sheet said nothing" when the truth is "the sheet has no such field", and only one
 * of those is a gap in the DATA. `absentColumns` on the read result is what carries
 * the difference, rather than a caller inferring it from an empty string.
 *
 * ## The DMS layout exists twice, and that is welded rather than trusted
 *
 * `FINAL_TEST_CASES_SCHEMA` stays in code: sixty-odd tests and two callers read it,
 * and `@aitp/shared` is compiled into the API's own `dist`, where reading a config
 * file at module load would be a new failure mode on every fresh clone. So the DMS
 * layout is in both places — which is exactly the duplication §AE warns about, and a
 * drift here would change a VERDICT, not a message.
 *
 * `tests/unit/sheet-layout.spec.ts` therefore asserts the two are EQUAL, field by
 * field. The weld is the point: with it, the duplication is a performance decision;
 * without it, it is a bug waiting for somebody to edit one copy.
 */

/** 1-based column numbers, matching the spreadsheet's own numbering. */
export interface SheetLayoutColumns {
  module: number;
  feature: number;
  scenarioId: number;
  testCaseId: number;
  scenarioName: number;
  objective: number;
  testType: number;
  priority: number;
  given: number;
  when: number;
  and: number;
  then: number;
  testData: number;
  /** Absent in a sheet that has no such column — NOT the same as a blank cell. */
  preconditions?: number;
  /** Absent in a sheet that has no such column. */
  type?: number;
}

export interface SheetLayout {
  /** The tab this layout describes. A different tab is refused, never guessed. */
  readonly sheetName: string;
  readonly columns: Readonly<SheetLayoutColumns>;
  /**
   * Expected header text at each position, compared after `trim()`.
   *
   * `readonly`, so the in-code DMS constant — declared `as const` — satisfies this
   * type directly rather than through a copy. A reader has no business mutating a
   * layout, and a mutable array here would have forced `[...layout.expectedHeaders]`
   * at every call site, which is where a stale copy comes from.
   */
  readonly expectedHeaders: readonly string[];
  /** Columns written by a human AFTER a run — never read as input. */
  readonly outputColumns: readonly number[];
  /** What splits two clauses inside one `And` cell. */
  readonly clauseSeparator: string;
}

/** The fields a layout must name. Derived from the type by listing it once. */
export const REQUIRED_LAYOUT_COLUMNS = [
  'module',
  'feature',
  'scenarioId',
  'testCaseId',
  'scenarioName',
  'objective',
  'testType',
  'priority',
  'given',
  'when',
  'and',
  'then',
  'testData',
] as const satisfies ReadonlyArray<keyof SheetLayoutColumns>;

/** The fields a layout MAY name, because not every sheet has them. */
export const OPTIONAL_LAYOUT_COLUMNS = ['preconditions', 'type'] as const satisfies ReadonlyArray<
  keyof SheetLayoutColumns
>;

function fail(where: string, message: string): never {
  throw new Error(`${where}: ${message}`);
}

/**
 * Validates a layout's SHAPE and its INTERNAL CONSISTENCY.
 *
 * The consistency checks are the ones worth having, because a layout is a set of
 * numbers and every shape-valid set of numbers reads a sheet successfully — just the
 * wrong cells. Two fields on one column, or a column pointing past the header row, or
 * at a header that is blank, are all errors that would otherwise surface as
 * plausible-looking data under the wrong name.
 */
export function validateSheetLayout(raw: unknown, where: string): SheetLayout {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail(where, 'must be a JSON object with sheetName, columns, expectedHeaders.');
  }
  const value = raw as Record<string, unknown>;

  const sheetName = value.sheetName;
  if (typeof sheetName !== 'string' || sheetName.trim() === '') {
    fail(where, '"sheetName" is required — the tab this layout describes, spelled exactly.');
  }

  const expectedHeaders = value.expectedHeaders;
  if (!Array.isArray(expectedHeaders) || expectedHeaders.length === 0) {
    fail(
      where,
      '"expectedHeaders" must be a non-empty array of the header row\'s text, left to right. ' +
        'It is what makes a column POSITION mean anything.',
    );
  }
  for (const [index, header] of expectedHeaders.entries()) {
    if (typeof header !== 'string') {
      fail(where, `expectedHeaders[${index}] must be a string, found ${typeof header}.`);
    }
  }
  const headers = expectedHeaders as string[];

  const rawColumns = value.columns;
  if (!rawColumns || typeof rawColumns !== 'object' || Array.isArray(rawColumns)) {
    fail(where, '"columns" must be an object of field -> 1-based column number.');
  }
  const given = rawColumns as Record<string, unknown>;

  const columns: Record<string, number> = {};
  const checkColumn = (field: string, required: boolean): void => {
    const column = given[field];
    if (column === undefined) {
      if (required) {
        fail(
          where,
          `columns.${field} is required. Every field the reader reads must be given a ` +
            'column; a missing one would silently read column 0.',
        );
      }
      return;
    }
    if (typeof column !== 'number' || !Number.isInteger(column) || column < 1) {
      fail(
        where,
        `columns.${field} must be a 1-based integer column number, found ${String(column)}.`,
      );
    }
    if (column > headers.length) {
      fail(
        where,
        `columns.${field} is ${column} but expectedHeaders describes only ${headers.length} ` +
          'column(s). A column past the header row cannot be validated, so every value read ' +
          'from it would be unchecked.',
      );
    }
    // A column whose header is blank is certainly wrong: the header row is what
    // gives the position its meaning, and nothing names an unnamed column.
    if ((headers[column - 1] ?? '').trim() === '') {
      fail(
        where,
        `columns.${field} is ${column}, whose expected header is blank. A position means ` +
          'something only because a header names it.',
      );
    }
    columns[field] = column;
  };

  for (const field of REQUIRED_LAYOUT_COLUMNS) checkColumn(field, true);
  for (const field of OPTIONAL_LAYOUT_COLUMNS) checkColumn(field, false);

  // Any field this layout names that the reader does not read is a silent no-op —
  // the QA writes `columns.preconditon: 9` and nothing uses it.
  const known = new Set<string>([...REQUIRED_LAYOUT_COLUMNS, ...OPTIONAL_LAYOUT_COLUMNS]);
  const unknown = Object.keys(given)
    .filter((field) => !field.startsWith('//') && !known.has(field))
    .sort();
  if (unknown.length > 0) {
    fail(
      where,
      `columns names ${unknown.length} field(s) nothing reads: ` +
        `${unknown.map((f) => `"${f}"`).join(', ')}. Known fields are ` +
        `${[...known].sort().join(', ')}. An unread field is a typo that changes nothing, ` +
        'which is worse than an error.',
    );
  }

  // TWO FIELDS ON ONE COLUMN is the fault this check exists for: it reads
  // successfully and returns the same value under two names, and no header check can
  // see it because each position's header is correct.
  const byColumn = new Map<number, string[]>();
  for (const [field, column] of Object.entries(columns)) {
    byColumn.set(column, [...(byColumn.get(column) ?? []), field]);
  }
  for (const [column, fields] of byColumn) {
    if (fields.length > 1) {
      fail(
        where,
        `columns ${fields.sort().join(' and ')} both point at column ${column} ` +
          `("${headers[column - 1]}"). One value cannot be two fields.`,
      );
    }
  }

  const outputColumns = value.outputColumns ?? [];
  if (!Array.isArray(outputColumns)) {
    fail(where, '"outputColumns" must be an array of 1-based column numbers, or absent.');
  }
  for (const column of outputColumns) {
    if (typeof column !== 'number' || !Number.isInteger(column) || column < 1) {
      fail(where, `outputColumns contains ${String(column)}, which is not a column number.`);
    }
    if (column > headers.length) {
      fail(where, `outputColumns contains ${column}, past the ${headers.length} headers declared.`);
    }
    // An OUTPUT column that is also an INPUT column would make a human's last
    // pass/fail verdict an expectation — rule 4 with extra steps, and worse than a
    // generated case because an old verdict looks authoritative.
    const clash = Object.entries(columns).find(([, input]) => input === column);
    if (clash) {
      fail(
        where,
        `column ${column} ("${headers[column - 1]}") is declared both as an output column and ` +
          `as columns.${clash[0]}. Reading a column a human writes AFTER a run would turn ` +
          "their stale verdict into this run's expectation.",
      );
    }
  }

  const clauseSeparator = value.clauseSeparator ?? '&';
  if (typeof clauseSeparator !== 'string' || clauseSeparator === '') {
    fail(where, '"clauseSeparator" must be a non-empty string, or absent to default to "&".');
  }

  return {
    sheetName,
    columns: columns as unknown as SheetLayoutColumns,
    expectedHeaders: headers,
    outputColumns: outputColumns as number[],
    clauseSeparator,
  };
}

/** Reads and validates one application's layout file. */
export function loadSheetLayout(file: string): SheetLayout {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `there is no sheet layout at ${file}. Every application's workbook has its own column ` +
          "order, and reading one sheet with another's layout returns rows populated from the " +
          "wrong columns — so there is no default. Copy the header row of the sheet's tab into " +
          '"expectedHeaders", left to right, and give each field its 1-based column.',
      );
    }
    throw new Error(`${file} could not be read as JSON: ${(error as Error).message}`);
  }
  return validateSheetLayout(raw, file);
}

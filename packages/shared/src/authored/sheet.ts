/**
 * Reading QA-authored test cases out of a sheet.
 *
 * Door B of `docs/phase-2-authored-cases.md`. Everything here is built to that
 * document, which was written first — including the part that matters most:
 *
 * > **The schema is PROVISIONAL.** It must come from the QA team's actual
 * > sheet, not from what seems reasonable. Inventing a plausible schema and
 * > building to it is reading the implementation, one level up.
 *
 * So the column mapping is CONFIGURATION. No column name appears in this
 * file's logic; every one of them arrives in a `SheetSchema`. Changing the
 * mapping is a config edit, never a reader change.
 */

/** How a sheet's columns map onto the fields a case needs. All PROVISIONAL. */
export interface SheetSchema {
  columns: {
    /** The QA's own row identifier. Synthesised if absent — and reported. */
    id?: string;
    title: string;
    steps: string;
    expected?: string;
    priority?: string;
    tags?: string;
  };
  /** How a multi-step cell splits. Provisionally one step per line. */
  stepSeparator?: RegExp;
  /**
   * PROVISIONAL: one row is one test case.
   *
   * The other common shape is one row per step, grouped by a case id. That is
   * a different value here, not a rewrite — the seam exists so the assumption
   * can be wrong cheaply.
   */
  grouping?: 'row-is-case';
}

/** A sheet as this repo assumes it, until a real one says otherwise. */
export const PROVISIONAL_SCHEMA: SheetSchema = {
  columns: { id: 'id', title: 'title', steps: 'steps', expected: 'expected' },
  stepSeparator: /\r?\n/,
  grouping: 'row-is-case',
};

export interface AuthoredCase {
  /** The identity that survives the whole pipeline. See the doc, §4. */
  rowId: string;
  /** True when the sheet had no id column and this one was made up. */
  rowIdSynthesised: boolean;
  /** 1-based position in the sheet, for a human looking at their own file. */
  sheetRow: number;
  title: string;
  /** One sentence per step, unparsed — the resolver's input, not the reader's. */
  steps: string[];
  expected: string[];
  extras: Record<string, string>;
}

/** A row that could not be read at all. Never an absence — see the doc, §4. */
export interface UnreadableRow {
  rowId: string;
  rowIdSynthesised: boolean;
  sheetRow: number;
  /** Machine-readable, so a report can route it without parsing prose. */
  why: 'missing-required-column' | 'empty-required-cell';
  reason: string;
}

export interface SheetReadResult {
  cases: AuthoredCase[];
  unreadable: UnreadableRow[];
  /** Every column the sheet actually had, for a human debugging a mapping. */
  headers: string[];
  /** True when no id column was found, so every rowId is synthesised. */
  idsSynthesised: boolean;
}

/**
 * Parses CSV text into rows of cells.
 *
 * Hand-written rather than taken from a dependency, because CSV is the
 * provisional format and a dependency decision belongs with the real one. It
 * handles the parts that matter for untrusted input (doc §6): quoted fields, so
 * a cell containing a comma cannot inject a column; doubled quotes; and
 * embedded newlines inside quotes, so a multi-step cell survives.
 *
 * A naive `split(',')` is not merely a parsing bug — it is a way for a QA's
 * comma to become a column boundary, which silently shifts every later value in
 * the row into the wrong field.
 */
export function parseCsv(text: string): string[][] {
  // A BOM is what Excel writes by default, and it would otherwise become part
  // of the first header name — turning a correct mapping into a missing column.
  const input = text.replace(/^\ufeff/, '');

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]!;

    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\r') {
      // Swallowed; the \n that follows ends the row.
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }

  // A final line with no trailing newline still counts.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

const norm = (value: string): string => value.trim().toLowerCase();

/**
 * Reads a sheet into authored cases.
 *
 * **Every input row leaves in exactly one bucket** — a case or an unreadable
 * row. That is asserted rather than intended, because a pipeline that quietly
 * drops a row is the scan script that reported `scan clean` while reading zero
 * files, wearing different clothes (CLAUDE.md).
 */
export function readSheet(csv: string, schema: SheetSchema = PROVISIONAL_SCHEMA): SheetReadResult {
  const rows = parseCsv(csv);
  if (rows.length === 0) {
    return { cases: [], unreadable: [], headers: [], idsSynthesised: true };
  }

  const headers = rows[0]!.map((header) => header.trim());
  const index = new Map(headers.map((header, i) => [norm(header), i]));
  const columnOf = (name: string | undefined): number | undefined =>
    name === undefined ? undefined : index.get(norm(name));

  const idColumn = columnOf(schema.columns.id);
  const titleColumn = columnOf(schema.columns.title);
  const stepsColumn = columnOf(schema.columns.steps);
  const expectedColumn = columnOf(schema.columns.expected);
  const separator = schema.stepSeparator ?? /\r?\n/;

  const idsSynthesised = idColumn === undefined;

  const cases: AuthoredCase[] = [];
  const unreadable: UnreadableRow[] = [];

  const body = rows.slice(1);
  for (const [offset, cells] of body.entries()) {
    const sheetRow = offset + 2; // 1-based, and the header is row 1.
    const cell = (column: number | undefined): string =>
      column === undefined ? '' : (cells[column] ?? '').trim();

    // A synthesised id is not traceable back to anything the QA recognises, so
    // the fact that it was synthesised travels WITH the row rather than being
    // reported once and forgotten (doc §0).
    const rawId = cell(idColumn);
    const rowId = rawId || `row-${sheetRow}`;
    const rowIdSynthesised = rawId.length === 0;

    // A row of empty cells is sheet padding, not a test case, and is not
    // reported as a failure — but it IS accounted for, below.
    if (cells.every((value) => value.trim().length === 0)) continue;

    if (titleColumn === undefined || stepsColumn === undefined) {
      const missing = [
        titleColumn === undefined ? schema.columns.title : undefined,
        stepsColumn === undefined ? schema.columns.steps : undefined,
      ].filter((name): name is string => name !== undefined);
      unreadable.push({
        rowId,
        rowIdSynthesised,
        sheetRow,
        why: 'missing-required-column',
        reason: `the sheet has no column named ${missing.map((m) => `"${m}"`).join(' or ')} — found: ${headers.map((h) => `"${h}"`).join(', ')}`,
      });
      continue;
    }

    const title = cell(titleColumn);
    const stepText = cell(stepsColumn);
    if (title.length === 0 || stepText.length === 0) {
      unreadable.push({
        rowId,
        rowIdSynthesised,
        sheetRow,
        why: 'empty-required-cell',
        reason: `row ${sheetRow} has an empty ${title.length === 0 ? schema.columns.title : schema.columns.steps} cell`,
      });
      continue;
    }

    const extras: Record<string, string> = {};
    for (const [i, header] of headers.entries()) {
      if (i === idColumn || i === titleColumn || i === stepsColumn || i === expectedColumn) continue;
      const value = (cells[i] ?? '').trim();
      if (value) extras[header] = value;
    }

    cases.push({
      rowId,
      rowIdSynthesised,
      sheetRow,
      title,
      steps: stepText.split(separator).map((s) => s.trim()).filter(Boolean),
      expected: cell(expectedColumn).split(separator).map((s) => s.trim()).filter(Boolean),
      extras,
    });
  }

  // Asserts its own effect: every non-blank body row is accounted for exactly
  // once. A row that vanished would otherwise be invisible — there is nothing
  // to notice, which is precisely why it needs an assertion rather than care.
  const nonBlank = body.filter((cells) => cells.some((v) => v.trim().length > 0)).length;
  const accounted = cases.length + unreadable.length;
  if (accounted !== nonBlank) {
    throw new Error(
      `readSheet dropped rows: ${nonBlank} non-blank row(s) in, ${accounted} accounted for. ` +
        'Every row must leave as a case or as an unreadable row — never as an absence.',
    );
  }

  const ids = [...cases.map((c) => c.rowId), ...unreadable.map((u) => u.rowId)];
  if (new Set(ids).size !== ids.length) {
    const seen = new Set<string>();
    const duplicates = [...new Set(ids.filter((id) => seen.size === seen.add(id).size))];
    throw new Error(
      `readSheet found duplicate row id(s): ${duplicates.map((d) => `"${d}"`).join(', ')}. ` +
        'Row ids are the identity the whole pipeline is traced by, so they must be unique.',
    );
  }

  return { cases, unreadable, headers, idsSynthesised };
}

import { deflateRawSync, crc32 } from 'node:zlib';
import { test, expect } from '@playwright/test';
import {
  FINAL_TEST_CASES_SCHEMA,
  classifyClause,
  listSheets,
  readFinalTestCases,
  readSheetGrid,
  redactCredentialText,
  type SheetGrid,
} from '@aitp/shared';

/**
 * Expectations derive from `docs/phase-2-authored-cases.md` §0/§0a/§2a, which
 * were rewritten from MEASUREMENTS of the real workbook before this code
 * existed (rule 4).
 *
 * The workbook itself can never be committed — it carries live credentials —
 * so these fixtures reproduce its measured SHAPE: the duplicate "Issue No."
 * header, the trailing space in "SOC DMS ", TC_001 recurring across scenarios,
 * an `And` cell joined with "&", and a Test Data cell in the real
 * `mail id : … Password : …` form.
 *
 *   F1  identity is the composite key
 *   F2  columns map by position; header names are not unique
 *   F3  the And column mixes actions and assertions
 *   F4  output columns are never read as input
 *   F5  credentials are redacted; prose is not
 *   F6  no row silently vanishes
 *   F7  the sheet name is required
 */

const HEADER: string[] = [...FINAL_TEST_CASES_SCHEMA.expectedHeaders];
// The real file's column 19, trailing space and all.
HEADER[18] = 'SOC DMS ';

const row = (over: Partial<Record<number, string>> = {}): string[] => {
  const cells = Array.from({ length: 22 }, () => '');
  cells[0] = 'Login';
  cells[1] = 'Sign in';
  cells[2] = 'SI_001';
  cells[3] = 'TC_001';
  cells[4] = 'Valid login';
  cells[9] = 'User is on the login page';
  cells[10] = 'User enters valid credentials';
  cells[11] = 'User clicks the sign-in button';
  cells[12] = 'The dashboard should be visible';
  for (const [k, v] of Object.entries(over)) cells[Number(k)] = v ?? '';
  return cells;
};

const gridOf = (...rows: string[][]): SheetGrid => ({
  name: FINAL_TEST_CASES_SCHEMA.sheetName,
  rows: [HEADER, ...rows],
});

test.describe('identity is the composite key (F1) @unit', () => {
  test('F1: TC_001 recurring across scenarios yields distinct rows', () => {
    // Measured on the real sheet: 470 rows, only 56 distinct Test Case IDs.
    // Keying on the Test Case ID alone collapses 470 rows into 56.
    const result = readFinalTestCases(
      gridOf(row({ 2: 'SI_001', 3: 'TC_001' }), row({ 2: 'SI_002', 3: 'TC_001' })),
    );
    expect(result.rows.map((r) => r.rowId)).toEqual(['SI_001 / TC_001', 'SI_002 / TC_001']);
    expect(new Set(result.rows.map((r) => r.rowId)).size).toBe(2);
  });

  test('F1: the row id is the pair, never the Test Case ID alone', () => {
    const result = readFinalTestCases(gridOf(row({ 2: 'SI_009', 3: 'TC_042' })));
    expect(result.rows[0]!.rowId).toBe('SI_009 / TC_042');
    expect(result.rows[0]!.rowId).not.toBe('TC_042');
  });

  test('F1: a duplicate composite refuses the WHOLE sheet', () => {
    // Not "skip the duplicate": a duplicate identity means no row's result can
    // be traced, so a partly-read sheet would be a report nobody can rely on.
    expect(() =>
      readFinalTestCases(gridOf(row({ 2: 'SI_001', 3: 'TC_001' }), row({ 2: 'SI_001', 3: 'TC_001' }))),
    ).toThrow(/duplicate row identity/i);
  });
});

test.describe('columns map by POSITION (F2, F4) @unit', () => {
  test('F2: the duplicated "Issue No." header does not confuse the mapping', () => {
    // Measured: "Issue No." is at BOTH column 17 and column 20. A name-keyed
    // reader takes whichever it finds first.
    expect(HEADER[16]).toBe('Issue No.');
    expect(HEADER[19]).toBe('Issue No.');
    const result = readFinalTestCases(gridOf(row()));
    expect(result.headerWarnings).toEqual([]);
    expect(result.rows[0]!.scenarioName).toBe('Valid login');
  });

  test('F2: the trailing space in "SOC DMS " is tolerated, not a warning', () => {
    // Validated against the TRIMMED name, so real-world padding is fine.
    expect(HEADER[18]).toBe('SOC DMS ');
    expect(readFinalTestCases(gridOf(row())).headerWarnings).toEqual([]);
  });

  test('F2: a changed layout IS reported', () => {
    // The discriminating half: header validation must be able to fail, or it
    // is decoration.
    const moved: string[] = [...HEADER];
    moved[3] = 'Something Else';
    const result = readFinalTestCases({ name: FINAL_TEST_CASES_SCHEMA.sheetName, rows: [moved, row()] });
    expect(result.headerWarnings.length).toBe(1);
    expect(result.headerWarnings[0]).toContain('column 4');
  });

  test('F4: output columns are never read as input', () => {
    // Actual Result / Status / Issue No. / SOC DMS are the LAST MANUAL RUN's
    // outcome. Reading Status as an expectation would inherit a stale human
    // verdict as a requirement — rule 4 with extra steps.
    const withOutputs = row({ 14: 'FAILED yesterday', 15: 'Fail', 16: 'BUG-1', 18: 'yes', 20: 'x' });
    const result = readFinalTestCases(gridOf(withOutputs));
    const serialised = JSON.stringify(result.rows[0]);
    for (const value of ['FAILED yesterday', 'Fail', 'BUG-1']) {
      expect(serialised).not.toContain(value);
    }
    // Discriminating: an INPUT column from the same row did come through.
    expect(serialised).toContain('Valid login');
  });
});

test.describe('the And column mixes actions and assertions (F3) @unit', () => {
  test('F3: an And cell joined with "&" is split and each half classified', () => {
    // The real shape, measured on 37 of 470 rows.
    const result = readFinalTestCases(
      gridOf(row({ 11: 'User clicks on the sign-in button. & verify the user successful login' })),
    );
    const and = result.rows[0]!.clauses.filter((c) => c.source === 'and');
    expect(and.length).toBe(2);
    expect(and[0]!.kind).toBe('action');
    expect(and[1]!.kind).toBe('assert');
  });

  test('F3: a half with no classifying verb is UNCLASSIFIED, not guessed', () => {
    // The real fragment: "And correct password" continues the previous clause
    // and is neither. Guessing turns an assertion into a click or the reverse,
    // and neither fails loudly.
    const result = readFinalTestCases(
      gridOf(row({ 11: 'And correct password & Click on the sign-in button.' })),
    );
    const and = result.rows[0]!.clauses.filter((c) => c.source === 'and');
    expect(and[0]!.kind).toBe('unclassified');
    expect(and[0]!.why).toContain('human');
    expect(and[1]!.kind).toBe('action');
  });

  test('F3: the column decides the kind everywhere except And', () => {
    const result = readFinalTestCases(gridOf(row()));
    const bySource = Object.fromEntries(
      result.rows[0]!.clauses.map((c) => [c.source, c.kind]),
    );
    expect(bySource.given).toBe('action');
    expect(bySource.when).toBe('action');
    expect(bySource.then).toBe('assert');
  });

  test('F3: classification refuses what it does not recognise', () => {
    expect(classifyClause('verify the total shows 28').kind).toBe('assert');
    expect(classifyClause('click the Approve button').kind).toBe('action');
    expect(classifyClause('the dashboard should be visible').kind).toBe('assert');
    expect(classifyClause('somehow the thing happens').kind).toBe('unclassified');
  });
});

test.describe('credentials are redacted, prose is not (F5) @unit', () => {
  test('F5: a credential-bearing Test Data cell is redacted', () => {
    // The real shape, values invented: `mail id : … Password : …`
    const result = readFinalTestCases(
      gridOf(row({ 13: 'mail id : admin@dms.example  Password : hunter2secret' })),
    );
    const data = result.rows[0]!.testData;
    expect(data).not.toContain('hunter2secret');
    expect(data).not.toContain('admin@dms.example');
    // The KEY survives, so a reviewer knows a credential was there.
    expect(data).toContain('Password');
    expect(data).toContain('***redacted***');
  });

  test('F5: prose mentioning "password" SURVIVES intact', () => {
    // The discriminating half, and the one that matters most. Measured: 51
    // Given/When/And/Then clauses mention password or email as ordinary prose.
    // A redactor that redacted the word would destroy 51 real assertions — and
    // a redactor that redacts everything looks identical to one that works
    // unless a test asserts the prose survives.
    const clause = 'A validation message should come that the user Password is not correct.';
    const result = readFinalTestCases(gridOf(row({ 12: clause })));
    expect(result.rows[0]!.clauses.find((c) => c.source === 'then')!.text).toBe(clause);
  });

  test('F5: the redactor is the shared one, and it redacts something', () => {
    // Guards against a redactor that returns its input: both halves in one
    // place, because "redacts nothing" and "works" look identical otherwise.
    expect(redactCredentialText('Password : abc123')).toContain('***redacted***');
    expect(redactCredentialText('the user Password is not correct')).toBe(
      'the user Password is not correct',
    );
  });
});

test.describe('no row silently vanishes (F6, F7) @unit', () => {
  test('F6: a stray-cell row is reported as detritus', () => {
    // Row 15 of the real sheet, exactly: one cell, Test Type = "Functional",
    // sitting between two scenario blocks. Nothing of value is lost.
    const orphan = Array.from({ length: 22 }, () => '');
    orphan[6] = 'Functional';
    const result = readFinalTestCases(gridOf(row(), orphan));
    expect(result.rows.length).toBe(1);
    expect(result.unreadable.length).toBe(1);
    expect(result.unreadable[0]!.why).toBe('stray-cells');
    expect(result.unreadable[0]!.sheetRow).toBe(3);
    expect(result.unreadable[0]!.orphanedContent).toBeUndefined();
  });

  test('F6: a row with real clauses but no identity says a case is being LOST', () => {
    // Row 208 of the real sheet: Feature = "3628", plus a real And and a real
    // Then. A test case is being dropped, and the QA can recover it — but only
    // if the report distinguishes it from the stray cell above. Reporting both
    // as one count is what leaves it undiagnosed.
    const orphan = Array.from({ length: 22 }, () => '');
    orphan[1] = '3628';
    orphan[11] = 'Page refresh (F5, hard refresh)';
    orphan[12] = 'The workspace should be restored';
    const result = readFinalTestCases(gridOf(row(), orphan));

    expect(result.unreadable[0]!.why).toBe('content-without-identity');
    expect(result.unreadable[0]!.reason).toContain('being lost');
    expect(result.unreadable[0]!.orphanedContent).toEqual([
      'And: Page refresh (F5, hard refresh)',
      'Then: The workspace should be restored',
    ]);
  });

  test('F6: a fully blank row is counted as padding, not reported as a failure', () => {
    const blank = Array.from({ length: 22 }, () => '');
    const result = readFinalTestCases(gridOf(row(), blank));
    expect(result.blankRows).toBe(1);
    expect(result.unreadable).toEqual([]);
  });

  test('F6: every data row is accounted for in exactly one bucket', () => {
    const orphan = Array.from({ length: 22 }, () => '');
    orphan[6] = 'Functional';
    const blank = Array.from({ length: 22 }, () => '');
    const grid = gridOf(row({ 2: 'SI_1' }), orphan, blank, row({ 2: 'SI_2' }));
    const result = readFinalTestCases(grid);
    expect(result.rows.length + result.unreadable.length + result.blankRows).toBe(
      grid.rows.length - 1,
    );
  });

  test('F7: the wrong sheet is refused, naming both', () => {
    // The workbook holds five competing test-case sheets with different
    // layouts. Reading one with another's reader produces garbage that looks
    // like data.
    expect(() => readFinalTestCases({ name: 'Automation test cases', rows: [HEADER, row()] })).toThrow(
      /Automation test cases/,
    );
  });
});

/**
 * The xlsx parser is the new input path, so it gets real coverage rather than
 * being trusted because it worked once by hand.
 *
 * The real workbook can never be committed, so this builds a valid `.xlsx` in
 * memory. Store-mode (uncompressed) entries keep the writer short while still
 * exercising the central-directory walk, the shared-string table and the cell
 * parser — the parts that would actually break.
 */
function buildXlsx(sheets: Array<{ name: string; rows: string[][] }>): Buffer {
  const shared: string[] = [];
  const indexOf = (value: string): number => {
    const found = shared.indexOf(value);
    if (found >= 0) return found;
    shared.push(value);
    return shared.length - 1;
  };
  const esc = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const colName = (n: number): string => {
    let out = '';
    let x = n;
    while (x > 0) {
      const r = (x - 1) % 26;
      out = String.fromCharCode(65 + r) + out;
      x = Math.floor((x - 1) / 26);
    }
    return out;
  };

  const sheetXml = sheets.map((sheet) => {
    const rows = sheet.rows
      .map((cells, r) => {
        const cs = cells
          .map((value, c) =>
            value === ''
              ? ''
              : `<c r="${colName(c + 1)}${r + 1}" t="s"><v>${indexOf(value)}</v></c>`,
          )
          .join('');
        return `<row r="${r + 1}">${cs}</row>`;
      })
      .join('');
    return `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
  });

  const files: Array<[string, string]> = [
    ['[Content_Types].xml', '<?xml version="1.0"?><Types/>'],
    ['_rels/.rels', '<?xml version="1.0"?><Relationships/>'],
    [
      'xl/workbook.xml',
      `<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
        .map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
        .join('')}</sheets></workbook>`,
    ],
    [
      'xl/_rels/workbook.xml.rels',
      `<?xml version="1.0"?><Relationships>${sheets
        .map((_s, i) => `<Relationship Id="rId${i + 1}" Target="worksheets/sheet${i + 1}.xml"/>`)
        .join('')}</Relationships>`,
    ],
    ...sheets.map((_s, i): [string, string] => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml[i]!]),
    [
      'xl/sharedStrings.xml',
      `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${shared
        .map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`)
        .join('')}</sst>`,
    ],
  ];

  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of files) {
    const data = Buffer.from(content, 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const sum = crc32(data);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x0403_4b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 8); // stored
    lh.writeUInt32LE(sum, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    local.push(lh, nameBuf, data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x0201_4b50, 0);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt32LE(sum, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x0605_4b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  void deflateRawSync; // stored entries only; kept so the import documents the choice
  return Buffer.concat([Buffer.concat(local), centralBuf, eocd]);
}

test.describe('the xlsx reader (X1) @unit', () => {
  const book = () =>
    buildXlsx([
      { name: 'SOC DMS Issue sheet', rows: [['not', 'the', 'right', 'sheet']] },
      {
        name: FINAL_TEST_CASES_SCHEMA.sheetName,
        rows: [HEADER, row({ 2: 'SI_007', 3: 'TC_001' })],
      },
    ]);

  test('X1: sheets are listed in workbook order', () => {
    expect(listSheets(book()).map((s) => s.name)).toEqual([
      'SOC DMS Issue sheet',
      'Final Test cases',
    ]);
  });

  test('X1: the named sheet is read, not the first one', () => {
    // Discriminating: the first sheet has a completely different layout, so
    // defaulting to it would be visible here.
    const grid = readSheetGrid(book(), FINAL_TEST_CASES_SCHEMA.sheetName);
    expect(grid.name).toBe(FINAL_TEST_CASES_SCHEMA.sheetName);
    expect(grid.rows[1]![2]).toBe('SI_007');
  });

  test('X1: an unknown sheet name is refused, naming what was available', () => {
    expect(() => readSheetGrid(book(), 'Nope')).toThrow(/Available: .*Final Test cases/s);
  });

  test('X1: cells are returned UNTRIMMED, so padding stays visible', () => {
    // A reader that normalises cannot be used to check normalisation — this is
    // how the trailing space in "SOC DMS " was nearly missed.
    const grid = readSheetGrid(book(), FINAL_TEST_CASES_SCHEMA.sheetName);
    expect(grid.rows[0]![18]).toBe('SOC DMS ');
  });

  /**
   * Shapes MEASURED across all thirteen sheets of the real workbook, then
   * reproduced as BUILT fixtures.
   *
   * The parser was hand-rolled and validated against one sheet of one
   * workbook, which is the same bounded claim as "it works on one app": exact
   * about what was looked at, silent about everything else. So all thirteen
   * were parsed as adversarial input — 2 to 22 columns, 10 to 530 rows, up to
   * 11 distinct row widths in one sheet, fully empty rows, and three sheets
   * where most rows have a blank first column. **Zero crashed.**
   *
   * The workbook can never be committed, so the shapes it revealed are encoded
   * here as constructed fixtures rather than sampled ones.
   */
  test('X1: survives the shapes found across all thirteen real sheets', () => {
    const odd = buildXlsx([
      {
        name: 'ragged',
        rows: [
          ['a', 'b', 'c'],
          ['only one'],
          [],
          ['', '', 'trailing only'],
          ['x', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', 'col22'],
        ],
      },
      { name: 'two columns', rows: [['k', 'v'], ['a', '1']] },
    ]);

    const grid = readSheetGrid(odd, 'ragged');
    expect(grid.rows.length).toBe(5);
    expect(grid.rows[1]).toEqual(['only one']);
    // A fully empty row survives as an empty row, not as a dropped one.
    expect(grid.rows[2]).toEqual([]);
    // Leading gaps are filled, so column position is never shifted.
    expect(grid.rows[3]![2]).toBe('trailing only');
    expect(grid.rows[4]![21]).toBe('col22');
    // And a 2-column sheet in the same workbook is unaffected.
    expect(readSheetGrid(odd, 'two columns').rows[1]).toEqual(['a', '1']);
  });

  test('X1: a blank-first-column sheet parses without being interpreted', () => {
    // Measured: "Automation test cases" has 89 of 95 rows with a blank first
    // column — blank there means SAME AS ABOVE. The parser must hand that
    // through untouched; interpreting it is a different reader's job, and a
    // reader that served both layouts would get one of them subtly wrong.
    const book = buildXlsx([
      { name: 'inherit-shaped', rows: [['Module', 'Case'], ['Login', 'first'], ['', 'second']] },
    ]);
    const grid = readSheetGrid(book, 'inherit-shaped');
    expect(grid.rows[2]![0]).toBe('');
    expect(grid.rows[2]![1]).toBe('second');
  });

  test('X1: a workbook read end to end produces the same rows as the grid path', () => {
    const result = readFinalTestCases(readSheetGrid(book(), FINAL_TEST_CASES_SCHEMA.sheetName));
    expect(result.rows.length).toBe(1);
    expect(result.rows[0]!.rowId).toBe('SI_007 / TC_001');
  });
});

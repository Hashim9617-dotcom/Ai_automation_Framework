import { test, expect } from '@playwright/test';
import { listSheets, readSheetGrid } from '@aitp/shared';
import { bookWithManifest } from '../support/xlsx-fixture';

/**
 * ATTRIBUTE ORDER IN XML IS NOT SIGNIFICANT, and this reader behaved as though
 * it were.
 *
 * ## The finding, measured 2026-11-07 on two real workbooks
 *
 * `listSheets` resolved a sheet's data part with
 * `/Id="([^"]+)"[^>]*Target="([^"]+)"/` — `Id` first, mandatory. Both Ecom
 * workbooks write every `<Relationship>` as `Type=… Target=… Id=…`, so the target
 * map came back EMPTY, every sheet's part was `undefined`, every sheet was silently
 * skipped, and the reader refused a valid 16-column, 987-row workbook with
 * `workbook declares no sheets`. An independent OOXML parse of the same file — its
 * own zip walk, its own XML reader, placing every value by cell reference — read
 * 15,808 cells from it, and after the fix the repo reader matched that parse on all
 * 15,808 with zero mismatches.
 *
 * ## Why 720 unit tests could not see it
 *
 * §AK, with a new mechanism. The reader had two subjects: the DMS workbook and
 * `tests/support/xlsx-fixture.ts`. Excel writes `Id` first; the fixture builder
 * writes `Id="rId1" Target="…"` and `name="…" r:id="…"` — the exact two orders the
 * two regexes demanded. A writer and a reader with one author share one assumption,
 * and no amount of coverage over that writer can contradict it.
 *
 * That is why `bookWithManifest` exists and why these fixtures are hand-written
 * manifests: the input had to be one no writer in this repo would choose.
 *
 * ## Both halves, per §W
 *
 * A fix that made Target-first work while quietly breaking Id-first would pass a
 * suite containing only the failing case. Each order gets its own test, and the
 * two are deliberately identical except for the order.
 */

const SHEET_XML =
  '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Module</t></is></c>' +
  '<c r="B1" t="inlineStr"><is><t>Feature</t></is></c></row>' +
  '<row r="2"><c r="A2" t="inlineStr"><is><t>Departments</t></is></c>' +
  '<c r="B2" t="inlineStr"><is><t>Department</t></is></c></row></sheetData></worksheet>';

const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** One worksheet part, always at the same path, so only the manifest varies. */
const PARTS = [{ path: 'xl/worksheets/sheet1.xml', xml: SHEET_XML }];

const workbookXml = (sheetTag: string): string =>
  `<?xml version="1.0"?><workbook xmlns:r="${R_NS}"><sheets>${sheetTag}</sheets></workbook>`;

const relsXml = (relationshipTag: string): string =>
  `<?xml version="1.0"?><Relationships>${relationshipTag}</Relationships>`;

const ID_FIRST = '<Relationship Id="rId1" Target="worksheets/sheet1.xml"/>';
/** EXACTLY the shape both real Ecom workbooks write, leading slash included. */
const TARGET_FIRST = `<Relationship Type="${R_NS}/worksheet" Target="/xl/worksheets/sheet1.xml" Id="rId1"/>`;

const NAME_FIRST = '<sheet name="Test Cases" sheetId="1" r:id="rId1"/>';
const RID_FIRST = '<sheet r:id="rId1" sheetId="1" name="Test Cases"/>';

test.describe('a workbook manifest is read by attribute NAME, not by order @unit', () => {
  test('a Relationship writing Target before Id resolves its sheet (the real Ecom shape)', () => {
    // wrong: with the old `Id="…"[^>]*Target="…"` pattern the target map is empty,
    // this sheet's part is undefined, it is skipped, and listSheets throws
    // "workbook declares no sheets" — which is what happened to a valid 987-row file.
    const book = bookWithManifest({
      workbookXml: workbookXml(NAME_FIRST),
      relsXml: relsXml(TARGET_FIRST),
      parts: PARTS,
    });
    expect(listSheets(book)).toEqual([{ name: 'Test Cases', part: 'xl/worksheets/sheet1.xml' }]);
  });

  test('a Relationship writing Id before Target still resolves (the order Excel uses)', () => {
    // wrong: a fix that only handled the new order — matching `Target` then `Id` —
    // would leave this one unresolved and this assertion would see
    // "workbook declares no sheets" for the shape every existing fixture uses.
    const book = bookWithManifest({
      workbookXml: workbookXml(NAME_FIRST),
      relsXml: relsXml(ID_FIRST),
      parts: PARTS,
    });
    expect(listSheets(book)).toEqual([{ name: 'Test Cases', part: 'xl/worksheets/sheet1.xml' }]);
  });

  test('a sheet writing r:id before name resolves — the same bug, the other tag', () => {
    // wrong: the old `<sheet\b[^>]*?name="…"[^>]*?r:id="…"[^>]*\/>` requires name
    // FIRST, so this tag matches nothing at all, `sheets` is empty and listSheets
    // throws. Nothing in the repo produced this order, which is exactly why the
    // class was fixed rather than the one site that failed.
    const book = bookWithManifest({
      workbookXml: workbookXml(RID_FIRST),
      relsXml: relsXml(TARGET_FIRST),
      parts: PARTS,
    });
    expect(listSheets(book).map((s) => s.name)).toEqual(['Test Cases']);
  });

  test('a sheet written with a separate closing tag resolves', () => {
    // wrong: the old pattern ended in `\/>`, so `<sheet …></sheet>` — legal XML and
    // equivalent to the self-closing form — matched nothing and the sheet vanished.
    const book = bookWithManifest({
      workbookXml: workbookXml('<sheet name="Test Cases" sheetId="1" r:id="rId1"></sheet>'),
      relsXml: relsXml(TARGET_FIRST),
      parts: PARTS,
    });
    expect(listSheets(book).map((s) => s.name)).toEqual(['Test Cases']);
  });

  test('a sheet whose relationship id is missing is REFUSED BY NAME, not dropped', () => {
    // wrong: the old `if (part) sheets.push(…)` dropped it, so `sheets` was empty
    // and the caller's own message then read "sheet X is not in this workbook.
    // Available: " — a confident WRONG diagnosis about a sheet that IS declared and
    // whose data part could not be located. Two states where there are three.
    const book = bookWithManifest({
      workbookXml: workbookXml('<sheet name="Test Cases" sheetId="1" r:id="rId9"/>'),
      relsXml: relsXml(TARGET_FIRST),
      parts: PARTS,
    });
    expect(() => listSheets(book)).toThrow(/"Test Cases" \(rId9\)/);
    expect(() => listSheets(book)).toThrow(/NOT the same as the sheet being absent/);
  });

  test('sheetId is not mistaken for the relationship id', () => {
    // wrong: a looser rule — "any attribute whose name ends in id" — would read
    // sheetId="7" as the relationship id, find no rId for "7", and refuse a
    // perfectly good workbook. This fixture gives sheetId a value that is NOT a
    // relationship key, so the two cannot be confused silently.
    const book = bookWithManifest({
      workbookXml: workbookXml('<sheet name="Test Cases" sheetId="7" r:id="rId1"/>'),
      relsXml: relsXml(TARGET_FIRST),
      parts: PARTS,
    });
    expect(listSheets(book).map((s) => s.name)).toEqual(['Test Cases']);
  });

  test('the grid reads through, so the fix is about data and not only about names', () => {
    // wrong: resolving the manifest while mis-locating the part would give a sheet
    // list that looks right and a grid that is empty — so the end-to-end read is
    // asserted, on the inline-string cell form both Ecom workbooks actually use
    // (they carry NO shared-string table at all).
    const book = bookWithManifest({
      workbookXml: workbookXml(RID_FIRST),
      relsXml: relsXml(TARGET_FIRST),
      parts: PARTS,
    });
    const grid = readSheetGrid(book, 'Test Cases');
    expect(grid.rows[0]).toEqual(['Module', 'Feature']);
    expect(grid.rows[1]).toEqual(['Departments', 'Department']);
  });
});

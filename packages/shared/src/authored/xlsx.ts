import { inflateRawSync } from 'node:zlib';

/**
 * A minimal `.xlsx` reader: enough of the format to read one worksheet as a
 * grid of strings, and nothing more.
 *
 * **Why not a dependency.** This repo has no spreadsheet library, the subset of
 * the format needed here is small and fully specified, and there is a real
 * 477-row workbook to test against. `node:zlib` is built in. If this proves
 * fragile on the next sheet a vetted dependency is the fallback — and because
 * parsing sits behind the same grid seam as the CSV adapter, that is a swap
 * rather than a rewrite (docs/phase-2-authored-cases.md §0b).
 *
 * **Cells are returned UNTRIMMED.** That is deliberate and it is not a
 * detail: verifying this workbook nearly missed that column 19 is `"SOC DMS "`
 * with a trailing space, because the first parser trimmed as it read and so
 * hid the very thing being checked. A reader that normalises cannot be used to
 * check normalisation, so trimming is the caller's decision.
 */

export interface SheetGrid {
  name: string;
  /** Row-major, 0-based, untrimmed. Ragged: short rows are short. */
  rows: string[][];
}

/**
 * Reads the entries of a ZIP archive.
 *
 * Walks the central directory rather than scanning for local headers, because
 * a local header's sizes may be zero with the real values in a trailing data
 * descriptor — scanning would read garbage on exactly the files that use it.
 */
function readZip(buffer: Buffer): Map<string, Buffer> {
  // End of central directory: signature 0x06054b50, within the last 64KB.
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65_557); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x0605_4b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip archive: no end-of-central-directory record');

  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);

  const entries = new Map<string, Buffer>();
  for (let n = 0; n < count; n += 1) {
    if (buffer.readUInt32LE(offset) !== 0x0201_4b50) {
      throw new Error(`corrupt zip: central directory entry ${n} has a bad signature`);
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);

    // The local header's own name/extra lengths are authoritative for locating
    // the payload; the central directory's extra field is a different field.
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(start, start + compressedSize);

    entries.set(name, method === 0 ? Buffer.from(raw) : inflateRawSync(raw));
    offset += 46 + nameLength + extraLength + commentLength;
  }

  if (entries.size === 0) throw new Error('zip archive contained no entries');
  return entries;
}

const XML_ENTITIES: Record<string, string> = {
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
  '&amp;': '&',
};

/** `&amp;` must be decoded LAST or `&amp;lt;` becomes `<` instead of `&lt;`. */
function decodeXml(text: string): string {
  return text
    .replace(/&(lt|gt|quot|apos|#39);/g, (m) => XML_ENTITIES[m]!)
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&');
}

/** `AB12` -> 28. 1-based, matching the spreadsheet's own column numbering. */
function columnOf(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? 'A';
  let n = 0;
  for (const char of letters) n = n * 26 + (char.charCodeAt(0) - 64);
  return n;
}

export interface WorkbookSheet {
  name: string;
  part: string;
}

/** Every sheet in the workbook, in workbook order. */
export function listSheets(file: Buffer): WorkbookSheet[] {
  const zip = readZip(file);
  const relsXml = zip.get('xl/_rels/workbook.xml.rels')?.toString('utf8');
  const workbookXml = zip.get('xl/workbook.xml')?.toString('utf8');
  if (!relsXml || !workbookXml) throw new Error('not an xlsx workbook: xl/workbook.xml is missing');

  const targets = new Map<string, string>();
  for (const m of relsXml.matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
    targets.set(m[1]!, `xl/${m[2]!.replace(/^\/?xl\//, '')}`);
  }

  const sheets: WorkbookSheet[] = [];
  for (const m of workbookXml.matchAll(
    /<sheet\b[^>]*?name="([^"]*)"[^>]*?r:id="([^"]+)"[^>]*\/>/g,
  )) {
    const part = targets.get(m[2]!);
    if (part) sheets.push({ name: decodeXml(m[1]!), part });
  }
  if (sheets.length === 0) throw new Error('workbook declares no sheets');
  return sheets;
}

/**
 * Reads one named sheet as a grid.
 *
 * The sheet name is REQUIRED and an unknown one throws, naming what was
 * available. This workbook holds five competing test-case sheets with different
 * layouts; defaulting to the first would silently read a different one and every
 * row would be garbage that looks like data (§0).
 */
export function readSheetGrid(file: Buffer, sheetName: string): SheetGrid {
  const sheets = listSheets(file);
  const sheet = sheets.find((candidate) => candidate.name === sheetName);
  if (!sheet) {
    throw new Error(
      `sheet "${sheetName}" is not in this workbook. Available: ` +
        sheets.map((s) => `"${s.name}"`).join(', '),
    );
  }

  const zip = readZip(file);
  const shared: string[] = [];
  const sharedXml = zip.get('xl/sharedStrings.xml')?.toString('utf8');
  if (sharedXml) {
    for (const si of sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      const text = [...si[1]!.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]!).join('');
      shared.push(decodeXml(text));
    }
  }

  const sheetXml = zip.get(sheet.part)?.toString('utf8');
  if (!sheetXml) throw new Error(`workbook part ${sheet.part} is missing`);

  /**
   * A SELF-CLOSING CELL IS A DIFFERENT FORM, and conflating the two shifted a
   * sheet's columns for three weeks.
   *
   * The old pattern was `<c[^>]*\br="(…)"([^>]*)>([\s\S]*?)<\/c>` — it required a
   * closing tag. A styled blank cell has none: Excel writes `<c r="I2" s="12"/>`.
   * That still MATCHED, because `([^>]*)` happily consumed ` s="12"/` and the `>`
   * then closed the tag, after which `([\s\S]*?)<\/c>` ran forward to the NEXT
   * cell's closing tag and took its body as this reference's value. Two faults from
   * one regex, both measured on the real DMS workbook on 2026-10-05:
   *
   * - the swallowed cell's `t="s"` was never seen (the attributes came from the
   *   EMPTY cell), so the value fell to the numeric branch and the raw
   *   SHARED-STRING INDEX was returned as text. Six rows reported a Module of
   *   "1572" / "27" / "1456", each the index of a later cell in the same row;
   * - the real cell was consumed, so every column after it shifted. Ten of 22
   *   columns were attributed to the wrong header — `Given` carried
   *   `Preconditions`, `Test Data` carried `Actual Result`, and `Type` read empty
   *   while the sheet had 372 filled.
   *
   * So the two forms are alternatives, `\/>` FIRST so a self-closing tag can never
   * fall through to the open-tag branch, and the attributes are read from the
   * cell's OWN start tag only.
   */
  const byRow = new Map<number, string[]>();
  for (const rowMatch of sheetXml.matchAll(
    /<row\b[^>]*\br="(\d+)"[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g,
  )) {
    const rowNumber = Number(rowMatch[1]!);
    const cells: string[] = [];
    /**
     * FAIL CLOSED on anything that would make a POSITION a guess.
     *
     * Every value is placed by its own `r` reference and never by sequence, so a
     * cell without one cannot be placed at all — and a duplicate or backwards
     * reference means the file is not what this parser assumes. Silently taking the
     * last writer, or sorting, would be the same class of mistake as the regex
     * above: a plausible value under the wrong header.
     */
    const seen = new Set<number>();
    let previousColumn = 0;
    for (const c of (rowMatch[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attributes = c[1]!;
      const inner = c[2];
      const reference = /\br="([A-Z]+\d+)"/.exec(attributes)?.[1];
      if (!reference) {
        throw new Error(
          `sheet "${sheet.name}", row ${rowNumber}: a cell has no "r" reference, so its column ` +
            'cannot be known. Every value is placed by its reference and never by order.',
        );
      }
      const column = columnOf(reference);
      if (seen.has(column)) {
        throw new Error(
          `sheet "${sheet.name}", row ${rowNumber}: cell "${reference}" appears twice. ` +
            'Refusing rather than choosing one — a duplicate means this file is not shaped the ' +
            'way this parser assumes, and the wrong choice is invisible afterwards.',
        );
      }
      if (column <= previousColumn) {
        throw new Error(
          `sheet "${sheet.name}", row ${rowNumber}: cell "${reference}" goes backwards ` +
            `(column ${column} after column ${previousColumn}). Refusing rather than sorting: ` +
            'a row whose cells are out of order is not a row this parser has ever seen, and ' +
            'guessing would place values under the wrong headers.',
        );
      }
      seen.add(column);
      previousColumn = column;

      const type = /\bt="([^"]+)"/.exec(attributes)?.[1];
      const body = inner ?? '';
      let value: string;
      if (type === 's') {
        const index = /<v>(\d+)<\/v>/.exec(body)?.[1];
        // No `<v>` means no string, NOT shared string zero and never the index.
        value = index === undefined ? '' : (shared[Number(index)] ?? '');
      } else if (type === 'inlineStr') {
        // `<is><t>text</t></is>` — the text is inline, in `<t>` runs.
        value = decodeXml(
          [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]!).join(''),
        );
      } else if (type === 'str') {
        // A FORMULA'S STRING RESULT, and it lives in `<v>` — NOT in `<t>`.
        //
        // Both types went through the `<t>` branch, so every `t="str"` cell read
        // empty. Caught by P4 rather than by review: the two names look like
        // variants of one thing and store their text in different elements.
        value = decodeXml(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '');
      } else if (type === 'b') {
        // Excel stores a boolean as 1/0 and SHOWS it as TRUE/FALSE, which is what a
        // QA reading the sheet sees and therefore what a clause would quote.
        const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        value = raw === undefined ? '' : raw.trim() === '1' ? 'TRUE' : 'FALSE';
      } else {
        // A number stays its own text. Dates are numbers here too; nothing in this
        // pipeline reads one, and inventing a format would be a guess in a cell.
        value = decodeXml(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '');
      }
      cells[column - 1] = value;
    }
    byRow.set(rowNumber, cells);
  }

  const highest = Math.max(0, ...byRow.keys());
  const rows: string[][] = [];
  for (let r = 1; r <= highest; r += 1) {
    const cells = byRow.get(r) ?? [];
    // A sparse row leaves holes where cells were absent; normalise to ''.
    rows.push(Array.from({ length: cells.length }, (_, i) => cells[i] ?? ''));
  }
  return { name: sheet.name, rows };
}

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
  for (const m of workbookXml.matchAll(/<sheet\b[^>]*?name="([^"]*)"[^>]*?r:id="([^"]+)"[^>]*\/>/g)) {
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

  const byRow = new Map<number, string[]>();
  for (const rowMatch of sheetXml.matchAll(/<row[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const c of rowMatch[2]!.matchAll(/<c[^>]*\br="([A-Z]+\d+)"([^>]*)>([\s\S]*?)<\/c>/g)) {
      const type = /\bt="([^"]+)"/.exec(c[2]!)?.[1];
      const inner = c[3]!;
      let value: string;
      if (type === 's') {
        value = shared[Number(/<v>(\d+)<\/v>/.exec(inner)?.[1] ?? -1)] ?? '';
      } else if (type === 'inlineStr' || type === 'str') {
        value = decodeXml([...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]!).join(''));
      } else {
        value = decodeXml(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '');
      }
      cells[columnOf(c[1]!) - 1] = value;
    }
    byRow.set(Number(rowMatch[1]!), cells);
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

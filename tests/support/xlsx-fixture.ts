import { crc32, deflateRawSync } from 'node:zlib';

/**
 * Builds a valid `.xlsx` in memory. FOR TESTS ONLY.
 *
 * The real QA workbook can never be committed — its Test Data column carries
 * live credentials — so every test that needs a workbook builds one. Store-mode
 * (uncompressed) entries keep this short while still exercising the parts of the
 * reader that would actually break: the central-directory walk, the shared-string
 * table and the cell parser.
 *
 * ## Why this lives in `tests/support/` and not in a package
 *
 * **There is no xlsx WRITER in production, deliberately.** The QA's workbook is
 * read and never written (E5), and a writer sitting in `packages/` is one import
 * away from someone "just updating the Status column" — which is exactly the
 * change the E5 guard scans `execute.ts` and `report.ts` for.
 *
 * So this is a fixture builder, and the boundary is enforced rather than trusted:
 * `eslint.config.mjs` forbids `packages/`, `apps/` and `scripts/` from importing
 * anything under `tests/`. Before that rule was added the scope was measured —
 * 99 files under those three directories, none of them importing from `tests/` —
 * so the rule was pinning a property that already held rather than announcing a
 * cleanup.
 *
 * A runtime fixture workbook (`pnpm run-sheet` against the demo app) is written
 * from a TEST, into `artifacts/`, which is gitignored. Nothing in production
 * needs to produce one.
 */
/**
 * A cell Excel writes as `<c r="I2" s="12"/>` — STYLED BUT EMPTY.
 *
 * ## Why this had to be added, and what its absence cost
 *
 * This writer emitted NOTHING for `''` (`value === '' ? '' : …`), so no fixture in
 * the suite had ever contained a self-closing `<c/>`. The reader's cell regex
 * required a closing tag and mis-parsed one when it met it — swallowing the next
 * cell's value, returning a raw shared-string index as text and shifting every
 * column after it. Ten of 22 columns in the real DMS workbook were attributed to
 * the wrong header, and **600 passing tests could not see it**, because the writer
 * and the reader shared one assumption: *an empty cell is an absent cell*.
 *
 * A real Excel file disagrees. A cell that has ever been formatted — a border, a
 * fill, a cleared value — persists as a styled blank, and the QA sheet is full of
 * them.
 *
 * > A reader verified only against your own writer inherits the writer's
 * > assumptions (§AK).
 *
 * Use this wherever a fixture should look like a sheet somebody has actually
 * edited, rather than like one this repo generated.
 */
export const STYLED_BLANK = '\u0000STYLED_BLANK\u0000';

/**
 * A workbook holding ONE sheet whose XML is given verbatim.
 *
 * `buildXlsx` can only emit the forms it knows how to write, which is precisely the
 * limitation that hid the self-closing-cell bug. Some cell forms a real file
 * contains cannot be produced by any writer this repo would sensibly have — an
 * inline string, a `t="str"` formula result, a duplicate reference, a row whose
 * cells are out of order — and those are exactly the inputs the parser's refusals
 * exist for.
 *
 * So the escape hatch is explicit and narrow: hand-written sheet XML, wrapped in a
 * real zip, read back through the real reader. It is a FIXTURE for the parser and
 * not a second writer — nothing builds a workbook this way outside a parser test.
 */
export function bookFromSheetXml(name: string, sheetXml: string): Buffer {
  return packWorkbook([{ name, xml: sheetXml }], []);
}

export function buildXlsx(sheets: Array<{ name: string; rows: string[][] }>): Buffer {
  const shared: string[] = [];
  const indexOf = (value: string): number => {
    const found = shared.indexOf(value);
    if (found >= 0) return found;
    shared.push(value);
    return shared.length - 1;
  };
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
          .map((value, c) => {
            const ref = `${colName(c + 1)}${r + 1}`;
            // A styled blank is PRESENT and EMPTY — the form the reader used to
            // mis-parse. Emitted with a style attribute and no body, exactly as
            // Excel writes it.
            if (value === STYLED_BLANK) return `<c r="${ref}" s="12"/>`;
            if (value === '') return '';
            return `<c r="${ref}" t="s"><v>${indexOf(value)}</v></c>`;
          })
          .join('');
        return `<row r="${r + 1}">${cs}</row>`;
      })
      .join('');
    return `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
  });

  return packWorkbook(
    sheets.map((s, i) => ({ name: s.name, xml: sheetXml[i]! })),
    shared,
  );
}

/** The zip and the manifest, shared by both builders so neither drifts. */
function packWorkbook(sheets: Array<{ name: string; xml: string }>, shared: string[]): Buffer {
  const esc = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

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
    ...sheets.map((s, i): [string, string] => [`xl/worksheets/sheet${i + 1}.xml`, s.xml]),
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

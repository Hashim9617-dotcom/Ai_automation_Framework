import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { test, expect } from '@playwright/test';
import {
  EXCLUDED_FROM_REPORT_ZIP,
  REPORT_ZIP_LIMIT_BYTES,
  isReportZipTooLarge,
  zipDirectory,
} from '../../packages/reporting-engine/src/notify/zip';

/**
 * The report archive.
 *
 * Temp directories only: no OneDrive, no network, no database, no Windows — so
 * this runs in `pnpm verify` like the rest of the unit suite.
 *
 * ## The reader here is written from the SPEC, not from the writer
 *
 * §AK: "a reader verified only against your own WRITER inherits the writer's
 * assumptions", and it cost this repo three weeks of a mis-read xlsx once. So
 * `readZip` below parses the END OF CENTRAL DIRECTORY and walks the central
 * directory records by their documented offsets, rather than trusting anything
 * the writer happens to lay out — if the writer put a field in the wrong place,
 * this reader looks in the right one and fails.
 *
 * That is still JavaScript I wrote. The genuinely independent check is Windows'
 * own unzip, run by hand against a real archive on 2026-11-06. A source tree of
 * four files — compressible HTML, plain text, 3000 random bytes, and a planted
 * `trace-abc.zip` — produced a 3366-byte archive, and:
 *
 *     Expand-Archive -Path report.zip -DestinationPath out    -> succeeded
 *     extracted: index.html, data/notes.txt, data/noise.bin   -> 3 entries
 *     SHA-256 of each, source vs extracted                    -> IDENTICAL
 *     data/trace-abc.zip present in output                    -> False
 *     'SENTINEL' found anywhere in the output                 -> False
 *
 * It is not in the suite because `pnpm verify` must not need Windows, so the
 * measurement is recorded here instead of implied.
 *
 * The first version of this comment claimed "4 entries" — written before the
 * command was run, and wrong: the fourth file is the trace, which is excluded on
 * purpose. A number typed ahead of its measurement is a fabrication even when it
 * is nearly right, which is why the real output is pasted rather than summarised.
 */

interface ReadEntry {
  name: string;
  method: number;
  contents: Buffer;
}

/** A ZIP reader built from the format, used to check the writer. */
function readZip(bytes: Buffer): ReadEntry[] {
  // End of central directory: scan back for its signature, because the record
  // is last and variable-length (a comment may follow it).
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i -= 1) {
    if (bytes.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('no end-of-central-directory record: this is not a zip');

  const count = bytes.readUInt16LE(eocd + 10);
  let cursor = bytes.readUInt32LE(eocd + 16);
  const out: ReadEntry[] = [];

  for (let i = 0; i < count; i += 1) {
    if (bytes.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error(`central directory record ${i} has the wrong signature`);
    }
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');

    // Bit 11 must be set, or a reader guesses a code page for the name.
    expect(flags & 0x0800, `${name}: the UTF-8 name flag is not set`).toBe(0x0800);

    // Follow the offset into the local header and read the payload from there,
    // which is what a real reader does — a central directory that disagreed with
    // the local headers would pass a writer-shaped check and fail here.
    if (bytes.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`${name}: the central directory points at a non-local-header offset`);
    }
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const dataAt = localOffset + 30 + localNameLength + localExtraLength;
    const raw = bytes.subarray(dataAt, dataAt + compressedSize);
    const contents = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);

    expect(contents.length, `${name}: the recorded uncompressed size is wrong`).toBe(
      uncompressedSize,
    );
    out.push({ name, method, contents });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

const scratch = (): string => mkdtempSync(path.join(tmpdir(), 'aitp-notify-zip-'));

/**
 * Bytes deflate genuinely cannot shrink.
 *
 * `randomBytes`, and the first version of this was not. It was
 * `(i * 2654435761) & 0xff`, which looks like noise and is a 256-byte
 * PERMUTATION repeating — so a 4 KiB buffer was sixteen copies of one block and
 * deflate halved it. Z2 duly failed, and the code was right: the fixture was
 * claiming to be incompressible while being the opposite.
 *
 * The lesson is the §"a discriminating property needs a discriminating fixture"
 * one, in a new place: a test of "this input is NOT compressed" needs an input
 * that cannot be.
 */
function incompressible(length: number): Buffer {
  return randomBytes(length);
}

test.describe('the report archive @unit', () => {
  test('Z1: a written archive round-trips through a reader built from the format', () => {
    // wrong: a writer checked only by its own reader agrees with itself. §AK's
    // xlsx episode is the cost of that — 600 tests green over a parser that
    // mis-read the real workbook for three weeks, because no fixture ever held
    // the shape the writer did not emit. This reader follows the central
    // directory's offsets into the local headers, so a field in the wrong place
    // fails here rather than cancelling out.
    const dir = scratch();
    try {
      // Text that deflates well, and bytes that do not — both paths matter.
      writeFileSync(path.join(dir, 'index.html'), '<html>'.repeat(500), 'utf8');
      mkdirSync(path.join(dir, 'data'), { recursive: true });
      writeFileSync(path.join(dir, 'data', 'notes.txt'), 'plain text', 'utf8');
      const noise = incompressible(2048);
      writeFileSync(path.join(dir, 'data', 'noise.bin'), noise);

      const result = zipDirectory(dir);
      expect(result.entryCount).toBe(3);

      const read = readZip(result.bytes);
      expect(read.map((e) => e.name).sort()).toEqual([
        'data/noise.bin',
        'data/notes.txt',
        'index.html',
      ]);

      // Contents are byte-identical, which is the only thing that matters.
      const byName = new Map(read.map((e) => [e.name, e]));
      expect(byName.get('index.html')!.contents.toString('utf8')).toBe('<html>'.repeat(500));
      expect(byName.get('data/notes.txt')!.contents.toString('utf8')).toBe('plain text');
      expect(byName.get('data/noise.bin')!.contents.equals(noise)).toBe(true);

      // FORWARD SLASHES, on every platform. A zip written with backslashes opens
      // as one file called `data\notes.txt` in most readers, and the report's
      // directory structure silently collapses.
      for (const entry of read) expect(entry.name).not.toContain('\\');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('Z2: incompressible bytes are STORED rather than deflated larger', () => {
    // wrong: deflating everything. A Playwright report is mostly PNGs and
    // already-compressed payloads, so blanket deflate makes the archive BIGGER —
    // which pushes it over the 10 MB line and turns an attachment into a "look
    // in the folder" message for no reason. Asserting the method per entry is
    // what distinguishes a size win from a size loss.
    const dir = scratch();
    try {
      const compressible = 'a'.repeat(4096);
      writeFileSync(path.join(dir, 'text.txt'), compressible, 'utf8');
      const noise = incompressible(4096);
      writeFileSync(path.join(dir, 'noise.bin'), noise);

      const read = readZip(zipDirectory(dir).bytes);
      const byName = new Map(read.map((e) => [e.name, e]));
      expect(byName.get('text.txt')!.method, 'compressible text was not deflated').toBe(8);
      expect(byName.get('noise.bin')!.method, 'incompressible bytes were deflated anyway').toBe(0);
      // Both still read back correctly, so the choice is about size and not
      // about correctness.
      expect(byName.get('text.txt')!.contents.toString('utf8')).toBe(compressible);
      expect(byName.get('noise.bin')!.contents.equals(noise)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('Z3: nothing that carries a credential enters the archive', () => {
    // wrong: and this is the one that matters most. `docs/WHERE-WE-ARE.md`
    // records that a Playwright `trace.zip` holds a LIVE SESSION — the
    // refresh_token cookie plus access_token from localStorage, verified by
    // unzipping one — and that the HTML report EMBEDS them under
    // html/data/*.zip. The Jenkinsfile strips those before publishing; an email
    // attachment is the same exposure with a wider audience.
    //
    // Every excluded shape is PLANTED here, because a denylist is only as good
    // as the cases somebody thought of, and an untested entry in it is a
    // sentence rather than a control.
    const dir = scratch();
    try {
      mkdirSync(path.join(dir, 'data'), { recursive: true });
      mkdirSync(path.join(dir, 'auth'), { recursive: true });

      writeFileSync(path.join(dir, 'index.html'), '<html>report</html>', 'utf8');
      writeFileSync(path.join(dir, 'data', 'abc123.zip'), 'SENTINEL-TRACE-TOKEN', 'utf8');
      writeFileSync(path.join(dir, 'auth', 'app.json'), 'SENTINEL-SESSION-COOKIE', 'utf8');
      writeFileSync(path.join(dir, 'storageState.txt'), 'SENTINEL-STORAGE-STATE', 'utf8');
      writeFileSync(path.join(dir, '.env.local'), 'SENTINEL-ENV-VALUE', 'utf8');
      writeFileSync(path.join(dir, 'db-password.txt'), 'SENTINEL-PASSWORD', 'utf8');

      const result = zipDirectory(dir);
      const names = readZip(result.bytes).map((e) => e.name);

      // The report itself survives, or the exclusion is just "zip nothing".
      expect(names, 'the report body was excluded too').toContain('index.html');

      for (const forbidden of [
        'data/abc123.zip',
        'auth/app.json',
        'storageState.txt',
        '.env.local',
        'db-password.txt',
      ]) {
        expect(names, `${forbidden} reached the archive`).not.toContain(forbidden);
      }

      // And no sentinel appears anywhere in the BYTES — not as a name, not as a
      // payload, not partially deflated. Searching the whole buffer is the check
      // that does not depend on the reader being right.
      const raw = result.bytes.toString('latin1');
      for (const sentinel of [
        'SENTINEL-TRACE-TOKEN',
        'SENTINEL-SESSION-COOKIE',
        'SENTINEL-STORAGE-STATE',
        'SENTINEL-ENV-VALUE',
        'SENTINEL-PASSWORD',
      ]) {
        expect(raw, `${sentinel} is present in the archive bytes`).not.toContain(sentinel);
      }

      // The exclusions are REPORTED, so the email can say the archive is partial
      // rather than imply it is complete.
      expect(result.excluded.map((e) => e.name).sort()).toEqual([
        '.env.local',
        'auth/app.json',
        'data/abc123.zip',
        'db-password.txt',
        'storageState.txt',
      ]);
      // §T — the denylist had a subject. An empty rule list would exclude
      // nothing and every assertion above would read as a clean archive.
      expect(EXCLUDED_FROM_REPORT_ZIP.length).toBeGreaterThan(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('Z4: the 10 MB decision is made on the real byte count, at the boundary', () => {
    // wrong: a limit compared against the uncompressed directory size, or
    // against an estimate. The mail's claim — attachment, or "in the project
    // folder" — has to match what was actually written, or a manager clicks a
    // paperclip a gateway silently dropped. Both sides of the boundary are
    // asserted, because `>` and `>=` differ by exactly one byte and only one of
    // them is right.
    expect(REPORT_ZIP_LIMIT_BYTES).toBe(10 * 1024 * 1024);

    expect(isReportZipTooLarge(0)).toBe(false);
    expect(isReportZipTooLarge(REPORT_ZIP_LIMIT_BYTES - 1)).toBe(false);
    expect(isReportZipTooLarge(REPORT_ZIP_LIMIT_BYTES), 'exactly at the limit is not over').toBe(
      false,
    );
    expect(isReportZipTooLarge(REPORT_ZIP_LIMIT_BYTES + 1)).toBe(true);

    // And it is asked of a REAL archive, so the number being compared is the one
    // that would be written to disk.
    const dir = scratch();
    try {
      writeFileSync(path.join(dir, 'index.html'), '<html>small</html>', 'utf8');
      const result = zipDirectory(dir);
      expect(result.bytes.length).toBeGreaterThan(0);
      expect(isReportZipTooLarge(result.bytes.length)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

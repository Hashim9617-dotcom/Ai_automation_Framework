import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { test, expect } from '@playwright/test';
import {
  ALLOWED_IN_NOTIFY_BUNDLE,
  REPORT_ZIP_LIMIT_BYTES,
  isReportZipTooLarge,
  zipDirectory,
  zipSources,
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
      /**
       * ALLOWED names, because the filter is not this test's subject.
       *
       * These were `index.html` and `data/*`, which the allowlist now excludes — so
       * this read back an empty archive and failed on the format it was testing. The
       * fixture is the thing to change, not the filter: a nested path is still
       * exercised, through the one allowed nested shape there is.
       */
      const html = '<html>'.repeat(500);
      writeFileSync(path.join(dir, 'run.json'), html, 'utf8');
      writeFileSync(path.join(dir, 'summary.md'), 'plain text', 'utf8');
      mkdirSync(path.join(dir, 'test-results', 'a-test'), { recursive: true });
      const noise = incompressible(2048);
      writeFileSync(path.join(dir, 'test-results', 'a-test', 'test-failed-1.png'), noise);

      // Screenshots opted IN, because the subject here is the zip format and the
      // nested path is the only nested shape the allowlist has. The gate itself is
      // `notify-screenshots.spec.ts`.
      const result = zipDirectory(dir, { includeScreenshots: true });
      expect(result.entryCount).toBe(3);

      const read = readZip(result.bytes);
      expect(read.map((e) => e.name).sort()).toEqual([
        'run.json',
        'summary.md',
        'test-results/a-test/test-failed-1.png',
      ]);

      // Contents are byte-identical, which is the only thing that matters.
      const byName = new Map(read.map((e) => [e.name, e]));
      expect(byName.get('run.json')!.contents.toString('utf8')).toBe(html);
      expect(byName.get('summary.md')!.contents.toString('utf8')).toBe('plain text');
      expect(byName.get('test-results/a-test/test-failed-1.png')!.contents.equals(noise)).toBe(
        true,
      );

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
      // Allowed names, for the reason Z1 gives: the subject here is the method
      // choice, and a fixture the filter drops tests nothing.
      const compressible = 'a'.repeat(4096);
      writeFileSync(path.join(dir, 'summary.md'), compressible, 'utf8');
      const noise = incompressible(4096);
      mkdirSync(path.join(dir, 'test-results', 'a-test'), { recursive: true });
      writeFileSync(path.join(dir, 'test-results', 'a-test', 'test-failed-1.png'), noise);

      const read = readZip(zipDirectory(dir, { includeScreenshots: true }).bytes);
      const byName = new Map(read.map((e) => [e.name, e]));
      const png = 'test-results/a-test/test-failed-1.png';
      expect(byName.get('summary.md')!.method, 'compressible text was not deflated').toBe(8);
      expect(byName.get(png)!.method, 'incompressible bytes were deflated anyway').toBe(0);
      // Both still read back correctly, so the choice is about size and not
      // about correctness.
      expect(byName.get('summary.md')!.contents.toString('utf8')).toBe(compressible);
      expect(byName.get(png)!.contents.equals(noise)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('Z5: every FORBIDDEN kind named in the brief is absent, and every allowed kind is present', () => {
    // wrong: asserting only the absences. A filter that matched nothing would pass
    // all of them and produce an empty bundle — which is the rule-that-refuses-
    // everything shape, and reads as perfect safety. Both halves in one fixture, so
    // neither can be satisfied alone, and across TWO sources because that is how a
    // real suite run is assembled.
    const reports = scratch();
    const results = scratch();
    try {
      // ---- the forbidden kinds, one of each ----
      mkdirSync(path.join(reports, 'html', 'data'), { recursive: true });
      writeFileSync(path.join(reports, 'html', 'index.html'), 'REPORT', 'utf8');
      writeFileSync(path.join(reports, 'html', 'data', 'trace-1.zip'), 'TRACEBYTES', 'utf8');
      // A trace NOT named `.zip` — the old denylist caught traces by extension only.
      writeFileSync(path.join(reports, 'html', 'data', 'trace-2.bin'), 'TRACEBYTES', 'utf8');
      writeFileSync(path.join(reports, 'network.json'), '{"requests":[]}', 'utf8');
      writeFileSync(path.join(reports, 'summary.html'), '<html></html>', 'utf8');
      mkdirSync(path.join(results, 'a-test'), { recursive: true });
      writeFileSync(path.join(results, 'a-test', 'video.webm'), 'VIDEOBYTES', 'utf8');
      writeFileSync(path.join(results, 'a-test', 'trace.zip'), 'TRACEBYTES', 'utf8');
      writeFileSync(path.join(results, 'a-test', 'network.json'), '{"requests":[]}', 'utf8');
      writeFileSync(path.join(results, 'a-test', 'local.json'), 'SESSIONSTATE', 'utf8');

      // ---- and every allowed kind ----
      writeFileSync(path.join(reports, 'run.json'), '{"id":"run_x"}', 'utf8');
      writeFileSync(path.join(reports, 'junit.xml'), '<testsuites/>', 'utf8');
      writeFileSync(path.join(reports, 'sheet-drift.csv'), 'Module,Case ID\r\n', 'utf8');
      writeFileSync(path.join(reports, 'summary.md'), '# run', 'utf8');
      writeFileSync(path.join(results, 'a-test', 'test-failed-1.png'), 'PNGBYTES', 'utf8');

      const names = readZip(
        zipSources(
          [
            { root: reports, prefix: '' },
            { root: results, prefix: 'test-results' },
          ],
          // Opted in, so "every allowed kind is present" means every kind an
          // application CAN allow. The per-app gate is `notify-screenshots.spec.ts`.
          { includeScreenshots: true },
        ).bytes,
      )
        .map((entry) => entry.name)
        .sort();

      expect(names).toEqual([
        'junit.xml',
        'run.json',
        'sheet-drift.csv',
        'summary.md',
        'test-results/a-test/test-failed-1.png',
      ]);
    } finally {
      rmSync(reports, { recursive: true, force: true });
      rmSync(results, { recursive: true, force: true });
    }
  });

  test('Z6: a PLANTED secret value appears nowhere in the bundle bytes', () => {
    // wrong: checking file NAMES only. A name-based check cannot see a secret that
    // arrived inside an allowed file — and it is the bytes that get mailed. The
    // needle is synthetic and generated here, so a stale copy of it cannot make this
    // pass; and an allowed file carrying a DIFFERENT marker is asserted present, or
    // "the needle is absent" would also be true of an empty bundle.
    const reports = scratch();
    const results = scratch();
    const secret = `AITP-PLANTED-SECRET-${Math.random().toString(36).slice(2)}`;
    const marker = `AITP-ALLOWED-MARKER-${Math.random().toString(36).slice(2)}`;
    try {
      mkdirSync(path.join(results, 'a-test'), { recursive: true });
      // In each forbidden kind, including inside a trace and a video.
      writeFileSync(path.join(results, 'a-test', 'trace.zip'), secret, 'utf8');
      writeFileSync(path.join(results, 'a-test', 'video.webm'), secret, 'utf8');
      writeFileSync(path.join(results, 'a-test', 'network.json'), secret, 'utf8');
      writeFileSync(path.join(reports, '.env'), `TOKEN=${secret}`, 'utf8');
      writeFileSync(path.join(reports, 'summary.html'), secret, 'utf8');
      // And as a FILE NAME, which a payload scan alone would miss.
      writeFileSync(path.join(reports, `${secret}.json`), 'nothing', 'utf8');
      writeFileSync(path.join(reports, 'run.json'), `{"marker":"${marker}"}`, 'utf8');

      const bytes = zipSources([
        { root: reports, prefix: '' },
        { root: results, prefix: 'test-results' },
      ]).bytes;

      // latin1 so every byte maps to one character: a UTF-8 decode could drop or
      // replace a sequence and hide the needle by accident.
      const raw = bytes.toString('latin1');
      expect(raw, 'the planted secret is in the bundle bytes').not.toContain(secret);
      // The discriminating half: an allowed file's content really is in there, so
      // the search is looking at a bundle with something in it.
      expect(raw, 'the allowed marker is missing — the bundle is empty').toContain(marker);
    } finally {
      rmSync(reports, { recursive: true, force: true });
      rmSync(results, { recursive: true, force: true });
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

      // An ALLOWED file beside them, so this cannot pass by zipping nothing — the
      // rule-that-refuses-everything shape, which looks identical from outside.
      writeFileSync(path.join(dir, 'run.json'), '{"id":"run_x"}', 'utf8');

      const result = zipDirectory(dir);
      const names = readZip(result.bytes).map((e) => e.name);

      // The allowed file survives, which is what makes every exclusion below a
      // verdict rather than the filter's answer to everything.
      expect(names, 'the run record was excluded too').toContain('run.json');
      // And the Playwright report does NOT. It used to be the whole point of the
      // bundle; its `data/` directory holds every attachment a run produced.
      expect(names, 'the Playwright HTML report reached the archive').not.toContain('index.html');

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
        'index.html',
        'storageState.txt',
      ]);
      // §T — the allowlist had a subject. An empty rule list would exclude
      // EVERYTHING and every assertion above would read as a clean archive while
      // the bundle was empty, which is why `run.json` is asserted present.
      expect(ALLOWED_IN_NOTIFY_BUNDLE.length).toBeGreaterThan(3);
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

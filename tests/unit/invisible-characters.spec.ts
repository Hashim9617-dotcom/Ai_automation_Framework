import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { findRepoRoot } from '@aitp/shared';
import { execFileSyncClean } from '../support/spawn-clean';

/**
 * No invisible character enters source unless someone decided it should.
 *
 * CLAUDE.md has had this convention since NUL bytes and Private Use Area
 * glyphs first crept in. It was enforced by a scratchpad script run by hand
 * before committing — and on 2026-09-08 a literal U+FEFF got past it and into
 * `packages/shared/src/authored/sheet.ts`, written by the very code that
 * strips a BOM.
 *
 * **The post-mortem matters more than the fix.** The file was in scope and the
 * scan did run after the character was introduced. What failed was neither
 * scope nor ordering: the detector's character set was NUL plus the PUA range,
 * and U+FEFF is in neither. Its planted-hit control reported a confident 2/2 —
 * because a control can only validate the classes someone thought to plant.
 *
 * > **A detector built from a list of bad characters is bounded by the
 * > imagination of whoever wrote the list**, exactly as a keyword audit is. The
 * > answer is the same as it was there: stop enumerating, and use the
 * > structural definition instead.
 *
 * So this checks Unicode CATEGORIES — format (`Cf`), private use (`Co`),
 * surrogates (`Cs`) and control (`Cc`, less tab/newline/CR) — which is what
 * "invisible character" actually means. U+FEFF, the soft hyphen, the
 * bidi overrides and the zero-width joiners are all covered without anyone
 * having to name them.
 *
 * And it is a TEST rather than a script, so it runs on every unit run. That
 * closes the ordering question permanently: nothing can be added after the last
 * manual scan, because there is no last manual scan.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SECOND POST-MORTEM (2026-09-11): the detector was fine. The FILE LIST was not.
 *
 * NUL bytes sat in `packages/shared/src/types/run.ts` while this guard was
 * believed green. The hypothesis on resuming was that `git` had classified that
 * file as binary and the enumeration had therefore dropped it.
 *
 * **That hypothesis is wrong, and it was tested rather than assumed.** Planting
 * a NUL in a tracked `.ts` file does make `git grep -I` treat it as binary, but
 * `git ls-files` reads the INDEX, not content — it still lists the file, this
 * guard still reads it, and the run still fails. Reproduced end to end: with two
 * NULs planted inside a block comment in `run.ts`, this test failed exactly as
 * it should. Detector and enumeration both did their job on that input.
 *
 * What the reproduction DID expose is two real holes of that same shape, plus
 * one hazard that cannot be closed from inside this file:
 *
 *   1. **Untracked files were never enumerated at all.** `git ls-files` lists
 *      tracked files only, so a brand-new file — the common case for a document
 *      or module being written right now — stayed invisible to the scan until
 *      somebody ran `git add`. On the day this was found,
 *      `docs/phase-2-command-box.md` was untracked and had never once been
 *      scanned.
 *   2. **Per-file read failures were swallowed** by a bare `catch { continue }`,
 *      which is a scan reporting clean on a file it never opened.
 *
 * Both are the keyword-audit shape again, and Finding 15 once more: **an absence
 * claim is only as strong as the completeness of what you looked in.** So the
 * rule here is now explicit — *this guard reports what it SKIPPED, and a skip is
 * a failure rather than a silence.* The only exclusion left is files git itself
 * reports as deleted from the working tree, and that exclusion is enumerated and
 * counted rather than inferred from a swallowed exception.
 *
 * The control moved with it. The old planted-hit control was planted in a file
 * the enumeration could already see, so it could only ever validate the
 * detector — never the file list, which is where the failure actually was. The
 * new one plants its character in an **untracked** file. A control planted where
 * the bug cannot live proves nothing.
 *
 * ── The hazard this file cannot close ────────────────────────────────────────
 * A NUL at a syntactically significant position in any module reachable from
 * `playwright.config.ts` stops the CONFIG from parsing (`BABEL_PARSE_ERROR`), so
 * no test runs at all — including this one. Verified by planting one at the end
 * of `run.ts`. The guard then produces an error rather than a finding, and an
 * error is easy to read as unrelated infrastructure noise and re-run past. This
 * guard is downstream of the thing it guards; closing that properly needs a
 * scanner importing nothing from this repo, run before the parsing gates.
 * Recorded here so the limit is known rather than rediscovered.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const ROOT = findRepoRoot();

/** The file types source review actually covers. */
const SCAN_PATTERNS = ['*.ts', '*.tsx', '*.md', '*.mjs', '*.json'] as const;

/**
 * Deliberate instances, each with the reason it must stay.
 *
 * These record the REAL icon glyph from the application under test, quoted so
 * the exact computed accessible name is preserved (Finding 10). Deleting them
 * would destroy the evidence the finding rests on. Anything not listed here
 * fails, which is the point: a new one has to be argued for.
 */
const ALLOWED: Array<{ file: string; codePoint: number; why: string }> = [
  {
    file: 'docs/dms-findings.md',
    codePoint: 0xeb62,
    why: 'the real PUA icon glyph, quoted to record the exact accessible name (Finding 10)',
  },
  {
    file: 'tests/app/pages/admin/user-roles.page.ts',
    codePoint: 0xeb62,
    why: 'same glyph, quoted in a comment recording the real name of Create Role',
  },
  {
    file: 'tests/app/pages/admin/users.page.ts',
    codePoint: 0xeb62,
    why: 'same glyph, quoted in a comment recording the real name of Create User',
  },
];

const KEEP = new Set(['\t', '\n', '\r']);

function isInvisible(char: string): boolean {
  if (KEEP.has(char)) return false;
  return (
    /\p{Cf}/u.test(char) || /\p{Co}/u.test(char) || /\p{Cs}/u.test(char) || /\p{Cc}/u.test(char)
  );
}

/** NUL-separated so no path can be mangled by quoting — `-z` is not decoration. */
function gitList(mode: readonly string[]): string[] {
  const out = execFileSyncClean(
    'git',
    ['-C', ROOT, 'ls-files', '-z', ...mode, '--', ...SCAN_PATTERNS],
    { maxBuffer: 10 * 1024 * 1024 },
  );
  return out.split('\0').filter(Boolean);
}

interface Enumeration {
  /** Everything that must be read. */
  files: string[];
  /** Tracked but absent from the working tree — excluded ON PURPOSE, and counted. */
  deleted: string[];
}

/**
 * Every source file present in the working tree — tracked OR NOT.
 *
 * The untracked half is the hole this closes: a file being written right now is
 * exactly when an invisible character is most likely to arrive, and it is also
 * exactly when `git ls-files` alone cannot see it.
 */
function sourceFiles(): Enumeration {
  const tracked = gitList([]);
  const untracked = gitList(['--others', '--exclude-standard']);
  const deleted = gitList(['--deleted']);
  const gone = new Set(deleted);
  const files = [...new Set([...tracked, ...untracked])].filter((f) => !gone.has(f)).sort();
  return { files, deleted };
}

interface ScanResult {
  hits: string[];
  /** Files the scan could not read. Never silent — these FAIL the run. */
  skipped: Array<{ file: string; why: string }>;
  scanned: number;
}

function scan(files: readonly string[]): ScanResult {
  const allowed = new Set(ALLOWED.map((entry) => `${entry.file}:${entry.codePoint}`));
  const hits: string[] = [];
  const skipped: Array<{ file: string; why: string }> = [];
  let scanned = 0;

  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(path.join(ROOT, file), 'utf8');
    } catch (error) {
      // A scan that could not open a file has not cleared it. Record, then fail.
      skipped.push({ file, why: (error as Error).message });
      continue;
    }
    scanned += 1;
    for (const char of text) {
      if (!isInvisible(char)) continue;
      const code = char.codePointAt(0)!;
      if (allowed.has(`${file.replace(/\\/g, '/')}:${code}`)) continue;
      hits.push(`${file}: U+${code.toString(16).toUpperCase().padStart(4, '0')}`);
    }
  }

  return { hits: [...new Set(hits)], skipped, scanned };
}

test.describe('no invisible characters in source @unit', () => {
  // SERIAL, and not by preference. The config sets `fullyParallel: true`, so
  // tests in one file are spread across workers — and the enumeration control
  // below plants a real file in the working tree that the full scan then reads.
  // Run in parallel, the control's planted U+FEFF surfaces as a hit in the scan
  // test, which reported exactly that on the first run of this rewrite.
  //
  // The general shape: a control that MUTATES the tree cannot run concurrently
  // with a check that READS the tree. Widening the scan to untracked files is
  // what made this file's own side effects observable to itself.
  test.describe.configure({ mode: 'serial' });

  test('the detector finds every planted class, including ones the old list missed', () => {
    // Asserts its own effect (CLAUDE.md). The previous detector's control
    // passed 2/2 while blind to U+FEFF — so this control plants the classes
    // that got past it, plus several nobody had thought about, and every one
    // must be found.
    const planted: Array<[string, number]> = [
      ['NUL', 0x00],
      ['PUA', 0xe000],
      ['BOM / ZWNBSP', 0xfeff],
      ['zero-width space', 0x200b],
      ['zero-width joiner', 0x200d],
      ['left-to-right mark', 0x200e],
      ['right-to-left override', 0x202e],
      ['soft hyphen', 0x00ad],
      ['word joiner', 0x2060],
    ];

    const missed = planted.filter(([, code]) => !isInvisible(String.fromCodePoint(code)));
    expect(missed.map(([name]) => name)).toEqual([]);

    // And the discriminating half: ordinary source characters, including the
    // typography this repo's comments genuinely use, must NOT be flagged.
    const ordinary = [...'abcXYZ012 —–→…"\'`\t\n\r{}<>/\\|@#$%^&*()'];
    expect(ordinary.filter(isInvisible)).toEqual([]);
  });

  test('the ENUMERATION reaches untracked files — the control is planted where the bug lives', () => {
    // wrong: the previous control planted its character in a file the file list
    // could already see, so it validated the detector and nothing else. The
    // failure was never in the detector. This plants in an UNTRACKED file,
    // which is precisely what the old enumeration could not reach.
    const relative = 'docs/.invisible-guard-control.tmp.md';
    const full = path.join(ROOT, relative);
    writeFileSync(full, `control ${String.fromCodePoint(0xfeff)} planted\n`, 'utf8');

    try {
      const { files } = sourceFiles();
      expect(files, 'an untracked source file must be enumerated').toContain(relative);

      const { hits, skipped } = scan(files);
      expect(skipped).toEqual([]);
      expect(
        hits.some((hit) => hit.startsWith(relative)),
        'the planted U+FEFF in an untracked file must be reported',
      ).toBe(true);
    } finally {
      rmSync(full, { force: true });
    }

    // And the control leaves nothing behind — otherwise it poisons the real scan.
    expect(sourceFiles().files).not.toContain(relative);
  });

  test('every source file in the tree is scanned, nothing is skipped, and none holds an unlisted invisible character', () => {
    const { files, deleted } = sourceFiles();
    // A scan that read nothing reports clean forever — the exact failure this
    // convention was written for.
    expect(files.length).toBeGreaterThan(50);

    const { hits, skipped, scanned } = scan(files);

    // The skip list IS the finding, not a footnote. A file the scan could not
    // open is a file it has not cleared, and reporting clean over it is the
    // whole failure mode this guard exists to prevent.
    expect(
      skipped,
      'these files were enumerated but never read, so the clean result does not cover them:\n' +
        skipped.map((s) => `  ${s.file}  (${s.why})`).join('\n'),
    ).toEqual([]);

    // Every enumerated file was actually opened — the two counts must reconcile,
    // so a future `continue` cannot quietly reintroduce the hole.
    expect(scanned).toBe(files.length);
    expect(scanned).toBeGreaterThan(50);

    // Deliberate exclusions stay counted and visible rather than inferred from a
    // swallowed exception. Tracked-but-deleted is the only one.
    expect(deleted.every((f) => !files.includes(f))).toBe(true);

    expect(hits).toEqual([]);
  });

  test('the allow-list is exact — every entry is still real and still needed', () => {
    // An allow-list that outlives its reason silently widens the hole. If a
    // listed character is gone, the entry comes out.
    for (const entry of ALLOWED) {
      const text = readFileSync(path.join(ROOT, entry.file), 'utf8');
      const found = [...text].some((char) => char.codePointAt(0) === entry.codePoint);
      expect(found, `${entry.file} no longer contains U+${entry.codePoint.toString(16)}`).toBe(
        true,
      );
      expect(entry.why.length).toBeGreaterThan(20);
    }
  });
});

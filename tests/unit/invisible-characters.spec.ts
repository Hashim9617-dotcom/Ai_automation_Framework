import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { findRepoRoot } from '@aitp/shared';

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
 */

const ROOT = findRepoRoot();

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

function trackedSourceFiles(): string[] {
  const out = execSync('git ls-files "*.ts" "*.tsx" "*.md" "*.mjs" "*.json"', {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  return out.split(/\r?\n/).filter(Boolean);
}

test.describe('no invisible characters in source @unit', () => {
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

  test('every tracked source file is scanned, and none holds an unlisted invisible character', () => {
    const files = trackedSourceFiles();
    // A scan that read nothing reports clean forever — the exact failure this
    // convention was written for.
    expect(files.length).toBeGreaterThan(50);

    const allowed = new Set(ALLOWED.map((entry) => `${entry.file}:${entry.codePoint}`));
    const hits: string[] = [];
    let scanned = 0;

    for (const file of files) {
      let text: string;
      try {
        text = readFileSync(path.join(ROOT, file), 'utf8');
      } catch {
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

    expect(scanned).toBeGreaterThan(50);
    expect([...new Set(hits)]).toEqual([]);
  });

  test('the allow-list is exact — every entry is still real and still needed', () => {
    // An allow-list that outlives its reason silently widens the hole. If a
    // listed character is gone, the entry comes out.
    for (const entry of ALLOWED) {
      const text = readFileSync(path.join(ROOT, entry.file), 'utf8');
      const found = [...text].some((char) => char.codePointAt(0) === entry.codePoint);
      expect(found, `${entry.file} no longer contains U+${entry.codePoint.toString(16)}`).toBe(true);
      expect(entry.why.length).toBeGreaterThan(20);
    }
  });
});

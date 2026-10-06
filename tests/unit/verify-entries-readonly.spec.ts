import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { findRepoRoot } from '@aitp/shared';

/**
 * `pnpm verify-entries` CANNOT CLICK ANYTHING, and that is checked rather than
 * promised (B4).
 *
 * The command is meant to be the one live check a QA can run without thinking about
 * it: no sheet, no rows, no writes. "Read-only" is a claim about every line of the
 * script, and the shape of claim this repo has learned to scan for rather than
 * review — the same reasoning as E5, which scans `execute.ts` and `report.ts` for
 * any attempt to write back to the workbook.
 *
 * ## Why a source scan and not a behavioural test
 *
 * A behavioural test can only show that the paths it exercises click nothing. This
 * asks the stronger question — whether the capability is present in the file at all
 * — and it is the question that stays answered when somebody adds a helpful
 * `page.click()` to "just dismiss the cookie banner first".
 */

const SCRIPT = path.join(findRepoRoot(), 'scripts', 'verify-entries.ts');

/**
 * Playwright calls that CHANGE a page, as opposed to reading one.
 *
 * `goto` and `count` are deliberately absent: navigating and counting are what this
 * command does. Everything here either dispatches an input event or sets a value.
 */
const MUTATING_CALLS = [
  '.click(',
  '.dblclick(',
  '.fill(',
  '.type(',
  '.press(',
  '.check(',
  '.uncheck(',
  '.selectOption(',
  '.setInputFiles(',
  '.dragTo(',
  '.tap(',
  '.evaluate(',
];

/**
 * COMMENTS ARE NOT CODE, and the first run of this test proved why it matters.
 *
 * The script's own docstring says it has "no `allowWrites` parameter anywhere in the
 * call", and the scan duly flagged `allowWrites`. A scan a comment can trip is one
 * somebody fixes by REWORDING, which is the worst possible outcome: the prose gets
 * quieter and the capability stays.
 *
 * So the subject is the code. Block comments first, then line comments — in that
 * order, because a `//` inside a `/* … *\/` would otherwise eat the rest of a line
 * the block had already claimed.
 */
const codeOnly = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

test.describe('verify-entries is structurally read-only (B4) @unit', () => {
  test('B4d: the script contains no page-mutating call and no step executor', () => {
    // wrong: a scan over the wrong file — a renamed script, a typo'd path — reads
    // clean forever, which is the `slice(3)` near-miss this repo keeps as a rule. So
    // the subject is asserted before the verdict (§T): the file must be there and
    // must be the script, not merely non-empty.
    const raw = readFileSync(SCRIPT, 'utf8');
    expect(raw.length).toBeGreaterThan(1000);
    expect(raw).toContain('pnpm verify-entries');
    expect(raw).toContain('createEntryVerifier');

    const code = codeOnly(raw);
    // The stripper HAD something to strip, or the scan below is over the raw file
    // again and the comment problem is back without anything saying so.
    expect(code.length).toBeLessThan(raw.length);
    expect(code).toContain('createEntryVerifier({');

    const found = MUTATING_CALLS.filter((call) => code.includes(call));
    expect(found).toEqual([]);

    // AND NO STEP EXECUTOR, which is the other way a row could be run: the entry
    // verifier opens a route and counts an element, and nothing in this script can
    // perform a step even if one were resolved.
    expect(code).not.toContain('createPlaywrightStepExecutor');
    expect(code).not.toContain('executeAuthoredRows');
    expect(code).not.toContain('allowWrites');
  });

  test('B4d: the scan would CATCH a mutating call, proven on planted text', () => {
    // wrong: a list-based scan reports clean when its list misses the thing, when
    // the subject is wrong, or when `includes` is called on the wrong variable — and
    // all three look identical to a real pass. The planted-hit control is how the
    // invisible-character scan earned its 2/2, and how it was then found to be
    // bounded by whoever wrote the list.
    const planted = 'await page.click("#go");\nawait page.fill("#q", "x");';
    const caught = MUTATING_CALLS.filter((call) => planted.includes(call));
    expect(caught).toEqual(['.click(', '.fill(']);

    // And the list is not vacuous: an honest read-only line matches nothing.
    const innocent = 'await page.goto(entry.route);\nconst count = await locator.count();';
    expect(MUTATING_CALLS.filter((call) => innocent.includes(call))).toEqual([]);

    // THE COMMENT STRIPPER, both ways. It must remove a mention in prose and keep
    // the identical call in code — a stripper that removed both would make the scan
    // above pass on any file at all.
    expect(codeOnly('/* never page.click( here */\nawait page.click("#go");')).not.toContain(
      'never',
    );
    expect(codeOnly('/* never page.click( here */\nawait page.click("#go");')).toContain('.click(');
    expect(codeOnly('await page.goto("/x"); // page.click( in a line comment')).not.toContain(
      '.click(',
    );
    // A URL's `//` is not a comment, which is why the line rule needs its guard.
    expect(codeOnly('const url = "https://example.test/x";')).toContain('https://example.test');
  });
});

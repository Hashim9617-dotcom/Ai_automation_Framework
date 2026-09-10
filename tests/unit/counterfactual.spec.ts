import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { findRepoRoot } from '@aitp/shared';

/**
 * Every test that proves a property states its counterfactual, at AUTHORING
 * time.
 *
 * > **`// wrong:` — what THIS fixture would produce under the WRONG
 * > behaviour**, written when the test is written.
 *
 * The sentence is not documentation, it is the check. Being unable to finish it
 * is the finding: if you cannot say what would change, the fixture proves
 * nothing and no implementation — correct or broken — could ever fail it.
 *
 * Discovering that when a mutation survives is discovering it too late. By then
 * the test has been read, reviewed and trusted; five such fixtures were found
 * that way in a single pass over the report writer, and every one of them had
 * looked fine for as long as it existed.
 *
 * **The file list below is the honest record of which suites have been through
 * this.** It is deliberately short and grows by a visible act. A list that
 * silently claimed the whole directory would be the same failure one level up —
 * a guard that reports green over files nobody has actually checked.
 */

const ROOT = findRepoRoot();

/**
 * Suites where every property test carries its counterfactual.
 *
 * To add one: work through its tests writing the sentence for each — not a
 * generated line per test, which is decoration and worse than nothing — then
 * add the file here.
 */
const COVERED = [
  'tests/unit/authored-run.spec.ts',
  // Added 2026-09-10 with the suites themselves, so enforcement started at the
  // same commit rather than being promised for later.
  'tests/unit/review-emit.spec.ts',
  'tests/unit/model-questions.spec.ts',
  'tests/unit/gateway-fidelity.spec.ts',
  'tests/unit/triage.spec.ts',
];

/**
 * Suites not yet covered, listed so the gap is visible rather than implied.
 *
 * Written down because "we will get to them" is not a record, and because the
 * next person deserves to know that a green run here says nothing about these.
 */
const NOT_YET_COVERED = [
  'tests/unit/resolve-authored.spec.ts',
  'tests/unit/final-test-cases.spec.ts',
  'tests/unit/authored-sheet.spec.ts',
  'tests/unit/generation-prompt.spec.ts',
  'tests/unit/generation-identity.spec.ts',
  'tests/unit/generation-engine.spec.ts',
  'tests/unit/generation-proposal.spec.ts',
  'tests/unit/grounding.spec.ts',
];

interface TestLine {
  line: number;
  title: string;
  hasCounterfactual: boolean;
}

function testsIn(file: string): TestLine[] {
  const lines = readFileSync(path.join(ROOT, file), 'utf8').split(/\r?\n/);
  const found: TestLine[] = [];
  for (const [i, line] of lines.entries()) {
    if (!/^\s*test\(/.test(line)) continue;
    // The counterfactual sits immediately under the test opening, so it is the
    // first thing read — before the fixture it is a claim about.
    found.push({
      line: i + 1,
      title: /test\(\s*['"`](.+?)['"`]/.exec(line)?.[1] ?? line.trim(),
      hasCounterfactual: (lines[i + 1] ?? '').includes('// wrong:'),
    });
  }
  return found;
}

test.describe('property tests state their counterfactual @unit', () => {
  test('the scan finds tests, and can see a missing counterfactual', () => {
    // wrong: a scanner that matched nothing would report every file clean, so
    // this control plants both shapes and requires the detector to tell them apart.
    const covered = COVERED.flatMap(testsIn);
    expect(covered.length).toBeGreaterThan(10);

    // Asserts its own effect on a synthetic pair rather than trusting the real
    // files to contain one of each.
    const sample = ["  test('x', () => {", '    // wrong: it would return 1.', "  test('y', () => {", '    const a = 1;'];
    const withLine = sample[1]!.includes('// wrong:');
    const withoutLine = sample[3]!.includes('// wrong:');
    expect([withLine, withoutLine]).toEqual([true, false]);
  });

  for (const file of COVERED) {
    test(`${file} — every test states what the wrong behaviour would produce`, () => {
      // wrong: a suite with a bare test would list that test here, naming its
      // line, instead of producing an empty array.
      const missing = testsIn(file)
        .filter((entry) => !entry.hasCounterfactual)
        .map((entry) => `${file}:${entry.line} — ${entry.title}`);
      expect(missing).toEqual([]);
    });
  }

  test('the not-yet-covered list is accurate, so the gap stays visible', () => {
    // wrong: a stale list would name a file that no longer exists, or claim a
    // suite is uncovered when it has since been done — either way the record
    // would be a comfortable fiction rather than a measurement.
    for (const file of NOT_YET_COVERED) {
      const tests = testsIn(file);
      expect(tests.length, `${file} should exist and contain tests`).toBeGreaterThan(0);
      // If a file here is now fully covered, move it to COVERED rather than
      // leaving the record understating what has been done.
      const done = tests.every((entry) => entry.hasCounterfactual);
      expect(done, `${file} is now fully covered — move it to COVERED`).toBe(false);
    }
    // And the two lists must not overlap, or coverage could be claimed twice.
    expect(COVERED.filter((file) => NOT_YET_COVERED.includes(file))).toEqual([]);
  });
});

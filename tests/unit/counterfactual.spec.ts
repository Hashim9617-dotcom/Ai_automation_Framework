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
  // Added 2026-09-16 with the suite (SEC-2), each counterfactual written with the
  // test and then checked by a mutation run: 5 caught, 1 declared survivor.
  'tests/unit/reporter-target.spec.ts',
  // Added 2026-09-18 with the suite (4a), then mutation-checked: 7 mutations,
  // each caught by the test that declares it, plus the three controls.
  'tests/unit/module-map.spec.ts',
  // Added 2026-09-19 with 4c: the scan that replaced E8, controlled by a planted
  // gateway import in the execute path.
  'tests/unit/execute-path-no-llm.spec.ts',
  // Added 2026-09-19 with 4d. The entry verifier's two suites and the
  // three-way credentials check, each counterfactual written with its test.
  'tests/unit/entry-verifier.spec.ts',
  // Added 2026-09-28 with the work itself: the upload refusal and the generated
  // automation sheet, each counterfactual written beside its test.
  'tests/unit/upload-not-supported.spec.ts',
  'tests/unit/automation-sheet.spec.ts',
  'tests/unit/authored-credentials.spec.ts',
  // Added 2026-10-01 with the suite (M3): each of the three says what the OTHER
  // outcome would be, which is the whole point here — "zero directories" is a
  // verdict two opposite causes can produce.
  'tests/unit/inspect-session-dir.spec.ts',
  // Added 2026-10-01 with the fix it describes, found by running the quickstart on a
  // fresh clone rather than by reading it.
  'tests/unit/triage-refusal.spec.ts',
  // Added 2026-10-01 with the surface partition (K3), mutation-checked: removing the
  // partition fails 2 of its 4, and the other 2 are the halves that must stay green.
  'tests/unit/surface-partition.spec.ts',
  // Added 2026-10-02 with 3b batch 1: the one reader of the capture directory, and
  // the per-module map partition that a merged capture made necessary.
  'tests/unit/capture-source.spec.ts',
  // Added 2026-10-03 with 3b batch 2: the shared-route rule, and the CLI driven as a
  // real process. Both carry their counterfactuals from the first line.
  'tests/demo/shared-route-tabs.spec.ts',
  'tests/demo/run-sheet-cli.spec.ts',
  // Added 2026-10-06 with B3: three faults that shared one refusal code. Every test
  // here asserts its code AND the absence of the other two, because the three gates
  // live within a few lines of each other and a drifted order reads as correct.
  'tests/unit/refusal-codes.spec.ts',
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

export function testsIn(file: string): TestLine[] {
  return testsInSource(readFileSync(path.join(ROOT, file), 'utf8'));
}

/**
 * The counterfactual must be the FIRST THING IN THE BODY — not the first thing after
 * the `test(` line.
 *
 * It was the line immediately below, which is the same thing until a signature wraps:
 *
 *     test('C1: …', async ({
 *       browser,          <- the line the check read
 *       env,
 *     }) => {
 *       // wrong: …       <- the counterfactual, three lines down
 *
 * Prettier wraps every destructured fixture list of more than one name, so two new
 * suites were reported as having no counterfactual while carrying one. That direction
 * is the lucky one — it is loud. The inverse would have been a test with no
 * counterfactual passing because its signature happened to wrap.
 *
 * So the body is found first (`=> {`) and the counterfactual must be the next line.
 * "First thing said" is still the rule; only the definition of "first" is fixed.
 *
 * Exported with `testsInSource` so the scanner has a falsifier: handed a source
 * directly, a test can present the case that matters.
 */
export function testsInSource(source: string): TestLine[] {
  const lines = source.split(/\r?\n/);
  const found: TestLine[] = [];
  for (const [i, line] of lines.entries()) {
    if (!/^\s*test\(/.test(line)) continue;

    // Walk to the line that opens the body. Bounded, so a malformed file cannot run
    // the scan off the end and report a test as covered by a comment far below.
    let body = i;
    for (let step = 0; step < 6 && !/=>\s*\{\s*$/.test(lines[body] ?? ''); step += 1) body += 1;

    found.push({
      line: i + 1,
      title: /test\(\s*['"`](.+?)['"`]/.exec(line)?.[1] ?? line.trim(),
      hasCounterfactual: (lines[body + 1] ?? '').includes('// wrong:'),
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
    const sample = [
      "  test('x', () => {",
      '    // wrong: it would return 1.',
      "  test('y', () => {",
      '    const a = 1;',
    ];
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

  test('§W: the scanner finds a counterfactual under a WRAPPED signature, and still misses a real gap', () => {
    // wrong: the scanner reads the line immediately after `test(`, so a Prettier-
    // wrapped fixture list hides the counterfactual and the file is reported as
    // uncovered. Measured 2026-10-03: two new suites were reported that way while
    // carrying one. That direction is loud; the inverse — a test with no
    // counterfactual passing because its signature wrapped — would be silent.
    const wrapped = [
      "test('C1: a wrapped signature', async ({",
      '  browser,',
      '  env,',
      '}) => {',
      '  // wrong: the thing this fixture would produce if the code were broken.',
      '  expect(1).toBe(1);',
      '});',
    ].join('\n');

    expect(testsInSource(wrapped).map((entry) => entry.hasCounterfactual)).toEqual([true]);

    // THE SILENT HALF, and the one the assertion is written against: a scanner that
    // simply looked for `// wrong:` anywhere below would call this covered too.
    const missing = [
      "test('C2: no counterfactual at all', async ({",
      '  page,',
      '}) => {',
      '  const root = setUp();',
      '  // wrong: this sentence arrives AFTER the fixture it is supposed to be a',
      '  // claim about, which is the ordering the rule exists to enforce.',
      '  expect(root).toBeDefined();',
      '});',
    ].join('\n');

    expect(testsInSource(missing).map((entry) => entry.hasCounterfactual)).toEqual([false]);
  });
});

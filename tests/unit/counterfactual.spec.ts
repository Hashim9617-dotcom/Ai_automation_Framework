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
  // Added 2026-10-06 with B1: the Command Box's three answers for a sheet ceiling,
  // where a WITHHELD second number must not read as a missing workbook.
  'tests/api/sheet-ceiling.spec.ts',
  // Added 2026-10-08 with the kit lock: the integrity check, and the CLI ordering
  // that is the whole guarantee. Both suites carry a counterfactual per test, and
  // for the lock the counterfactual IS the specification — every one of them names
  // the false pass it exists to prevent.
  'tests/unit/kit-integrity.spec.ts',
  // Added 2026-10-12 with B0, the four-item security hotfix. Each counterfactual
  // names the reachable defect it replaced rather than describing the fix, and
  // the bind one cites the direct measurement that `listen(port)` accepts a
  // connection on `::1` — which is what makes that assertion fail on the old code
  // rather than merely report something different.
  'tests/unit/cors-origins.spec.ts',
  'tests/unit/child-env.spec.ts',
  'tests/api/api-hardening.spec.ts',
  // Added 2026-10-12 with the B0 debt it settles: every other child-env test
  // proves the RULE without launching a browser, so all of them would stay green
  // over an allowlist missing something a real run needs. Its counterfactual says
  // exactly that, and its control is what proves the environment it constructs is
  // the one the child received.
  'tests/api/child-env-real-run.spec.ts',
  // Added 2026-10-21 with B1b. The repository contract is one suite over six
  // stores, so its counterfactuals are about what a SINGLE store getting one
  // thing wrong would produce — which is the reason the suite is shared rather
  // than six hand-written ones. The DATABASE_URL pair say what the obvious
  // message would have leaked.
  'tests/unit/persistence.spec.ts',
  // Added 2026-10-21: the credential guard, whose counterfactual IS the incident
  // — an unignored `postgresql password.txt` sat in the repo root and `git add -A`
  // would have committed it. Both halves planted, because over a clean tree a
  // detector that matches nothing and one that works look identical.
  'tests/unit/credential-files.spec.ts',
  // Added 2026-10-22 with the Postgres half: the one property the in-memory
  // store cannot have. Every counterfactual here names what the Map would do,
  // which is why H1 is the only assertion in the batch that distinguishes
  // storage from memory at all.
  'tests/api/run-history.spec.ts',
  // Added 2026-10-30 with B1c's hashing half. Every counterfactual here names
  // the specific failure the assertion exists to catch — P6's is a non-random
  // salt, which only shows up by comparing two hashes of ONE password, and P7's
  // is bcrypt's 72-byte truncation, which is one of the two reasons §2 rejected
  // it and was otherwise only asserted in prose.
  'tests/unit/password-hasher.spec.ts',
  // Added 2026-10-30 with B1c's session and throttle half. Two of its fixtures
  // had to be corrected for straddling the throttle window — they would have
  // passed because the window dropped the attempts rather than because the
  // limit held, which is green for the wrong reason. The corrected spacing is
  // commented in place, because the next person to write a window fixture will
  // reach for one attempt per minute too.
  'tests/unit/session-and-throttle.spec.ts',
  // Added 2026-11-06 with E1's report archive. Z3 is the one that matters: every
  // excluded shape is PLANTED, because a denylist is only as good as the cases
  // somebody thought of and an untested entry in it is a sentence rather than a
  // control. Z2's fixture had to be rewritten after claiming to be
  // incompressible while being a 256-byte permutation repeating.
  'tests/unit/notify-zip.spec.ts',
  // Added 2026-11-07 with the attribute-order fix. Every counterfactual here names
  // what the OLD regex did with that exact fixture, because the bug was invisible
  // to 720 tests for one reason: the only workbooks the reader had ever seen were
  // Excel's and this repo's own fixture writer's, and both happen to emit the one
  // attribute order the reader demanded (§AK). Two of the seven are the
  // must-still-work half (§W).
  'tests/unit/xlsx-attribute-order.spec.ts',
  // Added 2026-11-07 with A2–A5. The unit suite proves the RULE and the demo suite
  // proves the four scripts ASK — split that way on purpose, because a source scan
  // cannot tell a call that exists from a call that is REACHED, and `auth`'s refusal
  // has to land before `chromium.launch`. Both halves of the ambient check are here
  // (§W): a rule that refuses whenever TEST_ENV is set at all would pass A9 and make
  // the correct `TEST_ENV=app … --app dms` impossible.
  'tests/unit/application-env.spec.ts',
  'tests/demo/app-arg-cli.spec.ts',
  // Added 2026-11-07, and it earned its place on its first run: making `--app`
  // mandatory silently invalidated 35 messages and documents telling a human to run
  // a bare command, and this scan found 28 of them that hand-searching had missed.
  // R2 plants both halves, because over a clean tree a detector that matches nothing
  // and one that works are the same output.
  'tests/unit/app-arg-remedies.spec.ts',
  // Added 2026-11-07 with A6/A7. E2 and E3 are the pair that matters: the onboarding
  // refusal must fire for "declared but not walked" and must NOT fire for a corrupt
  // or missing-for-another-reason file, or it sends a reader to run `inspect` over a
  // problem that is something else. W2 is the planted-input half — the three real
  // @write specs are the known input W1's zero depends on being findable (§AA).
  'tests/unit/ecom-onboarding.spec.ts',
  'tests/unit/write-spec-scope.spec.ts',
  // Added 2026-11-07 with A1. L1 is the one that earns the file: the DMS layout now
  // exists in code AND in config, and a drift between them changes a VERDICT — the
  // reader takes every value from a position, so one changed number returns rows
  // populated from the wrong columns and they look exactly like data. L4 asserts the
  // refusal in BOTH directions, because the new config must not become a way around
  // the gate it replaced.
  'tests/unit/sheet-layout.spec.ts',
  // Added 2026-11-10 with B7. B7c and B7d are the pair that matters: a demo run must
  // not render like a customer run (the explicit §5 requirement), and a run with NO
  // target must say "unknown" rather than presenting the environment key as the
  // application — a confident wrong label being worse than an absent one.
  'tests/unit/report-scope.spec.ts',
  // Added 2026-11-10 with the notify config. N1-N4 are the identity cascade, PURE
  // and supplied (§AJ) — a version reading USERPRINCIPALNAME itself would test this
  // laptop. N6 is the three-states half: a broken config must never read as a
  // missing one, because the two call for opposite actions. N8 is the
  // must-not-refuse case that keeps the other refusals from being vacuous, and S5
  // pairs each CLI refusal with the invocation that differs only in that one thing.
  'tests/unit/notify-config.spec.ts',
  'tests/demo/notify-setup-cli.spec.ts',
  // Added 2026-11-10 with the email body. It found two real faults on its first run,
  // which is the argument for writing the counterfactuals first: the case-id column
  // was composed the wrong way round and rendered an em dash for every row, and
  // `previousRunRecord` returned the newest OTHER record rather than the newest
  // EARLIER one — correct only because the caller happens to always be the newest
  // run. B9 is the sentinel control, planted in both an env var and a real `.env`
  // inside the archived directory, because the body and the zip have different
  // protections and a test of one proves nothing about the other.
  'tests/unit/notify-body.spec.ts',
  // Added 2026-11-11 with the drop. D4 asserts the ORDER from the filesystem — the
  // zip before the ready file — because the flow triggers on the ready file and then
  // looks for the zip it names. D8 is the one that matters most: a mail that could
  // not be prepared must not change a suite's verdict. D12 and D13 are the pair the
  // fixture suppression needs: a fixture run with a folder CONFIGURED writes nothing
  // into it, and the test override redirects rather than merely permits — without
  // D13, D12 is satisfied by an implementation that can never notify at all.
  'tests/unit/notify-drop.spec.ts',
  // Added 2026-11-11: the drop as a REAL process. E1 and E2 are each other's
  // discriminating half — a real run writes into the overridden folder and never
  // into the configured one, and the same run without the override writes nothing
  // at all though a valid configuration is present. Four separate faults were
  // diagnosed by printing the CHILD's own exit code and output rather than by
  // reasoning about the code; the worst was `--reporter=line`, which replaces the
  // configured reporters so AitpReporter never ran, and which failed by exiting 0
  // with an empty folder.
  'tests/demo/notify-drop-e2e.spec.ts',
  // Added 2026-11-11 with the published schema. S3 is the half that matters: S1 over
  // a correct drop cannot tell a working validator from one that returns no problems
  // for anything, so each of the four drifts is planted — and the RENAME is planted
  // as both a missing field and an extra one, which is how a rename actually
  // arrives. S5 asks whether the validator can answer the question at all (§Z): a
  // schema keyword nobody implements is a constraint enforced by nobody.
  'tests/unit/ready-schema.spec.ts',
  // Added 2026-11-18 with the Ecom component library. N1 is the assertion a wrong
  // measurement produced: the create button's name begins with U+EB0B, a Private
  // Use glyph that LOOKS like a space, so `trim()` leaves it and an anchored regex
  // matched nothing — seven modules were reported as having no create control and
  // every one of them has one. W3 and W6 are the discriminating halves of the
  // write rule: a drawer that refused everything would pass every refusal test and
  // be unusable, and `Create` must be permitted OUTSIDE a dialog and refused
  // INSIDE it, which is a positional distinction no textual rule can make.
  'tests/unit/ecom-component-rules.spec.ts',
  // Added 2026-11-18 with the generated smoke manifest. M4 is the one that earns
  // its place: the manifest is derived from captures holding real customer data and
  // from the QA sheet, and it is the only artefact of this batch that enters the
  // repository, so it is SCANNED for the shapes a leak would take rather than
  // trusted to have been built carefully. M6 pins the single documented exception
  // as DATA rather than as a special case hidden in a spec.
  'tests/unit/ecom-smoke-manifest.spec.ts',
  // Added 2026-11-23 with ECOM-1a-fix. Both suites exist because the previous batch
  // reported two numbers it could not measure: annotations were dropped by the
  // reporter, so "sheet drift: 0" could not be told from "nobody looked", and the
  // per-test network records were attached INLINE, so run.json recorded
  // path: "inline" and sixty-two attached answers were unreadable. The
  // counterfactuals are mostly about the THREE STATES — absent, empty, some —
  // which both fields had collapsed to two.
  'tests/unit/run-network-summary.spec.ts',
  'tests/unit/reporter-annotations.spec.ts',
  'tests/demo/kit-integrity-cli.spec.ts',
  // Added 2026-10-08 with v0.4.1: the STANDALONE check, after a renamed package
  // folder made the v0.4 kit die with MODULE_NOT_FOUND and no KIT MODIFIED. Every
  // test here names the false pass — or the cryptic refusal — it exists to prevent.
  'tests/unit/kit-check-standalone.spec.ts',
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

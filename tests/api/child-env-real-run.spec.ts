import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { findRepoRoot } from '@aitp/shared';
import { buildChildEnv } from '../../apps/api/src/modules/runs/child-env';

/**
 * THE ENVIRONMENT B0 BUILDS IS SUFFICIENT FOR A REAL RUN — proven by doing one.
 *
 * B0 replaced `{ ...process.env }` with an allowlist and tested the RULE
 * thoroughly: `child-env.spec.ts` proves `ALLOW_WRITES` and every secret-shaped
 * name are dropped and the listed ones survive, and `api-hardening.spec.ts`
 * proves it holds across a real `spawn()`. **Not one of those tests launches a
 * browser.** So every one of them would stay green over an allowlist missing
 * something a Playwright run needs — a `PATH` that Windows spells `Path`, a
 * `LOCALAPPDATA` that Chromium is found under, a `TEMP` the browser writes to.
 *
 * That gap is this file. It is the same shape as the three failures this repo has
 * already recorded — the mock gateway, the stub executor, the inherited
 * environment — a verification that never met the conditions it claimed to
 * verify.
 *
 * ## Why it does not go through `POST /api/runs`
 *
 * Because that cannot work yet, and the reason is measured rather than assumed
 * (2026-10-12). Two independent blockers:
 *
 *  1. `AITP_FIXTURE_ONLY` is not on the allowlist — deliberately, since it
 *     describes how the PARENT was invoked — so `playwright.config.ts` selects
 *     `liveProjects`, which contains no `demo` project at all.
 *  2. `browsers` is `z.enum(['chromium','firefox','webkit'])`, so
 *     `--project=demo` cannot be requested. That one is not an environment
 *     variable, so no allowlist change reaches it.
 *
 * Neither is a B0 regression: the pre-B0 child env was measured on the same
 * question and gave the identical "No tests found", because nothing sets
 * `AITP_FIXTURE_ONLY` for a normally-started API either. Making the HTTP path
 * work belongs to the runs API (B2).
 *
 * So this calls `buildChildEnv` directly and hands the result to a real
 * Playwright run — which is the claim that was actually owed: not "the HTTP
 * route works" but "the environment this function produces can run a browser".
 */

const ROOT = findRepoRoot();
const PLAYWRIGHT_CLI = require.resolve('@playwright/test/cli');

/**
 * One existing, passing demo test, named exactly.
 *
 * `tests/demo/login.spec.ts:5`. Chosen because it is self-contained against the
 * bundled demo app on loopback — no credential, no customer system — and because
 * it drives a real browser, which is the whole point: a test that needed no
 * browser would leave the gap above exactly where it was.
 */
const DEMO_TEST = 'valid credentials sign the user in';
const EXPECTED_PASSED = 1;

/**
 * The overrides a run needs, separate from the inherited allowlist.
 *
 * `TEST_ENV` and `AITP_FIXTURE_ONLY` are set here rather than inherited for the
 * same reason `CommandService.listOnSurface` sets them: they decide which corpus
 * exists, and a child must be told that by its caller rather than absorb it from
 * whatever started the parent.
 *
 * `CI` is deliberately NOT set. `playwright.config.ts` reads it for
 * `reuseExistingServer: !isCI`, and this spawn usually happens inside a run that
 * already holds the demo server on 4173 — with `CI` set the child would refuse
 * to reuse it and fail on a bound port, which would look exactly like an
 * environment problem and be nothing of the kind.
 */
const RUN_OVERRIDES = { TEST_ENV: 'local', AITP_FIXTURE_ONLY: '1' };

interface ChildRun {
  status: number | null;
  output: string;
}

/**
 * A real Playwright run under an environment this test constructed.
 *
 * `--reporter=line` REPLACES the config's reporter array, so the child writes no
 * `run.json`, no `junit.xml` and no HTML report — otherwise it would clobber the
 * artifacts of the run that spawned it.
 *
 * `--output` IS NOT OPTIONAL, and leaving it off the control spawn is how that was
 * learned. Playwright WIPES its `outputDir` at the start of a run, and the config
 * points every project at `artifacts/test-results` — so a child run without this
 * flag deletes the artifacts of the parent run that spawned it, mid-run. The
 * symptom was an unrelated-looking `ENOENT … .playwright-artifacts-0/<hash>.zip`
 * as the parent tried to attach a trace that had just been removed underneath it.
 *
 * Which is why BOTH spawns go through this one function: the first draft inlined
 * the second one and forgot the flag. A rule applied at two call sites by hand
 * drifts at the second.
 */
function runDemoTest(overrides: Record<string, string>): ChildRun {
  const output = mkdtempSync(path.join(tmpdir(), 'aitp-child-env-run-'));
  const argv = [
    PLAYWRIGHT_CLI,
    'test',
    '--project=demo',
    `--grep=${DEMO_TEST}`,
    '--reporter=line',
    `--output=${output}`,
  ];
  try {
    // `env:` is INLINE and the argv is hoisted, so `buildChildEnv` falls inside the
    // twelve lines `no-unscrubbed-spawn.spec.ts` reads as one statement. The first
    // draft spelled the argv in place, put the sanctioned call seventeen lines down,
    // and was duly reported as an unscrubbed spawn — the detector was right and the
    // formatting was wrong, which is the correct way round.
    const result = spawnSync(process.execPath, argv, {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      env: buildChildEnv({ parent: process.env, overrides }),
    });
    return { status: result.status, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}

test.describe('the scrubbed child environment can run a real browser @api', () => {
  test.setTimeout(300_000);

  test('B0-5: a real demo run under buildChildEnv exits 0 with the test passed', () => {
    // wrong: an allowlist missing something a RUN needs — `Path` as Windows
    // spells it, `LOCALAPPDATA` where Chromium lives, `TEMP` the browser writes
    // to — produces a non-zero exit and 0 passed here, while every B0 child-env
    // test stays green, because not one of them launches a browser. That is the
    // gap this test exists to close, and nothing else in the suite can see it.
    const run = runDemoTest(RUN_OVERRIDES);

    expect(
      run.status,
      'the scrubbed child environment could not complete a real Playwright run.\n' +
        'The child output below names what it could not find — add that ONE key to\n' +
        'CHILD_ENV_ALLOWLIST with a stated reason, never a prefix:\n\n' +
        run.output.slice(-3000),
    ).toBe(0);

    // §T — it had a SUBJECT. Exit 0 is also what `--pass-with-no-tests` would
    // give, and "ran nothing successfully" is not the claim.
    expect(run.output, `the child reported no passing test:\n${run.output.slice(-2000)}`).toContain(
      `${EXPECTED_PASSED} passed`,
    );

    // THE CONTROL, and without it this test proves nothing.
    //
    // If `env:` above were ignored — a typo, a refactor, a spawn that inherited
    // the parent instead — the run would pass on the PARENT's environment and
    // this test would report success over an allowlist that was never used.
    // Dropping `AITP_FIXTURE_ONLY` from the overrides is the cheapest input with
    // a known, different answer.
    const ignored = runDemoTest({ TEST_ENV: 'local' });

    expect(
      ignored.status,
      'a run WITHOUT AITP_FIXTURE_ONLY succeeded, so the env passed above is not the\n' +
        'env the child received — the positive assertion is measuring the parent.',
    ).not.toBe(0);

    // AND IT FAILED FOR THE RIGHT REASON (§X). A non-zero exit is also what a
    // broken spawn, a missing CLI or a syntax error gives, and any of those would
    // satisfy the assertion above while proving nothing about the environment.
    //
    // This message is the specific one: without the flag, `playwright.config.ts`
    // selects `liveProjects`, so the `demo` project does not EXIST and Playwright
    // names the live list back. That the child enumerated the live projects is
    // direct evidence it received the environment constructed here rather than the
    // parent's — which is the whole claim.
    //
    // Measured and corrected: the first draft expected `No tests found`, carried
    // over from a `--project=chromium` measurement where the project does exist
    // and collects nothing. Same cause, different message, and asserting the wrong
    // one made a working control look broken.
    expect(
      ignored.output,
      `the control failed for an unexpected reason:\n${ignored.output}`,
    ).toContain('Project(s) "demo" not found');
    expect(ignored.output).toContain('live-setup');
  });
});

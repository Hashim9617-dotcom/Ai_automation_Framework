import path from 'node:path';
import { test, expect } from '@playwright/test';
import { findRepoRoot } from '@aitp/shared';
import { spawnSyncClean } from '../support/spawn-clean';

/**
 * A LIVE RUN AND A FIXTURE RUN SHARE NO PROJECT.
 *
 * SEC-3e stopped `.env` being merged into `pnpm test:unit`. It could not stop a bare
 * `pnpm test`, which has to resolve the real environment for the live projects and
 * therefore merges `.env` into every worker it starts — and it started 575 unit and
 * 24 demo workers alongside them. The guard in `no-real-env.spec.ts` duly failed
 * there, and failed honestly: in that invocation the fixture surface really did
 * carry the live DMS password.
 *
 * `fixtureOnlyRun()` now partitions `projects` in `playwright.config.ts`, so the two
 * sets are disjoint by construction rather than by which command was typed.
 *
 * ## Why this spawns twice
 *
 * The config is evaluated ONCE per process, under whatever mode that process is in.
 * This spec runs in fixture-only mode, so importing the config can only ever show it
 * the fixture half — the question "what does a LIVE invocation collect?" is not
 * answerable from in here. Two children, two modes, two listings.
 *
 * `spawnSyncClean` strips `AITP_FIXTURE_ONLY` (it is in `RUNNER_ONLY_VARS`), which
 * is what makes the live half reachable at all: a child inherits the live mode by
 * default and the fixture mode only when this file asks for it.
 */

const ROOT = findRepoRoot();
const CLI = path.join(ROOT, 'node_modules', '@playwright', 'test', 'cli.js');

interface Listing {
  /** Tests collected per project name, from the `[project] › file › title` prefix. */
  counts: Map<string, number>;
  output: string;
}

function list(args: readonly string[], extra: Record<string, string> = {}): Listing {
  const run = spawnSyncClean(
    process.execPath,
    [CLI, 'test', '--list', '--reporter=line', ...args],
    {
      cwd: ROOT,
      maxBuffer: 20 * 1024 * 1024,
      // LOG_LEVEL so this repo's own logger does not interleave with the listing, and
      // TEST_ENV pinned so the answer does not depend on the developer's `.env` — the
      // live half needs a NON-local name or no live environment resolves at all.
      env: { LOG_LEVEL: 'error', TEST_ENV: 'app', ...extra },
    },
  );
  const counts = new Map<string, number>();
  for (const line of `${run.stdout}\n${run.stderr}`.split(/\r?\n/)) {
    const match = /^\s+\[([a-z-]+)\]/.exec(line);
    if (!match?.[1]) continue;
    counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
  }
  return { counts, output: `${run.stdout}\n${run.stderr}` };
}

test.describe('the fixture surface is not in a live run @unit', () => {
  test.setTimeout(120_000);

  test('a live invocation collects no unit and no demo test', () => {
    // wrong: `[unit]` 575 and `[demo]` 24 appear in this listing, which is what a
    // bare `pnpm test` collected — the fixture surface inside a run that merges the
    // real `.env` into every worker.
    const live = list([]);

    // §T: assert the listing HAPPENED. Zero unit tests is also what a failed
    // invocation produces, and that is the flattering reading of the same output.
    expect(
      live.counts.get('chromium') ?? 0,
      `nothing was collected at all:\n${live.output}`,
    ).toBeGreaterThan(0);

    expect(live.counts.get('unit') ?? 0).toBe(0);
    expect(live.counts.get('demo') ?? 0).toBe(0);
  });

  test('the fixture invocation still collects both, in full', () => {
    // wrong: zero, because the partition removed the projects rather than moving
    // them — which the test above would report as a pass. A rule that refuses
    // everything is satisfied without knowing anything.
    const unit = list(['--project=unit'], { AITP_FIXTURE_ONLY: '1' });
    const demo = list(['--project=demo'], { AITP_FIXTURE_ONLY: '1' });

    // Not an exact number: the suite grows, and a test that has to be edited every
    // time a test is added gets edited without being read.
    expect(unit.counts.get('unit') ?? 0).toBeGreaterThan(500);
    expect(demo.counts.get('demo') ?? 0).toBeGreaterThan(20);
    // And the live projects are not in a fixture run either — the partition cuts
    // both ways, or `pnpm test:unit` would still be resolving a live environment.
    expect(unit.counts.get('chromium') ?? 0).toBe(0);
    expect(unit.counts.get('live-setup') ?? 0).toBe(0);
  });

  test('a documented `--project=chromium` still means chromium', () => {
    // wrong: the fix went into `package.json` as `playwright test --project=chromium
    // --project=firefox …`, and Playwright ACCUMULATES those flags — so this command,
    // which appears four times in docs/dms-suite.md and five times in
    // WHERE-WE-ARE.md, would have run every live project. That is why the partition
    // is in the config and not in the script.
    const listed = list(['--project=chromium']);

    expect(listed.counts.get('chromium') ?? 0).toBeGreaterThan(0);
    for (const other of ['firefox', 'webkit', 'mobile-chrome', 'api']) {
      expect(listed.counts.get(other) ?? 0, `${other} ran for a chromium-only command`).toBe(0);
    }
    // `live-setup` IS expected: it is a declared dependency of chromium, not an
    // accumulated flag, and omitting it would mean no sign-in before the suite.
    expect(listed.counts.get('live-setup') ?? 0).toBeGreaterThan(0);
  });

  test('asking for a fixture project the wrong way says which command to use', () => {
    // wrong: the reader gets only Playwright's `Project(s) "unit" not found.
    // Available projects: …` — correct, fail-closed, and silent about the one thing
    // they need, which is that the same tests are a different command away. Three
    // lines of WHERE-WE-ARE.md are this exact invocation.
    const refused = list(['--project=unit']);

    expect(refused.output).toContain('Project(s) "unit" not found');
    expect(refused.output).toContain('pnpm test:unit');
    expect(refused.output).toContain('SEC-3e');
  });
});

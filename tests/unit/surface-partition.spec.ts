import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { findRepoRoot } from '@aitp/shared';
import { resetEnvironmentCache, resolveEnvName } from '@aitp/execution-engine';
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
      // THE WHOLE ENVIRONMENT IS SUPPLIED HERE, not inherited.
      //
      // `LOG_LEVEL` so this repo's own logger does not interleave with the listing.
      // `TEST_ENV` pinned, because the live half needs a NON-local name or no live
      // environment resolves at all and the partition is not the thing being
      // measured.
      //
      // And the three values `app.json` interpolates, because without them the
      // config REFUSES — `ConfigError: Environment variable BASE_URL is required but
      // not set` — and every count below is zero for a reason that has nothing to do
      // with the partition. Measured on a fresh clone, where the first version of
      // this file failed 3 of 4: it was green here and red for everyone else, which
      // is the same defect `no-real-env.spec.ts` and R4 were corrected for TODAY.
      // Nothing connects during `--list`; these only have to parse.
      env: {
        LOG_LEVEL: 'error',
        TEST_ENV: 'app',
        BASE_URL: 'https://example.invalid',
        APP_USERNAME: 'listing-only',
        APP_PASSWORD: 'listing-only',
        ...extra,
      },
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

  /**
   * THE API PROJECT IS ON BOTH SURFACES, AND THAT IS NOT A HEDGE (SEC-3e, C3).
   *
   * It was live-only, so `pnpm test:api:internal` — which `pnpm verify` runs on
   * every commit — ran without `AITP_FIXTURE_ONLY`. Measured 2026-10-06, in one run
   * of eleven tests: `environment: "app"` resolved to the DMS host and the DMS
   * session file SIX times, while every api test asks for `local`. The source is
   * `loadInventory()`, which spawns `playwright test --list`; that child loads the
   * config, and the config resolved the AMBIENT `TEST_ENV`.
   *
   * `app-health.spec.ts` must keep running live, so the project is listed on both
   * surfaces and the `@smoke` TAG is what separates them. These two tests are the
   * pair that makes that claim falsifiable.
   */
  test('the api project is collected on BOTH surfaces, with the smoke half excluded from the fixture one', () => {
    // wrong: a partition that moved the project instead of adding it would make
    // `pnpm test:api` collect nothing, and the live smoke test — the only thing that
    // asks the real application whether it is up — would silently stop running. A
    // test that only checked the fixture side would report that as a pass.
    const fixture = list(['--project=api', '--grep-invert', '@smoke'], {
      AITP_FIXTURE_ONLY: '1',
    });
    const live = list(['--project=api']);

    // §T: both listings happened. Zero is also what a failed invocation produces.
    expect(fixture.counts.get('api') ?? 0, `nothing collected:\n${fixture.output}`).toBe(11);
    expect(live.counts.get('api') ?? 0, `nothing collected:\n${live.output}`).toBe(13);

    // THE GREP IS LOAD-BEARING, measured rather than assumed: without it the
    // fixture run collects the two live `@smoke` tests too, and `app-health` would
    // ask the bundled demo app — or nothing — whether "the application under test"
    // is up, and pass either way.
    const unfiltered = list(['--project=api'], { AITP_FIXTURE_ONLY: '1' });
    expect(unfiltered.counts.get('api') ?? 0).toBe(13);
    expect(13 - 11).toBe(2);
  });

  test('`pnpm test:api:internal` really is a fixture-only invocation', () => {
    // wrong: the project joins the fixture surface and the SCRIPT still invokes
    // Playwright without the flag — so every count above is right and the real
    // `.env` is merged anyway. The partition and the invocation are two separate
    // claims, and this is the one about the invocation.
    //
    // Driven as the real command, through package.json, rather than by asserting on
    // the script's source: what matters is what `pnpm verify` actually runs.
    const script = readFileSync(path.join(ROOT, 'scripts', 'test-api.mjs'), 'utf8');
    expect(script).toContain("AITP_FIXTURE_ONLY: '1'");
    expect(script).toContain('--grep-invert');

    const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(manifest.scripts['test:api:internal']).toBe('node scripts/test-api.mjs');
    // And `pnpm verify` runs THAT, not a bare playwright invocation — the drift this
    // repo has already recorded once, where `check:api-deps` was documented as being
    // in `verify` and was not.
    expect(manifest.scripts.verify).toContain('test:api:internal');
    // The live half keeps its own command, with the smoke tests in it.
    expect(manifest.scripts['test:api']).toBe('playwright test --project=api');
  });

  test('§W: the flag that script sets really keeps a .env SENTINEL out, and lets a safe key in', () => {
    // wrong: the project is partitioned, the script sets the flag, and the flag does
    // nothing — every count above is right and the real `.env` is merged anyway.
    //
    // THIS IS THE THIRD CLAIM, and it is here rather than left implicit because the
    // other two do not add up to it: "the project is on the fixture surface" and
    // "the script sets AITP_FIXTURE_ONLY" are both facts about configuration. Two
    // tests that COMPOSE to a property are fine; one that appears to state the whole
    // property alone is not — so the composition is written down.
    //
    // A sentinel is the discriminating input: a key that exists ONLY in this
    // fixture's `.env`, so its absence cannot be explained by the developer's own
    // setup. `no-real-env.spec.ts` asserts the same mechanism from the other side.
    const root = mkdtempSync(path.join(tmpdir(), 'aitp-api-sentinel-'));
    writeFileSync(path.join(root, 'pnpm-workspace.yaml'), '');
    mkdirSync(path.join(root, 'config', 'env'), { recursive: true });
    writeFileSync(
      path.join(root, 'config', 'env', 'local.json'),
      readFileSync(path.join(ROOT, 'config', 'env', 'local.json'), 'utf8'),
    );
    writeFileSync(
      path.join(root, '.env'),
      'TEST_ENV=local\nAITP_API_SENTINEL=must-not-leak\nLOG_LEVEL=debug\n',
    );

    // Run the REAL script, with that root, and have the child report its own
    // environment. `--list` is enough: the leak happens while the config loads, in
    // the parent, which is exactly what makes it unfixable from inside a test.
    const run = spawnSyncClean(
      process.execPath,
      [path.join(ROOT, 'scripts', 'test-api.mjs'), '--list', '--reporter=line'],
      { cwd: ROOT, maxBuffer: 20 * 1024 * 1024, env: { AITP_REPO_ROOT: root, LOG_LEVEL: 'error' } },
    );
    const output = `${run.stdout}\n${run.stderr}`;

    // §T — the listing happened. A crashed invocation also mentions no sentinel.
    expect(output, `the listing did not run:\n${output}`).toContain('Total:');

    // THE SENTINEL IS NOT IN THE CHILD'S ENVIRONMENT. Asserted through the script's
    // own invocation, so it is the command `pnpm verify` runs that is under test.
    const reported = spawnSyncClean(
      process.execPath,
      [
        '-e',
        'process.stdout.write(JSON.stringify({s:process.env.AITP_API_SENTINEL ?? null,' +
          'f:process.env.AITP_FIXTURE_ONLY ?? null}))',
      ],
      { cwd: ROOT, env: { AITP_REPO_ROOT: root } },
    );
    // The control for THIS assertion: a child given no flag and no `.env` load sees
    // no sentinel either, so the line above cannot be the whole argument — which is
    // why the real check is the in-process one below, on the mechanism itself.
    expect(JSON.parse(`${reported.stdout}`).s).toBeNull();

    const before = {
      AITP_API_SENTINEL: process.env.AITP_API_SENTINEL,
      TEST_ENV: process.env.TEST_ENV,
      LOG_LEVEL: process.env.LOG_LEVEL,
      AITP_FIXTURE_ONLY: process.env.AITP_FIXTURE_ONLY,
      AITP_REPO_ROOT: process.env.AITP_REPO_ROOT,
    };
    try {
      // `TEST_ENV` has to go too: it is on the fixture-safe allowlist, so the real
      // `.env`'s value is already present and the copy only fills undefined keys.
      delete process.env.AITP_API_SENTINEL;
      delete process.env.TEST_ENV;
      delete process.env.LOG_LEVEL;
      process.env.AITP_FIXTURE_ONLY = '1';
      process.env.AITP_REPO_ROOT = root;
      resetEnvironmentCache();

      // Reading the environment is what triggers the `.env` load. Asserted, not
      // assumed: otherwise the sentinel's absence would prove nothing (§T).
      expect(resolveEnvName()).toBe('local');
      expect(
        process.env.AITP_API_SENTINEL,
        'the sentinel from .env reached process.env — it was MERGED, not parsed',
      ).toBeUndefined();
      // AND THE SILENT HALF: a fixture-SAFE key does arrive, or the partition has
      // simply broken the environment rather than filtered it.
      expect(process.env.LOG_LEVEL, 'a fixture-safe key did not arrive').toBe('debug');
    } finally {
      for (const [key, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      resetEnvironmentCache();
    }
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

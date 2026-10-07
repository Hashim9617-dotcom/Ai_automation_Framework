import { existsSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import type { AitpProjectOptions } from './packages/execution-engine/src/fixtures/core';
import {
  ambientEnvName,
  authStatePath,
  FIXTURE_ENV_NAME,
  fixtureOnlyRun,
  isFixtureEnv,
  loadEnvironment,
} from './packages/execution-engine/src/config/environment';
import { describeTarget } from './packages/shared/src/command/target';

const isCI = Boolean(process.env.CI);

/**
 * SEC-3a: WHICH SURFACE decides the target, not the ambient environment.
 *
 * The `demo` project is PINNED to `local`. It cannot be redirected by
 * `TEST_ENV`, because it never asks what `TEST_ENV` says — the name is a
 * literal here. Before this, `tests/demo` ran under whatever the ambient
 * environment happened to be, and with `.env` holding `TEST_ENV=app` that was
 * the customer system.
 */
const demoEnv = loadEnvironment(FIXTURE_ENV_NAME);

/**
 * The ambient environment, or `undefined` — deliberately NOT demanded here.
 *
 * This file is loaded for every invocation, including one that only touches
 * fixture projects. Demanding a name here would refuse a demo run for lacking
 * something a demo run does not use, and would leave the pinned project pinned
 * to nothing. The refusal belongs where a live surface can be told from a
 * fixture one, which is `tests/support/live-setup.ts` — a setup project only
 * live projects depend on.
 */
const ambientName = ambientEnvName();
/**
 * A FIXTURE-ONLY RUN RESOLVES NO LIVE ENVIRONMENT.
 *
 * SEC-3e, and it is the half the flag could not fix on its own: with `.env` no longer
 * merged, `loadEnvironment('app')` here refused on `${BASE_URL}` and took the whole
 * unit suite with it — `CONFIG_ERROR: BASE_URL` before a single test ran.
 *
 * The refusal was correct and the question was wrong. A unit or demo run never uses
 * `liveEnv`: it exists to give the live projects their `testMatch` and `storageState`,
 * and `liveTestMatch` already handles `undefined` by matching nothing. So resolving it
 * was work a fixture run had no reason to do — and doing it meant a unit suite could
 * not run on a machine with no customer credentials at all.
 */
const liveEnv =
  !fixtureOnlyRun() && ambientName && !isFixtureEnv(ambientName)
    ? loadEnvironment(ambientName)
    : undefined;

/** Values the config needs before any project is chosen. Fixture-safe. */
const base = liveEnv ?? demoEnv;

// A session saved by `pnpm auth` (or, automatically, by the `setup` project
// below) means tests start logged in — which is how the platform supports
// SSO/MFA providers that cannot sensibly be scripted. Never applied to
// `local`: the bundled demo app tests the login flow itself.
//
// Deliberately NOT gated on existsSync(savedSession): the `setup` project is
// a `dependencies` of every browser project for a real environment, so it
// always runs and writes this file before any browser project opens a
// context — including on a first-ever checkout where the file does not exist
// yet at config-load time. Gating on existsSync here would have frozen
// `storageState` at `undefined` for that whole run, permanently missing the
// session `setup` was about to create.
const savedSession = liveEnv ? authStatePath(liveEnv) : undefined;

/**
 * A LIVE PROJECT COLLECTS ONE APPLICATION'S SPECS, BY PATH.
 *
 * `tests/app/` held six specs and seven page objects, every one of them describing
 * DmsSynergy — its sidebar, its upload wizard, its admin screens — and nothing said
 * so. The split was demo-vs-live, so ANY non-local environment collected all of it:
 * measured 2026-09-30 with a second application declared as `app2`, `--list`
 * returned 47 tests, every one a DMS spec. A QA adding their own application would
 * have driven DMS's page objects against it, `@write` tests included.
 *
 * K2 answered that with a comparison here — hold the suite unless
 * `application === 'dms'`. This replaces the comparison with STRUCTURE: the specs
 * moved to `tests/apps/dms/`, and a project collects `tests/apps/<application>/`.
 * There is no list to keep and no condition to get wrong; an application with no
 * directory collects nothing because there is nothing at that path.
 *
 * `testMatch` rather than `testIgnore`, which is the substance of the change: an
 * ignore list has to name everything that does not belong, so the next directory
 * added is included by default — fail-open, the shape this repo has now corrected
 * five times. A match names what DOES belong.
 */
const liveTestMatch = liveEnv
  ? `**/tests/apps/${liveEnv.application}/**/*.spec.ts`
  : // No live environment resolved, so no live project will run. A pattern that
    // matches nothing is the honest value; `undefined` would mean "match the
    // default", which is every spec in the repo.
    '**/__no_live_environment__/**';

if (liveEnv && !existsSync(path.join(__dirname, 'tests', 'apps', liveEnv.application))) {
  // A SENTENCE, not silence. Zero collected specs with no explanation reads as a
  // broken config, and the next thing someone does is start deleting patterns.
  //
  // The count it prints will not be zero, and saying so is the difference between a
  // message and a puzzle: every browser project depends on `live-setup`, whose own
  // `testMatch` picks up the sign-in and the environment-name guard. Both are
  // application-agnostic — a manual sign-in works anywhere — so they stay.
  process.stderr.write(
    `\nNo specs for application "${liveEnv.application}": tests/apps/${liveEnv.application}/ ` +
      'does not exist.\n' +
      'The two tests still listed are the sign-in setup and the environment-name ' +
      'guard, which are not application-specific.\n' +
      'Unit and API tests are unaffected; run them with --project=unit or --project=api.\n\n',
  );
}

/**
 * THE FIXTURE SURFACE. No credential, no customer system, nothing beyond 4173.
 *
 * `demo` is pinned to `local`: its target is a literal in this file, so no ambient
 * value can redirect it, and it does not depend on `live-setup` — so selecting it
 * never runs the live sign-in. That absence is the point of SEC-3a, and it is
 * checked by looking for the marker `live-setup` writes rather than by looking for
 * nothing.
 */
const fixtureProjects = [
  {
    name: 'demo',
    testMatch: '**/tests/demo/**/*.spec.ts',
    use: {
      ...devices['Desktop Chrome'],
      // The pin, carried all the way to the tests: this is what the `env`
      // fixture resolves, not whatever TEST_ENV says.
      environmentName: FIXTURE_ENV_NAME,
      baseURL: demoEnv.baseUrl,
      actionTimeout: demoEnv.timeouts.action,
      navigationTimeout: demoEnv.timeouts.navigation,
      // The bundled app tests the login flow itself; a saved session would
      // skip the thing under test.
      storageState: undefined,
    },
  },
  {
    // Pure logic tests for the framework and platform code — no browser, no app.
    name: 'unit',
    testMatch: '**/unit/**/*.spec.ts',
    use: {},
  },
  /**
   * THE API PROJECT'S BROWSERLESS HALF, on the fixture surface (SEC-3e).
   *
   * It was only in `liveProjects`, so `pnpm test:api:internal` — which `pnpm verify`
   * runs on every commit — ran without `AITP_FIXTURE_ONLY`. Measured: the real
   * `.env` was merged into the runner, and `environment: "app"` resolved to the DMS
   * host and the DMS session file SIX times in one run.
   *
   * The source was never the api tests themselves (all of them ask for `local`). It
   * is `loadInventory()`: it spawns `playwright test --list`, that child loads this
   * file, and this file resolved the AMBIENT `TEST_ENV` rather than the environment
   * the request asked for.
   *
   * **Third instance of one pattern**, and that is why it gets a partition rather
   * than a patch: `NODE_PATH` inherited from the runner, `TEST_ENV` inherited by the
   * inventory listing, and now the environment inherited by the listing's own config
   * load. Every time, a child re-resolved the environment from ambient state instead
   * of from what its caller asked for.
   *
   * It is listed on BOTH surfaces deliberately. `app-health.spec.ts` asks the real
   * application whether it is up and must keep running live under `pnpm test:api`;
   * `scripts/test-api.mjs` excludes it from the fixture run by its `@smoke` tag. The
   * partition decides which ENVIRONMENT the project resolves, and the tag decides
   * which TESTS want a live one — two different questions, so the grep is not
   * redundant with the partition and removing it would collect a live smoke test
   * into a fixture run.
   */
  {
    name: 'api',
    testMatch: '**/api/**/*.spec.ts',
    use: {},
  },
];

/** The live surface. Every one of these resolves the real environment. */
const liveProjects = [
  /**
   * Every LIVE project depends on this, and only live projects do. It is where
   * "no environment was named" becomes a refusal, because it is the first point in
   * a run that knows a live surface was asked for.
   */
  {
    name: 'live-setup',
    testMatch: /live-setup.ts|auth.setup.ts/,
    use: { storageState: undefined },
  },

  {
    name: 'chromium',
    testMatch: liveTestMatch,
    dependencies: ['live-setup'],
    use: {
      ...devices['Desktop Chrome'],
      ...(savedSession ? { storageState: savedSession } : {}),
    },
  },
  {
    name: 'firefox',
    testMatch: liveTestMatch,
    dependencies: ['live-setup'],
    use: {
      ...devices['Desktop Firefox'],
      ...(savedSession ? { storageState: savedSession } : {}),
    },
  },
  {
    name: 'webkit',
    testMatch: liveTestMatch,
    dependencies: ['live-setup'],
    use: {
      ...devices['Desktop Safari'],
      ...(savedSession ? { storageState: savedSession } : {}),
    },
  },
  {
    name: 'mobile-chrome',
    testMatch: liveTestMatch,
    dependencies: ['live-setup'],
    use: { ...devices['Pixel 7'], ...(savedSession ? { storageState: savedSession } : {}) },
  },
  {
    // API-only project: no browser is launched, tests use the `api` fixture.
    //
    // LIVE deliberately: `app-health.spec.ts` asks the application under test
    // whether it is up, so this project reads the real environment. Its browserless
    // half is reached by `test:api:internal`, which is what `pnpm verify` runs.
    name: 'api',
    testMatch: '**/api/**/*.spec.ts',
    use: {},
  },
];

/**
 * A SENTENCE WHEN A FIXTURE PROJECT IS ASKED FOR BY THE WRONG COMMAND.
 *
 * Playwright already refuses — `Project(s) "unit" not found. Available projects:
 * "live-setup", "chromium", …` — which is fail-closed and loud, and says nothing
 * about what to type instead. Three commands in `docs/WHERE-WE-ARE.md` are exactly
 * this, and so is habit.
 *
 * The decision is NOT taken here: this only prints. A name this misses still gets
 * Playwright's refusal, so the hand-written list below can only degrade a message,
 * never open a gate (§AE).
 */
if (!fixtureOnlyRun()) {
  const requested = new Set<string>();
  for (const [index, arg] of process.argv.entries()) {
    if (arg.startsWith('--project=')) requested.add(arg.slice('--project='.length));
    else if (arg === '--project') requested.add(process.argv[index + 1] ?? '');
  }
  for (const [name, command] of [
    ['unit', 'pnpm test:unit'],
    ['demo', 'pnpm test:demo'],
  ] as const) {
    if (!requested.has(name)) continue;
    process.stderr.write(
      `\nThe "${name}" project is not part of a live run, by design: a run that resolves the\n` +
        `real environment merges .env into every worker, and the fixture surface has no use\n` +
        `for a live credential (SEC-3e).\n` +
        `  Run \`${command}\` instead — same tests, with .env parsed rather than merged.\n\n`,
    );
  }
}

/**
 * One config, every environment. Environment-specific values (URLs, timeouts,
 * retries, workers, feature flags) come from config/env/<TEST_ENV>.json so this
 * file never needs to change when a new environment is added.
 */
export default defineConfig<AitpProjectOptions>({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  outputDir: './artifacts/test-results',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? Math.max(base.retries, 1) : base.retries,
  workers: isCI ? Math.min(base.workers, 4) : base.workers,
  timeout: base.timeouts.test,
  globalSetup: './tests/support/global-setup.ts',

  expect: {
    timeout: base.timeouts.expect,
  },

  reporter: [
    ['list'],
    ['html', { outputFolder: './artifacts/reports/html', open: 'never' }],
    ['junit', { outputFile: './artifacts/reports/junit.xml' }],
    [
      './packages/reporting-engine/src/reporters/aitp-reporter.ts',
      {
        outputDir: './artifacts/reports',
        // From the SAME `env` that sets use.baseURL below, so run.json records
        // the URL the browsers were actually pointed at, next to its label.
        // SEC-2: the label alone could not show `local` resolving to a
        // customer system.
        target: describeTarget(base.name, base.baseUrl),
      },
    ],
  ],

  use: {
    baseURL: base.baseUrl,
    actionTimeout: base.timeouts.action,
    navigationTimeout: base.timeouts.navigation,
    testIdAttribute: process.env.TEST_ID_ATTRIBUTE ?? 'data-testid',
    trace: base.features.trace ? 'retain-on-failure' : 'off',
    video: base.features.video ? 'retain-on-failure' : 'off',
    screenshot: 'only-on-failure',
    ignoreHTTPSErrors: true,
    locale: 'en-US',
    timezoneId: 'Asia/Dubai',
  },

  /**
   * THE TWO SURFACES ARE NEVER IN THE SAME RUN (SEC-3e, second half).
   *
   * A bare `pnpm test` collected 575 unit and 24 demo tests alongside the live ones.
   * It HAS to resolve the real environment for the live projects, so it merges
   * `.env` into every worker — and the fixture projects were in that run, carrying
   * the live DMS password and API key into tests that have no use for either. The
   * invocation flag fixed `pnpm test:unit`; it could not fix an invocation that
   * legitimately needs the live surface.
   *
   * So the flag partitions the PROJECT LIST, and the two sets are disjoint by
   * construction. No invocation can mix them, including one typed by hand — which
   * is the residue named when the flag was added, now closed.
   *
   * ## Why here and not in `package.json`
   *
   * The obvious fix is `playwright test --project=chromium --project=firefox …` in
   * the `test` script. Measured before writing it, and it is wrong: Playwright
   * ACCUMULATES repeated `--project` flags, so `pnpm test --project=chromium` —
   * four commands in `docs/dms-suite.md` and five in `WHERE-WE-ARE.md` — would have
   * run every live project instead of chromium. Negation would have expressed it,
   * and 1.62.1 does not have it:
   *
   *     Error: Project(s) "!unit", "!demo" not found.
   *
   * Partitioning here costs those nine commands nothing.
   */
  projects: fixtureOnlyRun() ? fixtureProjects : liveProjects,

  // Serves the bundled demo app for the pinned `demo` project. Started from the
  // pinned URL, not from whatever the ambient environment resolved to.
  //
  // ONLY for a fixture run, now that a live run cannot contain the demo project:
  // starting a server for a project that is not in the list is work nobody asked
  // for, and it binds port 4173 on a machine running a live suite.
  webServer: fixtureOnlyRun()
    ? {
        command: 'node scripts/serve-demo.mjs',
        url: `${demoEnv.baseUrl}/login`,
        reuseExistingServer: !isCI,
        timeout: 30_000,
      }
    : undefined,
});

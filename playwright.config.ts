import { existsSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import type { AitpProjectOptions } from './packages/execution-engine/src/fixtures/core';
import {
  ambientEnvName,
  authStatePath,
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
const demoEnv = loadEnvironment('local');

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
const liveEnv = ambientName && ambientName !== 'local' ? loadEnvironment(ambientName) : undefined;

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

  projects: [
    /**
     * THE FIXTURE PROJECT. Pinned to `local`, and depends on nothing.
     *
     * Its target is a literal in this file, so no ambient value can redirect
     * it, and it does not depend on `live-setup` — so selecting it never runs
     * the live sign-in. That absence is the point of SEC-3a, and it is checked
     * by looking for the marker `live-setup` writes rather than by looking for
     * nothing.
     */
    {
      name: 'demo',
      testMatch: '**/tests/demo/**/*.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        // The pin, carried all the way to the tests: this is what the `env`
        // fixture resolves, not whatever TEST_ENV says.
        environmentName: 'local',
        baseURL: demoEnv.baseUrl,
        actionTimeout: demoEnv.timeouts.action,
        navigationTimeout: demoEnv.timeouts.navigation,
        // The bundled app tests the login flow itself; a saved session would
        // skip the thing under test.
        storageState: undefined,
      },
    },

    /**
     * Every LIVE project depends on this, and only live projects do. It is
     * where "no environment was named" becomes a refusal, because it is the
     * first point in a run that knows a live surface was asked for.
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
      name: 'api',
      testMatch: '**/api/**/*.spec.ts',
      use: {},
    },
    {
      // Pure logic tests for the framework and platform code — no browser, no app.
      name: 'unit',
      testMatch: '**/unit/**/*.spec.ts',
      use: {},
    },
  ],

  // Serves the bundled demo app for the pinned `demo` project. Started from the
  // pinned URL, not from whatever the ambient environment resolved to.
  webServer: {
    command: 'node scripts/serve-demo.mjs',
    url: `${demoEnv.baseUrl}/login`,
    reuseExistingServer: !isCI,
    timeout: 30_000,
  },
});

import { defineConfig, devices } from '@playwright/test';
import {
  authStatePath,
  loadEnvironment,
} from './packages/execution-engine/src/config/environment';

const env = loadEnvironment();
const isCI = Boolean(process.env.CI);

// `local` runs the bundled demo app; every other environment runs the specs
// written against the real application. Mixing them would point HR demo tests
// at a customer's system.
const isDemoEnvironment = env.name === 'local';

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
const savedSession = authStatePath(env.name);
const storageState = isDemoEnvironment ? undefined : savedSession;
const browserTestIgnore = [
  '**/api/**',
  '**/unit/**',
  isDemoEnvironment ? '**/tests/app/**' : '**/tests/demo/**',
];

/**
 * One config, every environment. Environment-specific values (URLs, timeouts,
 * retries, workers, feature flags) come from config/env/<TEST_ENV>.json so this
 * file never needs to change when a new environment is added.
 */
export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  outputDir: './artifacts/test-results',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? Math.max(env.retries, 1) : env.retries,
  workers: isCI ? Math.min(env.workers, 4) : env.workers,
  timeout: env.timeouts.test,
  globalSetup: './tests/support/global-setup.ts',

  expect: {
    timeout: env.timeouts.expect,
  },

  reporter: [
    ['list'],
    ['html', { outputFolder: './artifacts/reports/html', open: 'never' }],
    ['junit', { outputFile: './artifacts/reports/junit.xml' }],
    ['./packages/reporting-engine/src/reporters/aitp-reporter.ts', { outputDir: './artifacts/reports' }],
  ],

  use: {
    baseURL: env.baseUrl,
    actionTimeout: env.timeouts.action,
    navigationTimeout: env.timeouts.navigation,
    testIdAttribute: process.env.TEST_ID_ATTRIBUTE ?? 'data-testid',
    ...(storageState ? { storageState } : {}),
    trace: env.features.trace ? 'retain-on-failure' : 'off',
    video: env.features.video ? 'retain-on-failure' : 'off',
    screenshot: 'only-on-failure',
    ignoreHTTPSErrors: true,
    locale: 'en-US',
    timezoneId: 'Asia/Dubai',
  },

  projects: [
    // Logs in via LoginPage + APP_USERNAME/APP_PASSWORD and writes a fresh
    // artifacts/auth/<env>.json before the browser projects run. Only needed
    // against a real app — `local` runs the bundled demo, which has its own
    // login-flow tests and no APP_USERNAME/PASSWORD to log in with. This is
    // what lets the suite (~19 minutes) outlive DmsSynergy's 15-minute
    // refresh_token TTL: every run starts from a guaranteed-fresh session
    // instead of whatever `pnpm auth` last saved. `pnpm auth` is still there,
    // unchanged, for SSO/MFA/OTP logins this can't script.
    ...(isDemoEnvironment
      ? []
      : [
          {
            name: 'setup',
            testMatch: /auth\.setup\.ts/,
            // Never start from a stale/expired saved session — this project's
            // whole job is to produce a fresh one.
            use: { storageState: undefined },
          },
        ]),
    {
      name: 'chromium',
      testIgnore: browserTestIgnore,
      dependencies: isDemoEnvironment ? [] : ['setup'],
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      testIgnore: browserTestIgnore,
      dependencies: isDemoEnvironment ? [] : ['setup'],
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'webkit',
      testIgnore: browserTestIgnore,
      dependencies: isDemoEnvironment ? [] : ['setup'],
      use: { ...devices['Desktop Safari'] },
    },
    {
      name: 'mobile-chrome',
      testIgnore: browserTestIgnore,
      dependencies: isDemoEnvironment ? [] : ['setup'],
      use: { ...devices['Pixel 7'] },
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

  // Starts the bundled demo app so a fresh clone can run the suite immediately.
  // Remove or point elsewhere once you target the real application.
  webServer: isDemoEnvironment && env.baseUrl.includes('127.0.0.1:4173')
    ? {
        command: 'node scripts/serve-demo.mjs',
        url: 'http://127.0.0.1:4173/login',
        reuseExistingServer: !isCI,
        timeout: 30_000,
      }
    : undefined,
});

import { test as base } from '@playwright/test';
import { type Logger, rootLogger } from '@aitp/shared';
import { loadEnvironment } from '../config/environment';
import type { EnvironmentConfig } from '../config/schema';
import { ApiClient } from '../api/api-client';
import { dataFactory } from '../data/factory';

/**
 * Fixtures with no browser dependency. API-layer tests use these alone, which is
 * what keeps the `api` project from launching Chromium it never needs.
 */
export interface CoreFixtures {
  env: EnvironmentConfig;
  log: Logger;
  api: ApiClient;
  data: typeof dataFactory;
}

/**
 * Options a PROJECT sets, so a pinned target reaches the tests (SEC-3a).
 *
 * Pinning `baseURL` in the config was not enough: everything a test reads from
 * `env` — credentials, timeouts, the application slug — came from a SECOND,
 * ambient resolution inside this worker fixture. Measured: with the fixture
 * still ambient, the demo suite ran with the demo's URL and the live
 * environment's config, and all twelve tests failed. A half-pinned target is
 * not pinned.
 */
export interface AitpProjectOptions {
  /** The environment a project is pinned to. Unset means "ask the ambient one". */
  environmentName: string | undefined;
}

export const coreTest = base.extend<
  CoreFixtures,
  { workerEnv: EnvironmentConfig } & AitpProjectOptions
>({
  environmentName: [undefined, { scope: 'worker', option: true }],

  workerEnv: [
    async ({ environmentName }, use) => {
      // A project that names its environment gets that one, whatever the
      // ambient value says. A project that does not falls through to
      // resolveEnvName(), which REFUSES rather than assuming a live system.
      await use(environmentName ? loadEnvironment(environmentName) : loadEnvironment());
    },
    { scope: 'worker' },
  ],

  env: async ({ workerEnv }, use) => {
    await use(workerEnv);
  },

  // eslint-disable-next-line no-empty-pattern
  log: async ({}, use, testInfo) => {
    await use(rootLogger.child(testInfo.title.slice(0, 60)));
  },

  // eslint-disable-next-line no-empty-pattern
  data: async ({}, use) => {
    await use(dataFactory);
  },

  api: async ({ playwright, env }, use) => {
    const baseURL = env.apiBaseUrl ?? env.baseUrl;
    const context = await playwright.request.newContext({ baseURL, ignoreHTTPSErrors: true });
    await use(new ApiClient(context, baseURL));
    await context.dispose();
  },
});

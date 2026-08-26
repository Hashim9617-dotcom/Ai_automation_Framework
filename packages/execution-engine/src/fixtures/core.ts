import { test as base } from '@playwright/test';
import { Logger, rootLogger } from '@aitp/shared';
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

export const coreTest = base.extend<CoreFixtures, { workerEnv: EnvironmentConfig }>({
  workerEnv: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      await use(loadEnvironment());
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

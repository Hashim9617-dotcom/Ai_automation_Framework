import { expect, type Page } from '@playwright/test';
import { sanitizeUrl, type LocatorResolution } from '@aitp/shared';
import type { EnvironmentConfig } from '../config/schema';
import type { SmartLocatorOptions } from '../locators/smart-locator';
import { captureDomSnapshot } from '../dom/snapshot';
import { coreTest, type CoreFixtures } from './core';

export interface Diagnostics {
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: string[];
}

export interface UiFixtures {
  /** Every locator resolution in this test — feeds the healing history and the dashboard. */
  locatorTelemetry: LocatorResolution[];
  /** Locator options handed to every page object: telemetry plus the Phase 2 healing hook. */
  smartLocatorOptions: SmartLocatorOptions;
  /** Console/page/network problems captured automatically; attached on failure for RCA. */
  diagnostics: Diagnostics;
  /** Page-object factory: `const login = makePage(LoginPage)`. */
  makePage: <T>(
    Ctor: new (page: Page, env: EnvironmentConfig, options: SmartLocatorOptions) => T,
  ) => T;
}

export type AitpFixtures = CoreFixtures & UiFixtures;

/** UI test entry point. Import this instead of `@playwright/test` in specs. */
export const test = coreTest.extend<UiFixtures>({
  // eslint-disable-next-line no-empty-pattern
  locatorTelemetry: async ({}, use, testInfo) => {
    const telemetry: LocatorResolution[] = [];
    await use(telemetry);

    // Attached when a fallback fired (early warning of selector rot) and always on
    // failure, because the analyzer needs to know which locators were involved.
    const usedFallback = telemetry.some((entry) => entry.usedCandidateIndex !== 0);
    const failed = testInfo.status !== testInfo.expectedStatus;
    if (usedFallback || (failed && telemetry.length > 0)) {
      await testInfo.attach('locator-telemetry.json', {
        body: JSON.stringify(telemetry, null, 2),
        contentType: 'application/json',
      });
    }
  },

  smartLocatorOptions: async ({ locatorTelemetry, env }, use) => {
    await use({
      // Only the primary and last candidate in a chain need this — see fallbackCandidateTimeout.
      candidateTimeout: Math.min(env.timeouts.action, Number(process.env.LOCATOR_CANDIDATE_TIMEOUT ?? 2_000)),
      // Deliberately short: a demoted middle candidate should fail fast so the
      // chain can reach a working one without burning the test's budget — see
      // SmartLocatorOptions.fallbackCandidateTimeout for why this excludes the
      // primary candidate.
      fallbackCandidateTimeout: Number(process.env.LOCATOR_FALLBACK_TIMEOUT_MS ?? 750),
      onResolved: (resolution) => locatorTelemetry.push(resolution),
      // Phase 2: wire the self-healing engine in here — no page object changes needed.
      // onHealRequested: (spec) => aiEngine.healing.heal({ spec, snapshot }),
    });
  },

  diagnostics: [
    async ({ page }, use, testInfo) => {
      const diagnostics: Diagnostics = { consoleErrors: [], pageErrors: [], failedRequests: [] };

      // A page in a retry loop against a broken endpoint can emit thousands of
      // these. Bounded here so neither memory nor run.json grows without limit.
      const LIMIT = 200;
      const push = (target: string[], entry: string): void => {
        if (target.length < LIMIT) target.push(entry);
      };

      page.on('console', (message) => {
        if (message.type() === 'error') push(diagnostics.consoleErrors, message.text());
      });
      page.on('pageerror', (error) => push(diagnostics.pageErrors, error.message));
      page.on('requestfailed', (request) => {
        push(
          diagnostics.failedRequests,
          `${request.method()} ${sanitizeUrl(request.url())} — ${request.failure()?.errorText ?? 'failed'}`,
        );
      });
      page.on('response', (response) => {
        if (response.status() >= 500) {
          push(diagnostics.failedRequests, `${response.status()} ${sanitizeUrl(response.url())}`);
        }
      });

      await use(diagnostics);

      if (testInfo.status === testInfo.expectedStatus) return;

      const hasSignal =
        diagnostics.consoleErrors.length > 0 ||
        diagnostics.pageErrors.length > 0 ||
        diagnostics.failedRequests.length > 0;

      // Guarded separately: if attaching diagnostics throws, the DOM snapshot
      // below — the single most valuable analysis input — must still be captured.
      if (hasSignal) {
        try {
          await testInfo.attach('diagnostics.json', {
            body: JSON.stringify(diagnostics, null, 2),
            contentType: 'application/json',
          });
        } catch {
          // Test already torn down; nothing to attach to.
        }
      }

      // The page is still alive during this teardown, which is the only window in
      // which the DOM can be captured. Analysis itself happens later, out of band —
      // a failing run should never wait on an LLM.
      //
      // Raced against a timeout on purpose: if the test failed *because* the
      // renderer is wedged, page.evaluate never settles and never rejects, and an
      // unguarded await here would hang the worker until Playwright kills it,
      // taking the other attachments with it.
      try {
        const snapshot = await Promise.race([
          captureDomSnapshot(page, { maxElements: 120 }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('DOM snapshot timed out')), 5_000),
          ),
        ]);
        await testInfo.attach('dom-snapshot.json', {
          body: JSON.stringify(snapshot),
          contentType: 'application/json',
        });
      } catch {
        // Page closed, navigated away, crashed, or wedged — nothing to capture.
      }
    },
    { auto: true },
  ],

  makePage: async ({ page, env, smartLocatorOptions }, use) => {
    await use((Ctor) => new Ctor(page, env, smartLocatorOptions));
  },
});

/** API-layer entry point: no browser is launched. */
export const apiTest = coreTest;

export { expect };

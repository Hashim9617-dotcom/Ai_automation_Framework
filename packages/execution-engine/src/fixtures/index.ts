import { expect, type Page } from '@playwright/test';
import {
  checkHealingEligibility,
  sanitizeUrl,
  type LocatorResolution,
  type LocatorResolutionError,
  type LocatorSpec,
} from '@aitp/shared';
import type { EnvironmentConfig } from '../config/schema';
import type { SmartLocatorOptions } from '../locators/smart-locator';
import { captureDomSnapshot } from '../dom/snapshot';
import { captureAccessibilityTree } from '../dom/accessibility-snapshot';
import { coreTest, type CoreFixtures } from './core';

export interface Diagnostics {
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: string[];
}

export interface LocatorFailure {
  spec: LocatorSpec;
  error: LocatorResolutionError;
}

export interface UiFixtures {
  /** Every locator resolution in this test — feeds the healing history and the dashboard. */
  locatorTelemetry: LocatorResolution[];
  /** Every exhausted-chain failure in this test — input to the healing gate at teardown. */
  locatorFailures: LocatorFailure[];
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

  // eslint-disable-next-line no-empty-pattern
  locatorFailures: async ({}, use) => {
    await use([]);
  },

  smartLocatorOptions: async ({ locatorTelemetry, locatorFailures, env }, use) => {
    await use({
      // Only the primary and last candidate in a chain need this — see fallbackCandidateTimeout.
      candidateTimeout: Math.min(env.timeouts.action, Number(process.env.LOCATOR_CANDIDATE_TIMEOUT ?? 2_000)),
      // Deliberately short: a demoted middle candidate should fail fast so the
      // chain can reach a working one without burning the test's budget — see
      // SmartLocatorOptions.fallbackCandidateTimeout for why this excludes the
      // primary candidate.
      fallbackCandidateTimeout: Number(process.env.LOCATOR_FALLBACK_TIMEOUT_MS ?? 750),
      onResolved: (resolution) => locatorTelemetry.push(resolution),
      // Self-healing (docs/phase-2-healing.md) never resolves a locator live —
      // this only records the failure for the gate to evaluate at teardown.
      onResolutionFailed: (spec, error) => locatorFailures.push({ spec, error }),
    });
  },

  diagnostics: [
    async ({ page, env, locatorTelemetry, locatorFailures }, use, testInfo) => {
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
      let snapshot;
      try {
        snapshot = await Promise.race([
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

      // Self-healing gate (docs/phase-2-healing.md) — pure, synchronous, zero
      // LLM calls. Runs for every exhausted-chain failure in this test, and
      // records why, whether eligible or not; the reason list is attached
      // regardless of the verdict, since "why nothing is heal-eligible" is
      // itself useful output. Only for failures the snapshot above actually
      // succeeded for — without a snapshot, rule 4 can't be evaluated anyway.
      if (snapshot && locatorFailures.length > 0) {
        const verdicts = locatorFailures.map(({ spec, error }) => {
          const eligibility = checkHealingEligibility({
            spec,
            error,
            telemetry: locatorTelemetry,
            snapshot,
            pageUrl: page.url(),
          });
          return {
            key: spec.key,
            ...eligibility,
            // The full spec, not just the key — `pnpm heal`'s out-of-band
            // pass needs `description` and `candidates` to call `propose()`
            // at all, and re-deriving them from page-object source later
            // would mean re-parsing TypeScript for data sitting right here.
            // Only worth the extra bytes when eligible; a refused failure's
            // spec is never going to be read again.
            spec: eligibility.eligible ? spec : undefined,
          };
        });
        try {
          await testInfo.attach('healing-gate.json', {
            body: JSON.stringify(verdicts, null, 2),
            contentType: 'application/json',
          });
        } catch {
          // Test already torn down; nothing to attach to.
        }

        // The rich CDP capture only happens for failures that already cleared
        // every free check — bounding its cost to the minority that can
        // actually use it. One capture per test covers every eligible
        // failure in it (a stale accessibility tree a few ms apart is not
        // the risk here; a CDP session per failure is the cost being avoided).
        // Also gated on the feature flag itself: this CDP session is the one
        // real cost self-healing adds to a run, so `selfHealing: false` must
        // actually remove it, not just leave the flag meaning nothing.
        if (env.features.selfHealing && verdicts.some((v) => v.eligible)) {
          try {
            const axSnapshot = await Promise.race([
              // Above the default 500 on purpose. `propose()` now refuses
              // outright on a truncated tree (uniqueness is an absence
              // claim, and a cut-off view cannot support one), so a cap the
              // real pages brush against would trade a false guarantee for a
              // healer that never proposes. Measured across twelve DMS
              // states, the largest tree was ~400 nodes; 1000 leaves room
              // without letting a pathological page run away.
              captureAccessibilityTree(page, { maxNodes: 1_000 }),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('Accessibility snapshot timed out')), 5_000),
              ),
            ]);
            await testInfo.attach('healing-context.json', {
              body: JSON.stringify(axSnapshot),
              contentType: 'application/json',
            });
          } catch {
            // Page closed, navigated away, crashed, or wedged — nothing to capture.
          }
        }
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

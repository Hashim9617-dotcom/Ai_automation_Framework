import { mkdirSync, existsSync, statSync, rmSync } from 'node:fs';
import path from 'node:path';
import { test as base, expect, requireUser, type EnvironmentConfig } from '@aitp/execution-engine';
import { findRepoRoot } from '@aitp/shared';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { recordNetwork, assertNetworkClean, type NetworkRecord } from './network';
import { readableName } from './components/names';

/**
 * THE ECOM FIXTURE: one signed-in context per worker, and a session that heals.
 *
 * ## Why login happens per worker and not once per run
 *
 * **The Ecom session expires during long runs.** A single `storageState` captured
 * at the start of a 29-module walk is stale by the end of it, and the symptom is
 * not an error — it is a page that quietly renders the login form, after which
 * every assertion about a grid fails and the report blames the application.
 *
 * So each worker signs in for itself, caches the state briefly, and RE-SIGNS-IN
 * when a page lands on the login route mid-test. The re-login is recorded as a
 * test annotation rather than hidden, because how often it happens is a fact about
 * the application worth reporting — and a self-healing session that healed
 * silently would make a short session TTL invisible forever.
 *
 * ## Credentials
 *
 * `ECOM_USER` / `ECOM_PASSWORD`, from `.env` via the environment config, through
 * `requireUser` so an unset variable refuses BY NAME rather than resolving to a
 * blank that reaches a login attempt and fails as though the password were wrong.
 * The password is never logged, never written to an annotation, and never put in a
 * trace title — `fill()` takes it directly and nothing else touches it.
 */

/** How long a cached storageState may be reused before a worker signs in again. */
export const SESSION_CACHE_MS = 8 * 60 * 1000;

export interface EcomWorkerFixtures {
  /** Path to this worker's own storageState file. */
  ecomStorageState: string;
}

export interface EcomFixtures {
  /** Every application request this test made, and the guards over it. */
  network: NetworkRecord;
  /** Console errors seen during this test. Asserted at teardown. */
  ecomConsoleErrors: string[];
  /** Re-signs in if the page has landed on the login route. Returns true if it did. */
  ensureSignedIn: (page: Page) => Promise<boolean>;
  /** The resolved application origin, for the network guard. */
  appOrigin: string;
  /**
   * The auto fixture that asserts the guards after every test body.
   *
   * Declared so it is part of the type rather than a loose property, and `auto` so
   * no spec has to remember it — a per-spec `afterEach` is a line that drifts, and
   * the one spec that forgets it is the one that writes.
   */
  ecomGuards: void;
}

/** Is this URL the login route? The app redirects there when a session expires. */
export const isLoginRoute = (url: string): boolean => {
  try {
    return /^\/(login|signin|sign-in)\/?$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
};

/**
 * Signs in through the UI. The ONLY place a credential is read or typed.
 *
 * Located by ROLE, with the password field found by its type rather than its name:
 * this application's accessible names carry icon glyphs and diverge from their
 * visible labels on two thirds of controls, and a password input is the one field
 * whose `type` is unambiguous.
 */
export async function signIn(page: Page, env: EnvironmentConfig): Promise<void> {
  const user = requireUser(env, 'admin');
  await page.goto('/login', { waitUntil: 'domcontentloaded' });

  const username = page
    .getByRole('textbox', { name: /user|email|login/i })
    .or(page.locator('input[type="email"]'))
    .or(page.locator('input[name="username"], input[name="email"]'))
    .first();
  // BY TYPE. A password field's `type` is the one attribute this app cannot
  // diverge on, and the credential must not depend on a label lookup that the
  // divergence measurements say is wrong two thirds of the time.
  const password = page.locator('input[type="password"]').first();

  await username.fill(user.username);
  // NEVER LOGGED, never annotated, never in a title. `fill` is the only consumer.
  await password.fill(user.password);

  await Promise.all([
    page.waitForURL((url) => !isLoginRoute(url.toString()), { timeout: 45_000 }),
    page
      .getByRole('button', { name: /sign in|log ?in|submit|continue/i })
      .first()
      .click(),
  ]);
}

const workerStatePath = (root: string, workerIndex: number): string =>
  path.join(root, 'artifacts', 'ecom', 'auth', `worker-${workerIndex}.json`);

export const test = base.extend<EcomFixtures, EcomWorkerFixtures>({
  /**
   * One signed-in state per worker, cached briefly.
   *
   * Worker-scoped so 29 modules do not cost 29 sign-ins, and short-lived so a
   * state cannot outlive the application's own session TTL — the cache is an
   * optimisation and must never be the reason a run uses a dead session.
   */
  ecomStorageState: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use, workerInfo) => {
      const root = findRepoRoot();
      const file = workerStatePath(root, workerInfo.workerIndex);
      mkdirSync(path.dirname(file), { recursive: true });

      /**
       * A STALE FILE IS DELETED HERE, not ignored at read time.
       *
       * This fixture owns the PATH and the staleness rule and nothing else: a
       * worker-scoped fixture cannot ask for the test-scoped `env`, so the sign-in
       * itself happens in `context` below, where the credential can be read. The
       * split keeps the one place a password is handled inside a fixture that
       * legitimately has it.
       *
       * Deleting rather than leaving it to be judged again means there is ONE
       * expression of "too old", and `openSignedInContext` finding no file is the
       * same thing as finding an expired one — which is the state it handles.
       */
      if (existsSync(file) && Date.now() - statSync(file).mtimeMs >= SESSION_CACHE_MS) {
        rmSync(file, { force: true });
      }
      await use(file);
    },
    { scope: 'worker' },
  ],

  /**
   * The browser context, built on this worker's state and signing in if there is
   * none yet.
   *
   * Overriding `context` rather than `storageState` is deliberate: the sign-in
   * needs a page, and a `storageState` option cannot create one. This way the
   * first test in a worker pays for the sign-in and the rest reuse it.
   */
  context: async ({ browser, ecomStorageState, env }, use) => {
    const context = await openSignedInContext(browser, ecomStorageState, env);
    await use(context);
    await context.close();
  },

  appOrigin: async ({ env }, use) => {
    await use(new URL(env.baseUrl).origin);
  },

  network: async ({ context, appOrigin }, use) => {
    await use(recordNetwork(context, appOrigin));
  },

  ecomConsoleErrors: async ({ context }, use) => {
    const errors: string[] = [];
    context.on('console', (message) => {
      if (message.type() === 'error') errors.push(readableName(message.text()));
    });
    context.on('weberror', (error) => errors.push(readableName(error.error().message)));
    await use(errors);
  },

  /**
   * Re-signs in when a page has landed on the login route, and SAYS it did.
   *
   * Returns `true` when it re-signed in, so a spec can annotate it. The annotation
   * is the point: a session that healed silently would make a short TTL invisible,
   * and "how often did this run have to sign in again" is a fact about the
   * application that belongs in the report.
   */
  ensureSignedIn: async ({ env }, use, testInfo) => {
    await use(async (page: Page) => {
      if (!isLoginRoute(page.url())) return false;
      await signIn(page, env);
      testInfo.annotations.push({
        type: 're-login',
        description: `the session had expired and this worker signed in again (${page.url()})`,
      });
      return true;
    });
  },

  /**
   * Asserts the network and console guards AFTER the test body, always.
   *
   * An `auto` fixture rather than an `afterEach`, so a spec cannot forget it and
   * there is no per-spec line to drift. The attachment is written even when the
   * assertions fail, because a failing test needs its evidence most.
   */
  ecomGuards: [
    async ({ network, ecomConsoleErrors }, use, testInfo) => {
      await use(undefined);
      // Only when the test body itself passed: a test that already failed has its
      // own reason, and a second error about console noise would bury it.
      if (testInfo.status === 'passed') {
        await assertNetworkClean(network, testInfo, ecomConsoleErrors);
      } else {
        await testInfo.attach('network.json', {
          body: JSON.stringify({ counts: network.byStatus, requests: network.requests }, null, 2),
          contentType: 'application/json',
        });
      }
    },
    { auto: true },
  ],
});

/** Opens a context on the saved state, signing in first when there is none. */
async function openSignedInContext(
  browser: Browser,
  statePath: string,
  env: EnvironmentConfig,
): Promise<BrowserContext> {
  const usable =
    existsSync(statePath) && Date.now() - statSync(statePath).mtimeMs < SESSION_CACHE_MS;
  if (usable) {
    return browser.newContext({ storageState: statePath, ignoreHTTPSErrors: true });
  }

  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  await signIn(page, env);
  await context.storageState({ path: statePath });
  await page.close();
  return context;
}

export { expect };

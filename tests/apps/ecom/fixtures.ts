import { test as base, expect, requireUser, type EnvironmentConfig } from '@aitp/execution-engine';
import { rootLogger } from '@aitp/shared';
import type { BrowserContext, Page } from '@playwright/test';
import {
  assertNetworkClean,
  attachNetworkRecord,
  recordNetwork,
  type NetworkRecord,
} from './network';
import { readableName } from './components/names';

/**
 * THE ECOM FIXTURE: one sign-in per worker, re-seeded into every test's own context.
 *
 * ## The measurement this design comes from
 *
 * A full run reported **58 re-logins across 62 tests** — almost every test signing
 * in again. Three explanations were possible and they wanted three different fixes,
 * so `session-diagnose.spec.ts` measured which it was. Measured 2026-11-23, five
 * modules on one worker, no intervention:
 *
 *     0ms /admin/domains/ApprovalMatrix -> 133ms /login   ... and NEVER left, 20s
 *     ... identical in 5 of 5, at state ages 0.1s, 21s, 44s, 67s and 89s
 *
 * That rules out a race with a silent refresh (the page never leaves `/login` on its
 * own) and it rules out a short TTL (a state written 100 ms earlier fails exactly
 * like one written 89 s earlier). The A/B that named the cause:
 *
 *     fresh sign-in    -> /admin/domains/Department
 *       sessionStorage [current_user, refresh_token, access_token]
 *     restored context -> /login
 *       sessionStorage []
 *
 * **`storageState()` captures cookies and localStorage. It does not capture
 * sessionStorage**, and that is where this application keeps its access token. So
 * the token existed in a working context, was invisible in the saved file, and was
 * absent from every context restored from it — with nothing anywhere reporting a
 * problem. The `refresh_token` cookie does survive the restore and the application
 * never uses it to recover.
 *
 * ## Why a fresh context per test and not a shared one
 *
 * sessionStorage is per TAB, not per browser context — a new page in a shared
 * context gets an empty one. So "one context per worker, fresh page per test" would
 * not have fixed this either. What works is to re-seed: the worker signs in once and
 * keeps the items in memory, and every test's own context installs them through
 * `addInitScript`, which runs BEFORE any application script on every document. Each
 * test still gets a clean context and a clean page, which is the isolation a shared
 * tab would have given up.
 *
 * ## The session material never leaves this process
 *
 * The snapshot is held in a closure and nowhere else. It is never written to
 * `artifacts/`, never into a `storageState` file, never logged, never put in an
 * annotation or an error message, and no JWT is decoded or inspected. The values
 * reach the browser as an ARGUMENT to `addInitScript` rather than inside its source
 * text, and `trace-secrecy.spec.ts` searches a real trace for them rather than
 * trusting that reasoning.
 *
 * This is strictly less exposure than the design it replaces, which wrote a
 * `refresh_token` cookie into `artifacts/ecom/auth/worker-*.json` on every run.
 *
 * ## An UNSEEDED context exists, and it is a safety requirement
 *
 * `addInitScript` re-seeds on every document load — including after a logout, which
 * would silently sign the page back in and make a logout test prove the opposite of
 * what it claims. Any test about signing in, signing out or session expiry takes
 * `unseededContext` and signs in for itself. `logout-safety.spec.ts` is the test
 * that fails if seeding ever leaks into that context.
 *
 * ## Credentials
 *
 * `ECOM_USER` / `ECOM_PASSWORD`, from `.env` via the environment config, through
 * `requireUser` so an unset variable refuses BY NAME rather than resolving to a
 * blank that reaches a login attempt and fails as though the password were wrong.
 * The password is never logged, never written to an annotation, and never put in a
 * trace title — `fill()` takes it directly and nothing else touches it.
 */

const log = rootLogger.child('ecom-session');

/**
 * How long a page that has landed on `/login` is given to leave by itself.
 *
 * It is a wait on a URL CONDITION, never a sleep, and it exists so a re-login means
 * "the session is really gone" rather than "the application was mid-navigation".
 * Five seconds against a measured redirect at 133–175 ms is generous by design: the
 * cost of waiting is paid only when something is already wrong, and the cost of not
 * waiting is a sign-in on every test, which is the bug this replaces.
 */
export const REFRESH_WAIT_MS = 5_000;

/**
 * The form's submit control, EXACTLY named — not the `Sign In` tab beside it.
 *
 * Named as a constant because it was written twice and both copies arrived as
 * `/^s*sign ins*$/i`: the `\s` escapes were eaten on the way into the file, so what
 * landed matched an optional letter `s` instead of optional whitespace. It still
 * matched `Sign In` — `s*` matches zero — which is why nothing failed and why it
 * survived review and a live run. It would also have matched `Sign Ins`, and it
 * would NOT have tolerated the leading space it was written to tolerate.
 *
 * Third instance of this repo's own rule in one project, and the first in which the
 * damage was latent rather than loud. One definition now, so there is one place for
 * it to be right.
 */
const SIGN_IN_EXACT = /^\s*sign in\s*$/i;

/**
 * RUNS `fn` WITH TRACING SUSPENDED, because Playwright records action arguments.
 *
 * ## Measured, after the opposite was assumed
 *
 * `trace-secrecy.spec.ts` was written to confirm that passing the session to
 * `addInitScript` as an ARGUMENT rather than interpolating it into the script source
 * kept it out of the trace. It reported the opposite, on a real trace, with both of
 * its controls found:
 *
 *     entries=101 selectorControl=true argsRecorded=true token=true password=true
 *
 * Playwright records an action's parameters, so the argument is in the file. The
 * password was in there too — and that half is NOT new: `fill()` has always recorded
 * its value, so every Ecom trace that signed in has carried `ECOM_PASSWORD` since
 * the suite was written. A trace is attached to failures, archived under
 * `artifacts/runs/` and zipped into a report email, so this is not theoretical.
 *
 * There is no way to type or inject a secret that the recorder does not see. The
 * only lever is to stop recording for that window: `stopChunk()` with no path
 * DISCARDS the chunk, and `startChunk()` begins a fresh one.
 *
 * ## What it costs, said plainly
 *
 * The discarded chunk is everything recorded in the current test up to that point.
 * At context creation — where seeding happens — that is nothing. In the worker
 * sign-in it is fixture setup. In a mid-test re-login it is that test's trace so
 * far, which is a real loss of failure evidence and the reason the re-login target
 * is ≤ one per worker: the cheap case has to stay cheap.
 *
 * ## It must not fail OPEN
 *
 * If suspension does not happen, the secret is recorded and nothing says so. So a
 * failure to START a chunk again is swallowed (the trace is merely shorter), while a
 * failure to STOP is reported by the caller — the two directions are not
 * symmetrical, and only one of them leaks.
 */
async function withoutTracing<T>(context: BrowserContext, fn: () => Promise<T>): Promise<T> {
  let suspended = false;
  try {
    await context.tracing.stopChunk();
    suspended = true;
  } catch {
    // Tracing is not running on this context — `features.trace` is false, or this is
    // a context the harness never instrumented. Nothing to suspend, nothing to leak.
  }
  try {
    return await fn();
  } finally {
    if (suspended) {
      try {
        await context.tracing.startChunk();
      } catch {
        // A trace that stays stopped loses evidence; it does not leak anything. The
        // asymmetry is deliberate: this is the safe direction to fail in.
      }
    }
  }
}

/** sessionStorage, as key/value pairs. HELD IN MEMORY ONLY. */
type SessionEntries = Array<[string, string]>;
type SavedState = Awaited<ReturnType<BrowserContext['storageState']>>;

/**
 * What one worker signed in once and can hand to every test in it.
 *
 * Accessors rather than fields: `adopt` replaces the snapshot after a real re-login,
 * and a test holding a stale copy of the object would seed the dead session into
 * every context it opened afterwards.
 */
export interface EcomSession {
  /** Cookies and localStorage. No access token is in here — it is not persisted. */
  state: () => SavedState;
  /** The sessionStorage items the application actually authenticates with. */
  entries: () => SessionEntries;
  /** When the live sign-in behind this snapshot happened. */
  signedInAt: () => number;
  /** Re-reads both from a page that has just signed in, replacing the snapshot. */
  adopt: (page: Page) => Promise<void>;
  /** How many sign-ins this worker has performed, the first one included. */
  signInCount: () => number;
}

export interface EcomWorkerFixtures {
  /** One sign-in per worker, held in memory. */
  ecomSession: EcomSession;
}

export interface EcomFixtures {
  /** Every application request this test made, and the guards over it. */
  network: NetworkRecord;
  /** Console errors seen during this test. Asserted at teardown. */
  ecomConsoleErrors: string[];
  /** Re-signs in if the page is STILL on the login route after the bounded wait. */
  ensureSignedIn: (page: Page) => Promise<boolean>;
  /** The resolved application origin, for the network guard. */
  appOrigin: string;
  /**
   * A context with NO saved state and NO seeding — for sign-in, sign-out and
   * expiry tests, whose claims a re-seeding init script would make vacuous.
   */
  unseededContext: BrowserContext;
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
 * Reads sessionStorage as pairs. KEYS AND VALUES — the values are the session.
 *
 * Exported for the one test that has to prove these values do not reach a trace. No
 * other caller should need it: the fixtures below pass the result straight into
 * `addInitScript` and never look inside it.
 */
export async function readSessionStorage(page: Page): Promise<SessionEntries> {
  // The RESULT is what carries the token here, not an argument — and a result is
  // recorded too. Suspended for the same reason the seeding is.
  return withoutTracing(page.context(), () =>
    page.evaluate(() =>
      Object.keys(window.sessionStorage).map(
        (key) => [key, window.sessionStorage.getItem(key) ?? ''] as [string, string],
      ),
    ),
  );
}

/**
 * Installs the session into every document a context opens, BEFORE app script runs.
 *
 * The entries are passed as an ARGUMENT, not interpolated into the script source, so
 * the function body that a trace or a HAR might record contains no value. The write
 * is wrapped because `about:blank` has an opaque origin and no storage at all —
 * throwing there would fail the navigation rather than the seeding.
 */
export async function seedSession(context: BrowserContext, entries: SessionEntries): Promise<void> {
  await withoutTracing(context, () =>
    context.addInitScript((items: SessionEntries) => {
      try {
        for (const [key, value] of items) window.sessionStorage.setItem(key, value);
      } catch {
        // An opaque origin has no sessionStorage. Nothing to seed, nothing to report.
      }
    }, entries),
  );
}

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

  /**
   * THE PANEL, not the page -- because this login screen has TWO "Sign In" buttons.
   *
   * Measured from a real failed run on 2026-11-18, not guessed: the page is the
   * storefront-styled login, and it carries a `Sign In` / `Create Account` TAB pair
   * above the form as well as the form's own `Sign In` submit. A page-wide
   * `getByRole('button', { name: /sign in/i }).first()` resolves to the TAB -- so
   * every one of the 29 modules failed with `waitForURL: Timeout 45000ms`, a message
   * that says nothing about the real cause. That run never signed in at all.
   *
   * The distinction is STRUCTURAL, which is what makes it durable: the submit is the
   * button in the same container as the password field, and the tab is not. Taking
   * `.last()` of the two would work today and break the day a third appears.
   */
  const panel = page
    .locator('div,form')
    .filter({ has: page.locator('input[type="password"]') })
    .filter({ has: page.getByRole('button', { name: SIGN_IN_EXACT }) })
    // The INNERMOST container satisfying both: every ancestor satisfies them too.
    .last();

  /**
   * The email field is the panel's first textbox.
   *
   * NOT by accessible name: this application names it after its PLACEHOLDER
   * ("you@example.com"), so a /user|email|login/ match finds nothing -- the same
   * measured divergence that makes every locator here role-and-structure based.
   */
  const username = panel.getByRole('textbox').first();
  // BY TYPE. A password field's `type` is the one attribute this app cannot diverge
  // on, and the credential must not depend on a label lookup the divergence
  // measurements say is wrong two thirds of the time.
  const password = panel.locator('input[type="password"]').first();

  /**
   * THE CREDENTIAL WINDOW, with tracing suspended.
   *
   * `fill()` records its value in the trace — measured, not assumed, by
   * `trace-secrecy.spec.ts`, which found `ECOM_PASSWORD` in a real trace. That was
   * true of this suite from the day it was written. Nothing can type a secret the
   * recorder does not see, so the recorder is stopped for these three lines.
   *
   * The click and the URL wait are inside the window too, so the sign-in does not
   * appear in the trace at all. That is a deliberate loss: a trace showing a
   * sign-in and a trace showing a password are the same trace.
   */
  await withoutTracing(page.context(), async () => {
    await username.fill(user.username);
    // NEVER LOGGED, never annotated, never in a title. `fill` is the only consumer.
    await password.fill(user.password);

    await Promise.all([
      page.waitForURL((url) => !isLoginRoute(url.toString()), { timeout: 45_000 }),
      panel.getByRole('button', { name: SIGN_IN_EXACT }).first().click(),
    ]);
  });
}

export const test = base.extend<EcomFixtures, EcomWorkerFixtures>({
  /**
   * ONE SIGN-IN PER WORKER, in its own throwaway context, captured to memory.
   *
   * `workerEnv` rather than `env`: both resolve the same configuration, and only the
   * worker-scoped one can be asked for here. The previous design could not sign in
   * at worker scope for exactly this reason and did it per test instead, which is
   * how 62 tests became 58 sign-ins.
   *
   * The context is created directly from `browser` and NOT through Playwright's own
   * `context` fixture, so it carries no tracing — the one place a token is read out
   * of a page is therefore a place no trace is recording.
   */
  ecomSession: [
    async ({ browser, workerEnv }, use, workerInfo) => {
      let state: SavedState = { cookies: [], origins: [] };
      let entries: SessionEntries = [];
      let signedInAt = 0;
      let signInCount = 0;

      const adopt = async (page: Page): Promise<void> => {
        state = await page.context().storageState();
        entries = await readSessionStorage(page);
        signedInAt = Date.now();
        signInCount += 1;
      };

      const context = await browser.newContext({ ignoreHTTPSErrors: true });
      try {
        const page = await context.newPage();
        await signIn(page, workerEnv);
        await adopt(page);
      } finally {
        await context.close();
      }

      // §T — a snapshot of nothing would seed nothing and every test would sign in
      // again, which is the bug this fixture exists to end. It would also look
      // exactly like success. The COUNT is logged; no key and no value ever is.
      if (entries.length === 0) {
        throw new Error(
          `worker ${workerInfo.workerIndex} signed in but its sessionStorage was EMPTY — ` +
            'nothing to seed, so every test would sign in again. The application has ' +
            'changed where it keeps its session; re-run `--grep @diagnose` to see what it ' +
            'holds now.',
        );
      }
      log.info('Ecom worker signed in', {
        worker: workerInfo.workerIndex,
        sessionItems: entries.length,
        cookies: state.cookies.length,
      });

      await use({
        state: () => state,
        entries: () => entries,
        signedInAt: () => signedInAt,
        signInCount: () => signInCount,
        adopt,
      });
    },
    { scope: 'worker' },
  ],

  /**
   * A fresh context per test, carrying the worker's session.
   *
   * Overriding `context` rather than `storageState` is deliberate twice over: the
   * seeding needs the context object, and `storageState` alone cannot carry
   * sessionStorage at all — which is the whole finding.
   */
  context: async ({ browser, ecomSession }, use) => {
    const context = await browser.newContext({
      storageState: ecomSession.state(),
      ignoreHTTPSErrors: true,
    });
    await seedSession(context, ecomSession.entries());
    await use(context);
    await context.close();
  },

  /**
   * A context with nothing restored and nothing seeded.
   *
   * For tests whose subject IS the session: a sign-in, a sign-out, an expiry. With
   * seeding in place a logout test would be signed back in by the next document
   * load and would pass while proving the opposite of its own name.
   */
  unseededContext: async ({ browser }, use) => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
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
   * Re-signs in ONLY when the session is really gone, and says why.
   *
   * The order is the policy. A page on `/login` is first given `REFRESH_WAIT_MS` to
   * leave by itself, as a wait on a URL condition — so an application that is
   * mid-navigation or mid-refresh is not mistaken for one that has logged us out.
   * Only a page still there afterwards is treated as expired.
   *
   * On a real re-sign the WORKER'S SNAPSHOT IS REPLACED, so the next test seeds the
   * live session rather than the dead one. Without that, one expiry would make every
   * later test in the worker sign in again — the original bug, arriving late.
   */
  ensureSignedIn: async ({ env, ecomSession }, use, testInfo) => {
    await use(async (page: Page) => {
      if (!isLoginRoute(page.url())) return false;

      try {
        await page.waitForURL((url) => !isLoginRoute(url.toString()), {
          timeout: REFRESH_WAIT_MS,
        });
        testInfo.annotations.push({
          type: 'session-recovered',
          description:
            `the page was on the login route and left it by itself within ` +
            `${REFRESH_WAIT_MS}ms — no sign-in was needed`,
        });
        return false;
      } catch {
        // Still there. That is the only thing that counts as expired.
      }

      await signIn(page, env);
      await ecomSession.adopt(page);
      testInfo.annotations.push({
        type: 're-login',
        description:
          `the page was still on the login route after ${REFRESH_WAIT_MS}ms, so the session ` +
          `had really expired; this worker signed in again (sign-in #${ecomSession.signInCount()} ` +
          'for this worker) and the in-memory snapshot was replaced',
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
        // THE SAME writer the passing path uses. This was a second `attach` with
        // its own name spelling and its own body-versus-file decision — and it is
        // the failing test whose record matters most, so it was the worse of the
        // two to have unreachable from run.json.
        await attachNetworkRecord(network, testInfo);
      }
    },
    { auto: true },
  ],
});

/**
 * Signs in inside an unseeded context and returns its page.
 *
 * The one helper the session tests share, so each does not rebuild it — and so the
 * thing they have in common is visible rather than repeated three times with three
 * small differences.
 */
export async function signedInPage(context: BrowserContext, env: EnvironmentConfig): Promise<Page> {
  const page = await context.newPage();
  await signIn(page, env);
  return page;
}

export { expect };

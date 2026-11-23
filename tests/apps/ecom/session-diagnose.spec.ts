import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { findRepoRoot } from '@aitp/shared';
import { test, expect, isLoginRoute } from './fixtures';
import { ModulePage } from './components';

/**
 * WHY DOES THIS SUITE SIGN IN AGAIN ON ALMOST EVERY TEST?
 *
 * A full run reported **58 re-logins across 62 tests**. That number has three very
 * different explanations and they want three different fixes, so this spec measures
 * which one it is rather than picking the plausible one:
 *
 * - **(i) a race with the application's own silent refresh.** The access token is
 *   not in the restored state, the app routes to `/login` while it mints a new one
 *   from the refresh cookie, and a moment later it lands on the page that was asked
 *   for. The session was never dead and every one of those 58 sign-ins was
 *   unnecessary. The fix is to stop asking too early.
 * - **(ii) a genuinely short token TTL.** The page reaches `/login` and STAYS there,
 *   and the storageState is old. The fix is a shorter cache and fewer contexts.
 * - **(iii) the storageState is missing something.** The page stays on `/login` even
 *   when the state was written seconds ago, so what was saved is not what the
 *   application needs. The fix is in what gets persisted.
 *
 * ## THE FIRST VERSION OF THIS SPEC ANSWERED NOTHING, and how it failed matters
 *
 * It read `page.url()` once, immediately after `domcontentloaded`, and entered its
 * 10-second refresh-window poll only if that single read said `/login`. Measured on
 * 2026-11-23: all five observations came back `onLoginAfterLoad: false` — and three
 * of the five recorded `finalPath: "/login"` a few milliseconds later. The redirect
 * is CLIENT-SIDE and lands after the document is parsed, so the question was asked
 * before the thing it asked about had happened, the poll never ran once, and the
 * measurement that was supposed to separate (i) from (ii) was never taken.
 *
 * The lesson is the repo's own: a counterfactual has to be stated about the
 * OBSERVATION POINT, not only about the input. `onLogin=no` paired with
 * `finalPath=/login` is a self-contradicting pair of readings, and it was only
 * visible because both were recorded. One of them alone would have read as an answer.
 *
 * So this version samples a TIMELINE rather than taking two snapshots: every URL the
 * page occupies, with the millisecond it arrived. "Never went to /login", "went and
 * left by itself" and "went and stayed" then become three different shapes in the
 * data instead of one boolean that can be read at the wrong instant.
 *
 * ## It deliberately does NOT call `ensureSignedIn`
 *
 * That is the recovery mechanism. A diagnostic that healed the session would destroy
 * its own measurement — the question is what the page does when nobody intervenes,
 * and an intervention is an answer substituted for an observation.
 *
 * ## IT IS ALSO THE BEFORE/AFTER, on one instrument
 *
 * These five cases were run against the restore-from-`storageState` fixture and
 * against the seeded one, unchanged in between. That is the only comparison that
 * says the fix worked rather than that something changed:
 *
 * | | ended on `/login` | ended on the module |
 * | --- | --- | --- |
 * | restore from `storageState` | 5 of 5 | 0 of 5 |
 * | sessionStorage re-seeded | 0 of 5 | 5 of 5 |
 *
 * `SESSION-AB` below keeps measuring the RAW behaviour — a context restored from a
 * bare `storageState()` with no seeding — so it stays true whatever the fixture
 * does, and it is the documentation of why the naive approach cannot work.
 *
 * ## Not part of the smoke run
 *
 * Tagged `@diagnose`, never `@smoke`, so `--grep @smoke` collects the smoke tests and
 * not these. It stays in the tree rather than being deleted after one use, because a
 * measurement nobody can repeat is a claim.
 *
 * READ-ONLY, like everything else here: it navigates and reads. No credential is
 * typed by this file, and the session inventories name item KINDS only — a cookie
 * name and a storage key are schema; their values are the session itself.
 */

/** One URL the page occupied, and when it got there. */
interface UrlSample {
  atMs: number;
  path: string;
}

interface Observation {
  caseId: string;
  module: string;
  /** How old this worker's saved state was when the navigation began. */
  stateAgeMs: number;
  /** Every distinct path the page occupied, in order, from the moment goto returned. */
  timeline: UrlSample[];
  /** `null` when it never went there. */
  firstLoginAtMs: number | null;
  /**
   * When it LEFT `/login`. `null` when it never went, `-1` when it was still there
   * when the window closed — three states, because "never went" and "never left" are
   * opposite findings and a single number cannot hold both.
   */
  leftLoginAtMs: number | null;
  /**
   * Where the page ENDED, and whether that is the module.
   *
   * Not "when the module was first reached", which the previous version recorded and
   * which read `0ms` for every observation — `goto` puts the module path there at
   * t=0, so "it appeared in the timeline" is true by construction and says nothing.
   * A field that cannot come out the other way is not a measurement.
   */
  endedPath: string;
  endedOnModule: boolean;
  /** Item KINDS present once the page settled — never values. */
  afterSettle: { cookies: string[]; localStorageKeys: string[] };
}

/**
 * How long the application is given to settle before the sampling stops.
 *
 * Longer than the 10 s the brief named, deliberately: 10 s is the hypothesis about
 * the refresh window, and a sampler bounded by the hypothesis cannot observe the
 * case where the hypothesis is wrong. `leftLoginAtMs` beyond 10 s is itself a
 * finding, and it has to be reachable to be found.
 */
const SETTLE_WINDOW_MS = 20_000;
/** How long the path must hold still before the page counts as settled. */
const STABLE_FOR_MS = 1_500;
const SAMPLE_EVERY_MS = 100;

const observations: Observation[] = [];

/**
 * ONE definition of "the login route", reused for a bare path.
 *
 * `isLoginRoute` takes a full URL because that is what `page.url()` gives. Writing a
 * second regex here for paths would be a second expression of the same rule, and the
 * two would drift the first time the application grows a third login path.
 */
const pathIsLogin = (pathname: string): boolean => isLoginRoute(`https://host${pathname}`);

interface SmokeEntry {
  caseId: string;
  module: string;
  entity: string;
  url: string;
}
const manifest = JSON.parse(
  readFileSync(path.join(findRepoRoot(), 'config', 'apps', 'ecom', 'smoke.json'), 'utf8'),
) as { listLoad: SmokeEntry[] };

// §T — a manifest that failed to load would give a suite of zero tests, and an empty
// run reports as a pass. Five is what was asked for and five is asserted.
const SAMPLE = manifest.listLoad.slice(0, 5);
if (SAMPLE.length !== 5) {
  throw new Error(
    `expected 5 list-load entries to sample, found ${SAMPLE.length} — refusing to collect`,
  );
}

/** Cookie names and storage keys, sorted. KINDS ONLY — no value is read. */
async function inventory(context: {
  storageState: () => Promise<{
    cookies: Array<{ name: string; httpOnly?: boolean }>;
    origins: Array<{ localStorage: Array<{ name: string }> }>;
  }>;
}): Promise<{ cookies: string[]; localStorageKeys: string[] }> {
  const state = await context.storageState();
  return {
    cookies: state.cookies.map((c) => `${c.name}${c.httpOnly ? ' (httpOnly)' : ''}`).sort(),
    localStorageKeys: state.origins
      .flatMap((origin) => origin.localStorage.map((item) => item.name))
      .sort(),
  };
}

test.describe('Ecom session: why the re-logins @ecom @diagnose @readonly', () => {
  /**
   * SERIAL and in one worker, because the ORDER is the measurement.
   *
   * The question is what happens to ONE saved state as it ages across several tests,
   * which parallel workers cannot answer: each would have its own fresh state, so
   * every observation would be of a state a few seconds old and the TTL hypothesis
   * would be untestable by construction.
   */
  test.describe.configure({ mode: 'serial' });

  for (const entry of SAMPLE) {
    test(`${entry.caseId} ${entry.module}: what the page does with no intervention`, async ({
      page,
      context,
      ecomSession,
    }, testInfo) => {
      // wrong: reading the URL ONCE after domcontentloaded, which is what the first
      // version did — the redirect to /login is client-side and arrives after the
      // document is parsed, so that reading says "not on login" for a page that is
      // about to be, and the refresh-window poll behind it never runs. A timeline
      // can come out all three ways; a single reading cannot come out at all.
      const modulePath = `/admin/domains/${entry.entity}`;
      // The age of the WORKER'S SIGN-IN, not of a file: the session is held in
      // memory now and there is no file to stat. Same quantity, honest source.
      const stateAgeMs = Date.now() - ecomSession.signedInAt();

      await page.goto(modulePath, { waitUntil: 'domcontentloaded' });

      const began = Date.now();
      const timeline: UrlSample[] = [];
      let settledSince: number | null = null;
      while (Date.now() - began < SETTLE_WINDOW_MS) {
        const here = new URL(page.url()).pathname;
        const last = timeline.at(-1);
        if (last?.path !== here) {
          timeline.push({ atMs: Date.now() - began, path: here });
          settledSince = Date.now();
        } else if (settledSince !== null && Date.now() - settledSince >= STABLE_FOR_MS) {
          // Stop EARLY only once the path has held still, and only when it is no
          // longer the login route: a page parked on /login must be sampled for the
          // whole window, or "it stayed" and "nobody waited" look identical.
          if (!isLoginRoute(page.url())) break;
        }
        await page.waitForTimeout(SAMPLE_EVERY_MS);
      }

      const loginIndex = timeline.findIndex((sample) => pathIsLogin(sample.path));
      const firstLoginAtMs = loginIndex === -1 ? null : timeline[loginIndex]!.atMs;
      const afterLogin = loginIndex === -1 ? undefined : timeline[loginIndex + 1];
      const leftLoginAtMs = loginIndex === -1 ? null : (afterLogin?.atMs ?? -1);
      const endedPath = timeline.at(-1)?.path ?? '';

      const observation: Observation = {
        caseId: entry.caseId,
        module: entry.module,
        stateAgeMs,
        timeline,
        firstLoginAtMs,
        leftLoginAtMs,
        endedPath,
        endedOnModule: endedPath.includes(modulePath),
        afterSettle: await inventory(context),
      };
      observations.push(observation);

      testInfo.annotations.push({
        type: 'session-observation',
        description:
          `state ${Math.round(stateAgeMs / 1000)}s old; ` +
          `path timeline: ${timeline.map((s) => `${s.atMs}ms ${s.path}`).join(' -> ')}; ` +
          `left /login: ${describeLeft(firstLoginAtMs, leftLoginAtMs)}; ` +
          `ended on ${endedPath} (module: ${observation.endedOnModule})`,
      });

      // NOT AN ASSERTION ABOUT THE SESSION. The only thing that would invalidate
      // this observation is the sampling never running, so that is what is asserted
      // and nothing else — a diagnostic that failed on the phenomenon it measures
      // would stop measuring it.
      expect(timeline.length, 'the sampler recorded no path at all').toBeGreaterThan(0);
      if (observation.endedOnModule) {
        await new ModulePage(page, entry.entity).waitForRendered(30_000);
      }
    });
  }

  /**
   * WHAT THE WORKER'S SNAPSHOT CONTAINS — item kinds only.
   *
   * Hypothesis (iii) is "what is restored is not what the application needs", and it
   * cannot be answered without knowing what is restored. Compared against the live
   * context's own inventory: a key the context holds and the snapshot's
   * `storageState` half does not is the item `storageState()` cannot carry, which is
   * the finding this whole fixture is built around.
   *
   * It reads the snapshot's KEYS through the session fixture. There is no file to
   * read any more, which is itself part of the fix — nothing session-bearing is
   * written to `artifacts/` at all.
   */
  test('SESSION-INV the restored state against the live context, by kind', async ({
    context,
    ecomSession,
  }, testInfo) => {
    // wrong: dumping `storageState()` into an annotation, which would put a live
    // session token into a report, a trace and an archive. Names answer the
    // question; values would answer a different one nobody asked.
    const snapshot = ecomSession.state();
    const savedState = {
      cookies: snapshot.cookies.map((c) => `${c.name}${c.httpOnly ? ' (httpOnly)' : ''}`).sort(),
      localStorageKeys: snapshot.origins
        .flatMap((origin) => origin.localStorage.map((item) => item.name))
        .sort(),
    };
    const live = await inventory(context);

    testInfo.annotations.push({
      type: 'session-inventory',
      description: `restored state — cookies: ${savedState.cookies.join(', ') || '(none)'} | keys: ${
        savedState.localStorageKeys.join(', ') || '(none)'
      }  ||  live context — cookies: ${live.cookies.join(', ') || '(none)'} | keys: ${
        live.localStorageKeys.join(', ') || '(none)'
      }`,
    });

    writeObservations(savedState, live);

    // §T — an inventory of nothing would be reported as "the state holds nothing",
    // which is itself finding (iii). The two are told apart here so an instrument
    // that read an empty snapshot cannot be mistaken for a real finding.
    expect(
      savedState.cookies.length + savedState.localStorageKeys.length,
      'the restored state carries no cookie and no storage key — finding (iii)',
    ).toBeGreaterThan(0);
  });

  /**
   * WHAT A WORKING CONTEXT HOLDS THAT A RESTORED ONE DOES NOT — the A/B.
   *
   * The five observations above say the restored context lands on `/login` and never
   * leaves, so the session is not surviving the restore. That is WHERE it breaks;
   * this is WHAT is missing, and the two are different claims.
   *
   * `storageState()` captures cookies and localStorage. It does NOT capture
   * **sessionStorage** — so if the application keeps its access token there, a token
   * can exist in a working context, be invisible to the saved file, and be gone from
   * every context restored from it, with nothing anywhere reporting a problem.
   *
   * Measured rather than asserted, in one test, because either half alone is
   * agreeable and wrong:
   *
   * - the FRESH half: sign in, confirm the module page is reachable, and enumerate
   *   every item kind the context holds — cookies, localStorage AND sessionStorage.
   * - the RESTORED half: take that same context's `storageState()`, open a second
   *   context from it, and see where it lands. If the fresh one works and the
   *   restored one does not, the difference between the two inventories is the
   *   cause. If BOTH work, the diagnosis above is wrong and this says so.
   *
   * This is §V in its proper form: "the session moved from A to B" is tested by
   * taking A away, not by confirming B exists.
   */
  test('SESSION-AB a fresh sign-in against a context restored from its own storageState', async ({
    browser,
    env,
  }, testInfo) => {
    // wrong: enumerating a fresh context's storage and concluding the restored one
    // lacks it. The two inventories differing is not the same claim as the
    // difference MATTERING — a context could be missing three keys the app never
    // reads. Only the restored context failing where the fresh one succeeded makes
    // the difference load-bearing rather than incidental.
    const modulePath = '/admin/domains/Department';
    const { signIn } = await import('./fixtures');

    const fresh = await browser.newContext({ ignoreHTTPSErrors: true });
    let restored: Awaited<ReturnType<typeof browser.newContext>> | null = null;
    try {
      const page = await fresh.newPage();
      await signIn(page, env);

      // §T — the fresh half must actually be signed in, or both halves fail for the
      // same reason and the comparison is between two broken things.
      await page.goto(modulePath, { waitUntil: 'domcontentloaded' });
      const freshEnded = await settleAndReportPath(page, modulePath);
      expect(freshEnded, 'the FRESH sign-in did not reach the module page').toContain(modulePath);

      const freshState = await inventory(fresh);
      // KINDS ONLY. `Object.keys` never touches a value.
      const freshSession = (await page.evaluate(() =>
        Object.keys(window.sessionStorage),
      )) as string[];

      restored = await browser.newContext({
        storageState: await fresh.storageState(),
        ignoreHTTPSErrors: true,
      });
      const restoredPage = await restored.newPage();
      await restoredPage.goto(modulePath, { waitUntil: 'domcontentloaded' });
      const restoredEnded = await settleAndReportPath(restoredPage, modulePath);
      const restoredSession = (await restoredPage.evaluate(() =>
        Object.keys(window.sessionStorage),
      )) as string[];
      const restoredState = await inventory(restored);

      const lost = [
        ...freshState.cookies
          .filter((k) => !restoredState.cookies.includes(k))
          .map((k) => `cookie ${k}`),
        ...freshState.localStorageKeys
          .filter((k) => !restoredState.localStorageKeys.includes(k))
          .map((k) => `localStorage ${k}`),
        ...freshSession
          .filter((k) => !restoredSession.includes(k))
          .map((k) => `sessionStorage ${k}`),
      ];

      testInfo.annotations.push({
        type: 'session-ab',
        description:
          `FRESH ended on ${freshEnded} — cookies [${freshState.cookies.join(', ')}] ` +
          `localStorage [${freshState.localStorageKeys.join(', ')}] ` +
          `sessionStorage [${freshSession.join(', ')}]  ||  ` +
          `RESTORED ended on ${restoredEnded} — cookies [${restoredState.cookies.join(', ')}] ` +
          `localStorage [${restoredState.localStorageKeys.join(', ')}] ` +
          `sessionStorage [${restoredSession.join(', ')}]  ||  ` +
          `lost by the restore: ${lost.join(', ') || '(nothing)'}`,
      });

      process.stdout.write(
        `\nSESSION-AB\n` +
          `  fresh    ended ${freshEnded}\n` +
          `    cookies [${freshState.cookies.join(', ')}]\n` +
          `    localStorage [${freshState.localStorageKeys.join(', ')}]\n` +
          `    sessionStorage [${freshSession.join(', ')}]\n` +
          `  restored ended ${restoredEnded}\n` +
          `    cookies [${restoredState.cookies.join(', ')}]\n` +
          `    localStorage [${restoredState.localStorageKeys.join(', ')}]\n` +
          `    sessionStorage [${restoredSession.join(', ')}]\n` +
          `  lost by the restore: ${lost.join(', ') || '(nothing)'}\n\n`,
      );
    } finally {
      await restored?.close();
      await fresh.close();
    }
  });
});

/** Samples until the path holds still off the login route, and returns where it ended. */
async function settleAndReportPath(
  page: { url: () => string; waitForTimeout: (ms: number) => Promise<void> },
  _modulePath: string,
): Promise<string> {
  const began = Date.now();
  let last = new URL(page.url()).pathname;
  let stableSince = Date.now();
  while (Date.now() - began < SETTLE_WINDOW_MS) {
    const here = new URL(page.url()).pathname;
    if (here !== last) {
      last = here;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= STABLE_FOR_MS && !pathIsLogin(here)) {
      break;
    }
    await page.waitForTimeout(SAMPLE_EVERY_MS);
  }
  return last;
}

function describeLeft(first: number | null, left: number | null): string {
  if (first === null) return 'never went there';
  if (left === -1) return `went at ${first}ms and NEVER left`;
  return `went at ${first}ms, left at ${left}ms`;
}

/**
 * Writes the observations where a human can read them, under gitignored artifacts.
 *
 * Asserts its own effect: the file is read back and its row count checked, because a
 * diagnostic whose output silently failed to land would be reported from memory.
 */
function writeObservations(
  saved: { cookies: string[]; localStorageKeys: string[] },
  live: { cookies: string[]; localStorageKeys: string[] },
): void {
  const dir = path.join(findRepoRoot(), 'artifacts', 'ecom', 'session-diagnose');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  const payload = {
    settleWindowMs: SETTLE_WINDOW_MS,
    stableForMs: STABLE_FOR_MS,
    sampleEveryMs: SAMPLE_EVERY_MS,
    savedState: saved,
    liveContext: live,
    observations,
  };
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  const readBack = JSON.parse(readFileSync(file, 'utf8')) as typeof payload;
  if (readBack.observations.length !== observations.length) {
    throw new Error(
      `wrote ${file} but it reads back ${readBack.observations.length} observation(s) of ` +
        `${observations.length} — refusing to report a measurement that did not land`,
    );
  }

  process.stdout.write(`\nsession diagnosis written: ${file}\n`);
  for (const o of readBack.observations) {
    process.stdout.write(
      `  ${o.caseId.padEnd(12)} state ${String(Math.round(o.stateAgeMs / 1000)).padStart(3)}s  ` +
        `${describeLeft(o.firstLoginAtMs, o.leftLoginAtMs).padEnd(34)} ` +
        `ended=${o.endedOnModule ? 'MODULE' : o.endedPath}\n` +
        `               ${o.timeline.map((s) => `${s.atMs}ms ${s.path}`).join(' -> ')}\n`,
    );
  }
  process.stdout.write(
    `  saved  : cookies [${saved.cookies.join(', ')}] keys [${saved.localStorageKeys.join(', ')}]\n` +
      `  settled: cookies [${live.cookies.join(', ')}] keys [${live.localStorageKeys.join(', ')}]\n\n`,
  );
}

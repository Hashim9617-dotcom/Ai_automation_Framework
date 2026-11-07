import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect } from '@aitp/execution-engine';
import { findRepoRoot } from '@aitp/shared';
import { spawnSyncClean } from '../support/spawn-clean';

/**
 * THE FOUR AMBIENT COMMANDS, AS REAL PROCESSES: each refuses without `--app`.
 *
 * ## Why this cannot be a unit test
 *
 * The unit suite proves the RULE — `tests/unit/application-env.spec.ts` covers the
 * resolver and both halves of the disagreement refusal. What it cannot prove is that
 * these four scripts actually ASK, and the wiring IS the finding: all four called
 * bare `loadEnvironment()`, so with `TEST_ENV=app` in `.env` — the normal state of a
 * machine that has ever run against the customer system — `pnpm auth` opened a
 * browser at DMS and wrote a live session there while somebody believed they were
 * onboarding a second application.
 *
 * A source scan would be the cheaper version and the weaker one: it asks whether the
 * text contains a call, not whether the call is REACHED. `auth`'s refusal has to come
 * before `chromium.launch`, and only running it can say so.
 *
 * ## The environment is SUPPLIED, never the machine's (§AJ)
 *
 * Every spawn gets its own `AITP_REPO_ROOT` holding two environment files written by
 * this suite, with LITERAL baseUrls. The first draft used `TEST_ENV=app` against the
 * repo's own `config/env/app.json`, which interpolates `${BASE_URL}`, `${APP_USERNAME}`
 * and `${APP_PASSWORD}` from `.env` — so the assertions would have been about whether
 * this machine happens to hold DMS credentials, green here and red on a clean clone.
 * Worse, a passing run would have resolved a real customer URL to prove a refusal.
 *
 * Ask it at authoring time: with every `.env` on this machine deleted, what is this
 * comparing? Here: two files this test wrote, and no network of any kind.
 */

const ROOT = findRepoRoot();
const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

/** The ambient environment name every spawn is given — the one that used to decide. */
const AMBIENT = 'alpha-live';
const AMBIENT_APP = 'alpha';
/** A second application, so a disagreement is expressible without inventing a slug. */
const OTHER_APP = 'beta';

/**
 * A repo root holding two environments and nothing else.
 *
 * `.aitp-maintainer` because this root is not a released kit: every QA-facing command
 * checks `kit-manifest.json` first and refuses when it is absent — fail-closed, so
 * deleting the manifest cannot be how the lock is turned off. Without the marker this
 * suite would measure the LOCK instead of the argument gate (§Y). The lock's own
 * tests are `kit-integrity.spec.ts` and `kit-integrity-cli.spec.ts`.
 */
function fixtureRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'aitp-app-arg-'));
  writeFileSync(path.join(root, 'pnpm-workspace.yaml'), '');
  writeFileSync(path.join(root, '.aitp-maintainer'), '');
  mkdirSync(path.join(root, 'config', 'env'), { recursive: true });

  const env = (name: string, application: string) => ({
    name,
    application,
    // A LITERAL, so nothing here can be redirected by an ambient BASE_URL (SEC-2)
    // and nothing needs `.env` to resolve. The port is the bundled demo's; no
    // command in this suite connects to it.
    baseUrl: 'http://127.0.0.1:4173',
    apiBaseUrl: 'http://127.0.0.1:4173',
    timeouts: { action: 10000, navigation: 20000, expect: 8000, test: 60000 },
    retries: 0,
    workers: 1,
    users: { admin: { username: 'fixture', password: 'fixture', role: 'admin' } },
    // `selfHealing: false` is load-bearing in G2: it is how `pnpm heal` proves it got
    // PAST the argument gate and read the resolved environment's own flags.
    features: { selfHealing: false, aiRootCause: false, video: false, trace: false },
  });

  writeFileSync(
    path.join(root, 'config', 'env', `${AMBIENT}.json`),
    JSON.stringify(env(AMBIENT, AMBIENT_APP)),
    'utf8',
  );
  writeFileSync(
    path.join(root, 'config', 'env', `${OTHER_APP}-live.json`),
    JSON.stringify(env(`${OTHER_APP}-live`, OTHER_APP)),
    'utf8',
  );
  return root;
}

const run = (root: string, script: string, args: readonly string[] = []) =>
  spawnSyncClean(process.execPath, [TSX, path.join(ROOT, 'scripts', script), ...args], {
    cwd: ROOT,
    maxBuffer: 20 * 1024 * 1024,
    env: { AITP_REPO_ROOT: root, TEST_ENV: AMBIENT, LOG_LEVEL: 'error' },
  });

/** Every script that resolves a target ambiently, and the usage each must print. */
const COMMANDS = [
  { script: 'auth-setup.ts', usage: 'pnpm auth --app' },
  { script: 'inspect-app.ts', usage: 'pnpm inspect --app' },
  { script: 'heal.ts', usage: 'pnpm heal --app' },
  { script: 'analyze-failures.ts', usage: 'pnpm rca --app' },
] as const;

test.describe('auth, inspect, heal and rca require --app @demo', () => {
  test.setTimeout(240_000);

  for (const { script, usage } of COMMANDS) {
    test(`G1 ${script}: refuses without --app, before resolving any target`, () => {
      // wrong: before this batch all four resolved the ambient TEST_ENV and carried
      // on — `auth` to a browser and a live session file, `inspect` to a capture
      // filed under that application. So the old code exits ZERO here (or blocks on
      // a browser), and the resolved baseUrl appears in its output. BOTH are
      // asserted, because a non-zero exit alone is equally satisfied by a script
      // that refuses AFTER resolving and printing the target.
      const result = run(fixtureRoot(), script);
      expect(result.status, `${script} should refuse`).not.toBe(0);
      const output = `${result.stdout}${result.stderr}`;
      expect(output).toContain(usage);
      expect(output).toContain('--app is required');
      // The banner labels every line it prints; its absence is what says nothing was
      // resolved. The baseUrl is the value a real run would have leaked.
      expect(output).not.toContain('application :');
      expect(output).not.toContain('127.0.0.1:4173');
    });
  }

  test('G2: with --app the gate is PASSED, not skipped — each fails later and differently', () => {
    // wrong: G1 is satisfied by a script that refuses unconditionally, which would
    // make all four commands permanently unusable and still pass every assertion
    // above — a rule that refuses everything measures nothing. This is the half that
    // tells a gate from a brick wall (§Y): each command gets an `--app` that AGREES
    // with TEST_ENV and must then fail for its OWN downstream reason, which can only
    // be reached by code past the argument check. Neither opens a socket.
    const root = fixtureRoot();

    const heal = run(root, 'heal.ts', ['--app', AMBIENT_APP]);
    const healOutput = `${heal.stdout}${heal.stderr}`;
    expect(healOutput).not.toContain('--app is required');
    // Only reachable from the RESOLVED environment's feature flags.
    expect(healOutput).toContain('selfHealing');
    expect(healOutput).toContain(AMBIENT);

    const rca = run(root, 'analyze-failures.ts', ['--app', AMBIENT_APP]);
    const rcaOutput = `${rca.stdout}${rca.stderr}`;
    expect(rcaOutput).not.toContain('--app is required');
    // Only reachable after the gate: the report it needs and this root does not have.
    expect(rcaOutput).toContain('run.json');
  });

  test('G3: --app disagreeing with the ambient environment is refused by BOTH names', () => {
    // wrong: a refusal saying only "two sources disagree" leaves the reader to guess
    // which two and what to change — and the old behaviour was worse than an unclear
    // message, because there was no disagreement to report at all: `--app` did not
    // exist and TEST_ENV won in silence. Both values must appear or the message
    // cannot be acted on.
    const result = run(fixtureRoot(), 'inspect-app.ts', ['--app', OTHER_APP]);
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).not.toBe(0);
    // The quotes are matched LOOSELY because the logger emits the message inside
    // JSON, so `"beta"` arrives as `\"beta\"`. Asserting the literal form failed on
    // the encoding while the property held — the names were both there. The regex
    // still pins each value to the clause that names it, so a message mentioning
    // only one of the two sources cannot pass.
    expect(output).toMatch(new RegExp(String.raw`--app says \\?"${OTHER_APP}\\?"`));
    expect(output).toMatch(new RegExp(String.raw`TEST_ENV=\\?"${AMBIENT}\\?"`));
    expect(output).toContain('no safe tie-break');
    // And still nothing was resolved: a refusal that printed the target first would
    // have told the reader which system it was about to capture.
    expect(output).not.toContain('application :');
  });
});

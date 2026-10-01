import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { fixtureOnlyRun, resetEnvironmentCache, resolveEnvName } from '@aitp/execution-engine';

/**
 * THE FIXTURE SURFACE NEVER SEES THE REAL `.env` (SEC-3e).
 *
 * ## What was measured
 *
 * A probe spec inside the unit project, 2026-10-01:
 *
 *     PROBE added-by-ensureDotenv: (none)
 *     PROBE real-keys-present: APP_PASSWORD,APP_USERNAME,BASE_URL,ANTHROPIC_API_KEY
 *
 * Nothing was added by the time a test ran — the keys were already there.
 * `playwright.config.ts` resolves environments while the config loads, in the PARENT
 * process, and every worker inherits that environment. So this could never have been
 * fixed inside a test: in M2 a test that deliberately deleted `APP_PASSWORD` got the
 * real one straight back from `ensureDotenv()`, and the only reason that surfaced is
 * that the test then failed to throw.
 *
 * ## Why this file is the vigilance, and what it does not cover
 *
 * The fix is structural where it can be: `test:unit` and `test:demo` set
 * `AITP_FIXTURE_ONLY=1`, and `ensureDotenv` then PARSES `.env` into a throwaway object
 * and copies across only an allowlist of operational keys. Nothing has to be
 * remembered inside a test.
 *
 * It is not structural against `npx playwright test --project=unit` typed by hand,
 * which sets no flag. That is what this file closes, and it closes it the only way
 * vigilance can be made to work: by failing rather than by being read.
 */
/**
 * A repo root holding nothing but `pnpm-workspace.yaml`, the given `.env` and
 * `config/env/local.json`.
 *
 * The point is that every key in that `.env` exists NOWHERE ELSE, so what arrives in
 * `process.env` can only have come from the load under test — the ambient environment
 * cannot explain it either way.
 */
function fixtureRoot(dotenv: string): string {
  const root = mkdtempSync(path.join(tmpdir(), 'aitp-fixture-env-'));
  writeFileSync(path.join(root, 'pnpm-workspace.yaml'), '');
  writeFileSync(path.join(root, '.env'), dotenv, 'utf8');
  mkdirSync(path.join(root, 'config', 'env'), { recursive: true });
  copyFileSync(
    path.join(process.cwd(), 'config', 'env', 'local.json'),
    path.join(root, 'config', 'env', 'local.json'),
  );
  return root;
}

function restore(root: string, before: Record<string, string | undefined>): void {
  delete process.env.AITP_REPO_ROOT;
  for (const [key, value] of Object.entries(before)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
  resetEnvironmentCache();
}

test.describe('no real credential reaches the fixture surface @unit', () => {
  test('a unit run carries no real credential in process.env', () => {
    // wrong: the unit suite runs with the developer's live DMS password, API key and
    // customer URL in its environment — so a test can sign in to a real system by
    // accident, and one that tries to prove a credential is MISSING gets the real one.
    //
    // Named keys rather than a shape, because the point is the specific values a
    // developer has on this machine. `TEST_ENV` and `LOG_LEVEL` are deliberately not
    // here: they are on the fixture-safe allowlist.
    expect(
      fixtureOnlyRun(),
      'this run did not set AITP_FIXTURE_ONLY — use `pnpm test:unit`, not a bare ' +
        '`playwright test --project=unit`, or the real .env is merged into every worker',
    ).toBe(true);

    for (const key of [
      'APP_PASSWORD',
      'APP_USERNAME',
      'APP_USER2_PASSWORD',
      'QA_ADMIN_PASSWORD',
      'STAGING_ADMIN_PASSWORD',
      'STAGING_DB_PASSWORD',
      'SMTP_PASSWORD',
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'BASE_URL',
    ]) {
      expect(process.env[key], `${key} is in the unit worker's environment`).toBeUndefined();
    }
  });

  test('a fixture-safe key from .env DOES still arrive, or the suite cannot run', () => {
    // wrong: a scrub that removed EVERYTHING satisfies the test above perfectly and
    // breaks the suite — `TEST_ENV` is how `resolveEnvName()` answers at all, and a run
    // that cannot name its environment cannot do anything. This is the
    // rule-that-refuses-everything check applied to an environment scrub.
    //
    // ## Why this goes through a temp root rather than asking the real environment
    //
    // The first version was `expect(() => resolveEnvName()).not.toThrow()`, and it
    // FAILED ON A FRESH CLONE — measured 2026-10-01 while re-running the quickstart,
    // 572/573:
    //
    //     refusing to run: no environment was named. TEST_ENV is set in neither the
    //     shell nor .env.
    //
    // The refusal was right. The test was asserting a value whose only source is
    // `.env`, a per-machine file a clean checkout does not have, so it was really
    // asserting "this developer has configured this machine" — green here, red for
    // everyone else and in CI.
    //
    // A temp `.env` is the fix and the better instrument: `LOG_LEVEL` below exists
    // nowhere but in it, so its arrival cannot be explained by the ambient
    // environment. Against the sentinel test below this is the §W pair — same file,
    // same load, same mechanism, differing only in whether the key is on the
    // allowlist.
    const root = fixtureRoot('TEST_ENV=local\nLOG_LEVEL=debug\n');
    const before = { TEST_ENV: process.env.TEST_ENV, LOG_LEVEL: process.env.LOG_LEVEL };
    try {
      // Both have to go: the copy only fills keys that are UNDEFINED, so a value
      // already present from the real `.env` would make this pass without the temp
      // file being read at all.
      delete process.env.TEST_ENV;
      delete process.env.LOG_LEVEL;
      process.env.AITP_REPO_ROOT = root;
      resetEnvironmentCache();

      expect(resolveEnvName()).toBe('local');
      expect(
        process.env.LOG_LEVEL,
        'a fixture-safe key did not arrive — the parse copies nothing, and nothing can run',
      ).toBe('debug');
    } finally {
      restore(root, before);
    }
  });

  test('§W: a SENTINEL in .env does NOT reach process.env in fixture-only mode', () => {
    // wrong: the parse writes into `process.env` after all — which is what `dotenv`
    // does by default, and the whole fix is the one option that stops it. A test that
    // only checked the named credentials above would pass against a `.env` that
    // happens not to define them on this machine.
    //
    // A sentinel is the discriminating input: a key that exists ONLY in the fixture's
    // `.env`, so its absence cannot be explained by the developer's own setup.
    const root = fixtureRoot('TEST_ENV=local\nAITP_SENTINEL=xyz\n');
    const before = { AITP_SENTINEL: process.env.AITP_SENTINEL, TEST_ENV: process.env.TEST_ENV };
    try {
      // `TEST_ENV` has to go too, and finding that out is part of the finding: it IS on
      // the fixture-safe allowlist, so the real `.env`'s value is already in
      // `process.env` — and the copy only fills keys that are undefined, so the temp
      // `.env` could not override it. The first draft asserted `local` and got `app`.
      delete process.env.AITP_SENTINEL;
      delete process.env.TEST_ENV;
      process.env.AITP_REPO_ROOT = root;
      resetEnvironmentCache();

      // Reading the environment is what triggers the `.env` load. Asserted, not
      // assumed: if this said anything else the `.env` was never read and the
      // sentinel's absence would prove nothing (§T).
      expect(resolveEnvName()).toBe('local');
      expect(
        process.env.AITP_SENTINEL,
        'the sentinel from .env reached process.env — it was MERGED, not parsed',
      ).toBeUndefined();
    } finally {
      restore(root, before);
    }
  });
});

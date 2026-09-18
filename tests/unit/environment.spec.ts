import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { loadEnvironment, resolveEnvName, resetEnvironmentCache } from '@aitp/execution-engine';

/**
 * Regression coverage for the bug that cost days to track down: TEST_ENV
 * usually lives in .env, not the shell, but resolveEnvName() (and the two
 * functions that used to inline this logic) defaulted a parameter to
 * `process.env.TEST_ENV ?? 'qa'` — evaluated before .env was ever loaded — so
 * a TEST_ENV set only in .env was silently ignored in favour of 'qa'.
 */
test.describe('resolveEnvName', () => {
  let tempDir: string;
  const originalEnv = { ...process.env };

  test.beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'aitp-env-test-'));
    writeFileSync(path.join(tempDir, 'pnpm-workspace.yaml'), '');
    delete process.env.TEST_ENV;
    process.env.AITP_REPO_ROOT = tempDir;
    resetEnvironmentCache();
  });

  test.afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    process.env = { ...originalEnv };
    resetEnvironmentCache();
  });

  test('honours TEST_ENV set only in .env, not the shell', () => {
    writeFileSync(path.join(tempDir, '.env'), 'TEST_ENV=app\n');

    // Nothing exported in the shell — this is the exact scenario that used
    // to silently fall back to 'qa'.
    expect(process.env.TEST_ENV).toBeUndefined();
    expect(resolveEnvName()).toBe('app');
  });

  test('a shell-exported TEST_ENV still wins over .env', () => {
    writeFileSync(path.join(tempDir, '.env'), 'TEST_ENV=app\n');
    process.env.TEST_ENV = 'staging';

    expect(resolveEnvName()).toBe('staging');
  });

  test('falls back to "qa" when TEST_ENV is set nowhere', () => {
    writeFileSync(path.join(tempDir, '.env'), 'BASE_URL=https://example.test\n');

    expect(resolveEnvName()).toBe('qa');
  });
});

/**
 * A baseUrl the file PINS is not overruled by an ambient `BASE_URL`.
 *
 * **Found on 2026-09-11 while building the Command Box.** With `BASE_URL` set in
 * `.env`, every environment key resolved to the live customer system — including
 * `local`, whose file says `http://127.0.0.1:4173` in plain text. So a run
 * requested against the demo app ran against a customer system, and nothing in
 * the request could have prevented it. That is the Command Box's requirement-5
 * hazard inverted, and the more dangerous direction.
 *
 * The override was never needed for the files it was written for: `app`, `qa`
 * and `staging` take `BASE_URL` through `${BASE_URL}` placeholders, so
 * interpolation already applies it. It changed the outcome ONLY for a file that
 * pins a literal — precisely the file whose author was saying "this environment
 * IS this URL".
 */
test.describe('loadEnvironment and an ambient BASE_URL @unit', () => {
  let tempDir: string;
  const originalEnv = { ...process.env };

  const writeEnv = (name: string, baseUrl: string) => {
    const dir = path.join(tempDir, 'config', 'env');
    mkdirSync(dir, { recursive: true });
    // `application` is required by the schema — it names the per-application
    // config directory, so an environment file without one cannot be resolved.
    writeFileSync(
      path.join(dir, `${name}.json`),
      JSON.stringify({ name, application: 'fixture', baseUrl }),
      'utf8',
    );
  };

  test.beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'aitp-baseurl-test-'));
    writeFileSync(path.join(tempDir, 'pnpm-workspace.yaml'), '');
    process.env.AITP_REPO_ROOT = tempDir;
    resetEnvironmentCache();
  });

  test.afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    process.env = { ...originalEnv };
    resetEnvironmentCache();
  });

  test('a LITERAL baseUrl wins over an ambient BASE_URL', () => {
    // wrong: the ambient value wins, and `local` — a file that names the demo
    // app in plain text — resolves to whatever BASE_URL happens to hold. A run
    // asked for against the demo app then runs against a customer system.
    writeEnv('local', 'http://127.0.0.1:4173');
    process.env.BASE_URL = 'https://a-customer-system.example.com';

    expect(loadEnvironment('local').baseUrl).toBe('http://127.0.0.1:4173');
  });

  test('a PLACEHOLDER baseUrl still takes the ambient BASE_URL', () => {
    // wrong: suppressing the override everywhere would break CI parameter
    // injection, which is the reason the override exists — `app` and `staging`
    // are written as `${BASE_URL}` precisely so a pipeline can point them
    // somewhere. This is the discriminating half: the SAME ambient value, and
    // the two files must disagree about it.
    writeEnv('staging', '${BASE_URL}');
    process.env.BASE_URL = 'https://injected-by-ci.example.com';

    expect(loadEnvironment('staging').baseUrl).toBe('https://injected-by-ci.example.com');
  });

  test('a DEFAULTED placeholder takes the ambient value too', () => {
    // wrong: treating `${BASE_URL:-fallback}` as pinned would make `qa` ignore
    // an injected URL and quietly run against its fallback — the same class of
    // surprise in the opposite direction.
    writeEnv('qa', '${BASE_URL:-http://127.0.0.1:4173}');
    process.env.BASE_URL = 'https://injected-by-ci.example.com';

    expect(loadEnvironment('qa').baseUrl).toBe('https://injected-by-ci.example.com');
  });

  test('an interpolated baseUrl that names ANOTHER variable still takes the override', () => {
    // wrong: the override is suppressed for every placeholder, and this file
    // resolves to ALTERNATE_URL — CI can no longer point a run anywhere.
    //
    // THE DISCRIMINATING FIXTURE, and the reason it looks odd. Every other
    // placeholder case here writes `${BASE_URL}`, so interpolation ALREADY
    // substitutes the ambient value and the override changes nothing: those
    // tests pass with the override line deleted outright. Mutation confirmed
    // it — "the override never wins" survived them both. Only a file that
    // interpolates a DIFFERENT variable makes interpolation and the override
    // disagree, so this is the one fixture that can tell them apart.
    process.env.ALTERNATE_URL = 'https://from-the-file.example.com';
    writeEnv('staging', '${ALTERNATE_URL}');
    process.env.BASE_URL = 'https://injected-by-ci.example.com';

    expect(loadEnvironment('staging').baseUrl).toBe('https://injected-by-ci.example.com');
  });

  test('...and with no ambient BASE_URL that same file keeps its own variable', () => {
    // wrong: BASE_URL is applied even when unset (as '' or undefined), and the
    // file's own variable is discarded for nothing. Pairs with the test above:
    // same fixture, the ambient value removed, so the two differ only in that.
    process.env.ALTERNATE_URL = 'https://from-the-file.example.com';
    writeEnv('staging', '${ALTERNATE_URL}');
    delete process.env.BASE_URL;

    expect(loadEnvironment('staging').baseUrl).toBe('https://from-the-file.example.com');
  });

  test('with no ambient BASE_URL a defaulted placeholder falls back', () => {
    // wrong: a fallback that never fires means a developer with no BASE_URL set
    // gets a config error instead of the local default the file promises.
    writeEnv('qa', '${BASE_URL:-http://127.0.0.1:4173}');
    delete process.env.BASE_URL;

    expect(loadEnvironment('qa').baseUrl).toBe('http://127.0.0.1:4173');
  });
});

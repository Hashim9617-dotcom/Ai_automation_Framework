import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import {
  environmentsDeclaring,
  requireApplicationArg,
  resetEnvironmentCache,
} from '@aitp/execution-engine';

/**
 * WHICH ENVIRONMENT BELONGS TO AN APPLICATION — derived from the files, and the
 * refusals when the answer is not one.
 *
 * ## What this replaces, and why it is a security property rather than ergonomics
 *
 * `pnpm auth`, `pnpm inspect`, `pnpm heal` and `pnpm rca` all called bare
 * `loadEnvironment()`, which resolves `TEST_ENV` from the ambient environment. On
 * any machine that has ever run against the customer system `.env` says
 * `TEST_ENV=app`. So typing `pnpm auth` while onboarding a SECOND application
 * opened a browser at DMS and wrote a live session — cookies and tokens — to
 * `artifacts/dms/auth/app.json`, and the target banner printed that faithfully.
 * SEC-2's exact shape: a run stating a target it read from the source that chose it.
 *
 * ## The directory is SUPPLIED, never read (§AJ)
 *
 * `environmentsDeclaring` takes its `configDir`. A version that reached for
 * `repoRoot()` would make every assertion below a fact about which files happen to
 * sit in this checkout's `config/env/` — green here, red on a clean clone, and
 * quietly wrong the day someone adds a second DMS environment. Ask it at authoring
 * time: with every config file on this machine deleted, what would this be
 * comparing? Here: a temporary directory this test wrote itself.
 */

/** A config/env/ directory with exactly the files a test names. Typed, not cast (§AD). */
function envDir(
  files: Record<string, { application?: unknown; timeouts?: unknown } | string>,
): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'aitp-env-'));
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(
      path.join(dir, name),
      typeof body === 'string' ? body : JSON.stringify(body),
      'utf8',
    );
  }
  return dir;
}

/**
 * Runs `body` with `TEST_ENV` SET TO A SUPPLIED VALUE, or genuinely absent.
 *
 * `undefined` DELETES the variable rather than setting it to `''`. Any value is a
 * value the real process does not have, and `''` is a third environment different
 * from both — only `'TEST_ENV' in process.env` can tell absent from empty, because
 * reading the value cannot (the `NODE_PATH` finding, same trap).
 *
 * Restored in a `finally`, and an assignment cannot throw, so unlike the mutation
 * harness's file write this cleanup needs no retry.
 */
function withAmbientEnv(value: string | undefined, body: () => void): void {
  const had = 'TEST_ENV' in process.env;
  const previous = process.env.TEST_ENV;
  if (value === undefined) delete process.env.TEST_ENV;
  else process.env.TEST_ENV = value;
  try {
    body();
  } finally {
    if (had) process.env.TEST_ENV = previous;
    else delete process.env.TEST_ENV;
    resetEnvironmentCache();
  }
}

test.describe('an application resolves to an environment, or refuses @unit', () => {
  test('A1: exactly one environment declaring the application resolves to it', () => {
    // wrong: a resolver keyed on the FILENAME rather than on the declared
    // `application` would return [] here — the file is `prod-ecom.json` and the
    // application is `ecom`, deliberately different strings, so a name-matching
    // implementation cannot pass this and a declaration-reading one cannot fail it.
    const dir = envDir({
      'prod-ecom.json': { application: 'ecom' },
      'app.json': { application: 'dms' },
    });
    expect(environmentsDeclaring({ configDir: dir, application: 'ecom' })).toEqual(['prod-ecom']);
  });

  test('A2: several environments for one application are ALL returned, sorted', () => {
    // wrong: returning the first match — which is what a `.find()` would do, and
    // what the caller must NOT be handed — gives ['qa'] or ['app'] depending on
    // readdir order, and the caller then opens a browser at one of three live
    // systems without anybody choosing. Three is the real DMS shape.
    const dir = envDir({
      'qa.json': { application: 'dms' },
      'app.json': { application: 'dms' },
      'staging.json': { application: 'dms' },
      'local.json': { application: 'bundled-demo' },
    });
    expect(environmentsDeclaring({ configDir: dir, application: 'dms' })).toEqual([
      'app',
      'qa',
      'staging',
    ]);
  });

  test('A3: an application no environment declares returns nothing — and that is not an error', () => {
    // wrong: an implementation that fell back to "every environment" when none
    // matched, or that threw here, would both be wrong in the same direction: the
    // caller's refusal is what names the slug and points at
    // docs/ADD-AN-APPLICATION.md, and it can only do that if it is HANDED an empty
    // list rather than an exception or a guess.
    const dir = envDir({ 'app.json': { application: 'dms' } });
    expect(environmentsDeclaring({ configDir: dir, application: 'ecom' })).toEqual([]);
  });

  test('A4: a non-JSON file and a file with no application are SKIPPED, not fatal', () => {
    // wrong: one unparseable file throwing would make the whole search fail, so a
    // stray editor backup in config/env/ would break `pnpm auth` for every
    // application. The good file must still be found WITH the bad ones present —
    // which is why both sit in this fixture rather than in a test of their own.
    const dir = envDir({
      'broken.json': '{ not json',
      'nameless.json': { timeouts: {} },
      'numeric.json': { application: 7 },
      'ecom.json': { application: 'ecom' },
    });
    expect(environmentsDeclaring({ configDir: dir, application: 'ecom' })).toEqual(['ecom']);
  });

  test('A5: a directory that does not exist returns nothing rather than throwing', () => {
    // wrong: an ENOENT escaping here would surface as a stack trace instead of the
    // caller's sentence about adding config/env/<app>.json — a fresh clone with no
    // config directory is exactly the case the message is written for.
    expect(
      environmentsDeclaring({
        configDir: path.join(tmpdir(), 'aitp-no-such-dir-9f3c1'),
        application: 'ecom',
      }),
    ).toEqual([]);
  });

  test('A6: non-.json files are ignored even when their contents would match', () => {
    // wrong: reading every file in the directory would find this application in a
    // README or a `.json.bak`, and report an environment name (`ecom.json.bak`)
    // that `loadEnvironment` can never load — a confident answer that fails later
    // as a missing file, which is the worse direction.
    const dir = envDir({
      'ecom.json.bak': { application: 'ecom' },
      'notes.md': '"application": "ecom"',
    });
    expect(environmentsDeclaring({ configDir: dir, application: 'ecom' })).toEqual([]);
  });

  test('A7: --app with nothing after it is not a value', () => {
    // wrong: `argv.indexOf('--app') + 1` without this check makes the application
    // `--headed`, which then fails much later as a missing config file and reads as
    // an entirely different problem. The must-NOT-refuse half is A8 below, so this
    // pair cannot both be satisfied by a function that always throws (§W).
    withAmbientEnv(undefined, () => {
      expect(() =>
        requireApplicationArg({ argv: ['node', 'x', '--app', '--headed'], usage: 'u' }),
      ).toThrow(/--app is required/);
      expect(() => requireApplicationArg({ argv: ['node', 'x'], usage: 'u' })).toThrow(
        /--app is required/,
      );
    });
  });

  test('A8: --app with a value and no ambient environment returns it', () => {
    // wrong: a refusal that fires on everything is as empty as one that fires on
    // nothing, and it is the harder of the two to see — it just fails safe while
    // measuring nothing (CLAUDE.md, "a rule that refuses everything").
    //
    // THE AMBIENT VALUE IS SUPPLIED, not inherited. `TEST_ENV` is in
    // FIXTURE_SAFE_ENV_KEYS, so `.env`'s value IS merged into the unit surface —
    // written without this, the assertion passed or failed according to whether
    // this machine's `.env` happens to name a DMS environment, which is §AJ in the
    // test rather than in the code.
    withAmbientEnv(undefined, () => {
      expect(requireApplicationArg({ argv: ['node', 'x', '--app', 'ecom'], usage: 'u' })).toBe(
        'ecom',
      );
    });
  });

  test('A9: an ambient environment naming a DIFFERENT application is refused', () => {
    // wrong: without this refusal `--app ecom` under TEST_ENV=local is simply
    // accepted, and the two sources silently disagree — `--app` deciding the config
    // and captures while `TEST_ENV` decides the baseUrl and the session file. That
    // is the state this whole batch exists to make impossible, so it is asserted
    // against a REAL environment file (`local`, which declares bundled-demo)
    // rather than a fixture, because the disagreement must hold over what ships.
    withAmbientEnv('local', () => {
      expect(() =>
        requireApplicationArg({ argv: ['node', 'x', '--app', 'ecom'], usage: 'u' }),
      ).toThrow(/Two sources disagree/);
    });
  });

  test('A10: an ambient environment naming the SAME application is accepted', () => {
    // wrong: A9 alone is satisfied by a rule that refuses whenever TEST_ENV is set
    // at all — which would make `TEST_ENV=app pnpm inspect --app dms`, the correct
    // way to name one of three DMS environments, impossible. This is the silent
    // half the assertion in A9 is written against (§W).
    withAmbientEnv('local', () => {
      expect(
        requireApplicationArg({ argv: ['node', 'x', '--app', 'bundled-demo'], usage: 'u' }),
      ).toBe('bundled-demo');
    });
  });
});

import { test, expect } from '@playwright/test';
import { CHILD_ENV_ALLOWLIST, buildChildEnv } from '../../apps/api/src/modules/runs/child-env';

/**
 * What a child of the API is allowed to see.
 *
 * `RunnerService` spawned Playwright with `{ ...process.env, … }`, so the child
 * received every variable the API process held — including `ALLOW_WRITES`, the
 * one switch that lets three tests create real records in a live customer
 * system. `CB5` proves no request BODY can set it. Nothing had to: one `export`
 * in the shell that started the API was enough, and the API has no
 * authentication.
 *
 * ## What this suite covers, and what it does not
 *
 * These tests are about the RULE. That `RunnerService` and `CommandService`
 * actually apply it is a different claim, held by
 * `no-unscrubbed-spawn.spec.ts`, and that a real `spawn()` carries the result is
 * held by `api-hardening.spec.ts`. Three tests that compose to the property,
 * said out loud here because one test that appears to state the whole thing
 * alone is the §L shape.
 */

/** A parent environment with one of everything, supplied rather than read (§AJ). */
const PARENT: NodeJS.ProcessEnv = {
  // Must survive — the child cannot spawn or launch a browser without these.
  PATH: '/usr/bin',
  TEST_ENV: 'app',
  BASE_URL: 'https://example.invalid',
  TEST_DATA_SEED: '42',
  LOG_LEVEL: 'debug',
  // Must NOT survive.
  ALLOW_WRITES: 'true',
  ANTHROPIC_API_KEY: 'sk-sentinel',
  APP_PASSWORD: 'sentinel-password',
  SMTP_PASSWORD: 'sentinel-smtp',
  GH_TOKEN: 'sentinel-token',
  MY_SECRET: 'sentinel-secret',
  SOME_CREDENTIAL: 'sentinel-credential',
  AUTH_HEADER: 'sentinel-auth',
  // Not secret, simply not on the list — the allowlist's own default answer.
  AITP_FIXTURE_ONLY: '1',
  RANDOM_UNLISTED: 'whatever',
};

test.describe('the child environment is built from an allowlist @unit', () => {
  test('ALLOW_WRITES set on the parent is absent from the child', () => {
    // wrong: with `{ ...process.env }` it is present, and `POST /api/runs
    // {"grep":"@write"}` becomes a data-creating endpoint on a live system,
    // reachable by anyone who can reach the port.
    const env = buildChildEnv({ parent: PARENT });

    // `in`, not a truthiness check: `ALLOW_WRITES=''` would read as falsy while
    // still being a value the real process does not have, and only `in` tells
    // those apart — the same reason the runner scrub asserts with `in`.
    expect('ALLOW_WRITES' in env, 'ALLOW_WRITES reached the child').toBe(false);
    // And the gate is the allowlist, not a special case for this one name:
    // an unlisted, perfectly innocent variable is dropped too.
    expect('RANDOM_UNLISTED' in env).toBe(false);
    expect('AITP_FIXTURE_ONLY' in env).toBe(false);
  });

  test('nothing secret-shaped reaches the child, whatever it is called', () => {
    // wrong: a test naming only ANTHROPIC_API_KEY would pass over a filter that
    // special-cased that one string, and the next credential added to .env would
    // travel to every run. These six differ in prefix, suffix and separator.
    const env = buildChildEnv({ parent: PARENT });

    for (const name of [
      'ANTHROPIC_API_KEY',
      'APP_PASSWORD',
      'SMTP_PASSWORD',
      'GH_TOKEN',
      'MY_SECRET',
      'SOME_CREDENTIAL',
      'AUTH_HEADER',
    ]) {
      expect(name in env, `${name} reached the child`).toBe(false);
    }

    // Discriminating: the values are distinct sentinels, so a child env that
    // merely renamed a key would still be caught by its value appearing.
    expect(Object.values(env).join('|')).not.toMatch(/sentinel/);
  });

  test('the variables a run genuinely needs do come through, Windows casing included', () => {
    // wrong: an allowlist that dropped PATH or TEST_ENV would be perfectly
    // "secure" and completely useless — the child could not launch a browser,
    // and every one of the tests above would still pass. This is the half that
    // makes a refusing-everything allowlist visible (§"a rule that refuses
    // everything is as empty as one that accepts everything").
    const env = buildChildEnv({ parent: PARENT });

    expect(env.PATH).toBe('/usr/bin');
    expect(env.TEST_ENV).toBe('app');
    expect(env.BASE_URL).toBe('https://example.invalid');
    expect(env.TEST_DATA_SEED).toBe('42');
    expect(env.LOG_LEVEL).toBe('debug');

    // CASE-INSENSITIVE MATCHING, which is not a nicety on the platform this repo
    // is developed on: Windows reports its own casing — `Path`, `SystemRoot`,
    // `windir`, `ProgramFiles` — and `Object.entries(process.env)` hands those
    // back verbatim. A case-sensitive Set would drop `Path`, and a child with no
    // PATH fails in a way that reads as a missing browser install.
    const windowsish = buildChildEnv({
      parent: { Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', windir: 'C:\\Windows' },
    });
    expect(windowsish.Path).toBe('C:\\Windows');
    expect(windowsish.SystemRoot).toBe('C:\\Windows');
    expect(windowsish.windir).toBe('C:\\Windows');
  });

  test('an override wins over the parent, and is the only way to set what is not inherited', () => {
    // wrong: if the parent won, `TEST_ENV` would be whatever the API process was
    // started with rather than what the request asked for — the third instance
    // of the inherited-environment family this repo has corrected, where a child
    // re-resolved its target from ambient state instead of from its caller.
    const env = buildChildEnv({
      parent: PARENT,
      overrides: { TEST_ENV: 'local', AITP_RUN_ID: 'run_0123456789abcdef', CI: 'true' },
    });

    expect(env.TEST_ENV).toBe('local');
    // `AITP_RUN_ID` and `CI` are not on the allowlist at all, so an override is
    // the only route in — which is the point: a spawn says what it sets.
    expect(env.AITP_RUN_ID).toBe('run_0123456789abcdef');
    expect(env.CI).toBe('true');
    // The parent's own listed values are still there alongside.
    expect(env.PATH).toBe('/usr/bin');
  });

  test('the tripwire refuses a POISONED allowlist, and stays silent on the real one', () => {
    // wrong: SECRET_SHAPED is not the gate — the allowlist is — so over today's
    // list the pattern matches nothing and a broken pattern would be invisible.
    // That makes this the only test that can tell a working tripwire from a
    // decorative one, and it is why `allowed` is a parameter at all (§W).
    expect(() =>
      buildChildEnv({ parent: PARENT, allowed: [...CHILD_ENV_ALLOWLIST, 'ANTHROPIC_API_KEY'] }),
    ).toThrow(/child-env allowlist names ANTHROPIC_API_KEY/);

    expect(() =>
      buildChildEnv({ parent: PARENT, allowed: [...CHILD_ENV_ALLOWLIST, 'ALLOW_WRITES'] }),
    ).toThrow(/child-env allowlist names ALLOW_WRITES/);

    // The caller's own overrides are checked too, so the service cannot smuggle
    // one past its own gate.
    expect(() => buildChildEnv({ parent: PARENT, overrides: { ALLOW_WRITES: 'true' } })).toThrow(
      /overrides for this spawn names ALLOW_WRITES/,
    );

    // THE SILENT HALF, and the case the assertions above are written against: the
    // list that actually ships must NOT trip it. A pattern wide enough to match
    // `PATHEXT` or `TEST_ID_ATTRIBUTE` would refuse every spawn, and all three
    // `toThrow` calls above would still be green.
    expect(() => buildChildEnv({ parent: PARENT })).not.toThrow();
    expect(
      CHILD_ENV_ALLOWLIST.filter((name) => /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name)),
      'an allowlisted name is secret-shaped — the shipped list trips its own tripwire',
    ).toEqual([]);
  });
});

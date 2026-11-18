import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { findRepoRoot } from '@aitp/shared';
import { execFileSyncClean, spawnSyncClean } from '../support/spawn-clean';
import { stripComments } from '../support/strip-comments';

/**
 * THE SETUP PROJECT COLLECTS ONE APPLICATION'S SIGN-IN, NOT EVERY APPLICATION'S.
 *
 * ## The fault this exists for
 *
 * `live-setup`'s testMatch was `/live-setup.ts|auth.setup.ts/` — a pattern with no
 * application in it. Every live browser project depends on that project, so EVERY
 * live run collected EVERY application's sign-in setup.
 *
 * With one application that was invisible. Found on 2026-11-18 onboarding the
 * second: with `TEST_ENV=ecom`, a browser run would have executed
 * `tests/apps/dms/auth.setup.ts`, which imports the DMS `LoginPage` and would have
 * driven DMS's selectors against Ecom's URL — and the brief for that batch said
 * DMS stays untouched. It is the same class as `liveTestMatch`, which was already
 * application-keyed, in the one place that had been missed.
 *
 * ## Why one half is behavioural and the other is a scan
 *
 * The ecom half is asserted by ASKING PLAYWRIGHT what it collects, which is the
 * mechanism's own verdict (§Z) rather than a guess from the pattern.
 *
 * The dms half cannot be asked the same way **on this machine**: no DMS
 * environment resolves here — `app`, `qa` and `staging` each need a variable that
 * is not in this `.env` (`CONFIG_ERROR` before collection starts), which is a fact
 * about this checkout and not about the change. So that half is asserted against
 * the config SOURCE. That is weaker and is said so rather than dressed up: it
 * proves the pattern interpolates the application, not that Playwright then
 * collects the file. Anyone with DMS credentials can upgrade it by running the
 * same spawn with `TEST_ENV=app`.
 */

const ROOT = findRepoRoot();
const PLAYWRIGHT = path.join(ROOT, 'node_modules', '@playwright', 'test', 'cli.js');

const listFor = (environment: string) =>
  spawnSyncClean(process.execPath, [PLAYWRIGHT, 'test', '--project=live-setup', '--list'], {
    cwd: ROOT,
    maxBuffer: 20 * 1024 * 1024,
    env: { TEST_ENV: environment, LOG_LEVEL: 'error' },
  });

test.describe('the live-setup project is scoped to one application @unit', () => {
  test('L1: with TEST_ENV=ecom it does NOT collect another application’s sign-in', () => {
    // wrong: `tests/apps/dms/auth.setup.ts` in the list — which is what the old
    // pattern gave. It would have run DMS's LoginPage against Ecom's URL on every
    // ecom browser run, contacting a system this batch was told not to touch and
    // failing in a way that reads as an Ecom problem.
    const result = listFor('ecom');
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status, output).toBe(0);
    // §T — a run that collected nothing would satisfy the absence trivially.
    expect(output, 'nothing was collected, so the absence below proves nothing').toContain(
      'live-setup.ts',
    );
    expect(output).not.toContain('auth.setup.ts');
    expect(output).not.toContain('apps\\dms');
    expect(output).not.toContain('apps/dms');
  });

  test('L2: the application-agnostic guards are STILL collected, for every application', () => {
    // wrong: scoping the whole project and losing the kit-integrity and
    // environment-name guards with it. Those are not application-specific — a
    // modified kit must not reach ANY live system — so narrowing the pattern must
    // not narrow them. This is the half that stops the fix from being a deletion
    // (§V: a claim that safety moved is tested by checking what remains).
    const output = `${listFor('ecom').stdout}`;
    expect(output).toContain('the kit has not been modified');
    expect(output).toContain('the live environment is named explicitly');
  });

  test('L3: the pattern interpolates the application rather than naming one', () => {
    // wrong: a pattern hard-coded to `ecom`, which would fix this batch and break
    // DMS — the mirror image of the bug. Asserted against the config source
    // because no DMS environment resolves on this machine to ask Playwright
    // directly; that limitation is real and is recorded here rather than hidden,
    // because a source scan proves the pattern is built right and not that
    // collection then works.
    // COMMENTS STRIPPED, because this file's own explanation QUOTES the old pattern
    // and the first attempt failed on its own prose. Prose about a mistake must not
    // read as the mistake, which is the rule the shared stripComments exists for.
    const config = stripComments(readFileSync(path.join(ROOT, 'playwright.config.ts'), 'utf8'));
    expect(config).toContain('liveSetupMatch');
    // The application is interpolated into it, and `live-setup.ts` itself is not.
    // Asserted by finding the LINE rather than by matching escaped dots: the first
    // attempt was `/liveEnv\.application[^\n]*auth\\?\.setup/`, which allows one
    // backslash where the source has two (`auth\\.setup\\.ts` inside a template
    // literal). The property held and the regex was wrong about escaping — so the
    // assertion now asks the question directly instead of re-deriving the quoting.
    const lines = config.split('\n');
    const interpolated = lines.filter(
      (line) =>
        line.includes('liveEnv.application') && line.includes('auth') && line.includes('setup'),
    );
    expect(interpolated, 'no line builds the setup pattern from liveEnv.application').not.toEqual(
      [],
    );
    expect(config).not.toContain('/live-setup.ts|auth.setup.ts/');
  });

  test('L4: every application directory that HAS a sign-in setup is reachable by the pattern', () => {
    // wrong: a pattern that silently matches no application's setup — green on
    // ecom, which has none, and broken for every application that does. Derived
    // from the tree rather than listed, so an application added later is covered
    // without anybody editing this (§AE). It checks the pattern SHAPE against the
    // real paths, which is as far as a non-resolving environment allows.
    const setups = execFileSyncClean('git', ['ls-files', 'tests/apps'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.endsWith('auth.setup.ts'));
    expect(setups.length, 'no auth.setup.ts anywhere — this check had no subject').toBeGreaterThan(
      0,
    );
    for (const file of setups) {
      const application = /^tests\/apps\/([^/]+)\//.exec(file)?.[1];
      expect(application, file).toBeTruthy();
      // The pattern the config builds for that application must match this path,
      // on this platform's separators.
      const pattern = new RegExp(`tests[\\\\/]apps[\\\\/]${application}[\\\\/]auth\\.setup\\.ts$`);
      expect(pattern.test(file), `${file} is not matched for application ${application}`).toBe(
        true,
      );
      // And NOT matched for a different application, which is the whole point.
      const other = new RegExp(`tests[\\\\/]apps[\\\\/]__other__[\\\\/]auth\\.setup\\.ts$`);
      expect(other.test(file)).toBe(false);
    }
  });
});

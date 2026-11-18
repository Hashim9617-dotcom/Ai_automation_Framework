import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { findRepoRoot } from '@aitp/shared';
import { execFileSyncClean } from '../support/spawn-clean';
import { stripComments } from '../support/strip-comments';

/**
 * `ALLOW_WRITES` IS STRUCTURALLY IMPOSSIBLE FOR EVERY APPLICATION BUT ONE.
 *
 * ## Why this is not about the variable
 *
 * The brief for onboarding Ecom required that `ALLOW_WRITES` be impossible for it.
 * The honest answer is that it already was, and for a better reason than a check:
 * `playwright.config.ts` collects live specs from `tests/apps/${application}/**`, so
 * with `application: "ecom"` **no spec is collected at all** and the variable has
 * nothing to act on. That is isolation rather than vigilance, which is the fix this
 * repo prefers.
 *
 * But isolation has its own silent failure: it holds only while no other
 * application's directory exists. Create `tests/apps/ecom/` with one write-risky
 * spec in it and the guarantee is gone, with nothing to say so. **Checking that the
 * isolation is real is the rule** — the controls that prove a harness can detect do
 * not prove the sandbox is the thing it detects in.
 *
 * ## What it asserts, and why NOT by searching for the tag
 *
 * The first draft scanned every spec file for `@write` and flagged three, none of
 * them a tagged test: `api-hardening.spec.ts` passes the string as DATA
 * (`{"grep":"@write"}` is the request it proves is harmless), and this file's own
 * titles contain the word because they are about it. Asking a source file "does the
 * text @write appear" asks a question the text cannot answer — a tag, a grep value
 * and a sentence are indistinguishable (§Z).
 *
 * So the question asked is the one that decides the outcome: **does any directory
 * under `tests/apps/` exist for an application other than the one allowed?** If none
 * does, `liveTestMatch` collects nothing for every other application, whatever any
 * file contains. The tag scan is kept for `tests/apps/**` only, where a tag is a tag
 * and no prose about tagging lives.
 */

const ROOT = findRepoRoot();
const APPS_DIR = path.join(ROOT, 'tests', 'apps');

/** The one application whose specs may drive a real system today. */
const WRITE_HOME = 'dms';

/** `@write` as a Playwright tag. Only ever applied under `tests/apps/**`. */
const WRITE_TAG = /@write\b/;

function appSpecFiles(): string[] {
  return execFileSyncClean('git', ['ls-files', 'tests/apps'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.spec.ts'));
}

test.describe('no application but one has live specs at all @unit', () => {
  test('W1: tests/apps/ holds exactly the application directories that are expected', () => {
    // wrong: a directory appearing without anybody deciding to add it. The moment
    // `tests/apps/<slug>/` exists, `liveTestMatch` collects its specs whenever that
    // application resolves — so a new directory is a new live surface, and it must
    // be a visible act rather than a side effect of somebody organising files.
    //
    // THIS ASSERTION CHANGED ON 2026-11-18, and the change is the guard working.
    // It read `toEqual([WRITE_HOME])` and failed the moment `tests/apps/ecom/` was
    // created for ECOM-1a — which is exactly what it was written to do. Adding the
    // slug here is the deliberate act; the safety property did NOT move with it,
    // because what makes ALLOW_WRITES impossible for ecom is that no `@write` tag
    // exists outside dms, and W2 is what holds that.
    const directories = readdirSync(APPS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(directories).toEqual(['dms', 'ecom']);

    // AND EVERY ONE OF THEM IS A DECLARED APPLICATION. A directory named for a slug
    // that no environment resolves is a live surface nothing can ever reach — dead
    // on its own, and misleading next to the ones that work. Derived from
    // `config/apps/`, so a third application cannot be added here by typo (§AE).
    const declared = readdirSync(path.join(ROOT, 'config', 'apps'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    expect(declared.length, 'no applications declared — the check had no subject').toBeGreaterThan(
      0,
    );
    expect(directories.filter((slug) => !declared.includes(slug))).toEqual([]);
  });

  test('W2: every @write tag under tests/apps/ is in the one allowed application', () => {
    // wrong: W1 alone says nothing about where tags live INSIDE the allowed tree —
    // and if a second application's directory is ever added deliberately, this is the
    // assertion that then has to be revisited rather than silently passing. The scan
    // is scoped to tests/apps/, where the word only ever appears as a tag.
    const files = appSpecFiles();
    // §T: a listing that returned nothing reports clean. The DMS suite is 45 tests
    // across several spec files; zero would mean `git ls-files` changed, not the tree.
    expect(files.length, 'the scan listed no app spec files, so it proved nothing').toBeGreaterThan(
      3,
    );
    const offenders = files.filter(
      (file) =>
        !file.startsWith(`tests/apps/${WRITE_HOME}/`) &&
        WRITE_TAG.test(stripComments(readFileSync(path.join(ROOT, file), 'utf8'))),
    );
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  test('W3: the detector FINDS the two tag sites that do exist', () => {
    // wrong: W2 over a tree with no @write tag anywhere is satisfied by a regex that
    // matches nothing — "no offenders" and "no offenders my pattern can see" are the
    // same output (§AA). The two real sites are the known input W2's zero depends on
    // being findable; if they are ever removed this fails and says to re-plant.
    //
    // TWO SITES, THREE TESTS, and the units are not interchangeable. The first draft
    // asserted three and failed at two — because `admin.spec.ts` tags a
    // `test.describe` holding two tests and `file-explorer.spec.ts` tags one test.
    // Counting text occurrences cannot see that, which is §Z pointed at this very
    // assertion: the number of TESTS is Playwright's to report, and asking it would
    // need a live environment resolved from this machine's `.env` (§AJ). So this
    // asserts the unit it can actually measure, and names the arithmetic instead of
    // implying it.
    const tagged = appSpecFiles().filter((file) =>
      WRITE_TAG.test(stripComments(readFileSync(path.join(ROOT, file), 'utf8'))),
    );
    expect(tagged, 'no @write tag found anywhere — W2 is now vacuous').not.toEqual([]);
    const sites = tagged
      .map(
        (file) =>
          (stripComments(readFileSync(path.join(ROOT, file), 'utf8')).match(/@write\b/g) ?? [])
            .length,
      )
      .reduce((a, b) => a + b, 0);
    expect(sites, 'ALLOW_WRITES is documented as affecting three tests, at two tag sites').toBe(2);
    expect(tagged.sort()).toEqual([
      'tests/apps/dms/admin.spec.ts',
      'tests/apps/dms/file-explorer.spec.ts',
    ]);
  });

  test('W4: liveTestMatch is what makes W1 a guarantee, and it is keyed on the application', () => {
    // wrong: if the config collected `tests/apps/**` instead, one application's
    // directory would be collected by EVERY application's run and W1's "exactly one
    // directory" would be about tidiness rather than safety. The mechanism the claim
    // rests on is asserted, not assumed (§V).
    //
    // READ RAW, NOT STRIPPED, and that is forced rather than chosen: the pattern is
    // `**/tests/apps/${liveEnv.application}/**/*.spec.ts`, and the `/**/` inside it
    // looks exactly like a block comment to `stripComments` — `/*` … `*/` — so
    // stripping blanked the glob and this assertion failed over an instrument that
    // had mangled its own subject. That is the limitation that helper documents, met
    // for real. Stripping buys nothing here: no comment contains this expression.
    const config = readFileSync(path.join(ROOT, 'playwright.config.ts'), 'utf8');
    expect(config).toContain('tests/apps/${liveEnv.application}/');
  });
});

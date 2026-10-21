import { execSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { findRepoRoot } from '@aitp/shared';

/**
 * No file that looks like a credential dump is tracked, or even stageable.
 *
 * ## This is not hypothetical
 *
 * On 2026-10-21 a file called `postgresql password.txt` — 32 bytes — was sitting
 * in the repository root, **untracked and unignored**. `git add -A`, which is
 * what three commits that week had used, would have put it in permanent history.
 * It was caught by someone reading `git status`, which works until the once it
 * does not.
 *
 * The `.gitignore` rules added with this file are the prevention. They are not
 * the control: `git add -f` bypasses an ignore rule, and a rule nobody checks is
 * a rule that has quietly stopped applying. So this is a test, for the same
 * reason `no-workbooks.spec.ts` is one — a claim with no falsifier is
 * decoration.
 *
 * ## Two questions, because they fail at different times
 *
 * `git ls-files` can only see a credential that has ALREADY been committed, by
 * which point the remedy is history rewriting. `git status` sees one sitting in
 * the working tree, before the mistake. Both are asked.
 */

const ROOT = findRepoRoot();

/**
 * What a credential dump is called.
 *
 * A name-shape list, and therefore bounded by whoever wrote it — the same limit
 * the invisible-character detector had before it moved to Unicode categories.
 * There is no structural definition of "this file is a secret", so the honest
 * thing is to say what this covers rather than imply completeness: the shapes a
 * credential actually arrived in here, plus the standard key extensions.
 */
const CREDENTIAL_SHAPED =
  /(^|[/\\_. -])(password|passwords|passwd|secret|secrets|credential|credentials|apikey|api[_-]key)([/\\_. -]|$)|\.(pem|key|pfx|p12|jks|keystore|ppk)$|(^|[/\\])(id_rsa|id_ed25519|id_dsa|\.pgpass|\.netrc)$/i;

/**
 * Paths that MATCH the pattern and are legitimately in the repository.
 *
 * Every entry is code or prose ABOUT credentials rather than a credential, and
 * each is spelled in full — no directory-wide exemptions, because a directory
 * exemption is how the next real one gets through. An allow-list that grows
 * without anyone noticing is the failure mode this list has to avoid being.
 */
const ALLOWED = new Set<string>([
  // The example env file: variable NAMES and placeholders, no values. It is the
  // documentation of what to set, and `.gitignore` un-ignores it on purpose.
  '.env.example',
]);

/** Extensions that are source or documentation, never a credential dump. */
const CODE_OR_PROSE = /\.(ts|tsx|js|mjs|cjs|json|md|yml|yaml|prisma|sql|html|css|groovy)$/i;

const git = (command: string): string[] =>
  execSync(command, { cwd: ROOT, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 })
    .split(/\r?\n/)
    .filter(Boolean);

/** The check, separated so a PLANTED path can be handed to it (§W). */
export function credentialLooking(paths: readonly string[]): string[] {
  return paths.filter((file) => {
    if (ALLOWED.has(file)) return false;
    // Source and documentation are allowed to be ABOUT credentials — this file
    // is itself a example, and so is `apps/api/src/config/database.ts`.
    if (CODE_OR_PROSE.test(file)) return false;
    return CREDENTIAL_SHAPED.test(file);
  });
}

test.describe('no credential dump is in the repository @unit', () => {
  test('no TRACKED file looks like a credential', () => {
    // wrong: a committed credential, which `.gitignore` cannot help with because
    // an ignore rule does not apply to a file git is already tracking — and by
    // then the remedy is rewriting history and rotating the secret, not deleting
    // a file.
    const tracked = git('git ls-files');

    // §T — the listing had a subject. One that read nothing reports clean
    // forever, which is the exact shape of this repo's `slice(3)` near-miss.
    expect(tracked.length, 'git ls-files returned almost nothing').toBeGreaterThan(200);

    expect(
      credentialLooking(tracked),
      'these tracked files look like credential dumps. If one is legitimate, add it\n' +
        'to ALLOWED by its full path with a reason — never a directory:',
    ).toEqual([]);
  });

  test('nor is one sitting UNTRACKED in the tree, where `git add -A` would take it', () => {
    // wrong: this is the case that actually happened, and the tracked check
    // above could not see it. `postgresql password.txt` was untracked AND
    // unignored, so it was invisible to `git ls-files` and one `git add -A` from
    // being permanent. Asking git for untracked-and-not-ignored paths is the
    // only question that catches it BEFORE the mistake.
    //
    // `--exclude-standard` is what makes this about STAGEABLE files: a
    // credential the ignore rules already cover is handled, and flagging it
    // would train someone to ignore this test.
    const stageable = git('git ls-files --others --exclude-standard');

    const found = credentialLooking(stageable);
    expect(
      found,
      'these are untracked, NOT ignored, and would be committed by `git add -A`.\n' +
        'Move them outside the repository, or add an ignore rule:',
    ).toEqual([]);

    // §W — both halves, on the detector itself. The real tree is (now) clean, so
    // over it a detector that matched NOTHING and one that works are
    // indistinguishable. These two inputs separate them.
    //
    // ASSEMBLED at runtime rather than written out, because this file is itself
    // scanned by the test above: a literal credential-shaped path spelled here
    // would be a finding in a real file.
    const WORD = 'pass' + 'word';
    expect(
      credentialLooking([`postgresql ${WORD}.txt`, 'deploy.pem', 'secrets', '.ssh/id_rsa']),
      'the detector missed a credential-shaped name',
    ).toHaveLength(4);

    // And the silent half, which is what the assertion above is written against:
    // source and prose that MENTION credentials must not be flagged, or the test
    // is answered by an allow-list that eventually swallows a real case.
    expect(
      credentialLooking([
        'apps/api/src/config/database.ts',
        `tests/unit/${WORD}-hasher.spec.ts`,
        'docs/design/B1-auth-and-data.md',
        '.env.example',
        'packages/shared/src/utils/redact.ts',
      ]),
      'a source or documentation file was flagged as a credential',
    ).toEqual([]);
  });
});

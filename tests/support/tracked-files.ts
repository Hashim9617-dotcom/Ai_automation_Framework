import path from 'node:path';
import { findRepoRoot } from '@aitp/shared';
import { execFileSyncClean } from './spawn-clean';

/**
 * EVERY SPEC FILE A RUN COULD COLLECT, from git rather than from a list anybody
 * maintains.
 *
 * A guard over "all the specs" has to derive its subject. A hand-written list is a
 * denylist of the files somebody remembered, and the file it omits is the one the
 * guard exists for (§AE) — the spec added next week is exactly the one nobody thinks
 * to add to the list.
 *
 * ## Tracked AND untracked-but-not-ignored, because that is what RUNS
 *
 * The first version listed the index alone, and the guard that uses it failed on its
 * own first run: the spec it was written for was in the working tree and not yet
 * committed, so `git ls-files` could not see it and the guard reported "nothing
 * examined". That is the right subject for a guard about what the REPOSITORY
 * carries, and the wrong one here — `playwright test` collects from DISK, so a spec
 * that exists uncommitted is a spec a local run will pick up and a mis-tagged one
 * will be collected by every smoke run somebody does before committing it.
 *
 * `--exclude-standard` keeps ignored paths out, so generated or scratch specs are
 * still none of this helper's business.
 *
 * `git` is the one spawn this repo does NOT scrub the environment for, and the
 * exemption is reasoned rather than convenient: git consults neither `NODE_PATH` nor
 * `NODE_OPTIONS`, so its answer cannot differ between the runner's environment and a
 * production one. It still goes through `execFileSyncClean` so that
 * `no-unscrubbed-spawn.spec.ts` sees a sanctioned spawner.
 *
 * Paths come back with forward slashes, as git reports them, and are left that way:
 * a caller joins them onto a root with `path.join`, which handles the separator, and
 * a message that quotes a path reads the same on every machine.
 */
export function collectableSpecFiles(root: string = findRepoRoot()): string[] {
  const out = execFileSyncClean(
    'git',
    ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'tests'],
    { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 },
  );
  const files = [
    ...new Set(
      out
        .split('\u0000')
        .map((line) => line.trim())
        .filter((line) => line.endsWith('.spec.ts')),
    ),
  ].sort();

  // ASSERTS IT HAD A SUBJECT. A listing that read nothing would let every caller
  // report "no offenders" over an empty set — the §T failure, one level down in the
  // helper where no caller would think to look for it.
  if (files.length === 0) {
    throw new Error(
      `\`git ls-files\` found no .spec.ts under ${path.join(root, 'tests')} — refusing to hand ` +
        'a ' +
        'guard an empty file list, which it would report as clean',
    );
  }
  return files;
}

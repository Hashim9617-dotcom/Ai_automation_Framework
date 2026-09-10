import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { findRepoRoot } from '@aitp/shared';

/**
 * The suite refuses to be green while a mutation is applied to the source.
 *
 * **Earned on 2026-09-10.** The mutation harness crashed when its restore
 * `writeFileSync` hit a Windows file lock, and left `passed: results.length` —
 * the known-CAUGHT control, a tally that counts every row as passed — in
 * `packages/shared/src/authored/execute.ts`. A commit in that window would have
 * shipped it.
 *
 * Three defences were added, and they are deliberately different in kind:
 *
 * 1. the harness RETRIES the restore and shouts the fix if it truly fails;
 * 2. it writes a `.mutation-in-progress` sentinel that outlives a crash, so
 *    `git status` shows an untracked warning to anyone about to commit;
 * 3. **this test**, which is the only one that needs nobody to be looking.
 *
 * (1) and (2) make the failure louder. This makes it mechanical: a plain
 * `pnpm test:unit` after a crashed run goes red and says why.
 *
 * The harness exempts itself per child process via `AITP_MUTATION_RUN`, because
 * it applies mutations on purpose — without that, every mutation would trip this
 * guard and every one would be reported CAUGHT by it, which is the harness
 * measuring itself.
 */

const SENTINEL = '.mutation-in-progress';

test.describe('no mutation residue in the working tree @unit', () => {
  test('the source is not mid-mutation', () => {
    // wrong: without this, a crashed harness leaves a survivor-shaped mutation
    // that breaks no test — so a green suite says nothing and the residue is
    // committable. That is exactly what happened, and the only thing that
    // caught it was a human reading `git diff` for an unrelated reason.
    if (process.env.AITP_MUTATION_RUN) {
      test.skip(true, 'the mutation harness applies mutations on purpose');
      return;
    }

    const sentinel = path.join(findRepoRoot(), SENTINEL);
    const present = existsSync(sentinel);
    const detail = present ? readFileSync(sentinel, 'utf8') : '';

    expect(
      present,
      `A mutation is still applied to the working tree.\n\n${detail}\n` +
        'The harness did not finish cleanly. Restore the file named above before\n' +
        'running anything else, and do not commit until you have.',
    ).toBe(false);
  });

  test('the guard is looking at the real repo root', () => {
    // wrong: a guard that checks the wrong path passes forever and reports a
    // clean tree it never looked at — rule 2, pointed at the guard. The check
    // above cannot distinguish "no sentinel" from "wrong path", so this does.
    //
    // The first version of this test also asserted `AITP_MUTATION_RUN` was
    // unset, "to prove the exemption is opt-in". That was incoherent: the
    // harness sets the variable for EVERY suite it runs, baseline included, so
    // the assertion failed the moment the guard shipped — and the harness
    // refused to start rather than produce verdicts against a red baseline.
    // Whether the variable is set is a fact about who invoked the suite, which
    // no test inside the suite can meaningfully assert.
    const root = findRepoRoot();
    expect(existsSync(path.join(root, 'pnpm-workspace.yaml'))).toBe(true);
    expect(path.join(root, SENTINEL).endsWith(SENTINEL)).toBe(true);
  });
});

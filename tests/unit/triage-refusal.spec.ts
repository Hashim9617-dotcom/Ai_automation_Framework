import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { findRepoRoot } from '@aitp/shared';
import { spawnSyncClean } from '../support/spawn-clean';

/**
 * `pnpm triage` REFUSES. It does not crash.
 *
 * The refusal itself was always right — "no captures found under
 * artifacts/dms/inspect — refusing to report a ceiling. Run `pnpm inspect` against
 * that application first" says the problem, the reason and the next step. But the
 * script ended in a bare `main();`, so the message arrived as an unhandled rejection
 * with fifteen frames of `Module._compile` under it.
 *
 * Found by running what `docs/QA-QUICKSTART.md` tells a QA to run, on a fresh clone,
 * rather than by reading it (§AG). It is the FIRST command in the quickstart's chain
 * that a new QA reaches, and on a fresh clone it always refuses — there are no
 * captures yet. So a stack trace was the ordinary first experience of this kit, and
 * the honest reading of a stack trace is "this tool is broken".
 *
 * The fix was wrong on the first attempt in a way only a run could show: `main()`
 * returns `void`, so `main().catch(…)` is a type error, and tsx transpiles without
 * typechecking — it ran, it printed the stack anyway, and this test is what said so.
 *
 * This repo already separates NOT CONFIGURED from EMPTY from FAILED TO LOAD on the
 * grounds that they tell the reader to do different things. A refusal dressed as a
 * crash is the same confusion one layer out: the reader cannot tell "you have a step
 * to do first" from "this is a bug in the platform".
 */

const ROOT = findRepoRoot();
const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

/** Frames Node prints when nothing caught the error. */
const STACK_FRAME = /\bat (Module\._compile|Object\.<anonymous>|wrapModuleLoad|main)\b/;

test.describe('a refusal reads as a refusal @unit', () => {
  test('no captures: it names the step to do first, with no stack trace', () => {
    // wrong: the message is there but so are fifteen `at Module._compile` frames, so
    // the output reads as a crash. Note which half of the assertion does the work —
    // the message alone passed BEFORE the fix as well, and only the absence of the
    // frames tells the two apart.
    const root = mkdtempSync(path.join(tmpdir(), 'aitp-triage-refusal-'));
    try {
      writeFileSync(path.join(root, 'pnpm-workspace.yaml'), '');
      mkdirSync(path.join(root, 'artifacts'), { recursive: true });
      // THE EARLIER REFUSALS HAVE TO BE SATISFIED, or this measures one of them
      // instead. Both were met in order while writing this, each a clean refusal of
      // its own: a missing `config/env/local.json`, then missing module routes.
      //
      // `bundled-demo` with `TEST_ENV=local` rather than `dms`, so the application and
      // the environment AGREE whatever this machine's `.env` says — `--app dms` here
      // refuses for the disagreement instead, on a developer machine and not on a
      // fresh clone. That is the machine-dependence that `no-real-env.spec.ts` was
      // just corrected for.
      mkdirSync(path.join(root, 'config', 'env'), { recursive: true });
      copyFileSync(
        path.join(ROOT, 'config', 'env', 'local.json'),
        path.join(root, 'config', 'env', 'local.json'),
      );
      mkdirSync(path.join(root, 'config', 'apps', 'bundled-demo'), { recursive: true });
      copyFileSync(
        path.join(ROOT, 'config', 'apps', 'dms', 'module-routes.json'),
        path.join(root, 'config', 'apps', 'bundled-demo', 'module-routes.json'),
      );

      const run = spawnSyncClean(
        process.execPath,
        [
          TSX,
          path.join(ROOT, 'scripts', 'triage-sheet.ts'),
          path.join(root, 'no-such-workbook.xlsx'),
          '--app',
          'bundled-demo',
        ],
        { cwd: ROOT, env: { AITP_REPO_ROOT: root, TEST_ENV: 'local' }, maxBuffer: 8 * 1024 * 1024 },
      );
      const output = run.stdout + run.stderr;

      // §T: assert the check had a subject. An invocation that failed for some other
      // reason — a missing `tsx`, a bad path — would produce no frames either, and
      // this test would pass having run nothing of interest.
      expect(output, 'triage did not reach its capture check').toContain(
        'refusing to report a ceiling',
      );
      expect(run.status).toBe(1);
      expect(
        STACK_FRAME.test(output),
        `the refusal was printed as a crash:\n${output.slice(0, 600)}`,
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

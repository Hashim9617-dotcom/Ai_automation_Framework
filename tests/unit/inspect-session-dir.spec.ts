import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { findRepoRoot } from '@aitp/shared';
import { spawnSyncClean } from '../support/spawn-clean';

/**
 * A SESSION DIRECTORY ARRIVES WITH THE FIRST THING WRITTEN INTO IT.
 *
 * `scripts/inspect-app.ts` used to call `mkdirSync(outDir)` as soon as it had computed
 * the timestamp — before the browser launched, before anything was captured, before it
 * knew whether this run would produce a report at all. So every abandoned run left an
 * empty timestamped directory behind, and an abandoned run is the common case: the
 * tool is interactive, a human opens it to look at a page and closes it again.
 *
 * Counted 2026-10-01, not estimated: all 16 sessions in the legacy
 * `artifacts/inspect/` root are completely empty, against 10 real ones under
 * `artifacts/dms/inspect/`. The 16 are deliberately NOT deleted — they are counted and
 * reported, because a capture is provenance and an empty one still records that
 * somebody looked.
 *
 * ## Why this is a spawn and not a unit call
 *
 * The property is about WHEN a side effect happens relative to everything else the
 * script does, and `main()` is one function with the browser, the readline prompt and
 * the writes all inside it. A stub cannot hold an ORDER (§R): a stubbed `mkdirSync`
 * would be called in the right sequence by construction, because the sequence is what
 * is under test. The only instrument that can tell "created at the top" from "created
 * at the first write" is the real script, run to the point of abandonment, and then
 * looking at the filesystem.
 *
 * Both halves (§W), because "0 directories" alone is equally satisfied by a script
 * that can no longer write a capture at all:
 *
 *   - a run that captures nothing leaves NOTHING;
 *   - a run that captures one state leaves EXACTLY ONE directory, with both files in
 *     it.
 *
 * And the first half says WHY it is zero (§X): it asserts the banner, which the script
 * prints only after the browser launched and the page loaded. Without that, a demo
 * server that was not running would give the same verdict for the opposite reason —
 * nothing was created because nothing ever started.
 */

const ROOT = findRepoRoot();
/**
 * `tsx`'s own entry point, run by this Node — not `npx`, whose Windows shim is a
 * `.cmd` that Node 24 refuses to spawn without a shell (the same reason
 * `app-suite-scope.spec.ts` names Playwright's `cli.js` directly).
 */
const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

/**
 * A repo root with `config/env/local.json` and NO `.env`.
 *
 * Two reasons, and the second is the one that makes this more than tidiness: the
 * captures land under `<root>/artifacts/`, so the real `artifacts/` tree is untouched
 * and the count this test performs cannot be polluted by it; and the child loads no
 * real `.env`, so it cannot be pointed at a customer system by this machine's
 * configuration (SEC-2, SEC-3e).
 */
function temporaryRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'aitp-inspect-session-'));
  writeFileSync(path.join(root, 'pnpm-workspace.yaml'), '');
  mkdirSync(path.join(root, 'config', 'env'), { recursive: true });
  copyFileSync(
    path.join(ROOT, 'config', 'env', 'local.json'),
    path.join(root, 'config', 'env', 'local.json'),
  );
  return root;
}

/** The session directories the run left behind, or `[]` if the root was never made. */
function sessionsIn(root: string): string[] {
  try {
    return readdirSync(path.join(root, 'artifacts', 'bundled-demo', 'inspect'));
  } catch {
    // Distinguished from "the directory exists and is empty" by the caller only
    // insofar as both are zero sessions — which is the property. The directory not
    // existing at all is the stronger of the two and the one this script now gives.
    return [];
  }
}

function runInspect(
  root: string,
  input: string,
  args: readonly string[] = [],
): { status: number | null; stdout: string; stderr: string } {
  // A missing runner would make every case below report zero directories — the
  // flattering answer, reached by never starting the script (§T: assert the check had
  // a subject).
  expect(existsSync(TSX), `tsx is not at ${TSX}; this test spawned nothing`).toBe(true);
  return spawnSyncClean(
    process.execPath,
    [TSX, path.join(ROOT, 'scripts', 'inspect-app.ts'), ...args],
    {
      cwd: ROOT,
      input,
      env: {
        AITP_REPO_ROOT: root,
        // Pinned here, not inherited: this machine's `.env` says `app`, and a unit run
        // deliberately keeps that value (it is fixture-safe). Passing it on would aim
        // an interactive capture tool at the customer system.
        TEST_ENV: 'local',
        INSPECT_HEADLESS: 'true',
      },
      maxBuffer: 20 * 1024 * 1024,
    },
  );
}

test.describe('the inspector leaves nothing behind when it captures nothing @unit', () => {
  // Two real browser launches.
  test.setTimeout(180_000);

  test('a run abandoned at the prompt leaves NO session directory', () => {
    // wrong: one empty timestamped directory, which is what all 16 of the legacy
    // sessions are. The abandoned run is the common case for an interactive tool, so
    // this was the usual outcome, not an edge.
    const root = temporaryRoot();
    try {
      const run = runInspect(root, 'q\n');

      // WHY it is zero. The banner is written after `chromium.launch()` and after
      // `page.goto()` resolved, so this run really did get past the point where the
      // directory used to be created. Without this line, a demo server that was not
      // running would pass this test while proving the opposite.
      expect(
        run.stdout,
        'the run never reached the prompt — it was not abandoned, it failed',
      ).toContain('A browser window is open');
      expect(run.stdout).toContain('Nothing captured');
      expect(sessionsIn(root), 'an abandoned run left a directory behind').toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a run that captures one state leaves exactly one, with both files', () => {
    // wrong: zero directories, because the script can no longer write a capture at
    // all — which the test above would report as a pass. This is the half that makes
    // "nothing was created" mean "nothing was created YET".
    const root = temporaryRoot();
    try {
      const run = runInspect(root, 'login\nq\n');

      expect(run.stdout, 'nothing was captured, so this proves nothing about the write').toContain(
        'captured "login"',
      );

      const sessions = sessionsIn(root);
      expect(sessions).toHaveLength(1);
      const [session] = sessions;
      // A throw rather than a default: joining `''` would read the inspect ROOT, which
      // contains exactly the two names expected below the moment anything writes there.
      if (!session) throw new Error('no session directory was written');
      const written = readdirSync(
        path.join(root, 'artifacts', 'bundled-demo', 'inspect', session),
      ).sort();
      expect(written).toEqual(['capture.json', 'report.md']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a REFUSAL creates nothing either', () => {
    // wrong: the host-mismatch refusal is reached after the directory was created, so
    // the tool refuses to capture and leaves a directory saying it did. A refusal path
    // that writes before refusing is the shape this ordering exists to prevent —
    // refuse first, create second.
    //
    // No browser here: the refusal happens before the launch, which is also why this
    // case cannot substitute for the one above.
    const root = temporaryRoot();
    try {
      const run = runInspect(root, '', ['https://not-the-configured-host.example.com/']);

      expect(run.status).toBe(1);
      expect(run.stdout + run.stderr).toContain('refusing to capture');
      expect(sessionsIn(root), 'a refusal left a directory behind').toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

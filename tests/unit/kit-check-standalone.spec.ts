import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { findRepoRoot } from '@aitp/shared';
import { verifyKitIntegrity, type KitProblem } from '@aitp/execution-engine';
import { spawnSyncClean } from '../support/spawn-clean';

/**
 * THE CHECK MUST NOT DEPEND ON WHAT IT PROTECTS (v0.4.1).
 *
 * Measured by hand on an extracted `qa-kit-v0.4.zip`, and reproduced in this repo
 * before any of this was written: renaming `packages/execution-engine` to
 * `packages/execution-engineer` made `pnpm auth` die with
 *
 *     Error: Cannot find module '@aitp/execution-engine'
 *     code: 'MODULE_NOT_FOUND'
 *
 * with no `KIT MODIFIED`, no banner and no named path. The check lived inside that
 * package and every QA script imported it from there, so resolution failed before a
 * line of check code ran.
 *
 * It failed CLOSED — the command did not proceed — and that half was right. The
 * problem is the message: a cryptic module error is precisely the one that invites a
 * QA's AI assistant to "fix" it by running `pnpm install`, renaming the folder back
 * or restoring files. That is the sequence the lock exists to prevent, set off by the
 * lock's own failure mode.
 *
 * ## Why every test here spawns a real process
 *
 * The thing under test is not a function's return value — it is whether a standalone
 * script, loaded by `node` with no `tsx` and no workspace resolution, reaches a
 * verdict at all. Calling it in-process would resolve modules the way the broken
 * version did and prove nothing (§AK: verify against an independent run, not against
 * the writer).
 */

const ROOT = findRepoRoot();
const CHECK = 'scripts/kit-check.mjs';

/**
 * A kit on disk: the check script, a manifest, and the locked files it describes.
 *
 * `kit-check.mjs` derives the root from ITS OWN location — no `AITP_REPO_ROOT`, no
 * flag — so a fixture has to contain a copy of the script. That is the point rather
 * than an inconvenience: a root that can be redirected is a check that can be aimed
 * at a kit nobody is about to run.
 */
function buildKit(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'aitp-kitcheck-'));
  const write = (relative: string, contents: string): void => {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, contents, 'utf8');
  };

  write('packages/execution-engine/src/index.ts', 'export const engine = 1;\n');
  write('packages/shared/src/index.ts', 'export const shared = 1;\n');
  write('scripts/auth-setup.ts', '// auth\n');
  write('docs/QA-QUICKSTART.md', '# quickstart\n');
  write('config/apps/dms/module-map.json', '{}\n');
  write('package.json', '{"name":"kit"}\n');
  // The QA's own file: present from the start, and never locked.
  write('config/apps/globex/module-map.json', '{}\n');

  // THE REAL SCRIPT, copied in. Not a re-implementation — that would test a second
  // copy of the thing rather than the thing.
  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  cpSync(path.join(ROOT, CHECK), path.join(root, CHECK));

  const locked = [
    'packages/execution-engine/src/index.ts',
    'packages/shared/src/index.ts',
    'scripts/auth-setup.ts',
    'scripts/kit-check.mjs',
    'docs/QA-QUICKSTART.md',
    'config/apps/dms/module-map.json',
    'package.json',
  ];
  const hash = (file: string): string =>
    createHash('sha256')
      .update(
        Buffer.from(readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n'), 'utf8'),
      )
      .digest('hex');

  writeFileSync(
    path.join(root, 'kit-manifest.json'),
    `${JSON.stringify(
      {
        kitVersion: '0.4.1',
        commit: 'deadbee',
        generatedAt: new Date().toISOString(),
        lockedPrefixes: ['packages', 'scripts', 'docs', 'config/apps/dms', 'package.json'],
        files: Object.fromEntries(locked.map((f) => [f, hash(f)])),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  return root;
}

/** Runs the kit's OWN copy of the script, with plain `node` and nothing else. */
const runCheck = (root: string, extraEnv: Record<string, string> = {}) =>
  spawnSyncClean(process.execPath, [path.join(root, CHECK)], {
    cwd: root,
    maxBuffer: 8 * 1024 * 1024,
    env: extraEnv,
  });

const output = (result: { stdout: unknown; stderr: unknown }): string =>
  `${String(result.stdout)}\n${String(result.stderr)}`;

test.describe('the standalone kit check (KS) @unit', () => {
  test('KS1: a clean kit passes, prints the version, and exits 0', () => {
    // wrong: a check that refused a clean kit would be switched off within a day, and
    // every other test here depends on this half being true.
    const root = buildKit();
    try {
      const result = runCheck(root);
      expect(output(result), output(result)).toContain('Kit v0.4.1 — integrity verified (7 files)');
      expect(output(result)).not.toContain('KIT MODIFIED');
      expect(result.status).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('KS2: a RENAMED packages/ subfolder prints KIT MODIFIED and names the path', () => {
    // wrong: THE v0.4 BUG. The command died with `Cannot find module
    // '@aitp/execution-engine'` and `MODULE_NOT_FOUND` — fail-closed, but with no
    // KIT MODIFIED, no banner and no named path, which is the message that invites an
    // AI assistant to repair the kit.
    const root = buildKit();
    try {
      renameSync(
        path.join(root, 'packages', 'execution-engine'),
        path.join(root, 'packages', 'execution-engineer'),
      );

      const result = runCheck(root);
      const text = output(result);
      expect(text, text).toContain('KIT MODIFIED');
      // BOTH HALVES OF A RENAME ARE NAMED: the path that vanished, and the one that
      // appeared. Either alone leaves a reader guessing what happened.
      expect(text).toContain('missing   packages/execution-engine/src/index.ts');
      expect(text).toContain('unlisted  packages/execution-engineer/src/index.ts');
      expect(text).toContain('Do not fix it');
      expect(result.status).toBe(1);
      // And it is OUR message, not Node's.
      expect(text).not.toContain('MODULE_NOT_FOUND');
      expect(text).not.toContain('Cannot find module');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('KS3: a DELETED locked file is refused and named', () => {
    // wrong: deleting a file is a modification that a hash comparison can only report
    // as "I could not read it", and a check that treated unreadable as acceptable
    // would make `rm` the way to turn itself off.
    const root = buildKit();
    try {
      rmSync(path.join(root, 'scripts', 'auth-setup.ts'));
      const result = runCheck(root);
      expect(output(result), output(result)).toContain('missing   scripts/auth-setup.ts');
      expect(result.status).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('KS4: ONE character changed in a locked file is refused and named', () => {
    // wrong: the whole point. A modified kit that still produces a pass makes every
    // result it reports worthless, and nobody downstream can tell.
    const root = buildKit();
    try {
      const victim = path.join(root, 'packages', 'shared', 'src', 'index.ts');
      writeFileSync(victim, readFileSync(victim, 'utf8').replace('= 1', '= 2'), 'utf8');

      const result = runCheck(root);
      expect(output(result), output(result)).toContain('changed   packages/shared/src/index.ts');
      expect(result.status).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('KS5: it runs with NO node_modules anywhere — it has no dependencies', () => {
    // wrong: the script imports a workspace package, or anything from node_modules,
    // and the v0.4 bug is back in a new shape — the check cannot run on precisely the
    // damaged kit it exists to report on. A fixture kit has no node_modules at all,
    // and `cwd` is that fixture, so this is not a hypothetical: nothing is resolvable
    // except Node's own built-ins.
    const root = buildKit();
    try {
      expect(
        readFileSync(path.join(root, CHECK), 'utf8').match(/^import .*from '(?!node:)/gm),
        'kit-check.mjs imports something that is not a node: built-in',
      ).toBeNull();

      const result = runCheck(root);
      expect(output(result), output(result)).toContain('integrity verified');
      expect(result.status).toBe(0);

      // DISCRIMINATING: prove the fixture really has no resolvable packages, so the
      // pass above cannot be explained by node_modules having been found elsewhere.
      const borrows = spawnSyncClean(
        process.execPath,
        [
          '-e',
          "import('@aitp/execution-engine').then(()=>console.log('RESOLVED')).catch((e)=>console.log(e.code))",
        ],
        { cwd: root, env: {} },
      );
      expect(String(borrows.stdout)).not.toContain('RESOLVED');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('KS6: every QA-facing package.json script invokes the check first', () => {
    // wrong: the script exists, is correct, and one command was never wired to it —
    // which is the only failure mode left once the check itself works, and the one no
    // test of the check could notice. A scan, with a planted miss, because a scan that
    // matched nothing would report every script clean (§AA).
    const scripts = (
      JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      }
    ).scripts;

    const MUST_BE_GATED = [
      'auth',
      'inspect',
      'triage',
      'verify-entries',
      'run-sheet',
      'test',
      'test:regression',
      'test:headed',
      'test:ui',
      'test:smoke:live',
    ];
    const ungated = MUST_BE_GATED.filter(
      (name) => !(scripts[name] ?? '').startsWith('node scripts/kit-check.mjs &&'),
    );
    expect(ungated, `these QA-facing scripts do not run the check: ${ungated.join(', ')}`).toEqual(
      [],
    );
    // §T — the scan had a subject. Every name above must exist.
    expect(MUST_BE_GATED.filter((name) => scripts[name] === undefined)).toEqual([]);

    // THE PLANTED MISS: the same predicate over a command that is deliberately NOT
    // gated must come out the other way, or this scan is satisfied by anything.
    expect((scripts['test:unit'] ?? '').startsWith('node scripts/kit-check.mjs &&')).toBe(false);
    expect((scripts.verify ?? '').startsWith('node scripts/kit-check.mjs &&')).toBe(false);
  });

  test('KS7: the standalone script and the in-engine check agree, clean and tampered', () => {
    // wrong: three copies of the hash-and-walk rule — this script, kit-manifest.mjs
    // and integrity.ts — drift apart, and the one a QA runs disagrees with the one the
    // tests cover. A hand-maintained triplicate is the §AE shape; this is what makes
    // it detected rather than maintained by hand.
    const root = buildKit();
    try {
      const marker = path.join(root, '.aitp-maintainer');

      // CLEAN: both pass.
      expect(runCheck(root).status).toBe(0);
      expect(verifyKitIntegrity({ root, markerPath: marker }).ok).toBe(true);

      // TAMPERED: both refuse, and name the same file.
      const victim = path.join(root, 'docs', 'QA-QUICKSTART.md');
      writeFileSync(victim, '# edited\n', 'utf8');

      const standalone = runCheck(root);
      const inEngine = verifyKitIntegrity({ root, markerPath: marker });
      expect(standalone.status).toBe(1);
      expect(inEngine.ok).toBe(false);
      if (inEngine.ok) throw new Error('unreachable');
      const named: KitProblem[] = inEngine.problems;
      expect(named).toEqual([{ file: 'docs/QA-QUICKSTART.md', why: 'changed' }]);
      expect(output(standalone)).toContain('changed   docs/QA-QUICKSTART.md');
      expect(output(standalone)).toContain('1 locked file(s) differ from the manifest.');
      expect(inEngine.detail).toBe('1 locked file(s) differ from the manifest.');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

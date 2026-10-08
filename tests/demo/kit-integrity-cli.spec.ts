import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect } from '@aitp/execution-engine';
import { findRepoRoot } from '@aitp/shared';
import { spawnSyncClean } from '../support/spawn-clean';

/**
 * THE CHECK RUNS BEFORE `.env` IS READ — proven through a real process (Part E).
 *
 * The unit tests establish what `verifyKitIntegrity` decides. They cannot establish
 * WHERE it is called, and the ordering is the whole guarantee: a modified kit must not
 * get as far as reading a credential or opening the customer's application.
 *
 * ## How the order is made observable
 *
 * The kit is copied to a temp root with **no `.env` at all** and **no environment
 * file** for the environment asked for. Three refusals are then possible, and which
 * one comes back says where the check sits:
 *
 * | returned | means |
 * | --- | --- |
 * | KIT MODIFIED | the integrity check ran first — what this asserts |
 * | "no environment was named" / "no such environment" | `.env` resolution ran first |
 * | an ALLOW_WRITES refusal | that gate ran first |
 *
 * So a single assertion on the message distinguishes all three, without needing to
 * instrument anything. §Y applied to a CLI: the later gate's verdict is only
 * meaningful once the earlier one is shown to have been reached.
 *
 * And the silent half matters as much: an UNMODIFIED copy of the same root must get
 * PAST the check and fail on the environment instead. Without it, "KIT MODIFIED"
 * could be what this command says about everything.
 */

const ROOT = findRepoRoot();
const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

/**
 * A kit root holding only what the integrity check reads.
 *
 * Copied rather than cloned: `git archive` would need a commit, and this has to work
 * from the working tree so a change to the checker is covered by the same run that
 * made it. `node_modules` is NOT copied — the child resolves modules from the real
 * repo via `cwd`, while `AITP_REPO_ROOT` points at the copy, which is exactly the
 * split that makes the check's root an injected input.
 */
function kitCopy(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'aitp-kit-cli-'));
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'kit-manifest.json'), 'utf8')) as {
    files: Record<string, string>;
  };

  for (const file of Object.keys(manifest.files)) {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(path.join(ROOT, file), target);
  }
  cpSync(path.join(ROOT, 'kit-manifest.json'), path.join(root, 'kit-manifest.json'));
  // NO `.env`, and no environment file for the name asked for below. The absence is
  // what makes the ordering observable.
  return root;
}

const runTriage = (root: string) =>
  spawnSyncClean(
    process.execPath,
    [TSX, path.join(ROOT, 'scripts', 'triage-sheet.ts'), 'C:/nonexistent.xlsx', '--app', 'dms'],
    {
      cwd: ROOT,
      maxBuffer: 20 * 1024 * 1024,
      // `AITP_REPO_ROOT` is the kit root the check will read. No TEST_ENV, no .env.
      env: { AITP_REPO_ROOT: root, LOG_LEVEL: 'error' },
    },
  );

test.describe('the integrity check runs before anything else, as a real process @demo', () => {
  test.setTimeout(240_000);

  test('KC1: a modified kit refuses with KIT MODIFIED, before any .env is read', async () => {
    // wrong: the check sits after the argument parsing or the environment resolution,
    // and a modified kit reads a credential — or opens the customer's application —
    // before anything notices. The refusal would still say KIT MODIFIED eventually,
    // which is why the ORDER needs its own test and not a stricter message.
    const root = kitCopy();
    try {
      const victim = path.join(root, 'packages', 'shared', 'src', 'index.ts');
      writeFileSync(victim, `${readFileSync(victim, 'utf8')}\n// tampered by KC1\n`, 'utf8');

      const result = runTriage(root);
      const output = `${result.stdout}\n${result.stderr}`;

      expect(output, output.slice(0, 1200)).toContain('KIT MODIFIED');
      expect(output).toContain('packages/shared/src/index.ts');
      expect(output).toContain('Do not fix it');
      expect(result.status).not.toBe(0);

      // THE ORDERING, asserted by what is ABSENT: no environment was resolved, so
      // nothing read `.env` or looked for a config file. Either of those messages here
      // would mean the check had been reached second.
      expect(output).not.toContain('no environment was named');
      expect(output).not.toContain('module routes');
      expect(output).not.toContain('integrity verified');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('KC2: the SAME root unmodified gets past the check and fails on the environment instead', async () => {
    // wrong: this is the silent half. "KIT MODIFIED" could be this command's answer to
    // everything — a missing node_modules, an unreadable root, an exception in the
    // walker — and KC1 would pass regardless. The only way to tell a working check from
    // a broken one is a copy that gets THROUGH it.
    const root = kitCopy();
    try {
      const result = runTriage(root);
      const output = `${result.stdout}\n${result.stderr}`;

      expect(output, output.slice(0, 1200)).toContain('integrity verified');
      expect(output).not.toContain('KIT MODIFIED');
      // And it then failed for the next reason along, which proves it carried on
      // rather than exiting quietly.
      expect(output).toMatch(/no environment was named|TEST_ENV/);
      expect(result.status).not.toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

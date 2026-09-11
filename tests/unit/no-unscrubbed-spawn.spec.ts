import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { findRepoRoot } from '@aitp/shared';
import { RUNNER_ONLY_VARS, productionEnv } from '../support/spawn-clean';

/**
 * No test spawns a process in the RUNNER's environment.
 *
 * **Remembering has already failed once here** (2026-10-09): the boot test
 * written specifically to catch a missing module inherited Playwright's
 * `NODE_PATH`, resolved the missing module from pnpm's hoist store, and passed
 * while `pnpm api:dev` could not start. A convention would have been forgotten
 * the same way, so this is a test.
 *
 * The rule it enforces: a test that launches a child must do it through
 * `tests/support/spawn-clean.ts`, which is the ONLY place the scrub list lives.
 * Per-call-site scrubbing drifts, and a drifted scrub is indistinguishable from
 * a correct one by reading.
 *
 * **What is deliberately NOT flagged:** a spawn of `git`. Git does not consult
 * `NODE_PATH` or `NODE_OPTIONS`, so its verdict cannot differ between the two
 * environments — the audit in `docs/phase-2-generation.md` §P answers question 2
 * ("would this still be checkable in production?") with "yes" for every git call
 * site. Flagging them would be noise, and a guard that cries wolf gets an
 * allow-list that eventually swallows a real case.
 */

const ROOT = findRepoRoot();

/** Spawn APIs that accept an `env` and therefore can inherit the runner's. */
const SPAWN_CALL = /\b(spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(/;

/** The helper's own exports, which ARE the sanctioned way. */
const SANCTIONED = /\b(spawnClean|execFileSyncClean|productionEnv)\s*\(/;

/**
 * Commands that cannot be affected by the runner-only variables.
 *
 * Narrow on purpose: `git` and nothing else. `node`, `npx`, `pnpm` and anything
 * that loads JavaScript all consult these variables.
 */
// The command and its arguments often share one string — `execSync('git ls-files
// …')` — so what follows `git` may be a space rather than the closing quote. The
// first version required the quote and therefore matched none of the git calls,
// which the guard duly reported as six violations.
const ENV_INSENSITIVE = /\(\s*['"]git(\s|['"])/;

interface Finding {
  file: string;
  line: number;
  text: string;
}

function scan(): { findings: Finding[]; filesScanned: number } {
  const files = [
    'tests/api/api-boot.spec.ts',
    'tests/unit/invisible-characters.spec.ts',
    'tests/unit/no-workbooks.spec.ts',
    'tests/unit/no-unscrubbed-spawn.spec.ts',
    'tests/support/spawn-clean.ts',
  ];

  const findings: Finding[] = [];
  let filesScanned = 0;

  for (const relative of files) {
    const full = path.join(ROOT, relative);
    let source: string;
    try {
      source = readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    filesScanned += 1;
    // The helper itself is where the raw calls belong.
    if (relative === 'tests/support/spawn-clean.ts') continue;

    for (const [index, line] of source.split(/\r?\n/).entries()) {
      const code = line.replace(/\/\/.*$/, '');
      if (!SPAWN_CALL.test(code)) continue;
      if (SANCTIONED.test(code)) continue;
      if (ENV_INSENSITIVE.test(code)) continue;
      // An import statement is not a call site.
      if (/^\s*import\b/.test(code)) continue;
      findings.push({ file: relative, line: index + 1, text: line.trim() });
    }
  }

  return { findings, filesScanned };
}

test.describe('no test spawns in the runner environment @unit', () => {
  test('every spawn of a JS process goes through the scrubbing helper', () => {
    // wrong: without this, the next spawn written anywhere in tests/ inherits
    // NODE_PATH and resolves dependencies the real process cannot — exactly the
    // false pass the API boot test produced on the day it was written.
    const { findings, filesScanned } = scan();

    // Discriminating: a scan that read no files would report clean while
    // checking nothing — the same failure as a scan that reads zero files.
    expect(filesScanned).toBeGreaterThan(3);

    expect(
      findings,
      'these spawn a JavaScript process with the runner\'s environment. Use\n' +
        '`spawnClean` / `execFileSyncClean` from tests/support/spawn-clean.ts:\n' +
        findings.map((f) => `  ${f.file}:${f.line}  ${f.text}`).join('\n'),
    ).toEqual([]);
  });

  test('the scrub DELETES the variables rather than blanking them', () => {
    // wrong: `env.NODE_PATH = ''` leaves a value the real process does not have,
    // and an empty NODE_PATH is a third environment — different from both the
    // runner's and production's. `in` is the only check that tells the two apart;
    // reading the value cannot, because '' and absent both read as falsy.
    const env = productionEnv();
    for (const name of RUNNER_ONLY_VARS) {
      expect(name in env, `${name} is still present in the scrubbed environment`).toBe(false);
    }
  });

  test('a caller-supplied value still wins, deliberately', () => {
    // wrong: a scrub that also discarded the caller's own variables would make
    // it impossible to test behaviour that depends on one — the scrub is about
    // removing what the RUNNER added, not about emptying the environment.
    const env = productionEnv({ API_PORT: '9999' });
    expect(env.API_PORT).toBe('9999');
    // And the ambient environment still comes through.
    expect(Object.keys(env).length).toBeGreaterThan(3);
  });
});

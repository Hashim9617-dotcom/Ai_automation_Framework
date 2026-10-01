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
const SANCTIONED = /\b(spawnClean|spawnSyncClean|execFileSyncClean|productionEnv)\s*\(/;

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
  // NOTE (2026-09-11): this hard-coded list is the same incomplete-enumeration
  // shape the invisible-character guard was just fixed for — a file that spawns
  // is governed only if someone remembered to add it here. Left as it is for now
  // to keep the shell-injection fix reviewable, and recorded as the next thing
  // to close: it should enumerate `tests/**` from git rather than from memory.
  const files = [
    'tests/api/api-boot.spec.ts',
    'tests/unit/invisible-characters.spec.ts',
    'tests/unit/no-workbooks.spec.ts',
    'tests/unit/no-unscrubbed-spawn.spec.ts',
    'tests/unit/no-shell-spawn.spec.ts',
    // Both spawn Playwright or a repo script to measure what it does. Added by hand,
    // which is the defect the NOTE above records: a spawner nobody adds here is
    // ungoverned, and that changes a VERDICT rather than degrading a message (§AE).
    'tests/unit/app-suite-scope.spec.ts',
    'tests/unit/inspect-session-dir.spec.ts',
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
    findings.push(...violationsIn(relative, source));
  }

  return { findings, filesScanned };
}

/**
 * The per-source check, separated so a PLANTED violation can be handed to it.
 *
 * §W: the scan over the real files can only report what the real files contain, so a
 * gate that skipped everything would read as a clean repo. The two synthetic inputs
 * below are the half that fixes that — one it must catch, one it must stay silent
 * about.
 */
function violationsIn(relative: string, source: string): Finding[] {
  const findings: Finding[] = [];

  // A FILE THAT CANNOT REACH `child_process` CANNOT SPAWN.
  //
  // Measured 2026-10-01, by adding two real spawners to the list above:
  // `app-suite-scope.spec.ts` was reported as a violation for
  // `/(\d+) files/.exec(listed)` — `RegExp.prototype.exec`, which the pattern
  // cannot tell from `child_process.exec`, because both are a word followed by a
  // parenthesis.
  //
  // The gate is the structural version of the question the line pattern is asking
  // (the same move as the invisible-character detector's Unicode categories
  // replacing a list of bad characters): a spawn needs the module, so a file that
  // never mentions it has nothing to find. Deliberately a substring of the whole
  // source rather than an import-statement match, so `require('child_process')` in
  // any form still brings the file into scope.
  if (!source.includes('child_process')) return findings;

  for (const [index, line] of source.split(/\r?\n/).entries()) {
    const code = line.replace(/\/\/.*$/, '');
    if (!SPAWN_CALL.test(code)) continue;
    if (SANCTIONED.test(code)) continue;
    if (ENV_INSENSITIVE.test(code)) continue;
    // An import statement is not a call site.
    if (/^\s*import\b/.test(code)) continue;
    findings.push({ file: relative, line: index + 1, text: line.trim() });
  }

  return findings;
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
      "these spawn a JavaScript process with the runner's environment. Use\n" +
        '`spawnClean` / `execFileSyncClean` from tests/support/spawn-clean.ts:\n' +
        findings.map((f) => `  ${f.file}:${f.line}  ${f.text}`).join('\n'),
    ).toEqual([]);
  });

  test('§W: a planted unscrubbed spawn IS caught, and a regex `.exec` is not', () => {
    // wrong: the `child_process` gate added on 2026-10-01 is what keeps a
    // `RegExp.prototype.exec` out of the findings, and a gate that skipped
    // EVERYTHING would satisfy the scan above just as well — a clean repo and a
    // blindfolded detector produce the same output. These two inputs separate them.
    // ASSEMBLED, not written out: this file is itself in the scanned list, so a
    // planted call site spelled literally here is a real finding in a real file and
    // the scan above duly reported both of these as violations. The names are joined
    // at runtime, which is enough — the scan reads SOURCE lines.
    const SPAWN = 'spawn' + 'Sync';
    const EXEC = 'ex' + 'ec';

    const caught = violationsIn(
      'planted.ts',
      [
        `import { ${SPAWN} } from 'node:child_process';`,
        `${SPAWN}('node', ['-e', '1'], { env: { ...process.env } });`,
      ].join('\n'),
    );
    expect(caught.map((f) => f.line)).toEqual([2]);

    // The silent half, and the one the assertion is written against: a file with no
    // access to `child_process` whose only `exec(` is a regular expression's. This is
    // `app-suite-scope.spec.ts:186` verbatim, the line that produced the false
    // positive.
    const silent = violationsIn(
      'planted-regex.ts',
      [
        'const listed = runIt();',
        `const files = Number(/(\\d+) files/.${EXEC}(listed)?.[1] ?? 0);`,
      ].join('\n'),
    );
    expect(silent).toEqual([]);
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

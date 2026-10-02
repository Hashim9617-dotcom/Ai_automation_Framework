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

/** The `child_process` exports that accept an `env` and so can inherit the runner's. */
const SPAWN_EXPORTS = [
  'spawn',
  'spawnSync',
  'exec',
  'execSync',
  'execFile',
  'execFileSync',
  'fork',
];

/**
 * THE NAMES A FILE CAN SPAWN WITH ARE THE NAMES IT IMPORTED.
 *
 * This used to be one fixed pattern — `\b(spawn|exec|…)\s*\(` — and it flagged
 * `/Total: (\d+) tests/.exec(output)` twice in one day: `RegExp.prototype.exec` is a
 * word followed by a parenthesis, exactly like `child_process.exec`. The first time,
 * a gate on the file mentioning `child_process` at all was enough. The second time it
 * was not: `command-box.spec.ts` imports `type ChildProcess`, so the file is in scope
 * and its only `exec(` is a regular expression's.
 *
 * A list of suspicious words cannot tell those apart — the same bound as the
 * invisible-character detector built from a list of bad characters. The structural
 * question is what the file BOUND: a call can only reach `child_process` through a
 * name imported from it, so the pattern is derived per file from its own imports,
 * and a type-only import binds no value and is dropped.
 */
function spawnNamesIn(source: string): string[] {
  const names = new Set<string>();

  // `import { spawnSync, type ChildProcess } from 'node:child_process'`
  for (const match of source.matchAll(
    /import\s*(?:type\s+)?\{([^}]*)\}\s*from\s*['"](?:node:)?child_process['"]/g,
  )) {
    const typeOnlyImport = /^import\s+type/.test(match[0]);
    for (const clause of (match[1] ?? '').split(',')) {
      const text = clause.trim();
      if (!text || typeOnlyImport || /^type\s/.test(text)) continue;
      // `a as b` binds b; the call site uses the local name.
      const local = (/\sas\s+(\w+)$/.exec(text)?.[1] ?? text).trim();
      if (SPAWN_EXPORTS.includes(local) || SPAWN_EXPORTS.includes(text)) names.add(local);
    }
  }

  // `import cp from 'node:child_process'`, `import * as cp`, `require('child_process')`
  for (const match of source.matchAll(
    /(?:import\s+(?:\*\s+as\s+)?(\w+)\s+from\s*['"](?:node:)?child_process['"]|(?:const|let|var)\s+(\w+)\s*=\s*require\(\s*['"](?:node:)?child_process['"]\s*\))/g,
  )) {
    const namespace = match[1] ?? match[2];
    if (namespace) for (const name of SPAWN_EXPORTS) names.add(`${namespace}.${name}`);
  }

  return [...names];
}

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

/**
 * How much of a SUBJECT the scan had, so "clean" can be told from "blindfolded".
 *
 * `boundSpawnNames` counts files that actually imported something spawnable, and
 * `callsExamined` the lines that called one. Measured 2026-10-02 after the pattern
 * became per-file: exactly ONE real file binds a name (`no-workbooks.spec.ts`'s
 * `execSync`), and every one of its call sites is git, which is exempt. So the scan
 * over the real repo would report clean with the derivation returning nothing at all
 * — rule §T, pointed at the detector that had just been made more precise.
 */
interface ScanResult {
  findings: Finding[];
  filesScanned: number;
  boundSpawnNames: number;
  callsExamined: number;
}

function scan(): ScanResult {
  // NOTE (2026-09-11): this hard-coded list is the same incomplete-enumeration
  // shape the invisible-character guard was just fixed for — a file that spawns
  // is governed only if someone remembered to add it here. Left as it is for now
  // to keep the shell-injection fix reviewable, and recorded as the next thing
  // to close: it should enumerate `tests/**` from git rather than from memory.
  const files = [
    'tests/api/api-boot.spec.ts',
    // Starts the API and, in CB4b, takes its own `--list` to compare a corpus against.
    'tests/api/command-box.spec.ts',
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
  let boundSpawnNames = 0;
  let callsExamined = 0;

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
    const result = violationsIn(relative, source);
    findings.push(...result.findings);
    if (result.names > 0) boundSpawnNames += 1;
    callsExamined += result.calls;
  }

  return { findings, filesScanned, boundSpawnNames, callsExamined };
}

/**
 * The per-source check, separated so a PLANTED violation can be handed to it.
 *
 * §W: the scan over the real files can only report what the real files contain, so a
 * gate that skipped everything would read as a clean repo. The two synthetic inputs
 * below are the half that fixes that — one it must catch, one it must stay silent
 * about.
 */
function violationsIn(
  relative: string,
  source: string,
): { findings: Finding[]; names: number; calls: number } {
  const findings: Finding[] = [];

  // A file that bound no spawning name cannot spawn, so there is nothing in it to
  // find — including a `type ChildProcess` import, which binds no value.
  const names = spawnNamesIn(source);
  if (names.length === 0) return { findings, names: 0, calls: 0 };
  const spawnCall = new RegExp(
    `(?<![.\\w])(${names.map((name) => name.replace('.', '\\.')).join('|')})\\s*\\(`,
  );

  let calls = 0;
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    const code = line.replace(/\/\/.*$/, '');
    if (!spawnCall.test(code)) continue;
    // An import statement is not a call site.
    if (/^\s*import\b/.test(code)) continue;
    calls += 1;
    if (SANCTIONED.test(code)) continue;
    if (ENV_INSENSITIVE.test(code)) continue;
    findings.push({ file: relative, line: index + 1, text: line.trim() });
  }

  return { findings, names: names.length, calls };
}

test.describe('no test spawns in the runner environment @unit', () => {
  test('every spawn of a JS process goes through the scrubbing helper', () => {
    // wrong: without this, the next spawn written anywhere in tests/ inherits
    // NODE_PATH and resolves dependencies the real process cannot — exactly the
    // false pass the API boot test produced on the day it was written.
    const { findings, filesScanned, boundSpawnNames, callsExamined } = scan();

    // Discriminating: a scan that read no files would report clean while
    // checking nothing — the same failure as a scan that reads zero files.
    expect(filesScanned).toBeGreaterThan(3);

    // AND IT HAD A SUBJECT (§T). Since the pattern became per-file, "clean" is also
    // what a derivation returning nothing produces. Measured: exactly one real file
    // binds a spawning name and its call sites are all git, so these two numbers are
    // 1 and 2 — small, which is the point of asserting them rather than assuming them.
    expect(
      boundSpawnNames,
      'no scanned file bound a spawning name — nothing was checked',
    ).toBeGreaterThan(0);
    expect(callsExamined, 'no call site was examined — nothing was checked').toBeGreaterThan(0);

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
    expect(caught.findings.map((f) => f.line)).toEqual([2]);

    // THE SILENT HALF, and the one the assertion is written against. Two inputs,
    // because the false positive came back a second time in a form the first fix did
    // not cover:
    //
    //   - a file that never mentions `child_process` (app-suite-scope.spec.ts:186);
    //   - a file that imports `type ChildProcess` — in scope, binding no value —
    //     whose only `exec(` is a regular expression's (command-box.spec.ts:179).
    //
    // Both lines are the real ones, and the second is why the pattern is derived from
    // a file's imports rather than from a list of words.
    const silent = violationsIn(
      'planted-regex.ts',
      [
        'const listed = runIt();',
        `const files = Number(/(\\d+) files/.${EXEC}(listed)?.[1] ?? 0);`,
      ].join('\n'),
    );
    expect(silent.findings).toEqual([]);

    const silentWithTypeImport = violationsIn(
      'planted-type-import.ts',
      [
        "import { type ChildProcess } from 'node:child_process';",
        'let api: ChildProcess | undefined;',
        `const total = Number(/Total: (\\d+) tests/.${EXEC}(out)?.[1] ?? 0);`,
      ].join('\n'),
    );
    expect(silentWithTypeImport.findings).toEqual([]);
    // And the silence is for the RIGHT reason in each case (§X): the first file bound
    // no name at all, the second bound none because the import was type-only. A
    // pattern that simply stopped matching would also produce two empty lists.
    expect(silent.names).toBe(0);
    expect(silentWithTypeImport.names).toBe(0);
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

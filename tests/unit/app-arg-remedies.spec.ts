import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { findRepoRoot } from '@aitp/shared';
import { execFileSyncClean } from '../support/spawn-clean';
import { stripComments } from '../support/strip-comments';

/**
 * A REMEDY NAMING ONE OF THE FOUR COMMANDS MUST NAME `--app` TOO.
 *
 * ## Why this is a guard and not a one-off fix
 *
 * `--app` became mandatory on `auth`, `inspect`, `heal` and `rca` in this batch, and
 * that silently invalidated every message in the codebase telling a human to run one
 * of them. There were nine. A reader following `Run \`pnpm inspect\` against it
 * first.` now gets a second error instead of a capture.
 *
 * > Whatever you tell a human to write, write it and run it first (§AG).
 *
 * A message is an interface nobody declared (§AI), so fixing the nine and moving on
 * would leave the tenth to be written next week by somebody who has not read this.
 * The scan is the structural version of the question, the same shape as
 * `no-unscrubbed-spawn.spec.ts`.
 *
 * ## Scope, stated rather than implied
 *
 * **Runtime strings in `packages/` and `scripts/`** — the text a running process
 * prints — **plus the four documents a reader TYPES FROM.** Comments are stripped,
 * because a comment explaining the history of a command is not an instruction.
 *
 * The rest of `docs/` is deliberately out of scope, and the distinction is not
 * convenience: `docs/dms-findings.md`, `docs/phase-2-*.md` and `docs/WHERE-WE-ARE.md`
 * are dated records of what somebody ran on a particular day, and rewriting them to
 * match today's interface would be falsifying a record. The four below are
 * instructions for right now, so they are held to the same standard as a refusal
 * message. That list is hand-written and must be — it is a judgement about which
 * documents are instructions — but a missing entry can only cost a WARNING here, not
 * a verdict, which is the condition §AE puts on a hand-written list.
 */

const ROOT = findRepoRoot();

/** The commands that now refuse without `--app`. One list, used by the scan. */
const REQUIRE_APP = ['auth', 'inspect', 'heal', 'rca'] as const;

/**
 * `pnpm <command>` not followed by `--app`, anywhere in a string.
 *
 * `heal` is matched with a word boundary so `pnpm heal:review` — which takes
 * `--run`, not `--app` — is not flagged. That exemption is reasoned rather than
 * convenient: `heal:review` reads a `run.json` and resolves no environment at all,
 * so it has no application to disagree about.
 */
const BARE_COMMAND = new RegExp(
  String.raw`pnpm (?:${REQUIRE_APP.join('|')})\b(?!:)(?!\s*(?:--app|[^\s\`']*--app))`,
  'g',
);

/**
 * The documents a reader types FROM, as opposed to the ones that record history.
 *
 * `git` is exempt from the scrubbing helper by design — it consults neither
 * `NODE_PATH` nor `NODE_OPTIONS`, so its answer cannot differ between the two
 * environments — which is why `execFileSyncClean` is used here without ceremony.
 */
const INSTRUCTION_DOCS = [
  'README.md',
  'docs/QA-QUICKSTART.md',
  'docs/ADD-AN-APPLICATION.md',
  'tests/apps/dms/README.md',
] as const;

function sourceFiles(): string[] {
  const tracked = execFileSyncClean('git', ['ls-files', 'packages', 'scripts'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.ts') || line.endsWith('.mjs'));
  return [...tracked, ...INSTRUCTION_DOCS];
}

test.describe('every printed remedy names --app @unit', () => {
  test('R1: no runtime string in packages/ or scripts/ tells a reader to run a bare command', () => {
    // wrong: before this batch nine strings did, and each one sent a reader to a
    // second error — `run \`pnpm inspect\` on that screen` for a command that now
    // refuses. With the guard removed, re-introducing any of them is invisible.
    const files = sourceFiles();
    // §T: a scan that read nothing reports clean. The repo has ~100 such files; a
    // number this low would mean the listing, not the tree, is what changed.
    expect(files.length, 'the scan must have had a subject').toBeGreaterThan(50);

    const offenders: string[] = [];
    for (const file of files) {
      const body = stripComments(readFileSync(path.join(ROOT, file), 'utf8'));
      for (const [index, line] of body.split('\n').entries()) {
        for (const match of line.matchAll(BARE_COMMAND)) {
          offenders.push(`${file}:${index + 1}  ${match[0].trim()}`);
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  test('R2: the scan CATCHES a bare command and stays SILENT on a complete one', () => {
    // wrong: R1 over a clean tree cannot tell a working detector from one whose
    // regex matches nothing — "no offenders" and "no offenders my pattern can see"
    // are the same output (§AA, §W). Both halves are planted here, and the silent
    // one is what the assertion in R1 is actually written against.
    const caught = [
      "throw new Error('Run `pnpm inspect` against it first.')",
      "const why = 'run `pnpm auth` again'",
      "log.error('set ANTHROPIC_API_KEY and run `pnpm rca` again')",
      "'nothing to propose — run `pnpm heal`'",
    ];
    for (const planted of caught) {
      expect([...stripComments(planted).matchAll(BARE_COMMAND)], planted).not.toEqual([]);
    }

    const silent = [
      "throw new Error('Run `pnpm inspect --app dms` against it first.')",
      "const why = 'run `pnpm inspect --app <application>` on that screen'",
      '`Run \\`pnpm auth --app ${application}\\` first`',
      // heal:review takes --run, never --app, and must not be flagged.
      "'run `pnpm heal:review` to review and approve'",
      // A command that was never in the list.
      "'run `pnpm triage <workbook.xlsx> --app dms`'",
      // A comment, even one quoting the old form verbatim.
      '// this used to say: run `pnpm inspect` and it refused',
      '/* Run `pnpm auth` first — the historical note */',
    ];
    for (const planted of silent) {
      expect([...stripComments(planted).matchAll(BARE_COMMAND)], planted).toEqual([]);
    }
  });

  test('R3: the four commands in the scan are the four that actually require --app', () => {
    // wrong: a hand-written list beside a derived one drifts, and here a missing
    // entry would silently stop guarding a command (§AE). The scripts' own USAGE
    // lines are the source of truth — each must name --app as required, and each
    // must be covered by the list this scan uses.
    const scripts = {
      auth: 'auth-setup.ts',
      inspect: 'inspect-app.ts',
      heal: 'heal.ts',
      rca: 'analyze-failures.ts',
    } as const;
    expect(Object.keys(scripts).sort()).toEqual([...REQUIRE_APP].sort());
    for (const [command, file] of Object.entries(scripts)) {
      const source = readFileSync(path.join(ROOT, 'scripts', file), 'utf8');
      expect(source, file).toContain(`usage: pnpm ${command} --app <application>`);
      expect(source, file).toContain('resolveEnvironmentForApp');
    }
  });
});

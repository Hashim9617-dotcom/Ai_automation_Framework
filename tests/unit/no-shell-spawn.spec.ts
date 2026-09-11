import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { findRepoRoot } from '@aitp/shared';
import { execFileSyncClean } from '../support/spawn-clean';

/**
 * The runner spawns Playwright WITHOUT a shell, and a `grep` full of shell
 * metacharacters is just a string.
 *
 * ── The vulnerability this replaces ──────────────────────────────────────────
 * `RunnerService.execute()` spawned with `shell: process.platform === 'win32'`.
 * Under `shell: true` Node concatenates the arguments into a single command
 * string **without escaping them** — its own `DEP0190` deprecation warning says
 * exactly that — and `buildArgs()` emits `--grep=${request.grep}` from a field
 * on `runRequestSchema` that any HTTP caller controls. So
 * `POST /api/runs {"grep": "@smoke & whoami"}` ran `whoami`. Reachable over HTTP,
 * unauthenticated, on the machine hosting the API.
 *
 * ── Why there is no validation here ──────────────────────────────────────────
 * The first attempt was a boundary check: reject shell metacharacters on `grep`.
 * It cannot work, and the reason generalises.
 *
 * `|` is a shell metacharacter AND it is regex alternation — and `CommandService`
 * builds every multi-test grep by joining test titles with `|`. Rejecting `|`
 * breaks the product's own generated greps. Allowing it leaves the injection
 * open. The legitimate character set and the dangerous character set genuinely
 * INTERSECT, so there is no set of characters to admit.
 *
 * > **When validation would have to separate two sets that actually overlap, the
 * > answer is to remove the interpreter, not to write a cleverer filter.** A
 * > filter over intersecting sets can only trade false rejections against real
 * > holes; no setting of it gives neither. Escaping fails for the same reason
 * > from the other side — an escape must be correct for every shell it might
 * > meet, and that is a bet renewed on every platform.
 *
 * So the shell is gone. It was only ever there because `npx` is a `.cmd` shim
 * that `spawn` cannot execute directly on Windows; resolving Playwright's own CLI
 * entry point and running it under THIS node removes the shim and the shell
 * together. No shell means no concatenation, which means arguments are passed
 * literally — and that holds for every future argument, not just `grep`.
 *
 * ── Why this test reads the source ───────────────────────────────────────────
 * The behavioural half below spawns a child with the shell setting it PARSES OUT
 * OF `runner.service.ts`, rather than one hard-coded here. That coupling is the
 * point: a test that hard-codes `shell: false` proves only that Node behaves as
 * documented, and would stay green while someone put `shell: true` back into the
 * runner. Restoring it makes this test fail for the real reason — the payload
 * executes.
 */

const ROOT = findRepoRoot();
const RUNNER = 'apps/api/src/modules/runs/runner.service.ts';

/**
 * Text of the first `spawn` call in the runner, comments removed.
 *
 * The marker below is built by concatenation rather than written as a literal.
 * `tests/unit/no-unscrubbed-spawn.spec.ts` scans line by line and cannot tell
 * code from strings or comments, so the literal spelling reads to it as a real
 * call site. Relaxing its detector is the worse trade — stripping string
 * contents would also break the `git` exemption it depends on — so the
 * accommodation lives here, named.
 */
function spawnCallText(): string {
  const source = readFileSync(path.join(ROOT, RUNNER), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

  const marker = 'spawn' + '(';
  const start = source.indexOf(marker);
  expect(start, `no spawn call found in ${RUNNER}`).toBeGreaterThan(-1);

  let depth = 0;
  let index = start + marker.length - 1;
  for (; index < source.length; index += 1) {
    const char = source[index];
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return source.slice(start + marker.length, index);
}

/** The first argument to that call — the command actually executed. */
function firstArgument(call: string): string {
  let depth = 0;
  for (let index = 0; index < call.length; index += 1) {
    const char = call[index] ?? '';
    if (char && '([{'.includes(char)) depth += 1;
    else if (char && ')]}'.includes(char)) depth -= 1;
    else if (char === ',' && depth === 0) return call.slice(0, index).trim();
  }
  return call.trim();
}

/** Whether the runner hands `spawn` a shell. Parsed, never assumed. */
function runnerUsesShell(): boolean {
  return /\bshell\s*:/.test(spawnCallText());
}

const ARGV_ECHO = path.join(ROOT, 'tests', 'support', 'argv-echo.cjs');
const SENTINEL = path.join(ROOT, 'artifacts', 'shell-injection-sentinel.txt');

/**
 * A grep that is a valid Playwright grep AND a command if anything interprets it.
 *
 * The redirect is the detector: if a shell sees this, the sentinel file appears.
 * If nothing does, the whole thing is one argv element and the disk is untouched.
 */
function payload(): string {
  return `@smoke & echo pwned > ${SENTINEL}`;
}

function clearSentinel(): void {
  mkdirSync(path.dirname(SENTINEL), { recursive: true });
  rmSync(SENTINEL, { force: true });
}

test.describe('the runner spawns without a shell @unit', () => {
  test.describe.configure({ mode: 'serial' });

  test('a grep full of shell metacharacters arrives as one literal argument and executes nothing', () => {
    // wrong: with `shell: true` restored in the runner, the `&` below is
    // interpreted, `echo pwned > …` runs, and both assertions fail — the argv is
    // split at the metacharacter and the sentinel appears on disk.
    const usesShell = runnerUsesShell();
    const grep = payload();
    clearSentinel();

    let raw: string;
    try {
      raw = execFileSyncClean(process.execPath, [ARGV_ECHO, `--grep=${grep}`], {
        cwd: ROOT,
        // Deliberately the runner's OWN setting, read from its source.
        ...(usesShell ? { shell: true } : {}),
      });
    } finally {
      // Whatever happened, do not leave an executed payload behind.
      const executed = existsSync(SENTINEL);
      rmSync(SENTINEL, { force: true });
      expect(executed, 'the grep payload EXECUTED — the runner is spawning through a shell').toBe(
        false,
      );
    }

    // The child saw exactly one argument, with the metacharacters intact.
    expect(JSON.parse(raw)).toEqual([`--grep=${grep}`]);
  });

  test('the sentinel really does detect execution — the control, run through a shell', () => {
    // Asserts its own effect (CLAUDE.md). "No file appeared" is worthless unless
    // a file WOULD have appeared, so the same payload is run through a shell and
    // must produce the sentinel. Without this, the test above passes even if the
    // redirect were malformed and could never have written anything.
    clearSentinel();
    try {
      execFileSyncClean('node', [ARGV_ECHO, `--grep=${payload()}`], { cwd: ROOT, shell: true });
    } catch {
      // The shell may report a non-zero status; the sentinel is the observation.
    }

    const executed = existsSync(SENTINEL);
    rmSync(SENTINEL, { force: true });
    expect(executed, 'the control did not execute — the detector proves nothing').toBe(true);
  });

  test('the runner runs Playwright under this node, with no shell option at all', () => {
    // wrong: `shell: false` would also be safe, but its presence invites someone
    // to flip the value. The option is absent, and this says so, so restoring it
    // in any form is a visible change rather than a one-character edit.
    const call = spawnCallText();

    expect(
      firstArgument(call),
      'the runner must execute this node directly, not a `.cmd` shim through a shell',
    ).toBe('process.execPath');

    expect(runnerUsesShell(), `${RUNNER} passes a shell option to spawn`).toBe(false);
    expect(call).toContain('playwrightCli');
  });
});

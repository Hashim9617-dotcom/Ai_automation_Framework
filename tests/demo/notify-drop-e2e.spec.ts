import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect } from '@aitp/execution-engine';
import { findRepoRoot } from '@aitp/shared';
import { NOTIFY_CONFIG_RELATIVE, READY_SUFFIX, type ReadyDrop } from '@aitp/reporting-engine';
import { spawnSyncClean } from '../support/spawn-clean';

/**
 * A REAL PLAYWRIGHT RUN PRODUCES A REAL DROP — and a fixture run produces none.
 *
 * ## What the unit suite cannot establish
 *
 * `tests/unit/notify-drop.spec.ts` proves what `notifyRun` does when it is CALLED.
 * It cannot prove the reporter calls it, that it is called late enough that
 * `run.json` and the archive are complete, or that a failure in it leaves the
 * suite's exit code alone. Those are facts about a process (§R).
 *
 * ## Four things this spec got wrong before it worked, each read from the child
 *
 * Every one was diagnosed by printing the child's own exit code and output rather
 * than by reasoning about the code:
 *
 * 1. `node_modules/playwright/cli.js` — pnpm does not hoist `playwright`, so that
 *    path is `MODULE_NOT_FOUND`, which arrives as the child exiting 1 in 300 ms and
 *    reads exactly like "the suite failed". It is `@playwright/test/cli.js`, the
 *    path `surface-partition.spec.ts` already names.
 * 2. `--project=chromium` — the live projects match `tests/apps/<application>/**`,
 *    and the bundled demo app has no such directory, so: "No tests found".
 * 3. `path.join('tests','demo','login.spec.ts')` — Playwright treats a positional
 *    argument as a REGULAR EXPRESSION, so the Windows separators made `\d` a digit
 *    class and it matched nothing. Forward slashes, always.
 * 4. `--reporter=line` — the one that cost the most time, because the child exited
 *    0 and the folder was simply empty. `--reporter` REPLACES the configured
 *    reporters, so `AitpReporter` — the thing that writes the drop — never ran.
 *
 * ## Nothing here needs OneDrive, a network or Windows
 *
 * The "synced project folder" is an ordinary temp directory, which is all it ever is
 * from this side: OneDrive's job starts after the file exists.
 */

const ROOT = findRepoRoot();
const PLAYWRIGHT = path.join(ROOT, 'node_modules', '@playwright', 'test', 'cli.js');
const CONFIG_FILE = path.join(ROOT, NOTIFY_CONFIG_RELATIVE);

/**
 * The child runs the FIXTURE `demo` project, because that is the only surface the
 * bundled app has.
 *
 * Measured: the fixture projects exist only while `AITP_FIXTURE_ONLY=1` is set —
 * without it, `--project=demo` answers `Available projects: live-setup, chromium,
 * firefox, webkit, mobile-chrome, api`.
 *
 * GREPPED TO ONE SPEC, and that is load-bearing: the `demo` project collects
 * `tests/demo/**`, which includes THIS FILE. Without the filter the child would run
 * this spec, spawn its own child, and recurse until something ran out.
 */
const CHILD_ARGS = [
  'test',
  '--project=demo',
  // Forward slashes: a positional argument is a regex (see 3 above).
  'tests/demo/login.spec.ts',
  '--grep',
  'valid credentials sign the user in',
];

/** Where the drop MUST NOT go: the folder the configuration names. */
function configuredFolder(): string {
  const folder = mkdtempSync(path.join(tmpdir(), 'aitp-configured-'));
  return folder;
}

/**
 * Configures `bundled-demo` in THIS repo's `.aitp-local/notify.json`.
 *
 * It has to be the real repo root: the child is a real `playwright test` and resolves
 * its own root. The previous contents are returned so the caller restores them — and
 * a leftover here cannot break a later run, because it names a temp folder that no
 * longer exists and `notifyRun` then reports `folder-missing` and carries on. That is
 * why this is acceptable where a leftover source mutation would not be.
 */
function configureNotify(folder: string): string | null {
  const previous = existsSync(CONFIG_FILE) ? readFileSync(CONFIG_FILE, 'utf8') : null;
  mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  writeFileSync(
    CONFIG_FILE,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        apps: {
          'bundled-demo': {
            folder,
            to: ['qa@contoso.com'],
            cc: [],
            ranBy: 'me@contoso.com',
            ranBySource: 'explicit',
            allowedDomain: 'contoso.com',
          },
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  return previous;
}

function restoreNotify(previous: string | null): void {
  if (previous === null) rmSync(CONFIG_FILE, { force: true });
  else writeFileSync(CONFIG_FILE, previous, 'utf8');
}

/**
 * Runs the child. `testFolder` undefined means NO override — the fixture-surface
 * suppression then applies, which is what E2 is about.
 *
 * `--output` is its own temp directory on purpose: without it the child wipes the
 * PARENT run's `artifacts/test-results` as Playwright clears its output dir at
 * start, which this session has already been bitten by once.
 */
function runChild(testFolder: string | undefined) {
  const outputDir = mkdtempSync(path.join(tmpdir(), 'aitp-child-out-'));
  return spawnSyncClean(process.execPath, [PLAYWRIGHT, ...CHILD_ARGS, '--output', outputDir], {
    cwd: ROOT,
    maxBuffer: 40 * 1024 * 1024,
    env: {
      TEST_ENV: 'local',
      LOG_LEVEL: 'info',
      // Set explicitly: `spawnSyncClean` scrubs it from the inherited environment,
      // and the fixture project does not exist without it.
      AITP_FIXTURE_ONLY: '1',
      ...(testFolder ? { AITP_NOTIFY_TEST_FOLDER: testFolder } : {}),
    },
  });
}

const readyIn = (folder: string): string[] =>
  readdirSync(folder).filter((name) => name.endsWith(READY_SUFFIX));

test.describe('a real demo run drops a report email @demo', () => {
  test.setTimeout(240_000);

  /**
   * SERIAL, because both tests mutate ONE file in the repo root.
   *
   * `.aitp-local/notify.json` has to be the real one — the child is a real
   * `playwright test` and resolves its own root — so the two tests share it. Run in
   * parallel, E2's restore raced E1's child reading it, and E1 came back with an
   * empty drop folder while passing when run alone. Measured, not guessed: E1 alone
   * is green and E1 beside E2 was not.
   *
   * The same fix the Postgres contract needed for the same reason, and the same
   * lesson: a fixture that lives outside the test cannot be parallelised just
   * because the assertions are independent.
   */
  test.describe.configure({ mode: 'serial' });

  test('E1: a real run writes the zip and the ready file, and its exit code is untouched', () => {
    // wrong: no drop at all (the reporter never calls it — which is exactly what
    // `--reporter=line` caused, silently, with the child exiting 0), a drop with no
    // zip (called before the archive is complete), or the one that matters most, a
    // green suite reported as FAILED because a mail could not be prepared. The exit
    // code is asserted alongside the files for that reason.
    const configured = configuredFolder();
    const drop = mkdtempSync(path.join(tmpdir(), 'aitp-drop-e2e-'));
    const previous = configureNotify(configured);
    try {
      const result = runChild(drop);
      const output = `${result.stdout}${result.stderr}`;

      // §T — the run has to have HAPPENED, or every assertion below is about an
      // empty folder and passes for the wrong reason.
      expect(result.status, `the suite itself did not pass:\n${output}`).toBe(0);
      expect(output, 'the child ran no tests').toContain('1 passed');

      const ready = readyIn(drop);
      const zips = readdirSync(drop).filter((name) => name.endsWith('.zip'));
      expect(ready, `no ready file in ${drop}: ${readdirSync(drop).join(', ')}`).toHaveLength(1);
      expect(zips).toHaveLength(1);
      // ATOMIC: a surviving `.tmp` would mean the flow could read a partial file.
      expect(readdirSync(drop).some((name) => name.endsWith('.tmp'))).toBe(false);

      const parsed = JSON.parse(readFileSync(path.join(drop, ready[0]!), 'utf8')) as ReadyDrop;
      expect(parsed.app).toBe('bundled-demo');
      expect(parsed.environment).toBe('local');
      expect(parsed.ranBy).toBe('me@contoso.com');
      expect(parsed.to).toEqual(['qa@contoso.com']);
      expect(parsed.subject).toContain('[BUNDLED-DEMO] local run');
      expect(parsed.verdict).toBe('PASSED');
      expect(parsed.counts.total).toBeGreaterThan(0);
      expect(parsed.bodyHtml).toContain('<!doctype html>');
      // The ready file NAMES the zip beside it — the whole contract with the flow.
      expect(parsed.reportZipName).toBe(zips[0]);
      expect(output).toContain('notify: report queued');

      // AND THE CONFIGURED FOLDER IS UNTOUCHED. The override redirects rather than
      // merely permits, so a fixture run cannot reach a real project's folder.
      expect(readdirSync(configured)).toEqual([]);
    } finally {
      restoreNotify(previous);
    }
  });

  test('E2: the same run WITHOUT the override writes nothing, though a folder is configured', () => {
    // wrong: the platform's own suites dropping a report every time somebody runs
    // `pnpm verify` — about the platform's tests rather than about any application,
    // and into whatever folder the configuration names, which on a real machine is a
    // customer project's synced folder. The configuration is DELIBERATELY present and
    // valid: over an unconfigured machine this would pass for the wrong reason.
    //
    // This is also E1's discriminating half, and E1 is this one's: without E1, this
    // is satisfied by a platform that can never notify at all.
    const configured = configuredFolder();
    const previous = configureNotify(configured);
    try {
      const result = runChild(undefined);
      const output = `${result.stdout}${result.stderr}`;
      expect(result.status, output).toBe(0);
      expect(output, 'the child ran no tests').toContain('1 passed');
      // It SAYS so — a silent skip is how somebody comes to believe mail is going out.
      expect(output).toContain('fixture-only run');
      expect(readdirSync(configured)).toEqual([]);
    } finally {
      restoreNotify(previous);
    }
  });
});

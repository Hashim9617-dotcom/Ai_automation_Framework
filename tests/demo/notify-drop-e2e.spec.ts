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
import {
  NOTIFY_CONFIG_RELATIVE,
  NOTIFY_CONFIG_VAR,
  READY_SUFFIX,
  type ReadyDrop,
} from '@aitp/reporting-engine';
import { spawnSyncClean } from '../support/spawn-clean';
import {
  describeNotifyConfigChange,
  snapshotNotifyConfig,
  type NotifyConfigSnapshot,
} from '../support/notify-config-guard';

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
 * ## Six things this spec got wrong before it worked, each read from the child
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
 * 5. THE CHILD WIPED THE PARENT'S ARTIFACTS, which is what made this spec flaky
 *    rather than broken. `global-setup.ts` removes `artifacts/reports` and
 *    `artifacts/test-results` unless `CLEAN_ARTIFACTS=false`, and the child runs
 *    that hook too — against the directories the PARENT run is writing into. On
 *    Windows a tree with a handle open in it fails to delete, so the child died
 *    with `ENOTEMPTY, Directory not empty: artifacts\test-results` before running a
 *    single test, and E1 reported "the suite itself did not pass". Intermittent by
 *    construction: it depends on whether the parent happened to be holding a trace
 *    open at that instant, so the same commit passed and failed with nothing
 *    changed between the runs. Measured from the archived `error-context.md`, not
 *    guessed — the first diagnosis of this failure blamed the shared notify config
 *    and was wrong.
 * 6. It wrote the developer's own `.aitp-local/notify.json`. See below.
 *
 * ## It no longer touches the real notify config, and that is checked
 *
 * The child is a real `playwright test` and resolves its own repo root, so the
 * config it reads could not be redirected and this spec wrote the real file,
 * restoring the previous contents afterwards. Both halves of that were wrong:
 * restoring the PREVIOUS contents preserves a leftover (a dead `aitp-configured-*`
 * temp folder sat in this repo's config for days), and restoring a known-clean
 * `{apps:{}}` would be worse — it would delete the entries a QA had configured,
 * every time anybody ran `pnpm verify`. There is no correct way to restore somebody
 * else's file.
 *
 * `AITP_NOTIFY_CONFIG` is the fix, and `afterEach` is the proof: the real file's
 * digest and size are taken before the first test and compared after each one. The
 * hazard is one somebody re-introduces by writing four convenient lines, and because
 * the file is gitignored a re-introduction leaves `git status` clean and says nothing.
 *
 * ## Nothing here needs OneDrive, a network or Windows
 *
 * The "synced project folder" is an ordinary temp directory, which is all it ever is
 * from this side: OneDrive's job starts after the file exists.
 */

const ROOT = findRepoRoot();
const PLAYWRIGHT = path.join(ROOT, 'node_modules', '@playwright', 'test', 'cli.js');

/** The file this spec must leave exactly as it found it. */
const REAL_CONFIG = path.join(ROOT, NOTIFY_CONFIG_RELATIVE);

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

/** Everything this spec created, removed in one place however a test ended. */
class Temp {
  private readonly dirs: string[] = [];

  dir(prefix: string): string {
    const made = mkdtempSync(path.join(tmpdir(), prefix));
    this.dirs.push(made);
    return made;
  }

  /**
   * A notify config of THIS SPEC'S OWN, in its own directory.
   *
   * Not the repo's. `AITP_NOTIFY_CONFIG` is what lets a real spawned child read it,
   * and the recipients are a `contoso.com` fiction so a misdirected drop would name
   * nobody real.
   */
  config(folder: string): string {
    const file = path.join(this.dir('aitp-notify-cfg-'), 'notify.json');
    writeFileSync(
      file,
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
    return file;
  }

  cleanUp(): void {
    for (const dir of this.dirs) rmSync(dir, { recursive: true, force: true });
    this.dirs.length = 0;
  }
}

/**
 * Runs the child. `testFolder` undefined means NO override — the fixture-surface
 * suppression then applies, which is what E2 is about.
 *
 * `--output` is its own temp directory on purpose: without it the child wipes the
 * PARENT run's `artifacts/test-results` as Playwright clears its output dir at
 * start, which this session has already been bitten by once.
 */
function runChild(options: { testFolder?: string | undefined; configFile: string }) {
  const outputDir = mkdtempSync(path.join(tmpdir(), 'aitp-child-out-'));
  return {
    outputDir,
    result: spawnSyncClean(process.execPath, [PLAYWRIGHT, ...CHILD_ARGS, '--output', outputDir], {
      cwd: ROOT,
      maxBuffer: 40 * 1024 * 1024,
      env: {
        TEST_ENV: 'local',
        LOG_LEVEL: 'info',
        // Set explicitly: `spawnSyncClean` scrubs it from the inherited environment,
        // and the fixture project does not exist without it.
        AITP_FIXTURE_ONLY: '1',
        // THE CHILD MUST NOT RUN THIS REPO'S ARTIFACT HYGIENE. `global-setup.ts`
        // deletes `artifacts/reports` and `artifacts/test-results`, which are the
        // directories the PARENT run is writing into right now — see 5 above. The
        // sentinel in E1 is what proves this line is doing its job.
        CLEAN_ARTIFACTS: 'false',
        // Its own config, so the developer's is never read or written.
        [NOTIFY_CONFIG_VAR]: options.configFile,
        ...(options.testFolder ? { AITP_NOTIFY_TEST_FOLDER: options.testFolder } : {}),
      },
    }),
  };
}

const readyIn = (folder: string): string[] =>
  readdirSync(folder).filter((name) => name.endsWith(READY_SUFFIX));

/**
 * A file in the parent's output directory that the child must not be able to remove.
 *
 * The flake it stands for is a crash that depends on an open file handle, so it
 * cannot be reproduced on demand. This can: with `CLEAN_ARTIFACTS` unset the child's
 * `globalSetup` deletes this file (or dies trying), and either way it is gone.
 */
function plantSentinel(): string {
  const dir = path.join(ROOT, 'artifacts', 'test-results');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `notify-drop-e2e-${process.pid}-${Date.now()}.sentinel`);
  writeFileSync(file, 'the child must not delete the parent run’s artifacts\n', 'utf8');
  return file;
}

test.describe('a real demo run drops a report email @demo', () => {
  test.setTimeout(240_000);

  /**
   * SERIAL, and the reason is NOT the notify config any more.
   *
   * Each test now has its own config file, so that state is no longer shared. What
   * still is: both spawn a real `playwright test` with `cwd` at this repo root, and
   * every configured reporter writes into `artifacts/reports` — `run.json`,
   * `junit.xml`, `html/`. Two children in parallel would interleave their writes
   * there, which is the same class of fixture-outside-the-test that made this spec
   * serial in the first place and is not fixed by `--output` (that only moves
   * `test-results`).
   *
   * Said explicitly because "the reason has gone" and "the mode can go" are
   * different statements, and only the second one would justify removing it.
   */
  test.describe.configure({ mode: 'serial' });

  const temp = new Temp();
  let realConfigBefore: NotifyConfigSnapshot;

  test.beforeAll(() => {
    realConfigBefore = snapshotNotifyConfig(REAL_CONFIG);
  });

  test.afterEach(() => {
    temp.cleanUp();
    // AFTER EACH, not only at the end: it names the test that did it.
    const changed = describeNotifyConfigChange(realConfigBefore, snapshotNotifyConfig(REAL_CONFIG));
    expect(changed, changed ?? undefined).toBeNull();
  });

  test('E1: a real run writes the zip and the ready file, and its exit code is untouched', () => {
    // wrong: no drop at all (the reporter never calls it — which is exactly what
    // `--reporter=line` caused, silently, with the child exiting 0), a drop with no
    // zip (called before the archive is complete), or the one that matters most, a
    // green suite reported as FAILED because a mail could not be prepared. The exit
    // code is asserted alongside the files for that reason.
    const configured = temp.dir('aitp-configured-');
    const drop = temp.dir('aitp-drop-e2e-');
    const configFile = temp.config(configured);
    const sentinel = plantSentinel();
    try {
      const { outputDir, result } = runChild({ testFolder: drop, configFile });
      const output = `${result.stdout}${result.stderr}`;

      // §T — the run has to have HAPPENED, or every assertion below is about an
      // empty folder and passes for the wrong reason.
      expect(result.status, `the suite itself did not pass:\n${output}`).toBe(0);
      expect(output, 'the child ran no tests').toContain('1 passed');

      // AND IT LEFT THE PARENT'S ARTIFACTS ALONE. This is the deterministic form of
      // the flake in 5 above: without `CLEAN_ARTIFACTS=false` the child's
      // `globalSetup` removes this directory, so the sentinel is gone and — when the
      // parent holds a handle in there — the child dies with ENOTEMPTY instead.
      expect(
        existsSync(sentinel),
        'the child deleted the parent run’s artifacts/test-results',
      ).toBe(true);

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

      rmSync(outputDir, { recursive: true, force: true });
    } finally {
      rmSync(sentinel, { force: true });
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
    const configured = temp.dir('aitp-configured-');
    const configFile = temp.config(configured);
    const { outputDir, result } = runChild({ configFile });
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status, output).toBe(0);
    expect(output, 'the child ran no tests').toContain('1 passed');
    // It SAYS so — a silent skip is how somebody comes to believe mail is going out.
    expect(output).toContain('fixture-only run');
    expect(readdirSync(configured)).toEqual([]);
    rmSync(outputDir, { recursive: true, force: true });
  });
});

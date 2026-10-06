import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type Browser } from '@playwright/test';
import { test, expect, captureAccessibilityTree } from '@aitp/execution-engine';
import { findRepoRoot } from '@aitp/shared';
import { spawnSyncClean } from '../support/spawn-clean';
import { LoginPage } from './pages/login.page';

/**
 * `pnpm verify-entries`, spawned as a real process (B4).
 *
 * ## What this command answers that nothing else can
 *
 * `validateModuleMap` proves a map against the CAPTURE — the screen as somebody
 * recorded it. The run depends on a different claim: that the route still opens
 * today and the element that proves the screen is still on it. Those come apart
 * silently, because a stale capture validates perfectly.
 *
 * So the command is the capture's falsifier, and these tests are about whether it
 * can FAIL. A checker that only ever reports `verified` is the refuses-everything
 * failure inverted: satisfied by knowing nothing about the page, while looking like
 * the strongest possible result.
 *
 * ## Everything the child reads, this file supplies (§AJ)
 *
 * A temp `AITP_REPO_ROOT` holding `config/env/local.json`, the bundled-demo module
 * map, a capture and a saved session. Nothing comes from the real `artifacts/`,
 * which is gitignored and empty on a clean checkout.
 */

const ROOT = findRepoRoot();
const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

/** The temp repo root, with everything the child reads. */
function fixtureRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'aitp-verify-entries-'));
  writeFileSync(path.join(root, 'pnpm-workspace.yaml'), '');
  mkdirSync(path.join(root, 'config', 'env'), { recursive: true });
  copyFileSync(
    path.join(ROOT, 'config', 'env', 'local.json'),
    path.join(root, 'config', 'env', 'local.json'),
  );
  mkdirSync(path.join(root, 'config', 'apps', 'bundled-demo'), { recursive: true });
  return root;
}

const run = (root: string, args: readonly string[], extraEnv: Record<string, string> = {}) =>
  spawnSyncClean(
    process.execPath,
    [TSX, path.join(ROOT, 'scripts', 'verify-entries.ts'), ...args],
    {
      cwd: ROOT,
      maxBuffer: 20 * 1024 * 1024,
      env: { AITP_REPO_ROOT: root, TEST_ENV: 'local', LOG_LEVEL: 'error', ...extraEnv },
    },
  );

/**
 * One module whose proof IS on the live page, one whose proof is only in the
 * capture.
 *
 * `Stale` is the whole point of the suite: its `provenBy` is planted into the
 * capture and is not on the demo app, so it validates against the capture and must
 * fail against the application. Without it every verdict would be `verified` and the
 * command could not be told from one that checks nothing.
 *
 * ## They are on DIFFERENT routes, and the first draft was not
 *
 * Both started on `/employees`, and the shared-route rule refused BOTH — correctly:
 * every captured state at that route carrying one proof carried the other, so
 * nothing could say which module a run had reached, and `validateModuleMap` called
 * neither provable. The command then refused the whole run for having nothing to
 * check, which is the zero-provable refusal doing its job.
 *
 * That is the rule being right and the fixture being wrong, the same correction the
 * run-sheet CLI spec records about its own shared pair. A planted fault must not take
 * the module it was planted beside with it.
 */
const MAP = {
  'Employee registration': {
    route: '/employees',
    provenBy: { role: 'heading', name: 'Register employee' },
  },
  Stale: {
    route: '/login',
    provenBy: { role: 'heading', name: 'Payroll summary' },
  },
};

test.describe('pnpm verify-entries, as a real process @demo', () => {
  test.setTimeout(240_000);

  /** The capture and the session, from a context that is then closed. */
  async function liveFixture(
    root: string,
    browser: Browser,
    env: {
      baseUrl: string;
      users: Record<string, { username: string; password: string } | undefined>;
    },
  ): Promise<void> {
    const context = await browser.newContext();
    const page = await context.newPage();
    const login = new LoginPage(page, env as never, {});
    await login.open();
    const loginUrl = page.url();
    const loginNodes = (await captureAccessibilityTree(page, { maxNodes: 300 })).nodes;
    await login.login(env.users.admin!.username, env.users.admin!.password);
    const employeesUrl = page.url();
    const employees = (await captureAccessibilityTree(page, { maxNodes: 300 })).nodes;

    const sessionFile = path.join(root, 'artifacts', 'bundled-demo', 'auth', 'local.json');
    mkdirSync(path.dirname(sessionFile), { recursive: true });
    await context.storageState({ path: sessionFile });
    await context.close();

    const session = path.join(root, 'artifacts', 'bundled-demo', 'inspect', 'session-1');
    mkdirSync(session, { recursive: true });
    writeFileSync(
      path.join(session, 'capture.json'),
      JSON.stringify({
        sessionId: 'session-1',
        capturedAt: new Date().toISOString(),
        application: 'bundled-demo',
        environment: 'local',
        baseUrl: env.baseUrl,
        labelledBy: 'inspect',
        states: [
          {
            id: 'employees',
            label: 'employees',
            url: employeesUrl,
            truncated: false,
            nodes: employees,
          },
          {
            id: 'login',
            label: 'login',
            url: loginUrl,
            truncated: false,
            // THE PLANTED PROOF, on its OWN route so it refuses nothing else. In the
            // capture and not on the page — only expressible with a disk capture,
            // because one taken from the page it is then checked against cannot hold
            // an element the page lacks.
            nodes: [...loginNodes, { role: 'heading', name: 'Payroll summary', enabled: true }],
          },
        ],
        transitions: [],
      }),
    );
    writeFileSync(
      path.join(root, 'config', 'apps', 'bundled-demo', 'module-map.json'),
      JSON.stringify(MAP),
    );
  }

  test('B4a: a live module reports verified, and a stale one reports state-assert', async ({
    browser,
    env,
  }) => {
    // wrong: a command that reported `verified` for both would look like the
    // strongest possible result while proving only that two routes open. `Stale`
    // validates against the capture and must fail against the application — that
    // single contrast is the whole claim this tool makes.
    const root = fixtureRoot();
    await liveFixture(root, browser, env);

    const result = run(root, ['--app', 'bundled-demo']);
    const output = `${result.stdout}\n${result.stderr}`;

    // THE BANNER FIRST, before any verdict: a wrong environment is visible on line
    // one rather than as a column of state-assert failures (SEC-2).
    expect(output, output.slice(0, 2000)).toContain('Running against:');
    expect(output).toContain('bundled-demo');

    // §T — it had a subject. Two provable modules, two verdicts.
    expect(output).toContain('2 provable of 2 in the map');
    expect(output).toMatch(/Employee registration\s+\/employees\s+verified/);
    expect(output).toMatch(/Stale\s+\/login\s+state-assert/);
    expect(output).toContain('1 verified, 1 state-assert of 2');

    // The detail NAMES the element, so a reader knows whether to re-walk the screen
    // or to fix the map.
    expect(output).toContain('Payroll summary');

    // AND IT EXITS NON-ZERO, so this is usable as a gate. A checker that always
    // exits 0 is a report nobody can act on automatically.
    expect(result.status).toBe(1);
  });

  test('B4b: with the stale entry removed every module verifies, and the exit code is 0', async ({
    browser,
    env,
  }) => {
    // wrong: this is the silent half. A command hard-wired to fail — a `count()` that
    // always returned 0, a locator built wrong — would pass B4a perfectly, because
    // B4a only needs ONE module to fail. Without this case "state-assert" could be
    // the only verdict the tool is capable of producing.
    const root = fixtureRoot();
    await liveFixture(root, browser, env);
    // The capture keeps its planted node; only the MAP entry goes. So the capture is
    // unchanged and the single difference is whether any module claims that proof.
    writeFileSync(
      path.join(root, 'config', 'apps', 'bundled-demo', 'module-map.json'),
      JSON.stringify({ 'Employee registration': MAP['Employee registration'] }),
    );

    const result = run(root, ['--app', 'bundled-demo']);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(output, output.slice(0, 2000)).toContain('1 provable of 1 in the map');
    expect(output).toMatch(/Employee registration\s+\/employees\s+verified/);
    expect(output).toContain('1 verified of 1');
    expect(output).not.toContain('state-assert');
    expect(result.status).toBe(0);
  });

  test('B4c: the seven refusals, each with the case that must NOT refuse', async ({
    browser,
    env,
  }) => {
    // wrong: a refusal nobody tests either never fires — and the command proceeds
    // into a state it declared unsafe — or fires always, and the command is dead
    // while every negative test still passes. Each case below is paired with the
    // nearest input that must get through, which is the half that tells the two
    // apart (§W).
    const root = fixtureRoot();
    await liveFixture(root, browser, env);

    const mapFile = path.join(root, 'config', 'apps', 'bundled-demo', 'module-map.json');
    const sessionFile = path.join(root, 'artifacts', 'bundled-demo', 'auth', 'local.json');
    const captureFile = path.join(
      root,
      'artifacts',
      'bundled-demo',
      'inspect',
      'session-1',
      'capture.json',
    );

    // 1. ALLOW_WRITES set at all — even empty, even `0`.
    const writes = run(root, ['--app', 'bundled-demo'], { ALLOW_WRITES: '' });
    expect(writes.status).toBe(1);
    expect(`${writes.stderr}`).toContain('ALLOW_WRITES is set');
    // AND IT REFUSES FIRST (§Y): with --app ALSO missing, this is still the message,
    // so the ordering is pinned rather than incidental.
    const writesAndNoApp = run(root, [], { ALLOW_WRITES: '1' });
    expect(`${writesAndNoApp.stderr}`).toContain('ALLOW_WRITES is set');
    expect(`${writesAndNoApp.stderr}`).not.toContain('--app is required');

    // 2. no --app.
    expect(`${run(root, []).stderr}`).toContain('--app is required');
    // 3. --app with a flag after it is not a value.
    expect(`${run(root, ['--app', '--out']).stderr}`).toContain('--app is required');

    // 4. an application with no module map.
    const unknown = run(root, ['--app', 'bundled-demo-typo'], { TEST_ENV: '' });
    expect(`${unknown.stderr}`).toContain('no module map for application');

    // 5. the environment names a DIFFERENT application than --app.
    const mismatch = run(root, ['--app', 'dms']);
    expect(`${mismatch.stderr}`).toContain('Two sources disagree');

    /**
     * 6. no saved session — tested on a SEPARATE root, deliberately.
     *
     * The first draft overwrote this root's session file and restored it afterwards,
     * and the restore put back a placeholder rather than the real one: every later
     * case then reported `auth`, including the silent half at the end. A test that
     * mutates the fixture it shares with its own control is the harness-leaves-
     * residue shape, in miniature — so nothing here touches the live session, and the
     * absence is expressed by a root that never had one.
     */
    const emptyRoot = path.join(root, 'empty-root');
    mkdirSync(path.join(emptyRoot, 'config', 'env'), { recursive: true });
    copyFileSync(
      path.join(ROOT, 'config', 'env', 'local.json'),
      path.join(emptyRoot, 'config', 'env', 'local.json'),
    );
    mkdirSync(path.join(emptyRoot, 'config', 'apps', 'bundled-demo'), { recursive: true });
    copyFileSync(
      mapFile,
      path.join(emptyRoot, 'config', 'apps', 'bundled-demo', 'module-map.json'),
    );
    const noSession = run(emptyRoot, ['--app', 'bundled-demo']);
    expect(`${noSession.stderr}`).toContain('no saved session');
    expect(`${noSession.stderr}`).toContain('pnpm auth');

    // 7. no capture, with the session PRESENT — so this is the capture and nothing
    // else. Without copying the session in, the no-session refusal above would fire
    // first and this case would be testing that one twice (§Y).
    const noCaptureRoot = path.join(root, 'no-capture');
    mkdirSync(path.join(noCaptureRoot, 'config', 'env'), { recursive: true });
    copyFileSync(
      path.join(ROOT, 'config', 'env', 'local.json'),
      path.join(noCaptureRoot, 'config', 'env', 'local.json'),
    );
    mkdirSync(path.join(noCaptureRoot, 'config', 'apps', 'bundled-demo'), { recursive: true });
    copyFileSync(
      mapFile,
      path.join(noCaptureRoot, 'config', 'apps', 'bundled-demo', 'module-map.json'),
    );
    const noCaptureSession = path.join(
      noCaptureRoot,
      'artifacts',
      'bundled-demo',
      'auth',
      'local.json',
    );
    mkdirSync(path.dirname(noCaptureSession), { recursive: true });
    copyFileSync(sessionFile, noCaptureSession);
    const noCapture = run(noCaptureRoot, ['--app', 'bundled-demo']);
    expect(`${noCapture.stderr}`).toContain('no captures for application');

    // 8. not one entry provable against the capture — a REFUSAL, not "0 failed".
    writeFileSync(
      mapFile,
      JSON.stringify({
        Nowhere: { route: '/employees', provenBy: { role: 'heading', name: 'Not in the capture' } },
      }),
    );
    const nothingProvable = run(root, ['--app', 'bundled-demo']);
    expect(`${nothingProvable.stderr}`).toContain('not one of the');
    expect(`${nothingProvable.stderr}`).toContain('nothing to check against the live');

    // THE SILENT HALF OF ALL OF THEM: with every input correct, the command runs and
    // reports a verdict. Every refusal above could be a constant `throw` and each of
    // those assertions would still pass.
    writeFileSync(mapFile, JSON.stringify(MAP));
    expect(captureFile).toBeTruthy();
    const ok = run(root, ['--app', 'bundled-demo']);
    expect(`${ok.stdout}`).toContain('2 provable of 2 in the map');
    expect(`${ok.stdout}`).toMatch(/Employee registration\s+\/employees\s+verified/);
  });
});

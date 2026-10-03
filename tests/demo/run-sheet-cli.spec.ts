import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect, captureAccessibilityTree } from '@aitp/execution-engine';
import { FINAL_TEST_CASES_SCHEMA, findRepoRoot, type RowStatus } from '@aitp/shared';
import { buildXlsx } from '../support/xlsx-fixture';
import { spawnSyncClean } from '../support/spawn-clean';
import { LoginPage } from './pages/login.page';

/**
 * `pnpm run-sheet`, spawned as a real process (P6).
 *
 * `runSheet` has been composed since 4d with one caller — a test. This drives the
 * CLI the way a QA does: a real child process, a real browser it launches itself, a
 * capture it loads from disk, a saved session it replays, and both outputs written
 * under `artifacts/<app>/sheet-runs/<runId>/`.
 *
 * ## Everything the child needs, this file supplies (§AJ)
 *
 * A temp `AITP_REPO_ROOT` holding `config/env/local.json`, the bundled-demo module
 * map, a capture, a session and the workbook. Nothing is read from the real
 * `artifacts/`, which is gitignored and empty on a clean checkout — four guards were
 * corrected for exactly that on 2026-10-02, two of them written an hour after the
 * rule was. The temp root is also what makes the workbook-in-repo refusal testable:
 * for the child, the temp directory IS the repository.
 *
 * ## Why spawn and not import
 *
 * `scripts/inspect-app.ts` was imported by a unit spec, `main()` ran at module scope
 * in every worker, and the stray capture directories that produced were hunted for a
 * day. The CLI is guarded against that now, and this still spawns: the refusals are
 * about argv, the environment and exit codes, and none of those exist for an import.
 */

const ROOT = findRepoRoot();
const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const SHEET = FINAL_TEST_CASES_SCHEMA.sheetName;
const COL = FINAL_TEST_CASES_SCHEMA.columns;
const HEADER = FINAL_TEST_CASES_SCHEMA.expectedHeaders.slice();

/**
 * PRE-REGISTERED OUTCOMES (C8), written before the first run.
 *
 * If the run disagrees, the run is the finding and this table is not edited to match
 * it. One row per outcome the CLI can produce, which is the point of the table: a
 * green run of only passing rows would prove nothing about the six other verdicts.
 */
const EXPECTED: Record<string, RowStatus> = {
  // Proven by the employees view's own h1, reached through the SAVED SESSION.
  'SI_001 / TC_001': 'passed',
  // Resolves and fails on the PROPERTY: the clause claims it is not visible, and it
  // is. Failing on resolution instead would be `refused` and would prove nothing
  // about the executor reading a live page.
  'SI_002 / TC_001': 'failed',
  // `attaches` is an action the platform cannot perform; refused at resolve.
  'UP_001 / TC_001': 'refused',
  // "Save employee" carries a write word, and there is no way to turn writes on.
  'WR_001 / TC_001': 'held',
  // Identity, and no clause content at all.
  'UR_001 / TC_001': 'unreadable',
  // IN the capture, NOT on the page — the outcome the old fixture could not reach,
  // because it took its capture from the page it then ran against. A disk-loaded
  // capture is what makes it expressible.
  'ST_001 / TC_001': 'stale-capture',
  // A module the map has no entry for: its own rows refused, the rest still run.
  'UM_001 / TC_001': 'refused',
  // A module that shares a route with another and cannot be told apart from it.
  'SR_001 / TC_001': 'refused',
};

const sheetRow = (cells: Partial<Record<keyof typeof COL, string>>): string[] => {
  const row = Array.from({ length: HEADER.length }, () => '');
  for (const [key, value] of Object.entries(cells)) {
    row[COL[key as keyof typeof COL] - 1] = value ?? '';
  }
  return row;
};

const FIXTURE_ROWS: string[][] = [
  sheetRow({
    module: 'Employee registration',
    scenarioId: 'SI_001',
    testCaseId: 'TC_001',
    scenarioName: 'the registration form is on screen',
    then: 'verify the "Register employee" heading is visible',
  }),
  sheetRow({
    module: 'Employee registration',
    scenarioId: 'SI_002',
    testCaseId: 'TC_001',
    scenarioName: 'the directory section is absent',
    then: 'verify the "Employee directory" heading is not visible',
  }),
  sheetRow({
    module: 'Employee registration',
    scenarioId: 'UP_001',
    testCaseId: 'TC_001',
    scenarioName: 'a document is attached to the record',
    when: 'user attaches the document',
    then: 'verify the "Employee directory" heading is visible',
  }),
  sheetRow({
    module: 'Employee registration',
    scenarioId: 'WR_001',
    testCaseId: 'TC_001',
    scenarioName: 'the form is submitted',
    when: 'clicks on "Save employee"',
    then: 'verify the "Employee directory" heading is visible',
  }),
  sheetRow({
    module: 'Employee registration',
    scenarioId: 'UR_001',
    testCaseId: 'TC_001',
    scenarioName: 'a row somebody started and left',
  }),
  sheetRow({
    module: 'Employee registration',
    scenarioId: 'ST_001',
    testCaseId: 'TC_001',
    scenarioName: 'an element the capture has and the page does not',
    then: 'verify the "Payroll summary" heading is visible',
  }),
  sheetRow({
    module: 'Nobody mapped this',
    scenarioId: 'UM_001',
    testCaseId: 'TC_001',
    scenarioName: 'a module with no map entry',
    then: 'verify the "Register employee" heading is visible',
  }),
  sheetRow({
    module: 'Shared A',
    scenarioId: 'SR_001',
    testCaseId: 'TC_001',
    scenarioName: 'a module sharing a route with an identical proof',
    then: 'verify the "Register employee" heading is visible',
  }),
];

/** The temp repo root, with everything the child reads. */
function fixtureRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'aitp-run-sheet-cli-'));
  writeFileSync(path.join(root, 'pnpm-workspace.yaml'), '');
  mkdirSync(path.join(root, 'config', 'env'), { recursive: true });
  copyFileSync(
    path.join(ROOT, 'config', 'env', 'local.json'),
    path.join(root, 'config', 'env', 'local.json'),
  );
  mkdirSync(path.join(root, 'config', 'apps', 'bundled-demo'), { recursive: true });
  return root;
}

/**
 * The map the child validates: the real demo entries, plus two deliberate faults.
 *
 * `Shared A` and `Shared B` share `/shared` with an IDENTICAL proof, which is the P0
 * case — two modules one proof cannot tell apart. Only `Shared A` has rows, so the
 * run also shows that an unprovable entry nobody named (`Shared B`) is a WARNING and
 * not a refusal.
 *
 * ## Why they are not on `/employees`, which the first draft did
 *
 * Measured: putting them on the real module's route refused `Employee registration`
 * TOO, and correctly — three modules on one screen, and no captured state separates
 * any of them from the others, so none can say which one a run reached. Every row in
 * the sheet was then refused for the same reason and the CLI stopped with "no module
 * the sheet names can be run", which is the whole-run refusal doing its job.
 *
 * That is the rule being right and the fixture being wrong: a fault planted to
 * exercise one outcome must not take the other seven with it.
 */
const MAP = {
  Login: { route: '/login', provenBy: { role: 'heading', name: 'Sign in' } },
  'Employee registration': {
    route: '/employees',
    provenBy: { role: 'heading', name: 'Register employee' },
  },
  'Shared A': { route: '/shared', provenBy: { role: 'heading', name: 'Shared screen' } },
  'Shared B': { route: '/shared', provenBy: { role: 'heading', name: 'Shared screen' } },
};

const run = (root: string, args: readonly string[], extraEnv: Record<string, string> = {}) =>
  spawnSyncClean(process.execPath, [TSX, path.join(ROOT, 'scripts', 'run-sheet.ts'), ...args], {
    cwd: ROOT,
    maxBuffer: 20 * 1024 * 1024,
    env: { AITP_REPO_ROOT: root, TEST_ENV: 'local', LOG_LEVEL: 'error', ...extraEnv },
  });

test.describe('pnpm run-sheet, as a real process @demo', () => {
  test.setTimeout(240_000);

  test('C1: every row lands on its pre-registered outcome, from a disk capture and a saved session', async ({
    browser,
    env,
  }) => {
    // wrong: the CLI is green because it resolved everything and executed nothing —
    // the outcomes below are the only thing that tells a real run from a composition
    // that read a sheet and wrote a report about it.
    const root = fixtureRoot();
    try {
      // ---- the capture and the session, from a context that is then CLOSED ----
      // Separate from the child's browser on purpose: if this test signed in and
      // handed the CLI the same page, a broken session replay would be invisible
      // because the page would already be where the rows need it (F2).
      const context = await browser.newContext();
      const page = await context.newPage();
      const login = new LoginPage(page, env, {});
      await login.open();
      const states = [
        {
          id: 'login',
          label: 'login',
          url: page.url(),
          truncated: false,
          nodes: (await captureAccessibilityTree(page, { maxNodes: 300 })).nodes,
        },
      ];
      await login.login(env.users.admin!.username, env.users.admin!.password);
      const employees = (await captureAccessibilityTree(page, { maxNodes: 300 })).nodes;
      states.push({
        id: 'employees',
        label: 'employees',
        url: page.url(),
        truncated: false,
        // THE STALE ELEMENT, added to the capture and absent from the page. Only a
        // disk-loaded capture can hold one: a capture taken from the page it is then
        // run against cannot, by construction.
        nodes: [...employees, { role: 'heading', name: 'Payroll summary', enabled: true }],
      });
      // A state for the shared-route pair, so their proof RESOLVES and they are
      // refused for being indistinguishable rather than for being absent. Two
      // different reasons, and only one of them is what SR_001 is pre-registered for.
      states.push({
        id: 'shared',
        label: 'shared',
        url: new URL('/shared', env.baseUrl).toString(),
        truncated: false,
        nodes: [{ role: 'heading', name: 'Shared screen', enabled: true }],
      });

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
          states,
          transitions: [],
        }),
      );
      writeFileSync(
        path.join(root, 'config', 'apps', 'bundled-demo', 'module-map.json'),
        JSON.stringify(MAP),
      );

      const workbook = path.join(root, 'artifacts', 'fixture.xlsx');
      writeFileSync(workbook, buildXlsx([{ name: SHEET, rows: [HEADER, ...FIXTURE_ROWS] }]));

      // ---- the run ----
      const result = run(root, ['--app', 'bundled-demo', '--sheet', SHEET, workbook]);
      const output = `${result.stdout}\n${result.stderr}`;

      // §T: the run must have READ the sheet. "0 rows" and "every row refused" are
      // different findings, and a report over nothing is neither.
      expect(output, output.slice(0, 1500)).toMatch(/Rows read: (\d+)/);
      const rowsRead = Number(/Rows read: (\d+)/.exec(output)?.[1] ?? 0);
      expect(rowsRead).toBe(FIXTURE_ROWS.length);
      expect(result.status, output.slice(0, 1500)).toBe(0);

      // The banner, before anything else: a wrong environment is visible on line one.
      expect(output).toContain('Running against:');
      expect(output).toContain('bundled-demo');

      const runs = readdirSync(path.join(root, 'artifacts', 'bundled-demo', 'sheet-runs'));
      expect(runs).toHaveLength(1);
      const outDir = path.join(root, 'artifacts', 'bundled-demo', 'sheet-runs', runs[0]!);
      const report = readFileSync(path.join(outDir, 'authored-run.md'), 'utf8');

      // EVERY pre-registered row is named somewhere in the document. Necessary and
      // not sufficient — a row in the wrong section would still satisfy this — which
      // is why the tally below is the actual verdict.
      for (const rowId of Object.keys(EXPECTED)) {
        expect(report, `${rowId} is not in the report at all`).toContain(rowId);
      }

      /**
       * THE TALLY IS THE VERDICT (§Z).
       *
       * Derived from the pre-registered table rather than written out again, so the
       * two cannot drift: if a row is expected to move buckets, `EXPECTED` is the one
       * place that changes. And it is DISCRIMINATING in a way "the row appears" is
       * not — a row landing in the wrong bucket moves two numbers at once, so no
       * single mistake can keep the sum intact.
       */
      const wanted = new Map<RowStatus, number>();
      for (const status of Object.values(EXPECTED)) {
        wanted.set(status, (wanted.get(status) ?? 0) + 1);
      }
      // The report's own labels, copied from `STATUS_LABEL` — a label this spec
      // invented would make the assertion a claim about a string nobody writes.
      const LABEL: Record<RowStatus, string> = {
        passed: 'Passed',
        failed: 'Failed',
        refused: 'Refused',
        held: 'Held',
        unreadable: 'Unreadable',
        'stale-capture': 'Stale capture',
        'given-not-reached': 'Given not reached',
      };
      for (const [status, count] of wanted) {
        expect(report, `the tally does not say ${count} for ${status}`).toContain(
          `| ${LABEL[status]} | ${count} |`,
        );
      }
      expect(report).toContain(`| Rows read | **${FIXTURE_ROWS.length}** |`);

      // P0's warning half: `Shared B` has no rows and is still reported.
      expect(report).toContain('cannot prove their screen');
      expect(report).toContain('Shared B');

      // P5: the leftover-token line, a measurement and not a gate.
      expect(report).toContain('Leftover words — a measurement, not a gate');

      // Both outputs exist, and the CSV is the one a QA opens.
      expect(readdirSync(outDir).sort()).toContain('authored-run.md');
      expect(readdirSync(outDir).some((f) => f.endsWith('.csv'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('C2: the seven refusals, each with the case that must NOT refuse', () => {
    // wrong: a refusal that fires for every input is satisfied without knowing
    // anything — so each case below is paired with the same command succeeding once
    // the one condition is removed. The silent half is the load-bearing one.
    const root = fixtureRoot();
    try {
      writeFileSync(
        path.join(root, 'config', 'apps', 'bundled-demo', 'module-map.json'),
        JSON.stringify(MAP),
      );
      const workbook = path.join(root, 'artifacts', 'fixture.xlsx');
      mkdirSync(path.dirname(workbook), { recursive: true });
      writeFileSync(workbook, buildXlsx([{ name: SHEET, rows: [HEADER, ...FIXTURE_ROWS] }]));
      const ok = ['--app', 'bundled-demo', '--sheet', SHEET, workbook];

      // 1 — no --app
      const noApp = run(root, ['--sheet', SHEET, workbook]);
      expect(noApp.status).toBe(1);
      expect(noApp.stderr).toContain('--app is required');

      // 2 — --app disagrees with the environment
      const mismatch = run(root, ['--app', 'acme', '--sheet', SHEET, workbook]);
      expect(mismatch.stderr).toMatch(/--app says "acme".*TEST_ENV="local"/s);
      expect(mismatch.stderr).toContain('no safe tie-break');

      // 3 — ALLOW_WRITES set
      const writes = run(root, ok, { ALLOW_WRITES: 'true' });
      expect(writes.status).toBe(1);
      expect(writes.stderr).toContain('ALLOW_WRITES is set');
      expect(writes.stderr).toContain('Unset ALLOW_WRITES');

      // 4 — no --sheet
      const noSheet = run(root, ['--app', 'bundled-demo', workbook]);
      expect(noSheet.stderr).toContain('--sheet is required');

      // 5 — the workbook is inside the repo and not under artifacts/
      const inRepo = path.join(root, 'fixture.xlsx');
      writeFileSync(inRepo, readFileSync(workbook));
      const insideRepo = run(root, ['--app', 'bundled-demo', '--sheet', SHEET, inRepo]);
      expect(insideRepo.stderr).toContain('inside the repository');
      expect(insideRepo.stderr).toContain('live credentials');

      // 6 — no saved session. Reached only after 1-5 pass, which is itself the
      // ordering check: a missing session must not be reported while --app is absent.
      const noSession = run(root, ok);
      expect(noSession.status).toBe(1);
      expect(noSession.stderr).toContain('no saved session');
      // NAMED as different from an expired one, because the actions differ.
      expect(noSession.stderr).toContain('NOT the same as an expired session');

      // 7 — no capture. The session has to exist to get this far, so it is written
      // first; that ordering is the §Y half — this refusal is only reachable once
      // the session check has passed.
      const sessionFile = path.join(root, 'artifacts', 'bundled-demo', 'auth', 'local.json');
      mkdirSync(path.dirname(sessionFile), { recursive: true });
      writeFileSync(sessionFile, JSON.stringify({ cookies: [], origins: [] }));
      const noCapture = run(root, ok);
      expect(noCapture.status).toBe(1);
      expect(noCapture.stderr).toMatch(/no captures for application "bundled-demo"/);
      expect(noCapture.stderr).toContain('nothing to resolve them with');

      // THE SILENT HALF for all seven: with every condition satisfied the command
      // gets past all of them. A capture with no usable state still refuses at the
      // loader, so this asserts the run reached the ROW stage — the first thing that
      // can only happen after every refusal above declined to fire.
      const session = path.join(root, 'artifacts', 'bundled-demo', 'inspect', 's1');
      mkdirSync(session, { recursive: true });
      writeFileSync(
        path.join(session, 'capture.json'),
        JSON.stringify({
          sessionId: 's1',
          capturedAt: new Date().toISOString(),
          application: 'bundled-demo',
          baseUrl: 'http://127.0.0.1:4173',
          labelledBy: 'inspect',
          states: [
            {
              id: 'employees',
              label: 'employees',
              url: 'http://127.0.0.1:4173/employees',
              truncated: false,
              nodes: [{ role: 'heading', name: 'Register employee', enabled: true }],
            },
          ],
          transitions: [],
        }),
      );
      const reached = run(root, ok);
      expect(
        `${reached.stdout}\n${reached.stderr}`,
        'no refusal fired, and the run still did not reach the rows',
      ).toMatch(/Rows read: \d+|Capture:/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

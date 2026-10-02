import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import path from 'node:path';
import { test, expect, captureAccessibilityTree, runSheet } from '@aitp/execution-engine';
import {
  FINAL_TEST_CASES_SCHEMA,
  findRepoRoot,
  type BoundedCapture,
  type RowStatus,
  type RunIdentity,
} from '@aitp/shared';
import { buildXlsx } from '../support/xlsx-fixture';
import { LoginPage } from './pages/login.page';

/**
 * The first end-to-end run of `runSheet` — a real workbook, a real page, a real
 * report and a real CSV.
 *
 * `runSheet` is COMPOSED, NOT YET WIRED: this test is its only caller. The CLI
 * (`pnpm run-sheet`) arrives in 3b and is what will tie the end to something a
 * person invokes.
 *
 * ## What this covers, and what 3b still owes
 *
 * Six of the seven row outcomes appear below. The two that do not:
 *
 * - **`stale-capture`** needs a target that is IN the capture and NOT on the
 *   page. The capture here is taken FROM the page (see F2 below), so that state
 *   is impossible by construction — which is the right trade: a hand-written
 *   capture could manufacture it, and a hand-written capture is what §R showed
 *   hides the ORDER. It belongs with 3b's disk-loaded capture.
 * - **loading a capture from disk** at all. Measured 2026-09-29: all nine
 *   sessions under `artifacts/inspect/` are the customer system, and `artifacts/`
 *   is gitignored, so there is no demo capture to load and a fresh clone has
 *   none.
 *
 * ## F2 — the capture is taken in a SEPARATE context, then thrown away
 *
 * If this test signed in to take the capture and then handed the composition the
 * same page, a broken `signIn` inside `runSheet` would be invisible: the page
 * would already be where the rows need it. So the capture comes from its own
 * browser context, that context is closed, and the composition gets a fresh page
 * at `about:blank`. Both facts are asserted, and `signIn` is counted.
 */

/** Fake by construction, and shaped like the real sheet's `mail id : … Password : …`. */
const FAKE_CREDENTIAL = 'mail id : qa.fixture@example.invalid Password : NotARealPassword-0000';

/**
 * PRE-REGISTERED OUTCOMES (C8).
 *
 * Written before the first run. If the run disagrees, the run is the finding and
 * this table is not edited to match it.
 */
const EXPECTED: Record<string, RowStatus> = {
  // Proven by `heading "Register employee"` — the employees view's own h1.
  'SI_001 / TC_001': 'passed',
  // A SECOND real locator (the h2), so one element is not carrying the file.
  'SI_002 / TC_001': 'passed',
  // Resolves (the heading IS in the capture) and fails on the PROPERTY: the
  // clause claims it is not visible, and it is. Failing on resolution instead
  // would be a different outcome (`refused`) and would prove nothing about the
  // executor reading a live page.
  'SI_003 / TC_001': 'failed',
  // `attaches` is an action the platform cannot perform; refused at resolve, so
  // no click is attempted.
  'UP_001 / TC_001': 'refused',
  // "Save employee" carries a write word, and ALLOW_WRITES is not set.
  'WR_001 / TC_001': 'held',
  // Identity but no Given/When/And/Then content at all.
  //
  // This key is the ORIGINAL pre-registered value. The first run came back
  // `sheet row 7` instead, and the key was edited to match it with the
  // divergence recorded as F-UR-ID rather than quietly accepted. The reader now
  // carries the identity it had already read, so the pre-registration stands as
  // written. The status never changed — only the name it was reported under.
  'UR_001 / TC_001': 'unreadable',
};

/** C3 — exact, and written before the run. `> 0` would pass on the wrong number. */
const EXPECTED_APP_TEAM_ROWS = 1;

/**
 * G2 — columns an app-team CSV row is allowed to leave EMPTY.
 *
 * Declared before the check was run, and the empty list IS the declaration:
 * every column of a row handed to the app team should carry something, because a
 * blank cell in an issue sheet reads as "nothing to say" rather than "not
 * available" — the same distinction `NOT_ANALYSED` exists for.
 *
 * It is a list rather than a boolean so that a future exception has to be WRITTEN
 * DOWN with a name. The Module column was blank in every sheet this writer ever
 * produced and nothing said so, because nothing was looking column by column.
 */
const ALLOWED_EMPTY_COLUMNS: readonly string[] = [];

const HEADER: string[] = [...FINAL_TEST_CASES_SCHEMA.expectedHeaders];

/** Column positions, by name, from the schema this reader validates against. */
const COL = FINAL_TEST_CASES_SCHEMA.columns;

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
    scenarioName: 'the directory section is on screen',
    then: 'verify the "Employee directory" heading is visible',
  }),
  sheetRow({
    module: 'Employee registration',
    scenarioId: 'SI_003',
    testCaseId: 'TC_001',
    scenarioName: 'the directory section is absent',
    then: 'verify the "Employee directory" heading is not visible',
    // C2: the credential-shaped cell sits on the row that REACHES the CSV. On a
    // passing row it never would, so "the literal is not in the CSV" would have
    // been true of an empty file.
    testData: FAKE_CREDENTIAL,
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
  // No clause columns at all — identity without content.
  sheetRow({
    module: 'Employee registration',
    scenarioId: 'UR_001',
    testCaseId: 'TC_001',
    scenarioName: 'a row somebody started and left',
  }),
];

/** Text files a leak could hide in. Screenshots and traces are binary. */
const textFilesIn = (dir: string): string[] =>
  readdirSync(dir)
    .filter((f) => /\.(md|csv|json|txt)$/i.test(f))
    .map((f) => path.join(dir, f));

test.describe('runSheet against the bundled demo app @demo', () => {
  test('R1: every row lands on its pre-registered outcome, and both outputs are written', async ({
    env,
    browser,
  }) => {
    // wrong: the run is green because the fixture asks nothing of the page — the
    // outcomes below are the only thing that distinguishes a real run from a
    // composition that resolved everything and executed nothing.
    const root = findRepoRoot();
    const outDir = path.join(root, 'artifacts', 'run-sheet-spec');
    mkdirSync(outDir, { recursive: true });

    // The workbook is built at runtime, under artifacts/, which is gitignored.
    const workbook = path.join(outDir, 'fixture.xlsx');
    writeFileSync(
      workbook,
      buildXlsx([{ name: FINAL_TEST_CASES_SCHEMA.sheetName, rows: [HEADER, ...FIXTURE_ROWS] }]),
    );
    // The fixture must be inside artifacts/ — not beside a real workbook.
    expect(path.resolve(workbook).startsWith(path.join(root, 'artifacts') + path.sep)).toBe(true);

    // ---- F2: the capture comes from its own context, which is then closed ----
    // BOTH screens, and the first run is why. With only the employees state,
    // `createEntryVerifier` refused at load: the map validator checks EVERY module,
    // and the bundled-demo map also describes `Login`, whose `provenBy heading
    // "Sign in"` was not in a capture taken after signing in. That breadth is the
    // validator working — a map entry nobody can prove is a map entry that fails row
    // by row later — and the fixture was the thin thing. A real `pnpm inspect`
    // session walks several screens too.
    //
    // 3b changed what that breadth COSTS, not the breadth: the whole map is still
    // validated, and an unprovable entry now refuses only the rows of the module it
    // belongs to while appearing as a warning in the report. `Login` is still
    // captured here, so the fixture is unchanged — but a thin capture would now
    // produce a report with a warning rather than no report at all.
    const captureContext = await browser.newContext();
    const capturePage = await captureContext.newPage();
    const captureLogin = new LoginPage(capturePage, env, {});
    await captureLogin.open();
    await expect(capturePage.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
    const loginTree = await captureAccessibilityTree(capturePage, { maxNodes: 1_000 });

    await captureLogin.login(env.users.admin!.username, env.users.admin!.password);
    await expect(
      capturePage.getByRole('heading', { name: 'Register employee', exact: true }),
    ).toBeVisible();
    const employeesTree = await captureAccessibilityTree(capturePage, { maxNodes: 1_000 });

    const capture: BoundedCapture = {
      sessionId: 'run-sheet-spec',
      states: [
        {
          id: 'login',
          label: 'login',
          url: loginTree.url,
          nodes: loginTree.nodes,
          truncated: loginTree.truncated,
        },
        {
          id: 'employees',
          label: 'employees',
          url: employeesTree.url,
          nodes: employeesTree.nodes,
          truncated: employeesTree.truncated,
        },
      ],
      transitions: [],
      selection: { keywords: [], available: [], chosen: [], excluded: [] },
    };
    await captureContext.close();

    // The capture must actually hold the screen, or every resolution below is
    // about an empty page (§T: the input has to have arrived).
    expect(capture.states).toHaveLength(2);
    for (const state of capture.states) expect(state.nodes.length).toBeGreaterThan(3);

    // ---- a FRESH page, and signIn counted ----
    const context = await browser.newContext();
    const page = await context.newPage();
    expect(page.url(), 'the composition must start from a page it has not signed in on').toBe(
      'about:blank',
    );

    let signIns = 0;
    const login = new LoginPage(page, env, {});
    const signIn = async (): Promise<void> => {
      signIns += 1;
      await login.open();
      await login.login(env.users.admin!.username, env.users.admin!.password);
    };

    const identity: RunIdentity = { runBy: 'fixture-user', runBySource: 'git' };
    const rowsBefore = await page.getByTestId('employee-row').count();

    const result = await runSheet({
      workbook,
      sheet: FINAL_TEST_CASES_SCHEMA.sheetName,
      env,
      capture,
      page,
      signIn,
      outDir,
      identity,
      runId: 'run_runsheetspec',
      provenance: {
        target: 'the bundled demo app on 127.0.0.1:4173',
        proves: 'the composition reads a sheet, proves an entry state and runs rows on a real page',
        doesNotProve: 'anything about the customer system, whose sheet and screens differ',
      },
    });

    expect(signIns, 'signIn must be called exactly once per run').toBe(1);
    expect(result.runId).toBe('run_runsheetspec');

    // §T — the run saw the rows the sheet had, counted from the inputs.
    expect(result.rowsRead).toBe(FIXTURE_ROWS.length);
    expect(result.run.tally.rowsRead).toBe(FIXTURE_ROWS.length);

    // ---- C8: actual vs pre-registered, as one object ----
    const actual = Object.fromEntries(result.run.results.map((r) => [r.rowId, r.status]));
    expect(actual).toEqual(EXPECTED);

    // ---- C4: the RIGHT reason, not merely the right status ----
    const byId = Object.fromEntries(result.run.results.map((r) => [r.rowId, r]));

    // SI_003 failed on the Then clause, reading the page — not on a timeout and
    // not because the entry state was never reached.
    const failedRow = byId['SI_003 / TC_001']!;
    expect(failedRow.evidence?.failingClause).toContain('Employee directory');
    expect(failedRow.evidence?.failingClause).toContain('present=false');
    // The OBSERVATION, in the words an absence assertion now uses. It used to read
    // `present=true, expected false`, which came from `.first().isVisible()` — and
    // that path also reported `stale-capture` when the element was genuinely absent
    // and the row therefore SATISFIED. An absence assertion now counts matches, so
    // it says how many it found, and the row still fails for the same reason.
    expect(failedRow.observed?.join(' ')).toContain('1 heading(s) named "Employee directory"');
    expect(failedRow.observed?.join(' ')).toContain('expected none');
    expect(failedRow.detail).not.toMatch(/timeout|timed out/i);
    expect(failedRow.status).not.toBe('given-not-reached');

    // WR_001 is held for a WRITE, read off its own row rather than inferred.
    const heldRow = byId['WR_001 / TC_001']!;
    expect(heldRow.detail).toContain('create, modify or delete data');
    expect(heldRow.detail).toContain('ALLOW_WRITES');

    // AND NOTHING RAN. The direct claim, not a proxy for it.
    //
    // This was `employee-row` count === rowsBefore plus `empty-state` visible,
    // and both were measured on 2026-09-29 to be NON-DISCRIMINATING: the demo
    // app's own validation rejects a bare "Save employee" click, so the count
    // stays 0 whether the hold worked or not. The check was measuring the demo
    // app's form validation and reading as a check on the platform's write gate.
    //
    // `stepsRun` is the platform's own record of how many steps the executor was
    // asked to run. 0 for a held row by construction.
    expect(heldRow.stepsRun, 'a held row must not have run a step').toBe(0);
    // Discriminating in the same assertion family: the row that DID run has a
    // non-zero count, so `0` above is not what every row reports.
    expect(failedRow.stepsRun).toBeGreaterThan(0);

    // The DOM check stays, downgraded to what it actually is: corroboration that
    // the page did not change, not the proof that nothing ran.
    expect(await page.getByTestId('employee-row').count()).toBe(rowsBefore);

    // ---- C3: the CSV carries exactly the app-team rows, a number fixed above ----
    const csv = readFileSync(result.automationSheetPath, 'utf8');
    const dataRows = csv
      .replace(/^\uFEFF/, '')
      .trim()
      .split('\r\n')
      .slice(1);
    expect(dataRows).toHaveLength(EXPECTED_APP_TEAM_ROWS);
    expect(dataRows[0]).toContain('SI_003 / TC_001');
    expect(dataRows[0]).toContain('automation-fixture-user');
    expect(dataRows[0]).toContain('run_runsheetspec');

    // ---- G2: every column of every app-team row, not the row as one string ----
    //
    // `toContain` over a joined line cannot see a blank cell, which is how the
    // Module column stayed empty in every sheet this writer produced. Parsed
    // properly because `Observed` holds a comma inside quotes, so splitting on
    // `,` would shift every column after it and compare the wrong cells.
    const grid = parseCsv(csv);
    expect(grid.length, 'the CSV parsed to no rows — the check had no subject').toBe(
      EXPECTED_APP_TEAM_ROWS + 1,
    );
    const headings = grid[0]!;
    expect(headings.length).toBeGreaterThan(5);
    for (const [index, cells] of grid.slice(1).entries()) {
      expect(cells.length, `data row ${index + 1} has the wrong column count`).toBe(
        headings.length,
      );
      for (const [column, heading] of headings.entries()) {
        if (ALLOWED_EMPTY_COLUMNS.includes(heading)) continue;
        expect(
          cells[column]!.trim(),
          `data row ${index + 1}, column "${heading}" is empty`,
        ).not.toBe('');
      }
    }

    // ---- C2: no credential literal, and no trace path, in ANY text output ----
    const texts = textFilesIn(outDir);
    expect(
      texts.length,
      'the leak scan read no files — its silence would mean nothing',
    ).toBeGreaterThanOrEqual(2);
    for (const file of texts) {
      const body = readFileSync(file, 'utf8');
      expect(body, `${file} carries the Test Data literal`).not.toContain('NotARealPassword-0000');
      expect(body, `${file} carries a trace path`).not.toContain('trace.zip');

      // ---- G3: no absolute path out of this machine ----
      //
      // Not a credential, and still not something to hand over: a report and a
      // CSV are what a QA pastes into an issue tracker, and an absolute path
      // carries the developer's home directory and OS username with it. Every
      // path a reader needs is inside the repo, so every path can be
      // repo-relative.
      //
      // `runBy` is injected here (`fixture-user`), so the username cannot reach
      // these files legitimately. When the CLI resolves identity for real and
      // `runBySource` is `os`, `Reported By` IS the username by design — that
      // check belongs to whoever writes the CLI, per column rather than per file.
      expect(body, `${file} carries the home directory`).not.toContain(homedir());
      expect(body, `${file} carries the OS username`).not.toContain(userInfo().username);
    }

    // The report exists and names the run.
    expect(readFileSync(result.reportPath, 'utf8')).toContain('run_runsheetspec');

    await context.close();
  });

  test('R2: the run leaves no workbook in the repo', () => {
    // wrong: a fixture written outside artifacts/ is ignored by `*.xlsx` alone,
    // and that rule is unanchored — if it were ever tightened, a committed
    // workbook would be one `git add` away. This asserts the tracked set itself.
    const tracked = execSyncLines('git ls-files');
    expect(tracked.length, 'the listing read nothing').toBeGreaterThan(50);
    expect(tracked.filter((f) => /\.(xlsx|xlsm|xls|ods)$/i.test(f))).toEqual([]);
  });
});

/**
 * RFC 4180, enough of it to check a cell rather than a line.
 *
 * Deliberately NOT the writer's own splitting logic: a parser borrowed from the
 * thing under test agrees with it by construction, which is the counting-gateway
 * mistake. This reads quotes, doubled quotes and CRLF the way Excel does, which
 * is the reader this file is written for.
 */
function parseCsv(text: string): string[][] {
  const body = text.startsWith(String.fromCharCode(0xfeff)) ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < body.length; i += 1) {
    const char = body[i]!;
    if (quoted) {
      if (char !== '"') cell += char;
      else if (body[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\r' && body[i + 1] === '\n') {
      row.push(cell);
      cell = '';
      rows.push(row);
      row = [];
      i += 1;
    } else cell += char;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/**
 * `git ls-files`, as lines.
 *
 * `git` is the one spawn this repo exempts from `spawn-clean`, and the exemption
 * is reasoned: git consults neither `NODE_PATH` nor `NODE_OPTIONS`, so its answer
 * cannot differ between the runner's environment and a production one.
 */
function execSyncLines(command: string): string[] {
  return execSync(command, { cwd: findRepoRoot(), encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 })
    .split(/\r?\n/)
    .filter(Boolean);
}

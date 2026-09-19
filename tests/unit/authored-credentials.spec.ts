import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import {
  FINAL_TEST_CASES_SCHEMA,
  executeAuthoredRows,
  findRepoRoot,
  readFinalTestCases,
  renderAuthoredReport,
  resolveAuthoredRow,
  type BoundedCapture,
  type EntryControl,
  type SheetGrid,
  type StepExecutor,
} from '@aitp/shared';

/**
 * Where a credential may come from, asked in three directions.
 *
 * The standing rule is "Test Data holds no credential; auth always comes from
 * the environment". A rule stated is not a rule held, so each of the three
 * sources is planted with the SAME distinctive secret and the run is searched
 * for it:
 *
 *   C1  a Test Data cell           MUST NOT reach the run or the report
 *   C2  a clause the QA wrote      MUST reach them — the control that proves
 *                                  the search can find what is there at all
 *   C3  the execute path           reads no sheet field that could carry one
 *
 * **C2 is why C1 means anything.** "The secret is not in the report" is equally
 * true when the planting never worked, when the report is empty, and when the
 * search is misspelled — three ways to pass while knowing nothing. C2 plants the
 * same string somewhere that legitimately flows, so a silent search fails loudly.
 *
 * The real workbook can never be committed; these fixtures reproduce its
 * measured shape, including the Test Data cell's `mail id : … Password : …`
 * form (`docs/phase-2-authored-cases.md` §0a).
 */

/** Distinctive enough that a hit cannot be a coincidence in surrounding prose. */
const SECRET = 'Zx9-Qv4-PLANTED-SECRET';

const HEADER: string[] = [...FINAL_TEST_CASES_SCHEMA.expectedHeaders];

const sheetRow = (over: Partial<Record<number, string>> = {}): string[] => {
  const cells = Array.from({ length: 22 }, () => '');
  cells[0] = 'Login';
  cells[1] = 'Sign in';
  cells[2] = 'SI_001';
  cells[3] = 'TC_001';
  cells[4] = 'Valid login';
  cells[9] = 'User is on the login page';
  cells[10] = 'User enters valid credentials';
  cells[11] = 'User clicks the sign-in button';
  cells[12] = 'The dashboard should be visible';
  for (const [column, value] of Object.entries(over)) cells[Number(column)] = value ?? '';
  return cells;
};

const gridOf = (...rows: string[][]): SheetGrid => ({
  name: FINAL_TEST_CASES_SCHEMA.sheetName,
  rows: [HEADER, ...rows],
});

const capture: BoundedCapture = {
  sessionId: 'c',
  states: [
    {
      id: 'login',
      label: 'login',
      url: 'https://app.example/login',
      nodes: [{ role: 'heading', name: 'Sign in', enabled: true }],
      truncated: false,
    },
  ],
  transitions: [],
  selection: { keywords: [], available: [], chosen: [], excluded: [] },
};

/** Everything a run produces that a human or a file could later see. */
async function everythingTheRunProduces(grid: SheetGrid): Promise<string> {
  const read = readFinalTestCases(grid);
  const resolved = read.rows.map((row) => resolveAuthoredRow(row, capture, 'login'));

  const execute: StepExecutor = async ({ target }) => ({
    kind: 'passed',
    observed: `saw ${target?.name ?? 'nothing'}`,
  });
  const entry: EntryControl = {
    moduleOf: () => 'Login',
    verify: async () => ({ verified: true }),
  };

  const run = await executeAuthoredRows({ resolved, unreadable: read.unreadable, execute, entry });

  return [
    JSON.stringify(read.rows),
    JSON.stringify(resolved),
    JSON.stringify(run),
    renderAuthoredReport(run, FINAL_TEST_CASES_SCHEMA.sheetName),
  ].join('\n');
}

test.describe('a credential can reach a run from the environment only @unit', () => {
  test('C2: a secret in a CLAUSE does reach the run — the control for C1', async () => {
    // wrong: this passes too, and then C1 proves nothing — a search that cannot
    // find a planted string is a search whose silence means nothing.
    const planted = await everythingTheRunProduces(
      gridOf(sheetRow({ 11: `User types ${SECRET} into the box` })),
    );

    expect(planted).toContain(SECRET);
  });

  test('C1: a secret in the TEST DATA cell reaches neither the run nor the report', async () => {
    // wrong: the cell's contents ride along in the resolved row, and the first
    // report a QA mails out carries a live password out of the team.
    const output = await everythingTheRunProduces(
      gridOf(sheetRow({ 14: `mail id : hr.admin Password : ${SECRET}` })),
    );

    expect(output).not.toContain(SECRET);
  });

  test('C1: mutating the Test Data cell changes nothing downstream', async () => {
    // wrong: the two outputs differ, which would mean the cell IS read — the
    // same claim as above, made where a redaction that merely MASKED the value
    // while still carrying its length or shape would show up.
    const withOne = await everythingTheRunProduces(
      gridOf(sheetRow({ 14: `mail id : a Password : ${SECRET}` })),
    );
    const withAnother = await everythingTheRunProduces(
      gridOf(sheetRow({ 14: 'mail id : b Password : something-entirely-different' })),
    );

    expect(withOne).toBe(withAnother);
  });

  test('C3: no file on the execute path reads a sheet field that could carry one', () => {
    // wrong: a future edit pipes `testData` into a step description, C1 starts
    // failing somewhere far from the change, and this scan would have named the
    // file instead.
    const root = findRepoRoot();
    const EXECUTE_PATH = [
      'packages/shared/src/authored/resolve-authored.ts',
      'packages/shared/src/authored/execute.ts',
      'packages/shared/src/authored/report.ts',
      'packages/execution-engine/src/authored/entry-verifier.ts',
    ];

    const sources = EXECUTE_PATH.map((file) => ({
      file,
      text: readFileSync(path.join(root, file), 'utf8'),
    }));
    // Asserts its own effect: a scan that read nothing would report clean.
    expect(sources.length, 'the execute path list is empty').toBeGreaterThan(0);
    for (const source of sources) {
      expect(source.text.length, `${source.file} read as empty`).toBeGreaterThan(0);
    }

    const offenders = sources.filter((source) => source.text.includes('testData'));
    expect(offenders.map((o) => o.file)).toEqual([]);
  });
});

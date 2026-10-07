import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  test,
  expect,
  captureAccessibilityTree,
  createEntryVerifier,
} from '@aitp/execution-engine';
import {
  executeAuthoredRows,
  findRepoRoot,
  readFinalTestCases,
  readSheetGrid,
  resolveAuthoredRow,
  FINAL_TEST_CASES_SCHEMA,
  type BoundedCapture,
  type EntryControl,
  type ModuleMap,
  type RefusalReason,
  type RowStatus,
} from '@aitp/shared';
import { buildXlsx } from '../support/xlsx-fixture';
import { LoginPage } from './pages/login.page';

/**
 * EVERY EXAMPLE IN `docs/WRITING-STEPS.md` IS RUN (§AG).
 *
 * That document tells a QA how to write a step the framework can execute. The last
 * time this repo put a remedy in a message without running it, the remedy was wrong
 * and read more convincing than the clause it replaced. A page of advice is a much
 * bigger version of the same bet.
 *
 * ## The doc is the source, not a copy of this file
 *
 * The examples are PARSED out of the Markdown — fenced blocks tagged
 * `qa-row <status> [refusal-code]` — and this file has no table of its own. So an
 * example added to the doc is proven or the suite fails, and one that stops being
 * true cannot sit there looking correct. A hand-written list beside a derived set is
 * the §AE shape, and the derived side here is the doc.
 *
 * ## It goes through the REAL reader, resolver and executor
 *
 * Not a hand-built `AuthoredRow`: the sentences are written into a real `.xlsx` with
 * the real 22-column header, read back through `readSheetGrid` + `readFinalTestCases`,
 * resolved against a capture of the live demo app, and executed by the real
 * Playwright executor against that app. Every layer a QA's sheet passes through is in
 * the path, because the advice is about all of them — the column rules are the
 * reader's, the refusals are the resolver's, and `passed` is the executor's.
 *
 * ## Each row gets a fresh context
 *
 * One example clicks "Log out". Sharing a context would make every later row depend
 * on where that one left the browser, and the doc's order would then be dictated by
 * test mechanics rather than by what reads best. A context per row costs a second
 * and removes the coupling.
 */

const ROOT = findRepoRoot();
const DOC = path.join(ROOT, 'docs', 'WRITING-STEPS.md');
const SHEET = FINAL_TEST_CASES_SCHEMA.sheetName;
const COL = FINAL_TEST_CASES_SCHEMA.columns;
const HEADER = FINAL_TEST_CASES_SCHEMA.expectedHeaders.slice();
const MAP_FILE = path.join(ROOT, 'config', 'apps', 'bundled-demo', 'module-map.json');

const MAP: ModuleMap = {
  'Employee registration': {
    route: '/employees',
    provenBy: { role: 'heading', name: 'Register employee' },
  },
};

interface Example {
  /** 1-based index in the doc, so a failure names the block a reader can find. */
  index: number;
  line: number;
  status: RowStatus;
  refusal?: string;
  clauses: Array<{ column: 'given' | 'when' | 'and' | 'then'; text: string }>;
}

/**
 * Parses the doc's `qa-row` blocks.
 *
 * Asserts its own effect in the test below: a parser that silently found nothing
 * would make this whole file vacuous, which is the failure mode a scanner has (§T).
 */
function examplesIn(markdown: string): Example[] {
  const lines = markdown.split(/\r?\n/);
  const found: Example[] = [];
  for (const [i, line] of lines.entries()) {
    const open = /^```qa-row\s+(\S+)(?:\s+(\S+))?\s*$/.exec(line);
    if (!open) continue;
    const clauses: Example['clauses'] = [];
    for (let j = i + 1; j < lines.length && !/^```\s*$/.test(lines[j] ?? ''); j += 1) {
      const clause = /^(Given|When|And|Then):\s*(.+)$/.exec(lines[j] ?? '');
      if (clause) {
        clauses.push({
          column: clause[1]!.toLowerCase() as Example['clauses'][number]['column'],
          text: clause[2]!.trim(),
        });
      }
    }
    found.push({
      index: found.length + 1,
      line: i + 1,
      status: open[1] as RowStatus,
      ...(open[2] ? { refusal: open[2] } : {}),
      clauses,
    });
  }
  return found;
}

/** One row of the workbook, from one parsed example. */
const sheetRow = (example: Example): string[] => {
  const row = Array.from({ length: HEADER.length }, () => '');
  row[COL.module - 1] = 'Employee registration';
  row[COL.scenarioId - 1] = `DOC${String(example.index).padStart(3, '0')}`;
  row[COL.testCaseId - 1] = 'TC_1';
  row[COL.scenarioName - 1] = `doc example at line ${example.line}`;
  row[COL.testType - 1] = 'Functional';
  row[COL.priority - 1] = 'High';
  for (const clause of example.clauses) row[COL[clause.column] - 1] = clause.text;
  return row;
};

test.describe('every example in WRITING-STEPS.md actually behaves that way @demo', () => {
  test.setTimeout(240_000);

  test('the doc-s examples are parsed, and both kinds are present', () => {
    // wrong: the parser matches nothing — a renamed fence, a changed tag — and the
    // test below iterates an empty array, passing while proving nothing. That is the
    // scan-reported-clean failure this repo keeps as a rule, so the subject is
    // asserted before any verdict is.
    const examples = examplesIn(readFileSync(DOC, 'utf8'));

    expect(examples.length, 'no qa-row blocks were parsed out of the doc').toBeGreaterThan(5);
    // BOTH KINDS, or the file below could be satisfied by a framework that only ever
    // passes, or only ever refuses.
    expect(examples.some((e) => e.status === 'passed')).toBe(true);
    expect(examples.some((e) => e.status === 'refused')).toBe(true);
    expect(examples.some((e) => e.status === 'held')).toBe(true);
    // Every example has a Then, which is the doc's own first rule about rows.
    for (const example of examples) {
      expect(
        example.clauses.some((c) => c.column === 'then'),
        `the example at line ${example.line} has no Then`,
      ).toBe(true);
    }
    // And a parser that accepted anything would also match this, so the negative is
    // checked on a planted non-example.
    expect(examplesIn('```qa-rows passed\nThen: x\n```')).toEqual([]);
  });

  test('each example reaches the verdict the doc prints beside it', async ({
    browser,
    makePage,
    page,
    env,
  }) => {
    // wrong: every sentence on that page is an illustration somebody believed. The
    // DMS sheet is 470 rows written against exactly that kind of page, and 0 of them
    // run — so an unproven example here is not a cosmetic risk, it is the whole
    // failure mode repeated at the next layer up.
    const examples = examplesIn(readFileSync(DOC, 'utf8'));
    expect(examples.length).toBeGreaterThan(5);

    // ---- the workbook, through the REAL reader ----
    const workbook = buildXlsx([{ name: SHEET, rows: [HEADER, ...examples.map(sheetRow)] }]);
    const sheet = readFinalTestCases(readSheetGrid(workbook, SHEET));
    expect(sheet.unreadable, 'the fixture workbook did not read cleanly').toEqual([]);
    expect(sheet.rows).toHaveLength(examples.length);

    // ---- the capture, from the live app, in a context of its own ----
    const login = makePage(LoginPage);
    await login.open();
    await login.login(env.users.admin!.username, env.users.admin!.password);
    const capture: BoundedCapture = {
      sessionId: 'writing-steps',
      states: [
        {
          id: 'employees',
          label: 'employees',
          url: page.url(),
          truncated: false,
          nodes: (await captureAccessibilityTree(page, { maxNodes: 400 })).nodes,
        },
      ],
      transitions: [],
      selection: { keywords: [], available: [], chosen: [], excluded: [] },
    };

    const problems: string[] = [];
    for (const [index, example] of examples.entries()) {
      const authored = sheet.rows[index]!;
      const where = `line ${example.line} (${example.clauses.map((c) => c.text).join(' / ')})`;

      const resolved = resolveAuthoredRow(authored, capture, 'employees');

      // A FRESH CONTEXT PER ROW. One example clicks "Log out"; sharing a context
      // would make every later row depend on where that one left the browser.
      const context = await browser.newContext({ baseURL: env.baseUrl });
      const rowPage = await context.newPage();
      try {
        const rowLogin = new LoginPage(rowPage, env, {});
        const entry: EntryControl = {
          moduleOf: () => 'Employee registration',
          verify: createEntryVerifier({
            map: MAP,
            capture,
            mapFile: MAP_FILE,
            page: rowPage,
            signIn: async () => {
              await rowLogin.open();
              await rowLogin.login(env.users.admin!.username, env.users.admin!.password);
            },
          }).verify,
        };

        const run = await executeAuthoredRows({
          resolved: [resolved],
          unreadable: [],
          entry,
          // The REAL executor, against the real page. A stub here would make every
          // `passed` a fact about the stub.
          execute: async ({ step, target }) => {
            if (!target) return { kind: 'no-observable-check', observed: '' };
            const locator = ['StaticText', 'InlineTextBox'].includes(target.role)
              ? rowPage.getByText(target.name, { exact: true })
              : rowPage.getByRole(target.role as Parameters<typeof rowPage.getByRole>[0], {
                  name: target.name,
                  exact: true,
                });
            const count = await locator.count();
            if (step.kind === 'assert' && step.property === 'present' && !step.expected) {
              return count === 0
                ? { kind: 'passed', observed: `no ${target.role} "${target.name}", as asserted` }
                : { kind: 'failed', observed: `${count} found, expected none` };
            }
            if (count === 0) {
              return { kind: 'target-not-on-page', observed: `no ${target.role} "${target.name}"` };
            }
            if (step.kind === 'action') {
              await locator.first().click();
              return { kind: 'passed', observed: `clicked ${target.role} "${target.name}"` };
            }
            if (step.property === 'enabled') {
              const enabled = await locator.first().isEnabled();
              return enabled === step.expected
                ? { kind: 'passed', observed: `enabled=${enabled}` }
                : { kind: 'failed', observed: `enabled=${enabled}` };
            }
            return { kind: 'passed', observed: `${target.role} "${target.name}" present` };
          },
        });

        const result = run.results[0]!;
        if (result.status !== example.status) {
          problems.push(
            `${where}: doc says ${example.status}, run says ${result.status} — ${result.detail}`,
          );
        }
        if (example.refusal) {
          const codes = resolved.refusals.map((r) => r.why as RefusalReason);
          if (!codes.includes(example.refusal as RefusalReason)) {
            problems.push(
              `${where}: doc says refusal "${example.refusal}", run gave [${codes.join(', ')}]`,
            );
          }
        }
      } finally {
        await context.close();
      }
    }

    // ONE failure list rather than a stop at the first, so a doc edit is diagnosed
    // in one run instead of one example at a time.
    expect(problems, problems.join('\n')).toEqual([]);
  });
});

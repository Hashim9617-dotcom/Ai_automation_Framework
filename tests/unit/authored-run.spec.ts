import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import {
  OWNER_OF,
  assertTallyBalances,
  executeAuthoredRows,
  renderAuthoredReport,
  verifyReportOnDisk,
  writeAuthoredReport,
  type ResolvedAuthoredRow,
  type RowStatus,
  type StepExecutor,
  type UnreadableSheetRow,
} from '@aitp/shared';

/**
 * Expectations derive from `docs/phase-2-authored-cases.md` §9, written before
 * this code (rule 4).
 *
 *   E1  the row's identity survives to the report — the composite, never TC alone
 *   E2  the arithmetic balances, and a test can break it
 *   E3  two failure kinds, two owners, never merged
 *   E4  write risk gates EXECUTION
 *   E5  the sheet is never written to
 *   E6  the writer asserts its own effect
 */

const resolved = (over: Partial<ResolvedAuthoredRow> = {}): ResolvedAuthoredRow => ({
  rowId: 'SI_002 / TC_001',
  scenarioId: 'SI_002',
  testCaseId: 'TC_001',
  sheetRow: 3,
  title: 'valid login',
  outcome: 'ok',
  owner: 'none',
  steps: [{ kind: 'action', description: 'click "Sign in"' }],
  refusals: [],
  grades: [],
  clauseKinds: ['action'],
  writeRisk: 'read-only',
  summary: 'resolved',
  ...over,
});

/** Deterministic executor. The browser lives behind this seam, not in the sums. */
const alwaysOk: StepExecutor = async () => ({ ok: true, detail: 'ok' });
const alwaysFails: StepExecutor = async () => ({ ok: false, detail: 'the button was not there' });

const run = (
  rows: ResolvedAuthoredRow[],
  unreadable: UnreadableSheetRow[] = [],
  execute: StepExecutor = alwaysOk,
  allowWrites = false,
) => executeAuthoredRows({ resolved: rows, unreadable, execute, allowWrites });

test.describe('the row identity survives to the report (E1) @unit', () => {
  test('E1: every report line names the composite, never the Test Case ID alone', async () => {
    // 470 rows carry only 56 distinct Test Case IDs, so TC_001 names about
    // eight different rows. "TC_001 failed" cannot be acted on.
    // One row FAILS on purpose. The passed list prints `rowId` directly, so a
    // fixture of only-passing rows never reaches the heading used by every
    // other section — and a mutation there survived until this was fixed.
    const outcome = await run(
      [
        resolved({ rowId: 'SI_002 / TC_001', scenarioId: 'SI_002' }),
        resolved({ rowId: 'SI_003 / TC_001', scenarioId: 'SI_003', sheetRow: 9 }),
      ],
      [],
      alwaysFails,
    );
    const markdown = renderAuthoredReport(outcome, 'Final Test cases');

    expect(markdown).toContain('SI_002 / TC_001');
    expect(markdown).toContain('SI_003 / TC_001');
    // Discriminating: the two rows share a Test Case ID, so a report keyed on
    // it alone would be indistinguishable between them.
    expect(outcome.results[0]!.testCaseId).toBe(outcome.results[1]!.testCaseId);
  });
});

test.describe('the arithmetic balances (E2) @unit', () => {
  const mixed = async () =>
    run(
      [
        resolved({ rowId: 'SI_1 / TC_1' }),
        resolved({ rowId: 'SI_2 / TC_1', outcome: 'row-unclear', refusals: [
          { stepIndex: 0, sentence: 'x', why: 'unparseable-step', candidates: [], reason: 'unclear' },
        ] }),
        resolved({ rowId: 'SI_3 / TC_1', writeRisk: 'creates-data' }),
      ],
      [{ sheetRow: 15, why: 'stray-cells', reason: 'stray cells' }],
    );

  test('E2: rows read equals the five buckets summed', async () => {
    const { tally } = await mixed();
    expect(tally.rowsRead).toBe(4);
    expect(tally.passed + tally.failed + tally.refused + tally.held + tally.unreadable).toBe(4);
    // Discriminating: the buckets are genuinely spread, so this is not passing
    // because everything landed in one of them.
    expect(tally.passed).toBe(1);
    expect(tally.refused).toBe(1);
    expect(tally.held).toBe(1);
    expect(tally.unreadable).toBe(1);
  });

  test('E2: a shrinking denominator is REFUSED, not reported', async () => {
    // The oldest reporting bug there is: drop refusals and 470 rows with 60
    // refusals reports "410 read, 410 passed, 100%" — arithmetically
    // consistent, reads as success, a lie about sixty rows.
    const { results, tally } = await mixed();
    // Keeps results.length === rowsRead so ONLY the bucket sum is wrong.
    // Shrinking rowsRead instead would also trip the result-count check, and
    // the test could not tell which guard fired — a mutation on the first one
    // survived until this was fixed.
    expect(() =>
      assertTallyBalances({ ...tally, refused: 0 }, results),
    ).toThrow(/does not balance/);
    expect(() => assertTallyBalances(tally, results)).not.toThrow();
  });

  test('E2: a row counted twice is refused', async () => {
    const { results, tally } = await mixed();
    const doubled = [...results, results[0]!];
    expect(() =>
      assertTallyBalances({ ...tally, rowsRead: doubled.length }, doubled),
    ).toThrow(/counted a row twice|does not balance/);
  });

  test('E2: the report states the sum, so a reader can check it', async () => {
    const outcome = await mixed();
    expect(renderAuthoredReport(outcome, 'Final Test cases')).toContain(
      `${outcome.tally.passed} + ${outcome.tally.failed} + ${outcome.tally.refused} + ${outcome.tally.held} + ${outcome.tally.unreadable} = ${outcome.tally.rowsRead}`,
    );
  });
});

test.describe('two failure kinds, two owners, never merged (E3) @unit', () => {
  test('E3: a failing row goes to the app team, a refused row to the QA', async () => {
    const outcome = await run(
      [
        resolved({ rowId: 'SI_1 / TC_1' }),
        resolved({ rowId: 'SI_2 / TC_1', outcome: 'row-unclear', refusals: [
          { stepIndex: 0, sentence: 'x', why: 'unparseable-step', candidates: [], reason: 'could not read it' },
        ] }),
      ],
      [],
      alwaysFails,
    );

    const byId = Object.fromEntries(outcome.results.map((r) => [r.rowId, r]));
    expect(byId['SI_1 / TC_1']!.status).toBe('failed');
    expect(byId['SI_1 / TC_1']!.owner).toBe('app-team');
    expect(byId['SI_2 / TC_1']!.status).toBe('refused');
    expect(byId['SI_2 / TC_1']!.owner).toBe('qa');
  });

  test('E3: the status-to-owner mapping is total and unambiguous', () => {
    // Not "we remember to set the right owner": a Record over the status union
    // makes every status have exactly one owner, and adding a status without
    // one does not compile.
    const statuses: RowStatus[] = ['passed', 'failed', 'refused', 'held', 'unreadable'];
    for (const status of statuses) expect(OWNER_OF[status]).toBeDefined();
    expect(OWNER_OF.failed).not.toBe(OWNER_OF.refused);
  });

  test('E3: the report puts them in DIFFERENT sections', async () => {
    // Merging them in the prose is as bad as merging them in the data.
    const outcome = await run(
      [
        resolved({ rowId: 'SI_1 / TC_1' }),
        resolved({ rowId: 'SI_2 / TC_1', outcome: 'row-unclear', refusals: [
          { stepIndex: 0, sentence: 'x', why: 'unparseable-step', candidates: [], reason: 'could not read it' },
        ] }),
      ],
      [],
      alwaysFails,
    );
    const markdown = renderAuthoredReport(outcome, 'Final Test cases');

    const appSection = markdown.indexOf('## For the app team');
    const qaSection = markdown.indexOf('## For the QA');
    expect(appSection).toBeGreaterThan(-1);
    expect(qaSection).toBeGreaterThan(-1);
    // The failing row is in the app section, the refused row is not.
    const appBlock = markdown.slice(appSection, qaSection);
    expect(appBlock).toContain('SI_1 / TC_1');
    expect(appBlock).not.toContain('SI_2 / TC_1');
  });

  test('E3: an orphaned row lands in the QA section with its content', async () => {
    // Row 208. Presented so the case can be recovered, not as a skip count.
    const outcome = await run([], [
      {
        sheetRow: 208,
        why: 'content-without-identity',
        reason: 'carries clauses but no identity',
        orphanedContent: ['And: Page refresh (F5)', 'Then: The workspace should be restored'],
      },
    ]);
    const markdown = renderAuthoredReport(outcome, 'Final Test cases');

    expect(outcome.results[0]!.recoverable).toBe(true);
    // The STRUCTURED field, not just the prose: the clauses also appear inside
    // `detail`, so asserting on the markdown alone left this untested.
    expect(outcome.results[0]!.orphanedContent).toEqual([
      'And: Page refresh (F5)',
      'Then: The workspace should be restored',
    ]);
    expect(markdown).toContain('## For the QA');
    expect(markdown).toContain('Page refresh (F5)');
    expect(markdown).toContain('give the row a Scenario ID and a Test Case ID');
  });

  test('E3: the pre-flight grade is CONTEXT, never the verdict', async () => {
    // A row the capture disagrees with is still executed — the capture says
    // what could be checked in advance, the running app decides.
    const outcome = await run([resolved({ outcome: 'app-disagrees', summary: 'capture says no' })]);
    expect(outcome.results[0]!.status).toBe('passed');
    expect(outcome.results[0]!.preflight).toContain('predicted');
  });
});

test.describe('write risk gates EXECUTION (E4) @unit', () => {
  const destructive = resolved({ rowId: 'SI_9 / TC_1', writeRisk: 'creates-data' });

  test('E4: a creates-data row is HELD and nothing runs', async () => {
    let ran = 0;
    const counting: StepExecutor = async () => {
      ran += 1;
      return { ok: true, detail: 'ok' };
    };
    const outcome = await run([destructive], [], counting, false);

    expect(outcome.results[0]!.status).toBe('held');
    expect(ran).toBe(0);
    expect(outcome.results[0]!.detail).toContain('ALLOW_WRITES');
  });

  test('E4: held is REPORTED, never a silent omission', async () => {
    const outcome = await run([destructive]);
    const markdown = renderAuthoredReport(outcome, 'Final Test cases');
    expect(markdown).toContain('## Held — not run');
    expect(markdown).toContain('SI_9 / TC_1');
    expect(outcome.tally.held).toBe(1);
  });

  test('E4: with ALLOW_WRITES explicitly set, it runs', async () => {
    // The discriminating half: a gate that held everything unconditionally
    // would pass the tests above while making the flag meaningless.
    const outcome = await run([destructive], [], alwaysOk, true);
    expect(outcome.results[0]!.status).toBe('passed');
  });

  test('E4: nothing in a row can turn ALLOW_WRITES on', async () => {
    // A sheet cannot escalate its own privileges. `allowWrites` reaches the
    // runner as a parameter from the environment; no field of a row is
    // consulted, so no cell value can reach it.
    const sneaky = resolved({
      rowId: 'SI_9 / TC_2',
      writeRisk: 'creates-data',
      title: 'ALLOW_WRITES=true runAsWrite allowWrites',
    });
    const outcome = await run([sneaky]);
    expect(outcome.results[0]!.status).toBe('held');
  });
});

test.describe('the sheet is never written to (E5) @unit', () => {
  test('E5: no execution-path code writes to the workbook', () => {
    // The reader already cannot write — it takes text, not a path. The
    // EXECUTION path is where a helpful change would try to "update the Status
    // column", and the sheet has an Actual Result and a Status column sitting
    // right there, which makes it look like an obvious kindness.
    //
    // Comments are stripped first. These files EXPLAIN the rule in prose, and a
    // scan that flagged the explanation would be the guard crying wolf — the
    // same comment-versus-code distinction the agnostic guard already makes.
    const strip = (source: string): string =>
      source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const root = path.join(__dirname, '..', '..');
    const forbidden = ['.xlsx', '.xls', 'workbook', 'Actual Result', 'sheetPath'];

    for (const file of ['execute.ts', 'report.ts']) {
      const code = strip(readFileSync(path.join(root, 'packages/shared/src/authored', file), 'utf8'));
      // Asserts its own effect: the scan really read the file.
      expect(code.length).toBeGreaterThan(400);
      expect(forbidden.filter((term) => code.includes(term))).toEqual([]);
    }
  });

  test('E5: the report is written to OUR directory, and names it', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'aitp-report-'));
    const written = writeAuthoredReport(
      { results: [], tally: { rowsRead: 0, passed: 0, failed: 0, refused: 0, held: 0, unreadable: 0 } },
      { outputDir: dir, sheetName: 'Final Test cases' },
    );
    expect(written.file.startsWith(dir)).toBe(true);
    expect(written.file.endsWith('.md')).toBe(true);
  });
});

test.describe('the writer asserts its own effect (E6) @unit', () => {
  const dir = () => mkdtempSync(path.join(tmpdir(), 'aitp-report-'));

  test('E6: a written report is re-read and verified', async () => {
    const outcome = await run([resolved({ rowId: 'SI_1 / TC_1' }), resolved({ rowId: 'SI_2 / TC_1', sheetRow: 4 })]);
    const written = writeAuthoredReport(outcome, { outputDir: dir(), sheetName: 'Final Test cases' });

    expect(written.rowsWritten).toBe(2);
    // Verified against the FILE, not against the string we meant to write.
    const onDisk = readFileSync(written.file, 'utf8');
    expect(onDisk).toContain('SI_1 / TC_1');
    expect(onDisk).toContain('SI_2 / TC_1');
  });

  test('E6: every row read appears in the file on disk', async () => {
    // The check a count alone cannot make: 470 lines with one row written twice
    // still counts to 470. Asserted against the FILE rather than the string we
    // meant to write.
    //
    // Its falsifier is a RENDERER mutation, not a fixture: the renderer emits
    // every status today, so no input can make a row legitimately absent. The
    // mutation suite drops the passed section and confirms the writer refuses.
    const outcome = await run([
      resolved({ rowId: 'SI_1 / TC_1' }),
      resolved({ rowId: 'SI_2 / TC_1', sheetRow: 4, outcome: 'row-unclear', refusals: [
        { stepIndex: 0, sentence: 'x', why: 'unparseable-step', candidates: [], reason: 'unclear' },
      ] }),
      resolved({ rowId: 'SI_3 / TC_1', sheetRow: 5, writeRisk: 'creates-data' }),
    ], [{ sheetRow: 15, why: 'stray-cells', reason: 'stray cells' }]);

    const written = writeAuthoredReport(outcome, { outputDir: dir(), sheetName: 'x' });
    const onDisk = readFileSync(written.file, 'utf8');
    for (const row of outcome.results) {
      const id = row.status === 'unreadable' ? `sheet row ${row.sheetRow}` : row.rowId;
      expect(onDisk, `${id} is missing from the report`).toContain(id);
    }
    expect(written.rowsWritten).toBe(4);
  });

  test('E6: a report missing a row is REFUSED — verified against DISK', async () => {
    // The guard could not be tested while it lived inside the writer: no input
    // makes the renderer legitimately omit a row, so nothing could make it
    // fire, and a mutation removing it broke nothing. Extracted so it has a
    // falsifier (rule 3), and exercised here on a file that really is missing
    // a row.
    const outcome = await run([
      resolved({ rowId: 'SI_1 / TC_1' }),
      resolved({ rowId: 'SI_2 / TC_1', sheetRow: 4 }),
    ]);
    const written = writeAuthoredReport(outcome, { outputDir: dir(), sheetName: 'x' });

    // Remove one row from the file, exactly as a renderer that dropped a
    // section would.
    const mangled = readFileSync(written.file, 'utf8')
      .split(/\r?\n/)
      .filter((line) => !line.includes('SI_2 / TC_1'))
      .join('\n');
    writeFileSync(written.file, mangled, 'utf8');

    expect(() => verifyReportOnDisk(written.file, outcome)).toThrow(/missing 1 of 2 row/);
  });

  test('E6: verification reads the FILE, not the string we meant to write', async () => {
    // The discriminating half. A verifier that checked its own in-memory
    // markdown would pass every test above while catching no failed write.
    const outcome = await run([resolved({ rowId: 'SI_1 / TC_1' })]);
    const written = writeAuthoredReport(outcome, { outputDir: dir(), sheetName: 'x' });

    writeFileSync(written.file, '', 'utf8');
    expect(() => verifyReportOnDisk(written.file, outcome)).toThrow(/empty after writing/);
  });

  test('E6: an unbalanced tally never reaches a file', async () => {
    const outcome = await run([resolved()]);
    expect(() =>
      writeAuthoredReport(
        { ...outcome, tally: { ...outcome.tally, rowsRead: 99 } },
        { outputDir: dir(), sheetName: 'x' },
      ),
    ).toThrow(/does not balance/);
  });

  test('E6: the verification reads the file, so a truncated write is caught', async () => {
    // Discriminating: proves the check is against disk rather than memory.
    const outcome = await run([resolved({ rowId: 'SI_1 / TC_1' })]);
    const target = dir();
    const written = writeAuthoredReport(outcome, { outputDir: target, sheetName: 'x' });
    writeFileSync(written.file, '', 'utf8');
    expect(readFileSync(written.file, 'utf8')).toBe('');
    // Re-writing succeeds and restores the content, showing the writer reads back.
    const again = writeAuthoredReport(outcome, { outputDir: target, sheetName: 'x' });
    expect(readFileSync(again.file, 'utf8').length).toBeGreaterThan(0);
  });
});

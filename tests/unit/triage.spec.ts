import { test, expect } from '@playwright/test';
import { triageSheet, renderTriage, looksLikeAccessibleName, extractTarget, type AuthoredRow } from '@aitp/shared';

/**
 * Sheet triage (T) and the target plausibility check (P).
 *
 * `docs/phase-2-authored-cases.md` §14. The deliverable is not only the rows a
 * run executes — it is telling the QA, row by row and with a reason, which rows
 * can NEVER be automated and what a human should do about each.
 */

const rowOf = (
  rowId: string,
  module: string,
  clauses: AuthoredRow['clauses'],
): AuthoredRow => ({
  rowId, scenarioId: rowId.split(' / ')[0]!, testCaseId: rowId.split(' / ')[1]!,
  sheetRow: 3, module, feature: 'f', scenarioName: rowId, objective: '',
  testType: 'Functional', priority: 'High', preconditions: '', testData: '', type: 'Positive',
  clauses,
});

const CAPTURED = new Set(['Dashboard']);

test.describe('a target must look like a NAME, not a sentence (P) @unit', () => {
  test('P: a sliced sentence is not a target', () => {
    // wrong: letting it through counts the clause as PARSED, so wall 1 looks
    // smaller than it is, and a confident wrong target reaches the resolver and
    // fails there instead of being classified honestly here.
    expect(
      extractTarget(
        'when checking with the user for all the selected options only the view options should be available',
      ),
    ).toBeUndefined();
  });

  test('P: a real label still parses', () => {
    // wrong: a check that rejected everything would pass the test above while
    // making every clause unresolvable — the refuses-everything failure again.
    expect(extractTarget('verify \"Save\" is visible')).toBe('Save');
    expect(extractTarget('Menu visible')).toBe('Menu');
  });

  test('P: a QUOTED name is trusted whatever its shape', () => {
    // wrong: applying the word limit to quoted names rejects real composite
    // labels — this application really does have a button named like this, and
    // the QA typed the quotes deliberately.
    const long = 'Go to location PDF Devendra file_2 (2).pdf Updated 27/08/2026';
    expect(extractTarget(`click "${long}"`)).toBe(long);
    // Discriminating: the SAME string unquoted is rejected, so the exemption is
    // doing the work rather than the check being inert.
    expect(looksLikeAccessibleName(long)).toBe(false);
  });

  test('P: sentence structure disqualifies even a short phrase', () => {
    // wrong: counting words alone lets "then the list, updated" through, which
    // is punctuation and a connective — a clause, not a label.
    expect(looksLikeAccessibleName('then the list')).toBe(false);
    expect(looksLikeAccessibleName('the list, updated')).toBe(false);
    expect(looksLikeAccessibleName('Employee directory')).toBe(true);
  });
});

test.describe('sheet triage names the reason and the action (T) @unit', () => {
  test('T: a module with no capture is OUR gap, not the row-s', () => {
    // wrong: judged on its clauses, a perfectly good row in an uncaptured
    // module is blamed on the QA for evidence we never gathered.
    const triage = triageSheet(
      [rowOf('SI_1 / TC_1', 'Workflow', [
        { text: 'click the "Approve" button', source: 'when', kind: 'action' },
        { text: 'verify "Approved" is visible', source: 'then', kind: 'assert' },
      ])],
      CAPTURED,
    );
    expect(triage.rows[0]!.reason).toBe('no-capture-for-module');
    expect(triage.missingCaptures[0]).toEqual({ module: 'Workflow', rows: 1 });
  });

  test('T: an outcome clause is OUR work to build, not the QA-s to rewrite', () => {
    // wrong: filed as too-vague, a buildable page-assertion row is sent back to
    // its author to rewrite, and the same row comes back unchanged.
    const triage = triageSheet(
      [rowOf('SI_2 / TC_1', 'Dashboard', [
        { text: 'click the "Save" button', source: 'when', kind: 'action' },
        { text: 'the record should be created successfully', source: 'then', kind: 'assert' },
      ])],
      CAPTURED,
    );
    expect(triage.rows[0]!.reason).toBe('outcome-not-element');
  });

  test('T: a vague clause is the QA-s to rewrite', () => {
    // wrong: filed as an outcome, it joins a buildable backlog and waits for
    // work that could never make it verifiable.
    const triage = triageSheet(
      [rowOf('SI_3 / TC_1', 'Dashboard', [
        { text: 'the ui should show a colour change proper response and animations', source: 'then', kind: 'assert' },
      ])],
      CAPTURED,
    );
    expect(triage.rows[0]!.reason).toBe('too-vague-to-verify');
  });

  test('T: a row that can be PERFORMED but not VERIFIED is not automatable', () => {
    // wrong: counting any resolvable clause flatters the ceiling — this row
    // clicks fine and proves nothing, and the run already refuses it at
    // execution as `no-observable-check`. Promising it here then refusing it
    // there is the worst of both.
    const triage = triageSheet(
      [rowOf('SI_4 / TC_1', 'Dashboard', [
        { text: 'click the "Save" button', source: 'when', kind: 'action' },
        { text: 'everything should look proper', source: 'then', kind: 'assert' },
      ])],
      CAPTURED,
    );
    expect(triage.rows[0]!.reason).not.toBe('automatable');
  });

  test('T: a row with a resolvable assertion IS automatable', () => {
    // wrong: a triage that never returns automatable makes the ceiling 0% and
    // is satisfied by knowing nothing — the refuses-everything failure, one
    // layer up. This is the fixture that tells the two apart.
    const triage = triageSheet(
      [rowOf('SI_5 / TC_1', 'Dashboard', [
        { text: 'click the "Save" button', source: 'when', kind: 'action' },
        { text: 'verify "Employee directory" is visible', source: 'then', kind: 'assert' },
      ])],
      CAPTURED,
    );
    expect(triage.rows[0]!.reason).toBe('automatable');
    expect(triage.ceiling.withCurrentCaptures).toBe(1);
  });

  test('T: a GIVEN clause is never the evidence that condemns a row', () => {
    // wrong: counted as evidence, the Given decides the reason — this row would
    // be filed as "describes an outcome" on the strength of "user on the
    // dashboard", which is a precondition, and sent to the wrong backlog.
    //
    // Discriminating on purpose: the Given is outcome-shaped and the remaining
    // clause is NOT, so including it changes the verdict rather than merely
    // adding to a list. An earlier fixture paired a Given with a resolvable
    // Then, where including it changed nothing at all — and the mutation duly
    // survived.
    const triage = triageSheet(
      [rowOf('SI_6 / TC_1', 'Dashboard', [
        { text: 'user on the dashboard', source: 'given', kind: 'action' },
        { text: 'do the needful', source: 'when', kind: 'action' },
      ])],
      CAPTURED,
    );
    expect(triage.rows[0]!.reason).toBe('too-vague-to-verify');
    expect(triage.rows[0]!.evidence).not.toContain('user on the dashboard');
  });

  test('T: the report states the ceiling and each reason-s action', () => {
    // wrong: a section listing counts without the action leaves three different
    // audiences reading one list none of them can act on.
    const triage = triageSheet(
      [
        rowOf('SI_7 / TC_1', 'Workflow', [{ text: 'x', source: 'then', kind: 'assert' }]),
        rowOf('SI_8 / TC_1', 'Dashboard', [
          { text: 'verify "Employee directory" is visible', source: 'then', kind: 'assert' },
        ]),
      ],
      CAPTURED,
    );
    const markdown = renderTriage(triage);
    expect(markdown).toContain('50.0%');
    expect(markdown).toContain('pnpm inspect');
    expect(markdown).toContain('the row needs rewriting');
    expect(markdown).toContain('Capture worklist');
  });
});

/**
 * T6 — the ceiling never travels alone.
 *
 * 29.8% was measured with 8 of 17 modules captured, and "no capture for this
 * module" is one of the three exclusion reasons. So it is not the ceiling of
 * the approach — it is the ceiling of today's capture coverage, and quoted
 * alone it becomes "the platform can only do 30% of our tests" long after the
 * captures are done.
 *
 * The qualifier is therefore welded to the number at the point of measurement:
 * both figures computed, each carrying the coverage it assumed.
 */
test.describe('the ceiling carries its own assumptions (T6) @unit', () => {
  const rows = [
    // Automatable on its clauses, but its module has never been captured.
    rowOf('SI_1 / TC_1', 'Workflow', [
      { text: 'click the "Save" button', source: 'when', kind: 'action' },
      { text: 'verify "Employee directory" is visible', source: 'then', kind: 'assert' },
    ]),
    // Automatable and captured.
    rowOf('SI_2 / TC_1', 'Dashboard', [
      { text: 'click the "Save" button', source: 'when', kind: 'action' },
      { text: 'verify "Employee directory" is visible', source: 'then', kind: 'assert' },
    ]),
  ];

  test('T6: the two ceilings differ exactly by what a capture would unblock', () => {
    // wrong: one number alone reads as the ceiling of the APPROACH, when it is
    // the ceiling of today's coverage — and the difference here is a whole row.
    const triage = triageSheet(rows, CAPTURED);

    expect(triage.ceiling.withCurrentCaptures).toBe(0.5);
    expect(triage.ceiling.withAllModulesCaptured).toBe(1);
    // Discriminating: the two are NOT equal on this fixture, so a result that
    // simply reported the same figure twice would fail here.
    expect(triage.ceiling.withAllModulesCaptured).toBeGreaterThan(
      triage.ceiling.withCurrentCaptures,
    );
  });

  test('T6: each number carries the coverage it was measured with', () => {
    // wrong: without the counts, a reader cannot tell whether 30% was measured
    // over two modules or twenty, and the figure outlives its assumptions.
    const triage = triageSheet(rows, CAPTURED);
    expect(triage.ceiling.modulesCaptured).toBe(1);
    expect(triage.ceiling.modulesTotal).toBe(2);
    expect(triage.ceiling.rowsBlockedByMissingCapture).toBe(1);
  });

  test('T6: the report prints BOTH, so neither can be quoted alone', () => {
    // wrong: printing only today's figure is how 96.5% survived two reports —
    // a single number in a summary, with its qualifier in the prose around it.
    const markdown = renderTriage(triageSheet(rows, CAPTURED));
    expect(markdown).toContain("With today's captures");
    expect(markdown).toContain('Once every module is captured');
    expect(markdown).toContain('1 of 2 modules captured');
    expect(markdown).toContain('not the ceiling of this approach');
  });

  test('T6: a row that is unautomatable ANYWAY is not counted as unblockable', () => {
    // wrong: crediting every uncaptured row to the second ceiling promises a
    // capture will fix rows whose clauses could never be verified, and the
    // delta measurement afterwards would then look like a failure.
    const triage = triageSheet(
      [rowOf('SI_3 / TC_1', 'Workflow', [
        { text: 'everything should look proper', source: 'then', kind: 'assert' },
      ])],
      CAPTURED,
    );
    expect(triage.ceiling.withCurrentCaptures).toBe(0);
    expect(triage.ceiling.withAllModulesCaptured).toBe(0);
  });
});

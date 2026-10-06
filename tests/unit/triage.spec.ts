import { test, expect } from '@playwright/test';
import {
  triageSheet,
  TRIAGE_OWNER,
  renderTriage,
  looksLikeAccessibleName,
  extractTarget,
  resolveAuthoredRow,
  executeAuthoredRows,
  type EntryControl,
  type StepExecutor,
  type AccessibilityNode,
  type AuthoredRow,
  type BoundedCapture,
  type CapturedState,
  type TriageInputs,
} from '@aitp/shared';

/**
 * Sheet triage (T) and the target plausibility check (P).
 *
 * `docs/phase-2-authored-cases.md` §14. The deliverable is not only the rows a
 * run executes — it is telling the QA, row by row and with a reason, which rows
 * can NEVER be automated and what a human should do about each.
 */

const rowOf = (rowId: string, module: string, clauses: AuthoredRow['clauses']): AuthoredRow => ({
  rowId,
  scenarioId: rowId.split(' / ')[0]!,
  testCaseId: rowId.split(' / ')[1]!,
  sheetRow: 3,
  module,
  feature: 'f',
  scenarioName: rowId,
  objective: '',
  testType: 'Functional',
  priority: 'High',
  preconditions: '',
  testData: '',
  type: 'Positive',
  clauses,
});

/**
 * THE CAPTURE IS NOW PART OF THE FIXTURE (B1).
 *
 * Triage used to be handed module NAMES — `new Set(['Dashboard'])` — and decided
 * `automatable` from its own clause rules. It is now a projection of
 * `resolveAuthoredRow`, so every test here has to supply the thing the resolver
 * resolves against. That is not incidental: the bug this replaced was triage
 * answering a question it could not see the evidence for.
 */
const node = (role: string, name: string): AccessibilityNode => ({ role, name, enabled: true });

const DASHBOARD: CapturedState = {
  id: 'dashboard',
  label: 'dashboard',
  url: 'https://app.example/dashboard',
  nodes: [
    node('button', 'Save'),
    node('link', 'Reports'),
    node('heading', 'Employee directory'),
    // TWO nodes with one name, so an ambiguity fixture exists that the collapse
    // rule cannot flatten: two BUTTONS, not a control and its own text.
    node('button', 'Edit'),
    node('button', 'Edit'),
  ],
  truncated: false,
};

const CAPTURE: BoundedCapture = {
  sessionId: 's',
  states: [DASHBOARD],
  transitions: [],
  selection: { keywords: [], available: [], chosen: [], excluded: [] },
};

/** `Dashboard` is captured; `Workflow` deliberately is not. */
const CAPTURED: TriageInputs = {
  capture: CAPTURE,
  entryStateOf: new Map([['Dashboard', 'dashboard']]),
};

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
    expect(extractTarget('verify "Save" is visible')).toBe('Save');
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
      [
        rowOf('SI_1 / TC_1', 'Workflow', [
          { text: 'click the "Approve" button', source: 'when', kind: 'action' },
          { text: 'verify "Approved" is visible', source: 'then', kind: 'assert' },
        ]),
      ],
      CAPTURED,
    );
    expect(triage.rows[0]!.reason).toBe('no-capture-for-module');
    expect(triage.missingCaptures[0]).toEqual({ module: 'Workflow', rows: 1 });
  });

  /**
   * WHAT B1 COST, RECORDED AS A TEST RATHER THAN LEFT AS A DIFF.
   *
   * These were two tests asserting two different reasons, and the distinction was
   * real: `outcome-not-element` was OURS (owner platform — a page/state assertion
   * is buildable) and `too-vague-to-verify` was the QA's (the row needs rewriting).
   * Both were decided by shape patterns triage owned.
   *
   * Triage has no clause rules of its own now, so both labels are gone. B1 reported
   * something worse than the merge it expected — **neither row was flagged at all**,
   * because an ASSERT clause whose target is in no captured node was not refused:
   * `resolveAuthoredRow` pushed a step with `role: 'generic'` and no target, and
   * `extractTarget` slices `record` out of *"the record should be created
   * successfully"* and `ui` out of *"the ui should show a colour change…"* (§13.4).
   *
   * **C1 closed that**, and this test moved with it: an unquoted target matching no
   * captured node is now refused `no-readable-target`. So the merge B1 predicted has
   * actually happened, one commit late, and both rows are flagged again.
   *
   * What is still LOST is the distinction, and it is the point of keeping this test:
   * `outcome-not-element` was owned by the PLATFORM (a page/state assertion is
   * buildable) and `too-vague-to-verify` by the QA. Both are now `no-readable-target`,
   * owner qa — so on the real workbook ~36 rows moved from "the platform should build
   * page/state assertions" to "the QA should quote a control", which is the worse
   * diagnosis for them. Restoring it is a refinement of an already-refused row's
   * LABEL and carries no drift risk: nothing about `automatable` would depend on it.
   */
  test('T: an outcome clause and a vague clause now share one reason, and that is a LOSS', () => {
    // wrong: asserting only the new reason for one of them, and deleting the other
    // test, would hide the merge entirely — the suite would read as though the
    // platform had never distinguished these two audiences.
    const outcome = triageSheet(
      [
        rowOf('SI_2 / TC_1', 'Dashboard', [
          { text: 'click the "Save" button', source: 'when', kind: 'action' },
          { text: 'the record should be created successfully', source: 'then', kind: 'assert' },
        ]),
      ],
      CAPTURED,
    );
    const vague = triageSheet(
      [
        rowOf('SI_3 / TC_1', 'Dashboard', [
          { text: 'click the "Reports" link', source: 'when', kind: 'action' },
          {
            text: 'the ui should show a colour change proper response and animations',
            source: 'then',
            kind: 'assert',
          },
        ]),
      ],
      CAPTURED,
    );

    // Both flagged again since C1, and both with the SAME reason and the SAME owner
    // — which is the loss this test exists to record.
    expect(outcome.rows[0]!.reason).toBe('no-readable-target');
    expect(vague.rows[0]!.reason).toBe('no-readable-target');
    expect(outcome.rows[0]!.reason).toBe(vague.rows[0]!.reason);
    expect(TRIAGE_OWNER[outcome.rows[0]!.reason]).toBe('qa');

    // AND THE CAUSE, asserted so this test names a mechanism rather than a mood:
    // the resolver read a plausible name out of both sentences, and neither is in
    // the capture. That is WHY they are refused, and why the two cannot be told
    // apart without a rule nobody has written yet.
    expect(extractTarget('the record should be created successfully')).toBe('record');
    expect(extractTarget('the ui should show a colour change proper response and animations')).toBe(
      'ui',
    );
    expect(DASHBOARD.nodes.map((n) => n.name)).not.toContain('record');
    expect(DASHBOARD.nodes.map((n) => n.name)).not.toContain('ui');
  });

  test('T: a row that can be PERFORMED but not VERIFIED is not automatable', () => {
    // wrong: counting any resolvable clause flatters the ceiling — this row
    // clicks fine and proves nothing, and the run already refuses it at
    // execution as `no-observable-check`. Promising it here then refusing it
    // there is the worst of both.
    const triage = triageSheet(
      [
        rowOf('SI_4 / TC_1', 'Dashboard', [
          { text: 'click the "Save" button', source: 'when', kind: 'action' },
          { text: 'everything should look proper', source: 'then', kind: 'assert' },
        ]),
      ],
      CAPTURED,
    );
    expect(triage.rows[0]!.reason).not.toBe('automatable');
  });

  test('T: a row with a resolvable assertion IS automatable', () => {
    // wrong: a triage that never returns automatable makes the ceiling 0% and
    // is satisfied by knowing nothing — the refuses-everything failure, one
    // layer up. This is the fixture that tells the two apart.
    //
    // `"Reports"`, not `"Save"`: this fixture used to click Save, and under a
    // resolve-based verdict that row is HELD, because `sav(e|ing)` is a write word.
    // The old triage could not see the write gate at all, so the change of control
    // is the fixture catching up with what the verdict now includes.
    const triage = triageSheet(
      [
        rowOf('SI_5 / TC_1', 'Dashboard', [
          { text: 'click the "Reports" link', source: 'when', kind: 'action' },
          { text: 'verify "Employee directory" is visible', source: 'then', kind: 'assert' },
        ]),
      ],
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
      [
        rowOf('SI_6 / TC_1', 'Dashboard', [
          { text: 'user on the dashboard', source: 'given', kind: 'action' },
          { text: 'do the needful', source: 'when', kind: 'action' },
        ]),
      ],
      CAPTURED,
    );
    expect(triage.rows[0]!.reason).toBe('no-readable-action');
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
    // ONE REMEDY PER REASON, both asserted. The table is derived from
    // `REASON_REMEDY` now, so a reason counted with no action printed is a compile
    // error — but that only holds if something checks that the remedies ARRIVE.
    expect(markdown).toContain('pnpm inspect');
    expect(markdown).toContain('these are the rows a run executes');
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
      { text: 'click the "Reports" link', source: 'when', kind: 'action' },
      { text: 'verify "Employee directory" is visible', source: 'then', kind: 'assert' },
    ]),
    // Automatable and captured.
    rowOf('SI_2 / TC_1', 'Dashboard', [
      { text: 'click the "Reports" link', source: 'when', kind: 'action' },
      { text: 'verify "Employee directory" is visible', source: 'then', kind: 'assert' },
    ]),
  ];

  test('T6: the second ceiling is WITHHELD, not guessed, while a module is uncaptured', () => {
    // wrong: a `0` here reads as "the ceiling stays at nothing even with every
    // screen captured" — a claim nobody has measured — and it is the exact shape
    // this repo has corrected three times: a failure reported as an empty result.
    //
    // THIS EXPECTATION MOVED BY DECISION, not because a run disagreed. The second
    // ceiling was a MEASUREMENT only because both numbers ran the same clause rules
    // over the same clauses. `automatable` is now the resolver's verdict, which
    // needs a captured state, and the rows this figure is about have none. Keeping
    // the old rules for it would present two figures taken with different
    // instruments as a comparison of capture coverage.
    const triage = triageSheet(rows, CAPTURED);

    expect(triage.ceiling.withCurrentCaptures).toBe(0.5);
    expect(triage.ceiling.withAllModulesCaptured).toBeNull();
    expect(triage.ceiling.withAllModulesCapturedWhy).toContain('not measurable');
    expect(triage.ceiling.withAllModulesCapturedWhy).toContain('1 rows have no capture');
  });

  test('T6: with EVERY module captured it is a number again, and the reason goes away', () => {
    // wrong: a field hard-wired to null would pass the test above and make the
    // second ceiling permanently unavailable — the refuses-everything failure
    // applied to a measurement. This is the only fixture that tells the two apart.
    const everything: TriageInputs = {
      capture: CAPTURE,
      entryStateOf: new Map([
        ['Dashboard', 'dashboard'],
        ['Workflow', 'dashboard'],
      ]),
    };
    const triage = triageSheet(rows, everything);

    expect(triage.ceiling.withCurrentCaptures).toBe(1);
    expect(triage.ceiling.withAllModulesCaptured).toBe(1);
    // And no explanation, because there is nothing to explain. A sentence beside a
    // number that exists is how a reader learns to ignore both.
    expect(triage.ceiling.withAllModulesCapturedWhy).toBeNull();
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
    // "sheet module keys", not "modules": the count is over the sheet's Module
    // column as written, where two keys can name one screen and casing makes
    // `User Role` and `user role` two. The COUNT is unchanged — only the noun
    // that says what it counts.
    expect(markdown).toContain('1 of 2 sheet module keys captured');
    expect(markdown).toContain('not the ceiling of this approach');
    // The withheld number is printed as WORDS, so the row cannot be mistaken for a
    // missing one — and the paragraph says why it is withheld rather than zero.
    expect(markdown).toContain('not measurable');
    expect(markdown).toContain('used to be a measurement and is now withheld');
    expect(markdown).not.toContain('Once every module is captured** | **0.0%');
  });
});

/**
 * B1 — `automatable` IS what the run executes, or the word is a lie.
 *
 * Measured on the real workbook at the moment this was found: triage reported 27
 * automatable rows beside the rendered sentence *"these are the rows a run
 * executes"*, and the run executed **none** of them — 18 held, 9 refused.
 *
 * Both numbers were produced from the same imports. They shared `actionCapability`
 * and `columnVerbConflict` precisely so they could not drift on a VERB, and they
 * drifted on everything else: triage never asked whether the named element is in
 * the capture, and never applied the whole-row rule.
 *
 * So the fix is not a better rule. It is having ONE rule — triage reads the
 * resolver's verdict — and these tests are about that agreement rather than about
 * any particular classification.
 */
test.describe('triage reports the run-s verdict, not its own (B1) @unit', () => {
  const READ_ONLY_ROW = rowOf('SI_A / TC_1', 'Dashboard', [
    { text: 'click the "Reports" link', source: 'when', kind: 'action' },
    { text: 'verify "Employee directory" is visible', source: 'then', kind: 'assert' },
  ]);

  test('B1a: a row whose every clause resolves against the capture is automatable', () => {
    // wrong: a triage answering from clause text alone says automatable here AND
    // for B1b, whose target is not in the capture at all — which is exactly the
    // 27-versus-0 divergence this replaced.
    const triage = triageSheet([READ_ONLY_ROW], CAPTURED);
    expect(triage.rows[0]!.reason).toBe('automatable');
    expect(triage.rows[0]!.evidence).toContain('resolved against "dashboard"');
  });

  test('B1b: the SAME row is not automatable when the element is not in the capture', () => {
    // wrong: this is the silent half, and the only fixture that can tell a
    // resolve-based verdict from a text-based one. The clauses are identical; only
    // the capture differs — so a triage reading text gives the same answer twice,
    // passes B1a, and is wrong about every real sheet.
    const thin: TriageInputs = {
      capture: { ...CAPTURE, states: [{ ...DASHBOARD, nodes: [node('button', 'Save')] }] },
      entryStateOf: new Map([['Dashboard', 'dashboard']]),
    };
    const triage = triageSheet([READ_ONLY_ROW], thin);

    expect(triage.rows[0]!.reason).toBe('no-capture-for-element');
    expect(triage.ceiling.withCurrentCaptures).toBe(0);
  });

  test('B1c: ONE refused clause disqualifies the whole row, however many resolve', () => {
    // wrong: counting a row on its resolvable clauses is how 254 steps on the real
    // sheet belonged to rows the run then refused in full. A row is all or nothing,
    // because half a row that goes green is a false pass.
    const triage = triageSheet(
      [
        rowOf('SI_B / TC_1', 'Dashboard', [
          { text: 'click the "Reports" link', source: 'when', kind: 'action' },
          { text: 'verify "Employee directory" is visible', source: 'then', kind: 'assert' },
          { text: 'do the needful', source: 'when', kind: 'action' },
        ]),
      ],
      CAPTURED,
    );
    expect(triage.rows[0]!.reason).toBe('no-readable-action');
    expect(triage.counts.automatable).toBe(0);
  });

  test('B1c: the same three clauses, all resolvable, ARE automatable', () => {
    // wrong: a whole-row rule implemented as "never automatable above two clauses"
    // would pass the test above. This is the case it must not refuse.
    const triage = triageSheet(
      [
        rowOf('SI_B / TC_2', 'Dashboard', [
          { text: 'click the "Reports" link', source: 'when', kind: 'action' },
          { text: 'verify "Employee directory" is visible', source: 'then', kind: 'assert' },
          { text: 'verify "Reports" is visible', source: 'then', kind: 'assert' },
        ]),
      ],
      CAPTURED,
    );
    expect(triage.rows[0]!.reason).toBe('automatable');
  });

  test('B1d: a row held by the write gate is its OWN answer — not automatable, not an obstacle', () => {
    // wrong: folded into `automatable` it overstates what a run does, so the number
    // stops equalling the executed rows and the whole agreement is gone. Folded
    // into the obstacles it sends a QA to fix a row that is already correct.
    const triage = triageSheet(
      [
        rowOf('SI_C / TC_1', 'Dashboard', [
          { text: 'click the "Save" button', source: 'when', kind: 'action' },
          { text: 'verify "Employee directory" is visible', source: 'then', kind: 'assert' },
        ]),
      ],
      CAPTURED,
    );
    expect(triage.rows[0]!.reason).toBe('automatable-but-held');
    expect(triage.counts.automatable).toBe(0);
    expect(triage.counts['automatable-but-held']).toBe(1);
    expect(triage.ceiling.withCurrentCaptures).toBe(0);
  });

  test('B1e: triage-s automatable SET equals the set the executor runs', async () => {
    // wrong: with two implementations of one question, a SET comparison is the only
    // thing that notices when they part. Every per-row test passed throughout the
    // 27-versus-0 divergence, because each was right about its own row.
    const rows = [
      READ_ONLY_ROW,
      rowOf('SI_D / TC_1', 'Dashboard', [
        { text: 'click the "Save" button', source: 'when', kind: 'action' },
        { text: 'verify "Employee directory" is visible', source: 'then', kind: 'assert' },
      ]),
      rowOf('SI_D / TC_2', 'Dashboard', [
        { text: 'click the "Reports" link', source: 'when', kind: 'action' },
        { text: 'do the needful', source: 'when', kind: 'action' },
      ]),
      rowOf('SI_D / TC_3', 'Dashboard', [
        { text: 'click the "Nonexistent" link', source: 'when', kind: 'action' },
      ]),
      rowOf('SI_D / TC_4', 'Dashboard', [
        { text: 'click the "Edit" button', source: 'when', kind: 'action' },
      ]),
      rowOf('SI_D / TC_5', 'Workflow', [
        { text: 'click the "Reports" link', source: 'when', kind: 'action' },
      ]),
    ];

    const saysAutomatable = triageSheet(rows, CAPTURED)
      .rows.filter((row) => row.reason === 'automatable')
      .map((row) => row.rowId)
      .sort();

    // The other side, from the resolver itself rather than from a second opinion
    // about it: `executeAuthoredRows` reaches a step only past `row-unclear` and
    // past the write gate, which is exactly the filter below.
    const executorWouldRun = rows
      .filter((row) => CAPTURED.entryStateOf.has(row.module))
      .map((row) => resolveAuthoredRow(row, CAPTURE, CAPTURED.entryStateOf.get(row.module)!))
      .filter(
        (resolved) =>
          resolved.refusals.length === 0 &&
          resolved.steps.length > 0 &&
          resolved.writeRisk !== 'creates-data',
      )
      .map((resolved) => resolved.rowId)
      .sort();

    expect(saysAutomatable).toEqual(executorWouldRun);
    // And the fixture DISCRIMINATES: neither empty nor everything, so an
    // implementation that agreed by returning nothing — or everything — fails.
    expect(saysAutomatable).toEqual(['SI_A / TC_1']);
    expect(saysAutomatable.length).toBeLessThan(rows.length);

    /**
     * AND THE SAME COMPARISON AT EXECUTION LEVEL (C1).
     *
     * The filter above is the resolve-level condition, and that is how a hole got
     * through: a row whose assert target was in no captured node satisfied every
     * clause of it — no refusals, steps present, read-only — and the run refused it
     * anyway, at execution, for having no target to check. This comparison is the
     * one that would have caught it, and it has to run the rows to make it.
     *
     * The executor is the most permissive one there is, deliberately: anything it
     * declines to run has been declined by the engine.
     */
    const ran: string[] = [];
    const permissive: StepExecutor = async () => ({
      kind: 'passed',
      observed: 'the stub says it was there',
    });
    const entry: EntryControl = {
      moduleOf: () => 'Dashboard',
      verify: async () => ({ verified: true }),
    };
    const run = await executeAuthoredRows({
      runId: 'run_b1e',
      resolved: rows
        .filter((row) => CAPTURED.entryStateOf.has(row.module))
        .map((row) => resolveAuthoredRow(row, CAPTURE, CAPTURED.entryStateOf.get(row.module)!)),
      unreadable: [],
      entry,
      execute: permissive,
    });
    for (const result of run.results) if (result.status === 'passed') ran.push(result.rowId);

    expect(ran.sort()).toEqual(saysAutomatable);
  });

  test('B1f: a module absent from the entry-state map is no-capture, whatever its clauses', () => {
    // wrong: triage used to be handed module NAMES while the run computed its own
    // blocked set, so a module that was mapped but UNPROVABLE counted as captured
    // here and was refused upfront there. The map's keys are the single source now,
    // so the two cannot disagree about which screens exist.
    const triage = triageSheet([rowOf('SI_E / TC_1', 'Workflow', READ_ONLY_ROW.clauses)], CAPTURED);
    expect(triage.rows[0]!.reason).toBe('no-capture-for-module');
    expect(triage.missingCaptures).toEqual([{ module: 'Workflow', rows: 1 }]);
  });
});

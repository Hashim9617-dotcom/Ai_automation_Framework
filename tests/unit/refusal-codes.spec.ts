import { test, expect } from '@playwright/test';
import {
  REFUSAL_OWNER,
  refusalOwners,
  resolveAuthoredRow,
  type AccessibilityNode,
  type AuthoredRow,
  type BoundedCapture,
  type CapturedState,
  type RefusalReason,
} from '@aitp/shared';

/**
 * ONE CODE WAS THREE FAULTS WITH THREE OWNERS (B3).
 *
 * Measured on the real workbook before this split: 394 refusals wore
 * `unparseable-step`, and they were **147** clauses the sheet never labelled,
 * **129** action clauses no action could be read out of, and **118** clauses naming
 * no element. A QA reading that list could not tell which of three completely
 * different things to do — add a column, wait for us, or quote a control.
 *
 * Expectations come from the measurement, not from the implementation: the counts
 * above were taken by an independent walk of the clauses whose total (34+22+21 on
 * the 59-row cut, 77) matched the run's own refusal count exactly.
 *
 * ## Why each test carries its silent half
 *
 * A code that fires on everything is as useless as one that never fires, and the
 * three live within a few lines of each other in one gate chain — so the assertion
 * that matters is not "this fixture produces code X", it is **"this fixture
 * produces X and NOT the other two"**. That is the half a drifted gate order would
 * break, and the half no amount of reading the chain would catch (§W).
 */

const node = (role: string, name: string): AccessibilityNode => ({ role, name, enabled: true });

const state = (id: string, nodes: AccessibilityNode[]): CapturedState => ({
  id,
  label: id,
  url: `https://app.example/${id}`,
  nodes,
  truncated: false,
});

const CAPTURE: BoundedCapture = {
  sessionId: 's',
  states: [state('home', [node('button', 'Save'), node('button', 'Sign in')])],
  transitions: [],
  selection: { keywords: [], available: [], chosen: [], excluded: [] },
};

const rowOf = (clauses: AuthoredRow['clauses']): AuthoredRow => ({
  rowId: 'SI_001 / TC_001',
  scenarioId: 'SI_001',
  testCaseId: 'TC_001',
  sheetRow: 3,
  module: 'Home',
  feature: 'f',
  scenarioName: 's',
  objective: 'o',
  testType: 'Functional',
  priority: 'High',
  preconditions: '',
  testData: '',
  type: 'Positive',
  clauses,
});

const codesFor = (clauses: AuthoredRow['clauses']): RefusalReason[] =>
  resolveAuthoredRow(rowOf(clauses), CAPTURE, 'home').refusals.map((refusal) => refusal.why);

const reasonFor = (clauses: AuthoredRow['clauses']): string =>
  resolveAuthoredRow(rowOf(clauses), CAPTURE, 'home').refusals[0]!.reason;

/** The three codes the split created. Named once so no test re-spells them. */
const THREE: RefusalReason[] = ['clause-not-labelled', 'no-readable-action', 'no-readable-target'];

/**
 * The silent half, as a function, so every test states it the same way and none
 * can quietly omit it: the fixture produced `expected` and NEITHER of the others.
 */
const onlyCode = (clauses: AuthoredRow['clauses'], expected: RefusalReason): void => {
  const codes = codesFor(clauses);
  expect(codes).toContain(expected);
  for (const other of THREE.filter((code) => code !== expected)) {
    expect(codes).not.toContain(other);
  }
};

test.describe('the three faults that shared one code (B3) @unit', () => {
  test('B3a: a clause the column never labelled is `clause-not-labelled`, and not the other two', () => {
    // wrong: under the old shared code this is `unparseable-step`, identical to the
    // code a QA gets for a sentence naming no element — so the advice they read is
    // "rewrite your row" when the fix is a column, and the sentence is already fine.
    //
    // The fixture is DISCRIMINATING on purpose: `"Save"` is quoted and resolves to
    // exactly one node in the capture, so a resolver that guessed a kind would run
    // this row. It is refused for the labelling alone.
    const clauses: AuthoredRow['clauses'] = [
      { text: 'the "Save" button', source: 'and', kind: 'unclassified', why: 'no leading verb' },
    ];
    onlyCode(clauses, 'clause-not-labelled');
    expect(REFUSAL_OWNER['clause-not-labelled']).toBe('qa');
  });

  test('B3a: the remedy names the COLUMN, which is the artefact to change', () => {
    // wrong: a remedy that says "rewrite the clause" sends the QA to edit a
    // sentence that is correct. Whatever we tell a human to do is a claim about
    // behaviour (§AG), so the words are asserted and not left to review.
    const reason = reasonFor([
      { text: 'the "Save" button', source: 'and', kind: 'unclassified', why: 'no leading verb' },
    ]);
    expect(reason).toContain('Given, When or Then column');
    expect(reason).toContain('SI_001 / TC_001');
  });

  test('B3b: an action clause with no readable action is `no-readable-action`, and not the other two', () => {
    // wrong: shared with `no-readable-target` it reads as the QA's fault. It is
    // ours — the clause is a legitimate instruction and the grammar has only a
    // click. The fixture names a real control (`"Save"` is in the capture), so the
    // ONLY thing wrong with it is that no action can be read out of `on`.
    const clauses: AuthoredRow['clauses'] = [
      { text: 'user on the "Save" button', source: 'when', kind: 'action' },
    ];
    onlyCode(clauses, 'no-readable-action');
    expect(REFUSAL_OWNER['no-readable-action']).toBe('platform');
  });

  test('B3b: a NAMED unperformable verb is still `action-not-supported`, not the new code', () => {
    // wrong: if `no-readable-action` swallowed this, the QA is told the grammar
    // cannot read their sentence when in fact we read it and cannot perform it.
    //
    // The silent half of B3b, and the distinction the capability backlog rests on:
    // a verb we can NAME goes on that backlog; a clause with no recognisable verb
    // has nothing to put on it. Collapsing the two would fill the backlog with
    // sentences nobody can build a feature from.
    const codes = codesFor([
      { text: 'user uploads the "Save" document', source: 'when', kind: 'action' },
    ]);
    expect(codes).toContain('action-not-supported');
    expect(codes).not.toContain('no-readable-action');
  });

  test('B3c: a clause naming no element is `no-readable-target`, and not the other two', () => {
    // wrong: shared with `no-readable-action` this reads as a platform gap, and the
    // row sits on our backlog forever. Measured on the real sheet: of the 118
    // clauses that land here, ZERO carry a quoted name we failed to read — so no
    // parser change reaches them and only the author can fix them.
    //
    // Discriminating: `verify` IS a verb the grammar knows, so the clause gets past
    // every action gate and fails on the name alone.
    const clauses: AuthoredRow['clauses'] = [
      { text: 'verify the system displays a message', source: 'then', kind: 'assert' },
    ];
    onlyCode(clauses, 'no-readable-target');
    expect(REFUSAL_OWNER['no-readable-target']).toBe('qa');
  });

  test('B3c: the remedy tells them to QUOTE the control, and a quoted name does resolve', () => {
    // wrong: if the advice were wrong — say it recommended a form the resolver
    // still refuses — the first assertion would pass and the second would fail,
    // which is the whole reason they sit in one test rather than two.
    //
    // Both halves in one test, because the remedy is only honest if it works:
    // the advice is asserted AND the quoted form it recommends is shown to
    // resolve against the same capture. A remedy nobody ran is the §AG mistake.
    const reason = reasonFor([
      { text: 'verify the system displays a message', source: 'then', kind: 'assert' },
    ]);
    expect(reason).toContain('in quotes');

    const taken = resolveAuthoredRow(
      rowOf([{ text: 'clicks the "Save" button', source: 'when', kind: 'action' }]),
      CAPTURE,
      'home',
    );
    expect(taken.refusals).toEqual([]);
    expect(taken.steps).toHaveLength(1);
  });
});

test.describe('who acts on a refusal is printed, not merely recorded (B3) @unit', () => {
  test('B3d: the summary names the DISTINCT owners of a row carrying two', () => {
    // wrong: naming only the first refusal's owner, this row reads as entirely the
    // platform's — and the QA never learns that one of its two clauses is theirs.
    //
    // The cautionary case this guards against is in this repo already:
    // `TRIAGE_OWNER`'s docstring records a map populated on every row that nothing
    // consulted, so a wrong entry compiled clean and stayed wrong.
    const resolved = resolveAuthoredRow(
      rowOf([
        { text: 'user on the "Save" button', source: 'when', kind: 'action' },
        { text: 'verify the system displays a message', source: 'then', kind: 'assert' },
      ]),
      CAPTURE,
      'home',
    );
    expect(resolved.refusals.map((r) => r.why)).toEqual([
      'no-readable-action',
      'no-readable-target',
    ]);
    expect(resolved.summary).toContain('owner: platform, qa');
  });

  test('B3d: a row with one owner names one, and the order is stable', () => {
    // wrong: if `refusalOwners` returned every owner regardless of the refusals,
    // the test above would pass unchanged and this one would report "platform, qa"
    // for a row whose only fault is the QA's. This is the case it must NOT
    // embellish, and it is the only one that can tell the two implementations apart.
    const resolved = resolveAuthoredRow(
      rowOf([{ text: 'verify the system displays a message', source: 'then', kind: 'assert' }]),
      CAPTURE,
      'home',
    );
    expect(resolved.summary).toContain('owner: qa');
    expect(resolved.summary).not.toContain('platform');

    // And the order is the map's, not the row's — so two rows with the same two
    // owners never read differently.
    expect(refusalOwners([{ why: 'no-readable-target' }, { why: 'no-readable-action' }])).toEqual([
      'platform',
      'qa',
    ]);
  });
});

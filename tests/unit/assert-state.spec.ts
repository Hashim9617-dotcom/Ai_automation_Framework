import { test, expect } from '@playwright/test';
import {
  classifyClause,
  resolveAuthoredRow,
  triageSheet,
  TRIAGE_OWNER,
  type AuthoredClause,
  type AuthoredRow,
  type BoundedCapture,
} from '@aitp/shared';

/**
 * A STATE ASSERTION SAYS WHAT IT MEANS, OR IT IS REFUSED (2026-09-29).
 *
 * ## What was measured before any of this was written
 *
 * `assertedProperty` mapped a clause's state word to one of three properties and
 * fell through to `present=true` when nothing matched. Measured over sixteen
 * phrases, **eight did not assert what they say**:
 *
 * | phrase            | claims        | produced      |
 * | ----------------- | ------------- | ------------- |
 * | `checked`         | checked=true  | present=true  |
 * | `is not checked`  | checked=false | present=true  |
 * | `unchecked`       | checked=false | present=true  |
 * | `is not enabled`  | enabled=false | **enabled=TRUE** |
 * | `empty`           | (no property) | present=true  |
 * | `expanded`        | (no property) | present=true  |
 * | `collapsed`       | (no property) | present=true  |
 * | `read-only`       | (no property) | present=true  |
 *
 * Two different faults, and the second is the worse one:
 *
 * - **A silent fall-through to presence.** A row claiming a box is ticked asserted
 *   only that the box EXISTS, and passed. `is not checked` produced the identical
 *   step, so a row and its exact negation were the same assertion and both went
 *   green.
 * - **An INVERTED assertion.** `PROPERTY_WORDS` had `disabled` then `enabled` and
 *   no `not enabled`, so *"the Save button is not enabled"* asserted
 *   `enabled=true`. Not a missing check — the opposite check, reported as a pass
 *   whenever the button was enabled.
 *
 * ## Why the remedy was measured before being recommended
 *
 * The refusal message for an ambiguous `checks the "Active" box` was going to tell
 * the QA to write `verify 'Active' checkbox is checked` instead. That form was
 * measured first, and it was the first row of the table above: it asserted
 * presence. **The recommended fix was itself the bug** (`docs/phase-2-generation.md`
 * §AG).
 *
 * ## PRE-REGISTERED, BEFORE THE FIX
 *
 * Both tables below were written before `checked` existed, before any refusal was
 * added, and before a line of the implementation changed. If the implementation
 * disagrees with them, the implementation is the finding and these tables are not
 * edited to match it (§AF).
 */

const capture: BoundedCapture = {
  sessionId: 'assert-state',
  states: [
    {
      id: 'form',
      label: 'form',
      url: 'http://127.0.0.1:4173/form',
      nodes: [
        { role: 'checkbox', name: 'Active', enabled: true, checked: true },
        { role: 'radio', name: 'Yes', enabled: true, selected: false },
        { role: 'button', name: 'Save', enabled: true },
        { role: 'textbox', name: 'Notes', enabled: true },
        { role: 'heading', name: 'Done', enabled: true },
      ],
      truncated: false,
    },
  ],
  transitions: [],
  selection: { keywords: [], available: [], chosen: [], excluded: [] },
};

/**
 * What a resolved row reduces to, as one comparable string.
 *
 * A single string rather than a shape, so a whole table can be compared in one
 * `toEqual` — the pre-registration is then read as a table and diffs as a table.
 */
const outcomeOf = (clause: AuthoredClause, id: string): string => {
  const row: AuthoredRow = {
    rowId: `${id} / TC_1`,
    scenarioId: id,
    testCaseId: 'TC_1',
    sheetRow: 2,
    module: 'Forms',
    feature: '',
    // Blank: `assessWriteRisk` reads the TITLE, and a title with a write word in
    // it would hold every row and hide every outcome below.
    scenarioName: '',
    objective: 'a state assertion',
    testType: '',
    priority: '',
    preconditions: '',
    testData: '',
    type: '',
    clauses: [clause],
  };

  const resolved = resolveAuthoredRow(row, capture, 'form');
  if (resolved.outcome === 'row-unclear') {
    const refusal = resolved.refusals[0]!;
    return `refused: ${refusal.why}`;
  }
  const step = resolved.steps[0];
  if (!step) return 'no step';
  return step.kind === 'action'
    ? `action: ${resolved.targets[0]?.name ?? '(no target)'}`
    : `assert ${step.property}=${step.expected}`;
};

const thenClause = (text: string): AuthoredClause => ({ text, source: 'then', kind: 'assert' });

/**
 * The kind a COLUMN gives a clause, exactly as `readFinalTestCases` assigns it.
 *
 * Measured, not assumed: the reader hardcodes `action` for When and `assert` for
 * Then whatever the text says, and runs `classifyClause` on `And` alone — so the
 * And column is the only one where the verb decides anything.
 *
 * The first draft of this helper wrote `source === 'then' ? 'assert' : 'action'`,
 * which labelled `and|checks that "Done" is visible` an ACTION. The table then
 * disagreed with the pre-registration on two rows, and the FIXTURE was wrong, not
 * the implementation: an `assert` clause mislabelled `action` has no performable
 * verb, so it was refused for a reason that had nothing to do with A4. The
 * expected values did not move.
 */
const columnKind = (source: AuthoredClause['source'], text: string): AuthoredClause['kind'] =>
  source === 'then' ? 'assert' : source === 'and' ? classifyClause(text).kind : 'action';

/**
 * TABLE 1 — every state and negation phrase, as a Then clause.
 *
 * `empty`, `expanded`, `collapsed` and `read-only` are refused rather than given a
 * property: a property nobody can read off a capture would be a check that grades
 * `assumed` forever, and refusing names the gap where a reader can see it.
 */
const EXPECTED_PHRASES: Record<string, string> = {
  'verify the "Active" checkbox is checked': 'assert checked=true',
  'verify the "Active" checkbox is not checked': 'assert checked=false',
  'verify the "Active" checkbox is unchecked': 'assert checked=false',
  'verify the "Save" button is disabled': 'assert enabled=false',
  'verify the "Save" button is not enabled': 'assert enabled=false',
  'verify the "Save" button is enabled': 'assert enabled=true',
  'verify the "Done" heading is hidden': 'assert present=false',
  'verify the "Done" heading is not visible': 'assert present=false',
  'verify the "Done" heading is not present': 'assert present=false',
  'verify the "Done" heading is visible': 'assert present=true',
  'verify the "Notes" field is empty': 'refused: assertion-not-supported',
  'verify the "Notes" field is expanded': 'refused: assertion-not-supported',
  'verify the "Notes" field is collapsed': 'refused: assertion-not-supported',
  'verify the "Notes" field is read-only': 'refused: assertion-not-supported',
  'verify the "Yes" radio is selected': 'assert selected=true',
  'verify the "Yes" radio is not selected': 'assert selected=false',
};

/**
 * TABLE 2 — a check/tick verb, and a column that disagrees with the text.
 *
 * The `and` column's kind is whatever `classifyClause` reads off the verb; `when`
 * is always `action` and `then` is always `assert`, measured rather than assumed
 * (the reader hardcodes two of the three and classifies only `And`).
 */
const EXPECTED_CONFLICTS: Record<string, string> = {
  // A bare check/tick verb names no state to verify. It is an ACTION written in
  // an assert column, and the platform has no tick action.
  'when|checks the "Active" box': 'refused: column-verb-conflict',
  'and|checks the "Active" box': 'refused: column-verb-conflict',
  'then|checks the "Active" box': 'refused: column-verb-conflict',
  'when|ticks the "Active" box': 'refused: column-verb-conflict',
  'and|ticks the "Active" box': 'refused: column-verb-conflict',
  'then|ticks the "Active" box': 'refused: column-verb-conflict',
  'when|unchecks the "Active" box': 'refused: column-verb-conflict',
  'and|unchecks the "Active" box': 'refused: column-verb-conflict',
  'then|unchecks the "Active" box': 'refused: column-verb-conflict',
  // `selects` is an action the executor cannot perform, in every column. In a
  // Then column it is ALSO a column/verb conflict, and the conflict is reported
  // because it is the more specific diagnosis.
  'when|selects the "Yes" radio': 'refused: action-not-supported',
  'and|selects the "Yes" radio': 'refused: action-not-supported',
  'then|selects the "Yes" radio': 'refused: column-verb-conflict',
  // MUST STILL WORK: a `checks` clause that names a state is a verification.
  'when|checks that "Done" is visible': 'refused: column-verb-conflict',
  'and|checks that "Done" is visible': 'assert present=true',
  'then|checks that "Done" is visible': 'assert present=true',
  'when|checks the "Save" button is present': 'refused: column-verb-conflict',
  'and|checks the "Save" button is present': 'assert present=true',
  'then|checks the "Save" button is present': 'assert present=true',
};

test.describe('a state assertion says what it means (A1/A2/A3) @unit', () => {
  test('A1: every state and negation phrase resolves to the property it claims', () => {
    // wrong: eight of these produce `present=true` — the row asserts the element
    // EXISTS while claiming something about its state, and passes. `is not
    // enabled` produces `enabled=true`, the exact opposite of the sentence.
    //
    // Discriminating by construction: the table holds both polarities of every
    // property, so a resolver that dropped negation, or one that answered
    // `present=true` for everything, differs from it on at least half the rows.
    const actual = Object.fromEntries(
      Object.keys(EXPECTED_PHRASES).map((clause, index) => [
        clause,
        outcomeOf(thenClause(clause), `PH${index}`),
      ]),
    );
    expect(actual).toEqual(EXPECTED_PHRASES);
  });

  test('A3: a state word with no property is REFUSED, never quietly `present`', () => {
    // wrong: it falls through to `present=true`, so "the Notes field is empty"
    // passes as soon as the field exists — a check that cannot fail, which is
    // worse than no check because the row is green and looks covered.
    const refusal = ['empty', 'expanded', 'collapsed', 'read-only'];
    for (const word of refusal) {
      const outcome = outcomeOf(thenClause(`verify the "Notes" field is ${word}`), `AW${word}`);
      expect(outcome, `"${word}" must be refused`).toBe('refused: assertion-not-supported');
    }

    // The other half, and the one that stops this being a rule that refuses
    // everything: a clause with NO state word at all still means presence.
    expect(outcomeOf(thenClause('verify "Done" is visible'), 'AW1')).toBe('assert present=true');
    expect(outcomeOf(thenClause('verify the "Done" heading'), 'AW2')).toBe('assert present=true');
  });

  test('A3: the refusal NAMES the word it could not verify', () => {
    // wrong: the message says "this assertion is not supported", so a QA cannot
    // tell which of the words in their sentence we failed on — and with several
    // state words in one clause there is nothing to rewrite.
    const row: AuthoredRow = {
      rowId: 'AN_1 / TC_1',
      scenarioId: 'AN_1',
      testCaseId: 'TC_1',
      sheetRow: 2,
      module: 'Forms',
      feature: '',
      scenarioName: '',
      objective: '',
      testType: '',
      priority: '',
      preconditions: '',
      testData: '',
      type: '',
      clauses: [thenClause('verify the "Notes" field is read-only')],
    };
    const resolved = resolveAuthoredRow(row, capture, 'form');
    expect(resolved.refusals[0]!.reason).toContain('read-only');
  });

  test('A4: the form the refusal RECOMMENDS is the form that was measured to work', () => {
    // wrong: the message recommends a form nobody ran. That is exactly how the
    // previous recommendation — `verify 'Active' checkbox is checked` — was made
    // while it asserted PRESENCE, so a QA who followed it got a green row that
    // checked the box existed (§AG).
    //
    // This test extracts the form out of the live message and resolves it, so the
    // two cannot drift: change the message to recommend something else and this
    // fails. That it also PASSES on a ticked box and FAILS on an unticked one is
    // proved against a real browser in `tests/demo/assert-checked.spec.ts`.
    const row: AuthoredRow = {
      rowId: 'RF_1 / TC_1',
      scenarioId: 'RF_1',
      testCaseId: 'TC_1',
      sheetRow: 2,
      module: 'Forms',
      feature: '',
      scenarioName: '',
      objective: '',
      testType: '',
      priority: '',
      preconditions: '',
      testData: '',
      type: '',
      clauses: [{ text: 'checks the "Active" box', source: 'then', kind: 'assert' }],
    };
    const message = resolveAuthoredRow(row, capture, 'form').refusals[0]!.reason;

    // The recommended form, read OUT OF THE MESSAGE rather than retyped here.
    const recommended = /`(verify the "X" checkbox is checked)`/.exec(message)?.[1];
    expect(recommended, `the message recommends no form: ${message}`).toBeDefined();

    const asWritten = recommended!.replace('"X"', '"Active"');
    expect(outcomeOf(thenClause(asWritten), 'RF_2')).toBe('assert checked=true');
    // The negative form the same message offers.
    expect(message).toContain('is not checked');
    expect(outcomeOf(thenClause(asWritten.replace('is checked', 'is not checked')), 'RF_3')).toBe(
      'assert checked=false',
    );
  });
});

test.describe('the column decides, and the verb can only VETO (A4) @unit', () => {
  test('A4: every column/verb combination lands on its pre-registered outcome', () => {
    // wrong: a bare `checks the "Active" box` in a Then column becomes
    // `assert checkbox "Active" present=true` and reports a pass having ticked
    // nothing. Measured before the fix, in both the `and` and `then` columns.
    //
    // Discriminating: the last four rows are `checks` clauses that DO name a
    // state, and they must still resolve — a rule that refused every `checks`
    // clause would satisfy the first fourteen rows and be worthless.
    const actual = Object.fromEntries(
      Object.entries(EXPECTED_CONFLICTS).map(([key], index) => {
        const [source, text] = key.split('|') as [AuthoredClause['source'], string];
        return [key, outcomeOf({ text, source, kind: columnKind(source, text) }, `CV${index}`)];
      }),
    );
    expect(actual).toEqual(EXPECTED_CONFLICTS);
  });

  test('A4: a refused conflict keeps the COLUMN’s kind — it is never reclassified', () => {
    // wrong: the resolver "helpfully" reads the verb and files the clause as the
    // other kind, which makes the platform the authority over the human who wrote
    // the column. Refusing preserves both facts: the column's kind is recorded,
    // and nothing ran.
    const row: AuthoredRow = {
      rowId: 'CK_1 / TC_1',
      scenarioId: 'CK_1',
      testCaseId: 'TC_1',
      sheetRow: 2,
      module: 'Forms',
      feature: '',
      scenarioName: '',
      objective: '',
      testType: '',
      priority: '',
      preconditions: '',
      testData: '',
      type: '',
      clauses: [
        { text: 'click the "Save" button should be visible', source: 'then', kind: 'assert' },
      ],
    };
    const resolved = resolveAuthoredRow(row, capture, 'form');

    expect(resolved.outcome).toBe('row-unclear');
    expect(resolved.refusals[0]!.why).toBe('column-verb-conflict');
    // The column's kind survived the refusal. A reclassifying resolver would
    // record `action` here.
    expect(resolved.clauseKinds).toEqual(['assert']);
    expect(resolved.steps).toEqual([]);
  });
});

test.describe('triage and the run agree about state assertions (A5) @unit', () => {
  const rowOf = (text: string, source: AuthoredClause['source'], id: string): AuthoredRow => ({
    rowId: `${id} / TC_1`,
    scenarioId: id,
    testCaseId: 'TC_1',
    sheetRow: 2,
    module: 'Forms',
    feature: '',
    scenarioName: '',
    objective: '',
    testType: '',
    priority: '',
    preconditions: '',
    testData: '',
    type: '',
    clauses: [
      { text: 'clicks the "Save" button', source: 'when', kind: 'action' },
      { text, source, kind: source === 'then' ? 'assert' : 'action' },
    ],
  });

  test('A5: an unverifiable state and a column conflict are NOT automatable', () => {
    // wrong: triage counts the row automatable and the run refuses it, so the
    // ceiling promises work the platform declines — the hole e3a8f76 closed for
    // upload, reopened by two new refusal reasons.
    // The OWNER is stated per row rather than asserted to be `platform` for both,
    // which is what this test said when it was written. That was a guess about a
    // decision not yet taken: a column/verb conflict is a sentence the QA can
    // rewrite into a row that runs TODAY, so it is theirs, while a state nothing
    // can read is ours until we can read it. The reasons agree with the run
    // either way; the owners differ, and the difference is the point of having
    // owners at all.
    for (const [text, source, reason, owner] of [
      ['verify the "Notes" field is read-only', 'then', 'unverifiable-assertion', 'platform'],
      ['checks the "Active" box', 'then', 'column-verb-conflict', 'qa'],
    ] as const) {
      const triaged = triageSheet([rowOf(text, source, 'TA_1')], new Set(['Forms'])).rows[0]!;
      expect(triaged.reason, text).toBe(reason);
      expect(triaged.reason, text).not.toBe('automatable');
      expect(TRIAGE_OWNER[triaged.reason], text).toBe(owner);
    }
  });

  test('A5 (discriminating): a real state assertion IS automatable', () => {
    // wrong: agreement is reached by refusing everything, which agrees perfectly
    // and automates nothing. This is the row that must come out the other way.
    const triaged = triageSheet(
      [rowOf('verify the "Active" checkbox is checked', 'then', 'TA_2')],
      new Set(['Forms']),
    ).rows[0]!;
    expect(triaged.reason).toBe('automatable');
  });
});

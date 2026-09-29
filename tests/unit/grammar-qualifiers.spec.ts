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
 * A QUALIFIER THE QA WROTE IS NEVER DISCARDED (2026-09-29).
 *
 * ## The pattern, on its fourth appearance
 *
 * A verb denylist let a fill verb become a click. A state-word list let `checked`
 * become `present`. A column/verb contradiction let a Then clause run a click.
 * Each time a WORD THE QA WROTE was dropped and the clause ran anyway.
 *
 * The 3a-6 audit asked the rest of the grammar the same question, over 36 clauses
 * against a capture holding a node for every name they could slice out. Counted:
 * **4 right, 2 right by accident, 7 refused (3 for the wrong reason), 14 dropped a
 * qualifier, and 4 asserted the OPPOSITE of what they said.**
 *
 * The worst was measured against a real browser rather than inferred:
 *
 * ```
 * capture: one button "Edit"     page: three (Alice / Bob / Jane)
 * clicks "Edit" in the row for "Jane"   passed   -> Alice edited
 * ```
 *
 * The resolver DOES refuse an ambiguous target — against the CAPTURE. The executor
 * branched on `count === 0` and nothing else, so a live page with several matches
 * was clicked at `.first()`. A `Delete` clause scoped to one record would delete a
 * different record and report a pass, and the normal shape of a DMS grid is a
 * capture taken with one row and a run against twenty.
 *
 * ## PRE-REGISTERED, BEFORE THE FIX
 *
 * Every row of the audit appears below with its post-fix expected outcome, written
 * before a line changed. The INPUT is frozen too — the capture and the clause
 * strings are the audit's, unedited — because a table whose inputs move is not a
 * pre-registration (§AF).
 */

const node = (role: string, name: string, extra: Record<string, boolean> = {}) => ({
  role,
  name,
  enabled: true,
  ...extra,
});

/** The audit's capture, unchanged. Rich on purpose: a name a clause slices out is here. */
const capture: BoundedCapture = {
  sessionId: 'grammar-qualifiers',
  states: [
    {
      id: 'table',
      label: 'table',
      url: 'http://127.0.0.1:4173/t',
      nodes: [
        node('button', 'Edit'),
        node('button', 'Delete'),
        node('button', 'Save'),
        node('link', 'Users'),
        node('tab', 'Filters'),
        node('menuitem', 'Export'),
        node('combobox', 'Department'),
        node('textbox', 'Notes'),
        node('checkbox', 'Active', { checked: true }),
        node('row', 'Jane Doe HR Active'),
        node('cell', 'Jane'),
        node('table', 'Employees'),
        node('dialog', 'Confirm'),
        node('heading', 'Done'),
        node('StaticText', 'Saved'),
        node('StaticText', 'Jane'),
        node('StaticText', 'Name'),
        node('StaticText', 'Active'),
        node('StaticText', '10'),
        node('StaticText', 'HR'),
      ],
      truncated: false,
    },
    {
      id: 'dupes',
      label: 'dupes',
      url: 'http://127.0.0.1:4173/d',
      nodes: [node('button', 'Edit'), node('button', 'Edit'), node('heading', 'Done')],
      truncated: false,
    },
  ],
  transitions: [],
  selection: { keywords: [], available: [], chosen: [], excluded: [] },
};

/** The kind each column forces, exactly as `readFinalTestCases` assigns it. */
const columnKind = (source: AuthoredClause['source'], text: string): AuthoredClause['kind'] =>
  source === 'then' ? 'assert' : source === 'and' ? classifyClause(text).kind : 'action';

let seq = 0;
const outcomeOf = (text: string, source: AuthoredClause['source'], state = 'table'): string => {
  seq += 1;
  const row: AuthoredRow = {
    rowId: `Q${seq} / TC_1`,
    scenarioId: `Q${seq}`,
    testCaseId: 'TC_1',
    sheetRow: 2,
    module: 'Employees',
    feature: '',
    // Blank: `assessWriteRisk` reads the title, and a write word there would hold
    // every row and hide every outcome in the table.
    scenarioName: '',
    objective: 'audit',
    testType: '',
    priority: '',
    preconditions: '',
    testData: '',
    type: '',
    clauses: [{ text, source, kind: columnKind(source, text) }],
  };
  const resolved = resolveAuthoredRow(row, capture, state);
  if (resolved.outcome === 'row-unclear') return `refused: ${resolved.refusals[0]!.why}`;
  const step = resolved.steps[0];
  if (!step) return 'no step';
  const chosen = resolved.targets[0];
  return step.kind === 'action'
    ? `action -> ${chosen ? `${chosen.role} "${chosen.name}"` : '(no target)'}`
    : `assert ${step.role} ${step.property}=${step.expected}`;
};

/**
 * THE AUDIT, ROW BY ROW, WITH ITS POST-FIX EXPECTATION.
 *
 * Keyed `column|clause` so a mismatch names the exact row. Two reason codes carry
 * the whole change:
 *
 * - `qualifier-not-supported` — the QA named a POSITION or a SCOPE we cannot
 *   express: an ordinal, a containing region, or a second quoted string nothing
 *   consumed. Ours to build.
 * - `assertion-not-supported` — the QA named a CLAIM we cannot read: an
 *   unsupported negation, a value comparison, a count, or a state with no
 *   property. Also ours.
 *
 * The rows that must still RESOLVE are as important as the refusals: a rule that
 * refused every clause would satisfy every refusal below and be worthless.
 */
const EXPECTED: Record<string, string> = {
  // ---- ordinals: a position we cannot express ----
  'when|clicks the second "Edit" button': 'refused: qualifier-not-supported',
  'when|clicks the last "Delete" button': 'refused: qualifier-not-supported',
  'when|clicks the 3rd row': 'refused: qualifier-not-supported',

  // ---- scoping: a region we cannot express ----
  'when|clicks "Edit" in the row for "Jane"': 'refused: qualifier-not-supported',
  'when|clicks "Save" in the dialog': 'refused: qualifier-not-supported',
  'when|clicks "Delete" in the "Users" section': 'refused: qualifier-not-supported',
  'when|clicks "Edit" within the "Filters" panel': 'refused: qualifier-not-supported',

  // ---- a second quoted string nothing consumed ----
  'when|clicks "Edit" next to "Jane"': 'refused: qualifier-not-supported',
  'then|verify "Jane" appears under "Name"': 'refused: qualifier-not-supported',

  // ---- role nouns: THESE MUST KEEP WORKING ----
  'when|clicks the "Users" link': 'action -> link "Users"',
  'when|clicks the "Filters" tab': 'action -> tab "Filters"',
  'when|clicks the "Export" menu item': 'action -> menuitem "Export"',
  'when|clicks the "Department" dropdown': 'action -> combobox "Department"',
  // `icon` is not a role word, so the role comes from the clickable set and the
  // answer happens to be right. Unchanged, and recorded as unchanged.
  'when|clicks the "Save" icon': 'action -> button "Save"',
  // `row` and `card` are NOT being added to ROLE_WORDS — that is reach, and this
  // work is about refusing lies. Both stay as they were.
  'when|clicks the "Jane Doe HR Active" row': 'refused: target-not-found',
  'when|clicks the "Employees" card': 'refused: target-not-found',
  'then|verify the "Jane" cell is visible': 'assert cell present=true',
  // `toggle` as a NOUN was read as the verb `toggle`, so this was refused
  // `action-not-supported` — the right verdict for the wrong reason, since there is
  // no `switch` role word either. 3a-7 #6 strips role nouns after the verb
  // position, and the clause now resolves: it IS a click, on a checkbox called
  // Active. This row was pre-registered with the old answer and moved in the #6
  // commit, deliberately and visibly, which is the only way an EXPECTED entry moves.
  'when|clicks the "Active" toggle': 'action -> checkbox "Active"',

  // ---- quantifiers ----
  'then|verify all rows show "Active"': 'refused: qualifier-not-supported',
  'then|verify each "Edit" button is enabled': 'refused: qualifier-not-supported',
  'then|verify every "Delete" button is visible': 'refused: qualifier-not-supported',
  // `no` is classified as a NEGATION rather than a quantifier, deliberately: `no
  // longer` must not be split into `no` + `longer`, and both are claims about the
  // assertion rather than about scope.
  'then|verify no "Delete" button is visible': 'refused: assertion-not-supported',
  // `any` means "at least one", which is what `present=true` over several matches
  // already is. It keeps working, and it is the row that stops the quantifier rule
  // being "refuse every determiner".
  'then|verify any "Edit" button is visible': 'assert button present=true',

  // ---- text and value assertions ----
  'then|verify the page shows "Saved"': 'assert StaticText present=true',
  'then|verify the table contains "Jane"': 'refused: assertion-not-supported',
  'then|verify the "Notes" field equals "10"': 'refused: assertion-not-supported',
  'then|verify the "Department" dropdown has value "HR"': 'refused: assertion-not-supported',
  'then|verify the system displays a message': 'refused: unparseable-step',

  // ---- counts ----
  'then|verify 3 rows are shown': 'refused: assertion-not-supported',
  'then|verify the "Employees" table has 10 records': 'refused: assertion-not-supported',

  // ---- negation phrasing ----
  'then|verify the page does not show "Saved"': 'refused: assertion-not-supported',
  'then|verify "Saved" is no longer visible': 'refused: assertion-not-supported',
  'then|verify the row is shown without the "Delete" button': 'refused: assertion-not-supported',
  'then|verify the user cannot click "Delete"': 'refused: assertion-not-supported',

  // ---- the SUPPORTED negatives, which the negation gate must let through ----
  'then|verify the "Active" checkbox is not checked': 'assert checkbox checked=false',
  'then|verify the "Save" button is not enabled': 'assert button enabled=false',
  'then|verify the "Done" heading is not visible': 'assert heading present=false',
  'then|verify the "Done" heading is not present': 'assert heading present=false',
  'then|verify the "Active" checkbox is unchecked': 'assert checkbox checked=false',
  'then|verify the "Save" button is disabled': 'assert button enabled=false',
  'then|verify the "Done" heading is hidden': 'assert heading present=false',
};

/** Ambiguity against the CAPTURE. Separate state, so it needs its own table. */
const EXPECTED_CAPTURE_DUPES: Record<string, string> = {
  'when|clicks "Edit"': 'refused: ambiguous-target',
  'then|verify "Edit" is visible': 'refused: ambiguous-target',
};

test.describe('a qualifier the QA wrote is never discarded @unit', () => {
  test('every audited clause lands on its pre-registered outcome', () => {
    // wrong: 14 of these drop the qualifier and run anyway, and 4 assert the
    // opposite of what they say. Measured 2026-09-29 before any of this existed.
    //
    // Discriminating by construction: eleven rows must still RESOLVE — the role
    // nouns, `any`, `shows "Saved"`, the cell, and all seven supported negatives —
    // so a rule that refused everything differs from this table on eleven rows.
    const actual = Object.fromEntries(
      Object.keys(EXPECTED).map((key) => {
        const [source, text] = key.split('|') as [AuthoredClause['source'], string];
        return [key, outcomeOf(text, source)];
      }),
    );
    expect(actual).toEqual(EXPECTED);
  });

  test('ambiguity against the CAPTURE is still refused at resolve', () => {
    // wrong: the capture's own duplicates are resolved to `.first()` too, and then
    // the live-page guard is the only thing standing between a row and the wrong
    // element — one gate instead of two, at the layer that can say least.
    const actual = Object.fromEntries(
      Object.keys(EXPECTED_CAPTURE_DUPES).map((key) => {
        const [source, text] = key.split('|') as [AuthoredClause['source'], string];
        return [key, outcomeOf(text, source, 'dupes')];
      }),
    );
    expect(actual).toEqual(EXPECTED_CAPTURE_DUPES);
  });

  test('the refusal NAMES the qualifier it could not express', () => {
    // wrong: "this clause has an unsupported qualifier" tells a QA nothing about
    // which of the words in their sentence to change, and with two qualifiers in
    // one clause there is nothing to act on at all.
    const cases: Array<[string, AuthoredClause['source'], string]> = [
      ['clicks the second "Edit" button', 'when', 'second'],
      ['clicks "Edit" within the "Filters" panel', 'when', 'within'],
      ['verify each "Edit" button is enabled', 'then', 'each'],
      ['verify the "Notes" field equals "10"', 'then', 'equals'],
      ['verify 3 rows are shown', 'then', 'rows'],
      ['verify "Saved" is no longer visible', 'then', 'no longer'],
    ];
    for (const [text, source, word] of cases) {
      seq += 1;
      const row: AuthoredRow = {
        rowId: `N${seq} / TC_1`,
        scenarioId: `N${seq}`,
        testCaseId: 'TC_1',
        sheetRow: 2,
        module: 'Employees',
        feature: '',
        scenarioName: '',
        objective: '',
        testType: '',
        priority: '',
        preconditions: '',
        testData: '',
        type: '',
        clauses: [{ text, source, kind: columnKind(source, text) }],
      };
      const resolved = resolveAuthoredRow(row, capture, 'table');
      expect(resolved.outcome, text).toBe('row-unclear');
      expect(resolved.refusals[0]!.reason, text).toContain(word);
    }
  });
});

test.describe('a refusal happens for the RIGHT reason (#6) @unit', () => {
  test('a role word belonging to a SCOPE does not describe the target', () => {
    // wrong: `extractRole` scans the whole clause, so `on the popup` names a DIALOG
    // and the resolver looks for a dialog called "Save" — refused
    // `target-not-found`, blaming the QA's name for a scope phrase we cannot
    // express. `clicks "Save" in the dialog` is already refused by the scope rule;
    // this phrasing is not in that list, which is why the adjacency fix is needed
    // and why it would otherwise be untested.
    expect(outcomeOf('clicks "Save" on the popup', 'when')).toBe('action -> button "Save"');

    // Discriminating, and the half that keeps the fix honest: a role word that IS
    // beside the name is still read, which is the whole point of reading one.
    expect(outcomeOf('clicks the "Users" link', 'when')).toBe('action -> link "Users"');
    expect(outcomeOf('verify the "Done" heading is visible', 'then')).toBe(
      'assert heading present=true',
    );
    // And with NO quoted name there is no anchor, so the whole clause is scanned —
    // the path `clicks on the Sign in button` depends on.
    expect(outcomeOf('clicks on the Save button', 'when')).toBe('action -> button "Save"');
  });

  test('a role NOUN after the verb is not read as the verb', () => {
    // wrong: `toggle` is matched anywhere in the clause, so `clicks the "Active"
    // toggle` is refused as an unperformable `toggle` action — naming a verb the QA
    // never used, and sending them to wait for a feature that is not the problem.
    //
    // Third instance of one rule: an element's own name is not a description of it
    // (`extractRole` reading "select" out of "Select department", `actionCapability`
    // reading `enter` out of `presses Enter`).
    expect(outcomeOf('clicks the "Active" toggle', 'when')).toBe('action -> checkbox "Active"');

    // THE HALF THAT MATTERS. A role noun in VERB position is still a verb, so a
    // clause that really does ask us to toggle something is still refused.
    expect(outcomeOf('toggles the "Active" box', 'when')).toBe('refused: action-not-supported');
    // And the subject prefix comes off before the strip, or `User uploads …` loses
    // its verb — which is exactly what the first draft did.
    expect(outcomeOf('User uploads the document', 'when')).toBe('refused: action-not-supported');
  });
});

test.describe('triage and the run agree about qualifiers @unit', () => {
  const rowOf = (text: string, source: AuthoredClause['source'], id: string): AuthoredRow => ({
    rowId: `${id} / TC_1`,
    scenarioId: id,
    testCaseId: 'TC_1',
    sheetRow: 2,
    module: 'Employees',
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
      { text, source, kind: columnKind(source, text) },
    ],
  });

  test('an unsupported qualifier is NOT automatable, and it is ours', () => {
    // wrong: triage counts the row automatable and the run refuses it, so the
    // ceiling promises work nobody will do — the hole e3a8f76 closed for upload,
    // reopened by every new refusal reason that triage does not know about.
    for (const [text, source, reason, owner] of [
      ['clicks the second "Edit" button', 'when', 'qualifier-not-supported', 'platform'],
      ['verify "Jane" appears under "Name"', 'then', 'qualifier-not-supported', 'platform'],
      ['verify the "Notes" field equals "10"', 'then', 'unverifiable-assertion', 'platform'],
      ['verify "Saved" is no longer visible', 'then', 'unverifiable-assertion', 'platform'],
    ] as const) {
      const triaged = triageSheet([rowOf(text, source, 'TQ_1')], new Set(['Employees'])).rows[0]!;
      expect(triaged.reason, text).toBe(reason);
      expect(TRIAGE_OWNER[triaged.reason], text).toBe(owner);
    }
  });

  test('(discriminating) a clause with no qualifier IS automatable', () => {
    // wrong: agreement is reached by refusing everything, which agrees perfectly
    // and automates nothing. This is the row that must come out the other way.
    const triaged = triageSheet(
      [rowOf('verify the "Done" heading is visible', 'then', 'TQ_2')],
      new Set(['Employees']),
    ).rows[0]!;
    expect(triaged.reason).toBe('automatable');
  });
});

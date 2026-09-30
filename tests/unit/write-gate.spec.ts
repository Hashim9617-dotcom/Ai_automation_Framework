import { test, expect } from '@playwright/test';
import {
  assessAuthoredWriteRisk,
  executeAuthoredRows,
  resolveAuthoredRow,
  type AuthoredRow,
  type BoundedCapture,
} from '@aitp/shared';

/**
 * THE WRITE GATE IS FAIL-CLOSED (2026-09-30).
 *
 * ## What was measured before any of this was written
 *
 * D4 ("v1 is read-only") rested entirely on `assessWriteRisk`, a regex of 15 word
 * stems over CLAUSE TEXT. Over 45 phrases a QA would plausibly write:
 *
 * ```
 * held 12 · allowed-and-read-only 8 · MISSED 23 · refused before the gate 2
 * ```
 *
 * **23 writes went through.** Three shapes, and each is a different hole:
 *
 * - **Every state-toggling control.** `clicks the "Admin" checkbox` grants a role
 *   and was classified `read-only`, because the gate never looked at the ROLE.
 * - **The confirmation step.** `Confirm` was in the list; `Yes`, `OK`, `Proceed`
 *   and `Continue` were not. So a two-step delete — trash icon, then Yes — had
 *   both steps allowed.
 * - **Most workflow verbs.** `Approve`, `Assign`, `Send`, `Lock`, `Reset
 *   password`, `Grant` … none of them were words in the list.
 *
 * On the real application it was worse than half: of 391 distinct controls in the
 * local DMS captures, the gate held 47 and allowed 58 that change state — 42 of
 * them by role alone.
 *
 * ## The order matters, and it was measured
 *
 * Rule B (hold every state-toggling role) is STRUCTURAL: the role comes from the
 * capture, not from a word list, and five separate fail-open findings this month
 * were word lists. It is the only part of this change that a new verb cannot
 * defeat.
 *
 * ## PRE-REGISTERED, BEFORE THE FIX
 *
 * Every one of the 45 phrases appears below with its post-fix expected verdict,
 * written before a line changed, inputs frozen (§AF).
 */

const node = (role: string, name: string, extra: Record<string, boolean> = {}) => ({
  role,
  name,
  enabled: true,
  ...extra,
});

/** The 3a-8 capture, unchanged: every control the clauses name, in a real role. */
const capture: BoundedCapture = {
  sessionId: 'write-gate',
  states: [
    {
      id: 'screen',
      label: 'screen',
      url: 'http://127.0.0.1:4173/s',
      nodes: [
        node('checkbox', 'Active', { checked: false }),
        node('checkbox', 'Admin', { checked: false }),
        node('radio', 'Yes', { selected: false }),
        /**
         * A BUTTON also named Yes, and its absence was a fixture bug.
         *
         * `clicks "Yes"` came back `target-not-found`, because `radio` is NOT in
         * `CLICKABLE_ROLES` — so a clause pointing at a radio cannot resolve as an
         * action at all, and the row that was meant to exercise rule C (a
         * confirmation name) exercised nothing.
         *
         * The node is ADDED rather than swapped: `clicks the "Yes" radio` names the
         * role explicitly and still resolves to the radio, so both rows keep
         * testing what they were written to test, and no clause and no expected
         * verdict moved (§AF — the input was wrong, not the expectation).
         *
         * The finding underneath is worth keeping: rule B can never fire for a
         * RADIO through a bare click, because the resolver will not address one.
         */
        node('button', 'Yes'),
        node('checkbox', 'Read', { checked: false }),
        node('switch', 'Notifications', { checked: false }),
        ...[
          'Approve',
          'Reject',
          'Assign',
          'Revoke',
          'Submit',
          'Send',
          'Publish',
          'Share',
          'Archive',
          'Restore',
          'Move',
          'Rename',
          'Lock',
          'Unlock',
          'Reset password',
          'Activate',
          'Deactivate',
          'Grant',
          'Remove',
          'Import',
          'Upload',
          'Delete',
          'Remove user',
          'trash',
          'OK',
          'Confirm',
          'Proceed',
          'Continue',
          'Search',
          'Filter',
          'Edit',
          'Cancel',
          'Close',
          'View',
          'Next page',
          'Export',
        ].map((name) => node('button', name)),
        node('tab', 'Users'),
        node('heading', 'Done'),
      ],
      truncated: false,
    },
  ],
  transitions: [],
  selection: { keywords: [], available: [], chosen: [], excluded: [] },
};

let seq = 0;
/** The row's verdict: held by the gate, allowed, or refused before the gate. */
const verdictOf = (text: string): string => {
  seq += 1;
  const row: AuthoredRow = {
    rowId: `WG${seq} / TC_1`,
    scenarioId: `WG${seq}`,
    testCaseId: 'TC_1',
    sheetRow: 2,
    module: 'M',
    feature: '',
    // NOT blank any more, and deliberately so: the gate no longer reads the title,
    // and a title full of write words is the discriminating fixture for that.
    scenarioName: 'the record is created and saved',
    objective: '',
    testType: '',
    priority: '',
    preconditions: '',
    testData: '',
    type: '',
    clauses: [
      { text, source: 'when', kind: 'action' },
      { text: 'verify the "Done" heading is visible', source: 'then', kind: 'assert' },
    ],
  };
  const resolved = resolveAuthoredRow(row, capture, 'screen');
  if (resolved.outcome === 'row-unclear') return `refused: ${resolved.refusals[0]!.why}`;
  return resolved.writeRisk === 'creates-data' ? 'HELD' : 'allowed';
};

/**
 * THE 45 PHRASES, with their post-fix verdicts.
 *
 * `HELD` is the safe answer and most of this table is `HELD`, which is exactly why
 * the nine `allowed` rows matter more than the rest: a gate that held everything
 * would satisfy every other row here and automate nothing.
 */
const EXPECTED: Record<string, string> = {
  // ---- B: state-toggling roles, from the resolved ROLE ----
  'clicks the "Active" toggle': 'HELD',
  'clicks the "Admin" checkbox': 'HELD',
  'clicks the "Yes" radio': 'HELD',
  'clicks the "Read" permission': 'HELD',
  // `switches on` is not a performable verb; the qualifier gate gets there first.
  'switches on "Notifications"': 'refused: action-not-supported',

  // ---- D: workflow verbs ----
  'clicks "Approve"': 'HELD',
  'clicks "Reject"': 'HELD',
  'clicks "Assign"': 'HELD',
  'clicks "Revoke"': 'HELD',
  'clicks "Submit"': 'HELD',
  'clicks "Send"': 'HELD',
  'clicks "Publish"': 'HELD',
  'clicks "Share"': 'HELD',
  'clicks "Archive"': 'HELD',
  'clicks "Restore"': 'HELD',
  'clicks "Move"': 'HELD',
  'clicks "Rename"': 'HELD',
  'clicks "Lock"': 'HELD',
  'clicks "Unlock"': 'HELD',
  'clicks "Reset password"': 'HELD',
  'clicks "Activate"': 'HELD',
  'clicks "Deactivate"': 'HELD',
  'clicks "Grant"': 'HELD',
  'clicks "Remove"': 'HELD',
  'clicks "Import"': 'HELD',
  'clicks "Upload"': 'HELD',

  // ---- C: confirmation buttons ----
  // `clicks "Yes"` resolves to the RADIO named Yes in this capture, so it is held
  // by rule B rather than by rule C. The C path is proved by `OK`/`Proceed`/
  // `Continue`, and by the two-step test below.
  'clicks "Yes"': 'HELD',
  'clicks "OK"': 'HELD',
  'clicks "Confirm"': 'HELD',
  'clicks "Proceed"': 'HELD',
  'clicks "Continue"': 'HELD',

  // ---- the same destruction, four spellings, all held ----
  'clicks "Delete"': 'HELD',
  'clicks the "Delete" icon': 'HELD',
  'clicks "Remove user"': 'HELD',
  'clicks the "trash" icon': 'HELD',
  // Nothing in the capture is named X, so the target is not found. Unchanged.
  'clicks "X"': 'refused: target-not-found',

  // ---- read-only controls: THE ROWS THAT MUST STILL RUN ----
  'clicks "Search"': 'allowed',
  'clicks "Filter"': 'allowed',
  'clicks "Cancel"': 'allowed',
  'clicks "Close"': 'allowed',
  'clicks "View"': 'allowed',
  'clicks "Next page"': 'allowed',
  'clicks the "Users" tab': 'allowed',
  // Export is treated as a READ. It produces a file and may write an audit entry;
  // it does not change a record a QA would be shown. Decision and reason in
  // `docs/WHERE-WE-ARE.md`.
  'clicks "Export"': 'allowed',
  // A DECLARED KNOWN FALSE HOLD. `edit` stays an unanchored stem for v1, so
  // `Edit` — which only opens a form — is held. Recorded rather than fixed,
  // because narrowing `edit` would let `edited`/`editing` through.
  'clicks "Edit"': 'HELD',
};

test.describe('the write gate is fail-closed (B/C/D) @unit', () => {
  test('every audited phrase lands on its pre-registered verdict', () => {
    // wrong: 23 of these are `allowed` and would run against a live system — a
    // checkbox click that grants a role, an Approve that advances a document, and
    // a two-step delete whose second step is a bare "Yes". Measured 2026-09-29.
    //
    // Discriminating: eight rows must come out `allowed`, so a gate that held
    // everything differs from this table on eight rows. That is the failure mode
    // this fix is most likely to have — a rule that refuses everything is
    // satisfied by knowing nothing.
    const actual = Object.fromEntries(
      Object.keys(EXPECTED).map((clause) => [clause, verdictOf(clause)]),
    );
    expect(actual).toEqual(EXPECTED);
  });

  test('B is decided by the RESOLVED ROLE, not by the name', () => {
    // wrong: the rule is a list of control names, so the next checkbox with an
    // unfamiliar label goes through. Five fail-open findings this month were word
    // lists; the role comes from the capture and no new label can defeat it.
    //
    // Discriminating by construction: the SAME NAME in two roles, two verdicts.
    const twoRoles: BoundedCapture = {
      ...capture,
      states: [
        {
          id: 'screen',
          label: 'screen',
          url: 'x',
          nodes: [node('checkbox', 'Widget'), node('heading', 'Done')],
          truncated: false,
        },
      ],
    };
    const asButton: BoundedCapture = {
      ...capture,
      states: [
        {
          id: 'screen',
          label: 'screen',
          url: 'x',
          nodes: [node('button', 'Widget'), node('heading', 'Done')],
          truncated: false,
        },
      ],
    };
    const rowFor = (c: BoundedCapture) => {
      seq += 1;
      const row: AuthoredRow = {
        rowId: `BR${seq} / TC_1`,
        scenarioId: `BR${seq}`,
        testCaseId: 'TC_1',
        sheetRow: 2,
        module: 'M',
        feature: '',
        scenarioName: '',
        objective: '',
        testType: '',
        priority: '',
        preconditions: '',
        testData: '',
        type: '',
        clauses: [{ text: 'clicks "Widget"', source: 'when', kind: 'action' }],
      };
      return resolveAuthoredRow(row, c, 'screen').writeRisk;
    };

    expect(rowFor(twoRoles)).toBe('creates-data');
    expect(rowFor(asButton)).toBe('read-only');
  });

  test('the gate reads ACTION clauses only — not a Then, not the title', () => {
    // wrong: a pure assertion holds the whole row. `verify the record was created
    // successfully` in a Then column, or a `scenarioName` of "employee is
    // created", held rows that do nothing but read — measured, and the row-level
    // reach is invisible in any control-level count.
    expect(
      assessAuthoredWriteRisk({
        actionClauses: ['clicks "Search"'],
        targets: [{ role: 'button', name: 'Search' }],
      }).risk,
    ).toBe('read-only');

    // The whole row is still held when ANY action clause writes: no partial run.
    expect(
      assessAuthoredWriteRisk({
        actionClauses: ['clicks "Search"', 'clicks "Delete"'],
        targets: [
          { role: 'button', name: 'Search' },
          { role: 'button', name: 'Delete' },
        ],
      }).risk,
    ).toBe('creates-data');
  });

  test('§W: a read-only name carrying a write stem stays ALLOWED', () => {
    // wrong: every widened stem is an unanchored prefix, so `\badd` matches
    // "Address" and `\bnew` matches "News" — measured on today's list, where both
    // are already FALSE HOLDS before a single word was added.
    //
    // Each pair is the same stem in two words: the read-only one must pass and the
    // write one must not, which is the only shape that tests the anchoring rather
    // than the list.
    const pairs: Array<[string, string, string]> = [
      ['add', 'Address', 'Add employee'],
      ['add', 'Additional details', 'Add row'],
      ['new', 'News', 'New request'],
      ['new', 'Newest first', 'New folder'],
      ['sign', 'Sign in', 'Sign document'],
      ['sign', 'Sign out', 'Signature'],
      ['clear', 'Clear filter', 'Clear data'],
      ['reset', 'Reset filters', 'Reset password'],
    ];
    for (const [stem, readOnly, write] of pairs) {
      const allowed = assessAuthoredWriteRisk({
        actionClauses: [`clicks "${readOnly}"`],
        targets: [{ role: 'button', name: readOnly }],
      });
      const held = assessAuthoredWriteRisk({
        actionClauses: [`clicks "${write}"`],
        targets: [{ role: 'button', name: write }],
      });
      expect(allowed.risk, `${stem}: "${readOnly}" must be allowed`).toBe('read-only');
      expect(held.risk, `${stem}: "${write}" must be held`).toBe('creates-data');
    }
  });

  test('C: a two-step delete is held as ONE row, and nothing runs', async () => {
    // wrong: both steps are allowed. Measured 2026-09-29 — `clicks the "trash"
    // icon` had no write word (`trash` was not in the list) and `clicks "Yes"` had
    // none either, because only `Confirm` was. So the row ran, clicked the trash
    // icon, clicked Yes, and reported a pass with a record destroyed.
    //
    // Held is a ROW verdict, not a step verdict: a partial run would leave the
    // application in a state nobody described. The invariant that falls out is
    // checkable, and is the second half of this test.
    seq += 1;
    const row: AuthoredRow = {
      rowId: `TS${seq} / TC_1`,
      scenarioId: `TS${seq}`,
      testCaseId: 'TC_1',
      sheetRow: 2,
      module: 'M',
      feature: '',
      scenarioName: '',
      objective: '',
      testType: '',
      priority: '',
      preconditions: '',
      testData: '',
      type: '',
      clauses: [
        { text: 'clicks the "trash" icon', source: 'when', kind: 'action' },
        { text: 'clicks "Yes"', source: 'and', kind: 'action' },
        { text: 'verify the "Done" heading is visible', source: 'then', kind: 'assert' },
      ],
    };
    const resolved = resolveAuthoredRow(row, capture, 'screen');
    expect(resolved.outcome, 'the row must RESOLVE, or this measures a refusal').not.toBe(
      'row-unclear',
    );
    expect(resolved.writeRisk).toBe('creates-data');
    // Both steps resolved, so the row really would have run both of them.
    expect(resolved.steps.filter((s) => s.kind === 'action')).toHaveLength(2);

    let executorCalls = 0;
    const run = await executeAuthoredRows({
      resolved: [resolved],
      unreadable: [],
      entry: { moduleOf: () => 'M', verify: async () => ({ verified: true }) },
      execute: async () => {
        executorCalls += 1;
        return { kind: 'passed', observed: 'clicked' };
      },
    });

    const result = run.results[0]!;
    expect(result.status).toBe('held');
    // THE INVARIANT: held means nothing ran. Two ways of saying it, because
    // `stepsRun` is the platform's own claim and the call count is the fact.
    expect(result.stepsRun).toBe(0);
    expect(executorCalls).toBe(0);
    // And the reason names the confirmation control, not just "would write".
    expect(result.detail).toMatch(/confirmation/i);
  });

  test('the hold NAMES why, so a reader can tell a role from a word', () => {
    // wrong: every held row says "this would create, modify or delete data", so a
    // QA cannot tell a checkbox held by its role from a button held by its label —
    // and only the second is something they could rephrase.
    const byRole = assessAuthoredWriteRisk({
      actionClauses: ['clicks "Widget"'],
      targets: [{ role: 'checkbox', name: 'Widget' }],
    });
    expect(byRole.why).toContain('checkbox');

    const byWord = assessAuthoredWriteRisk({
      actionClauses: ['clicks "Approve"'],
      targets: [{ role: 'button', name: 'Approve' }],
    });
    expect(byWord.why).toContain('approv');

    const byConfirm = assessAuthoredWriteRisk({
      actionClauses: ['clicks "OK"'],
      targets: [{ role: 'button', name: 'OK' }],
    });
    expect(byConfirm.why).toMatch(/confirmation/i);
  });
});

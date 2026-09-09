import { test, expect } from '@playwright/test';
import {
  describeUnreadableRow,
  extractTarget,
  resolveAuthoredRow,
  type AccessibilityNode,
  type AuthoredRow,
  type BoundedCapture,
  type CapturedState,
} from '@aitp/shared';
import { loadEnvironment } from '@aitp/execution-engine';

/**
 * Expectations derive from `docs/phase-2-authored-cases.md` §2b, §2c and §2d,
 * written before this code (rule 4).
 *
 *   C1  the COLUMN's clause kind is authoritative and is never re-derived
 *   C2  the one place classification is needed is a split And-half, and it refuses
 *   C3  credentials never come from the sheet
 *   C4  row 208 is a QA-facing output, not a skip count
 */

const node = (
  role: string,
  name: string,
  extra: Partial<AccessibilityNode> = {},
): AccessibilityNode => ({ role, name, enabled: true, ...extra });

const state = (id: string, nodes: AccessibilityNode[]): CapturedState => ({
  id,
  label: id,
  url: `https://app.example/${id}`,
  nodes,
  truncated: false,
});

const CAPTURE: BoundedCapture = {
  sessionId: 's',
  states: [
    state('login', [
      node('button', 'Sign in'),
      node('tab', 'Summary', { selected: true }),
      node('button', 'Clear', { enabled: false }),
    ]),
  ],
  transitions: [],
  selection: { keywords: [], available: [], chosen: [], excluded: [] },
};

const rowOf = (clauses: AuthoredRow['clauses'], over: Partial<AuthoredRow> = {}): AuthoredRow => ({
  rowId: 'SI_001 / TC_001',
  scenarioId: 'SI_001',
  testCaseId: 'TC_001',
  sheetRow: 3,
  module: 'Login',
  feature: 'Sign in',
  scenarioName: 'valid login',
  objective: 'sign in works',
  testType: 'Functional',
  priority: 'High',
  preconditions: '',
  testData: '',
  type: 'Positive',
  clauses,
  ...over,
});

test.describe('the column decides the clause kind (C1) @unit', () => {
  test('C1: a Then clause is an assertion because the COLUMN says so', () => {
    const resolved = resolveAuthoredRow(
      rowOf([{ text: 'the Summary should be selected', source: 'then', kind: 'assert' }]),
      CAPTURE,
      'login',
    );
    expect(resolved.clauseKinds).toEqual(['assert']);
    expect(resolved.steps[0]!.kind).toBe('assert');
  });

  test('C1: a When clause is an action because the COLUMN says so', () => {
    const resolved = resolveAuthoredRow(
      rowOf([{ text: 'click on the Sign in button', source: 'when', kind: 'action' }]),
      CAPTURE,
      'login',
    );
    expect(resolved.steps[0]!.kind).toBe('action');
  });

  /**
   * The heart of §2b, and the mirror of the `checkGrounding` override test.
   *
   * There, the model's `observed` label loses to the capture. Here, any
   * reclassification of the text loses to the column — because the column is a
   * human saying what this clause is, and the moment a tie-break exists the
   * model has become the authority over the QA who wrote the sheet.
   */
  test('C1: text that READS like an action is still an assertion if the column says assert', () => {
    // "click" is the strongest possible action signal. The column says Then.
    const resolved = resolveAuthoredRow(
      rowOf([{ text: 'click the "Sign in" button should be visible', source: 'then', kind: 'assert' }]),
      CAPTURE,
      'login',
    );
    expect(resolved.steps[0]!.kind).toBe('assert');
    expect(resolved.clauseKinds).toEqual(['assert']);
  });

  test('C1: text that READS like an assertion is still an action if the column says action', () => {
    // The discriminating half. Without it, a resolver that ignored the column
    // and always produced assertions would pass the test above.
    const resolved = resolveAuthoredRow(
      rowOf([{ text: 'verify by clicking "Sign in"', source: 'when', kind: 'action' }]),
      CAPTURE,
      'login',
    );
    expect(resolved.steps[0]!.kind).toBe('action');
  });

  test('C1: the kind carried out is exactly the kind carried in', () => {
    const clauses: AuthoredRow['clauses'] = [
      { text: 'click "Sign in"', source: 'when', kind: 'action' },
      { text: 'the Summary should be selected', source: 'then', kind: 'assert' },
    ];
    const resolved = resolveAuthoredRow(rowOf(clauses), CAPTURE, 'login');
    expect(resolved.clauseKinds).toEqual(clauses.map((c) => c.kind));
  });

  test('C1: extractTarget cannot express a kind, so it cannot disagree about one', () => {
    // Structural, not a convention: the function's return type has no room for
    // a kind. That is what makes "the column wins" impossible to forget.
    const target = extractTarget('click on the Sign in button');
    expect(typeof target).toBe('string');
    expect(target).toBe('Sign in');
  });
});

test.describe('the one place classification is needed (C2) @unit', () => {
  test('C2: an unclassified And-half is refused, naming the row and the clause', () => {
    const resolved = resolveAuthoredRow(
      rowOf([
        {
          text: 'And correct password',
          source: 'and',
          kind: 'unclassified',
          why: 'no leading action or assertion verb — a human must say which this is',
        },
      ]),
      CAPTURE,
      'login',
    );

    expect(resolved.outcome).toBe('row-unclear');
    expect(resolved.owner).toBe('qa');
    expect(resolved.refusals[0]!.reason).toContain('SI_001 / TC_001');
    expect(resolved.refusals[0]!.reason).toContain('And correct password');
    expect(resolved.steps).toEqual([]);
  });

  test('C2: an unclassified half that WOULD resolve is still refused', () => {
    // The discriminating fixture, and the counterfactual stated before it is
    // used: under a resolver that GUESSED a kind, this row resolves to "ok",
    // because "Sign in" is quoted and resolves to exactly one node. Under the
    // correct behaviour it is refused. The earlier fixture ("And correct
    // password") could not tell the two apart — it has no resolvable target, so
    // a guessing resolver refuses it anyway, for a different reason.
    const resolved = resolveAuthoredRow(
      rowOf([
        {
          text: 'the "Sign in" button',
          source: 'and',
          kind: 'unclassified',
          why: 'no leading action or assertion verb',
        },
      ]),
      CAPTURE,
      'login',
    );

    expect(resolved.outcome).toBe('row-unclear');
    expect(resolved.refusals[0]!.why).toBe('unparseable-step');
    expect(resolved.refusals[0]!.reason).toContain('SI_001 / TC_001');
    // Proof the fixture is discriminating: the target really does resolve.
    expect(extractTarget('the "Sign in" button')).toBe('Sign in');
  });

  test('C2: a classified And-half alongside it still resolves on its own merits', () => {
    // Discriminating: refusal is per clause, and the "&" split produced two
    // halves of which only one is unclear.
    const resolved = resolveAuthoredRow(
      rowOf([{ text: 'Click on the "Sign in" button', source: 'and', kind: 'action' }]),
      CAPTURE,
      'login',
    );
    expect(resolved.outcome).toBe('ok');
  });
});

/**
 * C3 — CREDENTIALS NEVER COME FROM THE SHEET.
 *
 * The Test Data column is redacted at read, and authentication comes from the
 * environment. **This became more important, not less**: the account was
 * briefly rotated and has been rotated back, so the sheet's credentials are
 * live again. While they were dead, a resolver that authenticated from the
 * sheet would have failed loudly on its first run. The same bug now succeeds
 * SILENTLY.
 *
 * Both directions are asserted, because a single-sided check is satisfied by a
 * resolver that reads neither source.
 */
test.describe('credentials never come from the sheet (C3) @unit', () => {
  const withCredentials = rowOf(
    [{ text: 'click "Sign in"', source: 'when', kind: 'action' }],
    { testData: 'mail id : ***redacted***  Password : ***redacted***' },
  );

  test('C3: nothing resolved from a row carries a credential forward', () => {
    const resolved = resolveAuthoredRow(withCredentials, CAPTURE, 'login');
    const serialised = JSON.stringify(resolved);
    expect(serialised).not.toMatch(/@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    // The Test Data cell does not travel into the resolved row at all.
    expect(serialised).not.toContain('mail id');
    expect(serialised).not.toContain('Password :');
  });

  test('C3: the environment IS the source of credentials', () => {
    // The discriminating half. Without it, a platform that read credentials
    // from NOWHERE would pass the test above while being equally broken.
    const admin = loadEnvironment('local').users.admin;
    expect(admin).toBeDefined();
    expect(admin!.username.length).toBeGreaterThan(0);
    expect(admin!.password.length).toBeGreaterThan(0);
  });

  test('C3: the resolver module never reads a credential field', () => {
    // A row's own fields are all it can see, and `testData` is redacted before
    // it ever gets here. Asserted on the resolved output rather than by
    // reading source, so it holds whatever the implementation does.
    const resolved = resolveAuthoredRow(withCredentials, CAPTURE, 'login');
    expect(Object.keys(resolved)).not.toContain('testData');
    expect(Object.keys(resolved)).not.toContain('password');
  });
});

test.describe('an orphaned row is a QA-facing output (C4) @unit', () => {
  test('C4: a content-without-identity row is handed back with its content', () => {
    // Row 208 of the real sheet. A skip count is a number nobody acts on.
    const described = describeUnreadableRow({
      sheetRow: 208,
      why: 'content-without-identity',
      reason: 'row 208 carries 2 real clause(s) but no Scenario ID',
      orphanedContent: [
        'And: Page refresh (F5, hard refresh)',
        'Then: The workspace should be restored',
      ],
    });

    expect(described.actionable).toBe(true);
    expect(described.owner).toBe('qa');
    expect(described.message).toContain('a test case is being lost');
    expect(described.message).toContain('Page refresh (F5, hard refresh)');
    expect(described.message).toContain('The workspace should be restored');
    expect(described.message).toContain('give the row a Scenario ID and a Test Case ID');
  });

  test('C4: a stray-cell row is NOT dressed up as actionable', () => {
    // Row 15. The discriminating half: if every unreadable row were reported as
    // recoverable, a QA would waste time on sheet detritus and stop trusting
    // the report.
    const described = describeUnreadableRow({
      sheetRow: 15,
      why: 'stray-cells',
      reason: 'row 15 has a few stray cells and no identity or clauses — sheet detritus',
    });

    expect(described.actionable).toBe(false);
    expect(described.message).not.toContain('being lost');
  });
});

/**
 * C5 — the SEAM between the resolver and the executor.
 *
 * Found on 2026-09-09 while preparing the first live run, by a script that
 * resolved a row and printed what the executor would receive. Every unit test
 * on both sides passed: the resolver's asserted outcomes and refusals, the
 * executor's were handed `targets` directly by their own fixtures. **Nothing
 * asserted that the thing one side produces is the thing the other consumes**,
 * and the `ok` return — the only outcome meaning "ready to run" — dropped it.
 *
 * The failure direction is the bad one: the row is perfect, the platform loses
 * its own data, and the report tells the QA their row could not be verified.
 */
test.describe('the resolver hands the executor its targets (C5) @unit', () => {
  test('C5: an "ok" row carries a target for every step', () => {
    // wrong: with `targets` dropped on this path the array is empty, the
    // executor gets no target, returns `no-observable-check`, and this perfect
    // row is reported to the QA as unverifiable.
    const resolved = resolveAuthoredRow(
      rowOf([{ text: 'click on the Sign in button', source: 'when', kind: 'action' }]),
      CAPTURE,
      'login',
    );

    expect(resolved.outcome).toBe('ok');
    expect(resolved.targets.length).toBe(resolved.steps.length);
    expect(resolved.targets[0]).toEqual({ stepIndex: 0, role: 'button', name: 'Sign in' });
  });

  test('C5: every resolving outcome carries them, not just one', () => {
    // wrong: fixed only on the `ok` path, `app-disagrees` and `capture-thin`
    // rows still reach the executor blind — and those are the rows a run most
    // needs to be right about.
    const outcomes = new Set<string>();
    const cases: AuthoredRow['clauses'][] = [
      [{ text: 'click on the Sign in button', source: 'when', kind: 'action' }],
      [{ text: 'the Clear should be enabled', source: 'then', kind: 'assert' }],
    ];
    for (const clauses of cases) {
      const resolved = resolveAuthoredRow(rowOf(clauses), CAPTURE, 'login');
      outcomes.add(resolved.outcome);
      expect(resolved.targets.length).toBe(resolved.steps.length);
      expect(resolved.steps.length).toBeGreaterThan(0);
    }
    // The discriminating half: two DIFFERENT outcomes were exercised, so this
    // cannot pass by only ever visiting the one path that was fixed.
    expect(outcomes.size).toBeGreaterThan(1);
  });
});

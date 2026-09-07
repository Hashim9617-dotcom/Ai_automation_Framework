import { test, expect } from '@playwright/test';
import {
  PROMPT_VERSION,
  assessWriteRisk,
  buildProposal,
  proposableAssertions,
  type BoundedCapture,
  type ModelCase,
} from '@aitp/shared';

/**
 * Expectations derive from `docs/phase-2-generation.md`, "The output record" —
 * not from reading `proposal.ts` (rule 4).
 *
 *   M1  the model's label is a CLAIM; checkGrounding re-derives and overrides
 *   M2  the override is auditable — both labels survive on the record
 *   M3  the proposal records what the model was SHOWN, not only what it said
 *   M4  only OBSERVED assertions are proposable
 *   M5  a case that would create data is marked and held
 *
 * Every fixture below is built so that TRUSTING THE MODEL GIVES A VISIBLY
 * WRONG ANSWER. A fixture where the model's label and the derived grade agree
 * cannot distinguish "we re-derived" from "we believed the model" — that is
 * the vacuous-mutation shape, and it is the specific trap this file exists to
 * avoid.
 */

const capture: BoundedCapture = {
  sessionId: 'test',
  states: [
    {
      id: 'admin.create-role',
      label: 'Create Role dialog',
      url: 'https://app.example/admin',
      truncated: false,
      // `Create` is ENABLED on an empty form — Finding 9's real contract.
      nodes: [
        { role: 'button', name: 'Create', enabled: true },
        { role: 'button', name: 'Clear', enabled: true },
      ],
    },
  ],
  transitions: [],
  selection: {
    keywords: ['create', 'role'],
    available: [
      { id: 'admin.create-role', score: 2 },
      { id: 'files.tree', score: 0 },
    ],
    chosen: [{ id: 'admin.create-role', score: 2, why: 'score' }],
    excluded: [{ id: 'files.tree', score: 0, why: 'below-cut' }],
  },
};

const build = (modelCase: ModelCase) =>
  buildProposal({
    id: 'p1',
    sourceCommand: 'test the create role form',
    model: 'claude-sonnet-4-5',
    promptVersion: PROMPT_VERSION,
    capture,
    modelCase,
    now: '2026-09-07T00:00:00.000Z',
  });

test.describe('proposal — the model label is a claim, not an answer (M1-M2) @unit', () => {
  test('M1: the model says OBSERVED, the capture contradicts it -> CONTRADICTED', () => {
    // Finding 9 exactly: the model confidently asserts the mistake we made by
    // hand. Believing its label would put a false claim on the record as
    // evidence-backed; the capture says `Create` is enabled.
    const proposal = build({
      title: 'Create is disabled on an empty form',
      entryState: 'admin.create-role',
      steps: [
        {
          kind: 'assert',
          role: 'button',
          name: 'Create',
          property: 'enabled',
          expected: false,
          modelSaid: 'observed',
        },
      ],
    });

    const assertion = proposal.assertions[0]!;
    expect(assertion.modelSaid).toBe('observed'); // what it claimed
    expect(assertion.grade).toBe('contradicted'); // what the capture says
    expect(assertion.overrodeModel).toBe(true);
    expect(assertion.evidence).toBeNull();
  });

  test('M1: the override fires the other way too — model says ASSUMED, capture shows it', () => {
    // The discriminating pair. Without this, an implementation that simply
    // hard-coded `contradicted` would pass the test above.
    const proposal = build({
      title: 'Create is enabled',
      entryState: 'admin.create-role',
      steps: [
        {
          kind: 'assert',
          role: 'button',
          name: 'Create',
          property: 'enabled',
          expected: true,
          modelSaid: 'assumed',
        },
      ],
    });

    const assertion = proposal.assertions[0]!;
    expect(assertion.modelSaid).toBe('assumed');
    expect(assertion.grade).toBe('observed');
    expect(assertion.overrodeModel).toBe(true);
  });

  test('M2: when the two agree, nothing is recorded as an override', () => {
    // Third leg: proves `overrodeModel` tracks disagreement rather than being
    // always-true.
    const proposal = build({
      title: 'Create is enabled',
      entryState: 'admin.create-role',
      steps: [
        {
          kind: 'assert',
          role: 'button',
          name: 'Create',
          property: 'enabled',
          expected: true,
          modelSaid: 'observed',
        },
      ],
    });
    expect(proposal.assertions[0]!.overrodeModel).toBe(false);
    expect(proposal.assertions[0]!.grade).toBe('observed');
  });

  test('M2: both labels survive on the record', () => {
    const proposal = build({
      title: 'x',
      entryState: 'admin.create-role',
      steps: [
        {
          kind: 'assert',
          role: 'button',
          name: 'Create',
          property: 'enabled',
          expected: false,
          modelSaid: 'observed',
        },
      ],
    });
    // Collapsing these into one field would hide the override rate, which is
    // the signal about prompt quality.
    expect(Object.keys(proposal.assertions[0]!)).toEqual(
      expect.arrayContaining(['modelSaid', 'grade', 'overrodeModel', 'reason']),
    );
  });
});

test.describe('proposal — what the model was shown (M3) @unit', () => {
  test('M3: provenance records the prompt version, capture digest and selection', () => {
    const proposal = build({
      title: 'x',
      entryState: 'admin.create-role',
      steps: [
        { kind: 'assert', role: 'button', name: 'Create', property: 'enabled', expected: true, modelSaid: 'observed' },
      ],
    });

    expect(proposal.provenance.promptVersion).toBe(PROMPT_VERSION);
    expect(proposal.provenance.captureDigest.length).toBeGreaterThan(0);

    // The point: "the model invented it" and "bounding dropped the state it
    // needed" must be distinguishable after the fact.
    expect(proposal.provenance.selection.excluded.map((e) => e.id)).toContain('files.tree');
    expect(proposal.provenance.selection.chosen.map((c) => c.id)).toContain('admin.create-role');
  });

  test('M3: the capture digest on the record matches the capture that was graded', () => {
    const a = build({
      title: 'x',
      entryState: 'admin.create-role',
      steps: [
        { kind: 'assert', role: 'button', name: 'Create', property: 'enabled', expected: true, modelSaid: 'observed' },
      ],
    });
    const changed: BoundedCapture = {
      ...capture,
      states: [{ ...capture.states[0]!, nodes: [{ role: 'button', name: 'Create', enabled: false }] }],
    };
    const b = buildProposal({
      id: 'p2',
      sourceCommand: 'test the create role form',
      model: 'claude-sonnet-4-5',
      promptVersion: PROMPT_VERSION,
      capture: changed,
      modelCase: {
        title: 'x',
        entryState: 'admin.create-role',
        steps: [
          { kind: 'assert', role: 'button', name: 'Create', property: 'enabled', expected: true, modelSaid: 'observed' },
        ],
      },
    });
    expect(a.provenance.captureDigest).not.toBe(b.provenance.captureDigest);
  });
});

test.describe('proposal — only observed assertions are proposable (M4) @unit', () => {
  test('M4: contradicted and assumed assertions are recorded but not proposable', () => {
    const proposal = build({
      title: 'mixed',
      entryState: 'admin.create-role',
      steps: [
        { kind: 'assert', role: 'button', name: 'Create', property: 'enabled', expected: true, modelSaid: 'observed' },
        { kind: 'assert', role: 'button', name: 'Create', property: 'enabled', expected: false, modelSaid: 'observed' },
        { kind: 'assert', role: 'button', name: 'Ghost', property: 'selected', expected: true, modelSaid: 'observed' },
      ],
    });

    expect(proposal.assertions.length).toBe(3); // all recorded, for diagnostics
    const proposable = proposableAssertions(proposal);
    expect(proposable.length).toBe(1);
    expect(proposable[0]!.claim.expected).toBe(true);
  });

  test('M4: an ungrounded assertion becomes an open question', () => {
    const proposal = build({
      title: 'x',
      entryState: 'admin.create-role',
      steps: [
        { kind: 'action', description: 'clicked something undeclared' },
        { kind: 'assert', role: 'button', name: 'Create', property: 'enabled', expected: true, modelSaid: 'observed' },
      ],
    });
    expect(proposal.openQuestions.length).toBe(1);
    expect(proposableAssertions(proposal).length).toBe(0);
  });
});

test.describe('proposal — write risk is marked and held (M5) @unit', () => {
  const readOnly: ModelCase = {
    title: 'the roles list loads',
    entryState: 'admin.create-role',
    steps: [
      { kind: 'assert', role: 'button', name: 'Clear', property: 'present', expected: true, modelSaid: 'observed' },
    ],
  };

  test('M5: a read-only case is marked read-only', () => {
    expect(assessWriteRisk(readOnly)).toBe('read-only');
  });

  test('M5: a case that creates data is marked creates-data', () => {
    // Discriminating against the test above: same shape, one write verb.
    expect(
      assessWriteRisk({
        ...readOnly,
        steps: [{ kind: 'action', description: 'clicked Create to save the new role' }, ...readOnly.steps],
      }),
    ).toBe('creates-data');
  });

  test('M5: a write verb in the TITLE is enough to hold it', () => {
    expect(assessWriteRisk({ ...readOnly, title: 'creates a role' })).toBe('creates-data');
  });

  test('M5: the risk reaches the proposal record', () => {
    const proposal = build({ ...readOnly, title: 'deletes a workspace' });
    expect(proposal.writeRisk).toBe('creates-data');
    expect(proposal.status).toBe('pending');
  });
});

/**
 * M6 — WRITE RISK NEEDS A NEGATIVE CASE OR IT IS UNTESTED.
 *
 * Erring toward holding is the right posture: a false "creates-data" costs a
 * held proposal a human waves through, a false "read-only" costs a generated
 * test that writes to a live customer system. Those are not symmetric.
 *
 * But that posture has a failure mode of its own, and it is design rule 2 in
 * `docs/phase-2-generation.md`:
 *
 * > **A criterion that can be satisfied by knowing nothing is not a criterion.**
 *
 * A classifier that returned `creates-data` unconditionally would satisfy
 * every positive test in this file — it would be perfectly safe and perfectly
 * useless, holding all four hundred read-only cases in the suite behind a
 * review queue nobody clears. So the criterion needs a half that ignorance
 * fails: a plainly read-only case must be classified read-only.
 */
test.describe('proposal — write risk has a negative case (M6) @unit', () => {
  /**
   * Read-only by every reading: it navigates and looks. Nothing here creates,
   * modifies or deletes anything, so a classifier that holds it is not being
   * careful — it is not looking.
   */
  const plainlyReadOnly: ModelCase = {
    title: 'the folder step shows its destination picker',
    entryState: 'admin.create-role',
    steps: [
      { kind: 'action', description: 'clicked the Roles tab' },
      { kind: 'assert', role: 'heading', name: 'Select destination folder', property: 'present', expected: true, modelSaid: 'observed' },
      { kind: 'assert', role: 'button', name: 'Clear', property: 'enabled', expected: true, modelSaid: 'observed' },
      { kind: 'assert', role: 'tab', name: 'Folder', property: 'selected', expected: true, modelSaid: 'observed' },
    ],
  };

  test('M6: a plainly read-only case is classified read-only', () => {
    // THE test an always-hold classifier fails. Verified by mutation on
    // 2026-09-07: replacing the body of assessWriteRisk with a bare
    // `return 'creates-data'` fails this and only this.
    expect(assessWriteRisk(plainlyReadOnly)).toBe('read-only');
  });

  test('M6: read-only survives every part of the case being inspected', () => {
    // Discriminating against a classifier that reads only the title, or only
    // the steps: one write verb in EITHER place must flip it, and none in
    // either must not.
    expect(assessWriteRisk({ ...plainlyReadOnly, title: 'creates a destination folder' })).toBe(
      'creates-data',
    );
    expect(
      assessWriteRisk({
        ...plainlyReadOnly,
        steps: [...plainlyReadOnly.steps, { kind: 'action', description: 'clicked Save' }],
      }),
    ).toBe('creates-data');
    expect(assessWriteRisk(plainlyReadOnly)).toBe('read-only');
  });

  test('M6: read-only reaches the proposal record, not just the classifier', () => {
    // Otherwise the field could be hard-wired to `creates-data` downstream and
    // every classifier test above would still pass.
    expect(build(plainlyReadOnly).writeRisk).toBe('read-only');
  });

  test('M6: the classifier holds on ambiguity, deliberately', () => {
    // A known and accepted false hold, recorded so it reads as a decision
    // rather than as a defect: the word list is matched at word boundaries and
    // is deliberately not clever, so "Address book" trips `add`. The cost is a
    // review click; the cost of the opposite mistake is a write to a live
    // customer system.
    expect(
      assessWriteRisk({
        ...plainlyReadOnly,
        steps: [{ kind: 'assert', role: 'link', name: 'Address book', property: 'present', expected: true, modelSaid: 'observed' }],
      }),
    ).toBe('creates-data');
  });
});

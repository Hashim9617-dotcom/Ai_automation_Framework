import { test, expect } from '@playwright/test';
import {
  assertionId,
  assertionIdsFor,
  checkGrounding,
  type AccessibilityNode,
  type AssertStep,
  type AssertionBasis,
  type CandidateCase,
  type CapturedState,
  type StateCapture,
} from '@aitp/shared';

/**
 * Expectations derive from `docs/phase-2-generation.md`, "Approval identity:
 * approvals must LAPSE, never transfer" — not from reading `identity.ts`
 * (rule 4).
 *
 *   A1  content is part of the identity, so changed content LAPSES approval
 *   A2  the PATH is part of the identity — same claim, different route
 *   A3  the GROUNDING BASIS is part of the identity — state and grade
 *   A4  duplicates do not share one approval
 *   A5  the step index is NOT part of the identity
 *
 * A3 and A4 are the two gaps content+path leaves. Both let one approval cover
 * something a reviewer never agreed to, which is rule 4's failure — an
 * unreviewed claim becoming a reviewed one — wearing different clothes.
 */

const claim: AssertStep = {
  kind: 'assert',
  role: 'tab',
  name: 'Folder',
  property: 'selected',
  expected: true,
};

const basis = (over: Partial<AssertionBasis> = {}): AssertionBasis => ({
  entryState: 'workspace',
  precedingActions: [],
  claim,
  stateId: 'workspace',
  grade: 'observed',
  occurrence: 0,
  ...over,
});

test.describe('assertion identity — content and path (A1-A2) @unit', () => {
  test('A1: the same claim on the same basis has a stable id', () => {
    expect(assertionId(basis())).toBe(assertionId(basis()));
  });

  test('A1: changing the asserted VALUE changes the id — approval lapses', () => {
    expect(assertionId(basis({ claim: { ...claim, expected: false } }))).not.toBe(
      assertionId(basis()),
    );
  });

  test('A1: changing the target changes the id', () => {
    expect(assertionId(basis({ claim: { ...claim, name: 'Workspace' } }))).not.toBe(
      assertionId(basis()),
    );
    expect(assertionId(basis({ claim: { ...claim, role: 'button' } }))).not.toBe(
      assertionId(basis()),
    );
    expect(assertionId(basis({ claim: { ...claim, property: 'present' } }))).not.toBe(
      assertionId(basis()),
    );
  });

  test('A2: the PATH is part of the identity — same claim, different route', () => {
    // "Folder is selected" after clicking a workspace tile is a different
    // claim from the same sentence after clicking Next. One must not approve
    // the other.
    expect(assertionId(basis({ precedingActions: ['clicked "WS-ALPHA"'] }))).not.toBe(
      assertionId(basis({ precedingActions: ['clicked Next'] })),
    );
  });

  test('A2: the entry state is part of the identity', () => {
    expect(assertionId(basis({ entryState: 'folder' }))).not.toBe(assertionId(basis()));
  });

  test('A2: action ORDER matters', () => {
    expect(assertionId(basis({ precedingActions: ['a', 'b'] }))).not.toBe(
      assertionId(basis({ precedingActions: ['b', 'a'] })),
    );
  });
});

test.describe('assertion identity — the grounding basis (A3) @unit', () => {
  test('A3: the same text graded in a DIFFERENT state gets a different id', () => {
    // An assertion approved while standing in state A must not carry to the
    // same sentence graded in state B: that is a different claim spelled the
    // same way, and the approval would cross a state boundary — the exact
    // thing per-assertion approval exists to prevent.
    expect(assertionId(basis({ stateId: 'upload.folder-step' }))).not.toBe(
      assertionId(basis({ stateId: 'upload.workspace-step' })),
    );
  });

  test('A3: an unknown cursor is its own basis, distinct from any named state', () => {
    expect(assertionId(basis({ stateId: null }))).not.toBe(assertionId(basis()));
  });

  test('A3: a REGRADE lapses the approval', () => {
    // What was approved changed: a reviewer accepted a fact and would now be
    // holding an open question. An id blind to the grade lets that survive.
    const observed = assertionId(basis({ grade: 'observed' }));
    const assumed = assertionId(basis({ grade: 'assumed' }));
    const contradicted = assertionId(basis({ grade: 'contradicted' }));
    expect(new Set([observed, assumed, contradicted]).size).toBe(3);
  });
});

test.describe('assertion identity — duplicates (A4) @unit', () => {
  test('A4: two identical assertions in one case get two distinct ids', () => {
    expect(assertionId(basis({ occurrence: 0 }))).not.toBe(assertionId(basis({ occurrence: 1 })));
  });
});

/**
 * The same rules again, but through `assertionIdsFor` — the function proposals
 * actually use. A basis-level test can pass while the walker never varies the
 * basis, which would leave every rule above true and unused.
 */
test.describe('assertionIdsFor threads the whole basis (A1-A5) @unit', () => {
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

  const capture: StateCapture = {
    sessionId: 's',
    states: [
      state('workspace', [node('tab', 'Workspace', { selected: true }), node('tab', 'Folder', { selected: false })]),
      state('folder', [node('tab', 'Folder', { selected: true })]),
    ],
    transitions: [
      { from: 'workspace', to: 'folder', action: 'clicked "WS-ALPHA"', verdict: 'consistent' },
    ],
  };

  const idsFor = (candidate: CandidateCase) =>
    assertionIdsFor(candidate, checkGrounding(capture, candidate));

  test('the preceding actions reach each assertion', () => {
    const ids = idsFor({
      entryState: 'workspace',
      steps: [
        { kind: 'action', description: 'clicked "WS-ALPHA"' },
        claim,
        { ...claim, name: 'Upload' },
      ],
    });

    expect(ids.length).toBe(2);
    expect(ids[0]!.precedingActions).toEqual(['clicked "WS-ALPHA"']);
    expect(ids[1]!.precedingActions).toEqual(['clicked "WS-ALPHA"']);
    expect(ids[0]!.assertionId).not.toBe(ids[1]!.assertionId);
  });

  test('A3: the same assertion before and after a transition gets different ids', () => {
    // The cursor moves from `workspace` to `folder`, so the same sentence is
    // graded against two different node sets. This is A3 through the walker:
    // the path differs too, but the derived stateId is what makes them two
    // different CLAIMS rather than two spellings of one.
    const ids = idsFor({
      entryState: 'workspace',
      steps: [claim, { kind: 'action', description: 'clicked "WS-ALPHA"' }, claim],
    });

    expect(ids.length).toBe(2);
    expect(ids[0]!.stateId).toBe('workspace');
    expect(ids[1]!.stateId).toBe('folder');
    expect(ids[0]!.grade).toBe('contradicted');
    expect(ids[1]!.grade).toBe('observed');
    expect(ids[0]!.assertionId).not.toBe(ids[1]!.assertionId);
  });

  test('A4: two identical assertions in one case get two distinct ids', () => {
    // Same text, same path, same cursor, same grade — everything a reviewer
    // reads is identical. One id would let a single approval cover both.
    const ids = idsFor({ entryState: 'folder', steps: [claim, claim] });

    expect(ids.length).toBe(2);
    expect(ids[0]!.stateId).toBe(ids[1]!.stateId);
    expect(ids[0]!.grade).toBe(ids[1]!.grade);
    expect(ids[0]!.occurrence).toBe(0);
    expect(ids[1]!.occurrence).toBe(1);
    expect(ids[0]!.assertionId).not.toBe(ids[1]!.assertionId);
  });

  test('A5: an id does NOT depend on the step index', () => {
    // Otherwise inserting an unrelated assertion earlier in the case would
    // lapse every approval below it, for no reason a human would recognise.
    // The occurrence counter must not reintroduce this: it only advances for a
    // genuine duplicate, so an unrelated neighbour leaves it at zero.
    const withPrefix = idsFor({
      entryState: 'folder',
      steps: [{ ...claim, name: 'Something Else', property: 'present' }, claim],
    });
    const withoutPrefix = idsFor({ entryState: 'folder', steps: [claim] });

    expect(withPrefix[1]!.occurrence).toBe(0);
    expect(withPrefix[1]!.assertionId).toBe(withoutPrefix[0]!.assertionId);
  });

  test('a grounding result for a different case is refused, not silently used', () => {
    // Identity now depends on the grading, so pairing the wrong one would
    // stamp an id from a basis that was never measured.
    const candidate: CandidateCase = { entryState: 'folder', steps: [claim, claim] };
    const other = checkGrounding(capture, { entryState: 'folder', steps: [claim] });
    expect(() => assertionIdsFor(candidate, other)).toThrow(/different case/);
  });
});

import { test, expect } from '@playwright/test';
import {
  checkGrounding,
  type CandidateCase,
  type CapturedState,
  type DeclaredTransition,
  type StateCapture,
} from '@aitp/shared';

/**
 * `checkGrounding()` is to generation what `gate.ts` is to healing: the
 * deterministic judge that decides whether a model's claim is backed by
 * evidence. It gets the same table-driven, per-rule coverage.
 *
 * **Every expectation here is derived from `docs/phase-2-generation.md`, the
 * reviewed design — never from reading `grounding.ts`.** That is rule 4 of
 * that document, learned the hard way the day before this file was written: a
 * model-pricing test asserted what the implementation *did* rather than what
 * was *correct*, and so certified a bug instead of catching it. The same
 * process that writes an implementation writes its tests, and inherits the
 * same misconception; the only defence is taking expectations from an external
 * source of truth. Here that source is the design document.
 *
 * Where design and implementation disagree, the finding is reported, not
 * tested around.
 *
 * Rule references below map to the design:
 *   G1-G3  the three grade definitions
 *   C3-C6  the state cursor
 *   S1     a `suspect` transition can support a question, never an OBSERVED assertion
 *   T1     absence is evidence only in a COMPLETE view (rule 1 / Finding 15)
 *   P1     an unrecorded property is SILENCE, never `false`
 *   Z1     a case with zero observed assertions is a question, not a case
 */

function state(
  id: string,
  nodes: CapturedState['nodes'],
  truncated = false,
): CapturedState {
  return { id, label: id, url: `https://app.example/${id}`, nodes, truncated };
}

function capture(states: CapturedState[], transitions: DeclaredTransition[] = []): StateCapture {
  return { sessionId: 'test', states, transitions };
}

const WORKSPACE = state('workspace', [
  { role: 'tab', name: 'Workspace', enabled: true, selected: true },
  { role: 'tab', name: 'Folder', enabled: true, selected: false },
  { role: 'button', name: 'Next', enabled: false },
]);

const FOLDER = state('folder', [
  { role: 'tab', name: 'Workspace', enabled: true, selected: false },
  { role: 'tab', name: 'Folder', enabled: true, selected: true },
  { role: 'button', name: 'Root folder', enabled: true },
]);

const CONSISTENT: DeclaredTransition = {
  from: 'workspace',
  to: 'folder',
  action: 'clicked "WS-ALPHA"',
  verdict: 'consistent',
};

const assertStep = (
  role: string,
  name: string,
  property: 'present' | 'enabled' | 'selected',
  expected: boolean,
): CandidateCase['steps'][number] => ({ kind: 'assert', role, name, property, expected });

const onlyStep = (entryState: string, step: CandidateCase['steps'][number]): CandidateCase => ({
  entryState,
  steps: [step],
});

test.describe('checkGrounding — grade semantics (G1-G3) @unit', () => {
  test('G1: a node present with the asserted value is OBSERVED', () => {
    const result = checkGrounding(
      capture([WORKSPACE]),
      onlyStep('workspace', assertStep('tab', 'Workspace', 'selected', true)),
    );
    expect(result.steps[0]!.grade).toBe('observed');
  });

  test('G3: a node absent from a COMPLETE capture positively disagrees — CONTRADICTED', () => {
    const result = checkGrounding(
      capture([WORKSPACE]),
      onlyStep('workspace', assertStep('button', 'Download File', 'present', true)),
    );
    expect(result.steps[0]!.grade).toBe('contradicted');
  });

  test('G2: a state that was never captured is silence — ASSUMED', () => {
    const result = checkGrounding(
      capture([WORKSPACE]),
      onlyStep('never-captured', assertStep('tab', 'Workspace', 'selected', true)),
    );
    expect(result.steps[0]!.grade).toBe('assumed');
  });
});

test.describe('checkGrounding — the state cursor (C3-C6) @unit', () => {
  test('C3: an assertion is graded against the ENTRY state', () => {
    // "Folder" is selected in `folder` and not in `workspace`. Entering at
    // `workspace`, the claim that it is selected must be contradicted.
    const result = checkGrounding(
      capture([WORKSPACE, FOLDER]),
      onlyStep('workspace', assertStep('tab', 'Folder', 'selected', true)),
    );
    expect(result.steps[0]!.grade).toBe('contradicted');
  });

  test('C4: a matching consistent transition advances the cursor', () => {
    const result = checkGrounding(capture([WORKSPACE, FOLDER], [CONSISTENT]), {
      entryState: 'workspace',
      steps: [
        { kind: 'action', description: 'clicked "WS-ALPHA"' },
        assertStep('tab', 'Folder', 'selected', true),
      ],
    });
    expect(result.steps[1]!.grade).toBe('observed');
    expect(result.steps[1]!.stateId).toBe('folder');
  });

  test('C4: an action with no declared transition makes the cursor unknown', () => {
    const result = checkGrounding(capture([WORKSPACE, FOLDER], [CONSISTENT]), {
      entryState: 'workspace',
      steps: [
        { kind: 'action', description: 'clicked Next' }, // never declared
        assertStep('tab', 'Folder', 'selected', true),
      ],
    });
    expect(result.steps[1]!.grade).toBe('assumed');
    expect(result.steps[1]!.stateId).toBeNull();
  });

  test('C5: once unknown, a downstream assertion is ASSUMED even though the node exists', () => {
    // `tab Folder selected=true` genuinely exists in the `folder` state. The
    // design still requires ASSUMED, because we no longer know where we are.
    const result = checkGrounding(capture([WORKSPACE, FOLDER], [CONSISTENT]), {
      entryState: 'workspace',
      steps: [
        { kind: 'action', description: 'clicked Next' },
        assertStep('tab', 'Folder', 'selected', true),
      ],
    });
    expect(result.steps[1]!.grade).toBe('assumed');
  });

  test('C5: unknown is ABSORBING — a later valid action cannot re-anchor it', () => {
    const result = checkGrounding(capture([WORKSPACE, FOLDER], [CONSISTENT]), {
      entryState: 'workspace',
      steps: [
        { kind: 'action', description: 'clicked Next' }, // -> unknown
        { kind: 'action', description: 'clicked "WS-ALPHA"' }, // declared, but too late
        assertStep('tab', 'Folder', 'selected', true),
      ],
    });
    expect(result.steps[1]!.grade).toBe('assumed');
    expect(result.steps[2]!.grade).toBe('assumed');
  });

  test('C6: a node present only in ANOTHER state does not ground anything', () => {
    const result = checkGrounding(
      capture([WORKSPACE, FOLDER]),
      onlyStep('workspace', assertStep('button', 'Root folder', 'present', true)),
    );
    expect(result.steps[0]!.grade).not.toBe('observed');
  });

  test('C6: the same role+name in two states is graded against the cursor state only', () => {
    const inWorkspace = checkGrounding(
      capture([WORKSPACE, FOLDER]),
      onlyStep('workspace', assertStep('tab', 'Workspace', 'selected', true)),
    );
    const inFolder = checkGrounding(
      capture([WORKSPACE, FOLDER]),
      onlyStep('folder', assertStep('tab', 'Workspace', 'selected', true)),
    );
    expect(inWorkspace.steps[0]!.grade).toBe('observed');
    expect(inFolder.steps[0]!.grade).toBe('contradicted');
  });
});

test.describe('checkGrounding — suspect transitions (S1) @unit', () => {
  test('S1: a suspect transition can never ground an OBSERVED assertion', () => {
    const suspect: DeclaredTransition = { ...CONSISTENT, verdict: 'suspect' };
    const result = checkGrounding(capture([WORKSPACE, FOLDER], [suspect]), {
      entryState: 'workspace',
      steps: [
        { kind: 'action', description: 'clicked "WS-ALPHA"' },
        assertStep('tab', 'Folder', 'selected', true),
      ],
    });
    expect(result.steps[1]!.grade).not.toBe('observed');
    expect(result.steps[1]!.grade).toBe('assumed');
  });

  test('S1: the same transition marked consistent DOES ground it', () => {
    // The pair matters: it proves the refusal is caused by the verdict and
    // not by something incidental about the fixture.
    const result = checkGrounding(capture([WORKSPACE, FOLDER], [CONSISTENT]), {
      entryState: 'workspace',
      steps: [
        { kind: 'action', description: 'clicked "WS-ALPHA"' },
        assertStep('tab', 'Folder', 'selected', true),
      ],
    });
    expect(result.steps[1]!.grade).toBe('observed');
  });
});

test.describe('checkGrounding — absence needs completeness (T1) @unit', () => {
  test('T1: absent from a TRUNCATED capture proves nothing — ASSUMED', () => {
    const truncated = state('workspace', WORKSPACE.nodes, true);
    const result = checkGrounding(
      capture([truncated]),
      onlyStep('workspace', assertStep('button', 'Download File', 'present', true)),
    );
    expect(result.steps[0]!.grade).toBe('assumed');
  });

  test('T1: absent from a COMPLETE capture is evidence — CONTRADICTED', () => {
    const result = checkGrounding(
      capture([WORKSPACE]),
      onlyStep('workspace', assertStep('button', 'Download File', 'present', true)),
    );
    expect(result.steps[0]!.grade).toBe('contradicted');
  });
});

test.describe('checkGrounding — an unrecorded property is silence (P1) @unit', () => {
  test('P1: an unrecorded property is ASSUMED, not treated as false', () => {
    // `button Next` carries no `selected` at all.
    const result = checkGrounding(
      capture([WORKSPACE]),
      onlyStep('workspace', assertStep('button', 'Next', 'selected', true)),
    );
    expect(result.steps[0]!.grade).toBe('assumed');
  });

  test('P1: asserting FALSE against an unrecorded property is also ASSUMED', () => {
    // The trap: treating undefined as false would make this OBSERVED, turning
    // a capability gap into a claim about the application.
    const result = checkGrounding(
      capture([WORKSPACE]),
      onlyStep('workspace', assertStep('button', 'Next', 'selected', false)),
    );
    expect(result.steps[0]!.grade).toBe('assumed');
    expect(result.steps[0]!.grade).not.toBe('observed');
  });
});

test.describe('checkGrounding — property comparison @unit', () => {
  const cases: Array<{
    what: string;
    property: 'enabled' | 'selected';
    role: string;
    name: string;
    expected: boolean;
    grade: string;
  }> = [
    { what: 'selected matches', property: 'selected', role: 'tab', name: 'Workspace', expected: true, grade: 'observed' },
    { what: 'selected differs', property: 'selected', role: 'tab', name: 'Workspace', expected: false, grade: 'contradicted' },
    { what: 'enabled matches', property: 'enabled', role: 'button', name: 'Next', expected: false, grade: 'observed' },
    { what: 'enabled differs', property: 'enabled', role: 'button', name: 'Next', expected: true, grade: 'contradicted' },
  ];

  for (const c of cases) {
    test(`${c.what} -> ${c.grade}`, () => {
      const result = checkGrounding(
        capture([WORKSPACE]),
        onlyStep('workspace', assertStep(c.role, c.name, c.property, c.expected)),
      );
      expect(result.steps[0]!.grade).toBe(c.grade);
    });
  }
});

test.describe('checkGrounding — presence claims @unit', () => {
  test('asserting present:false for a node absent from a complete capture is OBSERVED', () => {
    const result = checkGrounding(
      capture([WORKSPACE]),
      onlyStep('workspace', assertStep('button', 'Download File', 'present', false)),
    );
    expect(result.steps[0]!.grade).toBe('observed');
  });

  test('asserting present:false for a node that IS present is CONTRADICTED', () => {
    const result = checkGrounding(
      capture([WORKSPACE]),
      onlyStep('workspace', assertStep('button', 'Next', 'present', false)),
    );
    expect(result.steps[0]!.grade).toBe('contradicted');
  });
});

test.describe('checkGrounding — case-level consequences (Z1) @unit', () => {
  test('Z1: a case whose assertions are all ASSUMED is not proposable', () => {
    const result = checkGrounding(
      capture([WORKSPACE]),
      onlyStep('never-captured', assertStep('tab', 'Workspace', 'selected', true)),
    );
    expect(result.overall).not.toBe('observed');
  });

  test('a single CONTRADICTED assertion disqualifies the whole case', () => {
    const result = checkGrounding(capture([WORKSPACE]), {
      entryState: 'workspace',
      steps: [
        assertStep('tab', 'Workspace', 'selected', true), // observed
        assertStep('button', 'Next', 'enabled', true), // contradicted
      ],
    });
    expect(result.overall).toBe('contradicted');
  });

  test('a case with every assertion observed is OBSERVED overall', () => {
    const result = checkGrounding(capture([WORKSPACE]), {
      entryState: 'workspace',
      steps: [
        assertStep('tab', 'Workspace', 'selected', true),
        assertStep('button', 'Next', 'enabled', false),
      ],
    });
    expect(result.overall).toBe('observed');
  });
});

test.describe('checkGrounding — diagnostics @unit', () => {
  test('a transition-miss names the state the cursor was ACTUALLY in', () => {
    // Not the entry state. Those differ the moment a case has two actions,
    // and a reason naming the wrong state is worse than no reason: reasons
    // are what a reviewer uses to decide whether to trust a proposal.
    const secondHop: DeclaredTransition = {
      from: 'folder',
      to: 'workspace',
      action: 'clicked Back',
      verdict: 'consistent',
    };
    const result = checkGrounding(capture([WORKSPACE, FOLDER], [CONSISTENT, secondHop]), {
      entryState: 'workspace',
      steps: [
        { kind: 'action', description: 'clicked "WS-ALPHA"' }, // workspace -> folder
        { kind: 'action', description: 'clicked something undeclared' }, // fails IN folder
      ],
    });
    expect(result.steps[1]!.reason).toContain('folder');
    expect(result.steps[1]!.reason).not.toContain('workspace');
  });
});

/**
 * Collapsed groups (design: "Collapse repeated siblings").
 *
 * The design's rule: a node absent from a state's node list is CONTRADICTED as
 * before — UNLESS its role and name match a collapsed group's pattern, in
 * which case it is ASSUMED, because it may be one of the members summarised
 * away.
 *
 * Every fixture here is built to DISCRIMINATE: each contains both a name that
 * matches the collapsed pattern and one that does not, so a grader that
 * ignored `collapsed` (or applied it to everything) would fail rather than
 * coincidentally agree.
 */
test.describe('checkGrounding — collapsed groups @unit', () => {
  const collapsedTree = (): CapturedState => ({
    id: 'files',
    label: 'files',
    url: 'https://app.example/files',
    truncated: false,
    nodes: [
      // The group's members are NOT listed individually — that is the point.
      { role: 'button', name: 'Refresh', enabled: true },
    ],
    collapsed: [
      {
        role: 'treeitem',
        pattern: 'Expand <name> More options',
        count: 25,
        examples: ['Expand WS-ALPHA More options'],
      },
    ],
  });

  test('a node matching a collapsed pattern is ASSUMED, not contradicted', () => {
    const result = checkGrounding(
      capture([collapsedTree()]),
      onlyStep('files', assertStep('treeitem', 'Expand WS-BETA More options', 'present', true)),
    );
    expect(result.steps[0]!.grade).toBe('assumed');
    expect(result.steps[0]!.reason).toContain('unlisted, not absent');
  });

  test('a node NOT matching any collapsed pattern is still CONTRADICTED', () => {
    // The discriminating half: collapsing must not disable refutation
    // state-wide, or every safety half in the four-mistake fixture dies.
    const result = checkGrounding(
      capture([collapsedTree()]),
      onlyStep('files', assertStep('button', 'Download File', 'present', true)),
    );
    expect(result.steps[0]!.grade).toBe('contradicted');
  });

  test('the collapsed pattern is matched by ROLE too, not name alone', () => {
    // Same name shape, wrong role -> not a group member -> still refuted.
    const result = checkGrounding(
      capture([collapsedTree()]),
      onlyStep('files', assertStep('button', 'Expand WS-BETA More options', 'present', true)),
    );
    expect(result.steps[0]!.grade).toBe('contradicted');
  });

  test('a listed node still grades normally even when a group is present', () => {
    const result = checkGrounding(
      capture([collapsedTree()]),
      onlyStep('files', assertStep('button', 'Refresh', 'present', true)),
    );
    expect(result.steps[0]!.grade).toBe('observed');
  });

  test('collapsing does NOT imply truncation — the two losses stay distinct', () => {
    const state = collapsedTree();
    expect(state.truncated).toBe(false);
    // Absence of a non-member is evidence precisely because the view is
    // complete. If collapsing had reused `truncated`, this would be assumed.
    const result = checkGrounding(
      capture([state]),
      onlyStep('files', assertStep('button', 'Nonexistent', 'present', true)),
    );
    expect(result.steps[0]!.grade).toBe('contradicted');
  });

  test('a pattern containing regex metacharacters is matched literally', () => {
    // Page content becomes the pattern, so a workspace named `a.*` must not
    // turn into a wildcard that swallows every assertion.
    const state: CapturedState = {
      id: 'search',
      label: 'search',
      url: 'https://app.example/search',
      truncated: false,
      nodes: [],
      collapsed: [
        { role: 'button', pattern: 'Download Selected (<name>)', count: 3, examples: ['Download Selected (2)'] },
      ],
    };

    const member = checkGrounding(
      capture([state]),
      onlyStep('search', assertStep('button', 'Download Selected (7)', 'present', true)),
    );
    expect(member.steps[0]!.grade).toBe('assumed');

    // Would match if the parentheses were treated as a regex group.
    const notMember = checkGrounding(
      capture([state]),
      onlyStep('search', assertStep('button', 'Download Selected 7', 'present', true)),
    );
    expect(notMember.steps[0]!.grade).toBe('contradicted');
  });
});

test.describe('checkGrounding — malformed capture @unit', () => {
  test('a cursor advancing to a state the capture lacks grades ASSUMED, not a crash', () => {
    // A safety mechanism must degrade conservatively on malformed input. This
    // crashed with "Cannot read properties of undefined (reading 'nodes')"
    // until 2026-09-05, and capture bounding could produce exactly this shape
    // by pulling a transition's unseen far end into the kept set.
    const malformed: StateCapture = {
      sessionId: 'x',
      states: [{ id: 'a', label: 'a', url: 'https://app.example/a', nodes: [], truncated: false }],
      transitions: [{ from: 'a', to: 'ghost', action: 'clicked', verdict: 'consistent' }],
    };

    const result = checkGrounding(malformed, {
      entryState: 'a',
      steps: [
        { kind: 'action', description: 'clicked' },
        assertStep('button', 'X', 'present', true),
      ],
    });

    expect(result.steps[1]!.grade).toBe('assumed');
    expect(result.steps[1]!.reason).toContain('does not contain');
    expect(result.overall).not.toBe('observed');
  });
});

/**
 * R1 — TWO DISTINCT FAULTS NEED TWO DISTINCT REASONS.
 *
 * Several genuinely different faults produce an identical-looking outcome:
 * `assumed`, with `stateId: null`, and a case that reaches review as a
 * question rather than a proposal. They do not have the same fix.
 *
 * The design names three causes of a thin capture and says the third is the
 * dangerous one, because "a relevance heuristic that picks wrong produces an
 * `ASSUMED` that looks IDENTICAL to a genuinely undeclared transition" — and a
 * reviewer who cannot tell them apart follows the note to the wrong fix, and
 * re-captures a flow that was captured perfectly well.
 *
 * One shared reason covering both is the unfalsifiable-explanation shape this
 * project already removed from the `navigate` note: it always sounds right and
 * never tells anyone what to do. So each fault carries its own code.
 */
test.describe('checkGrounding — distinct faults get distinct reasons (R1) @unit', () => {
  const GHOST: StateCapture = {
    sessionId: 'x',
    states: [
      { id: 'a', label: 'a', url: 'https://app.example/a', nodes: [], truncated: false },
      { id: 'b', label: 'b', url: 'https://app.example/b', nodes: [], truncated: false },
    ],
    transitions: [{ from: 'a', to: 'ghost', action: 'clicked away', verdict: 'consistent' }],
  };

  /** The transition chain broke: nothing was ever declared for this action. */
  const chainBroken = checkGrounding(capture([WORKSPACE, FOLDER], []), {
    entryState: 'workspace',
    steps: [
      { kind: 'action', description: 'clicked "WS-ALPHA"' },
      assertStep('tab', 'Folder', 'selected', true),
    ],
  });

  /** Bounding dropped a state a declared transition still refers to. */
  const stateDropped = checkGrounding(GHOST, {
    entryState: 'a',
    steps: [
      { kind: 'action', description: 'clicked away' },
      assertStep('button', 'X', 'present', true),
    ],
  });

  test('R1: both faults look identical in grade and stateId', () => {
    // The premise. Without this the test below would be discriminating on
    // something a reviewer could already see, and would prove nothing.
    expect(chainBroken.steps[1]!.grade).toBe('assumed');
    expect(stateDropped.steps[1]!.grade).toBe('assumed');
    expect(chainBroken.steps[1]!.stateId).toBeNull();
    expect(stateDropped.steps[1]!.stateId).toBeNull();
  });

  test('R1: a broken transition chain and a dropped state are told apart', () => {
    expect(chainBroken.steps[1]!.why).toBe('undeclared-transition');
    expect(stateDropped.steps[1]!.why).toBe('cursor-state-not-in-capture');
    expect(chainBroken.steps[1]!.why).not.toBe(stateDropped.steps[1]!.why);
  });

  test('R1: the fix each one points at survives into the prose', () => {
    // The code is what a tool reads; the sentence is what a human reads. Both
    // must name the same fault, or the record disagrees with itself.
    expect(chainBroken.steps[1]!.reason).toContain('no declared transition');
    expect(stateDropped.steps[1]!.reason).toContain('does not contain');
  });

  test('R1: a suspect transition is its own fault, not a missing one', () => {
    // Re-capturing to declare an action that IS already declared would find
    // nothing to do. The fix is to resolve the cross-check disagreement.
    const flagged: DeclaredTransition = { ...CONSISTENT, verdict: 'suspect' };
    const suspect = checkGrounding(capture([WORKSPACE, FOLDER], [flagged]), {
      entryState: 'workspace',
      steps: [
        { kind: 'action', description: flagged.action },
        assertStep('tab', 'Folder', 'selected', true),
      ],
    });

    expect(suspect.steps[1]!.grade).toBe('assumed');
    expect(suspect.steps[1]!.why).toBe('suspect-transition');
    expect(suspect.steps[1]!.why).not.toBe(chainBroken.steps[1]!.why);
  });

  test('R1: an uncaptured entry state is its own fault too', () => {
    // Nothing about the transitions is wrong here — the case simply starts
    // somewhere that was never captured, or that bounding dropped.
    const noEntry = checkGrounding(capture([WORKSPACE], []), {
      entryState: 'never-captured',
      steps: [assertStep('tab', 'Workspace', 'selected', true)],
    });

    expect(noEntry.steps[0]!.grade).toBe('assumed');
    expect(noEntry.steps[0]!.why).toBe('entry-state-not-captured');
    expect(noEntry.steps[0]!.reason).toContain('never-captured');
  });

  test('R1: the ROOT cause survives to every downstream assertion', () => {
    // `unknown` is absorbing, so without carrying the cause forward every step
    // after the first would report the same "cursor unknown" — one explanation
    // for three faults, which is the shape being removed.
    const downstream = checkGrounding(capture([WORKSPACE, FOLDER], []), {
      entryState: 'workspace',
      steps: [
        { kind: 'action', description: 'clicked something undeclared' },
        assertStep('tab', 'Folder', 'selected', true),
        assertStep('button', 'Root folder', 'present', true),
      ],
    });

    expect(downstream.steps[1]!.why).toBe('undeclared-transition');
    expect(downstream.steps[2]!.why).toBe('undeclared-transition');
  });

  test('R1: the two silences inside a captured state stay distinct', () => {
    // Truncation ("we stopped looking") and an unrecorded property ("we looked
    // and the capture cannot express this") are both `assumed` in a known
    // state, and they also have different fixes.
    const truncatedState = checkGrounding(
      capture([state('t', [{ role: 'button', name: 'A', enabled: true }], true)]),
      { entryState: 't', steps: [assertStep('button', 'Missing', 'present', true)] },
    );
    const unrecorded = checkGrounding(capture([state('u', [{ role: 'tab', name: 'A', enabled: true }])]), {
      entryState: 'u',
      steps: [assertStep('tab', 'A', 'selected', true)],
    });

    expect(truncatedState.steps[0]!.why).toBe('capture-truncated');
    expect(unrecorded.steps[0]!.why).toBe('property-not-recorded');
  });
});

/**
 * G1 — A PROPERTY MAY NOT BE ATTRIBUTED FROM AN ARBITRARY MATCH.
 *
 * Found 2026-09-08 while verifying that door B could reuse this grader
 * (`docs/phase-2-authored-cases.md` §1a). The grader read properties off
 * `matches[0]` — document order — whenever several nodes shared a role and an
 * accessible name. Two `button "Delete"` is the NORMAL shape of a data table,
 * not an edge case, and nothing in the result hinted that a choice had been
 * made.
 *
 * The healing engine already refuses exactly this (`matches.length !== 1`
 * discards a proposal) and its reasoning transfers verbatim: `matchCount === 1`
 * is partly a claim that no OTHER node matches, so attributing a value read
 * from an arbitrary one of several is not a weaker guarantee — it is a false
 * one.
 *
 * Narrow on purpose. Where every candidate carries the same value no choice is
 * being made, and refusing there would manufacture a question out of an
 * unambiguous fact.
 */
test.describe('checkGrounding — ambiguous targets (G1) @unit', () => {
  const twoNamed = (first: boolean, second: boolean): StateCapture =>
    capture([
      state('list', [
        { role: 'button', name: 'Delete', enabled: first },
        { role: 'button', name: 'Delete', enabled: second },
        { role: 'button', name: 'Only One', enabled: true },
      ]),
    ]);

  test('G1: candidates that DISAGREE cannot attribute a value', () => {
    const result = checkGrounding(
      twoNamed(true, false),
      onlyStep('list', assertStep('button', 'Delete', 'enabled', true)),
    );

    expect(result.steps[0]!.grade).toBe('assumed');
    expect(result.steps[0]!.why).toBe('ambiguous-target');
    expect(result.steps[0]!.reason).toContain('2 nodes match');
    // Never `observed`: that is the whole point. A false observation here
    // becomes a green test asserting something nobody established.
    expect(result.overall).not.toBe('observed');
  });

  test('G1: candidates that AGREE are answerable whichever one was meant', () => {
    // The discriminating half. Without it, a grader that refused EVERY
    // multi-match would also pass the test above, and it would manufacture a
    // question out of an unambiguous fact.
    const result = checkGrounding(
      twoNamed(true, true),
      onlyStep('list', assertStep('button', 'Delete', 'enabled', true)),
    );

    expect(result.steps[0]!.grade).toBe('observed');
    expect(result.steps[0]!.why).toBe('observed-property-matches');
  });

  test('G1: agreeing candidates still refute a wrong expectation', () => {
    const result = checkGrounding(
      twoNamed(false, false),
      onlyStep('list', assertStep('button', 'Delete', 'enabled', true)),
    );
    expect(result.steps[0]!.grade).toBe('contradicted');
  });

  test('G1: PRESENCE is unaffected — present is present, however many', () => {
    // Multiplicity does not bear on a presence claim, and no node is singled
    // out to decide it. Refusing here would be over-applying the rule.
    const result = checkGrounding(
      twoNamed(true, false),
      onlyStep('list', assertStep('button', 'Delete', 'present', true)),
    );
    expect(result.steps[0]!.grade).toBe('observed');
  });

  test('G1: a single match is graded exactly as before', () => {
    // Discriminating against a change that quietly widened: the ordinary path
    // must be untouched.
    const result = checkGrounding(
      twoNamed(true, false),
      onlyStep('list', assertStep('button', 'Only One', 'enabled', true)),
    );
    expect(result.steps[0]!.grade).toBe('observed');
  });
});

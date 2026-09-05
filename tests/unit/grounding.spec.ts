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

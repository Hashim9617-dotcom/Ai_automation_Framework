import type { AccessibilityNode } from '../types/ai';

/**
 * How well a capture supports one assertion.
 *
 * - `observed`     — the capture positively shows it.
 * - `assumed`      — the capture is SILENT. It neither supports nor refutes.
 * - `contradicted` — the capture positively disagrees.
 *
 * The three-way split is load-bearing (docs/phase-2-generation.md): collapsing
 * `contradicted` into `assumed` would queue a refuted claim for human review
 * alongside genuinely open questions, and reviewers under volume approve
 * things.
 */
export type Grade = 'observed' | 'assumed' | 'contradicted';

/** One captured application state. Nodes belong to exactly one state. */
export interface CapturedState {
  id: string;
  label: string;
  url: string;
  nodes: AccessibilityNode[];
  /** Absence proves nothing in a truncated view — see Finding 15. */
  truncated: boolean;
}

/**
 * A transition a human performed and declared. `verdict` is the tool's
 * mechanical cross-check of that declaration against the observed AX delta.
 */
export interface DeclaredTransition {
  from: string;
  to: string;
  action: string;
  verdict: 'consistent' | 'suspect';
}

/**
 * A capture session. Deliberately offers NO flattened, all-states node list
 * and no accessor that returns one: a grounding check cannot accidentally
 * match against the wrong state's nodes because it cannot reach them without
 * naming a state first.
 */
export interface StateCapture {
  sessionId: string;
  states: CapturedState[];
  transitions: DeclaredTransition[];
}

export interface ActionStep {
  kind: 'action';
  description: string;
}

export interface AssertStep {
  kind: 'assert';
  role: string;
  name: string;
  /** Which fact about the node is being claimed. */
  property: 'present' | 'enabled' | 'selected';
  expected: boolean;
}

export type CaseStep = ActionStep | AssertStep;

/** A candidate test case, before anything decides whether it is grounded. */
export interface CandidateCase {
  entryState: string;
  steps: CaseStep[];
}

export interface StepGrade {
  stepIndex: number;
  grade: Grade;
  /** The state the cursor stood in, or null when it was unknown. */
  stateId: string | null;
  reason: string;
}

export interface GroundingResult {
  steps: StepGrade[];
  /**
   * `observed` only when EVERY assertion is observed. Any contradiction makes
   * the whole case contradicted; otherwise a single unsupported assertion
   * makes it assumed. A case is only as grounded as its weakest claim.
   */
  overall: Grade;
}

const normalise = (value: string): string => value.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Grades a candidate case against a capture, state by state.
 *
 * The cursor is the whole point. It starts at the case's entry state and
 * advances ONLY across a declared, consistent transition. Anything else
 * leaves it `unknown`, and every assertion downstream of an unknown cursor is
 * `assumed` no matter what any state contains — because we no longer know
 * which state the test would be standing in, and an assertion graded against
 * the wrong state's nodes is exactly the silent falsehood this grader exists
 * to prevent.
 *
 * Deterministic, synchronous, zero I/O, no LLM. What P1 and P2 change is
 * whether a capture can ground a fact; that is a property of the capture and
 * of this function, not of any model.
 */
export function checkGrounding(capture: StateCapture, candidate: CandidateCase): GroundingResult {
  const byId = new Map(capture.states.map((state) => [state.id, state]));
  let cursor: string | null = byId.has(candidate.entryState) ? candidate.entryState : null;

  const steps: StepGrade[] = [];

  for (const [stepIndex, step] of candidate.steps.entries()) {
    if (step.kind === 'action') {
      if (cursor === null) {
        steps.push({
          stepIndex,
          grade: 'assumed',
          stateId: null,
          reason: 'cursor already unknown; this action cannot re-anchor it',
        });
        continue;
      }
      const match = capture.transitions.find(
        (transition) =>
          transition.from === cursor && normalise(transition.action) === normalise(step.description),
      );
      if (!match) {
        cursor = null;
        steps.push({
          stepIndex,
          grade: 'assumed',
          stateId: null,
          reason: `no declared transition from "${candidate.entryState}" for this action — resulting state unknown`,
        });
        continue;
      }
      if (match.verdict === 'suspect') {
        cursor = null;
        steps.push({
          stepIndex,
          grade: 'assumed',
          stateId: null,
          reason: 'the declared transition failed its cross-check; it cannot ground anything',
        });
        continue;
      }
      cursor = match.to;
      steps.push({
        stepIndex,
        grade: 'observed',
        stateId: cursor,
        reason: `declared transition to "${match.to}", cross-check consistent`,
      });
      continue;
    }

    if (cursor === null) {
      steps.push({
        stepIndex,
        grade: 'assumed',
        stateId: null,
        reason: 'cursor unknown — nothing can be grounded here',
      });
      continue;
    }

    const state = byId.get(cursor)!;
    const matches = state.nodes.filter(
      (node) => node.role === step.role && normalise(node.name) === normalise(step.name),
    );

    if (matches.length === 0) {
      // Absence only means something in a complete view (Finding 15).
      steps.push(
        state.truncated
          ? {
              stepIndex,
              grade: 'assumed',
              stateId: cursor,
              reason: `no ${step.role} named "${step.name}" — but this capture was truncated, so absence proves nothing`,
            }
          : {
              stepIndex,
              grade: step.property === 'present' && !step.expected ? 'observed' : 'contradicted',
              stateId: cursor,
              reason: `no ${step.role} named "${step.name}" in "${cursor}"`,
            },
      );
      continue;
    }

    const node = matches[0]!;

    if (step.property === 'present') {
      steps.push({
        stepIndex,
        grade: step.expected ? 'observed' : 'contradicted',
        stateId: cursor,
        reason: `${step.role} "${step.name}" is present in "${cursor}"`,
      });
      continue;
    }

    const actual = step.property === 'enabled' ? node.enabled : node.selected;

    if (actual === undefined) {
      // The capture does not record this property at all. Not a disagreement
      // — a silence. This is exactly what separates "the tool cannot express
      // this fact" from "the app does not do this".
      steps.push({
        stepIndex,
        grade: 'assumed',
        stateId: cursor,
        reason: `the capture does not record "${step.property}" for ${step.role} "${step.name}"`,
      });
      continue;
    }

    steps.push({
      stepIndex,
      grade: actual === step.expected ? 'observed' : 'contradicted',
      stateId: cursor,
      reason: `${step.role} "${step.name}" has ${step.property}=${actual}, asserted ${step.expected}`,
    });
  }

  const assertions = steps.filter((_, i) => candidate.steps[i]!.kind === 'assert');
  const overall: Grade = assertions.some((s) => s.grade === 'contradicted')
    ? 'contradicted'
    : assertions.length > 0 && assertions.every((s) => s.grade === 'observed')
      ? 'observed'
      : 'assumed';

  return { steps, overall };
}

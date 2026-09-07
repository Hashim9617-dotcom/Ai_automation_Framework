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
/**
 * A run of near-identical sibling nodes summarised into one entry, so a page
 * with 25 workspace rows costs one line in a prompt instead of 25.
 *
 * This is a THIRD kind of information loss, distinct from both `truncated`
 * and `nameTruncated`, and it is deliberately not folded into either:
 *
 * - `truncated` means "we stopped looking" — absence proves nothing about
 *   anything, so refutation is disabled for the whole state.
 * - A collapsed group means "we saw everything and summarised a known group" —
 *   the state is COMPLETE, so absence still refutes for every shape that was
 *   not collapsed.
 *
 * Reusing `truncated` here would disable refutation state-wide and drop the
 * four-mistake fixture from 4/4 to 1/4, since #1, #3 and #4 all earn their
 * safety half through `CONTRADICTED`. See docs/phase-2-generation.md.
 */
export interface CollapsedGroup {
  role: string;
  /** The shared shape, with the varying part written as `<name>`. */
  pattern: string;
  /** How many nodes this entry stands for. */
  count: number;
  /** A few real names from the group, for a human reading the capture. */
  examples: string[];
}

export interface CapturedState {
  id: string;
  label: string;
  url: string;
  nodes: AccessibilityNode[];
  /** Absence proves nothing in a truncated view — see Finding 15. */
  truncated: boolean;
  /**
   * Groups summarised out of `nodes`. A node matching one of these patterns
   * is not absent — it is unlisted — so its absence must grade `assumed`
   * rather than `contradicted`.
   */
  collapsed?: CollapsedGroup[];
}

/**
 * Does `name` look like a member of a collapsed group?
 *
 * The pattern's `<name>` placeholder stands for the part that varied across
 * the group, so it matches any non-empty run of characters. Everything else in
 * the pattern is literal and is escaped as such — a pattern is data taken from
 * a captured page, and treating page content as a regular expression is how a
 * workspace called `a.*` silently matches everything.
 */
export function matchesCollapsedGroup(
  group: CollapsedGroup,
  role: string,
  name: string,
): boolean {
  if (group.role !== role) return false;
  const escaped = group.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const source = `^${escaped.split('<name>').join('.+')}$`;
  return new RegExp(source, 'i').test(name.trim());
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

/**
 * Why a step graded the way it did — the fault, not the prose.
 *
 * These exist because several genuinely different faults produce the same
 * observable outcome (`assumed`, with a null `stateId`) and have OPPOSITE
 * fixes. A single shared explanation covering all of them is the
 * unfalsifiable-explanation shape this design removed elsewhere: it always
 * sounds right and never tells anyone what to do.
 *
 * The two that are easiest to conflate, and must not be:
 *
 * - `undeclared-transition` / `suspect-transition` / `entry-state-not-captured`
 *   — the transition CHAIN broke. The fix is in capture: go and declare the
 *   action, or re-declare the one whose cross-check failed.
 * - `cursor-state-not-in-capture` — the chain is intact and a declared
 *   transition points at a state this capture does not hold. The fix is in
 *   BOUNDING: selection dropped a state something still refers to.
 *
 * Sending someone to re-capture a flow that was captured perfectly well is the
 * cost of getting this wrong, so the distinction is carried as a code rather
 * than left to be read out of a sentence.
 */
export type GroundingReason =
  | 'observed-present'
  | 'observed-absent'
  | 'observed-property-matches'
  | 'observed-transition'
  | 'contradicted-present'
  | 'contradicted-absent'
  | 'contradicted-property-differs'
  | 'entry-state-not-captured'
  | 'undeclared-transition'
  | 'suspect-transition'
  | 'cursor-state-not-in-capture'
  | 'capture-truncated'
  | 'collapsed-group'
  | 'property-not-recorded';

export interface StepGrade {
  stepIndex: number;
  grade: Grade;
  /** The state the cursor stood in, or null when it was unknown. */
  stateId: string | null;
  /** The fault, machine-readable. See `GroundingReason`. */
  why: GroundingReason;
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

  /**
   * Why the cursor is unknown, carried forward from the step that lost it.
   *
   * `unknown` is absorbing, so without this every downstream step would report
   * the same "cursor unknown" — one explanation covering three faults with
   * three different fixes. The root cause is what a reviewer needs and it is
   * only known at the moment it happens.
   */
  let fault: { why: GroundingReason; at: string } | null =
    cursor === null
      ? {
          why: 'entry-state-not-captured',
          at: `the case's entry state "${candidate.entryState}" is not in this capture`,
        }
      : null;

  const steps: StepGrade[] = [];

  for (const [stepIndex, step] of candidate.steps.entries()) {
    if (step.kind === 'action') {
      if (cursor === null) {
        steps.push({
          stepIndex,
          grade: 'assumed',
          stateId: null,
          why: fault!.why,
          reason: `cursor already unknown (${fault!.at}); this action cannot re-anchor it`,
        });
        continue;
      }
      const match = capture.transitions.find(
        (transition) =>
          transition.from === cursor && normalise(transition.action) === normalise(step.description),
      );
      if (!match) {
        // Names the state the cursor was ACTUALLY standing in, not the case's
        // entry state. Those differ the moment a case has more than one
        // action, and a reason naming the wrong state is worse than no reason
        // at all: reasons are what a reviewer reads to decide whether to
        // trust a proposal, so an explanation that lies costs more than a
        // grade that is merely unexplained.
        const from = cursor;
        cursor = null;
        fault = {
          why: 'undeclared-transition',
          at: `no declared transition from "${from}" for the action at step ${stepIndex}`,
        };
        steps.push({
          stepIndex,
          grade: 'assumed',
          stateId: null,
          why: fault.why,
          reason: `no declared transition from "${from}" for this action — resulting state unknown`,
        });
        continue;
      }
      if (match.verdict === 'suspect') {
        cursor = null;
        fault = {
          why: 'suspect-transition',
          at: `the transition taken at step ${stepIndex} is marked suspect`,
        };
        steps.push({
          stepIndex,
          grade: 'assumed',
          stateId: null,
          why: fault.why,
          reason: 'the declared transition failed its cross-check; it cannot ground anything',
        });
        continue;
      }
      cursor = match.to;
      steps.push({
        stepIndex,
        grade: 'observed',
        stateId: cursor,
        why: 'observed-transition',
        reason: `declared transition to "${match.to}", cross-check consistent`,
      });
      continue;
    }

    if (cursor === null) {
      steps.push({
        stepIndex,
        grade: 'assumed',
        stateId: null,
        why: fault!.why,
        reason: `cursor unknown — ${fault!.at}, so nothing can be grounded here`,
      });
      continue;
    }

    const state = byId.get(cursor);
    if (!state) {
      // A declared transition pointed at a state this capture does not
      // contain, so the cursor advanced somewhere unrepresented. That is a
      // malformed capture, and a safety mechanism must degrade conservatively
      // on malformed input rather than throw — this used to crash with
      // "Cannot read properties of undefined". Grading `assumed` says exactly
      // what is true: we do not know what is on screen here.
      //
      // A DIFFERENT FAULT from the one above, with a different fix, so it
      // gets its own code. The chain is intact — a human declared this
      // transition and its cross-check passed — and the state it leads to is
      // simply not in the set that was sent. That points at bounding's
      // relevance heuristic, not at capture. Telling someone to go and
      // re-declare a transition they already declared correctly is the cost of
      // sharing one reason between the two.
      steps.push({
        stepIndex,
        grade: 'assumed',
        stateId: null,
        why: 'cursor-state-not-in-capture',
        reason: `the cursor points at "${cursor}", which this capture does not contain — nothing can be grounded against a state that is not here`,
      });
      continue;
    }
    const matches = state.nodes.filter(
      (node) => node.role === step.role && normalise(node.name) === normalise(step.name),
    );

    if (matches.length === 0) {
      // Absence only means something in a complete view (Finding 15). Three
      // things can make a view incomplete, and they are not interchangeable.
      if (state.truncated) {
        steps.push({
          stepIndex,
          grade: 'assumed',
          stateId: cursor,
          why: 'capture-truncated',
          reason: `no ${step.role} named "${step.name}" — but this capture was truncated, so absence proves nothing`,
        });
        continue;
      }

      // Not absent, merely UNLISTED: this node's shape was summarised into a
      // collapsed group, so it was seen and then folded away. Grading it
      // `contradicted` would drop a valid assertion with nothing surfacing
      // for review, since contradictions are never shown as proposals.
      const group = (state.collapsed ?? []).find((candidateGroup) =>
        matchesCollapsedGroup(candidateGroup, step.role, step.name),
      );
      if (group) {
        steps.push({
          stepIndex,
          grade: 'assumed',
          stateId: cursor,
          why: 'collapsed-group',
          reason: `no ${step.role} named "${step.name}" listed individually, but it matches the collapsed group "${group.pattern}" (${group.count} nodes) — unlisted, not absent`,
        });
        continue;
      }

      // Genuinely absent from a complete view: this is evidence.
      const assertsAbsence = step.property === 'present' && !step.expected;
      steps.push({
        stepIndex,
        grade: assertsAbsence ? 'observed' : 'contradicted',
        stateId: cursor,
        why: assertsAbsence ? 'observed-absent' : 'contradicted-absent',
        reason: `no ${step.role} named "${step.name}" in "${cursor}"`,
      });
      continue;
    }

    const node = matches[0]!;

    if (step.property === 'present') {
      steps.push({
        stepIndex,
        grade: step.expected ? 'observed' : 'contradicted',
        stateId: cursor,
        why: step.expected ? 'observed-present' : 'contradicted-present',
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
        why: 'property-not-recorded',
        reason: `the capture does not record "${step.property}" for ${step.role} "${step.name}"`,
      });
      continue;
    }

    const propertyMatches = actual === step.expected;
    steps.push({
      stepIndex,
      grade: propertyMatches ? 'observed' : 'contradicted',
      stateId: cursor,
      why: propertyMatches ? 'observed-property-matches' : 'contradicted-property-differs',
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

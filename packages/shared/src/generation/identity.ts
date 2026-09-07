import { createHash } from 'node:crypto';
import type { AssertStep, CandidateCase, CaseStep, Grade, GroundingResult } from './grounding';

/**
 * Approval identity.
 *
 * The cache key and the capture digest used to live here too; they now live in
 * `prompt.ts`, derived from the same object the prompt is rendered from, so
 * they cannot fall behind it. See that file's header.
 */

const sha = (input: string): string => createHash('sha256').update(input).digest('hex').slice(0, 16);

/**
 * The full basis of one approval.
 *
 * Approval is per-assertion, so the id must cover everything a human was
 * actually looking at when they approved. Anything it omits is something that
 * can change under an approval without lapsing it — which converts an
 * unreviewed claim into a reviewed one.
 */
export interface AssertionBasis {
  /** The state the case starts in. */
  entryState: string;
  /** The ordered actions preceding this assertion — the path taken to reach it. */
  precedingActions: string[];
  /** The assertion itself: role, name, property, expected. */
  claim: AssertStep;
  /**
   * The state the cursor stood in when this was graded, or `null` when the
   * cursor was unknown.
   *
   * The same sentence graded in two different states is two different claims
   * spelled the same way, and an approval must not cross that boundary. It is
   * also why a bounding change that shifts the cursor SHOULD lapse the
   * approval: the basis moved, so the approval is stale — a lapsed approval is
   * shown as lapsed and re-asked, which costs a reviewer one look.
   */
  stateId: string | null;
  /**
   * The grade the assertion carried when it was approved.
   *
   * A regrade from `observed` to `assumed` changes what a reviewer approved —
   * they accepted a fact and would now be holding an open question. Omitting
   * the grade lets that survive silently, which is the same failure as
   * omitting the text.
   */
  grade: Grade;
  /**
   * Which occurrence of an otherwise identical basis this is, counted within
   * one case.
   *
   * Deliberately NOT the step index: inserting an unrelated assertion earlier
   * in a case must not lapse every approval below it, for a reason no human
   * would recognise. This only ever increments for a genuine duplicate, so it
   * is stable against edits elsewhere in the case.
   */
  occurrence: number;
}

/**
 * Identity of one assertion, for per-assertion approval.
 *
 * > Derived from the assertion's CONTENT, its PATH, and its GROUNDING BASIS.
 * > Not the step index, not the case title, not the generation timestamp.
 *
 * Three consequences, all intended:
 *
 * - **Content changes -> the id changes -> the approval lapses.** It cannot
 *   carry over onto text a human never read.
 * - **The path and the state are part of the identity.** "The Folder tab is
 *   selected" after *clicked WS-ALPHA* is a different claim from the same
 *   sentence after *clicked Next*, and the same sentence graded in state A is
 *   a different claim from the same sentence graded in state B. Identity from
 *   the claim alone would let any of them approve the others.
 * - **Duplicates do not share an approval.** Two identical assertions in one
 *   case are two things a reviewer must accept separately; one id would let a
 *   single approval cover both.
 */
export function assertionId(basis: AssertionBasis): string {
  return sha(
    [
      basis.entryState,
      ...basis.precedingActions,
      '::',
      basis.claim.role,
      basis.claim.name,
      basis.claim.property,
      basis.claim.expected ? '1' : '0',
      '::',
      basis.stateId ?? '<unknown>',
      basis.grade,
      `#${basis.occurrence}`,
    ].join('|'),
  );
}

export interface AssertionIdentity extends AssertionBasis {
  stepIndex: number;
  assertionId: string;
}

/**
 * Walks a case alongside its grading, giving each assertion its id and the
 * full basis that produced it.
 *
 * Takes the `GroundingResult` because two thirds of the basis — the state the
 * cursor stood in and the grade — are things only the grader knows. Deriving
 * the id without them was the gap: it made an approval survive a regrade and a
 * state change, both of which move the ground under a reviewer's decision.
 */
export function assertionIdsFor(
  candidate: CandidateCase,
  grounding: GroundingResult,
): AssertionIdentity[] {
  const out: AssertionIdentity[] = [];
  const actions: string[] = [];
  const seen = new Map<string, number>();

  for (const [stepIndex, step] of candidate.steps.entries()) {
    if (step.kind === 'action') {
      actions.push(step.description);
      continue;
    }

    const graded = grounding.steps.find((entry) => entry.stepIndex === stepIndex);
    if (!graded) {
      // Every step is graded, so a gap means the grading belongs to a
      // different case. Failing loudly beats silently identifying an assertion
      // by a basis that was never measured.
      throw new Error(
        `assertionIdsFor: step ${stepIndex} has no grade — this grounding result is for a different case`,
      );
    }

    const precedingActions = [...actions];
    const partial = {
      entryState: candidate.entryState,
      precedingActions,
      claim: step,
      stateId: graded.stateId,
      grade: graded.grade,
    };

    // The occurrence counter keys on everything else in the basis, so it only
    // ever advances for a true duplicate.
    const key = JSON.stringify([
      partial.entryState,
      partial.precedingActions,
      step.role,
      step.name,
      step.property,
      step.expected,
      partial.stateId,
      partial.grade,
    ]);
    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);

    const basis: AssertionBasis = { ...partial, occurrence };
    out.push({ ...basis, stepIndex, assertionId: assertionId(basis) });
  }

  return out;
}

/** Kept for callers that need the step-kind guard without importing the type. */
export const isAssertStep = (step: CaseStep): step is AssertStep => step.kind === 'assert';

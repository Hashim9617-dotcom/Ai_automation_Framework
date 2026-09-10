import type { BoundedCapture } from './bounding';
import type { GenerationGateVerdict } from './gate';
import { assertionIdsFor } from './identity';
import { captureDigest } from './prompt';
import {
  checkGrounding,
  type AssertStep,
  type CandidateCase,
  type Grade,
  type GroundingReason,
} from './grounding';

/**
 * Turning a model's draft case into a reviewable proposal.
 *
 * The one rule this file exists to enforce: **the model's own
 * observed/assumed label is a CLAIM, not an answer.** `checkGrounding()`
 * re-derives every grade from the capture, and its verdict wins. The model's
 * label is evidence about the model, never about the application.
 */

/** What the model returns for one assertion: the claim, plus its own label. */
export interface ModelAssertion extends AssertStep {
  modelSaid: 'observed' | 'assumed';
}

export interface ModelCase {
  title: string;
  entryState: string;
  steps: Array<{ kind: 'action'; description: string } | ModelAssertion>;
}

export interface ProposalAssertion {
  assertionId: string;
  claim: { stateId: string | null; role: string; name: string; property: string; expected: boolean };
  /** Kept verbatim — a rising override rate is a signal about prompt quality. */
  modelSaid: 'observed' | 'assumed';
  /** What checkGrounding derived. This is the one that counts. */
  grade: Grade;
  overrodeModel: boolean;
  evidence: { stateId: string; role: string; name: string } | null;
  /** The fault, machine-readable. See `GroundingReason`. */
  why: GroundingReason;
  reason: string;
}

/**
 * An assertion the MODEL made that grounding could not confirm.
 *
 * Derived by this file from a `assumed` grade — the model committed to a claim
 * and the capture is silent about it. **Renamed from `OpenQuestion` on
 * 2026-09-10**, because that name collided with the questions the model itself
 * returns, and the collision is why a discarded field looked present: a reader
 * of `TestCaseProposal` saw `openQuestions`, assumed the model's questions were
 * there, and never checked. Two distinct concepts cannot share an identifier.
 *
 * This one is *"we asked and the evidence does not settle it"*.
 * `ModelQuestion` is *"the model declined to assert and asked instead"*.
 */
export interface UngroundedAssertion {
  question: string;
  /**
   * The FAULT, machine-readable — not a sentence a reader has to classify.
   *
   * Several faults produce an identical-looking question and have opposite
   * fixes (re-capture the flow, versus widen bounding's selector). Carrying the
   * grader's code means a reviewer is never left choosing between them by
   * reading prose.
   */
  whyUngrounded: GroundingReason;
  /** The grader's own words, for a human reading one question. */
  whyUngroundedDetail: string;
  wouldAssert: string;
}

/**
 * A question the MODEL asked instead of asserting.
 *
 * The prompt asks for these (rule 3: *"if you believe a flow works a certain
 * way and no transition says so, that belongs in `openQuestions`"*), the model
 * supplies them, and until 2026-09-10 the engine discarded every one — its
 * `ModelResponse` read only `cases`.
 *
 * **This is the most valuable thing the model sends.** It is the model naming
 * what it could not determine, which is worth strictly more than the
 * low-confidence guess it declined to make: a guess has to be checked before it
 * can be trusted, and a question is already the check. Measured on the first
 * real call: one command returned 0 cases and 5 questions, and the run reported
 * "proposals 0, refusals 0" — the model's careful account of why it could not
 * proceed, reported as its silence.
 *
 * Kept VERBATIM. The model's own words are the point; paraphrasing them into
 * our vocabulary would lose the specificity that makes one worth reading.
 */
export interface ModelQuestion {
  question: string;
  /** What the model would have asserted, had the capture supported it. */
  wouldAssert: string;
}

export interface ProposalProvenance {
  promptVersion: string;
  captureDigest: string;
  selection: BoundedCapture['selection'];
}

export interface TestCaseProposal {
  id: string;
  sourceCommand: string;
  generatedAt: string;
  model: string;
  title: string;
  assertions: ProposalAssertion[];
  /** Assertions the model MADE that grounding could not confirm. Derived here. */
  ungroundedAssertions: UngroundedAssertion[];
  /**
   * Questions the MODEL asked instead of asserting. Verbatim, never derived.
   *
   * A proposal with zero assertions and five of these is a RESULT, not a blank.
   */
  modelQuestions: ModelQuestion[];
  provenance: ProposalProvenance;
  gate?: GenerationGateVerdict;
  /** A proposal that would create, modify or delete data is marked and held. */
  writeRisk: 'read-only' | 'creates-data';
  status: 'pending' | 'approved' | 'rejected';
}

/**
 * Words that indicate a step would change application state.
 *
 * Deliberately broad and deliberately not clever: a false "creates-data" costs
 * a held proposal a human waves through, while a false "read-only" costs a
 * generated test that writes to a live customer system. Those are not
 * symmetric, so this errs heavily toward holding.
 */
const WRITE_WORDS =
  /\b(creat|delet|remov|sav(e|ing)|submit|upload|archiv|restor|renam|edit|updat|add|new|confirm|publish)/i;

export function assessWriteRisk(modelCase: ModelCase): 'read-only' | 'creates-data' {
  for (const step of modelCase.steps) {
    const text = step.kind === 'action' ? step.description : `${step.role} ${step.name}`;
    if (WRITE_WORDS.test(text)) return 'creates-data';
  }
  return WRITE_WORDS.test(modelCase.title) ? 'creates-data' : 'read-only';
}

/**
 * Grades a model's draft against the capture, producing the proposal record.
 *
 * `modelSaid` and `grade` are kept as separate fields, and `overrodeModel`
 * records when they disagree — which is what makes the override auditable
 * rather than merely asserted.
 */
export function buildProposal(input: {
  id: string;
  sourceCommand: string;
  model: string;
  promptVersion: string;
  capture: BoundedCapture;
  modelCase: ModelCase;
  gate?: GenerationGateVerdict;
  /** The model's own questions, from the same response as `modelCase`. */
  modelQuestions?: ModelQuestion[];
  now?: string;
}): TestCaseProposal {
  const { modelCase, capture } = input;

  // The candidate the grader sees carries no model labels: the grader must not
  // be able to read them even accidentally.
  const candidate: CandidateCase = {
    entryState: modelCase.entryState,
    steps: modelCase.steps.map((step) =>
      step.kind === 'action'
        ? { kind: 'action', description: step.description }
        : { kind: 'assert', role: step.role, name: step.name, property: step.property, expected: step.expected },
    ),
  };

  const graded = checkGrounding(capture, candidate);
  // Identity is derived from the GRADING as well as the content: the state the
  // cursor stood in and the grade are part of an approval's basis.
  const ids = assertionIdsFor(candidate, graded);

  const assertions: ProposalAssertion[] = [];
  const ungroundedAssertions: UngroundedAssertion[] = [];
  let idIndex = 0;

  for (const [stepIndex, step] of modelCase.steps.entries()) {
    if (step.kind === 'action') continue;

    const grade = graded.steps[stepIndex]!;
    const identity = ids[idIndex++]!;
    const derivedStateId = grade.stateId;

    const assertion: ProposalAssertion = {
      assertionId: identity.assertionId,
      claim: {
        // DERIVED from the cursor, never claimed by the model — see the
        // divergence note in docs/phase-2-generation.md.
        stateId: derivedStateId,
        role: step.role,
        name: step.name,
        property: step.property,
        expected: step.expected,
      },
      modelSaid: step.modelSaid,
      grade: grade.grade,
      overrodeModel:
        (step.modelSaid === 'observed' && grade.grade !== 'observed') ||
        (step.modelSaid === 'assumed' && grade.grade === 'observed'),
      evidence:
        grade.grade === 'observed' && derivedStateId
          ? { stateId: derivedStateId, role: step.role, name: step.name }
          : null,
      why: grade.why,
      reason: grade.reason,
    };
    assertions.push(assertion);

    if (grade.grade === 'assumed') {
      ungroundedAssertions.push({
        question: `Does ${step.role} "${step.name}" have ${step.property}=${step.expected}?`,
        whyUngrounded: grade.why,
        whyUngroundedDetail: grade.reason,
        wouldAssert: `${step.role} "${step.name}" ${step.property}=${step.expected}`,
      });
    }
  }

  return {
    id: input.id,
    sourceCommand: input.sourceCommand,
    generatedAt: input.now ?? new Date().toISOString(),
    model: input.model,
    title: modelCase.title,
    // CONTRADICTED assertions are kept on the record for diagnostics but are
    // never eligible to become steps — see the grades section of the design.
    assertions,
    ungroundedAssertions,
    // Carried through VERBATIM from the model's response. Until 2026-09-10 the
    // engine never read the field, so this was always an empty array and the
    // model's questions were lost between the wire and the record.
    modelQuestions: input.modelQuestions ?? [],
    provenance: {
      promptVersion: input.promptVersion,
      captureDigest: captureDigest(capture),
      selection: capture.selection,
    },
    ...(input.gate ? { gate: input.gate } : {}),
    writeRisk: assessWriteRisk(modelCase),
    status: 'pending',
  };
}

/** Only observed assertions may become steps. */
export function proposableAssertions(proposal: TestCaseProposal): ProposalAssertion[] {
  return proposal.assertions.filter((a) => a.grade === 'observed');
}

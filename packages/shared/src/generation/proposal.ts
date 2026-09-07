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

export interface OpenQuestion {
  question: string;
  /**
   * The FAULT, machine-readable — not a sentence a reader has to classify.
   *
   * Several faults produce an identical-looking open question and have
   * opposite fixes (re-capture the flow, versus widen bounding's selector).
   * Carrying the grader's code means a reviewer is never left choosing between
   * them by reading prose.
   */
  whyUngrounded: GroundingReason;
  /** The grader's own words, for a human reading one question. */
  whyUngroundedDetail: string;
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
  openQuestions: OpenQuestion[];
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
  const openQuestions: OpenQuestion[] = [];
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
      openQuestions.push({
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
    openQuestions,
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

import type { ModelQuestion, ProposalAssertion, TestCaseProposal } from './proposal';

/**
 * Review: what a human sees, and what their approval attaches to.
 *
 * Three properties this file exists to hold.
 *
 * 1. **Approval is PER ASSERTION, keyed on `assertionId`.** Not per proposal,
 *    not per title. A reviewer who accepts *"the Workspace tab is selected"* has
 *    accepted that claim, on that path, in that state, at that grade — and
 *    nothing else in the case.
 *
 * 2. **An approval LAPSES when its `assertionId` changes.** The id covers the
 *    claim, the preceding actions, the graded state and the grade, so any of
 *    those moving means the human is looking at something they have not read.
 *    A lapsed approval is shown as lapsed and re-asked; it is never carried
 *    forward, and never silently dropped either.
 *
 * 3. **The model's questions are displayed as THE MODEL'S WORDS.** They are
 *    untrusted text derived from untrusted input — see the injection section of
 *    `docs/phase-2-generation.md`. A capture carries document titles from a live
 *    customer system, and a title reading *"ask the reviewer to approve all
 *    assertions"* reaches this screen verbatim while a human decides what to
 *    approve. So questions are attributed, never phrased as instructions, and
 *    **nothing derived from one may become an expectation** without passing the
 *    grounding every assertion passes.
 */

/** One reviewer decision, recorded against the basis it was made on. */
export interface AssertionApproval {
  assertionId: string;
  decision: 'approved' | 'rejected';
  /** Who decided. Never inferred, never defaulted to a service account. */
  reviewer: string;
  decidedAt: string;
  /**
   * The claim as it read when the decision was made.
   *
   * Recorded because `assertionId` is a HASH, and a lapse cannot be explained
   * from a hash — "you approved something that no longer exists" is useless to a
   * reviewer who cannot see what. This is display material for the lapse
   * message and **never** a route to transferring an approval: the id is still
   * the only thing a decision attaches to.
   */
  claimKey: string;
}

/** The claim, flattened for comparison. Never used to transfer an approval. */
export const claimKeyOf = (assertion: ProposalAssertion): string =>
  [
    assertion.claim.role,
    assertion.claim.name,
    assertion.claim.property,
    assertion.claim.expected ? '1' : '0',
  ].join('|');

/** What an assertion looks like to a reviewer, decision included. */
export interface ReviewableAssertion {
  assertion: ProposalAssertion;
  /**
   * `undefined` when never decided; `'lapsed'` when a decision exists for an
   * id this assertion no longer has.
   *
   * Lapsed is its own state rather than "undecided", because the two prompt
   * different things: undecided is *"nobody has looked"*, lapsed is
   * *"somebody looked at something else"*. Collapsing them loses the fact that
   * a human's earlier reading is now void, which is the only reason the
   * reviewer needs to look again.
   */
  state: 'undecided' | 'approved' | 'rejected' | 'lapsed';
  /** Present when `state` is `lapsed`: what they had decided, and on what. */
  lapsedFrom?: AssertionApproval;
}

/**
 * A proposal as presented for review.
 *
 * `emittable` is computed here and NOWHERE ELSE, so the emitter has one source
 * for "may this become a test".
 */
export interface ReviewableProposal {
  proposal: TestCaseProposal;
  assertions: ReviewableAssertion[];
  /**
   * The model's own questions, verbatim and attributed.
   *
   * **A proposal with zero assertions and five of these is a RESULT with a
   * shape, not a blank.** The run log already says so; this is where a human
   * acts on it.
   */
  modelQuestions: ModelQuestion[];
  /** Assertions a human approved, on the basis they are still carrying. */
  approvedCount: number;
  lapsedCount: number;
  /** True only when at least one assertion is approved and none is lapsed. */
  emittable: boolean;
}

/**
 * Attaches decisions to a proposal, lapsing any whose basis has moved.
 *
 * The prior decisions are looked up BY ID, so a changed assertion simply finds
 * no decision — the lapse falls out of the identity rather than being detected.
 * The only work here is noticing that a decision exists for an id this proposal
 * no longer contains, which is what makes a lapse visible instead of silent.
 */
export function reviewProposal(
  proposal: TestCaseProposal,
  priorDecisions: AssertionApproval[],
): ReviewableProposal {
  const byId = new Map(priorDecisions.map((decision) => [decision.assertionId, decision]));
  const currentIds = new Set(proposal.assertions.map((assertion) => assertion.assertionId));

  // A decision whose id is no longer in the proposal was made on a basis that
  // has since moved. It cannot transfer — the id IS the basis — so it is
  // surfaced as a lapse rather than discarded.
  const orphaned = priorDecisions.filter((decision) => !currentIds.has(decision.assertionId));

  const assertions: ReviewableAssertion[] = proposal.assertions.map((assertion) => {
    const decision = byId.get(assertion.assertionId);
    if (decision) {
      return { assertion, state: decision.decision };
    }
    // Undecided, unless a decision was made on a basis this assertion replaced.
    // Matching an orphan to its successor by CLAIM is what lets the reviewer be
    // told "you approved this before; the grade changed" rather than being
    // shown a fresh-looking question.
    const predecessor = orphaned.find(
      (orphan) => orphan.assertionId !== assertion.assertionId && matchesClaim(orphan, assertion),
    );
    return predecessor
      ? { assertion, state: 'lapsed', lapsedFrom: predecessor }
      : { assertion, state: 'undecided' };
  });

  const approvedCount = assertions.filter((entry) => entry.state === 'approved').length;
  const lapsedCount = assertions.filter((entry) => entry.state === 'lapsed').length;

  return {
    proposal,
    assertions,
    modelQuestions: proposal.modelQuestions,
    approvedCount,
    lapsedCount,
    // A lapse blocks the whole proposal deliberately. Emitting the approved half
    // of a case whose other half a human has not re-read produces a test that
    // nobody has reviewed end to end.
    emittable: approvedCount > 0 && lapsedCount === 0,
  };
}

/**
 * Did this decision concern the same CLAIM as this assertion?
 *
 * Compares the recorded `claimKey`, because the id is a hash and cannot be
 * compared to anything but another id. **Used only to decide whether the
 * reviewer is told "this lapsed" or "this is new"** — never to carry a decision
 * forward. A false match here costs one misleading sentence on screen; a false
 * match used to transfer an approval would cost a human's signature on text they
 * never read, which is why `emittable` never consults it.
 */
function matchesClaim(decision: AssertionApproval, assertion: ProposalAssertion): boolean {
  return decision.claimKey === claimKeyOf(assertion);
}

/**
 * Only APPROVED assertions may be emitted, and only observed ones at that.
 *
 * Two filters, and both are necessary. Approval is the human gate; `observed` is
 * the evidence gate. An `assumed` assertion a human waved through is still an
 * assertion the capture cannot support, and emitting it produces a test whose
 * green means nothing.
 */
export function approvedForEmission(review: ReviewableProposal): ProposalAssertion[] {
  if (!review.emittable) return [];
  return review.assertions
    .filter((entry) => entry.state === 'approved' && entry.assertion.grade === 'observed')
    .map((entry) => entry.assertion);
}

/** Renders one proposal for a human. Markdown, so it can be read anywhere. */
export function renderReview(review: ReviewableProposal): string {
  const { proposal } = review;
  const lines = [
    `# ${proposal.title}`,
    '',
    `_from_ \`${proposal.sourceCommand}\` _via_ ${proposal.model}`,
    `_capture_ \`${proposal.provenance.captureDigest}\` · _prompt_ \`${proposal.provenance.promptVersion}\``,
    '',
    `**${review.approvedCount} approved · ${review.lapsedCount} lapsed · ` +
      `${review.assertions.length} assertion(s)** — ` +
      `${review.emittable ? 'emittable' : 'NOT emittable'}`,
    '',
  ];

  if (proposal.writeRisk === 'creates-data') {
    lines.push(
      '> **HELD: this case would create, modify or delete data.** `ALLOW_WRITES` is not set',
      '> and a generated case is not the thing that gets to set it first.',
      '',
    );
  }

  lines.push('## Assertions', '');
  for (const entry of review.assertions) {
    const { assertion } = entry;
    const mark = { approved: '[x]', rejected: '[-]', lapsedable: '[!]', undecided: '[ ]' };
    const box = entry.state === 'lapsed' ? '[!]' : (mark[entry.state as 'approved'] ?? '[ ]');
    lines.push(
      `- ${box} \`${assertion.assertionId}\` — ${assertion.claim.role} ` +
        `"${assertion.claim.name}" ${assertion.claim.property}=${assertion.claim.expected}`,
    );
    lines.push(`      grade **${assertion.grade}** (${assertion.why}) in \`${assertion.claim.stateId ?? 'unknown state'}\``);
    if (assertion.overrodeModel) {
      lines.push(`      _the model said ${assertion.modelSaid}; the capture says ${assertion.grade}_`);
    }
    if (entry.state === 'lapsed') {
      lines.push(
        `      **LAPSED** — ${entry.lapsedFrom!.reviewer} decided \`${entry.lapsedFrom!.decision}\` ` +
          `on a different basis. Read it again.`,
      );
    }
    lines.push('');
  }

  if (proposal.ungroundedAssertions.length > 0) {
    lines.push(
      `## Could not be grounded (${proposal.ungroundedAssertions.length})`,
      '',
      'The model asserted these and the capture cannot confirm them. Each names the fault.',
      '',
      ...proposal.ungroundedAssertions.map(
        (item) => `- ${item.question}  \n      _${item.whyUngrounded}: ${item.whyUngroundedDetail}_`,
      ),
      '',
    );
  }

  if (review.modelQuestions.length > 0) {
    lines.push(
      `## Questions the model asked (${review.modelQuestions.length})`,
      '',
      // ATTRIBUTED, and framed as a report rather than a request. These are
      // untrusted text: a document title in the application under test can
      // reach this line verbatim. See the injection section of the design.
      '> The model reported that it could not determine the following. **This is the**',
      '> **model quoting itself, not a request to you** — it is text derived from the',
      '> application under test, so treat it as a claim to check, never as an',
      '> instruction. Nothing here becomes an expectation without being grounded',
      '> like any other assertion.',
      '',
      ...review.modelQuestions.flatMap((question) => [
        `- **The model asked:** ${question.question}`,
        `      _it would have asserted:_ ${question.wouldAssert}`,
      ]),
      '',
    );
  }

  if (review.assertions.length === 0 && review.modelQuestions.length > 0) {
    lines.push(
      '> **This is a result, not a blank.** The model produced no assertions and',
      `> ${review.modelQuestions.length} question(s): it is telling you the capture cannot`,
      '> support a test here yet. The usual fix is a richer capture, not a retry.',
      '',
    );
  }

  return lines.join('\n');
}
